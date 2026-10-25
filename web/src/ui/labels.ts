import type { TaskStatus } from '../../../shared/src/tasks.ts';

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: 'gray' | 'blue' | 'orange' | 'green' | 'red' }> = {
  draft: { label: '초안', tone: 'gray' },
  queued: { label: '대기', tone: 'gray' },
  planning: { label: '계획 중', tone: 'blue' },
  plan_review: { label: '📋 계획 결재', tone: 'orange' },
  running: { label: '실행 중', tone: 'blue' },
  approval: { label: '✋ 결재 대기', tone: 'orange' },
  done: { label: '완료', tone: 'green' },
  failed: { label: '실패', tone: 'red' },
  stopped: { label: '중지', tone: 'gray' },
  rejected: { label: '반려', tone: 'red' },
};

export const hhmm = (ts: number) => new Date(ts).toTimeString().slice(0, 5);
export const ago = (ts: number) => {
  const m = Math.floor((Date.now() - ts) / 60_000);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
};
