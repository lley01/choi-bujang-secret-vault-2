import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotesService } from '../src/notes-service.mjs';
import { FAKE_ENV, createFakeStore, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeToken, loginConfig, loginOptions, studentToken } from './helpers/login-fixtures.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const A_ID = crypto.randomUUID();
const B_ID = crypto.randomUUID();
const withA = async () => ({ authorization: `Bearer ${await judgeToken({ sub: A_ID, identity: 'a' })}` });
const withB = async () => ({ authorization: `Bearer ${await judgeToken({ sub: B_ID, identity: 'b' })}` });

function setup(rows = []) {
  const store = createFakeStore(rows);
  const service = createNotesService({ env: FAKE_ENV, createSupabase: store.createSupabase, loginConfig, loginOptions });
  return { store, service };
}

async function send(handler, request) {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET', headers: {}, ...request }, response));
  return { ...out, logs };
}

const post = (service, headers, body) => send(service.collection, { method: 'POST', url: '/api/notes', headers, body });
const list = (service, headers) => send(service.collection, { method: 'GET', url: '/api/notes', headers });
const one = (service, method, id, headers, body) => send(service.item, { method, url: `/api/notes/${id}`, query: { id }, headers, body });

test('추가(POST): 서버가 확인한 사용자 ID를 owner_id로 저장하고 {id}를 돌려준다', async () => {
  const { store, service } = setup();
  const id = crypto.randomUUID();
  const out = await post(service, { ...(await withA()), 'x-user-id': B_ID, 'x-role': 'admin' },
    { id, title: '  첫 메모  ', body: '실습용 가상 본문', owner_id: B_ID, ownerId: B_ID, userId: B_ID, role: 'admin' });
  assert.equal(out.status, 201);
  assert.deepEqual(out.body, { id });
  assert.equal(store.rows.length, 1);
  assert.deepEqual(store.rows[0], { id, owner_id: A_ID, title: '첫 메모', content: '실습용 가상 본문', created_at: store.rows[0].created_at });
  assert.deepEqual(store.log.queries[0].payload, { id, owner_id: A_ID, title: '첫 메모', content: '실습용 가상 본문' });
  assert.equal(out.headers.get('cache-control'), 'no-store');
});

test('추가(POST): id가 없으면 서버가 UUID를 만들어 {id}로 돌려주고, 그 id로 한 건을 읽을 수 있다', async () => {
  const { service } = setup();
  const out = await post(service, await withA(), { title: '제목', body: '본문' });
  assert.equal(out.status, 201);
  assert.deepEqual(Object.keys(out.body), ['id']);
  assert.match(out.body.id, UUID);
  const got = await one(service, 'GET', out.body.id, await withA());
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, { id: out.body.id, title: '제목', body: '본문' });
});

test('추가(POST): 본문이 문자열 JSON이나 Buffer로 와도 읽는다', async () => {
  const { service } = setup();
  for (const body of [JSON.stringify({ title: '문자열', body: 'a' }), Buffer.from(JSON.stringify({ title: '버퍼', body: 'b' }))]) {
    const out = await post(service, await withA(), body);
    assert.equal(out.status, 201);
  }
});

test('목록(GET): 로그인한 사용자의 메모만 {id,title,body} 배열로, 만든 순서대로 돌려준다', async () => {
  const { service } = setup();
  const first = (await post(service, await withA(), { title: 'A-1', body: 'a1' })).body.id;
  const second = (await post(service, await withA(), { title: 'A-2', body: 'a2' })).body.id;
  const other = (await post(service, await withB(), { title: 'B-1', body: 'b1' })).body.id;
  const a = await list(service, await withA());
  assert.equal(a.status, 200);
  assert.ok(Array.isArray(a.body));
  assert.deepEqual(a.body, [{ id: first, title: 'A-1', body: 'a1' }, { id: second, title: 'A-2', body: 'a2' }]);
  assert.deepEqual((await list(service, await withB())).body, [{ id: other, title: 'B-1', body: 'b1' }]);
  const nobody = { authorization: `Bearer ${await judgeToken({ sub: crypto.randomUUID() })}` };
  assert.deepEqual((await list(service, nobody)).body, []);
});

test('목록(GET): owner_id가 비어 있는 옛 가상 메모는 누구의 목록에도 나오지 않는다', async () => {
  const { service } = setup([{ id: crypto.randomUUID(), owner_id: null, title: '옛 메모', content: '실습용 가상', created_at: 0 }]);
  assert.deepEqual((await list(service, await withA())).body, []);
});

