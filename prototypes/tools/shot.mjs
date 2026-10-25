// 실제 GPU 헤드리스 Edge로 페이지를 열고, 기다렸다가 스크린샷을 찍는다. (개발 확인용)
// 사용: node shot.mjs <url> <out.png> [waitMs=6000] [--eval "JS"] [--width 1600 --height 900]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, out, waitArg] = process.argv.slice(2);
const opt = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const wait = Number(waitArg) || 6000;
const evalJs = opt('--eval', null);
const width = Number(opt('--width', 1600)), height = Number(opt('--height', 900));
const dpr = opt('--dpr', '1');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9334;
const proc = spawn(EDGE, ['--headless=new', '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--hide-scrollbars',
  `--window-size=${width},${height}`, `--force-device-scale-factor=${dpr}`, `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shot-'))}`, 'about:blank'],
  { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(300);
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m.result ?? m.error);
    if (m.method === 'Runtime.consoleAPICalled') logs.push(`[${m.params.type}] ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Runtime.exceptionThrown') logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  };
  const cmd = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Runtime.enable');
  await cmd('Page.enable');
  await cmd('Page.navigate', { url });
  await sleep(wait);
  if (evalJs) {
    const r = await cmd('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
    console.log('eval:', JSON.stringify(r?.result?.value ?? r));
    await sleep(1500);
  }
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`saved ${out}`);
  if (logs.length) console.log(logs.slice(0, 20).join('\n'));
  ws.close();
} finally {
  proc.kill();
}
