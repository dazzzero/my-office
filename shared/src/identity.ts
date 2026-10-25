// 직원의 이름·외형·색. 같은 세션은 항상 같은 결과가 나오도록 세션 id 해시로 정한다.
// (Phase 4 사원증 편집기에서 사용자가 바꾼 값이 있으면 그걸 우선하게 될 자리)
import type { FloorConfig } from './config.ts';
import type { Worker } from './events.ts';

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
const GIVEN = ['하늘', '서준', '민준', '지우', '서연', '도윤', '하은', '예준', '지호', '수아', '시우', '지민', '유진', '현우', '채원',
  '준서', '다은', '건우', '소율', '은우', '윤서', '태윤', '나연', '시윤', '하린', '주원', '가은', '민서', '지안', '도현'];

const MODELS = ['male-a', 'female-a', 'male-b', 'female-b', 'male-c', 'female-c', 'male-d', 'female-d', 'male-e', 'female-e', 'male-f', 'female-f'];

/** 팀 색 (층 안에서 팀 순서대로) */
export const TEAM_COLORS = ['#e8833a', '#4a7bd0', '#3fa36b'];
export const HOT_COLOR = '#8a93a3';

export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function workerName(w: Pick<Worker, 'sessionId' | 'agentType'>): string {
  if (w.agentType) return w.agentType;
  const h = hash(w.sessionId);
  return SURNAMES[h % SURNAMES.length] + GIVEN[(h >>> 8) % GIVEN.length];
}

/** 서브에이전트면 "Explore · 김하늘" 처럼 누구의 부하인지 함께 */
export function workerFullName(w: Pick<Worker, 'sessionId' | 'agentType'>): string {
  return w.agentType ? `${w.agentType} · ${workerName({ sessionId: w.sessionId, agentType: null })}` : workerName(w);
}

export function workerModel(w: Pick<Worker, 'id'>): string {
  return MODELS[hash(w.id) % MODELS.length];
}

export function teamColor(floor: FloorConfig | undefined, teamId: string): string {
  const i = floor?.teams.findIndex(t => t.id === teamId) ?? -1;
  return i >= 0 ? TEAM_COLORS[i % TEAM_COLORS.length] : HOT_COLOR;
}

export function teamName(floor: FloorConfig | undefined, teamId: string): string {
  return floor?.teams.find(t => t.id === teamId)?.name ?? teamId;
}
