// 한 번 묻고 답을 받는 Claude 호출 (`claude -p --output-format json`). 비서·회의가 쓴다.
// 같은 구독 로그인·모델(설정의 runner.model)을 쓰고, 세션 기록은 남기지 않는다.
import { spawn } from 'node:child_process';
import type { RunnerConfig } from '../../shared/src/config.ts';
import { resolveClaude, type ChildLike } from './runner.ts';

/**
 * 회의 조사에 쓰는 읽기 전용 도구. 파일을 바꾸거나 명령을 실행하는 도구는 없다.
 * WebFetch는 뺀다: 코드·diff 속 숨은 지시(프롬프트 주입)에 속아 읽은 내용을 URL에 실어 내보낼 수 있어서
 */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch'];
/** kill이 안 먹을 때(하위 프로세스가 남는 등) 이만큼 기다렸다가 강제로 끝낸다 */
const KILL_GRACE_MS = 5_000;

export interface OneShotRequest {
  cwd: string;
  prompt: string;
  /** 쓸 수 있는 도구. 빈 배열이면 도구 없이 답만 */
  tools: string[];
  /** 주면 구조화 출력(structured)으로 받는다 */
  schema?: object;
  appendSystemPrompt?: string;
  /** 고정 직원(.claude/agents)으로 실행 */
  agent?: string | null;
  /** 미리 정한 세션 id. 훅으로 들어오는 이벤트가 어느 호출 것인지 알 수 있다 */
  sessionId?: string;
  /** cwd 말고도 읽어도 되는 폴더 */
  addDirs?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface OneShotResult {
  text: string;
  structured: unknown;
  costUsd: number;
}

export type OneShot = (req: OneShotRequest) => Promise<OneShotResult>;

/** 테스트에서 가짜 프로세스로 바꿔 끼운다 */
export type OneShotSpawner = (exe: string, args: string[], cwd: string) => ChildLike & { on(event: 'close', cb: (code: number | null) => void): unknown };
const defaultSpawner: OneShotSpawner = (exe, args, cwd) => spawn(exe, args, { cwd, windowsHide: true });

const FILE_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const webOnly = (tools: string[]) => {
  const allow = tools.filter(t => !FILE_TOOLS.has(t));
  return allow.length ? ['--allowedTools', ...allow] : [];
};

export function oneShotArgs(model: string, r: Omit<OneShotRequest, 'cwd' | 'prompt' | 'timeoutMs' | 'signal'>): string[] {
  return [
    '-p', '--output-format', 'json', '--model', model, '--no-session-persistence',
    // 프로젝트 .mcp.json(DB 등)은 띄우지 않는다
    '--strict-mcp-config',
    // 읽기를 허용할 다른 폴더 (같은 층의 다른 팀). 작업 폴더(cwd)는 기본으로 읽힌다
    ...(r.addDirs?.length ? ['--add-dir', ...r.addDirs] : []),
    ...(r.tools.length
      // 목록에 없는 도구는 아예 없고, dontAsk라 허용되지 않은 건 묻지 않고 거절한다.
      // 파일 도구(Read·Grep·Glob)는 허용 목록에 넣지 않는다: 넣으면 PC 어디든 읽힌다 (실측).
      // 빼 두면 기본 규칙대로 작업 폴더·--add-dir 폴더 안에서만 읽힌다
      ? ['--tools', r.tools.join(','), ...webOnly(r.tools), '--permission-mode', 'dontAsk']
      : ['--tools', '']),
    ...(r.schema ? ['--json-schema', JSON.stringify(r.schema)] : []),
    ...(r.appendSystemPrompt ? ['--append-system-prompt', r.appendSystemPrompt] : []),
    ...(r.agent ? ['--agent', r.agent] : []),
    ...(r.sessionId ? ['--session-id', r.sessionId] : []),
  ];
}

export function createOneShot(runner: RunnerConfig, spawner: OneShotSpawner = defaultSpawner, graceMs = KILL_GRACE_MS): OneShot {
  return r => new Promise((resolve, reject) => {
    if (r.signal?.aborted) return reject(new Error('중지됨'));
    const child = spawner(resolveClaude(runner), oneShotArgs(runner.model, r), r.cwd);
    let out = '';
    let err = '';
    let why = '';
    let finished = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const kill = (reason: string) => {
      why ||= reason;
      child.kill();
      // kill이 안 먹어도 회의 진행(대기열)이 영영 막히지 않게
      grace ??= setTimeout(() => done(null), graceMs);
    };
    const timer = setTimeout(() => kill(`시간 초과 (${Math.round(r.timeoutMs / 1000)}초)`), r.timeoutMs);
    const onAbort = () => kill('중지됨');
    r.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err = (err + d).slice(-2000); });
    // 프로세스가 일찍 죽으면 stdin 쓰기가 EPIPE로 실패한다 → 서버가 죽지 않게 삼킨다 (결과는 close에서 판단)
    child.stdin.on('error', () => {});
    child.stdin.end(r.prompt);
    function done(code: number | null) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      r.signal?.removeEventListener('abort', onAbort);
      if (why) return reject(new Error(why));
      let j: { result?: string; structured_output?: unknown; total_cost_usd?: number; is_error?: boolean };
      try { j = JSON.parse(out); } catch { return reject(new Error(`Claude 응답을 읽지 못했습니다 (코드 ${code}) ${err.slice(-300)}`)); }
      if (j.is_error || (r.schema && !j.structured_output)) return reject(new Error(`Claude가 답하지 못했습니다: ${String(j.result ?? err).slice(0, 300)}`));
      resolve({ text: String(j.result ?? ''), structured: j.structured_output ?? null, costUsd: Number(j.total_cost_usd ?? 0) });
    }
    // 'exit'는 출력을 다 읽기 전에 올 수 있다 → 출력 스트림이 닫힌 뒤의 'close'에서 마무리
    child.on('close', done);
    child.on('error', e => { why ||= e.message; done(null); });
  });
}
