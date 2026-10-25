import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { createSecurity } from '../src/security.ts';

const dir = mkdtempSync(join(tmpdir(), 'myoffice-sec-'));
const store = new Store(join(dir, 'sec.db'));
const { app, tasks } = await buildApp({
  config: loadConfig(EXAMPLE_CONFIG_FILE), store, token: 'T', security: createSecurity('KEY'),
  spawner: () => { throw new Error('이 테스트에선 Claude를 실행하지 않음'); },
  agentsOf: () => [],
  secretary: async () => ({ reply: '프론트엔드팀에 맡길게요', drafts: [{ teamId: 'shop-fe', agent: null, title: '로그인 오류', instruction: '로그인 오류를 고쳐줘' }] }),
});
after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

const ok = { host: '127.0.0.1:7777', 'x-myoffice-key': 'KEY' };

test('다른 주소(Host)로 들어온 요청은 거절 — DNS 리바인딩 방지', async () => {
  const res = await app.inject({ url: '/api/work', headers: { host: 'evil.example.com' } });
  assert.equal(res.statusCode, 403);
});

test('다른 사이트(Origin)에서 온 요청은 거절', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...ok, origin: 'https://evil.example.com' }, payload: { instruction: 'x', teamId: 'shop-fe', draft: true } });
  assert.equal(res.statusCode, 403);
});

test('화면 키가 없으면 지시·결재 불가, 조회는 가능', async () => {
  const post = await app.inject({ method: 'POST', url: '/api/tasks', headers: { host: '127.0.0.1:7777' }, payload: { instruction: 'x', teamId: 'shop-fe', draft: true } });
  assert.equal(post.statusCode, 403);
  const get = await app.inject({ url: '/api/work', headers: { host: '127.0.0.1:7777' } });
  assert.equal(get.statusCode, 200);
});

test('화면은 /api/session에서 키를 받아 지시할 수 있다', async () => {
  const s = await app.inject({ url: '/api/session', headers: { host: 'localhost:5173', origin: 'http://localhost:5173' } });
  assert.equal(s.json().key, 'KEY');
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: { ...ok, origin: 'http://127.0.0.1:7777' }, payload: { instruction: '초안', teamId: 'shop-fe', draft: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'draft');
});

test('잘못된 요청은 400과 이유', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/tasks', headers: ok, payload: { instruction: 'x', teamId: 'nope' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /없는 팀/);
});

test('대표실 비서: 답과 함께 업무 초안(draft)을 만든다', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/secretary', headers: ok, payload: { text: '쇼핑몰 로그인 오류 좀 봐줘' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.reply, '프론트엔드팀에 맡길게요');
  assert.equal(body.drafts[0].status, 'draft');
  assert.equal(body.drafts[0].source, 'secretary');
  assert.ok(tasks.list().some(t => t.title === '로그인 오류'));
});
