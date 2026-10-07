import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNotesService } from '../src/notes-service.mjs';
import { createLoginVerifier } from '../src/verify-login.mjs';
import { FAKE_ENV, createFakeStore, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeKeySet, judgeToken, loginConfig, loginOptions, now, otherKeys, studentToken, supabaseClient } from './helpers/login-fixtures.mjs';

// 이 파일은 로그인 토큰 검사(시작 틀의 src/verify-login.mjs)가 메모 API 앞에서 제대로 일하는지 봅니다.
// 메모를 추가·수정·삭제하는 동작은 test/notes-crud.test.mjs 가 봅니다.
const A_ID = crypto.randomUUID();
const OWN = { id: crypto.randomUUID(), owner_id: A_ID, title: '내 메모', content: '실습용 가상 본문', created_at: 1 };
const OTHER = { id: crypto.randomUUID(), owner_id: crypto.randomUUID(), title: '남의 메모', content: '실습용 가상 본문', created_at: 2 };

function setup(extra = {}) {
  const store = createFakeStore([OWN, OTHER]);
  const service = createNotesService({ env: FAKE_ENV, createSupabase: store.createSupabase, loginConfig, loginOptions, ...extra });
  return { store, service };
}

async function call(handler, request) {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET', headers: {}, url: '/api/notes', ...request }, response));
  return { out, logs };
}

