import type { Worker } from '../../../shared/src/events.ts';
import { teamColor, teamName, workerName } from '../../../shared/src/identity.ts';
import { useOffice } from '../store.ts';

const ZONE_ICON: Record<Worker['zone'], string> = {
  desk: '💻', library: '📚', server: '🖥️', window: '🪟', meeting: '🗣️', lounge: '☕', elevator: '🛗', boss: '🏢',
};
const STATUS: Record<Worker['status'], [string, string]> = {
  working: ['작업 중', 'st-working'], waiting: ['✋ 결재 대기', 'st-waiting'], idle: ['대기', 'st-idle'],
  error: ['⚠️ 오류', 'st-error'], away: ['💤 자리 비움', 'st-away'], left: ['퇴근', 'st-left'],
};

/** 휴대폰 세로 화면: 3D 아래에 "이 층에서 누가 어디서 무엇을 하는지" 목록 */
export function MobilePeople() {
  const floorCfg = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  const workers = useOffice(s => s.workers);
  const selectedFloor = useOffice(s => s.selectedFloor);
  const selectWorker = useOffice(s => s.selectWorker);
  const order: Record<Worker['status'], number> = { waiting: 0, error: 1, working: 2, idle: 3, away: 4, left: 5 };
  const here = Object.values(workers)
    .filter(w => w.floor === selectedFloor && w.status !== 'left')
    .sort((a, b) => order[a.status] - order[b.status] || a.startedAt - b.startedAt);
  return (
    <div className="mpeople">
      <h4>이 층 사람들 <small>{here.length}명 · 누르면 상세</small></h4>
      {here.length === 0 && <p className="empty">조용한 층이에요 ☕</p>}
      <ul>
        {here.map(w => {
          const [label, cls] = STATUS[w.status];
          return (
            <li key={w.id} onClick={() => selectWorker(w.id)}>
              <span className="dot" style={{ background: teamColor(floorCfg, w.teamId) }} />
              <div>
                <div className="row">
                  <b>{w.meetingId ? '🗣️ ' : w.agentId ? '↳ ' : ''}{workerName(w)}</b>
                  <em>{teamName(floorCfg, w.teamId)}</em>
                  <span className={`chip ${cls}`}>{label}</span>
                </div>
                <div className="what">{ZONE_ICON[w.zone]} {w.summary}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
