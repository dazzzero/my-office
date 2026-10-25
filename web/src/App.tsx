import { useState } from 'react';
import { OfficeScene, zoomBy } from './office/Scene.tsx';
import { useOffice } from './store.ts';
import { LeftPanel } from './ui/LeftPanel.tsx';
import { RightPanel } from './ui/RightPanel.tsx';

export function App() {
  const floor = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  const connected = useOffice(s => s.connected);
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
        </header>
        <div className="view">
          {floor && <OfficeScene floor={floor} zoomKey={zoomKey} />}
          <div className="zoom">
            <button onClick={() => zoomBy(1.2)} title="확대">+</button>
            <button onClick={() => zoomBy(1 / 1.2)} title="축소">−</button>
            <button onClick={() => setZoomKey(k => k + 1)} title="처음 화면으로">⟲</button>
          </div>
        </div>
      </main>
      <RightPanel />
    </div>
  );
}