function assertRejectedWithoutData(out, store) {
  assert.equal(out.status, 401);
  assert.deepEqual(Object.keys(out.body), ['error', 'message']);
  assert.equal(out.body.error, 'LOGIN_REQUIRED');
  assert.match(out.body.message, /로그인이 필요합니다/u);
  assert.equal(out.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(store.log.queries, [], '거부된 요청은 Supabase 자료 조회까지 가면 안 됩니다');
  assert.ok(!JSON.stringify(out.body).includes('실습용 가상'));
}

test('정상 A 로그인(심판 토큰, 신원 a)은 자신의 메모를 받는다', async () => {
  const { service } = setup();
  const token = await judgeToken({ sub: A_ID, identity: 'a' });
  const { out } = await call(service.collection, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, [{ id: OWN.id, title: '내 메모', body: '실습용 가상 본문' }]);
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.equal(out.headers.get('vary'), 'Authorization');
});

test('로그인한 학생(Supabase 토큰 검사 통과)도 자신의 메모를 받는다', async () => {
  const { service } = setup();
  const { out } = await call(service.collection, { headers: { authorization: `Bearer ${studentToken(A_ID)}` } });
  assert.equal(out.status, 200);
  assert.equal(out.body.length, 1);
  assert.equal(out.body[0].id, OWN.id);
});

test('토큰이 없으면 자료 없이 401로 거부한다', async () => {
  const { store, service } = setup();
  const { out } = await call(service.collection, {});
  assertRejectedWithoutData(out, store);
});

test('형식이 틀린 Authorization 헤더는 자료 없이 거부한다', async () => {
  for (const authorization of ['Basic dXNlcjpwdw==', 'Bearer', 'Bearer not-a-jwt', `bearer ${await judgeToken()}`, '']) {
    const { store, service } = setup();
    const { out } = await call(service.collection, { headers: { authorization } });
    assertRejectedWithoutData(out, store);
  }
});

test('검사에 실패하는 토큰(위조 서명·만료·다른 대상·가짜 역할·너무 긴 수명·학생 검사 실패)은 모두 거부한다', async () => {
  const stale = now() - 3600;
  const tokens = {
    '다른 키로 서명한 위조': await judgeToken({ key: otherKeys.privateKey }),
    '만료': await judgeToken({ iat: stale, exp: stale + 600 }),
    '다른 배포 주소 대상': await judgeToken({ aud: 'other-app.vercel.app' }),
    '심판이 아닌 역할': await judgeToken({ role: 'admin' }),
    '알 수 없는 신원': await judgeToken({ identity: 'c' }),
    '수명이 15분을 넘는 토큰': await judgeToken({ exp: now() + 3600 }),
    '다른 발급자': await judgeToken({ iss: 'https://evil.example/defense/judge' }),
    '학생 토큰 검사 실패': studentToken(crypto.randomUUID(), { register: false }),
  };
  for (const [name, token] of Object.entries(tokens)) {
    const { store, service } = setup();
    const { out } = await call(service.collection, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(out.status, 401, `${name}은(는) 거부되어야 합니다`);
    assertRejectedWithoutData(out, store);
  }
});

test('브라우저가 보낸 userId·role은 믿지 않는다', async () => {
  const spoof = { 'x-user-id': OTHER.owner_id, 'x-role': 'admin', userid: OTHER.owner_id, role: 'admin' };
  const denied = setup();
  const noToken = await call(denied.service.collection, { headers: spoof, query: { userId: OTHER.owner_id, role: 'admin' } });
  assertRejectedWithoutData(noToken.out, denied.store);

  const allowed = setup();
  const token = await judgeToken({ sub: A_ID });
  const { out } = await call(allowed.service.collection, {
    headers: { ...spoof, authorization: `Bearer ${token}` }, query: { userId: OTHER.owner_id, role: 'admin' },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.map((note) => note.id), [OWN.id], '목록은 토큰이 확인해 준 사용자 것이어야 한다');
  assert.deepEqual(allowed.store.log.queries[0].filters, [['owner_id', A_ID]]);
});

test('검사기를 만들 수 없으면(설정 오류) 자료 없이 닫힌다', async () => {
  const store = createFakeStore([OWN]);
  const broken = { ...loginConfig, publicAppUrl: 'https://replace-with-your-vercel-app.example' };
  const service = createNotesService({ env: FAKE_ENV, createSupabase: store.createSupabase, loginConfig: broken, loginOptions });
  const { out, logs } = await call(service.collection, { headers: { authorization: `Bearer ${await judgeToken()}` } });
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: 'AUTH_UNAVAILABLE' });
  assert.deepEqual(store.log.queries, []);
  assert.deepEqual(logs, ['NOTES_AUTH_UNAVAILABLE invalid_login_issuer']);
});

test('검사기가 예외를 던져도 자료 없이 닫히고 로그에 값이 남지 않는다', async () => {
  const { store, service } = setup({ verifyLogin: async () => { throw new Error(`boom ${FAKE_ENV.SUPABASE_SECRET_KEY}`); } });
  const { out, logs } = await call(service.collection, { headers: { authorization: 'Bearer a.b.c' } });
  assert.equal(out.status, 500);
  assert.deepEqual(store.log.queries, []);
  assert.deepEqual(logs, ['NOTES_AUTH_UNAVAILABLE unknown']);
});

test('토큰과 서버 전용 키는 응답·로그에 나가지 않는다', async () => {
  const token = await judgeToken({ sub: A_ID });
  const ok = await call(setup().service.collection, { headers: { authorization: `Bearer ${token}` } });
  const denied = await call(setup().service.collection, { headers: { authorization: 'Bearer aaa.bbb.ccc' } });
  for (const { out, logs } of [ok, denied]) {
    const seen = JSON.stringify([out.body, [...out.headers], logs]);
    assert.ok(!seen.includes(token));
    assert.ok(!seen.includes('aaa.bbb.ccc'));
    assert.ok(!seen.includes(FAKE_ENV.SUPABASE_SECRET_KEY));
  }
});

test('저장소의 identityProvider는 도우미 검증을 통과하고 비밀값을 담지 않는다', () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const provider = config.identityProvider;
  assert.deepEqual(Object.keys(provider).sort(), ['audience', 'issuer', 'jwksUrl']);
  assert.match(provider.issuer, /^https:\/\/[a-z0-9]+\.supabase\.co\/auth\/v1$/u);
  assert.equal(provider.jwksUrl, `${provider.issuer}/.well-known/jwks.json`);
  assert.equal(provider.audience, 'authenticated');
  assert.doesNotThrow(() => createLoginVerifier({ config, supabaseSecretKey: FAKE_ENV.SUPABASE_SECRET_KEY, judgeKeySet, supabaseClient }));
  assert.ok(!/sb_secret_|service_role|eyJ[A-Za-z0-9_-]{12,}/u.test(JSON.stringify(config)));
});

test('allowedRoutes는 실제로 있는 GET·POST·PUT·DELETE 경로와 정확히 같다', () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.allowedRoutes, [
    'GET /api/notes', 'POST /api/notes', 'GET /api/notes/:id', 'PUT /api/notes/:id', 'DELETE /api/notes/:id',
  ]);
  for (const file of ['../api/notes.js', '../api/notes/[id].js']) {
    assert.ok(readFileSync(new URL(file, import.meta.url), 'utf8').length > 0, `${file}가 있어야 합니다`);
  }
});
