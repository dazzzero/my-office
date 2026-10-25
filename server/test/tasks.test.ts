import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { EXAMPLE_CONFIG_FILE, loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import type { ChildLike, Spawner } from '../src/runner.ts';
import { TaskManager } from '../src/tasks.ts';

/** 진짜 claude.exe 대신 stream-json으로 말하는 가짜 프로세스 */
class FakeClaude implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: any[] = [];
  private exitHandlers: ((code: number | null) => void)[] = [];
  private buf = '';
  args: string[];
  cwd: string;
  constructor(args: string[], cwd: string) {
    this.args = args;
    this.cwd = cwd;
    this.stdin.on('data', d => {
      this.buf += String(d);
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        this.written.push(JSON.parse(this.buf.slice(0, i)));
        this.buf = this.buf.slice(i + 1);
      }
    });
    this.stdin.on('finish', () => this.exit(0));
  }
  emit(obj: unknown) { this.stdout.write(JSON.stringify(obj) + '\n'); }
  exit(code: number | null) { for (const h of this.exitHandlers.splice(0)) h(code); }
  on(event: string, cb: (x: any) => void) { if (event === 'exit') this.exitHandlers.push(cb); return this; }
  kill() { this.exit(null); }
}

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const dir = mkdtempSync(join(tmpdir(), 'myoffice-tasks-'));
const opened: { tm: TaskManager; store: Store }[] = [];
after(() => {
  for (const o of opened) { o.tm.shutdown(); o.store.close(); }
  rmSync(dir, { recursive: true, force: true });
});
let dbn = 0;

function setup(max = 10) {
  const store = new Store(join(dir, `t${++dbn}.db`));
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  config.runner.maxConcurrent = max;
  const procs: FakeClaude[] = [];
  const spawner: Spawner = (_exe, args, cwd) => { const p = new FakeClaude(args, cwd); procs.push(p); return p; };
  const approvals: string[] = [];
  const tm = new TaskManager({
    db: store.db, config, spawner,
    agentsOf: p => (p.endsWith('backend') ? [{ name: 'bug-fixer' }] : []),
    onApproval: a => approvals.push(a.kind),
  });
  opened.push({ tm, store });
  return { tm, procs, approvals, store };
}

test('지시 → 계획 모드로 실행 → 계획 결재 → 승인하면 자동 모드로 실행 → 완료', async () => {
  const { tm, procs, approvals } = setup();
  const task = tm.create({ instruction: '주문 목록 정렬 버그 고쳐줘', teamId: 'shop-be' });
  await tick();
  assert.equal(procs.length, 1);
  const p = procs[0];
  assert.equal(p.cwd, 'C:\\work\\shop\\backend', '팀 폴더에서 실행');
  assert.deepEqual(p.args.slice(p.args.indexOf('--permission-mode'), p.args.indexOf('--permission-mode') + 2), ['--permission-mode', 'plan']);
  assert.ok(p.args.includes('claude-opus-5-5'));
  assert.match(p.written[0].message.content, /주문 목록 정렬 버그[\s\S]*ExitPlanMode/);
  assert.equal(tm.get(task.id).status, 'planning');

  p.emit({ type: 'system', subtype: 'init', session_id: 'sess-A' });
  p.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'sortOrder' } }] } });
  p.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: '1. 정렬 기준 수정\n2. 테스트' } } });
  await tick();
  const t1 = tm.get(task.id);
  assert.equal(t1.status, 'plan_review');
  assert.equal(t1.sessionId, 'sess-A');
  assert.equal(t1.plan, '1. 정렬 기준 수정\n2. 테스트');
  const [plan] = tm.pendingApprovals();
  assert.equal(plan.kind, 'plan');
  assert.deepEqual(approvals, ['plan']);

  tm.decide(plan.id, true);
  await tick();
  const resp = p.written.at(-1);
  assert.equal(resp.type, 'control_response');
  assert.equal(resp.response.request_id, 'r1');
  assert.equal(resp.response.response.behavior, 'allow');
  assert.deepEqual(resp.response.response.updatedPermissions, [{ type: 'setMode', mode: 'auto', destination: 'session' }]);
  assert.equal(tm.get(task.id).status, 'running');

  p.emit({ type: 'result', result: '정렬 기준을 고쳤습니다.', total_cost_usd: 0.42, is_error: false, session_id: 'sess-A' });
  await tick();
  const done = tm.get(task.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, '정렬 기준을 고쳤습니다.');
  assert.equal(done.costUsd, 0.42);
  assert.equal(done.live, true, '이어서 지시할 수 있게 살아 있음');
  assert.ok(tm.log(task.id).some(l => l.kind === 'tool' && l.text.includes('sortOrder')));
});

