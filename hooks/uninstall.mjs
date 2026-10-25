// ~/.claude/settings.json에서 마이오피스 훅만 제거한다 (다른 훅은 그대로 둠).
import { backupSettings, countOurs, readSettings, stripOurs, writeSettings } from './common.mjs';

const file = readSettings();
const before = countOurs(file.settings);
if (!before) {
  console.log('설치된 마이오피스 훅이 없습니다.');
  process.exit(0);
}
const backup = backupSettings();
writeSettings({ ...file, settings: stripOurs(file.settings) });
console.log(`🗑️  마이오피스 훅 ${before}개 제거 완료 (백업: ${backup})`);
