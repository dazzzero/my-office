// 한 프로젝트의 규칙 파일(CLAUDE.md, .claude/rules, 차단 훅, settings)을 다른 작업 공간에 복사한다.
// 무엇을 어디로 복사할지는 myoffice.config.json의 rulesSync에 적는다 (회사 경로라 git에 올리지 않음).
// 사용: node scripts/sync-rules.mjs [--dry-run]
//
// 주의: .mcp.json(DB 접속), settings.local.json(개인 설정), 에이전트 파일처럼
//       원본 프로젝트 전용 경로·접속정보가 들어 있는 파일은 files에 넣지 말 것.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../hooks/common.mjs';

const dryRun = process.argv.includes('--dry-run');
const today = new Date().toLocaleDateString('sv-SE');
const stamp = new Date().toLocaleString('sv-SE').replace(/[-: ]/g, '').replace(/^(\d{8})/, '$1-');
const jobs = loadConfig().rulesSync ?? [];
if (!jobs.length) console.log('myoffice.config.json에 rulesSync 설정이 없습니다.');

for (const job of jobs) {
  console.log(`\n📋 ${job.name}`);
  for (const rel of job.files) {
    const src = join(job.from, rel);
    const dst = join(job.to, rel);
    if (!existsSync(src)) { console.warn(`⚠️  원본 없음: ${src}`); continue; }
    const body = readFileSync(src, 'utf8');
    const header = job.header.map(l => l.replaceAll('{src}', src).replaceAll('{date}', today)).join('\n') + '\n\n';
    const next = rel.endsWith('CLAUDE.md') ? header + body : body;
    const prev = existsSync(dst) ? readFileSync(dst, 'utf8') : null;
    const state = prev === null ? '새로 만듦' : prev === next ? '변경 없음' : '갱신 (기존 파일 백업)';
    console.log(`${dryRun ? '[dry-run] ' : ''}${state.padEnd(16)} ${dst}`);
    if (dryRun || prev === next) continue;
    mkdirSync(dirname(dst), { recursive: true });
    if (prev !== null) copyFileSync(dst, `${dst}.bak-${stamp}`);
    writeFileSync(dst, next);
  }
}
