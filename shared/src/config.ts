// myoffice.config.json 스키마. 서버와 웹이 함께 쓴다.

export interface TeamConfig {
  id: string;
  name: string;
  /** 이 폴더(또는 그 하위)에서 실행된 세션이 이 팀 소속이 된다 */
  path: string;
}

export interface FloorConfig {
  floor: number;
  label: string;
  id: string;
  name: string;
  teams: TeamConfig[];
}

/** 어느 층이든 무조건 결재(ask) 또는 차단(deny)할 명령 패턴. allOf의 정규식이 모두 맞으면 해당 */
export interface GuardRule {
  id: string;
  description: string;
  tools: string[];
  allOf: string[];
  action: 'ask' | 'deny';
}

export interface MyOfficeConfig {
  server: { host: string; port: number };
  defaultFloor: number;
  meetingNotesDir: string;
  floors: FloorConfig[];
  guard: GuardRule[];
  /** 한 프로젝트의 규칙 파일을 다른 작업 공간에 복사 (npm run rules:sync) */
  rulesSync?: RulesSync[];
  /** 마이오피스가 직접 시키는 일 */
  runner: RunnerConfig;
  notifications: { windows: WindowsNotifyConfig; mobile: null | { provider: 'telegram' } };
}

export interface RunnerConfig {
  /** 마이오피스가 동시에 띄우는 Claude 수 (Paseo 대화는 세지 않음) */
  maxConcurrent: number;
  model: string;
  /** claude.exe 경로. 비우면 npm 전역 설치 위치에서 찾는다 */
  claudePath?: string;
  /** 일이 끝나고 이 시간(분) 동안 추가 지시가 없으면 프로세스를 닫는다 (이어서 지시하면 다시 연다) */
  idleMinutes: number;
}

export interface RulesSync {
  name: string;
  from: string;
  to: string;
  /** from/to 기준 상대 경로 */
  files: string[];
  /** CLAUDE.md 사본 맨 위에 붙일 안내. {src}=원본 경로, {date}=동기화 날짜 */
  header: string[];
}

export interface WindowsNotifyConfig {
  enabled: boolean;
  /** 결재 대기 */
  waiting: boolean;
  /** 오류로 멈춤 */
  error: boolean;
  /** 작업 완료 */
  done: boolean;
  /** 작업이 끝난 뒤 이 시간(초) 동안 새 지시가 없을 때만 완료 알림 (연달아 일할 땐 조용히) */
  doneQuietSeconds: number;
  /** 자동 모드가 작업을 막음 */
  denied: boolean;
}
