// 이벤트를 받아 "지금 누가 어디서 뭘 하는지"(직원 상태)를 유지한다.
import type { FloorConfig } from '../../shared/src/config.ts';
import type { FloorSummary, OfficeEvent, Worker } from '../../shared/src/events.ts';

const AWAY_AFTER = 30 * 60_000;
const FORGET_LEFT_AFTER = 10 * 60_000;

export interface Change {
  changed: Worker[];
  removed: string[];
}

export class OfficeState {
  readonly workers = new Map<string, Worker>();
  private readonly floors: FloorConfig[];

  constructor(floors: FloorConfig[]) {
    this.floors = floors;
  }

  private create(id: string, e: OfficeEvent, agentId: string | null, agentType: string | null): Worker {
    const w: Worker = {
      id, sessionId: e.sessionId, agentId, agentType, floor: e.floor, teamId: e.teamId,
      status: 'idle', zone: agentId ? 'elevator' : 'desk', summary: '출근', tool: null,
      startedAt: e.ts, lastSeen: e.ts, toolCount: 0,
    };
    this.workers.set(id, w);
    return w;
  }

  apply(e: OfficeEvent): Change {
    const changed = new Set<Worker>();
    const removed: string[] = [];
    const main = this.workers.get(e.sessionId) ?? this.create(e.sessionId, e, null, null);
    main.lastSeen = e.ts;
    changed.add(main);

    const subId = e.agentId ? `${e.sessionId}/${e.agentId}` : null;
    let target = main;
    if (subId && e.kind !== 'subagent.stop') {
      target = this.workers.get(subId) ?? this.create(subId, e, e.agentId, e.agentType);
      target.lastSeen = e.ts;
      changed.add(target);
    }

    switch (e.kind) {
      case 'session.start':
        Object.assign(main, { status: 'idle', zone: 'desk', summary: e.summary, floor: e.floor, teamId: e.teamId });
        break;
      case 'session.end':
        Object.assign(main, { status: 'left', zone: 'elevator', summary: e.summary });
        for (const w of this.workers.values()) {
          if (w.sessionId === e.sessionId && w.agentId) { this.workers.delete(w.id); removed.push(w.id); changed.delete(w); }
        }
        break;
      case 'prompt':
        Object.assign(main, { status: 'working', zone: 'desk', summary: e.summary });
        break;
      case 'tool.start':
        Object.assign(target, { status: 'working', zone: e.zone ?? target.zone, summary: e.summary, tool: e.tool });
        target.toolCount++;
        break;
      case 'tool.end':
      case 'tool.fail':
        if (target.status === 'waiting') target.status = 'working';
        break;
      case 'permission.request':
        Object.assign(target, { status: 'waiting', summary: e.summary });
        break;
      case 'permission.denied':
        Object.assign(target, { summary: e.summary });
        break;
      case 'notification':
        if (e.summary === '결재 대기') Object.assign(target, { status: 'waiting' });
        else if (e.summary === '지시 대기 중') Object.assign(main, { status: 'idle', zone: 'lounge', summary: e.summary });
        break;
      case 'subagent.start':
        Object.assign(target, { status: 'working', zone: 'elevator', summary: e.summary });
        break;
      case 'subagent.stop':
        if (subId && this.workers.delete(subId)) removed.push(subId);
        break;
      case 'stop':
        Object.assign(main, { status: 'idle', zone: 'lounge', summary: e.summary, tool: null });
        break;
      case 'stop.fail':
        Object.assign(main, { status: 'error', summary: e.summary });
        break;
      case 'compact.start':
        Object.assign(target, { status: 'working', zone: 'lounge', summary: e.summary });
        break;
      case 'compact.end':
        Object.assign(target, { zone: 'desk', summary: e.summary });
        break;
      case 'cwd.changed':
        Object.assign(main, { floor: e.floor, teamId: e.teamId });
        break;
    }
    return { changed: [...changed], removed };
  }

  /** 오래 소식 없는 직원은 away, 퇴근한 지 오래된 직원은 목록에서 뺀다 */
  tick(now: number): Change {
    const changed: Worker[] = [];
    const removed: string[] = [];
    for (const w of this.workers.values()) {
      if (w.status === 'left') {
        if (now - w.lastSeen > FORGET_LEFT_AFTER) { this.workers.delete(w.id); removed.push(w.id); }
      } else if (w.status !== 'away' && w.status !== 'waiting' && now - w.lastSeen > AWAY_AFTER) {
        w.status = 'away';
        changed.push(w);
      }
    }
    return { changed, removed };
  }

  /** 훅이 아닌 곳에서 만든 직원 (회의 참석자) 넣기·빼기 */
  put(changed: Worker[], removed: string[]): Change {
    for (const w of changed) this.workers.set(w.id, { ...w });
    const gone = removed.filter(id => this.workers.delete(id));
    return { changed, removed: gone };
  }

  list(): Worker[] {
    return [...this.workers.values()];
  }

  floorSummaries(): FloorSummary[] {
    return this.floors.map(f => {
      const ws = this.list().filter(w => w.floor === f.floor && w.status !== 'left');
      return {
        floor: f.floor, label: f.label, name: f.name,
        working: ws.filter(w => w.status === 'working').length,
        waiting: ws.filter(w => w.status === 'waiting').length,
        total: ws.length,
      };
    });
  }
}
