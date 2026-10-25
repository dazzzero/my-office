import { useEffect, useMemo, useState } from 'react';
import type { FloorConfig } from '../../../shared/src/config.ts';
import { MEETING_ACTIVE, MEETING_KIND_LABEL, type AttendeeInput, type Meeting, type MeetingKind, type MeetingLine, type MeetingStatus, type Persona } from '../../../shared/src/meetings.ts';
import { teamColor } from '../../../shared/src/identity.ts';
import type { Task } from '../../../shared/src/tasks.ts';
import { api } from '../api.ts';
import { attempt, useOffice } from '../store.ts';
import { useAgents } from './CommandPanel.tsx';
import { TASK_STATUS, ago, hhmm } from './labels.ts';

export const MEETING_STATUS: Record<MeetingStatus, { label: string; tone: 'gray' | 'blue' | 'orange' | 'green' | 'red' }> = {
  queued: { label: '대기', tone: 'gray' },
  research: { label: '🔎 조사 중', tone: 'blue' },
  debate: { label: '💬 토론 중', tone: 'blue' },
  minutes: { label: '📝 정리 중', tone: 'blue' },
  done: { label: '완료', tone: 'green' },
  failed: { label: '실패', tone: 'red' },
  stopped: { label: '중지', tone: 'gray' },
  skipped: { label: '건너뜀', tone: 'gray' },
};

interface MeetingsInfo {
  personas: Persona[];
  maxAttendees: number;
  defaultRounds: number;
}

function useMeetingsInfo() {
  const [info, setInfo] = useState<MeetingsInfo | null>(null);
  useEffect(() => { api<MeetingsInfo>('GET', '/api/meetings').then(setInfo).catch(() => {}); }, []);
  return info;
}

const key = (a: AttendeeInput) => (a.kind === 'persona' ? `p:${a.persona}` : a.kind === 'agent' ? `a:${a.teamId}:${a.agent}` : `t:${a.teamId}`);

/** 팀 대표 + 그 팀 고정 직원 체크 */
function TeamAttendees({ floor, team, picked, toggle, full }: {
  floor: FloorConfig; team: FloorConfig['teams'][number]; picked: Set<string>; toggle: (a: AttendeeInput) => void; full: boolean;
}) {
  const agents = useAgents(team.id).filter(a => a.scope === 'project');
  const rep: AttendeeInput = { kind: 'team', teamId: team.id };
  return (
    <div className="att-team">
      <label className="check">
        <input type="checkbox" checked={picked.has(key(rep))} disabled={full && !picked.has(key(rep))} onChange={() => toggle(rep)} />
        <span className="dot" style={{ background: teamColor(floor, team.id) }} /> {team.name} 대표
      </label>
      {agents.map(a => {
        const x: AttendeeInput = { kind: 'agent', teamId: team.id, agent: a.name };
        return (
          <label key={a.name} className="check sub" title={a.description}>
            <input type="checkbox" checked={picked.has(key(x))} disabled={full && !picked.has(key(x))} onChange={() => toggle(x)} /> {a.name}
          </label>
        );
      })}
    </div>
  );
}