test('수정(PUT): title·body만 바꾸고 owner_id는 그대로이며 {id,title,body}를 돌려준다', async () => {
  const { store, service } = setup();
  const { body: { id } } = await post(service, await withA(), { title: '옛 제목', body: '옛 본문' });
  const out = await one(service, 'PUT', id, await withA(), { title: '새 제목', body: '새 본문', owner_id: B_ID, userId: B_ID });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { id, title: '새 제목', body: '새 본문' });
  assert.equal(store.rows[0].owner_id, A_ID);
  assert.deepEqual(store.log.queries.at(-1).payload, { title: '새 제목', content: '새 본문' });
  assert.deepEqual((await one(service, 'GET', id, await withA())).body, { id, title: '새 제목', body: '새 본문' });
});

test('수정(PUT): 본문의 id가 경로의 id와 다르면 거부하고, 같으면 받는다', async () => {
  const { service } = setup();
  const { body: { id } } = await post(service, await withA(), { title: 't', body: 'b' });
  const bad = await one(service, 'PUT', id, await withA(), { id: crypto.randomUUID(), title: 'x', body: 'y' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'ID_MISMATCH');
  const same = await one(service, 'PUT', id.toUpperCase(), await withA(), { id, title: 'x', body: 'y' });
  assert.equal(same.status, 200);
});

test('삭제(DELETE): 204로 지우고, 지운 뒤 GET은 404이며 다시 지우거나 고쳐도 404다', async () => {
  const { store, service } = setup();
  const { body: { id } } = await post(service, await withA(), { title: '지울 메모', body: '곧 사라짐' });
  const removed = await one(service, 'DELETE', id, await withA());
  assert.equal(removed.status, 204);
  assert.equal(removed.ended, true);
  assert.equal(removed.body, undefined);
  assert.equal(store.rows.length, 0);
  const after = await one(service, 'GET', id, await withA());
  assert.equal(after.status, 404);
  assert.deepEqual(after.body, { error: 'NOT_FOUND' });
  assert.equal((await one(service, 'DELETE', id, await withA())).status, 404);
  assert.equal((await one(service, 'PUT', id, await withA(), { title: 'x', body: 'y' })).status, 404);
  assert.deepEqual((await list(service, await withA())).body, []);
});

test('로그인한 학생(Supabase 토큰)도 추가·수정·삭제할 수 있고 owner_id는 학생의 사용자 ID다', async () => {
  const { store, service } = setup();
  const studentId = crypto.randomUUID();
  const headers = { authorization: `Bearer ${studentToken(studentId)}` };
  const { body: { id } } = await post(service, headers, { title: '학생 메모', body: '내용' });
  assert.equal(store.rows[0].owner_id, studentId);
  assert.equal((await one(service, 'PUT', id, headers, { title: '고침', body: '내용2' })).status, 200);
  assert.equal((await one(service, 'DELETE', id, headers)).status, 204);
});

test('알려진 허점(4단계에서 고칠 것): 소유자 검사가 아직 없어 B가 A의 메모를 읽고 고치고 지울 수 있다', async () => {
  const { store, service } = setup();
  const { body: { id } } = await post(service, await withA(), { title: 'A의 메모', body: 'A만 봐야 함' });
  assert.deepEqual((await one(service, 'GET', id, await withB())).body, { id, title: 'A의 메모', body: 'A만 봐야 함' });
  const edited = await one(service, 'PUT', id, await withB(), { title: 'B가 고침', body: 'B가 쓴 내용' });
  assert.equal(edited.status, 200);
  assert.equal(store.rows[0].owner_id, A_ID, '고쳐도 소유자는 A로 남는다');
  assert.deepEqual((await list(service, await withA())).body, [{ id, title: 'B가 고침', body: 'B가 쓴 내용' }]);
  assert.deepEqual((await list(service, await withB())).body, [], 'B의 목록에는 나오지 않는다');
  assert.equal((await one(service, 'DELETE', id, await withB())).status, 204);
  assert.equal(store.rows.length, 0);
});

test('입력 검증: 잘못된 요청은 저장소에 닿기 전에 400으로 거부한다', async () => {
  const { store, service } = setup();
  const headers = await withA();
  const id = crypto.randomUUID();
  const cases = [
    ['JSON이 아닌 문자열', 'not json', 'INVALID_JSON'],
    ['배열 본문', [], 'INVALID_JSON'],
    ['본문 없음', undefined, 'INVALID_JSON'],
    ['title 없음', { body: 'b' }, 'INVALID_TITLE'],
    ['title이 공백뿐', { title: '   ', body: 'b' }, 'INVALID_TITLE'],
    ['title이 문자열이 아님', { title: 5, body: 'b' }, 'INVALID_TITLE'],
    ['title이 200자 초과', { title: 'x'.repeat(201), body: 'b' }, 'INVALID_TITLE'],
    ['body 없음', { title: 't' }, 'INVALID_NOTE_BODY'],
    ['body가 문자열이 아님', { title: 't', body: { a: 1 } }, 'INVALID_NOTE_BODY'],
    ['body가 5000자 초과', { title: 't', body: 'x'.repeat(5001) }, 'INVALID_NOTE_BODY'],
    ['id가 UUID가 아님', { id: 'abc', title: 't', body: 'b' }, 'INVALID_ID'],
    ['id가 숫자', { id: 7, title: 't', body: 'b' }, 'INVALID_ID'],
  ];
  for (const [name, body, error] of cases) {
    const out = await post(service, headers, body);
    assert.equal(out.status, 400, name);
    assert.equal(out.body.error, error, name);
    const put = await one(service, 'PUT', id, headers, body);
    if (!name.startsWith('id가')) { assert.equal(put.status, 400, `PUT ${name}`); assert.equal(put.body.error, error, `PUT ${name}`); }
  }
  for (const badId of ['abc', '123', 'not-a-uuid', `${id}x`, '00000000-0000-0000-0000-00000000000']) {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const out = await one(service, method, badId, headers, { title: 't', body: 'b' });
      assert.equal(out.status, 400, `${method} ${badId}`);
      assert.equal(out.body.error, 'INVALID_ID');
    }
  }
  assert.deepEqual(store.log.queries, [], '잘못된 요청은 저장소를 부르지 않는다');
});

