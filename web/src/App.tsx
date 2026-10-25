import { useState } from 'react';
import { OfficeScene, zoomBy } from './office/Scene.tsx';
import { useOffice } from './store.ts';
import { ApprovalsPanel } from './ui/ApprovalsPanel.tsx';
import { ChatPanel } from './ui/ChatPanel.tsx';
import { CommandPanel } from './ui/CommandPanel.tsx';
import { Kanban } from './ui/Kanban.tsx';
import { LeftPanel } from './ui/LeftPanel.tsx';
import { RightPanel } from './ui/RightPanel.tsx';
import { TaskPanel } from './ui/TaskPanel.tsx';

function Drawer() {
  const panel = useOffice(s => s.panel);
  const openPanel = useOffice(s => s.openPanel);
  const commandTeam = useOffice(s => s.commandTeam);
  const approvals = useOffice(s => s.approvals.length);
  if (!panel) return null;
  const title = panel === 'approvals' ? `📥 결재함 (${approvals})`
    : panel === 'command' ? '📝 지시하기'
    : panel === 'chat' ? '💬 대표실 — 비서'
    : '📋 업무';
  return (
    <div className="drawer">
      <div className="drawer-head"><b>{title}</b><button onClick={() => openPanel(null)}>✕</button></div>
      {panel === 'approvals' && <ApprovalsPanel />}
      {panel === 'command' && <CommandPanel key={commandTeam ?? 'none'} />}
      {panel === 'chat' && <ChatPanel />}
      {typeof panel === 'object' && <TaskPanel key={panel.taskId} taskId={panel.taskId} />}
    </div>
  );
}

export function App() {
  const floor = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  const connected = useOffice(s => s.connected);
  const approvals = useOffice(s => s.approvals.length);
  const active = useOffice(s => s.tasks.filter(t => !['draft', 'done', 'failed', 'stopped', 'rejected'].includes(t.status)).length);
  const panel = useOffice(s => s.panel);
  const kanban = useOffice(s => s.kanban);
  const toast = useOffice(s => s.toast);
  const openPanel = useOffice(s => s.openPanel);
  const openCommand = useOffice(s => s.openCommand);
  const toggleKanban = useOffice(s => s.toggleKanban);
  const [zoomKey, setZoomKey] = useState(0);

  return (
    <div className="app">
      <LeftPanel />
      <main>
        <header>
          {floor && (
            <div className="card">
              <span className="no">{floor.label}</span>
              <b>{floor.name}</b>
              <em>{floor.teams.map(t => t.name).join(' · ')}</em>
            </div>
          )}
          <span className={`live${connected ? '' : ' off'}`}>{connected ? '● LIVE' : '○ 연결 중…'}</span>
          <div className="toolbar">
            <button className={`inbox${approvals ? ' has' : ''}${panel === 'approvals' ? ' on' : ''}`} onClick={() => openPanel(panel === 'approvals' ? null : 'approvals')}>
              📥 결재함{approvals > 0 && <span className="count">{approvals}</span>}
            </button>
            <button className={panel === 'command' ? 'on' : ''} onClick={() => (panel === 'command' ? openPanel(null) : openCommand(null))}>📝 지시하기</button>
            <button className={panel === 'chat' ? 'on' : ''} onClick={() => openPanel(panel === 'chat' ? null : 'chat')}>💬 대표실</button>
            <button className={kanban ? 'on' : ''} onClick={toggleKanban}>📋 칸반{active > 0 && <span className="count gray">{active}</span>}</button>
          </div>
        </header>
        <div className="view">
          {floor && <OfficeScene floor={floor} zoomKey={zoomKey} />}
          <div className="zoom">
            <button onClick={() => zoomBy(1.2)} title="확대">+</button>
            <button onClick={() => zoomBy(1 / 1.2)} title="축소">−</button>
            <button onClick={() => setZoomKey(k => k + 1)} title="처음 화면으로">⟲</button>
          </div>
          <Drawer />
          {kanban && <Kanban />}
          {toast && <div className="toast">⚠️ {toast}</div>}
        </div>
      </main>
      <RightPanel />
    </div>
  );
}
