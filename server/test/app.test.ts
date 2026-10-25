import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ServerMessage } from '../../shared/src/events.ts';
import { buildApp } from '../src/app.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'myoffice-test-'));
const store = new Store(join(dir, 'test.db'));
const { app, office } = await buildApp({ config: loadConfig(EXAMPLE_CONFIG_FILE), store, token: 'T' });
after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const hook = (body: object, token = 'T') =>
  app.inject({ method: 'POST', url: '/hook', headers: { 'x-myoffice-token': token }, payload: body });

const base = { session_id: 'sess-1', cwd: 'C:\\work\\blog\\web', transcript_path: 'C:\\x.jsonl' };

test('토큰이 틀리면 401, 아무것도 저장하지 않음', async () => {
  const res = await hook({ ...base, hook_event_name: 'SessionStart' }, 'wrong');
  assert.equal(res.statusCode, 401);
  assert.equal(store.countEvents(), 0);
});

test('등록되지 않은 폴더 이벤트는 204로 통과시키고 저장하지 않음', async () => {
  const res = await hook({ ...base, cwd: 'C:\\Users\\User\\Desktop', hook_event_name: 'SessionStart' });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  assert.equal(store.countEvents(), 0);
});

test('등록된 폴더 이벤트는 저장되고 직원 상태에 반영, 응답은 빈 204', async () => {
  const res = await hook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:\\a\\client.ts' } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.body, '');
  const [e] = store.recentEvents(1);
  assert.equal(e.floor, 3);
  assert.equal(e.teamId, 'blog-fe');
  assert.equal(e.summary, 'client.ts 읽는 중');
  assert.equal(office.workers.get('sess-1')?.zone, 'library');
});

test('큰 페이로드(5MB Read 결과)도 받고, DB에는 잘라서 저장', async () => {
  const res = await hook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: { content: 'x'.repeat(5_000_000) } });
  assert.equal(res.statusCode, 204);
  const row = store.db.prepare('SELECT length(raw) AS n FROM events ORDER BY id DESC LIMIT 1').get() as { n: number };
  assert.ok(row.n < 5_000);
});

test('WebSocket: 접속하면 스냅샷, 훅이 오면 실시간 이벤트', async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: ServerMessage[] = [];
  const next = () => new Promise<ServerMessage>(resolve => {
    ws.addEventListener('message', m => { const msg = JSON.parse(String(m.data)); messages.push(msg); resolve(msg); }, { once: true });
  });

  const snap = await next();
  assert.equal(snap.type, 'snapshot');
  assert.ok(snap.type === 'snapshot' && snap.workers.some(w => w.id === 'sess-1'));

  const pending = next();
  await hook({ ...base, hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'Explore' });
  const msg = await pending;
  assert.equal(msg.type, 'event');
  assert.ok(msg.type === 'event' && msg.changed.some(w => w.id === 'sess-1/ag1' && w.zone === 'elevator'));
  assert.equal(msg.type === 'event' && msg.floors.find(f => f.floor === 3)?.total, 2);
  ws.close();
});

test('lastPromptAt: 세션의 마지막 지시 시각', async () => {
  await hook({ ...base, session_id: 'sess-p', hook_event_name: 'UserPromptSubmit', prompt: '첫 지시' });
  const first = store.lastPromptAt('sess-p');
  assert.ok(first);
  assert.equal(store.lastPromptAt('nobody'), undefined);
});

test('/api/config는 기본 층과 층 목록을 준다', async () => {
  const res = await app.inject({ url: '/api/config' });
  assert.equal(res.json().defaultFloor, 1);
  assert.equal(res.json().floors.length, 6);
});
