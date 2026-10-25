// 서버와 WebSocket으로 연결된 사무실 상태.
import { create } from 'zustand';
import type { FloorConfig } from '../../shared/src/config.ts';
import type { FloorSummary, OfficeEvent, ServerMessage, Worker } from '../../shared/src/events.ts';
import type { Meeting, MeetingLine, MorningStatus } from '../../shared/src/meetings.ts';
import type { Approval, Task, TerminalApprovalMode } from '../../shared/src/tasks.ts';
import { initKey } from './api.ts';

const MAX_EVENTS = 300;

/** 오른쪽에 겹쳐 여는 창 */
export type Panel = null | 'approvals' | 'command' | 'chat' | 'meetings' | { taskId: number } | { meetingId: number };

interface OfficeStore {
  floorsConfig: FloorConfig[];
  maxConcurrent: number;
  connected: boolean;
  workers: Record<string, Worker>;
  /** 서버에서 빠졌지만 엘리베이터까지 걸어가는 중인 직원 */
  departing: Record<string, Worker>;
  floors: FloorSummary[];
  events: OfficeEvent[];
  tasks: Task[];
  approvals: Approval[];
  terminalMode: TerminalApprovalMode;
  meetings: Meeting[];
  morning: MorningStatus | null;
  /** 열어 본 회의의 발언 (회의 상세를 열 때 읽고, 이후엔 실시간으로 붙는다) */
  meetingLines: Record<number, MeetingLine[]>;
  selectedFloor: number;
  selectedWorkerId: string | null;
  panel: Panel;
  kanban: boolean;
  /** 지시하기 창을 특정 팀으로 열 때 */
  commandTeam: string | null;
  toast: string | null;
  selectFloor: (floor: number) => void;
  selectWorker: (id: string | null) => void;
  finishDeparture: (id: string) => void;
  openPanel: (p: Panel) => void;
  openCommand: (teamId?: string | null) => void;
  toggleKanban: () => void;
  showToast: (msg: string | null) => void;
}

export const useOffice = create<OfficeStore>()(set => ({
  floorsConfig: [],
  maxConcurrent: 10,
  connected: false,
  workers: {},
  departing: {},
  floors: [],
  events: [],
  tasks: [],
  approvals: [],
  terminalMode: 'terminal',
  meetings: [],
  morning: null,
  meetingLines: {},
  selectedFloor: 1,
  selectedWorkerId: null,
  panel: null,
  kanban: false,
  commandTeam: null,
  toast: null,
  selectFloor: floor => set({ selectedFloor: floor, selectedWorkerId: null }),
  selectWorker: id => set({ selectedWorkerId: id }),
  finishDeparture: id => set(s => {
    const departing = { ...s.departing };
    delete departing[id];
    return { departing };
  }),
  openPanel: panel => set({ panel }),
  openCommand: teamId => set({ panel: 'command', commandTeam: teamId ?? null }),
  toggleKanban: () => set(s => ({ kanban: !s.kanban })),
  showToast: toast => set({ toast }),
}));

/** 에러를 화면 아래 알림으로 */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    useOffice.getState().showToast((e as Error).message);
    setTimeout(() => useOffice.getState().showToast(null), 5000);
    return undefined;
  }
}

/** teamId → 층 설정과 팀 */
export function findTeam(floors: FloorConfig[], teamId: string) {
  for (const f of floors) {
    const team = f.teams.find(t => t.id === teamId);
    if (team) return { floor: f, team };
  }
  return null;
}

function applyChanges(changed: Worker[], removed: string[]) {
  useOffice.setState(s => {
    const workers = { ...s.workers };
    const departing = { ...s.departing };
    for (const w of changed) workers[w.id] = w;
    for (const id of removed) {
      if (workers[id]) departing[id] = workers[id];
      delete workers[id];
    }
    return { workers, departing };
  });
}

function handle(msg: ServerMessage) {
  switch (msg.type) {
    case 'snapshot':
      useOffice.setState({
        workers: Object.fromEntries(msg.workers.map(w => [w.id, w])),
        departing: {},
        floors: msg.floors,
        events: msg.recent,
        tasks: msg.tasks,
        approvals: msg.approvals,
        terminalMode: msg.terminalMode,
        meetings: msg.meetings,
        morning: msg.morning,
      });
      break;
    case 'meetings':
      useOffice.setState({ meetings: msg.meetings, morning: msg.morning });
      break;
    case 'meeting.line':
      useOffice.setState(s => {
        const have = s.meetingLines[msg.line.meetingId];
        if (!have || have.some(l => l.id === msg.line.id)) return {};
        return { meetingLines: { ...s.meetingLines, [msg.line.meetingId]: [...have, msg.line] } };
      });
      break;
    case 'event':
      applyChanges(msg.changed, msg.removed);
      useOffice.setState(s => ({ floors: msg.floors, events: [msg.event, ...s.events].slice(0, MAX_EVENTS) }));
      break;
    case 'tick':
      applyChanges(msg.changed, msg.removed);
      useOffice.setState({ floors: msg.floors });
      break;
    case 'work':
      useOffice.setState({ tasks: msg.tasks, approvals: msg.approvals, terminalMode: msg.terminalMode });
      break;
  }
}

export async function startOffice() {
  await initKey();
  const res = await fetch('/api/config');
  const config = (await res.json()) as { defaultFloor: number; floors: FloorConfig[]; maxConcurrent: number };
  // 앱을 열면 항상 기본 층(1F)부터. 단, 알림을 눌러 들어온 경우(?floor=N)는 그 층
  const fromToast = Number(new URLSearchParams(location.search).get('floor'));
  const start = config.floors.some(f => f.floor === fromToast) ? fromToast : config.defaultFloor;
  useOffice.setState({ floorsConfig: config.floors, maxConcurrent: config.maxConcurrent, selectedFloor: start });

  let retry = 500;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { retry = 500; useOffice.setState({ connected: true }); };
    ws.onmessage = m => handle(JSON.parse(m.data as string) as ServerMessage);
    ws.onclose = () => {
      useOffice.setState({ connected: false });
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10_000);
    };
  };
  connect();
}
