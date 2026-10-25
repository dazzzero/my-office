// 서버와 WebSocket으로 연결된 사무실 상태.
import { create } from 'zustand';
import type { FloorConfig } from '../../shared/src/config.ts';
import type { FloorSummary, OfficeEvent, ServerMessage, Worker } from '../../shared/src/events.ts';

const MAX_EVENTS = 300;

interface OfficeStore {
  floorsConfig: FloorConfig[];
  connected: boolean;
  workers: Record<string, Worker>;
  /** 서버에서 빠졌지만 엘리베이터까지 걸어가는 중인 직원 */
  departing: Record<string, Worker>;
  floors: FloorSummary[];
  events: OfficeEvent[];
  selectedFloor: number;
  selectedWorkerId: string | null;
  selectFloor: (floor: number) => void;
  selectWorker: (id: string | null) => void;
  finishDeparture: (id: string) => void;
}

export const useOffice = create<OfficeStore>()(set => ({
  floorsConfig: [],
  connected: false,
  workers: {},
  departing: {},
  floors: [],
  events: [],
  selectedFloor: 1,
  selectedWorkerId: null,
  selectFloor: floor => set({ selectedFloor: floor, selectedWorkerId: null }),
  selectWorker: id => set({ selectedWorkerId: id }),
  finishDeparture: id => set(s => {
    const departing = { ...s.departing };
    delete departing[id];
    return { departing };
  }),
}));

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
  }
}

export async function startOffice() {
  const res = await fetch('/api/config');
  const config = (await res.json()) as { defaultFloor: number; floors: FloorConfig[] };
  // 앱을 열면 항상 기본 층(1F)부터. 단, 알림을 눌러 들어온 경우(?floor=N)는 그 층
  const fromToast = Number(new URLSearchParams(location.search).get('floor'));
  const start = config.floors.some(f => f.floor === fromToast) ? fromToast : config.defaultFloor;
  useOffice.setState({ floorsConfig: config.floors, selectedFloor: start });

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
