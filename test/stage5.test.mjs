import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// 5단계 제작: 자료 요청을 서버 한곳(/api/notes)으로 모읍니다.
const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('originalApiUrl은 쿼리 없는 원본 자료 HTTPS 경로이고, 배포 주소와 같은 호스트의 /api/notes다', () => {
  assert.equal(typeof config.originalApiUrl, 'string');
  assert.ok(config.originalApiUrl.startsWith('https://'), 'scripts/bundle.mjs의 5단계 규칙');
  const original = new URL(config.originalApiUrl);
  const app = new URL(config.publicAppUrl);
  assert.equal(original.search, '', '쿼리가 없어야 합니다');
  assert.equal(original.hash, '');
  assert.equal(original.username + original.password, '');
  assert.equal(original.host, app.host, '배포 주소와 같은 호스트');
  assert.equal(original.pathname, '/api/notes');
  assert.ok(!config.originalApiUrl.endsWith('/'), '끝에 / 가 붙지 않은 그대로의 경로');
  assert.ok(config.allowedRoutes.includes('GET /api/notes') && config.allowedRoutes.includes('POST /api/notes'));
});

test('브라우저 코드는 메모 자료를 Supabase에서 직접 읽거나 고치지 않고 서버 함수만 부른다(로그인 호출은 예외)', () => {
  for (const direct of [/\.from\(/u, /rest\/v1/u, /\.rpc\(/u, /\.storage\b/u, /\.channel\(/u, /realtime/iu]) {
    assert.doesNotMatch(page, direct, `화면 코드에 ${direct}가 있으면 안 됩니다`);
  }
  const clientCalls = [...page.matchAll(/\bclient\.([a-zA-Z]+)/gu)].map((m) => m[1]);
  assert.ok(clientCalls.length > 0);
  assert.deepEqual([...new Set(clientCalls)], ['auth'], 'Supabase 클라이언트는 로그인(auth)에만 씁니다');
  const fetchTargets = [...page.matchAll(/callApi\('[A-Z]+', [`']([^`']+)[`']/gu)].map((m) => m[1].replace(/\$\{[^}]+\}/u, ':id'));
  assert.deepEqual([...new Set(fetchTargets)].sort(), ['/api/notes', '/api/notes/:id']);
});
