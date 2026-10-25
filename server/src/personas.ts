// 회의 공용 역할: personas/*.md (기획자·아키텍트·QA·보안 검토자·서기). 직접 고쳐 쓰면 다음 회의부터 반영된다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Persona } from '../../shared/src/meetings.ts';
import { ROOT } from './config.ts';

export const PERSONAS_DIR = join(ROOT, 'personas');
/** 회의록을 정리하는 역할. 참석자 목록에는 나오지 않는다 */
export const SCRIBE = 'scribe';

export interface PersonaFull extends Persona {
  /** 성격·관점 (시스템 프롬프트에 붙인다) */
  body: string;
}

export function loadPersonas(dir = PERSONAS_DIR): Map<string, PersonaFull> {
  const out = new Map<string, PersonaFull>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.md')) continue;
    try {
      const text = readFileSync(join(dir, file), 'utf8').replace(/^﻿/, '');
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      const front = m?.[1] ?? '';
      const field = (k: string) => front.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1].trim() ?? '';
      const id = file.replace(/\.md$/, '');
      out.set(id, { id, name: field('name') || id, emoji: field('emoji') || '👤', summary: field('summary'), body: (m?.[2] ?? text).trim() });
    } catch {
      // 읽을 수 없는 파일은 건너뛴다
    }
  }
  return out;
}
