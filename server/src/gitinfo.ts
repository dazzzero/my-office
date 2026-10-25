// 아침 스탠드업·코드리뷰 회의에 넣을 git 사실. Claude에게 시키지 않고 서버가 직접 읽는다 (빠르고, 사용량이 안 든다).
// 읽기만 한다: rev-parse · log · status · diff · show
import { execFile } from 'node:child_process';
import { hash } from '../../shared/src/identity.ts';

export interface GitFacts {
  /** git 저장소인지 */
  ok: boolean;
  head: string | null;
  /** since 이후 커밋 한 줄씩 */
  commits: string[];
  /** 커밋 안 한 변경 (git status --porcelain) */
  changes: string[];
  /** 커밋 안 한 변경 크기 요약 (diff --stat 마지막 줄) */
  diffStat: string;
  /** HEAD + 커밋 안 한 변경. 지난 스탠드업 이후 바뀐 게 있는지 비교용 */
  fingerprint: string;
}

export interface GitReader {
  facts(cwd: string, sinceMs: number): Promise<GitFacts>;
  /** 코드리뷰용 변경 내용: 커밋 안 한 변경이 있으면 그것, 없으면 마지막 커밋 */
  diff(cwd: string, maxChars: number): Promise<{ label: string; text: string } | null>;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const lines = (s: string, max: number) => s.split('\n').map(l => l.trimEnd()).filter(Boolean).slice(0, max);

export const realGit: GitReader = {
  async facts(cwd, sinceMs) {
    const head = await git(cwd, ['rev-parse', 'HEAD']).then(s => s.trim(), () => null);
    if (!head) {
      const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']).then(() => true, () => false);
      if (!inside) return { ok: false, head: null, commits: [], changes: [], diffStat: '', fingerprint: 'no-git' };
    }
    const [log, status, stat] = await Promise.all([
      head ? git(cwd, ['log', `--since=${new Date(sinceMs).toISOString()}`, '--no-merges', '-n', '30',
        '--date=format:%m-%d %H:%M', '--pretty=format:%h %ad %an: %s']).catch(() => '') : Promise.resolve(''),
      git(cwd, ['status', '--porcelain']).catch(() => ''),
      head ? git(cwd, ['diff', '--stat', 'HEAD']).catch(() => '') : Promise.resolve(''),
    ]);
    const changes = lines(status, 60);
    const diffStat = lines(stat, 1000).at(-1) ?? '';
    return { ok: true, head, commits: lines(log, 30), changes, diffStat, fingerprint: String(hash(`${head}\n${status}\n${stat}`)) };
  },

  async diff(cwd, maxChars) {
    const [work, stat, untracked] = await Promise.all([
      git(cwd, ['diff', 'HEAD']).catch(() => ''),
      git(cwd, ['diff', '--stat', 'HEAD']).catch(() => ''),
      // git diff에는 아직 git에 안 올린 새 파일이 빠진다 → 목록을 붙여서 직접 읽게
      git(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
    ]);
    const added = lines(untracked, 80);
    if (work.trim() || added.length) {
      // 요약·새 파일 목록을 맨 앞에 둬서 본문이 잘려도 무엇이 바뀌었는지는 다 보이게
      const head = [
        stat.trim() && `[바뀐 파일 요약 (git diff --stat HEAD)]\n${stat.trim()}`,
        added.length && `[새 파일 — git에 아직 안 올려서 아래 diff에 없음. 필요하면 직접 읽을 것]\n${added.join('\n')}`,
      ].filter(Boolean).join('\n\n');
      return { label: '커밋 안 한 변경', text: `${head}\n\n${byFile(work, maxChars)}`.trim() };
    }
    const last = await git(cwd, ['show', 'HEAD', '--stat', '--patch', '--format=%h %an %ad%n%s%n%b', '--date=format:%Y-%m-%d %H:%M']).catch(() => '');
    return last.trim() ? { label: '마지막 커밋 (git show HEAD)', text: byFile(last, maxChars) } : null;
  },
};

/** diff를 파일 단위로 한도까지 담고, 못 담은 파일은 이름만 알려 준다 */
export function byFile(diff: string, maxChars: number): string {
  const out: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const part of diff.split(/^(?=diff --git )/m)) {
    if (used + part.length <= maxChars) { out.push(part); used += part.length; }
    else skipped.push(part.match(/^diff --git a\/(\S+)/)?.[1] ?? '(머리말)');
  }
  return out.join('') + (skipped.length ? `\n…(길어서 뺀 파일 ${skipped.length}개 — 필요하면 직접 읽을 것: ${skipped.join(', ')})` : '');
}
