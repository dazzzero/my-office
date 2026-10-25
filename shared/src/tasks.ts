// 마이오피스가 직접 시키는 일(업무)과 결재.

/**
 * draft: 비서가 만든 초안·칸반 카드 (아직 안 보냄)
 * queued: 보냈지만 동시 실행 상한 때문에 대기
 * planning: 계획 세우는 중 (파일 안 바꿈)
 * plan_review: 계획 결재 대기
 * running: 실행 중
 * approval: 실행 중 결재 대기 (금지 목록 등)
 * done / failed / stopped / rejected
 */
export type TaskStatus = 'draft' | 'queued' | 'planning' | 'plan_review' | 'running' | 'approval' | 'done' | 'failed' | 'stopped' | 'rejected';
export type TaskSource = 'direct' | 'secretary' | 'kanban' | 'meeting';

export const ACTIVE_STATUSES: TaskStatus[] = ['planning', 'plan_review', 'running', 'approval'];

export interface Task {
  id: number;
  title: string;
  instruction: string;
  floor: number;
  teamId: string;
  /** 고정 직원(.claude/agents)으로 시킨 경우 그 이름 */
  agent: string | null;
  source: TaskSource;
  status: TaskStatus;
  sessionId: string | null;
  plan: string | null;
  result: string | null;
  error: string | null;
  /** Claude가 알려주는 사용량 추정치(달러). 구독 요금제에선 실제 청구가 아니라 한도 사용량 참고용 */
  costUsd: number;
  createdAt: number;
  updatedAt: number;
  /** Claude 프로세스가 살아 있어서 바로 이어서 지시할 수 있는지 */
  live: boolean;
  /** 회의에서 나온 할 일이면 그 회의 */
  meetingId: number | null;
}

/**
 * plan: 계획 결재, tool: 마이오피스가 시킨 일의 작업 결재, terminal: Paseo·터미널 세션의 권한 요청 (토글을 켰을 때),
 * today: 아침 스탠드업이 제안한 "오늘 할 일" 묶음 (골라서 승인)
 */
export type ApprovalKind = 'plan' | 'tool' | 'terminal' | 'today';

/** today 결재의 input */
export interface TodayChecklist {
  meetingId: number;
  floor: number;
  items: { taskId: number; title: string; teamId: string; agent: string | null; instruction: string }[];
}
/** Paseo·터미널 세션의 결재를 어디서 받을지 */
export type TerminalApprovalMode = 'terminal' | 'office';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface Approval {
  id: number;
  taskId: number | null;
  kind: ApprovalKind;
  sessionId: string | null;
  toolName: string | null;
  input: Record<string, unknown> | null;
  /** 왜 결재가 필요한지 (금지 목록 사유, 자동 모드 판단 등) */
  reason: string | null;
  status: ApprovalStatus;
  note: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface TaskLogEntry {
  id: number;
  taskId: number;
  ts: number;
  kind: 'instruction' | 'text' | 'tool' | 'result' | 'approval' | 'system';
  text: string;
}

export interface TeamAgent {
  name: string;
  description: string;
  /** project: 그 프로젝트의 .claude/agents, user: 내 PC 공용(~/.claude/agents) */
  scope: 'project' | 'user';
}

/** 비서가 제안하는 업무 초안 */
export interface Draft {
  teamId: string;
  agent: string | null;
  title: string;
  instruction: string;
}
