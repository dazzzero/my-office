import type { OfficeEvent, Worker } from '../../../shared/src/events.ts';
import { teamColor, teamName, workerFullName, workerName } from '../../../shared/src/identity.ts';
import { useOffice } from '../store.ts';

const STATUS_LABEL: Record<Worker['status'], string> = {
  working: '일하는 중', waiting: '✋ 결재 대기', idle: '대기', error: '⚠️ 오류', away: '💤 자리 비움', left: '퇴근',
};
const ZONE_LABEL: Record<string, string> = {
  desk: '책상', library: '자료실', server: '서버실', window: '창가', meeting: '회의실', lounge: '라운지', elevator: '엘리베이터', boss: '대표실',
};

const hhmmss = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
const since = (ts: number) => {
  const m = Math.floor((Date.now() - ts) / 60_000);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 ${m % 60}분 전`;
};

function WorkerDetail({ w }: { w: Worker }) {
  const floorCfg = useOffice(s => s.floorsConfig.find(f => f.floor === w.floor));
  const events = useOffice(s => s.events);
  const selectWorker = useOffice(s => s.selectWorker);
  const mine = events.filter(e => e.sessionId === w.sessionId && (e.agentId ?? null) === (w.agentId ?? null)).slice(0, 20);
  return (
    <div className="sec detail">
      <h4>직원 상세 <small className="close" onClick={() => selectWorker(null)}>닫기 ✕</small></h4>
      <div className="card-person">
        <span className="dot big" style={{ background: teamColor(floorCfg, w.teamId) }} />
        <div>
          <b>{workerFullName(w)}</b>
          <span>{teamName(floorCfg, w.teamId)} · {w.agentType ? '서브에이전트' : '세션'}</span>
        </div>
      </div>
      <dl>
        <dt>상태</dt><dd>{STATUS_LABEL[w.status]}</dd>
        <dt>위치</dt><dd>{ZONE_LABEL[w.zone]}</dd>
        <dt>하는 일</dt><dd>{w.summary}</dd>
        <dt>출근</dt><dd>{hhmmss(w.startedAt)} ({since(w.startedAt)})</dd>
        <dt>도구 사용</dt><dd>{w.toolCount}회</dd>
        <dt>세션</dt><dd className="mono">{w.sessionId.slice(0, 8)}{w.agentId ? ` / ${w.agentId.slice(0, 8)}` : ''}</dd>
      </dl>
      <h4>최근 활동</h4>
      <ul className="log">{mine.map(e => <LogItem key={e.id} e={e} />)}</ul>
    </div>
  );
}

function LogItem({ e, withName }: { e: OfficeEvent; withName?: boolean }) {
  const floorCfg = useOffice(s => s.floorsConfig.find(f => f.floor === e.floor));
  return (
    <li>
      <time>{hhmmss(e.ts)}</time>
      {withName && <b style={{ color: teamColor(floorCfg, e.teamId) }}>{workerName(e)} </b>}
      {e.summary}
    </li>
  );
}

export function RightPanel() {
  const selectedFloor = useOffice(s => s.selectedFloor);
  const floorCfg = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  const workers = useOffice(s => s.workers);
  const events = useOffice(s => s.events);
  const selectedId = useOffice(s => s.selectedWorkerId);
  const selectWorker = useOffice(s => s.selectWorker);

  const selected = selectedId ? workers[selectedId] : null;
  const here = Object.values(workers).filter(w => w.floor === selectedFloor && w.status !== 'left').sort((a, b) => a.startedAt - b.startedAt);
  const log = events.filter(e => e.floor === selectedFloor && e.kind !== 'tool.end').slice(0, 40);

  return (
    <aside className="right">
      {selected ? <WorkerDetail w={selected} /> : (
        <>
          <div className="sec">
            <h4>작업 위치</h4>
            {floorCfg?.teams.map(t => (
              <div key={t.id} className="path"><span className="dot" style={{ background: teamColor(floorCfg, t.id) }} />{t.name}<code>{t.path}</code></div>
            ))}
          </div>
          <div className="sec">
            <h4>사무실 사람들 <small>{here.length}명</small></h4>
            <ul className="people">
              {here.length === 0 && <li className="empty">조용한 층이에요</li>}
              {here.map(w => (
                <li key={w.id} onClick={() => selectWorker(w.id)}>
                  <span className="dot" style={{ background: teamColor(floorCfg, w.teamId) }} />
                  <div>
                    <b>{w.agentId ? `↳ ${workerName(w)}` : workerName(w)}</b>
                    <span>{teamName(floorCfg, w.teamId)}</span>
                    <span className={`chip st-${w.status}`}>{w.status === 'working' ? w.summary : STATUS_LABEL[w.status]}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      <div className="sec">
        <h4>활동 로그</h4>
        <ul className="log">
          {log.length === 0 && <li className="empty">아직 기록이 없어요</li>}
          {log.map(e => <LogItem key={e.id} e={e} withName />)}
        </ul>
      </div>
      <div className="sec">
        <h4>어디서 무엇을 하나</h4>
        <div className="legend">
          <span>💻 책상 · 편집/작성</span><span>📚 자료실 · 읽기/검색</span>
          <span>🖥️ 서버실 · 명령/DB</span><span>🪟 창가 · 웹 검색</span>
          <span>🗣️ 회의실 · 에이전트 호출</span><span>☕ 라운지 · 완료/대기</span>
          <span>🛗 엘리베이터 · 출퇴근</span><span>✋ 결재 대기</span>
        </div>
      </div>
    </aside>
  );
}
