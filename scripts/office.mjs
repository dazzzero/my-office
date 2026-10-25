// 마이오피스 한 번에 열기: (필요하면) 화면 빌드 → 서버를 백그라운드로 실행 → Edge 앱 창으로 열기
// 사용: node scripts/office.mjs            열기
//       node scripts/office.mjs --restart  서버를 새로 띄워서 열기 (코드가 바뀐 뒤)
//       node scripts/office.mjs --stop     서버 끄기
//       node scripts/office.mjs --no-window 창은 열지 않고 서버만
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, serverUrl } from '../hooks/common.mjs';

const args = new Set(process.argv.slice(2));
const url = serverUrl();
const PID_FILE = join(ROOT, 'data', 'server.pid');
const LOG_FILE = join(ROOT, 'data', 'server.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const healthy = async () => {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
};

function stopServer() {
  if (!existsSync(PID_FILE)) return false;
  const pid = Number(readFileSync(PID_FILE, 'utf8'));
  try { process.kill(pid); } catch {}
  rmSync(PID_FILE, { force: true });
  return true;
}

if (args.has('--stop')) {
  console.log(stopServer() ? '🛑 마이오피스 서버를 껐습니다.' : '실행 중인 마이오피스 서버가 없습니다 (이 스크립트로 띄운 것 기준).');
  process.exit(0);
}

if (args.has('--restart')) { stopServer(); await sleep(500); }

if (!existsSync(join(ROOT, 'web', 'dist', 'index.html')) || args.has('--restart')) {
  console.log('🔨 화면 빌드 중…');
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: join(ROOT, 'web'), stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!(await healthy())) {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server', 'src', 'index.ts')], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  for (let i = 0; i < 40 && !(await healthy()); i++) await sleep(250);
  if (!(await healthy())) {
    console.error(`서버가 뜨지 않았습니다. 로그: ${LOG_FILE}`);
    process.exit(1);
  }
  console.log(`🏢 서버 실행: ${url}  (로그: data\\server.log, 끄기: npm run office:stop)`);
} else {
  console.log(`🏢 서버는 이미 실행 중: ${url}`);
}

if (!args.has('--no-window')) {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
  if (edge) spawn(edge, [`--app=${url}`, '--window-size=1600,900'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log('🪟 마이오피스 창을 열었습니다.');
}
