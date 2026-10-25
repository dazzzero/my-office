import { useState } from 'react';
import { teamColor, workerName } from '../../../shared/src/identity.ts';
import type { Approval, TodayChecklist } from '../../../shared/src/tasks.ts';
import { api } from '../api.ts';
import { attempt, findTeam, useOffice } from '../store.ts';
import { ago } from './labels.ts';

function ApprovalCard({ a }: { a: Approval }) {
  const task = useOffice(s => s.tasks.find(t => t.id === a.taskId));
  const floors = useOffice(s => s.floorsConfig);
  const openPanel = useOffice(s => s.openPanel);
  // Paseo·터미널 세션의 요청이면 사무실에 있는 그 직원으로 어디인지 찾는다
  const worker = useOffice(s => (a.sessionId ? s.workers[a.sessionId] : undefined));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const where = task ? findTeam(floors, task.teamId) : worker ? findTeam(floors, worker.teamId) : null;

  const decide = async (approve: boolean) => {
    setBusy(true);
    await attempt(() => api('POST', `/api/approvals/${a.id}`, { approve, note }));
    setBusy(false);
  };

  const command = typeof a.input?.command === 'string' ? a.input.command : null;
  return (
    <div className={`approval ${a.kind}`}>
      <div className="approval-head">
        <span className="tag">{a.kind === 'plan' ? '📋 계획 결재' : a.kind === 'terminal' ? '💻 Paseo·터미널' : '✋ 작업 결재'}</span>
        <b onClick={() => task && openPanel({ taskId: task.id })}>
          {task?.title ?? (a.sessionId ? `${workerName({ sessionId: a.sessionId, agentType: null })}의 요청` : '업무')}
        </b>
        <em>{where ? `${where.floor.label} ${where.floor.name} · ${where.team.name}` : ''} · {ago(a.createdAt)}</em>
      </div>
      {a.kind === 'plan' ? (
        <pre className="plan">{String(a.input?.plan ?? '')}</pre>
      ) : (
        <div className="tool-req">
          <div><b>{a.toolName}</b>{a.reason && <span className="reason"> — {a.reason}</span>}</div>
          {command ? <pre>{command}</pre> : <pre>{JSON.stringify(a.input, null, 2).slice(0, 800)}</pre>}
        </div>
      )}
      <input className="note" placeholder={a.kind === 'plan' ? '반려 사유 / 수정 요청 (선택)' : '반려 사유 (선택)'} value={note} onChange={e => setNote(e.target.value)} />
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => decide(true)}>승인</button>
        <button className="danger" disabled={busy} onClick={() => decide(false)}>{a.kind === 'plan' ? '반려 (다시 계획)' : '반려'}</button>
      </div>
    </div>
  );
}

/** 아침 스탠드업의 "오늘 할 일" 묶음: 골라서 승인 → 고른 것만 계획 → 계획 결재 → 실행 */
function TodayCard({ a }: { a: Approval }) {
  const floors = useOffice(s => s.floorsConfig);
  const openPanel = useOffice(s => s.openPanel);
  const list = a.input as unknown as TodayChecklist;
  const floor = floors.find(f => f.floor === list.floor);
  const [picked, setPicked] = useState<Set<number>>(() => new Set(list.items.map(i => i.taskId)));
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const toggle = (id: number) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const decide = async (approve: boolean) => {
    setBusy(true);
    await attempt(() => api('POST', `/api/approvals/${a.id}`, { approve, picks: [...picked] }));
    setBusy(false);
  };
  return (
    <div className="approval today">
      <div className="approval-head">
        <span className="tag">☀️ 오늘 할 일</span>
        <b onClick={() => openPanel({ meetingId: list.meetingId })}>{floor ? `${floor.label} ${floor.name}` : ''} 아침 스탠드업</b>
        <em>{a.reason} · {ago(a.createdAt)}</em>
      </div>
      <ul className="checklist">
        {list.items.map(i => (
          <li key={i.taskId}>
            <label className="check">
              <input type="checkbox" checked={picked.has(i.taskId)} onChange={() => toggle(i.taskId)} />
              <span className="dot" style={{ background: teamColor(floor, i.teamId) }} />
              <b>{i.title}</b>
              <em>{floor?.teams.find(t => t.id === i.teamId)?.name ?? i.teamId}{i.agent ? ` · ${i.agent}` : ''}</em>
            </label>
            <small className="link" onClick={() => setOpen(open === i.taskId ? null : i.taskId)}>{open === i.taskId ? '접기' : '내용'}</small>
            {open === i.taskId && <p className="pre">{i.instruction}</p>}
          </li>
        ))}
      </ul>
      <p className="hint">고른 일은 팀에 보내져 <b>계획부터</b> 세웁니다. 계획은 다시 결재함으로 옵니다. 안 고른 일은 칸반에서 치웁니다(회의록에는 남음).</p>
      <div className="actions">
        <button className="primary" disabled={busy || picked.size === 0} onClick={() => decide(true)}>고른 {picked.size}건 진행</button>
        <button className="danger" disabled={busy} onClick={() => decide(false)}>오늘은 안 함</button>
      </div>
    </div>
  );
}

export function ApprovalsPanel() {
  const approvals = useOffice(s => s.approvals);
  const mode = useOffice(s => s.terminalMode);
  const office = mode === 'office';
  const plans = approvals.filter(a => a.kind === 'plan').length;
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel-body">
      <label className="toggle">
        <input type="checkbox" checked={office}
          onChange={e => attempt(() => api('POST', '/api/settings', { terminalMode: e.target.checked ? 'office' : 'terminal' }))} />
        <span>
          <b>Paseo·터미널 결재도 여기서 받기</b>
          <em>{office
            ? '켜짐: Paseo·터미널 대화의 권한 요청이 여기로 옵니다. 5분 안에 처리하지 않으면 원래대로 그쪽에서 물어봅니다.'
            : '꺼짐: Paseo·터미널 대화의 권한 요청은 그쪽 화면에서 묻습니다. (마이오피스가 시킨 일은 항상 여기로)'}</em>
        </span>
      </label>
      {plans >= 2 && (
        <div className="actions bulk">
          <button className="primary" disabled={busy} onClick={async () => { setBusy(true); await attempt(() => api('POST', '/api/approvals/approve-plans', {})); setBusy(false); }}>
            📋 계획 {plans}건 모두 승인
          </button>
          <span className="hint">작업 결재(✋)는 하나씩 봅니다</span>
        </div>
      )}
      {approvals.length === 0 && <p className="empty">결재할 일이 없어요 ☕</p>}
      {approvals.map(a => (a.kind === 'today' ? <TodayCard key={a.id} a={a} /> : <ApprovalCard key={a.id} a={a} />))}
    </div>
  );
}
