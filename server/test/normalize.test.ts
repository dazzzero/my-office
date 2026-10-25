import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize, shrink, toolSummary, toolZone } from '../src/normalize.ts';

test('도구 → 공간', () => {
  assert.equal(toolZone('Read'), 'library');
  assert.equal(toolZone('Grep'), 'library');
  assert.equal(toolZone('Edit'), 'desk');
  assert.equal(toolZone('Write'), 'desk');
  assert.equal(toolZone('Bash'), 'server');
  assert.equal(toolZone('PowerShell'), 'server');
  assert.equal(toolZone('mcp__mariadb__search_objects'), 'server');
  assert.equal(toolZone('WebSearch'), 'window');
  assert.equal(toolZone('Agent'), 'meeting');
  assert.equal(toolZone('TodoWrite'), 'desk');
});

test('도구 설명 한 줄', () => {
  assert.equal(toolSummary('Read', { file_path: 'C:\\work\\src\\api\\client.ts' }), 'client.ts 읽는 중');
  assert.equal(toolSummary('Edit', { file_path: '/a/b/LoginForm.vue' }), 'LoginForm.vue 수정 중');
  assert.equal(toolSummary('Bash', { command: 'npm test', description: 'Run tests' }), 'Run tests');
  assert.equal(toolSummary('Bash', { command: 'git status\ngit log' }), 'git status');
  assert.equal(toolSummary('WebFetch', { url: 'https://code.claude.com/docs' }), 'code.claude.com 보는 중');
  assert.equal(toolSummary('Agent', { subagent_type: 'Explore', description: '훅 찾기' }), 'Explore 호출: 훅 찾기');
  assert.equal(toolSummary('mcp__mariadb__search_objects', {}), 'mariadb.search_objects 사용 중');
  assert.ok(toolSummary('Bash', { command: 'x'.repeat(200) }).length <= 60);
});

test('훅 이벤트 → 종류와 설명', () => {
  assert.deepEqual(normalize({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'useAuth' } }),
    { kind: 'tool.start', tool: 'Grep', zone: 'library', summary: '"useAuth" 검색 중' });
  assert.equal(normalize({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })?.summary, '결재 대기');
  assert.equal(normalize({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } })?.summary, '결재 요청: rm -rf x');
  assert.equal(normalize({ hook_event_name: 'SubagentStart', agent_type: 'Explore' })?.summary, 'Explore 출근');
  assert.equal(normalize({ hook_event_name: 'SessionStart', source: 'resume' })?.summary, '복귀');
  assert.equal(normalize({ hook_event_name: 'StopFailure', error: 'rate_limit' })?.summary, '오류: rate_limit');
  assert.equal(normalize({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })?.summary, '자동 모드가 막음: rm -rf build');
  assert.equal(normalize({ hook_event_name: 'NotARealEvent' }), null);
});

test('shrink: 긴 문자열과 큰 배열을 자른다', () => {
  const out = shrink({ content: 'a'.repeat(1000), list: Array.from({ length: 50 }, (_, i) => i) }) as { content: string; list: number[] };
  assert.ok(out.content.length < 520);
  assert.equal(out.list.length, 20);
});
