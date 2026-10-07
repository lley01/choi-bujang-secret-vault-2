import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createNotesHandler } from '../api/notes.js';
import { createLoginVerifier } from '../src/verify-login.mjs';

// 아래 키·토큰·주소는 모두 이 시험 안에서만 만든 가짜 값입니다. 실제 값을 넣지 마세요.
const FAKE_ENV = { SUPABASE_URL: 'https://dummy-project.example', SUPABASE_SECRET_KEY: 'dummy-server-key' };
const APP_HOST = 'test-app.vercel.app';
const JUDGE = 'https://aleph-judge-production.up.railway.app/defense/judge';
const STUDENT_ISSUER = 'https://dummy-project.supabase.co/auth/v1';
const loginConfig = {
  judgeIssuer: JUDGE,
  publicAppUrl: `https://${APP_HOST}/`,
  identityProvider: { issuer: STUDENT_ISSUER, audience: 'authenticated', jwksUrl: `${STUDENT_ISSUER}/.well-known/jwks.json` },
};

const { publicKey, privateKey } = await generateKeyPair('ES256');
const otherKeys = await generateKeyPair('ES256');
const judgeKeySet = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }] });
const now = () => Math.floor(Date.now() / 1000);

function judgeToken({ role = 'judge', identity = 'a', aud = APP_HOST, iss = JUDGE, iat = now(), exp = iat + 600, key = privateKey } = {}) {
  return new SignJWT({ aleph_run: crypto.randomUUID(), aleph_role: role, aleph_identity: identity })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(iss).setAudience(aud).setSubject(crypto.randomUUID())
    .setIssuedAt(iat).setExpirationTime(exp).sign(key);
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const studentToken = (extra = {}) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: STUDENT_ISSUER, ...extra })}.sig`;
const GOOD_STUDENT = studentToken({ sub: 'student-ok' });
const supabaseClient = {
  auth: {
    async getClaims(token) {
      if (token !== GOOD_STUDENT) return { data: null, error: { message: 'invalid' } };
      return { data: { claims: { iss: STUDENT_ISSUER, aud: 'authenticated', role: 'authenticated',
        sub: crypto.randomUUID(), exp: now() + 600 } }, error: null };
    },
  },
};

const NOTES = [
  { title: '과제', content: '실습용 가상 과제 기록', id: 'row-1', owner_id: 'owner-1' },
  { title: '포트폴리오', content: '실습용 가상 포트폴리오 기록', id: 'row-2', owner_id: null },
];

function fakeSupabase(calls) {
  return () => {
    calls.push('createClient');
    const query = { select: () => query, order: () => query, limit: () => Promise.resolve({ data: NOTES, error: null }) };
    return { from: () => { calls.push('from'); return query; } };
  };
}

function fakeResponse() {
  const out = { headers: new Map(), status: undefined, body: undefined };
  const response = {
    setHeader: (key, value) => out.headers.set(key.toLowerCase(), value),
    status: (value) => { out.status = value; return { json: (body) => { out.body = body; return out; } }; },
  };
  return { response, out };
}

async function withCapturedErrors(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { await run(); } finally { console.error = original; }
  return lines;
}

function makeHandler(calls = []) {
  return createNotesHandler({ env: FAKE_ENV, createSupabase: fakeSupabase(calls), loginConfig,
    loginOptions: { judgeKeySet, supabaseClient } });
}

async function call(handler, request) {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET', headers: {}, ...request }, response));
  return { out, logs };
}

function assertRejectedWithoutData(out, calls) {
  assert.equal(out.status, 401);
  assert.deepEqual(out.body, { error: 'LOGIN_REQUIRED' });
  assert.equal(out.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(calls, [], '거부된 요청은 Supabase 자료 조회까지 가면 안 됩니다');
  assert.ok(!JSON.stringify(out.body).includes('실습용 가상'));
}

test('정상 A 로그인(심판 토큰, 신원 a)은 자료를 받는다', async () => {
  const calls = [];
  const { out } = await call(makeHandler(calls), { headers: { authorization: `Bearer ${await judgeToken()}` } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { notes: [
    { title: '과제', content: '실습용 가상 과제 기록' },
    { title: '포트폴리오', content: '실습용 가상 포트폴리오 기록' },
  ] });
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.equal(out.headers.get('vary'), 'Authorization');
});

test('로그인한 학생(Supabase 토큰 검사 통과)도 자료를 받는다', async () => {
  const { out } = await call(makeHandler(), { headers: { authorization: `Bearer ${GOOD_STUDENT}` } });
  assert.equal(out.status, 200);
  assert.equal(out.body.notes.length, 2);
});

test('토큰이 없으면 자료 없이 401로 거부한다', async () => {
  const calls = [];
  const { out } = await call(makeHandler(calls), {});
  assertRejectedWithoutData(out, calls);
});

test('형식이 틀린 Authorization 헤더는 자료 없이 거부한다', async () => {
  for (const authorization of ['Basic dXNlcjpwdw==', 'Bearer', 'Bearer not-a-jwt', `bearer ${await judgeToken()}`, '']) {
    const calls = [];
    const { out } = await call(makeHandler(calls), { headers: { authorization } });
    assertRejectedWithoutData(out, calls);
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
    '학생 토큰 검사 실패': studentToken({ sub: 'someone-else' }),
  };
  for (const [name, token] of Object.entries(tokens)) {
    const calls = [];
    const { out } = await call(makeHandler(calls), { headers: { authorization: `Bearer ${token}` } });
    assert.equal(out.status, 401, `${name}은(는) 거부되어야 합니다`);
    assertRejectedWithoutData(out, calls);
  }
});

test('브라우저가 보낸 userId·role은 믿지 않는다', async () => {
  const spoof = { 'x-user-id': 'admin', 'x-role': 'admin', userid: 'admin', role: 'admin' };
  const calls = [];
  const denied = await call(makeHandler(calls), {
    headers: spoof, query: { userId: 'admin', role: 'admin' }, body: { userId: 'admin', role: 'admin' },
  });
  assertRejectedWithoutData(denied.out, calls);

  const allowed = await call(makeHandler(), {
    headers: { ...spoof, authorization: `Bearer ${await judgeToken()}` },
    query: { userId: 'someone-else', role: 'admin' }, body: { userId: 'someone-else', role: 'admin' },
  });
  assert.equal(allowed.out.status, 200);
  assert.equal(allowed.out.body.notes.length, 2);
});

test('검사기를 만들 수 없으면(설정 오류) 자료 없이 닫힌다', async () => {
  const calls = [];
  const brokenConfig = { ...loginConfig, publicAppUrl: 'https://replace-with-your-vercel-app.example' };
  const handler = createNotesHandler({ env: FAKE_ENV, createSupabase: fakeSupabase(calls), loginConfig: brokenConfig,
    loginOptions: { judgeKeySet, supabaseClient } });
  const { out, logs } = await call(handler, { headers: { authorization: `Bearer ${await judgeToken()}` } });
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: 'AUTH_UNAVAILABLE' });
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, ['NOTES_AUTH_UNAVAILABLE invalid_login_issuer']);
});

test('검사기가 예외를 던져도 자료 없이 닫히고 로그에 값이 남지 않는다', async () => {
  const calls = [];
  const handler = createNotesHandler({ env: FAKE_ENV, createSupabase: fakeSupabase(calls),
    verifyLogin: async () => { throw new Error(`boom ${FAKE_ENV.SUPABASE_SECRET_KEY}`); } });
  const { out, logs } = await call(handler, { headers: { authorization: 'Bearer a.b.c' } });
  assert.equal(out.status, 500);
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, ['NOTES_AUTH_UNAVAILABLE unknown']);
});

test('토큰과 서버 전용 키는 응답·로그에 나가지 않는다', async () => {
  const token = await judgeToken();
  const ok = await call(makeHandler(), { headers: { authorization: `Bearer ${token}` } });
  const denied = await call(makeHandler(), { headers: { authorization: 'Bearer aaa.bbb.ccc' } });
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
  assert.doesNotThrow(() => createLoginVerifier({ config, supabaseSecretKey: FAKE_ENV.SUPABASE_SECRET_KEY,
    judgeKeySet, supabaseClient }));
  assert.ok(!/sb_secret_|service_role|eyJ[A-Za-z0-9_-]{12,}/u.test(JSON.stringify(config)));
});
