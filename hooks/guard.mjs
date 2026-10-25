// 공통 금지 목록 검사 훅 (PreToolUse · Bash/PowerShell).
// 마이오피스 서버 없이 Claude가 직접 실행한다 → Paseo·터미널·마이오피스 어디서 시킨 일이든 항상 검사.
// 판단이 안 서거나 오류가 나면 통과시킨다 (훅 오류로 작업이 멈추지 않게. 프로젝트 자체 규칙은 따로 작동).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, hookOutput } from './guard-core.mjs';

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(readFileSync(join(root, 'myoffice.config.json'), 'utf8'));
  const result = decide(config, payload);
  if (result) process.stdout.write(JSON.stringify(hookOutput(result)));
} catch {
  // 통과
}
