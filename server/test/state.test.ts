import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OfficeEvent } from '../../shared/src/events.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { OfficeState } from '../src/state.ts';

let id = 0;
const ev = (kind: OfficeEvent['kind'], extra: Partial<OfficeEvent> = {}): OfficeEvent => ({
  id: ++id, ts: 1_000_000 + id, kind, sessionId: 's1', agentId: null, agentType: null,
  floor: 3, teamId: 'blog-fe', cwd: 'C:\\work\\blog\\web', tool: null, zone: null, summary: kind, ...extra,
});

test('세션 하루: 출근 → 지시 → 자료실 → 결재 대기 → 승인 → 완료 → 퇴근', () => {
  const s = new OfficeState(loadConfig(EXAMPLE_CONFIG_FILE).floors);
  s.apply(ev('session.start', { summary: '출근' }));
  assert.equal(s.workers.get('s1')?.status, 'idle');

  s.apply(ev('prompt'));
  s.apply(ev('tool.start', { tool: 'Read', zone: 'library', summary: 'a.ts 읽는 중' }));
  const w = s.workers.get('s1')!;
  assert.equal(w.status, 'working');
  assert.equal(w.zone, 'library');
  assert.equal(w.summary, 'a.ts 읽는 중');
  assert.equal(w.toolCount, 1);

  s.apply(ev('permission.request', { tool: 'Bash', summary: '결재 요청: npm test' }));
  assert.equal(s.workers.get('s1')?.status, 'waiting');
  assert.equal(s.floorSummaries().find(f => f.floor === 3)?.waiting, 1);

  s.apply(ev('tool.end', { tool: 'Bash' }));
  assert.equal(s.workers.get('s1')?.status, 'working');

  s.apply(ev('stop', { summary: '업무 완료' }));
  assert.equal(s.workers.get('s1')?.zone, 'lounge');

  s.apply(ev('session.end', { summary: '퇴근' }));
  assert.equal(s.workers.get('s1')?.status, 'left');
  assert.equal(s.floorSummaries().find(f => f.floor === 3)?.total, 0);
});

test('서브에이전트: 엘리베이터로 출근, 자기 도구는 자기 상태에, 끝나면 퇴장', () => {
  const s = new OfficeState(loadConfig(EXAMPLE_CONFIG_FILE).floors);
  s.apply(ev('session.start'));
  s.apply(ev('subagent.start', { agentId: 'a1', agentType: 'Explore' }));
  assert.equal(s.workers.get('s1/a1')?.zone, 'elevator');

  s.apply(ev('tool.start', { agentId: 'a1', agentType: 'Explore', tool: 'Grep', zone: 'library', summary: 'g' }));
  assert.equal(s.workers.get('s1/a1')?.zone, 'library');
  assert.equal(s.workers.get('s1')?.zone, 'desk', '메인 세션은 그대로');

  const { removed } = s.apply(ev('subagent.stop', { agentId: 'a1', agentType: 'Explore' }));
  assert.deepEqual(removed, ['s1/a1']);
  assert.equal(s.workers.has('s1/a1'), false);
});

test('tick: 30분 소식 없으면 away, 퇴근 10분 뒤 목록에서 제거, 결재 대기는 유지', () => {
  const s = new OfficeState(loadConfig(EXAMPLE_CONFIG_FILE).floors);
  s.apply(ev('session.start', { sessionId: 'idle1' }));
  s.apply(ev('permission.request', { sessionId: 'wait1' }));
  s.apply(ev('session.end', { sessionId: 'gone1' }));
  const now = 1_000_000 + 31 * 60_000;
  const { changed, removed } = s.tick(now);
  assert.deepEqual(changed.map(w => w.id), ['idle1']);
  assert.deepEqual(removed, ['gone1']);
  assert.equal(s.workers.get('wait1')?.status, 'waiting');
});
