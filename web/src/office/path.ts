// 격자 A* 길찾기 + 직선으로 갈 수 있는 구간은 펴서 자연스럽게 걷게 한다.
import type { Grid } from './layout.ts';

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export type Point = [number, number];

export function findPath(grid: Grid, from: Point, to: Point): Point[] {
  const { cell, cols, rows, blocked } = grid;
  const ci = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor(x / cell)));
  const ri = (z: number) => Math.min(rows - 1, Math.max(0, Math.floor(z / cell)));
  const s = ri(from[1]) * cols + ci(from[0]);
  const g = ri(to[1]) * cols + ci(to[0]);
  if (s === g) return [to];
  // 출발·도착 칸은 의자 위 등 막힌 칸일 수 있으므로 항상 통과로 본다
  const free = (n: number) => !blocked[n] || n === s || n === g;

  const n = cols * rows;
  const cost = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const h = (k: number) => Math.hypot((k % cols) - (g % cols), Math.floor(k / cols) - Math.floor(g / cols));
  const open: number[] = [s];
  cost[s] = 0;
  while (open.length) {
    let best = 0;
    for (let k = 1; k < open.length; k++) if (cost[open[k]] + h(open[k]) < cost[open[best]] + h(open[best])) best = k;
    const cur = open.splice(best, 1)[0];
    if (cur === g) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % cols, cz = Math.floor(cur / cols);
    for (const [dx, dz] of DIRS) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
      const m = nz * cols + nx;
      if (closed[m] || !free(m)) continue;
      if (dx && dz && (!free(cz * cols + nx) || !free(nz * cols + cx))) continue;
      const c = cost[cur] + (dx && dz ? Math.SQRT2 : 1);
      if (c < cost[m]) { cost[m] = c; came[m] = cur; open.push(m); }
    }
  }
  if (came[g] < 0) return [to]; // 길이 없으면 그냥 직선

  const cells: Point[] = [];
  for (let k = g; k !== s && k >= 0; k = came[k]) cells.push([(k % cols + 0.5) * cell, (Math.floor(k / cols) + 0.5) * cell]);
  cells.reverse();
  cells[cells.length - 1] = to;

  const clear = (a: Point, b: Point) => {
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (cell / 3));
    for (let k = 1; k < steps; k++) {
      const m = ri(a[1] + (b[1] - a[1]) * k / steps) * cols + ci(a[0] + (b[0] - a[0]) * k / steps);
      if (blocked[m] && m !== s && m !== g) return false;
    }
    return true;
  };
  const out: Point[] = [];
  let cur: Point = from;
  for (let i = 0; i < cells.length;) {
    let k = cells.length - 1;
    while (k > i && !clear(cur, cells[k])) k--;
    out.push(cells[k]);
    cur = cells[k];
    i = k + 1;
  }
  return out;
}

/** 이 점에서 저 점까지 막힌 칸을 피해 걸어갈 수 있는지 (배치도 검증용) */
export function reachable(grid: Grid, from: Point, to: Point): boolean {
  const { cell, cols } = grid;
  const s = Math.floor(from[1] / cell) * cols + Math.floor(from[0] / cell);
  const g = Math.floor(to[1] / cell) * cols + Math.floor(to[0] / cell);
  if (s === g) return true;
  const seen = new Uint8Array(grid.blocked.length);
  const queue = [s];
  seen[s] = 1;
  while (queue.length) {
    const k = queue.shift()!;
    if (k === g) return true;
    const x = k % cols, z = Math.floor(k / cols);
    for (const [dx, dz] of DIRS.slice(0, 4)) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= cols || nz >= grid.rows) continue;
      const m = nz * cols + nx;
      if (!seen[m] && (!grid.blocked[m] || m === g)) { seen[m] = 1; queue.push(m); }
    }
  }
  return false;
}
