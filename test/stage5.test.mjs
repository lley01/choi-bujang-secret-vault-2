import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';

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

// ── 5단계 저장점 ──

const vercelEnv = {
  VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
  VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40), VERCEL_URL: 'defense-app-ghi789.vercel.app',
};
const appConfig = { ...config, publicAppUrl: 'https://student-defense.vercel.app/' };

async function withFetch(respond, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => { seen.push(`${init.method ?? 'GET'} ${new URL(String(url)).pathname}`); return respond(String(url)); };
  try { return { results: await run(), seen }; } finally { globalThis.fetch = original; }
}
const appDenied = (url) => (url.endsWith('/data.json') ? new Response('not found', { status: 404 })
  : new Response(JSON.stringify({ error: 'LOGIN_REQUIRED', message: '로그인이 필요합니다.' }), { status: 401, headers: { 'content-type': 'application/json' } }));

test('설정은 5단계이고, bundle.mjs의 5단계 규칙(originalApiUrl https)을 만족한다', () => {
  assert.equal(config.step, 5);
  assert.ok(config.originalApiUrl.startsWith('https://'));
});

test('배포 식별 정보는 5단계를 받아들이고 6단계는 거부한다', () => {
  assert.equal(deploymentIdentity(vercelEnv, config).step, 5);
  assert.throws(() => deploymentIdentity(vercelEnv, { ...config, step: 6 }), /배포 식별 정보를 확인할 수 없습니다/u);
});

test('5단계 자기 점검: 우리 앱의 401 JSON만 거부로 적고, 요청 6건만 보내며 토큰이 필요한 점검 3건은 미실행', async () => {
  const { results, seen } = await withFetch(appDenied, () => runAttackChecks(appConfig));
  assert.equal(seen.length, 6, '미실행 항목은 요청을 보내지 않는다');
  for (const item of results.slice(1, 6)) assert.match(item.observed, /거부됨 \(HTTP 401\)/u, item.attackId);
  assert.deepEqual(results.slice(-3).map((item) => item.attackId), ['normal_login_notes_read', 'other_owner_note_access', 'direct_db_rest_access']);
  for (const item of results.slice(-3)) assert.match(item.observed, /^미실행/u);
  assert.ok(results.length <= 20);
  for (const item of results) assert.ok(item.expected.length <= 300 && item.observed.length <= 300, item.attackId);
});

test('네트워크 프록시의 403이나 배포 보호 화면의 401은 앱의 거부로 적지 않고 판정 불가로 남긴다', async () => {
  const proxy = () => new Response('Host not in allowlist', { status: 403, headers: { 'content-type': 'text/plain', 'x-deny-reason': 'host_not_allowed' } });
  const vercelLogin = () => new Response('<!doctype html><title>Login – Vercel</title>', { status: 401, headers: { 'content-type': 'text/html' } });
  const otherJson = () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  for (const respond of [proxy, vercelLogin, otherJson]) {
    const { results } = await withFetch(respond, () => runAttackChecks(appConfig));
    for (const item of results.slice(0, 6)) {
      assert.match(item.observed, /판정 불가: 앱이 아닌 곳/u, item.attackId);
      assert.doesNotMatch(item.observed, /거부됨/u, item.attackId);
    }
  }
});

test('거부되지 않고 자료가 돌아오면 그대로 거부되지 않음으로 적고, 자료 내용은 결과에 넣지 않는다', async () => {
  const leak = () => new Response(JSON.stringify([{ id: 'x', title: 'a', body: '실습용 가상 본문' }]), { status: 200 });
  const { results } = await withFetch(leak, () => runAttackChecks(appConfig));
  for (const item of results.slice(1, 6)) assert.match(item.observed, /거부되지 않음/u, item.attackId);
  assert.ok(!JSON.stringify(results).includes('실습용 가상 본문'));
});
