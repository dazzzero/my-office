// 훅 설치/제거 공용. 의존성 없이 node만으로 실행된다.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** 테스트할 때는 MYOFFICE_CLAUDE_SETTINGS로 다른 파일을 지정할 수 있다 */
export const SETTINGS = process.env.MYOFFICE_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json');
export const TOKEN_FILE = join(ROOT, 'data', 'hook-token.txt');
/** 이 헤더가 달린 http 훅 = 마이오피스 훅. 제거할 때 이것만 골라 지운다 */
export const MARK_HEADER = 'X-MyOffice-Token';

/** 관전용 이벤트. 도구 이벤트는 모든 도구(*)에 건다 */
export const EVENTS = [
  ['SessionStart'], ['SessionEnd'], ['UserPromptSubmit'],
  ['PreToolUse', '*'], ['PostToolUse', '*'], ['PostToolUseFailure', '*'], ['PermissionRequest', '*'], ['PermissionDenied', '*'],
  ['Notification', '*'], ['SubagentStart'], ['SubagentStop'],
  ['Stop'], ['StopFailure'], ['PreCompact'], ['PostCompact'],
  ['TaskCreated'], ['TaskCompleted'], ['CwdChanged'],
];

export function ensureToken() {
  if (existsSync(TOKEN_FILE)) return readFileSync(TOKEN_FILE, 'utf8').trim();
  mkdirSync(dirname(TOKEN_FILE), { recursive: true });
  const token = randomUUID();
  writeFileSync(TOKEN_FILE, token);
  return token;
}

/**
 * 내 설정(myoffice.config.json)은 회사 경로가 들어가므로 git에 올리지 않는다.
 * 없으면 예시(myoffice.config.example.json)를 복사해서 만든다.
 */
export function loadConfig() {
  const file = join(ROOT, 'myoffice.config.json');
  if (!existsSync(file)) {
    copyFileSync(join(ROOT, 'myoffice.config.example.json'), file);
    console.log('ℹ️  myoffice.config.json이 없어서 예시 설정으로 만들었습니다. 내 프로젝트 경로로 고쳐 쓰세요.');
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function serverUrl() {
  const { host, port } = loadConfig().server;
  return `http://${host}:${port}`;
}

export function readSettings() {
  const raw = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : '{}';
  const indent = raw.match(/\n( +)"/)?.[1] ?? '  ';
  return { raw, indent, settings: JSON.parse(raw) };
}

export function writeSettings({ raw, indent, settings }) {
  writeFileSync(SETTINGS, JSON.stringify(settings, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
}

export function backupSettings() {
  if (!existsSync(SETTINGS)) return null;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const to = `${SETTINGS}.bak-myoffice-${stamp}`;
  copyFileSync(SETTINGS, to);
  return to;
}

const isOurs = handler => handler?.type === 'http' && handler.headers && MARK_HEADER in handler.headers;

export function countOurs(settings) {
  return Object.values(settings.hooks ?? {}).flat().flatMap(g => g.hooks ?? []).filter(isOurs).length;
}

/** 마이오피스 훅만 빼고 나머지 훅은 그대로 둔다 */
export function stripOurs(settings) {
  if (!settings.hooks) return settings;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !isOurs(h)) }))
      .filter(g => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

export function ourHookGroups(token) {
  const url = `${serverUrl()}/hook`;
  return Object.fromEntries(EVENTS.map(([event, matcher]) => [event, {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'http', url, timeout: 3, headers: { [MARK_HEADER]: token } }],
  }]));
}
