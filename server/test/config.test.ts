import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXAMPLE_CONFIG_FILE, createTeamMatcher, loadConfig, normPath } from '../src/config.ts';

// 테스트는 저장소에 올라가는 예시 설정으로 돈다 (내 실제 설정과 무관)
const config = loadConfig(EXAMPLE_CONFIG_FILE);
const match = createTeamMatcher(config);
const where = (cwd: string) => {
  const m = match(cwd);
  return m && `${m.floor.floor}:${m.team.id}`;
};

test('층 배치: 1F가 기본, 1~5F + 옥상', () => {
  assert.equal(config.defaultFloor, 1);
  assert.deepEqual(config.floors.map(f => `${f.label} ${f.name}`),
    ['1F 쇼핑몰', '2F 사내 ERP', '3F 블로그', '4F 쇼핑몰 v2', '5F 연구소', '옥상 마이오피스 본사']);
});

test('폴더명이 같아도 전체 경로로 다른 층을 구분한다', () => {
  assert.equal(where('C:\\work\\shop\\backend'), '1:shop-be');
  assert.equal(where('C:\\work\\shop-v2\\backend'), '4:shop2-be');
});

test('하위 폴더, 대소문자, 슬래시, Git Bash 경로도 같은 팀', () => {
  assert.equal(where('c:\\work\\blog\\web\\src\\views'), '3:blog-fe');
  assert.equal(where('C:/work/blog/api/'), '3:blog-api');
  assert.equal(where('/c/work/shop/docs'), '1:shop-doc');
  assert.equal(where('D:\\projects\\lab'), '5:lab');
});

test('등록되지 않은 폴더, 이름만 비슷한 폴더는 무시', () => {
  assert.equal(where('C:\\Users\\User\\Desktop'), null);
  assert.equal(where('C:\\work\\blog\\web2'), null);
  assert.equal(where('C:\\work\\blog'), null);
});

test('normPath', () => {
  assert.equal(normPath('/d/projects/x/'), 'd:\\projects\\x');
  assert.equal(normPath('C:\\Dev\\MyLab\\'), 'c:\\dev\\mylab');
});

test('공통 금지 목록: 정규식이 모두 유효하고 의도대로 걸린다', () => {
  const hits = (cmd: string) => config.guard
    .filter(r => r.allOf.every(p => new RegExp(p, 'i').test(cmd)))
    .map(r => r.id);
  assert.deepEqual(hits('git push origin main'), ['git-push']);
  assert.deepEqual(hits('rm -rf node_modules'), ['recursive-delete']);
  assert.deepEqual(hits('Remove-Item .\\dist -Recurse -Force'), ['recursive-delete']);
  assert.deepEqual(hits(`py -c "import pymysql; c.execute('UPDATE t_user SET a=1'); c.commit()"`), ['db-write']);
  assert.deepEqual(hits('python .tooling/sql.py "SELECT * FROM t_user"'), []);
  assert.deepEqual(hits('mysql -u root -e "select 1"'), []);
  // 읽기는 통과: 쓰기처럼 보이는 컬럼명, 소수점 자르기 함수 TRUNCATE()
  assert.deepEqual(hits('mysql -e "SELECT update_dt, delete_yn FROM t_order"'), []);
  assert.deepEqual(hits('mysql -e "SELECT TRUNCATE(amt, 2) FROM t_order"'), []);
  assert.deepEqual(hits('mysql -e "TRUNCATE TABLE t_order"'), ['db-write']);
  assert.deepEqual(hits('mysql -e "truncate t_order"'), ['db-write']);
  assert.deepEqual(hits('py -c "from sql import load_dsn"'), ['db-dsn-bypass']);
  assert.deepEqual(hits('git status && rm -f a.txt'), []);
});

test('내 실제 설정이 있으면 예시와 같은 형식이어야 한다', () => {
  const mine = loadConfig();
  assert.ok(Array.isArray(mine.floors) && mine.floors.length > 0);
  assert.ok(mine.floors.every(f => f.teams.length <= 3), '한 층에 팀은 3개까지');
  assert.ok(mine.floors.some(f => f.floor === mine.defaultFloor));
});
