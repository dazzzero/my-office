// 층 하나의 배치도. 모든 층이 같은 골격을 쓰고 팀 책상 섬 개수만 다르다(1~3개 + 공용 좌석).
// 좌표: x → 오른쪽(0..W), z → 앞쪽(0..D), 뒷벽 z=0, 왼쪽 벽 x=0. 단위 = Kenney 바닥 타일 1칸.
// 캐릭터·가구는 회전 0일 때 +z(화면 앞쪽)를 바라본다.
import type { FloorConfig } from '../../../shared/src/config.ts';
import type { Zone } from '../../../shared/src/events.ts';

export const W = 14;
export const D = 10;
export const WALL_H = 1.3;
export const DESK_H = 0.38;

export type Pose = 'sit' | 'stand';
/** 직원이 머무를 수 있는 자리 */
export interface Spot {
  key: string;
  zone: Zone;
  x: number;
  z: number;
  /** 바라보는 방향 (y축 회전, 0 = +z) */
  rot: number;
  pose: Pose;
}

export interface Placement {
  model: string;
  x: number;
  z: number;
  rot?: number;
  y?: number;
  /** 길찾기에서 막힌 칸으로 칠지 (기본: MODEL_SIZE에 있으면 막음) */
  block?: boolean;
}

export type BlockKind = 'box' | 'glass' | 'rack' | 'elevator' | 'window' | 'wall';
/** 코드로 그리는 상자 (벽·유리·서버랙·엘리베이터 등). x,z는 왼쪽 위 모서리 */
export interface Block {
  kind: BlockKind;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  y?: number;
  color: string;
  block?: boolean;
}

export interface Area {
  zone: Zone | 'work';
  x: number;
  z: number;
  w: number;
  d: number;
  color: string;
  label?: string;
}

export interface Island {
  teamId: string;
  name: string;
  hot: boolean;
  x: number;
  z: number;
  seats: Spot[];
}

