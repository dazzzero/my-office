import { useState } from 'react';
import { MEETING_ACTIVE } from '../../shared/src/meetings.ts';
import { isRemote } from './api.ts';
import { dismissInstall, install, useInstall } from './install.ts';
import { OfficeScene, zoomBy } from './office/Scene.tsx';
import { useOffice, type Panel } from './store.ts';
import { ApprovalsPanel } from './ui/ApprovalsPanel.tsx';
import { ChatPanel } from './ui/ChatPanel.tsx';
import { CommandPanel } from './ui/CommandPanel.tsx';
import { Kanban } from './ui/Kanban.tsx';
import { LeftPanel } from './ui/LeftPanel.tsx';
import { MeetingDetail, MeetingsHome } from './ui/MeetingPanel.tsx';
import { MobilePeople } from './ui/MobilePeople.tsx';
import { PhonePanel } from './ui/PhonePanel.tsx';
import { RightPanel } from './ui/RightPanel.tsx';
import { TaskPanel } from './ui/TaskPanel.tsx';

const isMeeting = (p: Panel) => p === 'meetings' || (typeof p === 'object' && !!p && 'meetingId' in p);

function MobileMore() {
  const openPanel = useOffice(s => s.openPanel);
  const toggleKanban = useOffice(s => s.toggleKanban);
  const kanban = useOffice(s => s.kanban);
  const items: [string, string, () => void][] = [
    ['📋 칸반', '업무 흐름 한눈에', () => { openPanel(null); if (!kanban) toggleKanban(); }],
    ['💬 대표실 비서', '말로 하면 팀별 초안을 만들어 줘요', () => openPanel('chat')],
    ['👥 사람·활동', '이 층에 누가 있고 무엇을 했는지', () => openPanel('people')],
    ['🏢 층 안내', '층별 직원·결재 대기', () => openPanel('floors')],
    ['📱 알림·화면', '휴대폰 알림 켜기, 절전 모드', () => openPanel('phone')],
  ];
  return (
    <div className="panel-body more">
      {items.map(([title, sub, go]) => (
        <button key={title} className="more-item" onClick={go}><b>{title}</b><span>{sub}</span></button>
      ))}
    </div>
  );
}

function Drawer() {
  const panel = useOffice(s => s.panel);
  const openPanel = useOffice(s => s.openPanel);
  const commandTeam = useOffice(s => s.commandTeam);
  const approvals = useOffice(s => s.approvals.length);
  if (!panel) return null;
  const title = panel === 'approvals' ? `📥 결재함 (${approvals})`
    : panel === 'command' ? '📝 지시하기'
    : panel === 'chat' ? '💬 대표실 — 비서'
    : panel === 'phone' ? (isRemote ? '📱 알림·화면' : '📱 휴대폰 연결')
    : panel === 'more' ? '☰ 더보기'
    : panel === 'people' ? '👥 사람·활동'
    : panel === 'floors' ? '🏢 층 안내'
    : isMeeting(panel) ? '🗣️ 회의실'
    : '📋 업무';
  return (
    <div className="drawer">
      <div className="drawer-head"><b>{title}</b><button onClick={() => openPanel(null)}>✕</button></div>
      {panel === 'approvals' && <ApprovalsPanel />}
      {panel === 'command' && <CommandPanel key={commandTeam ?? 'none'} />}
      {panel === 'chat' && <ChatPanel />}
      {panel === 'meetings' && <MeetingsHome />}
      {panel === 'phone' && <PhonePanel />}
      {panel === 'more' && <MobileMore />}
      {panel === 'people' && <RightPanel />}
      {panel === 'floors' && <LeftPanel />}
      {typeof panel === 'object' && 'meetingId' in panel && <MeetingDetail key={panel.meetingId} meetingId={panel.meetingId} />}
      {typeof panel === 'object' && 'taskId' in panel && <TaskPanel key={panel.taskId} taskId={panel.taskId} />}
    </div>
  );
}

