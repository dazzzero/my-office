// Claude Code(claude.exe)를 Paseo와 같은 방식(stream-json 양방향)으로 실행하고 대화한다.
//  보내기: {"type":"user",...} 지시, {"type":"control_response",...} 결재 답
//  받기:   system/init(세션 id), assistant(말·도구), control_request(can_use_tool = 결재 요청), result(한 턴 끝)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { RunnerConfig } from '../../shared/src/config.ts';

export type PermissionMode = 'plan' | 'auto' | 'default' | 'acceptEdits';

export interface PermissionRequest {
  tool_name: string;
  input: Record<string, unknown>;
  decision_reason?: string;
  decision_reason_type?: string;
  tool_use_id?: string;
  agent_id?: string;
}

export type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface TurnResult {
  text: string;
  costUsd: number;
  isError: boolean;
  sessionId: string;
}

export interface ProcessHandlers {
  onInit?(sessionId: string): void;
  onText?(text: string): void;
  onTool?(name: string, input: Record<string, unknown>): void;
  onPermission?(requestId: string, req: PermissionRequest): void;
  /** Claude 쪽에서 결재 요청을 거둬들임 (중단 등) */
  onCancel?(requestId: string): void;
  onResult?(r: TurnResult): void;
  onExit?(code: number | null, stderrTail: string): void;
}

export interface ProcessOptions {
  exe: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  agent?: string | null;
  resume?: string | null;
}

export interface ChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(): unknown;
}
export type Spawner = (exe: string, args: string[], cwd: string) => ChildLike;

const defaultSpawner: Spawner = (exe, args, cwd) =>
  spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

/** claude.exe 위치: 설정 → npm 전역 설치 위치 → PATH의 claude */
export function resolveClaude(config: RunnerConfig): string {
  if (config.claudePath) return config.claudePath;
  const npm = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return existsSync(npm) ? npm : 'claude';
}

export function buildArgs(o: ProcessOptions): string[] {
  return [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--model', o.model,
    '--permission-mode', o.permissionMode,
    '--permission-prompt-tool', 'stdio',
    '--setting-sources=user,project,local',
    ...(o.agent ? ['--agent', o.agent] : []),
    ...(o.resume ? ['--resume', o.resume] : []),
  ];
}

export class ClaudeProcess {
  private child: ChildLike;
  private buf = '';
  private stderrTail = '';
  private seq = 0;
  private exited = false;
  private readonly handlers: ProcessHandlers;

  constructor(opts: ProcessOptions, handlers: ProcessHandlers, spawner: Spawner = defaultSpawner) {
    this.handlers = handlers;
    this.child = spawner(opts.exe, buildArgs(opts), opts.cwd);
    this.child.stdout.setEncoding?.('utf8');
    this.child.stdout.on('data', (d: string | Buffer) => this.onData(String(d)));
    this.child.stderr.on('data', (d: string | Buffer) => { this.stderrTail = (this.stderrTail + String(d)).slice(-2000); });
    this.child.on('error', err => { this.stderrTail += `\n${err.message}`; this.finish(null); });
    this.child.on('exit', code => this.finish(code));
  }

  get alive(): boolean {
    return !this.exited;
  }

  send(text: string): void {
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  respond(requestId: string, result: PermissionResult): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: result } });
  }

  setPermissionMode(mode: PermissionMode): void {
    this.write({ type: 'control_request', request_id: `myoffice-${++this.seq}`, request: { subtype: 'set_permission_mode', mode } });
  }

  interrupt(): void {
    this.write({ type: 'control_request', request_id: `myoffice-${++this.seq}`, request: { subtype: 'interrupt' } });
  }

  /** 입력을 닫으면 Claude가 정상 종료한다 */
  close(): void {
    if (!this.exited) this.child.stdin.end();
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }

  private write(msg: unknown): void {
    if (!this.exited) this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.handlers.onExit?.(code, this.stderrTail);
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Record<string, any>;
      try { m = JSON.parse(line); } catch { continue; }
      this.dispatch(m);
    }
  }

  private dispatch(m: Record<string, any>): void {
    const h = this.handlers;
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id) h.onInit?.(m.session_id);
        break;
      case 'assistant':
        // 서브에이전트 안쪽 말은 제외 (메인 직원의 말만 업무일지에)
        if (m.parent_tool_use_id) break;
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) h.onText?.(c.text);
          else if (c.type === 'tool_use') h.onTool?.(c.name, c.input ?? {});
        }
        break;
      case 'control_request':
        if (m.request?.subtype === 'can_use_tool') h.onPermission?.(m.request_id, m.request as PermissionRequest);
        // 그 밖의 요청(대화형 질문 등)은 처리하지 않는다고 답해서 멈추지 않게
        else this.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: '마이오피스에서 지원하지 않는 요청' } });
        break;
      case 'control_cancel_request':
        h.onCancel?.(m.request_id);
        break;
      case 'result':
        h.onResult?.({ text: String(m.result ?? ''), costUsd: Number(m.total_cost_usd ?? 0), isError: Boolean(m.is_error), sessionId: m.session_id });
        break;
    }
  }
}
