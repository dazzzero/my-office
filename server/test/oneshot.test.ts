import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { READ_ONLY_TOOLS, createOneShot, oneShotArgs, type OneShotSpawner } from '../src/oneshot.ts';

/** 진짜 claude.exe 대신. 테스트가 출력·종료 순서를 정한다 */
class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = 0;
  prompt = '';
  /** true면 kill을 무시 (하위 프로세스가 남는 경우 흉내) */
  stubborn = false;
  constructor() {
    super();
    this.stdin.on('data', d => { this.prompt += d; });
  }
  kill() { this.killed++; if (!this.stubborn) setImmediate(() => this.emit('close', null)); }
}

const runner = { maxConcurrent: 1, model: 'claude-opus-5-5', idleMinutes: 1 };
function setup(graceMs = 30) {
  const procs: FakeProc[] = [];
  const args: string[][] = [];
  const spawner: OneShotSpawner = (_exe, a) => { const p = new FakeProc(); procs.push(p); args.push(a); return p as never; };
  return { ask: createOneShot(runner, spawner, graceMs), procs, args };
}
const json = (o: object) => JSON.stringify(o);

test('인자: 조사(읽기 전용 도구 + dontAsk), 도구 없음, 구조화 출력·직원·세션 id, MCP 끔', () => {
  const research = oneShotArgs('m', { tools: READ_ONLY_TOOLS, schema: { type: 'object' }, agent: 'qa', sessionId: 'S', appendSystemPrompt: 'P', addDirs: ['C:\\b', 'C:\\c'] });
  assert.deepEqual(research.slice(research.indexOf('--tools'), research.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob,WebSearch']);
  assert.ok(!research.join(' ').includes('WebFetch'), '읽은 내용을 밖으로 보낼 수 있는 WebFetch는 없다');
  assert.ok(!research.includes('Edit') && !research.includes('Bash') && !research.includes('Write'));
  assert.deepEqual(research.slice(research.indexOf('--permission-mode'), research.indexOf('--permission-mode') + 2), ['--permission-mode', 'dontAsk']);
  // 파일 도구를 허용 목록에 넣으면 PC 어디든 읽힌다 → 웹 검색만 허용, 파일은 작업 폴더·추가 폴더 안에서만
  assert.deepEqual(research.slice(research.indexOf('--allowedTools'), research.indexOf('--allowedTools') + 2), ['--allowedTools', 'WebSearch']);
  assert.deepEqual(research.slice(research.indexOf('--add-dir'), research.indexOf('--add-dir') + 3), ['--add-dir', 'C:\\b', 'C:\\c']);
  assert.ok(research[research.indexOf('--add-dir') + 3].startsWith('--'), '--add-dir 뒤엔 바로 다음 옵션');
  const filesOnly = oneShotArgs('m', { tools: ['Read', 'Grep'] });
  assert.ok(!filesOnly.includes('--allowedTools'));
  for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--json-schema', '--agent', '--session-id', '--append-system-prompt']) assert.ok(research.includes(flag), flag);

  const talk = oneShotArgs('m', { tools: [] });
  assert.deepEqual(talk.slice(talk.indexOf('--tools'), talk.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(!talk.includes('--permission-mode') && !talk.includes('--json-schema') && !talk.includes('--agent'));
});

test('출력이 exit 뒤에 와도 close에서 다 읽고 파싱한다, 지시는 stdin으로', async () => {
  const { ask, procs } = setup();
  const p = ask({ cwd: '.', prompt: '안녕', tools: [], schema: {}, timeoutMs: 1000 });
  const proc = procs[0];
  proc.emit('exit', 0);
  proc.stdout.write(json({ result: 'ok', structured_output: { a: 1 }, total_cost_usd: 0.2 }));
  setImmediate(() => proc.emit('close', 0));
  const r = await p;
  assert.deepEqual(r.structured, { a: 1 });
  assert.equal(r.costUsd, 0.2);
  assert.equal(proc.prompt, '안녕');
});

test('시간 초과: kill이 안 먹어도 잠시 뒤 강제로 끝낸다 (회의 대기열이 막히지 않게)', async () => {
  const { ask, procs } = setup(30);
  const p = ask({ cwd: '.', prompt: 'x', tools: [], timeoutMs: 20 });
  procs[0].stubborn = true;
  await assert.rejects(p, /시간 초과/);
  assert.equal(procs[0].killed, 1);
});

test('중지 신호 → 중지됨, error와 close가 겹쳐도 한 번만 끝난다', async () => {
  const { ask, procs } = setup();
  const ac = new AbortController();
  const p = ask({ cwd: '.', prompt: 'x', tools: [], timeoutMs: 1000, signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /중지됨/);
  procs[0].emit('error', new Error('late'));
  procs[0].emit('close', 1);

  const ac2 = new AbortController();
  ac2.abort();
  await assert.rejects(ask({ cwd: '.', prompt: 'x', tools: [], timeoutMs: 1000, signal: ac2.signal }), /중지됨/);
  assert.equal(procs.length, 1, '이미 중지된 신호면 띄우지도 않음');
});

test('stdin 쓰기 실패(EPIPE)는 삼키고, 결과는 출력으로 판단. 망가진 출력·구조화 출력 없음은 실패', async () => {
  const { ask, procs } = setup();
  const p = ask({ cwd: '.', prompt: 'x', tools: [], timeoutMs: 1000 });
  procs[0].stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  procs[0].stdout.write('not json');
  procs[0].emit('close', 1);
  await assert.rejects(p, /응답을 읽지 못했습니다/);

  const p2 = ask({ cwd: '.', prompt: 'x', tools: [], schema: {}, timeoutMs: 1000 });
  procs[1].stdout.write(json({ result: '한도 초과', is_error: true }));
  procs[1].emit('close', 1);
  await assert.rejects(p2, /답하지 못했습니다: 한도 초과/);
});
