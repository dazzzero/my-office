import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { MyOfficeConfig } from '../../shared/src/config.ts';
import { D, W, buildFloorPlan, type Spot } from '../src/office/layout.ts';
import { findPath, reachable } from '../src/office/path.ts';

// 예시 설정 + (있으면) 내 실제 설정 둘 다 검사한다. 내 설정은 git에 올라가지 않는다
const read = (name: string) => {
  const url = new URL(`../../${name}`, import.meta.url);
  return existsSync(url) ? (JSON.parse(readFileSync(url, 'utf8')) as MyOfficeConfig) : null;
};
const configs = [read('myoffice.config.example.json')!, read('myoffice.config.json')].filter(c => c !== null);
const config = configs[0];

for (const [ci, floor] of configs.flatMap((c, ci) => c.floors.map(f => [ci, f] as const))) {
  test(`[${ci === 0 ? '예시' : '내 설정'}] ${floor.label}: 모든 자리가 엘리베이터에서 걸어갈 수 있고 겹치지 않는다`, () => {
    const plan = buildFloorPlan(floor);
    assert.equal(plan.islands.length, floor.teams.length + 1, '팀 섬 + 공용 좌석');
    assert.deepEqual(plan.islands.slice(0, -1).map(i => i.teamId), floor.teams.map(t => t.id));

    const all: Spot[] = [...plan.islands.flatMap(i => i.seats), ...Object.values(plan.spots).flat()];
    const { cell, cols, blocked } = plan.grid;
    for (const s of all) {
      assert.ok(s.x > 0 && s.x < W && s.z > 0 && s.z < D, `${s.key} 바닥 안`);
      const k = Math.floor(s.z / cell) * cols + Math.floor(s.x / cell);
      // 소파처럼 가구 위에 앉는 자리는 막힌 칸이어도 된다 (길찾기는 도착 칸을 항상 통과로 본다)
      if (s.pose === 'stand') assert.equal(blocked[k], 0, `${s.key} 자리가 가구에 묻혀 있음 (${s.x}, ${s.z})`);
      assert.ok(reachable(plan.grid, [plan.elevator.x, plan.elevator.z], [s.x, s.z]), `${s.key}에 갈 수 없음`);
    }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const d = Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z);
      assert.ok(d > 0.3, `${all[i].key}와 ${all[j].key}가 너무 가까움 (${d.toFixed(2)})`);
    }
  });
}

test('팀이 너무 많으면 거부', () => {
  const teams = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, name: `팀${i}`, path: `C:\\t${i}` }));
  assert.throws(() => buildFloorPlan({ teams }));
});

test('길찾기: 책상 섬을 가로지르지 않고 돌아간다', () => {
  const plan = buildFloorPlan(config.floors[0]);
  const seat = plan.islands[0].seats[0];
  const path = findPath(plan.grid, [plan.elevator.x, plan.elevator.z], [seat.x, seat.z]);
  assert.ok(path.length >= 2, '직선이 아니라 여러 구간');
  assert.deepEqual(path.at(-1), [seat.x, seat.z]);
});
