import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import type { Worker } from '../../shared/src/events.ts';
import type { TodayChecklist } from '../../shared/src/tasks.ts';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import type { GitFacts, GitReader } from '../src/gitinfo.ts';
import { MeetingManager } from '../src/meetings.ts';
import { MorningRoutine } from '../src/morning.ts';
import { READ_ONLY_TOOLS, type OneShotRequest, type OneShotResult } from '../src/oneshot.ts';
import { loadPersonas } from '../src/personas.ts';
import type { ChildLike } from '../src/runner.ts';
import { TaskManager } from '../src/tasks.ts';

/** 업무를 보내면 뜨는 Claude 대신 (아무 말도 안 함) */
class SilentClaude implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  on() { return this; }
  kill() {}
}

const dir = mkdtempSync(join(tmpdir(), 'myoffice-meetings-'));
const opened: { mm: MeetingManager; tm: TaskManager; store: Store }[] = [];
after(() => {
  for (const o of opened) { o.mm.shutdown(); o.tm.shutdown(); o.store.close(); }
  rmSync(dir, { recursive: true, force: true });
});
let n = 0;

const waitFor = async (cond: () => boolean, what: string | (() => string)) => {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.fail(`기다렸지만 안 됨: ${typeof what === 'function' ? what() : what}`);
};

const MINUTES = {
  summary: '정렬 버그는 백엔드에서 고친다.',
  discussion: '- 원인은 정렬 기준',
  decisions: ['백엔드 정렬 기준 수정'],
  actionItems: [
    { teamId: 'shop-be', agent: 'bug-fixer', title: '정렬 기준 수정', instruction: 'OrderService 정렬 기준을 created_at desc로' },
    { teamId: 'shop-fe', agent: 'nobody', title: '정렬 표시', instruction: '목록 화면에 정렬 기준 표시' },
    { teamId: 'erp-fe', agent: null, title: '다른 층 일', instruction: '이건 버려져야 함' },
  ],
  openQuestions: ['기본 정렬을 바꿔도 되는지'],
};

function setup(o: { minutes?: object; facts?: Record<string, Partial<GitFacts>>; now?: () => number } = {}) {
  const store = new Store(join(dir, `m${++n}.db`));
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  const agentsOf = (p: string) => (p.endsWith('backend') ? [{ name: 'bug-fixer', description: '' }] : []);
  const tm = new TaskManager({ db: store.db, config, spawner: () => new SilentClaude(), agentsOf, now: o.now });
  const calls: OneShotRequest[] = [];
  let gate: Promise<void> | null = null;
  const ask = async (r: OneShotRequest): Promise<OneShotResult> => {
    calls.push(r);
    if (gate) await gate;
    if (r.signal?.aborted) throw new Error('중지됨');
    const props = (r.schema as { properties: Record<string, unknown> }).properties;
    const structured = 'findings' in props ? { gist: '조사 끝', findings: `${calls.length}번째 조사 결과` }
      : 'remark' in props ? { gist: '동의합니다', remark: `${calls.length}번째 발언` }
        : (o.minutes ?? MINUTES);
    return { text: '', structured, costUsd: 0.1 };
  };
  const facts = o.facts ?? {};
  const git: GitReader = {
    facts: async cwd => ({ ok: true, head: 'h1', commits: [], changes: [], diffStat: '', fingerprint: 'fp', ...facts[cwd] }),
    diff: async () => ({ label: '커밋 안 한 변경', text: '+ new line' }),
  };
  const workers = new Map<string, Worker>();
  /** 회의실에 들어온 적 있는 직원 (가짜 Claude가 빨라서 금방 나간다) */
  const entered = new Map<string, Worker>();
  const notesDir = join(dir, `notes${n}`);
  const mm = new MeetingManager({
    db: store.db, config, tasks: tm, ask, agentsOf, git, notesDir, now: o.now,
    onWorkers: (changed, removed) => {
      for (const w of changed) { workers.set(w.id, { ...w }); if (!entered.has(w.id)) entered.set(w.id, { ...w }); }
      for (const id of removed) workers.delete(id);
    },
  });
  opened.push({ mm, tm, store });
  return {
    mm, tm, calls, workers, entered, notesDir, config, store,
    hold: () => { let open!: () => void; gate = new Promise(r => { open = r; }); return () => { gate = null; open(); }; },
  };
}

test('공용 역할 파일: 기획자·아키텍트·QA·보안 검토자·서기', () => {
  const p = loadPersonas();
  assert.deepEqual([...p.keys()].sort(), ['architect', 'planner', 'qa', 'scribe', 'security']);
  assert.equal(p.get('qa')!.name, 'QA');
  assert.match(p.get('scribe')!.body, /지어내지 않는다/);
});

