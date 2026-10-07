import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNotesService } from '../src/notes-service.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';
import { FAKE_ENV, createFakeStore, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';

// 이 파일은 자료 조회 경로만 봅니다. 로그인 토큰 검사는 test/login-api.test.mjs, 추가·수정·삭제는 test/notes-crud.test.mjs 가 봅니다.
const USER_ID = '00000000-0000-4000-8000-000000000001';
const loggedIn = async () => ({ kind: 'student', userId: USER_ID });

async function call(handler, request) {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET', headers: {}, ...request }, response));
  return { out, logs };
}

test('/api/notes는 GET·POST만 받고 캐시하지 않는다', async () => {
  const service = createNotesService({ env: FAKE_ENV, createSupabase: createFakeStore().createSupabase, verifyLogin: loggedIn });
  const { out } = await call(service.collection, { method: 'PATCH' });
  assert.equal(out.status, 405);
  assert.equal(out.headers.get('allow'), 'GET, POST');
  assert.equal(out.headers.get('cache-control'), 'no-store');
});

test('/api/notes는 환경변수가 없으면 키 값 없이 500으로 거절한다', async () => {
  for (const env of [{}, { SUPABASE_URL: FAKE_ENV.SUPABASE_URL }, { SUPABASE_SECRET_KEY: FAKE_ENV.SUPABASE_SECRET_KEY }]) {
    let called = false;
    const service = createNotesService({ env, createSupabase: () => { called = true; }, verifyLogin: loggedIn });
    const { out, logs } = await call(service.collection, {});
    assert.equal(out.status, 500);
    assert.equal(out.body.error, 'SERVER_NOT_CONFIGURED');
    assert.equal(called, false);
    assert.ok(!JSON.stringify([out.body, logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
  }
});

test('/api/notes 목록은 id·title·body만 돌려주고 키를 응답·로그에 넣지 않는다', async () => {
  const store = createFakeStore([
    { id: crypto.randomUUID(), owner_id: USER_ID, title: '과제', content: '실습용 가상 과제 기록', created_at: 1 },
    { id: crypto.randomUUID(), owner_id: USER_ID, title: '포트폴리오', content: '실습용 가상 포트폴리오 기록', created_at: 2 },
  ]);
  const service = createNotesService({ env: FAKE_ENV, createSupabase: store.createSupabase, verifyLogin: loggedIn });
  const { out, logs } = await call(service.collection, {});
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.map(({ title, body }) => ({ title, body })), [
    { title: '과제', body: '실습용 가상 과제 기록' },
    { title: '포트폴리오', body: '실습용 가상 포트폴리오 기록' },
  ]);
  for (const note of out.body) assert.deepEqual(Object.keys(note).sort(), ['body', 'id', 'title']);
  assert.equal(out.headers.get('cache-control'), 'no-store');
  assert.deepEqual(store.log.clients[0].options.auth, { persistSession: false, autoRefreshToken: false });
  assert.equal(store.log.clients[0].key, FAKE_ENV.SUPABASE_SECRET_KEY);
  assert.deepEqual(store.log.queries[0].filters, [['owner_id', USER_ID]]);
  assert.ok(!JSON.stringify([out.body, [...out.headers], logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
});

test('/api/notes는 Supabase 오류 때 오류 코드만 기록하고 500으로 답한다', async () => {
  const error = { code: '42501', message: `permission denied for ${FAKE_ENV.SUPABASE_SECRET_KEY}` };
  const failing = () => {
    const query = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? (resolve) => resolve({ data: null, error }) : () => query) });
    return { from: () => query };
  };
  for (const createSupabase of [failing, () => { throw new Error(FAKE_ENV.SUPABASE_SECRET_KEY); }]) {
    const service = createNotesService({ env: FAKE_ENV, createSupabase, verifyLogin: loggedIn });
    const { out, logs } = await call(service.collection, {});
    assert.equal(out.status, 500);
    assert.equal(out.body.error, 'NOTES_UNAVAILABLE');
    assert.ok(!JSON.stringify([out.body, logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
  }
});

test('공개 data.json에는 메모가 남지 않는다', () => {
  assert.equal(existsSync(new URL('../public/data.json', import.meta.url)), false);
  const source = JSON.parse(readFileSync(new URL('../data.json', import.meta.url), 'utf8'));
  assert.deepEqual(source.notes, []);
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(page, /\/api\/notes/u);
  assert.doesNotMatch(page, /fetch\('\/data\.json'/u);
});

test('자기 점검은 /data.json 제거와 /api/notes의 토큰 거부를 실제 응답대로 기록한다', async () => {
  const config = { step: 2, sampleMarker: 'SAMPLE_NOTE_1', publicAppUrl: 'https://student-defense.vercel.app' };
  const originalFetch = globalThis.fetch;
  const requested = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      requested.push({ url: String(url), method: init.method ?? 'GET', authorization: init.headers?.Authorization });
      if (String(url).endsWith('/data.json')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 });
    };
    const results = await runAttackChecks(config);
    assert.deepEqual(requested.map((item) => `${item.method} ${new URL(item.url).pathname.replace(/[0-9a-f-]{36}/u, ':id')}`), [
      'GET /data.json', 'GET /api/notes', 'GET /api/notes', 'POST /api/notes', 'PUT /api/notes/:id', 'DELETE /api/notes/:id',
    ]);
    assert.deepEqual(requested.map((item) => item.authorization), [undefined, undefined, 'Bearer aaaaaaaa.bbbbbbbb.cccccccc', undefined, undefined, undefined]);
    assert.deepEqual(results.map((item) => item.attackId), ['anonymous_note_read', 'anonymous_notes_api_read', 'forged_token_notes_api_read',
      'anonymous_note_create', 'anonymous_note_update', 'anonymous_note_delete']);
    assert.match(results[0].observed, /보이지 않음 \(HTTP 404\)/u);
    for (const result of results.slice(1)) assert.match(result.observed, /거부됨 \(HTTP 401\)/u);
    for (const result of results) assert.ok(result.expected.length <= 300 && result.observed.length <= 300);

    // 거부하지 않는 서버: 목록이 배열로 오든 { notes } 로 오든, 쓰기가 받아들여지든 모두 "거부되지 않음"으로 기록한다.
    for (const body of [[{ id: 'x', title: 'a', body: '실습용 가상 본문' }], { notes: [{ title: 'a', content: '실습용 가상 본문' }] }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      const leaked = await runAttackChecks(config);
      assert.match(leaked[0].observed, /아직 보임/u);
      for (const result of leaked.slice(1, 3)) assert.match(result.observed, /거부되지 않음/u);
      for (const result of leaked.slice(3)) assert.match(result.observed, /거부되지 않음 \(HTTP 200\)/u);
      assert.ok(!JSON.stringify(leaked).includes('실습용 가상 본문'));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
