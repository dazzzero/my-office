import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import type { OneShotRequest } from '../src/oneshot.ts';

const dir = mkdtempSync(join(tmpdir(), 'myoffice-mapp-'));
const store = new Store(join(dir, 'test.db'));
const calls: OneShotRequest[] = [];
let release: () => void = () => {};
let gate: Promise<void> | null = null;
const { app, office, security, meetings } = await buildApp({
  config: loadConfig(EXAMPLE_CONFIG_FILE), store, token: 'T', notesDir: join(dir, 'notes'),
  agentsOf: () => [],
  git: { facts: async () => ({ ok: false, head: null, commits: [], changes: [], diffStat: '', fingerprint: 'no-git' }), diff: async () => null },
  ask: async r => {
    calls.push(r);
    if (gate) await gate;
    const props = (r.schema as { properties: Record<string, unknown> }).properties;
    const structured = 'findings' in props ? { gist: '조사 끝', findings: 'f' } : 'remark' in props ? { gist: 'g', remark: 'r' }
      : { summary: 's', discussion: 'd', decisions: [], actionItems: [{ teamId: 'blog-fe', agent: null, title: 't', instruction: 'i' }], openQuestions: [] };
    return { text: '', structured, costUsd: 0.01 };
  },
});
after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const post = (url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url, headers: { 'x-myoffice-key': security.uiKey }, payload });
const waitFor = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 300; i++) { if (cond()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`기다렸지만 안 됨: ${what}`);
};

test('/api/meetings: 공용 역할(서기 제외)·아침 루틴 상태·최대 인원', async () => {
  const res = await app.inject({ url: '/api/meetings' });
  const body = res.json();
  assert.deepEqual(body.personas.map((p: { id: string }) => p.id).sort(), ['architect', 'planner', 'qa', 'security']);
  assert.equal(body.maxAttendees, 4);
  assert.equal(body.morning.time, '09:00');
  assert.deepEqual(body.meetings, []);
});

test('회의 열기 → 회의 호출의 훅은 DB·사무실 직원으로 안 가고 회의실 말풍선으로 → 끝나면 칸반 초안', async () => {
  gate = new Promise(r => { release = r; });
  const res = await post('/api/meetings', { kind: 'planning', floor: 3, agenda: '블로그 검색 개선', attendees: [{ kind: 'team', teamId: 'blog-fe' }, { kind: 'persona', persona: 'planner' }], rounds: 1 });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().id;
  await waitFor(() => calls.length === 2, '조사 시작');

  const before = store.countEvents();
  const hook = await app.inject({
    method: 'POST', url: '/hook', headers: { 'x-myoffice-token': 'T' },
    payload: { session_id: calls[0].sessionId, cwd: 'C:\\work\\blog\\web', hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'search' } },
  });
  assert.equal(hook.statusCode, 204);
  assert.equal(store.countEvents(), before, 'DB에 안 남김');
  assert.ok(!office.workers.has(calls[0].sessionId!), '따로 직원을 만들지 않음');
  const inRoom = office.list().filter(w => w.meetingId === id);
  assert.equal(inRoom.length, 3, '참석 2 + 서기');
  assert.ok(inRoom.every(w => w.zone === 'meeting' && w.floor === 3));
  assert.ok(inRoom.some(w => w.summary === '🔎 "search" 검색 중'));

  gate = null;
  release();
  await waitFor(() => meetings.get(id).status === 'done', '회의 끝');
  assert.equal(office.list().filter(w => w.meetingId === id).length, 0, '회의실에서 나감');
  const detail = (await app.inject({ url: `/api/meetings/${id}` })).json();
  assert.equal(detail.meeting.taskIds.length, 1);
  assert.ok(detail.lines.some((l: { stage: string }) => l.stage === 'debate'));
  const work = (await app.inject({ url: '/api/work' })).json();
  assert.ok(work.tasks.some((t: { source: string; status: string }) => t.source === 'meeting' && t.status === 'draft'));
});

test('스탠드업은 회의실 패널에서 열면 무조건 열린다, 중지 API', async () => {
  gate = new Promise(r => { release = r; });
  const res = await post('/api/meetings', { kind: 'standup', floor: 5 });
  assert.equal(res.statusCode, 200, res.body);
  const id = res.json().id;
  assert.equal(res.json().title, '아침 스탠드업');
  await waitFor(() => meetings.get(id).status === 'research', '조사 시작');
  const stop = await post(`/api/meetings/${id}/stop`);
  assert.equal(stop.statusCode, 200);
  gate = null;
  release();
  await waitFor(() => meetings.get(id).status === 'stopped', '중지');
});

test('입력 검사: 참석자 목록이 배열이 아니면 400, 라운드가 숫자가 아니면 기본값, 없는 층 400', async () => {
  const bad = await post('/api/meetings', { kind: 'planning', floor: 3, agenda: 'x', attendees: 'blog-fe' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /참석자/);
  const bad2 = await post('/api/meetings', { kind: 'planning', floor: 3, agenda: 'x', attendees: ['blog-fe'] });
  assert.equal(bad2.statusCode, 400);
  const nofloor = await post('/api/meetings', { kind: 'planning', floor: 'abc', agenda: 'x', attendees: [{ kind: 'team', teamId: 'blog-fe' }] });
  assert.equal(nofloor.statusCode, 400);
  const ok = await post('/api/meetings', { kind: 'planning', floor: 3, agenda: 'x', attendees: [{ kind: 'team', teamId: 'blog-fe' }], rounds: 'abc' });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().rounds, 2);
  await waitFor(() => meetings.get(ok.json().id).status === 'done', '회의 끝');
});

test('계획 모두 승인: 기다리는 계획 결재가 없으면 0', async () => {
  const res = await post('/api/approvals/approve-plans');
  assert.deepEqual(res.json(), { approved: 0 });
});
