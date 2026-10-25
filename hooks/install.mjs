// 마이오피스 훅을 ~/.claude/settings.json에 추가한다 (기존 훅은 그대로 둠).
// 사용: node hooks/install.mjs            설치 (자동 백업)
//       node hooks/install.mjs --dry-run  무엇이 추가될지만 보여줌
//       node hooks/install.mjs --status   설치 여부와 서버 상태
import {
  SETTINGS, backupSettings, countOurs, ensureToken, ourHookGroups, readSettings, serverUrl, stripOurs, writeSettings,
} from './common.mjs';

const args = new Set(process.argv.slice(2));
const file = readSettings();

if (args.has('--status')) {
  console.log(`설정 파일: ${SETTINGS}`);
  console.log(`마이오피스 훅: ${countOurs(file.settings)}개 설치됨`);
  try {
    const health = await (await fetch(`${serverUrl()}/health`, { signal: AbortSignal.timeout(1000) })).json();
    console.log(`서버: 실행 중 (${serverUrl()}, 이벤트 ${health.events}건, 직원 ${health.workers}명)`);
  } catch {
    console.log(`서버: 꺼져 있음 (${serverUrl()}) — 훅은 즉시 통과하므로 작업엔 영향 없음`);
  }
  process.exit(0);
}

const token = ensureToken();
const groups = ourHookGroups(token);

if (args.has('--dry-run')) {
  console.log(`[dry-run] ${SETTINGS}에 아래 훅을 추가합니다 (기존 훅 유지, 기존 마이오피스 훅은 교체):\n`);
  console.log(JSON.stringify(groups, null, 2).replace(token, '<토큰>'));
  process.exit(0);
}

const backup = backupSettings();
stripOurs(file.settings);
file.settings.hooks ??= {};
for (const [event, list] of Object.entries(groups)) (file.settings.hooks[event] ??= []).push(...list);
writeSettings(file);

console.log(`✅ 마이오피스 훅 ${countOurs(file.settings)}개 설치 완료`);
if (backup) console.log(`   백업: ${backup}`);
console.log('   새로 시작하는 Claude Code 세션부터 적용됩니다. 제거: npm run hooks:uninstall');
