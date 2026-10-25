import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OfficeEvent } from '../../shared/src/events.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Notifier, type Timers, type Toast } from '../src/notify.ts';

let id = 0;
const ev = (kind: OfficeEvent['kind'], ts: number, extra: Partial<OfficeEvent> = {}): OfficeEvent => ({
  id: ++id, ts, kind, sessionId: 's1', agentId: null, agentType: null, floor: 3, teamId: 'blog-fe',
  cwd: 'C:\\work\\blog\\web', tool: null, zone: null, summary: '', ...extra,
});

/** 손으로 돌리는 가짜 타이머 */
function fakeTimers() {
  let now = 0, seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    set: (fn, ms) => { queue.set(++seq, { at: now + ms, fn }); return seq; },
    clear: h => { queue.delete(h as number); },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [k, t] of [...queue]) if (t.at <= now) { queue.delete(k); t.fn(); }
  };
  return { timers, advance };
}

function setup(overrides: Partial<ReturnType<typeof loadConfig>['notifications']['windows']> = {}) {
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  config.notifications.windows = { ...config.notifications.windows, ...overrides };
  const sent: Toast[] = [];
  const clock = fakeTimers();
  return { n: new Notifier(config, t => sent.push(t), clock.timers), sent, advance: clock.advance };
}

test('결재 대기 알림: 층·직원·할 일, 누르면 그 층으로', () => {
  const { n, sent } = setup();
  n.handle(ev('permission.request', 0, { summary: '결재 요청: npm test' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '✋ 결재 대기 · 3F 블로그');
  assert.match(sent[0].body, /— npm test$/);
  assert.equal(sent[0].url, 'http://127.0.0.1:7777/?floor=3');
});

test('같은 직원의 결재 대기는 1분에 한 번 (요청 + 알림이 연달아 와도 1번)', () => {
  const { n, sent } = setup();
  n.handle(ev('permission.request', 0, { summary: '결재 요청: a' }));
  n.handle(ev('notification', 1000, { summary: '결재 대기' }));
  n.handle(ev('permission.request', 30_000, { summary: '결재 요청: b' }));
  assert.equal(sent.length, 1);
  n.handle(ev('permission.request', 61_000, { summary: '결재 요청: c' }));
  assert.equal(sent.length, 2);
});

test('작업 완료: 끝나고 30초 동안 새 지시가 없으면 알림 (걸린 시간 포함)', () => {
  const { n, sent, advance } = setup();
  n.handle(ev('prompt', 0));
  n.handle(ev('stop', 40_000));
  advance(29_000);
  assert.equal(sent.length, 0, '아직 30초 안 됨');
  advance(1_000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '✅ 작업 완료 · 3F 블로그');
  assert.match(sent[0].body, /40초 걸린 작업이 끝났어요$/);
});

test('작업 완료: 30초 안에 다음 지시가 오면 조용히 (연달아 일하는 중)', () => {
  const { n, sent, advance } = setup();
  n.handle(ev('prompt', 0));
  n.handle(ev('stop', 20_000));
  advance(10_000);
  n.handle(ev('prompt', 30_000));
  advance(60_000);
  assert.equal(sent.length, 0);
  n.handle(ev('stop', 200_000));
  advance(30_000);
  assert.equal(sent.length, 1, '마지막 작업만 알림');
  assert.match(sent[0].body, /2분 50초 걸린/);
});

test('작업 완료: 서버 재시작으로 지시 시각을 잊었으면 DB에서 찾아 걸린 시간 표시', () => {
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  const sent: Toast[] = [];
  const clock = fakeTimers();
  const n = new Notifier(config, t => sent.push(t), clock.timers, id => (id === 's1' ? 1_000 : undefined));
  n.handle(ev('stop', 91_000));
  clock.advance(30_000);
  assert.match(sent[0].body, /1분 30초 걸린 작업이 끝났어요$/);
});

test('자동 모드가 막은 작업 알림', () => {
  const { n, sent } = setup();
  n.handle(ev('permission.denied', 0, { summary: '자동 모드가 막음: rm -rf build' }));
  assert.equal(sent[0].title, '🛡️ 자동 모드가 막은 작업 · 3F 블로그');
  assert.match(sent[0].body, /— rm -rf build$/);
});

test('오류 알림, 설정으로 끄기, 데모 세션 무시', () => {
  const a = setup();
  a.n.handle(ev('stop.fail', 0, { summary: '오류: rate_limit' }));
  assert.equal(a.sent[0].title, '⚠️ 오류로 멈춤 · 3F 블로그');

  const b = setup({ waiting: false, error: false, done: false, denied: false });
  b.n.handle(ev('permission.request', 0));
  b.n.handle(ev('stop.fail', 0));
  b.n.handle(ev('permission.denied', 0));
  b.n.handle(ev('stop', 0));
  b.advance(60_000);
  assert.equal(b.sent.length, 0);

  const c = setup();
  c.n.handle(ev('permission.request', 0, { sessionId: 'demo-1' }));
  c.n.handle(ev('stop', 0, { sessionId: 'demo-1' }));
  c.advance(60_000);
  assert.equal(c.sent.length, 0);
});
