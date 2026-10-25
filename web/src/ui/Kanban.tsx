import { useState } from 'react';
import type { Task, TaskStatus } from '../../../shared/src/tasks.ts';
import { HOT_COLOR, teamColor } from '../../../shared/src/identity.ts';
import { api } from '../api.ts';
import { attempt, findTeam, useOffice } from '../store.ts';
import { TASK_STATUS, ago } from './labels.ts';

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: '📝 할 일 (초안)', statuses: ['draft'] },
  { title: '⏳ 대기', statuses: ['queued'] },
  { title: '📋 계획·결재', statuses: ['planning', 'plan_review', 'approval'] },
  { title: '⚙️ 실행 중', statuses: ['running'] },
  { title: '✅ 완료', statuses: ['done'] },
  { title: '⛔ 중지·실패', statuses: ['stopped', 'failed', 'rejected'] },
];

function Card({ t }: { t: Task }) {
  const floors = useOffice(s => s.floorsConfig);
  const openPanel = useOffice(s => s.openPanel);
  const where = findTeam(floors, t.teamId);
  const st = TASK_STATUS[t.status];
  return (
    <div className="kcard" draggable={t.status === 'draft'}
      onDragStart={e => e.dataTransfer.setData('text/task-id', String(t.id))}
      onClick={() => openPanel({ taskId: t.id })}>
      <b>{t.source === 'meeting' && <span title="회의에서 나온 일">🗣️ </span>}{t.title}</b>
      <div className="meta">
        <span className="dot" style={{ background: where ? teamColor(where.floor, t.teamId) : HOT_COLOR }} />
        {where ? `${where.floor.label} ${where.team.name}` : t.teamId}{t.agent ? ` · ${t.agent}` : ''}
      </div>
      <div className="meta"><span className={`status tone-${st.tone}`}>{st.label}</span><i>{ago(t.updatedAt)}</i></div>
    </div>
  );
}

export function Kanban() {
  const tasks = useOffice(s => s.tasks);
  const floors = useOffice(s => s.floorsConfig);
  const selectedFloor = useOffice(s => s.selectedFloor);
  const openCommand = useOffice(s => s.openCommand);
  const toggleKanban = useOffice(s => s.toggleKanban);
  const [over, setOver] = useState<string | null>(null);
  const floor = floors.find(f => f.floor === selectedFloor);

  // 초안 카드를 팀 칸에 끌어다 놓으면 그 팀에 보낸다
  const drop = (teamId: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData('text/task-id'));
    if (id) await attempt(() => api('POST', `/api/tasks/${id}/start`, { teamId, agent: null }));
  };

  return (
    <div className="kanban">
      <div className="kanban-head">
        <b>📋 칸반</b>
        <span className="hint">초안 카드를 오른쪽 팀에 끌어다 놓으면 그 팀에 보냅니다</span>
        <div className="drop-teams">
          {floor?.teams.map(t => (
            <div key={t.id} className={`drop-team${over === t.id ? ' over' : ''}`} style={{ borderColor: teamColor(floor, t.id) }}
              onDragOver={e => { e.preventDefault(); setOver(t.id); }} onDragLeave={() => setOver(null)} onDrop={drop(t.id)}>
              {floor.label} {t.name}
            </div>
          ))}
        </div>
        <button onClick={() => openCommand(null)}>＋ 카드</button>
        <button onClick={toggleKanban}>닫기 ✕</button>
      </div>
      <div className="columns">
        {COLUMNS.map(c => {
          const list = tasks.filter(t => c.statuses.includes(t.status));
          return (
            <div key={c.title} className="col">
              <h5>{c.title} <small>{list.length}</small></h5>
              {list.map(t => <Card key={t.id} t={t} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
