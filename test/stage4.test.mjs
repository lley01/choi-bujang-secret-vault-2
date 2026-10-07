import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';

// 4단계 저장점: 설정이 4단계이고, 빌드·배포 식별·자기 점검이 4단계를 받아들이며, 소유자 검사 코드가 실제로 들어 있는지 봅니다.
const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
const vercelEnv = {
  VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
  VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40), VERCEL_URL: 'defense-app-def456.vercel.app',
};

test('설정은 4단계 이상이고 허용 경로는 실제 메모 API 다섯 경로 그대로다', () => {
  assert.ok(config.step >= 4, '4단계 이상');
  assert.deepEqual(config.allowedRoutes, ['GET /api/notes', 'POST /api/notes', 'GET /api/notes/:id', 'PUT /api/notes/:id', 'DELETE /api/notes/:id']);
  assert.ok(config.originalApiUrl === null || config.originalApiUrl.startsWith('https://'), '원본 API 주소는 비어 있거나 https 주소여야 합니다(5단계부터 필수)');
});

test('소유자 검사 코드가 실제로 들어 있다(패치 파일만 있고 적용되지 않은 상태가 아님)', () => {
  const service = readFileSync(new URL('../src/notes-service.mjs', import.meta.url), 'utf8');
  for (const pattern of [/\.eq\('id', id\)\.eq\('owner_id', me\)\.maybeSingle\(\)/u, /\.eq\('id', id\)\.eq\('owner_id', me\)\n\s*\.select\(/u,
    /\.delete\(\)\n\s*\.eq\('id', id\)\.eq\('owner_id', me\)/u, /owner_id: me \}\)/u]) {
    assert.match(service, pattern);
  }
});

test('배포 식별 정보는 4단계를 받아들이고 6단계 이상은 거부한다', () => {
  assert.equal(deploymentIdentity(vercelEnv, { ...config, step: 4 }).step, 4);
  assert.throws(() => deploymentIdentity(vercelEnv, { ...config, step: 6 }), /배포 식별 정보를 확인할 수 없습니다/u);
});

test('4단계 자기 점검은 거부 점검 6건을 실제 응답대로 기록하고, 두 사용자 토큰이 필요한 점검은 미실행으로 남긴다', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async (url) => {
      requests += 1;
      if (String(url).endsWith('/data.json')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 });
    };
    const results = await runAttackChecks({ ...config, step: 4, publicAppUrl: 'https://student-defense.vercel.app/' });
    assert.equal(requests, 6, '미실행 항목은 요청을 보내지 않는다');
    assert.deepEqual(results.slice(-2).map((item) => item.attackId), ['normal_login_notes_read', 'other_owner_note_access']);
    for (const item of results.slice(-2)) assert.match(item.observed, /^미실행/u);
    assert.ok(results.length <= 20);
    for (const item of results) assert.ok(item.expected.length <= 300 && item.observed.length <= 300);
    await assert.rejects(runAttackChecks({ ...config, step: 6, publicAppUrl: 'https://student-defense.vercel.app/' }), /이 단계의 공격 점검/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
