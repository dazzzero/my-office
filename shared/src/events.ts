// 훅 이벤트를 사무실 이벤트로 정규화한 형태와, 화면이 그리는 직원 상태.
import type { Meeting, MeetingLine, MorningStatus } from './meetings.ts';
import type { Approval, Task, TerminalApprovalMode } from './tasks.ts';

export type EventKind =
  | 'session.start'
  | 'session.end'
  | 'prompt'
  | 'tool.start'
  | 'tool.end'
  | 'tool.fail'
  | 'permission.request'
  | 'permission.denied'
  | 'notification'
  | 'subagent.start'
  | 'subagent.stop'
  | 'stop'
  | 'stop.fail'
  | 'compact.start'
  | 'compact.end'
  | 'task.created'
  | 'task.completed'
  | 'cwd.changed';

/** 사무실 공간. 도구 종류에 따라 직원이 이동하는 곳 */
export type Zone = 'library' | 'desk' | 'server' | 'window' | 'meeting' | 'lounge' | 'elevator' | 'boss';

export interface OfficeEvent {
  id: number;
  ts: number;
  kind: EventKind;
  sessionId: string;
  /** 서브에이전트가 낸 이벤트면 그 에이전트 id */
  agentId: string | null;
  agentType: string | null;
  floor: number;
  teamId: string;
  cwd: string;
  tool: string | null;
  zone: Zone | null;
  /** 말풍선·로그에 쓰는 짧은 설명. 예: "client.ts 읽는 중" */
  summary: string;
}

/** 직원 상태. working: 일하는 중 / waiting: 결재 대기 / idle: 대기 / error: 오류 / away: 오래 소식 없음 / left: 퇴근 */
export type WorkerStatus = 'working' | 'waiting' | 'idle' | 'error' | 'away' | 'left';

export interface Worker {
  /** 세션이면 sessionId, 서브에이전트면 `${sessionId}/${agentId}` */
  id: string;
  sessionId: string;
  agentId: string | null;
  /** 서브에이전트 종류(Explore 등). 세션 본인은 null */
  agentType: string | null;
  floor: number;
  teamId: string;
  status: WorkerStatus;
  zone: Zone;
  summary: string;
  tool: string | null;
  startedAt: number;
  lastSeen: number;
  /** 처리한 도구 호출 수 */
  toolCount: number;
  /** 이름표에 쓸 이름 (회의 참석자 "🧪QA" 등). 없으면 세션 id로 정한 이름 */
  label?: string;
  /** 회의 참석자면 그 회의 */
  meetingId?: number;
}

export interface FloorSummary {
  floor: number;
  label: string;
  name: string;
  working: number;
  waiting: number;
  total: number;
}

/** 서버 → 웹 WebSocket 메시지 */
export type ServerMessage =
  | {
    type: 'snapshot'; workers: Worker[]; floors: FloorSummary[]; recent: OfficeEvent[]; tasks: Task[]; approvals: Approval[]; terminalMode: TerminalApprovalMode;
    meetings: Meeting[]; morning: MorningStatus;
  }
  | { type: 'work'; tasks: Task[]; approvals: Approval[]; terminalMode: TerminalApprovalMode }
  | { type: 'meetings'; meetings: Meeting[]; morning: MorningStatus }
  | { type: 'meeting.line'; line: MeetingLine }
  | { type: 'event'; event: OfficeEvent; changed: Worker[]; removed: string[]; floors: FloorSummary[] }
  | { type: 'tick'; changed: Worker[]; removed: string[]; floors: FloorSummary[] };
