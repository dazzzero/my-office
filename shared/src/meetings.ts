// 회의실: 참석자들이 조사 → 토론 → 회의록(결정·할 일)을 만든다. 회의는 파일을 바꾸지 않는다.

/** standup: 아침 스탠드업(층마다 자동), planning: 기획 회의, review: 코드리뷰 회의 */
export type MeetingKind = 'standup' | 'planning' | 'review';

/**
 * queued: 앞 회의가 끝나길 기다림 / research: 조사 / debate: 토론 / minutes: 회의록 정리
 * done / failed / stopped / skipped(아침 루틴에서 바뀐 것도 남은 일도 없어 건너뜀)
 */
export type MeetingStatus = 'queued' | 'research' | 'debate' | 'minutes' | 'done' | 'failed' | 'stopped' | 'skipped';

export const MEETING_ACTIVE: MeetingStatus[] = ['queued', 'research', 'debate', 'minutes'];

/** 회의를 열 때 고르는 참석자 */
export type AttendeeInput =
  | { kind: 'team'; teamId: string }
  | { kind: 'agent'; teamId: string; agent: string }
  | { kind: 'persona'; persona: string };

export interface MeetingAttendee {
  kind: AttendeeInput['kind'];
  /** 팀 대표·고정 직원이면 그 팀. 공용 역할은 null */
  teamId: string | null;
  agent: string | null;
  persona: string | null;
  /** 회의록·화면에 쓰는 이름. 예: "프론트엔드팀 대표", "🧪 QA" */
  name: string;
  /** 3D 사무실에서 이 참석자를 그리는 직원 id */
  workerId: string;
}

/** 회의에서 나온 할 일 → 칸반 초안 */
export interface ActionItem {
  teamId: string;
  agent: string | null;
  title: string;
  instruction: string;
}

/** 서기가 정리한 회의록 (구조화 출력) */
export interface Minutes {
  summary: string;
  discussion: string;
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
}

export interface Meeting {
  id: number;
  kind: MeetingKind;
  floor: number;
  title: string;
  agenda: string;
  attendees: MeetingAttendee[];
  rounds: number;
  status: MeetingStatus;
  minutes: Minutes | null;
  /** 회의록 파일 경로 */
  file: string | null;
  error: string | null;
  /** Claude가 알려주는 사용량 추정치(달러, 구독 한도 참고용)와 호출 수 */
  costUsd: number;
  calls: number;
  /** 아침 루틴으로 열린 회의면 그 날짜 (YYYY-MM-DD) */
  routineDate: string | null;
  /** 회의에서 나온 할 일(업무 초안) id */
  taskIds: number[];
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export type MeetingStage = 'research' | 'debate' | 'minutes' | 'system';

/** 회의 중 발언 하나 (조사 결과·토론 발언·진행 안내) */
export interface MeetingLine {
  id: number;
  meetingId: number;
  ts: number;
  stage: MeetingStage;
  round: number | null;
  /** 참석자 순번 (attendees 배열 index). 진행 안내·서기는 null */
  speaker: number | null;
  /** 말풍선에 띄우는 한 줄 요지 */
  gist: string | null;
  text: string;
}

/** 공용 역할 (personas/*.md) */
export interface Persona {
  id: string;
  name: string;
  emoji: string;
  /** 한 줄 소개 */
  summary: string;
}

export interface MorningStatus {
  enabled: boolean;
  /** "09:00" */
  time: string;
  /** 다음 실행 예정 시각 (ms). 꺼져 있으면 null */
  nextAt: number | null;
  /** 마지막으로 실행한 날짜 (YYYY-MM-DD) */
  lastDate: string | null;
}

export const MEETING_KIND_LABEL: Record<MeetingKind, string> = {
  standup: '☀️ 아침 스탠드업',
  planning: '💡 기획 회의',
  review: '🔍 코드리뷰 회의',
};