test('계획 반려: 사유와 함께 다시 계획하라고 돌려보낸다', async () => {
  const { tm, procs } = setup();
  const task = tm.create({ instruction: 'a', teamId: 'shop-fe' });
  await tick();
  procs[0].emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } } });
  await tick();
  tm.decide(tm.pendingApprovals()[0].id, false, '테스트도 추가해');
  await tick();
  const resp = procs[0].written.at(-1).response.response;
  assert.equal(resp.behavior, 'deny');
  assert.match(resp.message, /테스트도 추가해/);
  assert.equal(tm.get(task.id).status, 'planning');
  assert.equal(tm.pendingApprovals().length, 0);
});

test('실행 중 결재(금지 목록 등): 결재함에 올라오고, 반려하면 deny', async () => {
  const { tm, procs, approvals } = setup();
  const task = tm.create({ instruction: 'a', teamId: 'shop-fe' });
  await tick();
  const p = procs[0];
  p.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } } });
  await tick();
  tm.decide(tm.pendingApprovals()[0].id, true);
  p.emit({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' }, decision_reason: '마이오피스 금지 목록: 원격 저장소로 push' } });
  await tick();
  assert.equal(tm.get(task.id).status, 'approval');
  const [a] = tm.pendingApprovals();
  assert.equal(a.kind, 'tool');
  assert.equal(a.toolName, 'Bash');
  assert.match(String(a.reason), /push/);
  assert.deepEqual(approvals, ['plan', 'tool']);
  tm.decide(a.id, false);
  await tick();
  assert.equal(p.written.at(-1).response.response.behavior, 'deny');
  assert.equal(tm.get(task.id).status, 'running');
  assert.throws(() => tm.decide(a.id, true), /이미 처리/);
});

test('동시 실행 상한: 넘치면 대기했다가 앞 업무가 끝나면 시작', async () => {
  const { tm, procs } = setup(1);
  const a = tm.create({ instruction: 'a', teamId: 'shop-fe' });
  const b = tm.create({ instruction: 'b', teamId: 'erp-fe' });
  await tick();
  assert.equal(procs.length, 1);
  assert.equal(tm.get(b.id).status, 'queued');
  procs[0].emit({ type: 'result', result: 'ok', total_cost_usd: 0, is_error: false, session_id: 's' });
  await tick();
  procs[0].stdin.end(); // 프로세스 종료
  await tick();
  assert.equal(procs.length, 2);
  assert.equal(procs[1].cwd, 'C:\\work\\erp\\frontend');
  assert.equal(tm.get(a.id).status, 'done');
  assert.equal(tm.get(b.id).status, 'planning');
});

test('이어서 지시: 살아 있는 프로세스에 계획 모드로 다시 + 끝난 뒤엔 --resume으로 새로', async () => {
  const { tm, procs } = setup();
  const task = tm.create({ instruction: 'a', teamId: 'shop-fe' });
  await tick();
  procs[0].emit({ type: 'system', subtype: 'init', session_id: 'sess-Z' });
  procs[0].emit({ type: 'result', result: 'ok', total_cost_usd: 0.1, is_error: false, session_id: 'sess-Z' });
  await tick();
  assert.throws(() => tm.create({ instruction: '', teamId: 'shop-fe' }), /비어/);

  tm.message(task.id, '테스트도 추가해');
  await tick();
  const [mode, msg] = procs[0].written.slice(-2);
  assert.equal(mode.request.subtype, 'set_permission_mode');
  assert.equal(mode.request.mode, 'plan');
  assert.match(msg.message.content, /테스트도 추가해/);
  assert.equal(tm.get(task.id).status, 'planning');

  procs[0].emit({ type: 'result', result: 'ok2', total_cost_usd: 0.3, is_error: false, session_id: 'sess-Z' });
  await tick();
  procs[0].stdin.end();
  await tick();
  assert.equal(tm.get(task.id).live, false);
  assert.equal(tm.get(task.id).costUsd, 0.3, '프로세스 안 누적값');
  tm.message(task.id, '하나 더');
  await tick();
  assert.equal(procs.length, 2);
  assert.deepEqual(procs[1].args.slice(procs[1].args.indexOf('--resume'), procs[1].args.indexOf('--resume') + 2), ['--resume', 'sess-Z']);
});