test('추가(POST): 이미 있는 id는 409로 거부하고 기존 메모는 그대로 둔다', async () => {
  const { store, service } = setup();
  const id = crypto.randomUUID();
  await post(service, await withA(), { id, title: '원래', body: '원래 본문' });
  const dup = await post(service, await withB(), { id, title: '덮어쓰기', body: '시도' });
  assert.equal(dup.status, 409);
  assert.deepEqual(dup.body, { error: 'ID_EXISTS' });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0].title, '원래');
});

test('모든 경로·방법은 토큰이 없거나 엉터리면 자료·저장소에 닿기 전에 401로 거부한다', async () => {
  const seed = [{ id: crypto.randomUUID(), owner_id: A_ID, title: 't', content: 'c', created_at: 1 }];
  const id = seed[0].id;
  const attempts = [
    ['GET /api/notes', (s, h) => list(s, h)],
    ['POST /api/notes', (s, h) => post(s, h, { title: 't', body: 'b' })],
    ['GET /api/notes/:id', (s, h) => one(s, 'GET', id, h)],
    ['PUT /api/notes/:id', (s, h) => one(s, 'PUT', id, h, { title: 'x', body: 'y' })],
    ['DELETE /api/notes/:id', (s, h) => one(s, 'DELETE', id, h)],
  ];
  const headerSets = [{}, { authorization: 'Bearer aaa.bbb.ccc' }, { authorization: 'Basic dXNlcjpwdw==' },
    { authorization: `Bearer ${studentToken(A_ID, { register: false })}` },
    { 'x-user-id': A_ID, 'x-role': 'admin', userid: A_ID, role: 'admin' }];
  for (const [name, attempt] of attempts) {
    for (const headers of headerSets) {
      const { store, service } = setup(seed);
      const out = await attempt(service, headers);
      assert.equal(out.status, 401, name);
      assert.deepEqual(out.body, { error: 'LOGIN_REQUIRED' }, name);
      assert.equal(out.headers.get('www-authenticate'), 'Bearer');
      assert.deepEqual(store.log.queries, [], `${name}은 저장소를 부르면 안 된다`);
      assert.equal(store.log.clients.length, 0);
      assert.equal(store.rows.length, 1);
      assert.equal(store.rows[0].title, 't');
    }
  }
});

