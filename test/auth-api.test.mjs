import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthService } from '../src/auth-service.mjs';
import { createNotesService } from '../src/notes-service.mjs';
import { FAKE_ENV, createFakeStore, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeToken, loginConfig, loginOptions } from './helpers/login-fixtures.mjs';

// 아래 값은 모두 시험용 가짜 값입니다. 실제 키·토큰·비밀번호를 넣지 마세요.
const ACCESS = 'access.token.fake1';
const REFRESH = 'refreshfake1';
const PASSWORD = 'pw-for-test-only';
const HOST = 'app.example.vercel.app';

function fakeSupabaseAuth({ signIn, getUser, refresh, signOut } = {}) {
  const calls = { clients: [], signIn: [], getUser: [], refresh: [], signOut: [] };
  const createSupabase = (url, key, options) => {
    calls.clients.push({ url, key, options });
    return { auth: {
      signInWithPassword: async (input) => { calls.signIn.push(input); return signIn ? signIn(input) : {
        data: { session: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }, user: { email: input.email } }, error: null }; },
      getUser: async (jwt) => { calls.getUser.push(jwt); return getUser ? getUser(jwt) : (jwt === ACCESS
        ? { data: { user: { email: 'a@example.com' } }, error: null } : { data: { user: null }, error: { status: 401, code: 'bad_jwt' } }); },
      refreshSession: async (input) => { calls.refresh.push(input); return refresh ? refresh(input) : (input.refresh_token === REFRESH
        ? { data: { session: { access_token: 'access.token.fake2', refresh_token: 'refreshfake2', expires_in: 3600 }, user: { email: 'a@example.com' } }, error: null }
        : { data: { session: null, user: null }, error: { status: 400, code: 'refresh_token_not_found' } }); },
      admin: { signOut: async (jwt, scope) => { calls.signOut.push({ jwt, scope }); return signOut ? signOut() : { data: null, error: null }; } },
    } };
  };
  return { createSupabase, calls };
}