function OpenMeeting({ info, onOpened }: { info: MeetingsInfo; onOpened: (m: Meeting) => void }) {
  const floors = useOffice(s => s.floorsConfig);
  const selectedFloor = useOffice(s => s.selectedFloor);
  const [kind, setKind] = useState<MeetingKind>('planning');
  const [floorNo, setFloorNo] = useState(selectedFloor);
  const floor = floors.find(f => f.floor === floorNo)!;
  const [picked, setPicked] = useState<AttendeeInput[]>([]);
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [rounds, setRounds] = useState(info.defaultRounds);
  const [busy, setBusy] = useState(false);

  // 종류·층을 바꾸면 기본 참석자: 기획 = 첫 팀 대표 + 기획자, 코드리뷰 = 첫 팀 대표 + 아키텍트·QA·보안
  useEffect(() => {
    const first: AttendeeInput[] = floor?.teams[0] ? [{ kind: 'team', teamId: floor.teams[0].id }] : [];
    const roles = kind === 'review' ? ['architect', 'qa', 'security'] : ['planner'];
    setPicked([...first, ...roles.filter(r => info.personas.some(p => p.id === r)).map(r => ({ kind: 'persona' as const, persona: r }))]);
    setRounds(kind === 'review' ? 1 : info.defaultRounds);
  }, [kind, floorNo, floor, info]);

  const pickedKeys = useMemo(() => new Set(picked.map(key)), [picked]);
  const full = picked.length >= info.maxAttendees;
  const toggle = (a: AttendeeInput) => setPicked(p => (pickedKeys.has(key(a)) ? p.filter(x => key(x) !== key(a)) : [...p, a]));

  const standup = kind === 'standup';
  const calls = standup ? null : picked.length * (1 + rounds) + 1;
  const submit = async () => {
    setBusy(true);
    const m = await attempt(() => api<Meeting>('POST', '/api/meetings', standup
      ? { kind, floor: floorNo }
      : { kind, floor: floorNo, title: title || undefined, agenda, attendees: picked, rounds }));
    setBusy(false);
    if (m) onOpened(m);
  };

  return (
    <div className="form open-meeting">
      <div className="row2">
        <label>종류
          <select value={kind} onChange={e => setKind(e.target.value as MeetingKind)}>
            <option value="planning">{MEETING_KIND_LABEL.planning}</option>
            <option value="review">{MEETING_KIND_LABEL.review}</option>
            <option value="standup">{MEETING_KIND_LABEL.standup}</option>
          </select>
        </label>
        <label>층
          <select value={floorNo} onChange={e => setFloorNo(Number(e.target.value))}>
            {[...floors].sort((a, b) => a.floor - b.floor).map(f => <option key={f.floor} value={f.floor}>{f.label} {f.name}</option>)}
          </select>
        </label>
      </div>
      {standup ? (
        <p className="hint">이 층 팀 대표들이 지난 스탠드업 이후 git 변경·남은 할 일을 보고, <b>오늘 할 일</b>을 결재함에 묶음으로 올립니다. (토론 없음)</p>
      ) : (
        <>
          <label>참석자 <small>({picked.length}/{info.maxAttendees}명 · 📝 서기는 자동)</small></label>
          <div className="attendees">
            {floor?.teams.map(t => <TeamAttendees key={t.id} floor={floor} team={t} picked={pickedKeys} toggle={toggle} full={full} />)}
            <div className="att-team">
              {info.personas.map(p => {
                const x: AttendeeInput = { kind: 'persona', persona: p.id };
                return (
                  <label key={p.id} className="check" title={p.summary}>
                    <input type="checkbox" checked={pickedKeys.has(key(x))} disabled={full && !pickedKeys.has(key(x))} onChange={() => toggle(x)} /> {p.emoji} {p.name}
                    <em>{p.summary}</em>
                  </label>
                );
              })}
            </div>
          </div>
          <label>제목 <input placeholder="비우면 안건 첫 줄로" value={title} onChange={e => setTitle(e.target.value)} /></label>
          <label>안건
            <textarea rows={4} placeholder={kind === 'review' ? '예) 어제 올린 주문 목록 정렬 변경 리뷰' : '예) 주문 목록에 엑셀 내보내기를 넣을지, 넣는다면 어떻게'} value={agenda} onChange={e => setAgenda(e.target.value)} />
          </label>
          <label>토론
            <select value={rounds} onChange={e => setRounds(Number(e.target.value))}>
              {[0, 1, 2, 3].map(r => <option key={r} value={r}>{r ? `${r}라운드` : '토론 없이 조사 후 바로 정리'}</option>)}
            </select>
          </label>
        </>
      )}
      <p className="hint">
        회의는 파일을 바꾸지 않습니다 (조사는 읽기·검색만). 나온 할 일은 <b>칸반 초안</b>이 되고, 보내야 계획 → 결재 → 실행됩니다.
        {calls !== null && <> 예상 Claude 호출 약 <b>{calls}회</b>.</>}
      </p>
      <div className="actions">
        <button className="primary" disabled={busy || (!standup && (!agenda.trim() || !picked.length))} onClick={submit}>회의 열기</button>
      </div>
    </div>
  );
}

function MorningBox() {
  const morning = useOffice(s => s.morning);
  const [busy, setBusy] = useState(false);
  if (!morning) return null;
  const next = morning.nextAt ? new Date(morning.nextAt) : null;
  const when = next ? `${next.getMonth() + 1}/${next.getDate()} (${'일월화수목금토'[next.getDay()]}) ${hhmm(next.getTime())}` : '꺼짐';
  return (
    <div className="morning">
      <div>
        <b>☀️ 아침 루틴</b> <span>평일 {morning.time} · 다음 {when}{morning.lastDate ? ` · 마지막 ${morning.lastDate}` : ''}</span>
        <em>층마다 스탠드업을 열어 "오늘 할 일"을 결재함에 올립니다. 바뀐 것도 남은 일도 없는 층은 건너뜁니다. "지금 실행"을 눌러도 정기 실행은 그대로 돕니다.</em>
      </div>
      <button disabled={busy} onClick={async () => { setBusy(true); await attempt(() => api('POST', '/api/morning/run', {})); setBusy(false); }}>지금 실행</button>
    </div>
  );
}

