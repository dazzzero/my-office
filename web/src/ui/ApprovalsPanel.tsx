import { useState } from 'react';
import { workerName } from '../../../shared/src/identity.ts';
import type { Approval } from '../../../shared/src/tasks.ts';
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

export function ApprovalsPanel() {
  const approvals = useOffice(s => s.approvals);
  const mode = useOffice(s => s.terminalMode);
  const office = mode === 'office';
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
      {approvals.length === 0 && <p className="empty">결재할 일이 없어요 ☕</p>}
      {approvals.map(a => <ApprovalCard key={a.id} a={a} />)}
    </div>
  );
}