test('중지: interrupt 보내고 상태는 stopped, 결재는 취소', async () => {
  const { tm, procs } = setup();
  const task = tm.create({ instruction: 'a', teamId: 'shop-fe' });
  await tick();
  procs[0].emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } } });
  await tick();
  tm.stop(task.id);
  await tick();
  assert.equal(procs[0].written.at(-1).request.subtype, 'interrupt');
  assert.equal(tm.get(task.id).status, 'stopped');
  assert.equal(tm.pendingApprovals().length, 0);
});

test('비정상 종료 → failed, 서버 재시작 → 진행 중이던 업무는 stopped', async () => {
  const { tm, procs, store } = setup();
  const t1 = tm.create({ instruction: 'a', teamId: 'shop-fe' });
  await tick();
  procs[0].stderr.write('boom');
  await tick();
  procs[0].exit(1);
  await tick();
  assert.equal(tm.get(t1.id).status, 'failed');
  assert.match(String(tm.get(t1.id).error), /코드 1[\s\S]*boom/);

  const t2 = tm.create({ instruction: 'b', teamId: 'shop-fe' });
  await tick();
  assert.equal(tm.get(t2.id).status, 'planning');
  const config = loadConfig(EXAMPLE_CONFIG_FILE);
  const again = new TaskManager({ db: store.db, config, spawner: () => new FakeClaude([], ''), agentsOf: () => [] });
  assert.equal(again.get(t2.id).status, 'stopped');
});

test('계획 모두 승인: 기다리는 계획 결재만 한꺼번에 승인 (작업 결재는 그대로)', async () => {
  const { tm, procs } = setup();
  tm.create({ instruction: 'a', teamId: 'shop-fe' });
  tm.create({ instruction: 'b', teamId: 'shop-be' });
  const c = tm.create({ instruction: 'c', teamId: 'erp-fe' });
  await tick();
  procs[0].emit({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } } });
  procs[1].emit({ type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'y' } } });
  procs[2].emit({ type: 'control_request', request_id: 't1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'git push' } } });
  await tick();
  assert.equal(tm.pendingApprovals().length, 3);
  assert.equal(tm.approveAllPlans(), 2);
  assert.deepEqual(tm.pendingApprovals().map(a => a.kind), ['tool']);
  assert.equal(procs[0].written.at(-1).response.response.behavior, 'allow');
  assert.equal(tm.get(c.id).status, 'approval');
});

test('초안(칸반·비서)은 보내기 전까지 실행하지 않고, 보낼 때 팀·직원을 바꿀 수 있다', async () => {
  const { tm, procs } = setup();
  const d = tm.create({ instruction: '로그인 오류 확인', teamId: 'shop-fe', draft: true, source: 'secretary' });
  await tick();
  assert.equal(procs.length, 0);
  assert.equal(d.status, 'draft');
  assert.throws(() => tm.start(d.id, { teamId: 'shop-be', agent: 'nobody' }), /없는 직원/);
  const t = tm.start(d.id, { teamId: 'shop-be', agent: 'bug-fixer' });
  await tick();
  assert.equal(t.teamId, 'shop-be');
  assert.ok(procs[0].args.includes('--agent') && procs[0].args.includes('bug-fixer'));
  assert.throws(() => tm.start(d.id), /이미 보낸/);
});