function MeetingRow({ m }: { m: Meeting }) {
  const floors = useOffice(s => s.floorsConfig);
  const openPanel = useOffice(s => s.openPanel);
  const floor = floors.find(f => f.floor === m.floor);
  const st = MEETING_STATUS[m.status];
  return (
    <li className={`mrow${m.status === 'skipped' ? ' dim' : ''}`} onClick={() => m.status !== 'skipped' && openPanel({ meetingId: m.id })}>
      <div className="mrow-head">
        <span className={`status tone-${st.tone}`}>{st.label}</span>
        <b>{MEETING_KIND_LABEL[m.kind].split(' ')[0]} {m.title}</b>
      </div>
      <div className="meta">
        {floor?.label} {floor?.name} · {ago(m.createdAt)}
        {m.status === 'skipped' ? ` · ${m.agenda}` : m.calls ? ` · 호출 ${m.calls}회` : ''}
        {m.taskIds.length > 0 && ` · 할 일 ${m.taskIds.length}건`}
      </div>
    </li>
  );
}

export function MeetingsHome() {
  const meetings = useOffice(s => s.meetings);
  const openPanel = useOffice(s => s.openPanel);
  const info = useMeetingsInfo();
  const [form, setForm] = useState(false);
  const [showSkipped, setShowSkipped] = useState(false);
  const active = meetings.filter(m => MEETING_ACTIVE.includes(m.status));
  const past = meetings.filter(m => !MEETING_ACTIVE.includes(m.status) && (showSkipped || m.status !== 'skipped'));
  const skipped = meetings.filter(m => m.status === 'skipped').length;
  return (
    <div className="panel-body meetings">
      <MorningBox />
      {form && info
        ? <OpenMeeting info={info} onOpened={m => { setForm(false); openPanel({ meetingId: m.id }); }} />
        : <div className="actions"><button className="primary" onClick={() => setForm(true)}>＋ 회의 열기</button></div>}
      {active.length > 0 && <><h4>진행 중</h4><ul className="mlist">{active.map(m => <MeetingRow key={m.id} m={m} />)}</ul></>}
      <h4>
        지난 회의
        {skipped > 0 && <small className="link" onClick={() => setShowSkipped(v => !v)}> {showSkipped ? '건너뜀 숨기기' : `건너뜀 ${skipped}건 보기`}</small>}
      </h4>
      <ul className="mlist">
        {past.length === 0 && <li className="empty">아직 회의가 없어요</li>}
        {past.map(m => <MeetingRow key={m.id} m={m} />)}
      </ul>
    </div>
  );
}

function Line({ l, m }: { l: MeetingLine; m: Meeting }) {
  const [open, setOpen] = useState(l.stage === 'debate');
  const who = l.speaker === null ? null : m.attendees[l.speaker]?.name;
  if (l.stage === 'system') return <li className="mline sys"><time>{hhmm(l.ts)}</time>{l.text}</li>;
  const icon = l.stage === 'research' ? '🔎' : l.stage === 'debate' ? '💬' : '📝';
  return (
    <li className={`mline st-${l.stage}`} onClick={() => setOpen(o => !o)}>
      <div className="mline-head">
        <time>{hhmm(l.ts)}</time>{icon}
        {l.round !== null && <small>{l.round}R</small>}
        <b>{who ?? '📝 서기'}</b>
        <span>{l.gist}</span>
      </div>
      {open && <div className="mline-text">{l.text}</div>}
    </li>
  );
}