test('기획 회의: 조사(읽기 전용) → 토론(도구 없음) → 회의록 → 칸반 초안 + 회의록 파일', async () => {
  const { mm, tm, calls, workers, entered, notesDir } = setup();
  const m = mm.open({
    kind: 'planning', floor: 1, agenda: '주문 목록 정렬 버그를 어떻게 고칠까', rounds: 1,
    attendees: [{ kind: 'team', teamId: 'shop-be' }, { kind: 'persona', persona: 'qa' }],
  });
  assert.equal(m.status, 'queued');
  await waitFor(() => mm.get(m.id).status === 'done', '회의 끝');

  // 참석자 2 + 서기 1이 회의실에 앉았다가 끝나면 나간다
  assert.deepEqual([...entered.values()].map(w => `${w.zone}:${w.label ?? '-'}:${w.floor}`).sort(), ['meeting:-:1', 'meeting:📝서기:1', 'meeting:🧪QA:1']);
  assert.equal(workers.size, 0);

  // 조사 2 · 토론 2 · 회의록 1
  assert.equal(calls.length, 5);
  const [r1, r2, d1, d2, scribe] = calls;
  assert.deepEqual(r1.tools, READ_ONLY_TOOLS);
  assert.deepEqual(r2.tools, READ_ONLY_TOOLS);
  assert.deepEqual(d1.tools, []);
  assert.deepEqual(scribe.tools, []);
  assert.equal(r1.cwd, 'C:\\work\\shop\\backend', '팀 대표는 자기 팀 폴더에서');
  assert.equal(r2.cwd, 'C:\\work\\shop\\backend', '공용 역할은 참석한 팀 폴더에서');
  assert.deepEqual(r1.addDirs, ['C:\\work\\shop\\frontend', 'C:\\work\\shop\\docs'], '같은 층 다른 팀 폴더까지만 읽기');
  assert.deepEqual(d1.addDirs, []);
  assert.match(r2.appendSystemPrompt!, /QA 담당/);
  assert.match(d2.prompt, /3번째 발언/, '뒤 사람은 앞 발언을 본다');
  assert.equal(new Set(calls.map(c => c.sessionId)).size, 5, '호출마다 다른 세션 id');

  const done = mm.get(m.id);
  assert.equal(done.calls, 5);
  assert.ok(Math.abs(done.costUsd - 0.5) < 1e-9);
  assert.deepEqual(done.minutes!.decisions, ['백엔드 정렬 기준 수정']);

  // 다른 층 팀의 할 일은 버리고, 없는 직원은 null로
  const drafts = done.taskIds.map(id => tm.get(id));
  assert.equal(drafts.length, 2);
  assert.ok(drafts.every(t => t.status === 'draft' && t.source === 'meeting' && t.meetingId === m.id));
  assert.equal(drafts[0].agent, 'bug-fixer');
  assert.equal(drafts[1].agent, null);

  assert.ok(done.file && done.file.startsWith(notesDir) && existsSync(done.file));
  const md = readFileSync(done.file, 'utf8');
  assert.match(md, /# 💡 기획 회의/);
  assert.match(md, /## 결정 사항\n- 백엔드 정렬 기준 수정/);
  assert.match(md, /정렬 기준 수정/);
  assert.match(md, /Claude 호출 5회/);
  assert.match(md, /### 1라운드/);

  const lines = mm.lines(m.id);
  assert.equal(lines.filter(l => l.stage === 'research').length, 2);
  assert.equal(lines.filter(l => l.stage === 'debate').length, 2);
});

test('회의 호출의 훅 이벤트는 회의실 말풍선으로 (사무실 직원으로 안 만듦), 중지하면 바로 끝', async () => {
  const { mm, calls, workers, hold, tm } = setup();
  const release = hold();
  const m = mm.open({ kind: 'planning', floor: 1, agenda: 'x', attendees: [{ kind: 'team', teamId: 'shop-fe' }] });
  await waitFor(() => calls.length === 1, '조사 시작');
  const sid = calls[0].sessionId!;
  assert.equal(mm.claimHook(sid, 'tool.start', 'Read', 'App.tsx 읽는 중'), true);
  assert.equal(mm.claimHook('someone-else', 'tool.start', 'Read', 'x'), false);
  const w = [...workers.values()].find(x => x.teamId === 'shop-fe')!;
  assert.equal(w.summary, '🔎 App.tsx 읽는 중');
  assert.equal(w.status, 'working');

  mm.stop(m.id);
  release();
  await waitFor(() => mm.get(m.id).status === 'stopped', '중지');
  assert.equal(workers.size, 0);
  assert.equal(mm.get(m.id).taskIds.length, 0);
  assert.equal(tm.list().length, 0);
});

test('참석자 검사: 최대 인원, 서기·없는 역할, 다른 층 팀, 없는 직원', () => {
  const { mm } = setup();
  const base = { kind: 'planning' as const, floor: 1, agenda: 'x' };
  assert.throws(() => mm.open({ ...base, attendees: [] }), /한 명 이상/);
  assert.throws(() => mm.open({ ...base, attendees: [{ kind: 'team', teamId: 'shop-fe' }, ...['planner', 'architect', 'qa', 'security'].map(p => ({ kind: 'persona' as const, persona: p }))] }), /최대 4명/);
  assert.throws(() => mm.open({ ...base, attendees: [{ kind: 'persona', persona: 'scribe' }] }), /없는 역할/);
  assert.throws(() => mm.open({ ...base, attendees: [{ kind: 'team', teamId: 'erp-fe' }] }), /1F에 없는 팀/);
  assert.throws(() => mm.open({ ...base, attendees: [{ kind: 'agent', teamId: 'shop-fe', agent: 'bug-fixer' }] }), /없는 직원/);
  assert.throws(() => mm.open({ ...base, agenda: ' ', attendees: [{ kind: 'team', teamId: 'shop-fe' }] }), /안건/);
});

test('아침 스탠드업: 바뀐 팀만 참석, 토론 없이 정리 → "오늘 할 일" 묶음 결재 → 고른 것만 진행', async () => {
  const { mm, tm, calls } = setup({
    facts: { 'C:\\work\\shop\\backend': { commits: ['a1 10-25 15:00 kim: 정렬 수정'], fingerprint: 'fp-be' } },
    minutes: { ...MINUTES, actionItems: MINUTES.actionItems.slice(0, 2) },
  });
  // 처음엔 지난 지문이 없으니 세 팀 다 "바뀜" → 열린다. 끝나면 지문이 저장된다
  const m0 = await mm.openStandup(1);
  await waitFor(() => mm.get(m0.id).status === 'done', '첫 스탠드업');
  for (const a of tm.pendingApprovals()) tm.decide(a.id, false);
  calls.length = 0;

  // 지문이 그대로면 건너뜀
  const skipped = await mm.openStandup(1);
  assert.equal(skipped.status, 'skipped');
  assert.equal(calls.length, 0, 'Claude를 부르지 않음');
  // 강제로 열면 연다
  const forced = await mm.openStandup(1, { force: true });
  assert.equal(forced.status, 'queued');
  await waitFor(() => mm.get(forced.id).status === 'done', '강제 스탠드업');
  assert.equal(forced.attendees.length, 3);
  assert.equal(forced.rounds, 0);
  assert.equal(calls.filter(c => c.tools.length).length, 3, '조사 3');
  assert.equal(calls.length, 4, '조사 3 + 정리 1 (토론 없음)');
  assert.match(calls[0].prompt, /새 커밋 1건:[\s\S]*정렬 수정/);
  assert.match(calls[3].prompt, /남은 할 일/);

  const [today] = tm.pendingApprovals();
  assert.equal(today.kind, 'today');
  const list = today.input as unknown as TodayChecklist;
  assert.equal(list.floor, 1);
  assert.equal(list.items.length, 2);

  tm.decide(today.id, true, '', [list.items[0].taskId]);
  assert.equal(tm.get(list.items[0].taskId).status, 'planning', '고른 일은 보냄 → 계획');
  const dropped = tm.get(list.items[1].taskId);
  assert.equal(dropped.status, 'rejected');
  assert.ok(!tm.list().some(t => t.id === dropped.id), '안 고른 일은 칸반에서 치움');
  assert.equal(tm.pendingApprovals().filter(a => a.kind === 'today').length, 0);
});

test('아침 스탠드업: 안 고른 묶음은 다음 스탠드업 묶음으로 합친다, 서버 재시작에도 남는다', async () => {
  const { mm, tm, store, config } = setup({ minutes: { ...MINUTES, actionItems: MINUTES.actionItems.slice(0, 1) } });
  const a = await mm.openStandup(1, { force: true });
  await waitFor(() => mm.get(a.id).status === 'done', '1');
  const b = await mm.openStandup(1, { force: true });
  await waitFor(() => mm.get(b.id).status === 'done', '2');
  const pending = tm.pendingApprovals().filter(x => x.kind === 'today');
  assert.equal(pending.length, 1, '층마다 묶음 하나');
  assert.equal((pending[0].input as unknown as TodayChecklist).items.length, 2);
  assert.match(String(pending[0].reason), /안 고른 1건 포함/);

  const again = new TaskManager({ db: store.db, config, spawner: () => new SilentClaude(), agentsOf: () => [] });
  assert.equal(again.pendingApprovals().filter(x => x.kind === 'today').length, 1);
});

test('코드리뷰 회의: 변경 내용(diff)을 조사 자료로, 기본 1라운드', async () => {
  const { mm, calls } = setup();
  const m = mm.open({ kind: 'review', floor: 1, agenda: '어제 변경 리뷰', attendees: [{ kind: 'team', teamId: 'shop-fe' }, { kind: 'persona', persona: 'security' }] });
  assert.equal(m.rounds, 1);
  await waitFor(() => mm.get(m.id).status === 'done', '리뷰');
  assert.match(calls[0].prompt, /검토할 변경 내용[\s\S]*\+ new line/);
});

test('조사가 전부 실패하면 회의 실패, 회의록 파일에 실패 기록', async () => {
  const store = new Store(join(dir, `fail${++n}.db`));
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  const tm = new TaskManager({ db: store.db, config, spawner: () => new SilentClaude(), agentsOf: () => [] });
  const failing = new MeetingManager({
    db: store.db, config, tasks: tm, agentsOf: () => [], notesDir: join(dir, `notes-fail${n}`),
    ask: async () => { throw new Error('한도 초과'); },
  });
  opened.push({ mm: failing, tm, store });
  const m = failing.open({ kind: 'planning', floor: 1, agenda: 'x', attendees: [{ kind: 'team', teamId: 'shop-fe' }] });
  await waitFor(() => failing.get(m.id).status === 'failed', () => `실패 (지금 ${failing.get(m.id).status} · ${failing.lines(m.id).map(l => l.text).join(' / ')})`);
  assert.match(String(failing.get(m.id).error), /전원/);
  assert.match(readFileSync(failing.get(m.id).file!, 'utf8'), /한도 초과/);
});

test('조사 중 중지: 늦게 끝난 호출이 회의실을 비운 뒤 직원을 다시 들여보내지 않는다 (유령 직원 없음)', async () => {
  const store = new Store(join(dir, `ghost${++n}.db`));
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  const tm = new TaskManager({ db: store.db, config, spawner: () => new SilentClaude(), agentsOf: () => [] });
  let releaseSlow!: () => void;
  const slow = new Promise<void>(r => { releaseSlow = r; });
  let calls = 0;
  const workers = new Map<string, Worker>();
  const mm = new MeetingManager({
    db: store.db, config, tasks: tm, agentsOf: () => [], notesDir: join(dir, `ghost-notes${n}`),
    onWorkers: (changed, removed) => { for (const w of changed) workers.set(w.id, w); for (const id of removed) workers.delete(id); },
    ask: async r => {
      if (++calls === 1) {
        // 첫 참석자: 중지 신호에 바로 반응
        await new Promise((_, reject) => r.signal!.addEventListener('abort', () => reject(new Error('중지됨'))));
      }
      await slow; // 둘째 참석자: 중지를 무시하고 늦게 끝남
      return { text: '', structured: { gist: '늦은 답', findings: 'f' }, costUsd: 0 };
    },
  });
  opened.push({ mm, tm, store });
  const m = mm.open({ kind: 'planning', floor: 1, agenda: 'x', attendees: [{ kind: 'team', teamId: 'shop-fe' }, { kind: 'team', teamId: 'shop-be' }] });
  await waitFor(() => calls === 2, '조사 둘 다 시작');
  mm.stop(m.id);
  await waitFor(() => mm.get(m.id).status === 'stopped' && workers.size === 0, '중지되고 회의실 비움');
  releaseSlow();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(workers.size, 0, '늦은 답이 와도 직원이 다시 나타나지 않음');
});

test('같은 층 스탠드업을 동시에 두 번 열면 하나만 열린다', async () => {
  const { mm, store } = setup();
  const results = await Promise.allSettled([mm.openStandup(2, { force: true }), mm.openStandup(2, { force: true })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(String((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason), /이미 진행 중/);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM meetings WHERE kind = 'standup'").get() as { n: number }).n, 1);
});

test('서버 재시작: 지난날 아침 루틴으로 대기 중이던 스탠드업은 열지 않는다', async () => {
  const { store, config, tm } = setup();
  store.db.prepare(`INSERT INTO meetings (kind, floor, title, agenda, attendees, rounds, status, routine_date, created_at, updated_at)
                    VALUES ('standup', 1, '아침 스탠드업', 'x', '[]', 0, 'queued', '2020-01-01', 0, 0)`).run();
  const again = new MeetingManager({ db: store.db, config, tasks: tm, ask: async () => { throw new Error('부르면 안 됨'); }, agentsOf: () => [], notesDir: dir });
  const [m] = again.list();
  again.shutdown();
  assert.equal(m.status, 'stopped');
  assert.match(String(m.error), /지난 아침 루틴/);
});

test('오늘 할 일 결재: 아무것도 안 고르고 승인·목록에 없는 id → 보낸 것 없이 반려 처리', async () => {
  const { mm, tm } = setup({ minutes: { ...MINUTES, actionItems: MINUTES.actionItems.slice(0, 2) } });
  const m = await mm.openStandup(1, { force: true });
  await waitFor(() => mm.get(m.id).status === 'done', '스탠드업');
  const [today] = tm.pendingApprovals();
  const decided = tm.decide(today.id, true, '', [99999]);
  assert.equal(decided.status, 'rejected');
  assert.ok(m.id && mm.get(m.id).taskIds.every(id => tm.get(id).status === 'rejected'));
  assert.throws(() => tm.decide(today.id, true), /이미 처리/);
});

test('오늘 할 일 묶음 바꾸기: 새 항목이 0건이어도 예전 묶음 취소가 화면에 반영된다', () => {
  const store = new Store(join(dir, `rc${++n}.db`));
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  let changes = 0;
  const tm = new TaskManager({ db: store.db, config, spawner: () => new SilentClaude(), agentsOf: () => [], onChange: () => changes++ });
  opened.push({ mm: { shutdown() {} } as never, tm, store });
  const t = tm.create({ instruction: 'a', teamId: 'shop-fe', draft: true, source: 'meeting' });
  tm.replaceChecklist(1, 1, [t.id], () => '첫 묶음');
  // 그사이 칸반에서 처리돼 더는 초안이 아님
  store.db.prepare("UPDATE tasks SET status = 'stopped' WHERE id = ?").run(t.id);
  changes = 0;
  const a = tm.replaceChecklist(2, 1, [], () => '둘째');
  assert.equal(a, null, '합쳐서 0건이면 새 묶음 없음');
  assert.equal(tm.pendingApprovals().length, 0, '예전 묶음은 취소');
  assert.ok(changes >= 1, '화면 갱신');
});

test('아침 루틴: 평일 9시 이후 하루 한 번, 주말·이른 시각엔 안 함, 놓치면 그날 처음 확인할 때', async () => {
  const store = new Store(join(dir, `morning${++n}.db`));
  opened.push({ mm: { shutdown() {} } as never, tm: { shutdown() {} } as never, store });
  let now = new Date(2026, 9, 26, 8, 59).getTime(); // 월요일
  const opens: number[] = [];
  const r = new MorningRoutine({
    db: store.db, now: () => now,
    config: { enabled: true, time: '09:00', weekdays: [1, 2, 3, 4, 5], floors: [1, 2, 3] },
    meetings: { openStandup: async (floor: number) => { opens.push(floor); return { status: floor === 2 ? 'skipped' : 'queued' } as never; } },
  });
  assert.equal(await r.check(), false, '9시 전');
  assert.equal(r.status().nextAt, new Date(2026, 9, 26, 9, 0).getTime());
  // 9시 전에 "지금 실행"을 눌러도 정기 실행은 그대로
  await r.run();
  assert.deepEqual(opens, [1, 2, 3]);
  assert.equal(r.lastDate, null);
  opens.length = 0;

  now = new Date(2026, 9, 26, 13, 30).getTime(); // 서버를 늦게 켬
  assert.equal(r.status().nextAt, now, '놓쳤으면 곧');
  assert.equal(await r.check(), true);
  assert.deepEqual(opens, [1, 2, 3]);
  assert.equal(r.lastDate, '2026-10-26');
  assert.equal(await r.check(), false, '하루 한 번');
  assert.equal(r.status().nextAt, new Date(2026, 9, 27, 9, 0).getTime());

  now = new Date(2026, 9, 31, 10, 0).getTime(); // 토요일
  assert.equal(await r.check(), false);
  assert.equal(r.status().nextAt, new Date(2026, 10, 2, 9, 0).getTime(), '다음 월요일');
});
