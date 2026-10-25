import { useEffect, useState } from 'react';
import type { TaskLogEntry } from '../../../shared/src/tasks.ts';
import { workerName } from '../../../shared/src/identity.ts';
import { api } from '../api.ts';
import { attempt, findTeam, useOffice } from '../store.ts';
import { TASK_STATUS, ago, hhmm } from './labels.ts';

const LOG_ICON: Record<TaskLogEntry['kind'], string> = { instruction: '🧑‍💼', text: '💬', tool: '🔧', result: '✅', approval: '📥', system: 'ℹ️' };

export function TaskPanel({ taskId }: { taskId: number }) {
  const task = useOffice(s => s.tasks.find(t => t.id === taskId));
  const floors = useOffice(s => s.floorsConfig);
  const openPanel = useOffice(s => s.openPanel);
  const selectFloor = useOffice(s => s.selectFloor);
  const selectWorker = useOffice(s => s.selectWorker);
  const [log, setLog] = useState<TaskLogEntry[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  // 업무 상태가 바뀔 때마다 업무일지 다시 읽기
  useEffect(() => {
    let alive = true;
    api<TaskLogEntry[]>('GET', `/api/tasks/${taskId}/log`).then(l => alive && setLog(l)).catch(() => {});
    return () => { alive = false; };
  }, [taskId, task?.updatedAt]);

  if (!task) return <div className="panel-body"><p className="empty">칸반에서 치운 업무예요.</p></div>;
  const where = findTeam(floors, task.teamId);
  const st = TASK_STATUS[task.status];
  const canFollowUp = ['done', 'failed', 'stopped'].includes(task.status);
  const active = ['draft', 'queued', 'planning', 'plan_review', 'running', 'approval'].includes(task.status);

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await attempt(fn); setBusy(false); };

  return (
    <div className="panel-body task">
      <div className="task-head">
        <span className={`status tone-${st.tone}`}>{st.label}</span>
        <b>{task.title}</b>
      </div>
      <dl>
        <dt>어디</dt><dd>{where ? `${where.floor.label} ${where.floor.name} · ${where.team.name}` : task.teamId}{task.agent ? ` · ${task.agent}` : ''}</dd>
        <dt>시작</dt><dd>{hhmm(task.createdAt)} ({ago(task.createdAt)})</dd>
        {task.sessionId && (
          <>
            <dt>담당</dt>
            <dd>
              <a onClick={() => { selectFloor(task.floor); selectWorker(task.sessionId); }}>{workerName({ sessionId: task.sessionId, agentType: null })}</a>
              {task.live ? ' · 대기 중(이어서 지시 가능)' : ''}
            </dd>
          </>
        )}
        {task.costUsd > 0 && <><dt>사용량</dt><dd>약 ${task.costUsd.toFixed(2)} 상당 (구독 한도에서 차감, 별도 청구 없음)</dd></>}
      </dl>

      {task.plan && <><h4>계획</h4><pre className="plan">{task.plan}</pre></>}
      {task.result && <><h4>{task.status === 'failed' ? '결과 (실패)' : '결과 보고'}</h4><pre className="result">{task.result}</pre></>}
      {task.error && task.status !== 'done' && <p className="error">{task.error}</p>}

      <div className="actions">
        {task.status === 'draft' && <button className="primary" disabled={busy} onClick={() => run(() => api('POST', `/api/tasks/${task.id}/start`, {}))}>보내기</button>}
        {(task.status === 'plan_review' || task.status === 'approval') && <button className="primary" onClick={() => openPanel('approvals')}>결재함 열기</button>}
        {active && <button className="danger" disabled={busy} onClick={() => run(() => api('POST', `/api/tasks/${task.id}/stop`, {}))}>중지</button>}
        {!active && <button disabled={busy} onClick={() => run(async () => { await api('POST', `/api/tasks/${task.id}/archive`, {}); openPanel(null); })}>칸반에서 치우기</button>}
      </div>

      {canFollowUp && (
        <div className="follow-up">
          <textarea rows={3} placeholder="이어서 지시 (다시 계획 → 결재 → 실행)" value={text} onChange={e => setText(e.target.value)} />
          <button className="primary" disabled={busy || !text.trim()} onClick={() => run(async () => { await api('POST', `/api/tasks/${task.id}/message`, { text }); setText(''); })}>이어서 지시</button>
        </div>
      )}

      <h4>업무일지</h4>
      <ul className="tasklog">
        {log.map(l => (
          <li key={l.id} className={`k-${l.kind}`}>
            <time>{hhmm(l.ts)}</time><span className="ic">{LOG_ICON[l.kind]}</span>
            <span className="txt">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
