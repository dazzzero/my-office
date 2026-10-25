// 휴대폰 연결: Tailscale serve로 https://<이PC>.ts.net 주소를 마이오피스(127.0.0.1:포트)에 연결한다.
// 내 Tailscale 기기에서만 열린다 (인터넷 공개인 funnel은 쓰지 않음). 서버는 계속 127.0.0.1에서만 열려 있다.
// 사용: node scripts/phone.mjs           상태 보기
//       node scripts/phone.mjs --serve   연결
//       node scripts/phone.mjs --off     연결 해제
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { serverUrl } from '../hooks/common.mjs';

const EXE = existsSync('C:\\Program Files\\Tailscale\\tailscale.exe') ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
const port = new URL(serverUrl()).port || '7777';
const target = `http://127.0.0.1:${port}`;
const args = new Set(process.argv.slice(2));

let status;
try {
  status = JSON.parse(execFileSync(EXE, ['status', '--json'], { encoding: 'utf8' }));
} catch {
  console.error('❌ Tailscale이 없거나 꺼져 있어요. https://tailscale.com/download 에서 설치하고 로그인해 주세요.');
  process.exit(1);
}
if (status.BackendState !== 'Running') {
  console.error(`❌ Tailscale이 실행 중이 아니에요 (${status.BackendState}). 트레이의 Tailscale에서 연결(Connect)해 주세요.`);
  process.exit(1);
}
const dns = status.Self.DNSName.replace(/\.$/, '');
const certs = (status.CertDomains ?? []).includes(dns);
const serve = () => spawnSync(EXE, ['serve', 'status'], { encoding: 'utf8' }).stdout.trim();

if (args.has('--off')) {
  const r = spawnSync(EXE, ['serve', '--https=443', 'off'], { encoding: 'utf8' });
  console.log(r.status === 0 ? '🔌 휴대폰 연결(Tailscale serve)을 껐습니다.' : r.stderr || r.stdout);
  process.exit(r.status ?? 1);
}

if (args.has('--serve')) {
  if (!certs) {
    console.error([
      '❌ HTTPS 인증서가 아직 꺼져 있어요 (앱 설치·알림에 필요).',
      '   https://login.tailscale.com/admin/dns → 아래쪽 "HTTPS Certificates" → Enable 을 누른 뒤 다시 실행해 주세요.',
    ].join('\n'));
    process.exit(1);
  }
  // --bg: 이 창을 닫아도, PC를 다시 켜도 유지된다
  const r = spawnSync(EXE, ['serve', '--bg', '--https=443', target], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(r.status ?? 1); }
  console.log(`✅ 휴대폰 연결 준비 완료: https://${dns}  →  ${target}\n   (내 Tailscale 기기에서만 열림)\n   다음: PC 마이오피스 📱 → "휴대폰 연결 QR 만들기"\n\n${serve()}`);
  process.exit(0);
}

console.log([
  `Tailscale: 켜짐 · ${dns} · ${status.User?.[String(status.Self.UserID)]?.LoginName ?? ''}`,
  `HTTPS 인증서: ${certs ? '✅ 켜짐' : '⬜ 꺼짐 — https://login.tailscale.com/admin/dns 에서 "HTTPS Certificates" Enable'}`,
  `마이오피스 연결: ${serve().includes(`127.0.0.1:${port}`) ? `✅ https://${dns}` : '⬜ 안 됨 — npm run phone:serve'}`,
].join('\n'));
