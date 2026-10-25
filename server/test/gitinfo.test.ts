import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { byFile, realGit } from '../src/gitinfo.ts';

const dir = mkdtempSync(join(tmpdir(), 'myoffice-git-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: dir });

test('diff를 파일 단위로 자르고, 못 담은 파일은 이름을 알려 준다', () => {
  const d = ['diff --git a/a.ts b/a.ts\n+aaaa\n', 'diff --git a/b.ts b/b.ts\n+' + 'b'.repeat(100) + '\n', 'diff --git a/c.ts b/c.ts\n+c\n'].join('');
  const out = byFile(d, 60);
  assert.match(out, /a\.ts[\s\S]*c\.ts/);
  assert.ok(!out.includes('bbbb'));
  assert.match(out, /뺀 파일 1개[\s\S]*b\.ts/);
});

test('git 현황·코드리뷰 자료: 커밋, 커밋 안 한 변경, 새 파일(요약을 맨 앞에), 지문', { skip: !hasGit }, async () => {
  const none = await realGit.facts(dir, 0);
  assert.equal(none.ok, false, 'git 저장소가 아님');

  git('init', '-q');
  writeFileSync(join(dir, 'a.ts'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', '첫 커밋');
  const clean = await realGit.facts(dir, 0);
  assert.equal(clean.ok, true);
  assert.equal(clean.commits.length, 1);
  assert.match(clean.commits[0], /첫 커밋/);
  assert.deepEqual(clean.changes, []);

  writeFileSync(join(dir, 'a.ts'), 'two\n');
  writeFileSync(join(dir, '새파일.ts'), 'new\n');
  const dirty = await realGit.facts(dir, Date.now() + 60_000);
  assert.equal(dirty.commits.length, 0, 'since 이후 커밋 없음');
  assert.deepEqual(dirty.changes.sort(), [' M a.ts', '?? 새파일.ts'], '한글 파일명도 그대로');
  assert.notEqual(dirty.fingerprint, clean.fingerprint);

  const d = await realGit.diff(dir, 30_000);
  assert.ok(d);
  assert.match(d.text, /^\[바뀐 파일 요약[\s\S]*a\.ts[\s\S]*\[새 파일[\s\S]*새파일\.ts[\s\S]*diff --git a\/a\.ts/);
});
