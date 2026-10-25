import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { PushNote } from '../../shared/src/mobile.ts';
import { buildApp } from '../src/app.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';

const dir = mkdtempSync(join(tmpdir(), 'myoffice-mobile-'));
const store = new Store(join(dir, 'm.db'));
const sent: { endpoint: string; note: PushNote }[] = [];
let failWith: number | null = null;
const { app, security, tasks, devices } = await buildApp({
  config: loadConfig(EXAMPLE_CONFIG_FILE), store, token: 'T', agentsOf: () => [],
  tailnet: async () => ({ running: true, dnsName: 'pc.tail1.ts.net', login: 'me@example.com', certs: true, serving: true }),
  pushSender: async (sub, payload) => {
    if (failWith) throw Object.assign(new Error('gone'), { statusCode: failWith });
    sent.push({ endpoint: sub.endpoint, note: JSON.parse(payload) });
  },
});
after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
await new Promise(r => setTimeout(r, 20)); // Tailscale 상태 읽기

/** Tailscale serve를 거쳐 휴대폰에서 온 요청 */
const phone = { host: 'pc.tail1.ts.net', 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': 'me@example.com' };
const local = { host: '127.0.0.1:7777', 'x-myoffice-key': security.uiKey };
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

async function pairPhone(): Promise<string> {
  const pair = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: local });
  const code = new URL(pair.json().url).searchParams.get('pair')!;
  const claim = await app.inject({ method: 'POST', url: '/api/devices/claim', headers: phone, payload: { code, name: '내 폰' } });
  return claim.json().token;
}

test('휴대폰(원격): 화면 파일은 받지만 API는 기기 키가 있어야, 주소·계정·출처가 다르면 거절', async () => {
  assert.notEqual((await app.inject({ url: '/', headers: phone })).statusCode, 401, '연결 화면을 띄울 파일은 키 없이');
  assert.equal((await app.inject({ url: '/api/work', headers: phone })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/work', headers: { ...phone, host: 'other.tail1.ts.net' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/work', headers: { ...phone, 'tailscale-user-login': 'friend@example.com' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/devices/claim', headers: { ...phone, origin: 'https://evil.example.com' }, payload: {} })).statusCode, 403);
  // 내 PC에서 전달 헤더를 꾸며도 권한이 늘지 않는다 (원격으로 취급돼 주소 검사에 걸림)
  assert.equal((await app.inject({ url: '/api/work', headers: { host: '127.0.0.1:7777', 'x-forwarded-for': '1.2.3.4' } })).statusCode, 403);
});

test('연결: PC가 QR(일회용 코드)을 띄우고, 휴대폰이 코드를 내면 기기 키 → API·결재 가능', async () => {
  const pair = await app.inject({ method: 'POST', url: '/api/devices/pair', headers: local });
  assert.equal(pair.statusCode, 200);
  assert.match(pair.json().url, /^https:\/\/pc\.tail1\.ts\.net\/\?pair=/);
  assert.match(pair.json().svg, /^<svg/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/devices/pair', headers: phone })).statusCode, 403, '새 기기 연결은 PC에서만');

  const code = new URL(pair.json().url).searchParams.get('pair')!;
  const claim = await app.inject({ method: 'POST', url: '/api/devices/claim', headers: { ...phone, origin: 'https://pc.tail1.ts.net' }, payload: { code, name: '내 폰' } });
  assert.equal(claim.statusCode, 200);
  const { token } = claim.json();
  assert.ok(token.length > 30);
  const again = await app.inject({ method: 'POST', url: '/api/devices/claim', headers: phone, payload: { code, name: 'x' } });
  assert.equal(again.statusCode, 400, '코드는 한 번만');

  const auth = { ...phone, 'x-myoffice-device': token };
  assert.equal((await app.inject({ url: '/api/work', headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/session', headers: auth })).json().key, '', '휴대폰엔 PC 화면 키를 주지 않음');
  const set = await app.inject({ method: 'POST', url: '/api/settings', headers: auth, payload: { terminalMode: 'terminal' } });
  assert.equal(set.statusCode, 200, '기기 키로 바꾸는 요청도 가능');
  assert.equal((await app.inject({ method: 'POST', url: '/hook', headers: { ...phone, 'x-myoffice-token': 'T' }, payload: {} })).statusCode, 403, '훅은 PC에서만');

  const me = (await app.inject({ url: '/api/mobile', headers: auth })).json();
  assert.equal(me.me.name, '내 폰');
  assert.equal(me.url, 'https://pc.tail1.ts.net');
  assert.ok(me.pushKey.length > 40);
});

test('푸시: 결재가 생기면 휴대폰에 짧은 알림, 처리되면 알림 지우기, 종류별로 끌 수 있음', async () => {
  const token = await pairPhone();
  const auth = { ...phone, 'x-myoffice-device': token };
  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await app.inject({ method: 'POST', url: '/api/devices/me', headers: auth, payload: { push: sub } })).statusCode, 200);
  sent.length = 0;

  const waiting = tasks.waitTerminalApproval({ sessionId: 's1', toolName: 'Bash', input: { command: 'npm publish' }, reason: null }, 30);
  await tick();
  const shown = sent.filter(s => s.endpoint === sub.endpoint);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].note.type, 'show');
  assert.match(shown[0].note.title!, /💻 Paseo 결재/);
  assert.ok(!JSON.stringify(shown[0].note).includes('npm publish'), '명령 내용은 알림에 안 실음');
  const tag = shown[0].note.tag;

  await waiting; // 시간 초과 → 결재함에서 빠짐
  await tick();
  assert.ok(sent.some(s => s.note.type === 'clear' && s.note.tag === tag), '처리되면 알림 지우기');

  await app.inject({ method: 'POST', url: '/api/devices/me', headers: auth, payload: { prefs: { approval: false } } });
  sent.length = 0;
  await tasks.waitTerminalApproval({ sessionId: 's1', toolName: 'Bash', input: {}, reason: null }, 10);
  assert.equal(sent.filter(s => s.note.type === 'show' && s.endpoint === sub.endpoint).length, 0, '끈 종류는 안 보냄');
});

test('구독이 사라지면(410) 등록을 지우고, 연결을 끊으면 그 기기 키는 더 못 씀', async () => {
  const token = await pairPhone();
  const auth = { ...phone, 'x-myoffice-device': token };
  await app.inject({ method: 'POST', url: '/api/devices/me', headers: auth, payload: { push: { endpoint: 'https://push.example.com/gone', keys: { p256dh: 'p', auth: 'a' } } } });
  const me = (await app.inject({ url: '/api/mobile', headers: auth })).json().me;
  failWith = 410;
  await tasks.waitTerminalApproval({ sessionId: 's2', toolName: 'Bash', input: {}, reason: null }, 10);
  await tick();
  failWith = null;
  assert.equal(devices.get(me.id)!.push, false);

  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/${me.id}/revoke`, headers: auth })).statusCode, 403, '연결 해제는 PC에서만');
  assert.equal((await app.inject({ method: 'POST', url: `/api/devices/${me.id}/revoke`, headers: local })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/work', headers: auth })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/devices/me', headers: { ...phone, 'x-myoffice-device': 'nope' }, payload: {} })).statusCode, 401);
});
