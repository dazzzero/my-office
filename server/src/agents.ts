// 팀 폴더의 고정 직원 목록: <프로젝트>/.claude/agents/*.md + 내 PC 공용 ~/.claude/agents/*.md
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TeamAgent } from '../../shared/src/tasks.ts';

function readAgents(dir: string, scope: TeamAgent['scope']): TeamAgent[] {
  if (!existsSync(dir)) return [];
  const out: TeamAgent[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    try {
      const text = readFileSync(join(dir, file), 'utf8').replace(/^﻿/, '');
      const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
      const field = (k: string) => front.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1].trim().replace(/^["'>|]\s*|["']$/g, '') ?? '';
      const name = field('name') || file.replace(/\.md$/, '');
      out.push({ name, description: field('description').slice(0, 200), scope });
    } catch {
      // 읽을 수 없는 파일은 건너뛴다
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAgents(teamPath: string, userDir = join(homedir(), '.claude', 'agents')): TeamAgent[] {
  const project = readAgents(join(teamPath, '.claude', 'agents'), 'project');
  const names = new Set(project.map(a => a.name));
  return [...project, ...readAgents(userDir, 'user').filter(a => !names.has(a.name))];
}
