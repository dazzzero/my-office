import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FloorConfig, MorningConfig, MyOfficeConfig, TeamConfig } from '../../shared/src/config.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = join(ROOT, 'data');

/** 내 설정. 회사 경로가 들어가므로 git에 올리지 않는다 */
export const CONFIG_FILE = join(ROOT, 'myoffice.config.json');
/** 저장소에 올라가는 예시 설정. 테스트도 이걸 쓴다 */
export const EXAMPLE_CONFIG_FILE = join(ROOT, 'myoffice.config.example.json');

export function loadConfig(path = CONFIG_FILE): MyOfficeConfig {
  if (path === CONFIG_FILE && !existsSync(path)) {
    copyFileSync(EXAMPLE_CONFIG_FILE, path);
    console.log('ℹ️  myoffice.config.json이 없어서 예시 설정으로 만들었습니다. 내 프로젝트 경로로 고쳐 쓰세요.');
  }
  const config = JSON.parse(readFileSync(path, 'utf8')) as MyOfficeConfig;
  // 예전 설정 파일에 없는 항목은 기본값으로
  const m = (config.meetings ??= {} as MyOfficeConfig['meetings']);
  m.maxAttendees ??= 4;
  m.defaultRounds ??= 2;
  const morning: Partial<MorningConfig> = m.morning ?? {};
  const time = morning.time ?? '09:00';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) console.warn(`⚠️  meetings.morning.time "${time}"은 HH:MM(00:00~23:59) 형식이 아니라서 09:00으로 씁니다.`);
  m.morning = {
    enabled: morning.enabled ?? true,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : '09:00',
    weekdays: (morning.weekdays ?? [1, 2, 3, 4, 5]).filter(d => Number.isInteger(d) && d >= 0 && d <= 6),
    floors: morning.floors ?? config.floors.map(f => f.floor),
  };
  return config;
}

/** 경로 비교용 정규화: 소문자, 역슬래시, 끝 구분자 제거. Git Bash 형식(/c/dev)도 c:\dev로 바꾼다 */
export function normPath(p: string): string {
  return p
    .replace(/^\/([a-zA-Z])(\/|$)/, '$1:\\')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

export interface TeamMatch {
  floor: FloorConfig;
  team: TeamConfig;
}

/** cwd → 층/팀. 가장 긴 경로가 우선이고, 등록되지 않은 폴더면 null */
export function createTeamMatcher(config: MyOfficeConfig): (cwd: string) => TeamMatch | null {
  const entries = config.floors
    .flatMap(floor => floor.teams.map(team => ({ floor, team, key: normPath(team.path) })))
    .sort((a, b) => b.key.length - a.key.length);
  return cwd => {
    const p = normPath(cwd);
    const hit = entries.find(e => p === e.key || p.startsWith(e.key + '\\'));
    return hit ? { floor: hit.floor, team: hit.team } : null;
  };
}
