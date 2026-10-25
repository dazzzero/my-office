import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Task } from '../../../shared/src/tasks.ts';
import { api } from '../api.ts';
import { attempt, findTeam, useOffice } from '../store.ts';
import { AgentSelect } from './CommandPanel.tsx';

interface Line {
  who: 'me' | 'secretary';
  text: string;
  drafts?: number[];
}

/** 비서가 만든 초안: 팀·직원을 고쳐서 보내거나 버린다 */
function DraftCard({ id }: { id: number }) {
  const task = useOffice(s => s.tasks.find(t => t.id === id));
  const floors = useOffice(s => s.floorsConfig);
  const openPanel = useOffice(s => s.openPanel);
  const [teamId, setTeamId] = useState(task?.teamId ?? '');
  const [agent, setAgent] = useState<string | null>(task?.agent ?? null);
  const [busy, setBusy] = useState(false);
  if (!task) return null;
  const where = findTeam(floors, teamId);
  if (task.status !== 'draft') {
    return <div className="draft sent" onClick={() => openPanel({ taskId: id })}>✔ 보냄 · {task.title} <em>(눌러서 보기)</em></div>;
  }
  return (
    <div className="draft">
      <b>{task.title}</b>
      <p>{task.instruction}</p>
      <div className="row">
        <select value={teamId} onChange={e => { setTeamId(e.target.value); setAgent(null); }}>
          {floors.map(f => (
            <optgroup key={f.floor} label={`${f.label} ${f.name}`}>
              {f.teams.map(t => <option key={t.id} value={t.id}>{f.label} · {t.name}</option>)}
            </optgroup>
          ))}
        </select>
        <AgentSelect teamId={teamId} value={agent} onChange={setAgent} />
      </div>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={async () => {
          setBusy(true);
          await attempt(() => api('POST', `/api/tasks/${id}/start`, { teamId, agent }));
          setBusy(false);
        }}>{where ? `${where.floor.label} ${where.team.name}에 보내기` : '보내기'}</button>
        <button disabled={busy} onClick={() => attempt(() => api('POST', `/api/tasks/${id}/archive`, {}))}>버리기</button>
      </div>
    </div>
  );
}

// 창을 닫았다 열어도 대화가 남도록 따로 보관
const useChat = create<{ lines: Line[]; busy: boolean; add: (l: Line) => void; setBusy: (b: boolean) => void }>()(set => ({
  lines: [{ who: 'secretary', text: '무엇을 맡길까요? 말씀하시면 어느 층·팀에 보낼지 정리해서 초안으로 드릴게요. 확인하신 뒤에 보내면 됩니다.' }],
  busy: false,
  add: l => set(s => ({ lines: [...s.lines, l] })),
  setBusy: busy => set({ busy }),
}));

export function ChatPanel() {
  const { lines, busy, add, setBusy } = useChat();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [lines.length]);

  const send = async () => {
    const msg = text.trim();
    if (!msg) return;
    setText('');
    add({ who: 'me', text: msg });
    setBusy(true);
    const res = await attempt(() => api<{ reply: string; drafts: Task[] }>('POST', '/api/secretary', { text: msg }));
    setBusy(false);
    add(res
      ? { who: 'secretary', text: res.reply, drafts: res.drafts.map(d => d.id) }
      : { who: 'secretary', text: '죄송해요, 지금은 답할 수 없어요. 잠시 뒤 다시 말씀해 주세요.' });
  };

  return (
    <div className="panel-body chat">
      <div className="lines">
        {lines.map((l, i) => (
          <div key={i} className={`line ${l.who}`}>
            <div className="bubble-chat">{l.text}</div>
            {l.drafts?.map(id => <DraftCard key={id} id={id} />)}
          </div>
        ))}
        {busy && <div className="line secretary"><div className="bubble-chat typing">비서가 정리하는 중…</div></div>}
        <div ref={end} />
      </div>
      <div className="composer">
        <textarea rows={2} placeholder="예) 쇼핑몰 로그인 오류 확인하고, ERP 주문 API 문서도 정리해줘" value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
        <button className="primary" disabled={busy || !text.trim()} onClick={send}>보내기</button>
      </div>
    </div>
  );
}
