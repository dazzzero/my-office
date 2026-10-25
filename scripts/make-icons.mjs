// 앱 아이콘 만들기 (주황 바탕 + 흰 건물). 결과: web/public/icon-192.png, icon-512.png, icon-maskable-512.png, badge.png
// 사용: node scripts/make-icons.mjs  (그림을 바꿀 때만)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { ROOT } from '../hooks/common.mjs';

const ORANGE = [240, 122, 42, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** 0..1 좌표의 도형 목록으로 건물을 그린다: 몸체, 옥상 간판, 창문(뚫림), 문(뚫림) */
function building(x, y, s) {
  const solid = [
    [0.18, 0.22, 0.64, 0.78], // 몸체
    [0.38, 0.08, 0.24, 0.16], // 옥상
  ];
  const holes = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) holes.push([0.27 + c * 0.17, 0.3 + r * 0.13, 0.1, 0.08]);
  holes.push([0.42, 0.84, 0.16, 0.16]); // 문
  const inside = ([bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh;
  const u = { x: (x - (1 - s) / 2) / s, y: (y - (1 - s) / 2) / s };
  x = u.x; y = u.y;
  return solid.some(inside) && !holes.some(inside);
}

function render(size, { bg, fg, round, scale }) {
  const SS = 4; // 4배로 그려서 줄이면 가장자리가 부드럽다
  const px = new Float64Array(size * size * 4);
  for (let py = 0; py < size; py++) for (let pxx = 0; pxx < size; pxx++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (pxx + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
      let col = CLEAR;
      if (inRounded(x, y, round)) col = bg;
      if (building(x, y, scale)) col = fg;
      for (let k = 0; k < 4; k++) acc[k] += col[k];
    }
    for (let k = 0; k < 4; k++) px[(py * size + pxx) * 4 + k] = acc[k] / (SS * SS);
  }
  return png(size, px);
}

function inRounded(x, y, r) {
  if (r <= 0) return true;
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function png(size, px) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size * 4; x++) raw[y * (size * 4 + 1) + 1 + x] = Math.round(px[y * size * 4 + x]);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8비트 RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c;
}

const out = join(ROOT, 'web', 'public');
writeFileSync(join(out, 'icon-192.png'), render(192, { bg: ORANGE, fg: WHITE, round: 0.22, scale: 0.7 }));
writeFileSync(join(out, 'icon-512.png'), render(512, { bg: ORANGE, fg: WHITE, round: 0.22, scale: 0.7 }));
// 안드로이드가 원·둥근 사각형 등으로 잘라 쓰는 아이콘: 바탕을 꽉 채우고 건물은 안쪽 안전 영역(60%)에
writeFileSync(join(out, 'icon-maskable-512.png'), render(512, { bg: ORANGE, fg: WHITE, round: 0, scale: 0.55 }));
// 상태 표시줄 작은 아이콘: 투명 바탕에 흰 건물 (안드로이드가 모양만 씀)
writeFileSync(join(out, 'badge.png'), render(96, { bg: CLEAR, fg: WHITE, round: 0, scale: 0.85 }));
console.log('✅ 아이콘을 만들었습니다:', out);
