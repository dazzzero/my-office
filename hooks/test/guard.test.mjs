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