export interface Grid {
  cell: number;
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

export type SharedZone = Exclude<Zone, 'desk' | 'boss'>;

export interface FloorPlan {
  areas: Area[];
  placements: Placement[];
  blocks: Block[];
  islands: Island[];
  /** 자료실·서버실 등 공용 공간의 자리 */
  spots: Record<SharedZone, Spot[]>;
  /** 출퇴근 지점 */
  elevator: Spot;
  grid: Grid;
}

/** 길을 막는 가구의 바닥 크기 [가로, 세로] (회전 0 기준) */
export const MODEL_SIZE: Record<string, [number, number]> = {
  desk: [0.73, 0.56],
  bookcaseOpen: [0.4, 0.25],
  table: [0.84, 0.45],
  tableCoffee: [0.66, 0.4],
  loungeSofa: [0.98, 0.41],
  loungeChair: [0.5, 0.5],
  pottedPlant: [0.4, 0.4],
  plantSmall1: [0.25, 0.25],
  plantSmall2: [0.25, 0.25],
  lampRoundFloor: [0.25, 0.25],
  trashcan: [0.2, 0.2],
};

const PI = Math.PI;
const SOUTH = 0, NORTH = PI, EAST = PI / 2;

export const ISLAND_SLOTS: [number, number][] = [[5.3, 3.0], [8.4, 3.0], [5.3, 6.7], [8.4, 6.7]];
export const MAX_TEAMS = ISLAND_SLOTS.length - 1;

/** 책상 6개 섬: 북쪽 줄은 앞(+z)을, 남쪽 줄은 뒤(-z)를 보고 앉는다 */
function buildIsland(cx: number, cz: number, teamId: string, name: string, hot: boolean, out: Placement[]): Island {
  const seats: Spot[] = [];
  for (let i = 0; i < 3; i++) {
    const x = +(cx + (i - 1) * 0.76).toFixed(2);
    for (const side of [-1, 1] as const) {
      const deskZ = cz + side * 0.29;
      const seatZ = deskZ + side * 0.62;
      const facing = side < 0 ? SOUTH : NORTH;
      out.push(
        { model: 'desk', x, z: deskZ },
        { model: hot ? 'laptop' : 'computerScreen', x, z: deskZ - side * 0.12, y: DESK_H, rot: facing + PI, block: false },
        { model: 'chairDesk', x, z: seatZ, rot: facing, block: false },
      );
      seats.push({ key: `${teamId}:${seats.length}`, zone: 'desk', x, z: +seatZ.toFixed(2), rot: facing, pose: 'sit' });
    }
  }
  return { teamId, name, hot, x: cx, z: cz, seats };
}

export function buildFloorPlan(floor: Pick<FloorConfig, 'teams'>): FloorPlan {
  if (floor.teams.length > MAX_TEAMS) throw new Error(`한 층에 팀은 최대 ${MAX_TEAMS}개까지 배치할 수 있습니다`);
  const placements: Placement[] = [];
  const blocks: Block[] = [];

  const areas: Area[] = [
    { zone: 'work', x: 0, z: 0, w: W, d: D, color: '#eef0f3' },
    { zone: 'library', x: 0, z: 0, w: 3.6, d: 3.8, color: '#e9dcc8', label: '📚 자료실' },
    { zone: 'server', x: 10.5, z: 0, w: 3.5, d: 3.8, color: '#d3d8df', label: '🖥️ 서버실' },
    { zone: 'window', x: 3.9, z: 0, w: 6.3, d: 1.35, color: '#e6eef6', label: '🪟 창가' },
    { zone: 'lounge', x: 0, z: 6.4, w: 3.6, d: 3.6, color: '#dcebe0', label: '☕ 라운지' },
    { zone: 'meeting', x: 10.5, z: 5.0, w: 3.5, d: 5.0, color: '#e3e7f4', label: '🗣️ 회의실' },
  ];

  // 벽, 창문, 엘리베이터
  blocks.push(
    { kind: 'wall', x: -0.08, z: -0.08, w: W + 0.08, d: 0.08, h: WALL_H, color: '#f6f7f9', block: false },
    { kind: 'wall', x: -0.08, z: 0, w: 0.08, d: D, h: WALL_H, color: '#eceef2', block: false },
    { kind: 'window', x: 4.2, z: -0.01, w: 5.6, d: 0.02, h: 0.7, y: 0.42, color: '#cfe3f3', block: false },
    { kind: 'elevator', x: 0, z: 4.35, w: 0.06, d: 1.1, h: 1.15, color: '#a7b0bc', block: false },
  );
  const elevator: Spot = { key: 'elevator', zone: 'elevator', x: 0.55, z: 4.9, rot: EAST, pose: 'stand' };

  // 📚 자료실: 뒷벽 책장 + 열람 테이블
  for (let i = 0; i < 7; i++) placements.push({ model: 'bookcaseOpen', x: +(0.35 + i * 0.47).toFixed(2), z: 0.25 });
  placements.push({ model: 'table', x: 1.75, z: 2.65 }, { model: 'books', x: 1.6, z: 2.65, y: 0.33, block: false });
  const library: Spot[] = [0.6, 1.55, 2.5, 3.2].map((x, i) => ({ key: `library:${i}`, zone: 'library', x, z: 0.95, rot: NORTH, pose: 'stand' }));
  for (const [i, x] of [1.45, 2.05].entries()) {
    placements.push({ model: 'chairModernCushion', x, z: 3.2, rot: NORTH, block: false });
    library.push({ key: `library:t${i}`, zone: 'library', x, z: 3.2, rot: NORTH, pose: 'sit' });
  }

  // 🪟 창가: 창 쪽을 보는 긴 바 테이블 + 스툴
  blocks.push({ kind: 'box', x: 4.0, z: 0.18, w: 6.0, d: 0.42, h: DESK_H, color: '#f4f1ec' });
  const windowSpots: Spot[] = [];
  for (let i = 0; i < 6; i++) {
    const x = 4.5 + i;
    placements.push({ model: 'stoolBar', x, z: 0.95, rot: NORTH, block: false });
    windowSpots.push({ key: `window:${i}`, zone: 'window', x, z: 0.95, rot: NORTH, pose: 'sit' });
  }

  // 🖥️ 서버실: 서버랙 4대 + 관리 콘솔
  blocks.push({ kind: 'glass', x: 10.46, z: 0, w: 0.04, d: 3.8, h: 0.9, color: '#a9cbe3' });
  const server: Spot[] = [];
  for (let i = 0; i < 4; i++) {
    const x = 10.95 + i * 0.75;
    blocks.push({ kind: 'rack', x: x - 0.28, z: 0.1, w: 0.56, d: 0.6, h: 1.15, color: '#363d4a' });
    server.push({ key: `server:${i}`, zone: 'server', x, z: 1.25, rot: NORTH, pose: 'stand' });
  }
  placements.push({ model: 'table', x: 12.3, z: 2.75 }, { model: 'laptop', x: 12.3, z: 2.75, y: 0.33, rot: PI, block: false });
  server.push(
    { key: 'server:c0', zone: 'server', x: 11.95, z: 3.3, rot: NORTH, pose: 'stand' },
    { key: 'server:c1', zone: 'server', x: 12.65, z: 3.3, rot: NORTH, pose: 'stand' },
  );

  // ☕ 라운지: 벽쪽 소파 2개 + 커피 테이블 + 커피 머신
  placements.push(
    { model: 'rugRectangle', x: 1.3, z: 8.0, rot: EAST, block: false },
    { model: 'loungeSofa', x: 0.3, z: 7.4, rot: EAST },
    { model: 'loungeSofa', x: 0.3, z: 8.6, rot: EAST },
    { model: 'tableCoffee', x: 1.45, z: 8.0, rot: EAST },
    { model: 'loungeChair', x: 2.5, z: 9.4, rot: NORTH, block: false },
    { model: 'kitchenCoffeeMachine', x: 2.8, z: 6.95, y: DESK_H, block: false },
  );
  blocks.push({ kind: 'box', x: 2.35, z: 6.72, w: 0.9, d: 0.42, h: DESK_H, color: '#d9d4cc' });
  const lounge: Spot[] = [
    ...[7.15, 7.65, 8.35, 8.85].map((z, i): Spot => ({ key: `lounge:${i}`, zone: 'lounge', x: 0.6, z, rot: EAST, pose: 'sit' })),
    { key: 'lounge:coffee', zone: 'lounge', x: 2.8, z: 7.55, rot: NORTH, pose: 'stand' },
    { key: 'lounge:chair', zone: 'lounge', x: 2.5, z: 9.4, rot: NORTH, pose: 'sit' },
  ];

  // 🗣️ 회의실: 유리 벽(문 틈 있음) + 테이블 + 의자 6개
  blocks.push(
    { kind: 'glass', x: 10.46, z: 5.0, w: 0.04, d: 5.0, h: 0.9, color: '#a9cbe3' },
    { kind: 'glass', x: 11.5, z: 4.96, w: 2.5, d: 0.04, h: 0.9, color: '#a9cbe3' },
    { kind: 'box', x: 11.6, z: 6.7, w: 2.0, d: 0.8, h: DESK_H, color: '#f7f5f0' },
  );
  const meeting: Spot[] = [];
  for (const [row, z, rot] of [[0, 6.3, SOUTH], [1, 7.9, NORTH]] as const) {
    for (let i = 0; i < 3; i++) {
      const x = 12.0 + i * 0.6;
      placements.push({ model: 'chairModernCushion', x, z, rot, block: false });
      meeting.push({ key: `meeting:${row}${i}`, zone: 'meeting', x, z, rot, pose: 'sit' });
    }
  }

  // 화분
  for (const [x, z] of [[3.75, 0.35], [10.2, 0.35], [13.65, 4.55], [3.75, 9.6], [10.1, 9.6]]) placements.push({ model: 'pottedPlant', x, z });

  // 팀 책상 섬 + 공용 좌석
  const islands = floor.teams.map((t, i) => buildIsland(...ISLAND_SLOTS[i], t.id, t.name, false, placements));
  islands.push(buildIsland(...ISLAND_SLOTS[floor.teams.length], 'hot', '공용 좌석', true, placements));

  const spots = { library, server, window: windowSpots, meeting, lounge, elevator: [elevator] };
  return { areas, placements, blocks, islands, spots, elevator, grid: buildGrid(placements, blocks) };
}

const MARGIN = 0.13;

function buildGrid(placements: Placement[], blocks: Block[]): Grid {
  const cell = 0.25, cols = Math.round(W / cell), rows = Math.round(D / cell);
  const blocked = new Uint8Array(cols * rows);
  const mark = (x: number, z: number, w: number, d: number) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cx = (c + 0.5) * cell, cz = (r + 0.5) * cell;
      if (cx > x - MARGIN && cx < x + w + MARGIN && cz > z - MARGIN && cz < z + d + MARGIN) blocked[r * cols + c] = 1;
    }
  };
  for (const p of placements) {
    const size = MODEL_SIZE[p.model];
    if (!size || p.block === false) continue;
    const turned = Math.abs(Math.sin(p.rot ?? 0)) > 0.7;
    const [w, d] = turned ? [size[1], size[0]] : size;
    mark(p.x - w / 2, p.z - d / 2, w, d);
  }
  for (const b of blocks) if (b.block !== false) mark(b.x, b.z, b.w, b.d);
  return { cell, cols, rows, blocked };
}