/** 휴대폰·태블릿 브라우저로 열었을 때: 앱으로 설치하라는 띠 (설치했거나 닫으면 안 보임) */
function InstallBanner() {
  const { installed, dismissed } = useInstall();
  const [help, setHelp] = useState(false);
  if (!isRemote || installed || dismissed) return null;
  return (
    <div className="install-banner">
      <img src="/icon-192.png" alt="" width={32} height={32} />
      <div>
        <b>마이오피스 앱 설치</b>
        <span>{help ? '크롬 메뉴(⋮) → "앱 설치" 또는 "홈 화면에 추가"를 눌러 주세요' : '주소 없이 홈 화면 아이콘으로 바로 열려요'}</span>
      </div>
      <button className="primary" onClick={async () => { if (!(await install())) setHelp(true); }}>설치</button>
      <button className="x" onClick={dismissInstall} title="닫기">✕</button>
    </div>
  );
}

/** 휴대폰: 아직 연결 안 된 기기 */
function PairScreen() {
  const error = useOffice(s => s.pairError);
  return (
    <div className="pair">
      <img src="/icon-192.png" alt="" width={72} height={72} />
      <h2>마이오피스</h2>
      <p>이 기기는 아직 연결되지 않았어요.</p>
      <ol>
        <li>PC 마이오피스 오른쪽 위 <b>📱 휴대폰</b> → <b>휴대폰 연결 QR 만들기</b></li>
        <li>이 기기 카메라로 QR 찍기</li>
      </ol>
      {error && <p className="error">⚠️ {error}</p>}
    </div>
  );
}

/** 창(결재함 등)·칸반·알림 띠 */
function Overlays() {
  const kanban = useOffice(s => s.kanban);
  const toast = useOffice(s => s.toast);
  return (
    <>
      <Drawer />
      {kanban && <Kanban />}
      {toast && <div className="toast">⚠️ {toast}</div>}
    </>
  );
}

/** PC: 3D 사무실 + 확대·축소·처음 화면 버튼 + 창들 */
function OfficeView({ zoomKey, onReset }: { zoomKey: number; onReset: () => void }) {
  const floor = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  return (
    <div className="view">
      {floor && <OfficeScene floor={floor} zoomKey={zoomKey} />}
      <div className="zoom">
        <button onClick={() => zoomBy(1.2)} title="확대">+</button>
        <button onClick={() => zoomBy(1 / 1.2)} title="축소">−</button>
        <button onClick={onReset} title="처음 화면으로">⟲</button>
      </div>
      <Overlays />
    </div>
  );
}

function DesktopApp() {
  const floor = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  const connected = useOffice(s => s.connected);
  const approvals = useOffice(s => s.approvals.length);
  const active = useOffice(s => s.tasks.filter(t => !['draft', 'done', 'failed', 'stopped', 'rejected'].includes(t.status)).length);
  const meetingsActive = useOffice(s => s.meetings.filter(m => MEETING_ACTIVE.includes(m.status)).length);
  const panel = useOffice(s => s.panel);
  const kanban = useOffice(s => s.kanban);
  const openPanel = useOffice(s => s.openPanel);
  const openCommand = useOffice(s => s.openCommand);
  const toggleKanban = useOffice(s => s.toggleKanban);
  const [zoomKey, setZoomKey] = useState(0);
  const toggle = (p: Exclude<Panel, null>) => openPanel(panel === p ? null : p);

  return (
    <div className="app">
      <LeftPanel />
      <main>
        <InstallBanner />
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
            {/* 폭이 좁으면 글자는 숨기고 아이콘만 (마우스를 올리면 이름) */}
            <button className={`inbox${approvals ? ' has' : ''}${panel === 'approvals' ? ' on' : ''}`} onClick={() => toggle('approvals')} title="결재함">
              📥<span className="lbl">결재함</span>{approvals > 0 && <span className="count">{approvals}</span>}
            </button>
            <button className={panel === 'command' ? 'on' : ''} onClick={() => (panel === 'command' ? openPanel(null) : openCommand(null))} title="지시하기">📝<span className="lbl">지시하기</span></button>
            <button className={panel === 'chat' ? 'on' : ''} onClick={() => toggle('chat')} title="대표실 비서">💬<span className="lbl">대표실</span></button>
            <button className={isMeeting(panel) ? 'on' : ''} onClick={() => toggle('meetings')} title="회의실">
              🗣️<span className="lbl">회의실</span>{meetingsActive > 0 && <span className="count blue">{meetingsActive}</span>}
            </button>
            <button className={kanban ? 'on' : ''} onClick={toggleKanban} title="칸반">📋<span className="lbl">칸반</span>{active > 0 && <span className="count gray">{active}</span>}</button>
            <button className={`narrow-only${panel === 'people' ? ' on' : ''}`} onClick={() => toggle('people')} title="사람·활동">👥</button>
            <button className={panel === 'phone' ? 'on' : ''} onClick={() => toggle('phone')} title={isRemote ? '알림·화면 설정' : '휴대폰 연결'}>📱</button>
          </div>
        </header>
        <OfficeView zoomKey={zoomKey} onReset={() => setZoomKey(k => k + 1)} />
      </main>
      <RightPanel />
    </div>
  );
}

