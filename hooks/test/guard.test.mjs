import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decide, hookOutput } from '../guard-core.mjs';

const config = JSON.parse(readFileSync(new URL('../../myoffice.config.example.json', import.meta.url), 'utf8'));
const inShop = { cwd: 'C:\\work\\shop\\backend\\src' };
const bash = command => ({ ...inShop, tool_name: 'Bash', tool_input: { command } });

test('git push → 결재(ask), 폴더째 삭제 → 결재(ask)', () => {
  assert.equal(decide(config, bash('git push origin main'))?.action, 'ask');
  assert.equal(decide(config, { ...inShop, tool_name: 'PowerShell', tool_input: { command: 'Remove-Item dist -Recurse -Force' } })?.action, 'ask');
});

test('DB 쓰기 → 차단(deny), 조회는 통과', () => {
  assert.equal(decide(config, bash(`py -c "import pymysql; cur.execute('DELETE FROM t'); c.commit()"`))?.action, 'deny');
  assert.equal(decide(config, bash('mysql -e "SELECT TRUNCATE(amt,2) FROM t"')), null);
});

test('여러 규칙에 걸리면 deny가 우선', () => {
  const r = decide(config, bash(`git push && py -c "import pymysql; cur.execute('UPDATE t SET a=1')"`));
  assert.equal(r?.action, 'deny');
  assert.equal(r?.rule.id, 'db-write');
});

test('실제 명령일 때만 걸리고, 글자로만 들어 있으면 통과 (오탐 방지)', () => {
  assert.equal(decide(config, bash('cd repo && git push'))?.action, 'ask');
  assert.equal(decide(config, bash('git -C C:/repo push origin main'))?.action, 'ask');
  assert.equal(decide(config, bash('npm test; rm -rf dist'))?.action, 'ask');
  assert.equal(decide(config, { ...inShop, tool_name: 'PowerShell', tool_input: { command: 'Set-Location x; Remove-Item .\\out -Recurse' } })?.action, 'ask');
  // 스크립트 파일을 쓰는데 내용에 그 글자가 들어 있는 경우
  assert.equal(decide(config, bash(`cat > t.mjs <<'EOF'\nawait post({ text: 'git push --dry-run 해봐' })\nEOF`)), null);
  assert.equal(decide(config, bash('echo "rm -rf 는 위험해요"')), null);
  assert.equal(decide(config, bash(`node -e "const d = '폴더째 삭제 (Remove-Item -Recurse 등)'"`)), null);
});

test('결재 창 문구: 무엇이 왜 걸렸는지 한국어로', () => {
  const ask = hookOutput(decide(config, bash('npm run build && git push origin main'))).hookSpecificOutput.permissionDecisionReason;
  assert.match(ask, /^\[마이오피스 결재\] 원격 저장소로 push하는 명령이 들어 있어요: ".*git push origin main.*" — 실행해도 되면 승인/);
  const deny = hookOutput(decide(config, bash(`py -c "import pymysql; cur.execute('DELETE FROM t')"`))).hookSpecificOutput.permissionDecisionReason;
  assert.match(deny, /^\[마이오피스 차단\] DB 직접 쓰기/);
});

test('등록되지 않은 폴더, 다른 도구, 평범한 명령은 그냥 통과', () => {
  assert.equal(decide(config, { cwd: 'C:\\Users\\me\\Desktop', tool_name: 'Bash', tool_input: { command: 'git push' } }), null);
  assert.equal(decide(config, { ...inShop, tool_name: 'Read', tool_input: { file_path: 'a' } }), null);
  assert.equal(decide(config, bash('git status')), null);
});

test('훅 출력 형식 (Claude Code PreToolUse)', () => {
  const out = hookOutput(decide(config, bash('git push')));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /원격 저장소로 push/);
});

test('guard.mjs 실행: 깨진 입력이면 조용히 통과 (작업을 멈추지 않음)', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../guard.mjs', import.meta.url))], { input: 'not json' });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout), '');
});