test('허용되지 않은 방법은 Allow 목록과 함께 405로 거부한다', async () => {
  const { service } = setup();
  for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const out = await send(service.collection, { method, headers: await withA() });
    assert.equal(out.status, 405);
    assert.equal(out.headers.get('allow'), 'GET, POST');
  }
  for (const method of ['POST', 'PATCH', 'HEAD']) {
    const out = await send(service.item, { method, url: `/api/notes/${crypto.randomUUID()}`, headers: await withA() });
    assert.equal(out.status, 405);
    assert.equal(out.headers.get('allow'), 'GET, PUT, DELETE');
  }
});

test('경로의 id는 주소에서 읽고, 주소를 알 수 없을 때만 query.id를 쓴다', async () => {
  const { service } = setup();
  const { body: { id } } = await post(service, await withA(), { title: '경로', body: '경로 본문' });
  const other = crypto.randomUUID();
  const viaUrl = await send(service.item, { url: `/api/notes/${id}?id=${other}`, query: { id: other }, headers: await withA() });
  assert.equal(viaUrl.status, 200);
  assert.equal(viaUrl.body.id, id);
  const viaQuery = await send(service.item, { query: { id }, headers: await withA() });
  assert.equal(viaQuery.status, 200);
  const none = await send(service.item, { headers: await withA() });
  assert.equal(none.status, 400);
});

test('저장소가 오류를 내면 오류 코드만 기록하고 500으로 답하며 키·토큰은 나가지 않는다', async () => {
  const failing = () => {
    const query = new Proxy({}, {
      get: (_target, prop) => (prop === 'then'
        ? (resolve) => resolve({ data: null, error: { code: '42501', message: `permission denied ${FAKE_ENV.SUPABASE_SECRET_KEY}` } })
        : () => query),
    });
    return { from: () => query };
  };
  const service = createNotesService({ env: FAKE_ENV, createSupabase: failing, loginConfig, loginOptions });
  const headers = await withA();
  const id = crypto.randomUUID();
  const outs = [
    await list(service, headers), await post(service, headers, { title: 't', body: 'b' }),
    await one(service, 'GET', id, headers), await one(service, 'PUT', id, headers, { title: 't', body: 'b' }),
    await one(service, 'DELETE', id, headers),
  ];
  for (const out of outs) {
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: 'NOTES_UNAVAILABLE' });
    const seen = JSON.stringify([out.body, [...out.headers], out.logs]);
    assert.ok(!seen.includes(FAKE_ENV.SUPABASE_SECRET_KEY));
    assert.ok(!seen.includes(headers.authorization.slice(7)));
    assert.match(out.logs.join('\n'), /^NOTES_[A-Z]+_FAILED 42501$/u);
  }
});

test('환경변수가 없으면 500으로 닫히고, 검사기를 만들 수 없어도 저장소를 부르지 않는다', async () => {
  const store = createFakeStore();
  const noEnv = createNotesService({ env: {}, createSupabase: store.createSupabase, loginConfig, loginOptions });
  assert.equal((await list(noEnv, await withA())).status, 500);
  const broken = createNotesService({ env: FAKE_ENV, createSupabase: store.createSupabase,
    loginConfig: { ...loginConfig, publicAppUrl: 'https://replace-with-your-vercel-app.example' }, loginOptions });
  const out = await post(broken, await withA(), { title: 't', body: 'b' });
  assert.equal(out.status, 500);
  assert.deepEqual(out.body, { error: 'AUTH_UNAVAILABLE' });
  assert.deepEqual(store.log.queries, []);
});

test('Supabase 클라이언트를 만들다 예외가 나도 JSON 500으로 닫히고 메시지는 기록하지 않는다', async () => {
  const service = createNotesService({ env: FAKE_ENV, loginConfig, loginOptions,
    createSupabase: () => { throw new Error(`bad url ${FAKE_ENV.SUPABASE_SECRET_KEY}`); } });
  const headers = await withA();
  const id = crypto.randomUUID();
  const outs = [await list(service, headers), await post(service, headers, { title: 't', body: 'b' }),
    await one(service, 'GET', id, headers), await one(service, 'PUT', id, headers, { title: 't', body: 'b' }),
    await one(service, 'DELETE', id, headers)];
  for (const out of outs) {
    assert.equal(out.status, 500);
    assert.deepEqual(out.body, { error: 'NOTES_UNAVAILABLE' });
    assert.deepEqual(out.logs, ['NOTES_CLIENT_FAILED']);
    assert.ok(!JSON.stringify([out.body, out.logs]).includes(FAKE_ENV.SUPABASE_SECRET_KEY));
  }
});
