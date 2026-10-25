// graphics.html#bench 를 실제 GPU 헤드리스 Edge로 열어 렌더러별 프레임 시간을 수집한다.
// 사용: node bench.mjs [dpr]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333, dpr = process.argv[2] || '1';
const url = 'file:///c:/dev/mylab/prototypes/graphics.html#bench';
const proc = spawn(EDGE, ['--headless=new', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist',
  `--force-device-scale-factor=${dpr}`, '--window-size=1440,900', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'bench-'))}`, url], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(300);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); };
  const evalJs = expr => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr } })); });
  let text;
  for (let i = 0; i < 120 && !text; i++) {
    await sleep(500);
    text = (await evalJs("document.getElementById('bench')?.textContent"))?.result?.value;
  }
  console.log(text || 'timeout');
  ws.close();
} finally { proc.kill(); }
