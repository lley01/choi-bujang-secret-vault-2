import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';

// 3단계 저장점: aleph.config.json이 3단계 구현과 맞고, 빌드·식별·자기 점검이 3단계를 받아들이는지 봅니다.
const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
const vercelEnv = {
  VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
  VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), VERCEL_URL: 'defense-app-abc123.vercel.app',
};

test('설정은 3단계 이상이고 bundle.mjs가 3단계부터 요구하는 발급자 정보와 허용 경로를 갖춘다', () => {
  assert.ok(config.step >= 3, '3단계 이상');
  for (const key of ['issuer', 'audience', 'jwksUrl']) assert.ok(config.identityProvider?.[key]?.trim(), `identityProvider.${key}`);
  assert.ok(Array.isArray(config.allowedRoutes) && config.allowedRoutes.length > 0);
  assert.match(config.repoUrl, /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u, 'repoUrl은 실제 GitHub 저장소 주소여야 합니다(자리표시자 금지)');
  assert.match(config.publicAppUrl, /^https:\/\/[a-z0-9.-]+\.vercel\.app\/$/u);
  assert.match(config.judgeIssuer, /^https:\/\/[a-z0-9-]+\.up\.railway\.app\/defense\/judge$/u);
  assert.ok(config.originalApiUrl === null || config.originalApiUrl.startsWith('https://'), '원본 API 주소는 비어 있거나 https 주소여야 합니다(5단계부터 필수)');
});

test('로그인 발급자 정보는 학습 DB와 같은 Supabase 프로젝트를 가리킨다', () => {
  // 화면 코드에는 Supabase 주소가 없습니다(로그인은 서버 함수). 원본 자료 주소(5단계부터)와 같은 프로젝트인지 봅니다.
  const projectUrl = /^(https:\/\/[a-z0-9]+\.supabase\.co)\/auth\/v1$/u.exec(config.identityProvider.issuer)?.[1];
  assert.ok(projectUrl);
  if (config.originalApiUrl) assert.equal(new URL(config.originalApiUrl).origin, projectUrl);
  assert.equal(config.identityProvider.issuer, `${projectUrl}/auth/v1`);
  assert.equal(config.identityProvider.jwksUrl, `${projectUrl}/auth/v1/.well-known/jwks.json`);
});

test('배포 식별 정보는 1~3단계를 받아들이고 엉뚱한 값은 거부한다(4단계는 test/stage4.test.mjs)', () => {
  for (const step of [1, 2, 3]) {
    assert.equal(deploymentIdentity(vercelEnv, { ...config, step }).step, step);
  }
  for (const step of [0, 6, '3', undefined]) {
    assert.throws(() => deploymentIdentity(vercelEnv, { ...config, step }), /배포 식별 정보를 확인할 수 없습니다/u);
  }
});

test('3단계 자기 점검은 거부 점검을 실제 응답대로 기록하고 정상 로그인 점검은 미실행으로 남긴다', async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      requested.push(`${init.method ?? 'GET'} ${new URL(String(url)).pathname.replace(/[0-9a-f-]{36}/u, ':id')}`);
      if (String(url).endsWith('/data.json')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 });
    };
    const results = await runAttackChecks({ ...config, step: 3, publicAppUrl: 'https://student-defense.vercel.app/' });
    assert.equal(requested.length, 6, '미실행 항목은 요청을 보내지 않는다');
    assert.deepEqual(results.map((item) => item.attackId), ['anonymous_note_read', 'anonymous_notes_api_read', 'forged_token_notes_api_read',
      'anonymous_note_create', 'anonymous_note_update', 'anonymous_note_delete', 'normal_login_notes_read']);
    for (const result of results.slice(1, 6)) assert.match(result.observed, /거부됨 \(HTTP 401\)/u);
    assert.match(results[6].observed, /^미실행/u);
    assert.ok(results.length <= 20);
    for (const result of results) {
      assert.deepEqual(Object.keys(result).sort(), ['attackId', 'expected', 'observed']);
      assert.ok(result.expected.length <= 300 && result.observed.length <= 300);
      assert.match(result.attackId, /^[a-z0-9][a-z0-9_.-]{0,79}$/iu);
    }
    await assert.rejects(runAttackChecks({ ...config, step: 6, publicAppUrl: 'https://student-defense.vercel.app/' }), /이 단계의 공격 점검/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('src/decider.mjs의 RULE_IDS에는 시작 틀의 기본 거부 규칙 하나만 있고 지어낸 규칙 이름이 없다', async () => {
  const { RULE_IDS } = await import('../src/decider.mjs');
  assert.deepEqual([...RULE_IDS], ['starter.deny']);
});
