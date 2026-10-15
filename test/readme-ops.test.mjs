import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// README의 「운영 안내: 설치·실행·중지·복구」가 실제 저장소와 맞는지 봅니다. 문서 검사이며 배포·심판 확인이 아닙니다.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readme = read('README.md');
const start = readme.indexOf('## 운영 안내: 설치·실행·중지·복구');
const end = readme.indexOf('\n## ', start + 1);
const guide = start >= 0 ? readme.slice(start, end) : '';
const scripts = JSON.parse(read('package.json')).scripts;

test('운영 안내: 네 구성 요소마다 설치·실행·중지·복구가 있음', () => {
  assert.ok(guide, '운영 안내 절이 없음');
  const parts = guide.split(/\n### \d\. /u).slice(1);
  assert.equal(parts.length, 4);
  for (const [index, name] of ['학생 판정기', '탐지 규칙', '접속 앱', '자료실'].entries()) {
    assert.ok(parts[index].startsWith(name), name);
    for (const label of ['설치', '실행', '중지', '복구']) assert.match(parts[index], new RegExp(`\\| ${label} \\|`, 'u'), `${name} ${label}`);
  }
});

test('운영 안내: 엔진 출처(ALEPH SDP 엔진)와 미실행을 밝힘', () => {
  assert.match(guide, /\*\*ALEPH SDP 엔진\*\*/u);
  assert.match(guide, /엔진 코드를 포함하지 않으며/u);
  assert.match(guide, /docs\/DECIDER_REQUEST\.md/u);
  assert.match(guide, /미실행/u);
  assert.ok(existsSync(new URL('../docs/DECIDER_REQUEST.md', import.meta.url)));
  assert.ok(existsSync(new URL('../docs/DETECT_EVENTS.md', import.meta.url)));
});

test('운영 안내: 적힌 npm 명령은 모두 package.json에 있고 git reset --hard 를 권하지 않음', () => {
  const named = [...guide.matchAll(/npm run ([a-z0-9:-]+)/gu)].map((match) => match[1]);
  assert.ok(named.length >= 8);
  for (const name of new Set(named)) assert.ok(scripts[name], `없는 명령: npm run ${name}`);
  assert.match(guide, /`git reset --hard`는 쓰지 않습니다/u);
  assert.doesNotMatch(guide.replace(/`git reset --hard`는 쓰지 않습니다/u, ''), /reset --hard/u);
});

test('운영 안내: 비밀값을 담지 않고, 커밋 제외 파일이 실제로 .gitignore에 있음', () => {
  const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{12,}\.|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
  assert.doesNotMatch(guide, secret);
  const ignore = read('.gitignore');
  for (const entry of ['.env', '.env.*', 'bundle-notes.json', 'artifacts/', 'matrix-evidence.json']) {
    assert.ok(ignore.split(/\r?\n/u).includes(entry), entry);
  }
});
