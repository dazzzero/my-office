// Claude Code 훅 입력(JSON) → 사무실 이벤트의 종류·도구·공간·설명.
import type { EventKind, Zone } from '../../shared/src/events.ts';

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

const KINDS: Record<string, EventKind> = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.start',
  PostToolUse: 'tool.end',
  PostToolUseFailure: 'tool.fail',
  PermissionRequest: 'permission.request',
  PermissionDenied: 'permission.denied',
  Notification: 'notification',
  SubagentStart: 'subagent.start',
  SubagentStop: 'subagent.stop',
  Stop: 'stop',
  StopFailure: 'stop.fail',
  PreCompact: 'compact.start',
  PostCompact: 'compact.end',
  TaskCreated: 'task.created',
  TaskCompleted: 'task.completed',
  CwdChanged: 'cwd.changed',
};

export const HOOK_EVENTS = Object.keys(KINDS);

export function eventKind(hookEventName: string | undefined): EventKind | null {
  return (hookEventName && KINDS[hookEventName]) || null;
}

export function toolZone(tool: string): Zone {
  if (/^(Read|Grep|Glob|LS|NotebookRead)$/.test(tool)) return 'library';
  if (/^(Bash|PowerShell|BashOutput|KillShell|Monitor)$/.test(tool) || tool.startsWith('mcp__')) return 'server';
  if (/^(WebFetch|WebSearch)$/.test(tool)) return 'window';
  if (/^(Agent|Task|SendMessage|Workflow)$/.test(tool)) return 'meeting';
  return 'desk';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const base = (p: unknown): string => str(p).split(/[\\/]/).pop() || str(p);
const clip = (s: string, n = 60): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
};

/** 도구 호출을 사람이 읽는 한 줄로. 예: "client.ts 읽는 중" */
export function toolSummary(tool: string, input: Record<string, unknown> = {}): string {
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return `${base(input.file_path || input.notebook_path)} 읽는 중`;
    case 'Grep':
      return `"${clip(str(input.pattern), 30)}" 검색 중`;
    case 'Glob':
      return `${clip(str(input.pattern), 30)} 찾는 중`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${base(input.file_path || input.notebook_path)} 수정 중`;
    case 'Write':
      return `${base(input.file_path)} 작성 중`;
    case 'Bash':
    case 'PowerShell':
      return clip(str(input.description) || str(input.command).split('\n')[0]);
    case 'WebFetch':
      try { return `${new URL(str(input.url)).host} 보는 중`; } catch { return '웹 페이지 보는 중'; }
    case 'WebSearch':
      return `"${clip(str(input.query), 30)}" 웹 검색 중`;
    case 'Agent':
    case 'Task':
      return clip(`${str(input.subagent_type) || '에이전트'} 호출: ${str(input.description)}`);
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return '할 일 정리 중';
  }
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return `${mcp[1]}.${mcp[2]} 사용 중`;
  return `${tool} 사용 중`;
}

export interface Normalized {
  kind: EventKind;
  tool: string | null;
  zone: Zone | null;
  summary: string;
}

export function normalize(p: HookPayload): Normalized | null {
  const kind = eventKind(p.hook_event_name);
  if (!kind) return null;
  const tool = p.tool_name ?? null;
  const zone = tool ? toolZone(tool) : null;
  const ts = tool ? toolSummary(tool, p.tool_input) : '';
  const summary = (() => {
    switch (kind) {
      case 'session.start': return p.source === 'resume' ? '복귀' : '출근';
      case 'session.end': return '퇴근';
      case 'prompt': return `지시: ${clip(str(p.prompt), 40)}`;
      case 'tool.start': return ts;
      case 'tool.end': return `${tool} 완료`;
      case 'tool.fail': return p.is_interrupt ? `${tool} 중단됨` : `${tool} 실패`;
      case 'permission.request': return `결재 요청: ${ts}`;
      case 'permission.denied': return `자동 모드가 막음: ${ts}`;
      case 'notification':
        if (p.notification_type === 'permission_prompt') return '결재 대기';
        if (p.notification_type === 'idle_prompt') return '지시 대기 중';
        return clip(str(p.message));
      case 'subagent.start': return `${p.agent_type || '서브에이전트'} 출근`;
      case 'subagent.stop': return `${p.agent_type || '서브에이전트'} 업무 완료`;
      case 'stop': return '업무 완료';
      case 'stop.fail': return `오류: ${str(p.error) || 'unknown'}`;
      case 'compact.start': return '커피 브레이크 (기억 정리)';
      case 'compact.end': return '업무 복귀';
      case 'task.created': return `할 일 추가: ${clip(str(p.task_subject), 40)}`;
      case 'task.completed': return `할 일 완료: ${clip(str(p.task_subject), 40)}`;
      case 'cwd.changed': return `폴더 이동: ${base(p.new_cwd)}`;
    }
  })();
  return { kind, tool, zone, summary };
}

/** DB 저장용: 긴 문자열·큰 배열을 잘라 원본 페이로드 크기를 제한한다 */
export function shrink(value: unknown, maxStr = 500, maxItems = 20, depth = 0): unknown {
  if (typeof value === 'string') return value.length > maxStr ? value.slice(0, maxStr) + `…(+${value.length - maxStr})` : value;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, maxItems).map(v => shrink(v, maxStr, maxItems, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v, maxStr, maxItems, depth + 1)]));
}
