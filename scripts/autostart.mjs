// 윈도우에 로그인하면 마이오피스 서버를 창 없이 켠다 (아침 루틴·알림·결재함이 항상 동작하게).
// 시작프로그램 폴더에 바로가기 하나를 만들거나 지운다. 관리자 권한은 필요 없다.
// 사용: node scripts/autostart.mjs            설치
//       node scripts/autostart.mjs --status   확인
//       node scripts/autostart.mjs --uninstall 제거
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../hooks/common.mjs';

const STARTUP = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LINK = join(STARTUP, '마이오피스 서버.lnk');
const args = new Set(process.argv.slice(2));

const ps = script => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8' });
const q = s => `'${s.replace(/'/g, "''")}'`;

if (args.has('--status')) {
  if (!existsSync(LINK)) {
    console.log('⏸️  자동 실행 꺼짐 (설치: npm run autostart:install)');
  } else {
    const r = ps(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(LINK)}); "$($s.TargetPath) $($s.Arguments)"`);
    console.log(`✅ 자동 실행 켜짐: ${LINK}\n   실행: ${r.stdout.trim()}`);
  }
} else if (args.has('--uninstall')) {
  if (existsSync(LINK)) { rmSync(LINK); console.log('🗑️  자동 실행을 껐습니다 (시작프로그램 바로가기 삭제).'); }
  else console.log('자동 실행 바로가기가 없습니다.');
} else {
  // office.mjs --no-window: 서버만 백그라운드로 띄우고 바로 끝난다 (최소화된 창이 잠깐 떴다가 닫힘)
  const r = ps([
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${q(LINK)})`,
    `$s.TargetPath = ${q(process.execPath)}`,
    `$s.Arguments = ${q(`"${join(ROOT, 'scripts', 'office.mjs')}" --no-window`)}`,
    `$s.WorkingDirectory = ${q(ROOT)}`,
    '$s.WindowStyle = 7',
    `$s.Description = ${q('마이오피스 서버 (로그인 시 자동 실행)')}`,
    '$s.Save()',
  ].join('\n'));
  if (r.status !== 0 || !existsSync(LINK)) {
    console.error(`바로가기를 만들지 못했습니다.\n${r.stderr}`);
    process.exit(1);
  }
  console.log(`✅ 자동 실행 설치: 다음 로그인부터 서버가 창 없이 켜집니다.\n   ${LINK}\n   끄기: npm run autostart:uninstall`);
}
