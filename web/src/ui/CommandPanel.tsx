import { useEffect, useState } from 'react';
import type { Task, TeamAgent } from '../../../shared/src/tasks.ts';
import { api } from '../api.ts';
import { attempt, useOffice } from '../store.ts';

/** 팀의 고정 직원 목록 (.claude/agents) */
export function useAgents(teamId: string | null) {
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  useEffect(() => {
    if (!teamId) return setAgents([]);
    let alive = true;
    api<TeamAgent[]>('GET', `/api/teams/${teamId}/agents`).then(a => alive && setAgents(a)).catch(() => alive && setAgents([]));
    return () => { alive = false; };
  }, [teamId]);
  return agents;
}

export function AgentSelect({ teamId, value, onChange }: { teamId: string | null; value: string | null; onChange: (v: string | null) => void }) {
  const agents = useAgents(teamId);
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">일반 직원 (지정 안 함)</option>
      {agents.map(a => (
        <option key={a.name} value={a.name}>{a.name}{a.scope === 'user' ? ' (공용)' : ''}{a.description ? ` — ${a.description.slice(0, 40)}` : ''}</option>
      ))}
    </select>
  );
}

export function CommandPanel() {
  const floors = useOffice(s => s.floorsConfig);
  const selectedFloor = useOffice(s => s.selectedFloor);
  const presetTeam = useOffice(s => s.commandTeam);
  const openPanel = useOffice(s => s.openPanel);
  const running = useOffice(s => s.tasks.filter(t => t.live).length);
  const max = useOffice(s => s.maxConcurrent);

  const initialFloor = floors.find(f => f.teams.some(t => t.id === presetTeam))?.floor ?? selectedFloor;
  const [floor, setFloor] = useState(initialFloor);
  const floorCfg = floors.find(f => f.floor === floor);
  const [teamId, setTeamId] = useState<string | null>(presetTeam ?? floorCfg?.teams[0]?.id ?? null);
  const [agent, setAgent] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);

  // 층을 바꾸면 그 층의 첫 팀으로
  useEffect(() => {
    if (!floorCfg?.teams.some(t => t.id === teamId)) setTeamId(floorCfg?.teams[0]?.id ?? null);
  }, [floorCfg, teamId]);
  useEffect(() => setAgent(null), [teamId]);

  const submit = async (draft: boolean) => {
    if (!teamId || !instruction.trim()) return;
    setBusy(true);
    const task = await attempt(() => api<Task>('POST', '/api/tasks', { instruction, teamId, agent, title: title || undefined, draft, source: draft ? 'kanban' : 'direct' }));
    setBusy(false);
    if (task) openPanel(draft ? null : { taskId: task.id });
  };

  return (
    <div className="panel-body form">
      <label>층
        <select value={floor} onChange={e => setFloor(Number(e.target.value))}>
          {[...floors].sort((a, b) => a.floor - b.floor).map(f => <option key={f.floor} value={f.floor}>{f.label} {f.name}</option>)}
        </select>
      </label>
      <label>팀
        <select value={teamId ?? ''} onChange={e => setTeamId(e.target.value)}>
          {floorCfg?.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <label>직원 <AgentSelect teamId={teamId} value={agent} onChange={setAgent} /></label>
      <label>제목 <input placeholder="비우면 지시 첫 줄로" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>지시
        <textarea rows={7} placeholder="예) 주문 목록 화면에서 날짜순 정렬이 거꾸로 돼. 원인 찾아서 고쳐줘." value={instruction} onChange={e => setInstruction(e.target.value)} />
      </label>
      <p className="hint">보내면 먼저 <b>계획</b>을 세워 결재함에 올립니다. 승인해야 실제로 바꿉니다. (지금 {running}/{max}개 실행 중)</p>
      <div className="actions">
        <button className="primary" disabled={busy || !instruction.trim()} onClick={() => submit(false)}>지시 보내기</button>
        <button disabled={busy || !instruction.trim()} onClick={() => submit(true)}>칸반에 초안으로</button>
      </div>
    </div>
  );
}