async function call(handler, request) {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ headers: { host: HOST }, ...request, headers: { host: HOST, ...request.headers } }, response));
  return { ...out, logs };
}
const loginRequest = (body, headers = {}) => ({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json', ...headers }, body });

test('로그인: 서버 전용 설정으로 Supabase Auth를 부르고, 토큰은 HttpOnly·Secure·SameSite=Strict 쿠키로만 주며 본문에는 이메일만 담는다', async () => {
  const { createSupabase, calls } = fakeSupabaseAuth();
  const auth = createAuthService({ env: FAKE_ENV, createSupabase });
  const out = await call(auth.route, loginRequest({ email: ' a@example.com ', password: PASSWORD }));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { email: 'a@example.com' });
  assert.equal(calls.clients[0].url, FAKE_ENV.SUPABASE_URL);
  assert.equal(calls.clients[0].key, FAKE_ENV.SUPABASE_SECRET_KEY);
  assert.deepEqual(calls.signIn, [{ email: 'a@example.com', password: PASSWORD }]);
  const cookies = out.headers.get('set-cookie');
  assert.equal(cookies.length, 2);
  assert.match(cookies[0], /^aleph_at=access\.token\.fake1; Path=\/api; Max-Age=3600; HttpOnly; Secure; SameSite=Strict$/u);
  assert.match(cookies[1], /^aleph_rt=refreshfake1; Path=\/api\/auth; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/u);
  assert.equal(out.headers.get('cache-control'), 'no-store');
  const seen = JSON.stringify([out.body, out.logs]);
  for (const secret of [ACCESS, REFRESH, PASSWORD, FAKE_ENV.SUPABASE_SECRET_KEY]) assert.ok(!seen.includes(secret), secret);
});

test('로그인 실패는 이유(message)와 오류 코드를 돌려주고 쿠키를 주지 않으며, 이메일·비밀번호는 기록하지 않는다', async () => {
  const cases = [
    [{ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' }, 401, /이메일 또는 비밀번호가 맞지 않습니다/u],
    [{ status: 400, code: 'email_not_confirmed' }, 401, /이메일 인증이 아직/u],
    [{ status: 429, code: 'over_request_rate_limit' }, 429, /요청이 너무 많습니다/u],
    [{ status: 400, code: 'weird_code' }, 401, /로그인에 실패했습니다/u],
    [{ name: 'AuthRetryableFetchError', status: 0 }, 502, /연결하지 못했습니다/u],
  ];
  for (const [error, status, reason] of cases) {
    const { createSupabase } = fakeSupabaseAuth({ signIn: () => ({ data: { session: null, user: null }, error }) });
    const out = await call(createAuthService({ env: FAKE_ENV, createSupabase }).route, loginRequest({ email: 'a@example.com', password: PASSWORD }));
    assert.equal(out.status, status, error.code);
    assert.match(out.body.message, reason);
    if (status === 401 || status === 429) assert.equal(out.body.code, error.code);
    assert.equal(out.headers.get('set-cookie'), undefined);
    assert.ok(!JSON.stringify(out.logs).includes('a@example.com') && !JSON.stringify(out.logs).includes(PASSWORD));
  }
});

test('로그인 요청은 JSON·같은 사이트·올바른 형식만 받고, 아니면 Supabase를 부르지 않는다', async () => {
  const { createSupabase, calls } = fakeSupabaseAuth();
  const auth = createAuthService({ env: FAKE_ENV, createSupabase });
  const bad = [
    [loginRequest({ email: 'a@example.com', password: PASSWORD }, { 'content-type': 'application/x-www-form-urlencoded' }), 415],
    [loginRequest({ email: 'a@example.com', password: PASSWORD }, { origin: 'https://evil.example' }), 403],
    [loginRequest({ email: 'a@example.com', password: PASSWORD }, { origin: 'null' }), 403],
    [loginRequest({ email: 'no-at-sign', password: PASSWORD }), 400],
    [loginRequest({ email: 'a@example.com', password: '' }), 400],
    [loginRequest('not json'), 400],
    [{ method: 'GET', url: '/api/auth/login', headers: {} }, 405],
  ];
  for (const [request, status] of bad) assert.equal((await call(auth.route, request)).status, status, JSON.stringify(request.headers));
  assert.equal(calls.signIn.length, 0);
  const sameSite = await call(auth.route, loginRequest({ email: 'a@example.com', password: PASSWORD }, { origin: `https://${HOST}` }));
  assert.equal(sameSite.status, 200);
});

test('세션 확인: 유효한 쿠키면 이메일, 만료되면 갱신 쿠키로 새로 발급, 둘 다 안 되면 401과 쿠키 삭제', async () => {
  const { createSupabase, calls } = fakeSupabaseAuth();
  const auth = createAuthService({ env: FAKE_ENV, createSupabase });
  const ok = await call(auth.route, { method: 'GET', url: '/api/auth/session', headers: { cookie: `x=1; aleph_at=${ACCESS}; aleph_rt=${REFRESH}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { email: 'a@example.com' });
  assert.equal(ok.headers.get('set-cookie'), undefined);

  const renewed = await call(auth.route, { method: 'GET', url: '/api/auth/session', headers: { cookie: `aleph_at=expired.token.x; aleph_rt=${REFRESH}` } });
  assert.equal(renewed.status, 200);
  assert.deepEqual(calls.refresh.at(-1), { refresh_token: REFRESH });
  assert.match(renewed.headers.get('set-cookie')[0], /^aleph_at=access\.token\.fake2;/u);
  assert.ok(!JSON.stringify(renewed.body).includes('fake2'));

  const gone = await call(auth.route, { method: 'GET', url: '/api/auth/session', headers: { cookie: 'aleph_at=expired.token.x; aleph_rt=unknown' } });
  assert.equal(gone.status, 401);
  assert.equal(gone.body.error, 'LOGIN_REQUIRED');
  for (const cookie of gone.headers.get('set-cookie')) assert.match(cookie, /^aleph_(?:at|rt)=; .*Max-Age=0/u);

  const before = calls.clients.length;
  const none = await call(auth.route, { method: 'GET', url: '/api/auth/session', headers: {} });
  assert.equal(none.status, 401);
  assert.equal(calls.clients.length, before, '쿠키가 없으면 Supabase를 부르지 않는다');
  assert.deepEqual(none.logs, [], '로그인하지 않은 방문자의 확인 요청은 로그를 남기지 않는다');
});

test('로그아웃: 서버에서 이 세션을 끊고(local) 쿠키를 지운다. 서버 호출이 실패해도 쿠키는 지운다', async () => {
  const { createSupabase, calls } = fakeSupabaseAuth();
  const out = await call(createAuthService({ env: FAKE_ENV, createSupabase }).route, { method: 'POST', url: '/api/auth/logout', headers: { cookie: `aleph_at=${ACCESS}` } });
  assert.equal(out.status, 204);
  assert.deepEqual(calls.signOut, [{ jwt: ACCESS, scope: 'local' }]);
  for (const cookie of out.headers.get('set-cookie')) assert.match(cookie, /Max-Age=0; HttpOnly; Secure; SameSite=Strict$/u);

  const failing = fakeSupabaseAuth({ signOut: () => { throw new Error(ACCESS); } });
  const out2 = await call(createAuthService({ env: FAKE_ENV, createSupabase: failing.createSupabase }).route, { method: 'POST', url: '/api/auth/logout', headers: { cookie: `aleph_at=${ACCESS}` } });
  assert.equal(out2.status, 204);
  assert.equal(out2.headers.get('set-cookie').length, 2);
  assert.ok(!JSON.stringify(out2.logs).includes(ACCESS));
  const cross = await call(createAuthService({ env: FAKE_ENV, createSupabase }).route, { method: 'POST', url: '/api/auth/logout', headers: { origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('서버 설정이 없으면 500, 없는 경로는 404', async () => {
  const auth = createAuthService({ env: {}, createSupabase: () => { throw new Error('must not be called'); } });
  assert.equal((await call(auth.route, loginRequest({ email: 'a@example.com', password: PASSWORD }))).status, 500);
  assert.equal((await call(auth.route, { method: 'GET', url: '/api/auth/whoami', headers: {} })).status, 404);
});

test('쿠키에 이상한 글자가 섞이면 토큰으로 쓰지 않는다', async () => {
  const { createSupabase, calls } = fakeSupabaseAuth();
  const out = await call(createAuthService({ env: FAKE_ENV, createSupabase }).route, { method: 'GET', url: '/api/auth/session', headers: { cookie: 'aleph_at=a b"c' } });
  assert.equal(out.status, 401);
  assert.equal(calls.getUser.length, 0);
});

// ── 메모 API: 화면 로그인의 쿠키 토큰 ──
const A_ID = crypto.randomUUID();
function notes() {
  const store = createFakeStore([{ id: crypto.randomUUID(), owner_id: A_ID, title: 'A의 메모', content: '실습용 가상', created_at: 1 }]);
  return { store, service: createNotesService({ env: FAKE_ENV, createSupabase: store.createSupabase, loginConfig, loginOptions }) };
}

test('메모 API: Authorization 헤더가 없으면 HttpOnly 쿠키의 토큰을 같은 검사기로 검사해 본인 메모를 준다', async () => {
  const { service } = notes();
  const token = await judgeToken({ sub: A_ID });
  const out = await call(service.collection, { method: 'GET', url: '/api/notes', headers: { cookie: `aleph_at=${token}` } });
  assert.equal(out.status, 200);
  assert.equal(out.body.length, 1);
});

test('메모 API: 헤더가 있으면 헤더만 검사하고(틀리면 401), 쿠키의 토큰이 틀리거나 없으면 401', async () => {
  const token = await judgeToken({ sub: A_ID });
  for (const headers of [{ authorization: 'Bearer aaa.bbb.ccc', cookie: `aleph_at=${token}` }, { cookie: 'aleph_at=aaa.bbb.ccc' },
    { cookie: `other=${token}` }, { cookie: 'aleph_at=' }]) {
    const { store, service } = notes();
    const out = await call(service.collection, { method: 'GET', url: '/api/notes', headers });
    assert.equal(out.status, 401, JSON.stringify(Object.keys(headers)));
    assert.deepEqual(store.log.queries, []);
  }
});