export function MeetingDetail({ meetingId }: { meetingId: number }) {
  const m = useOffice(s => s.meetings.find(x => x.id === meetingId));
  const lines = useOffice(s => s.meetingLines[meetingId]);
  const tasks = useOffice(s => s.tasks);
  const floors = useOffice(s => s.floorsConfig);
  const approvals = useOffice(s => s.approvals);
  const openPanel = useOffice(s => s.openPanel);
  const selectFloor = useOffice(s => s.selectFloor);
  const [busy, setBusy] = useState(false);

  // 처음 열 때 발언 전체를 읽고, 이후엔 실시간으로 붙는다
  useEffect(() => {
    let alive = true;
    api<{ lines: MeetingLine[] }>('GET', `/api/meetings/${meetingId}`)
      .then(r => alive && useOffice.setState(s => ({ meetingLines: { ...s.meetingLines, [meetingId]: r.lines } })))
      .catch(() => {});
    return () => { alive = false; };
  }, [meetingId]);

  if (!m) return <div className="panel-body"><p className="empty">목록에 없는 회의예요.</p></div>;
  const floor = floors.find(f => f.floor === m.floor);
  const st = MEETING_STATUS[m.status];
  const active = MEETING_ACTIVE.includes(m.status);
  const mine = m.taskIds.map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t);
  const checklist = approvals.find(a => a.kind === 'today' && (a.input as { meetingId?: number })?.meetingId === m.id);
  const team = (id: string) => floor?.teams.find(t => t.id === id)?.name ?? id;
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await attempt(fn); setBusy(false); };

  return (
    <div className="panel-body meeting">
      <div className="task-head">
        <span className={`status tone-${st.tone}`}>{st.label}</span>
        <b>{m.title}</b>
      </div>
      <dl className="mdl">
        <dt>종류</dt><dd>{MEETING_KIND_LABEL[m.kind]}{m.rounds ? ` · 토론 ${m.rounds}라운드` : ''}</dd>
        <dt>층</dt><dd><a onClick={() => selectFloor(m.floor)}>{floor?.label} {floor?.name}</a></dd>
        <dt>참석</dt><dd>{m.attendees.map(a => a.name).join(', ')} · 📝 서기</dd>
        <dt>시작</dt><dd>{hhmm(m.createdAt)} ({ago(m.createdAt)}){m.endedAt ? ` ~ ${hhmm(m.endedAt)}` : ''}</dd>
        {m.calls > 0 && <><dt>사용량</dt><dd>Claude 호출 {m.calls}회 · 약 ${m.costUsd.toFixed(2)} 상당 (구독 한도에서 차감)</dd></>}
        {m.file && <><dt>회의록</dt><dd className="mono">{m.file}</dd></>}
      </dl>
      <details className="agenda"><summary>안건</summary><p>{m.agenda}</p></details>
      {m.error && m.status === 'failed' && <p className="error">{m.error}</p>}
      <div className="actions">
        {active && <button className="danger" disabled={busy} onClick={() => run(() => api('POST', `/api/meetings/${m.id}/stop`, {}))}>회의 중지</button>}
        {checklist && <button className="primary" onClick={() => openPanel('approvals')}>☀️ 결재함에서 오늘 할 일 고르기</button>}
        <button onClick={() => openPanel('meetings')}>← 회의 목록</button>
      </div>

      {m.minutes && (
        <div className="minutes">
          <h4>요약</h4>
          <p>{m.minutes.summary}</p>
          <h4>결정 사항</h4>
          {m.minutes.decisions.length ? <ul>{m.minutes.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul> : <p className="empty">없음</p>}
          <h4>할 일 <small>{mine.length}건 · 칸반 초안</small></h4>
          {mine.length === 0 && <p className="empty">없음</p>}
          {mine.map(t => {
            const ts = TASK_STATUS[t.status];
            return (
              <div key={t.id} className="action-item">
                <div className="row">
                  <span className={`status tone-${ts.tone}`}>{ts.label}</span>
                  <b onClick={() => openPanel({ taskId: t.id })}>{t.title}</b>
                  <em>{team(t.teamId)}{t.agent ? ` · ${t.agent}` : ''}</em>
                </div>
                <p>{t.instruction}</p>
                {t.status === 'draft' && !checklist && (
                  <button className="primary" disabled={busy} onClick={() => run(() => api('POST', `/api/tasks/${t.id}/start`, {}))}>보내기 (계획 → 결재)</button>
                )}
              </div>
            );
          })}
          {mine.filter(t => t.status === 'draft').length > 1 && !checklist && (
            <div className="actions">
              <button disabled={busy} onClick={() => run(async () => { for (const t of mine.filter(x => x.status === 'draft')) await api('POST', `/api/tasks/${t.id}/start`, {}); })}>할 일 모두 보내기</button>
            </div>
          )}
          <h4>미결 사항</h4>
          {m.minutes.openQuestions.length ? <ul>{m.minutes.openQuestions.map((d, i) => <li key={i}>{d}</li>)}</ul> : <p className="empty">없음</p>}
          {m.minutes.discussion && <><h4>논의 요지</h4><p className="pre">{m.minutes.discussion}</p></>}
        </div>
      )}

      <h4>회의 진행 <small>눌러서 펼치기</small></h4>
      <ul className="mlines">
        {!lines && <li className="empty">불러오는 중…</li>}
        {lines?.map(l => <Line key={l.id} l={l} m={m} />)}
        {active && <li className="mline sys">… {st.label}</li>}
      </ul>
    </div>
  );
}
