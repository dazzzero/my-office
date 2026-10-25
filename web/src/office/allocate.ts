// 직원마다 지금 가 있어야 할 자리를 정한다. 한 번 앉은 자리는 공간이 바뀌기 전까지 유지한다.
import type { Worker } from '../../../shared/src/events.ts';
import type { FloorPlan, SharedZone, Spot } from './layout.ts';

export type Placed = Pick<Worker, 'id' | 'sessionId' | 'agentId' | 'teamId' | 'zone' | 'status' | 'startedAt'> & { departing?: boolean };

export class SpotAllocator {
  private held = new Map<string, Spot>();
  private readonly plan: FloorPlan;

  constructor(plan: FloorPlan) {
    this.plan = plan;
  }

  assign(workers: Placed[]): Map<string, Spot> {
    const result = new Map<string, Spot>();
    const taken = new Set<string>();
    const ids = new Set(workers.map(w => w.id));
    for (const id of this.held.keys()) if (!ids.has(id)) this.held.delete(id);

    const take = (w: Placed, candidates: Spot[]): Spot | null => {
      const prev = this.held.get(w.id);
      const pick = (prev && candidates.some(c => c.key === prev.key) && !taken.has(prev.key) ? prev : null)
        ?? candidates.find(c => !taken.has(c.key))
        ?? null;
      if (pick) taken.add(pick.key);
      return pick;
    };

    // 1) 세션 본인: 팀 섬의 자기 책상 (먼저 출근한 순서). 자리가 모자라면 공용 좌석
    const desks = new Map<string, Spot>();
    const mains = workers.filter(w => !w.agentId && !w.departing && w.status !== 'left').sort((a, b) => a.startedAt - b.startedAt);
    const hot = this.plan.islands.find(i => i.hot)!.seats;
    const deskTaken = new Set<string>();
    for (const w of mains) {
      const island = this.plan.islands.find(i => i.teamId === w.teamId);
      const seat = [...(island?.seats ?? []), ...hot].find(s => !deskTaken.has(s.key));
      if (seat) { deskTaken.add(seat.key); desks.set(w.id, seat); }
    }

    // 2) 지금 있어야 할 곳
    const order = [...workers].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    for (const w of order) {
      let spot: Spot | null = null;
      if (w.departing || w.status === 'left' || w.zone === 'elevator') {
        spot = this.plan.elevator;
      } else if (w.zone === 'desk' || w.zone === 'boss') {
        const own = desks.get(w.id);
        spot = own && !taken.has(own.key) ? (taken.add(own.key), own) : take(w, hot.filter(s => !deskTaken.has(s.key)));
      } else {
        spot = take(w, this.plan.spots[w.zone as SharedZone] ?? []);
      }
      // 그 공간이 꽉 찼으면 창가 → 라운지 → 엘리베이터 앞 순서로 빈자리
      spot ??= take(w, this.plan.spots.window) ?? take(w, this.plan.spots.lounge) ?? this.plan.elevator;
      if (spot !== this.plan.elevator) this.held.set(w.id, spot);
      result.set(w.id, spot);
    }
    return result;
  }
}
