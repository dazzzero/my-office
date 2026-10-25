import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './config.ts';

/** 훅 요청 인증 토큰. hooks/install.mjs도 같은 파일을 읽는다 */
export const TOKEN_FILE = join(DATA_DIR, 'hook-token.txt');

export function ensureToken(file = TOKEN_FILE): string {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true });
  const token = randomUUID();
  writeFileSync(file, token);
  return token;
}
