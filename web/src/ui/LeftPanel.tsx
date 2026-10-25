import { teamColor, workerName } from '../../../shared/src/identity.ts';
import { useOffice } from '../store.ts';

const STATUS_LABEL: Record<string, string> = { working: '작업', waiting: '결재 대기', idle: '대기', error: '오류', away: '자리 비움', left: '퇴근' };

export function LeftPanel() {
  const floorsConfig = useOffice(s => s.floorsConfig);
  const summaries = useOffice(s => s.floors);
  const selectedFloor = useOffice(s => s.selectedFloor);
  const workers = useOffice(s => s.workers);
  const selectFloor = useOffice(s => s.selectFloor);
  const selectWorker = useOffice(s => s.selectWorker);
  const floorCfg = floorsConfig.find(f => f.floor === selectedFloor);

  // 위층이 위에 오도록
  const ordered = [...floorsConfig].sort((a, b) => b.floor - a.floor);
  const here = Object.values(workers).filter(w => w.floor === selectedFloor && w.status !== 'left').sort((a, b) => a.startedAt - b.startedAt);

  return (
    <aside className="left">
      <div className="brand">🏢 <span>마이</span>오피스</div>
      <h4>층별 안내 <small>FLOOR GUIDE</small></h4>
      {ordered.map(f => {
        const s = summaries.find(x => x.floor === f.floor);
        const on = f.floor === selectedFloor;
        return (
          <div key={f.floor} className={`floor${on ? ' on' : ''}`} onClick={() => selectFloor(f.floor)}>
            <span className="no">{f.label}</span>
            <div className="floor-body">
              <div className="floor-head">
                <b>{f.name}</b>
                {!!s?.waiting && <span className="badge wait">✋ {s.waiting}</span>}
                {!!s?.total && <span className="badge">{s.total}명</span>}
              </div>
              <em>{f.teams.map(t => t.name).join(' · ')}</em>
              {on && (
                <ul className="sess">
                  {here.length === 0 && <li className="empty">아직 출근한 직원이 없어요</li>}
                  {here.map(w => (
                    <li key={w.id} onClick={e => { e.stopPropagation(); selectWorker(w.id); }}>
                      <span className="dot" style={{ background: teamColor(floorCfg, w.teamId) }} />
                      {w.agentId ? <span className="sub">↳ {workerName(w)}</span> : workerName(w)}
                      <i className={`st-${w.status}`}>{STATUS_LABEL[w.status]}</i>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