/** 휴대폰: 위 = 층 고르기, 가운데 = 3D 사무실, 아래 = 탭. 창은 전체 화면으로 */
function MobileApp() {
  const floors = useOffice(s => s.floorsConfig);
  const floor = useOffice(s => s.floorsConfig.find(f => f.floor === s.selectedFloor));
  const summaries = useOffice(s => s.floors);
  const selectedFloor = useOffice(s => s.selectedFloor);
  const selectFloor = useOffice(s => s.selectFloor);
  const connected = useOffice(s => s.connected);
  const approvals = useOffice(s => s.approvals.length);
  const meetingsActive = useOffice(s => s.meetings.filter(m => MEETING_ACTIVE.includes(m.status)).length);
  const panel = useOffice(s => s.panel);
  const kanban = useOffice(s => s.kanban);
  const selectedWorker = useOffice(s => s.selectedWorkerId);
  const selectWorker = useOffice(s => s.selectWorker);
  const openPanel = useOffice(s => s.openPanel);
  const openCommand = useOffice(s => s.openCommand);
  const toggleKanban = useOffice(s => s.toggleKanban);
  const [zoomKey, setZoomKey] = useState(0);
  const go = (p: Panel) => { if (kanban) toggleKanban(); openPanel(p); };
  const tab = !panel && !kanban ? 'office' : panel === 'approvals' ? 'approvals' : panel === 'command' ? 'command' : isMeeting(panel) ? 'meetings' : 'more';

  return (
    <div className="mapp">
      <header className="mtop">
        <select value={selectedFloor} onChange={e => selectFloor(Number(e.target.value))}>
          {[...floors].sort((a, b) => b.floor - a.floor).map(f => {
            const s = summaries.find(x => x.floor === f.floor);
            return <option key={f.floor} value={f.floor}>{f.label} {f.name}{s?.total ? ` · ${s.total}명` : ''}{s?.waiting ? ` · ✋${s.waiting}` : ''}</option>;
          })}
        </select>
        <span className={`live${connected ? '' : ' off'}`}>{connected ? '● LIVE' : '○'}</span>
        <button className="icon" onClick={() => setZoomKey(k => k + 1)} title="처음 화면으로">⟲</button>
      </header>
      <InstallBanner />
      <div className="mbody">
        <div className="view">
          {/* 창이 화면을 다 덮고 있으면 3D는 그리지 않는다 (배터리) */}
          {floor && <OfficeScene floor={floor} zoomKey={zoomKey} paused={!!panel || kanban} />}
        </div>
        <MobilePeople />
        <Overlays />
        {selectedWorker && !panel && !kanban && (
          <div className="sheet">
            <button className="sheet-close" onClick={() => selectWorker(null)}>✕</button>
            <RightPanel />
          </div>
        )}
      </div>
      <nav className="mtabs">
        <button className={tab === 'office' ? 'on' : ''} onClick={() => go(null)}><i>🏢</i>사무실</button>
        <button className={tab === 'approvals' ? 'on' : ''} onClick={() => go('approvals')}><i>📥</i>결재{approvals > 0 && <span className="count">{approvals}</span>}</button>
        <button className={tab === 'command' ? 'on' : ''} onClick={() => { if (kanban) toggleKanban(); openCommand(null); }}><i>📝</i>지시</button>
        <button className={tab === 'meetings' ? 'on' : ''} onClick={() => go('meetings')}><i>🗣️</i>회의{meetingsActive > 0 && <span className="count blue">{meetingsActive}</span>}</button>
        <button className={tab === 'more' ? 'on' : ''} onClick={() => go('more')}><i>☰</i>더보기</button>
      </nav>
    </div>
  );
}

export function App() {
  const needPair = useOffice(s => s.needPair);
  const mobile = useOffice(s => s.mobile);
  if (needPair) return <PairScreen />;
  return mobile ? <MobileApp /> : <DesktopApp />;
}
