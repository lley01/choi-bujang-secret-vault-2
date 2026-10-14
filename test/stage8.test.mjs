import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createNotesService } from '../src/notes-service.mjs';
import { RULE_IDS, decide } from '../src/decider.mjs';
import { DENY, checkAccess, readStoredRole } from '../src/access-check.mjs';
import { fixtureRequests } from '../scripts/fixture-7.mjs';
import { RESOURCES, RESOURCE_HEADER, resourceOf } from '../src/resources.mjs';
import { FAKE_ENV, createFakeStore, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeToken, loginConfig, loginOptions } from './helpers/login-fixtures.mjs';

// 8단계 자원 ID. 가짜 저장소와 가상 로그인으로 시험합니다. 심판 판정이 아닙니다.
const A_ID = crypto.randomUUID();
const withA = async () => ({ authorization: `Bearer ${await judgeToken({ sub: A_ID, identity: 'a' })}` });
const header = RESOURCE_HEADER.toLowerCase();

function setup(rows = [], env = FAKE_ENV) {
  const store = createFakeStore(rows);
  return { store, service: createNotesService({ env, createSupabase: store.createSupabase, loginConfig, loginOptions }) };
}
async function send(handler, request) {
  const { response, out } = fakeResponse();
  await withCapturedErrors(() => handler({ method: 'GET', headers: {}, ...request }, response));
  return out;
}

test('메모와 강사 공지는 서로 다른 자원 ID를 가진다', () => {
  assert.deepEqual({ ...RESOURCES }, { NOTE: 'vault.note', NOTICE: 'class.notice' });
  assert.notEqual(RESOURCES.NOTE, RESOURCES.NOTICE);
  assert.ok(Object.isFrozen(RESOURCES));
  assert.equal(RESOURCE_HEADER, 'X-Resource-Id');
});

test('서버는 요청 경로로 자원을 구별하고, 쿼리나 비슷한 경로에 속지 않는다', () => {
  const cases = [
    ['/api/notes', 'vault.note'], ['/api/notes/', 'vault.note'], [`/api/notes/${A_ID}`, 'vault.note'],
    ['/api/notes?resource=class.notice', 'vault.note'], ['/api/notices', 'class.notice'], ['/api/notices/n1', 'class.notice'],
    ['/api/notices?resource=vault.note', 'class.notice'], ['/api/notes/a/b', null], ['/api/notesx', null], ['/api/noticesx', null],
    ['/api/auth/login', null], ['/', null], ['api/notes', null], ['https://evil.example/api/notes', null], [undefined, null],
  ];
  for (const [url, expected] of cases) assert.equal(resourceOf(url), expected, String(url));
});

test('메모 API는 성공·거부를 가리지 않고 모든 응답에 서버가 정한 자원 ID(vault.note)를 붙인다', async () => {
  const id = crypto.randomUUID();
  const a = await withA();
  const attempts = [
    ['목록 200', (s) => send(s.collection, { url: '/api/notes', headers: a }), 200],
    ['추가 201', (s) => send(s.collection, { method: 'POST', url: '/api/notes', headers: a, body: { title: '가상', body: '가상 본문' } }), 201],
    ['조회 200', (s) => send(s.item, { url: `/api/notes/${id}`, query: { id }, headers: a }), 200],
    ['수정 200', (s) => send(s.item, { method: 'PUT', url: `/api/notes/${id}`, query: { id }, headers: a, body: { title: '새 제목', body: '' } }), 200],
    ['삭제 204', (s) => send(s.item, { method: 'DELETE', url: `/api/notes/${id}`, query: { id }, headers: a }), 204],
    ['없는 메모 404', (s) => send(s.item, { url: `/api/notes/${crypto.randomUUID()}`, headers: a }), 404],
    ['잘못된 id 400', (s) => send(s.item, { url: '/api/notes/zzz', query: { id: 'zzz' }, headers: a }), 400],
    ['로그인 없음 401', (s) => send(s.collection, { url: '/api/notes' }), 401],
    ['로그인 없음 401(한 건)', (s) => send(s.item, { url: `/api/notes/${id}`, query: { id } }), 401],
    ['허용 안 된 방법 405', (s) => send(s.collection, { method: 'PATCH', url: '/api/notes', headers: a }), 405],
  ];
  for (const [name, attempt, status] of attempts) {
    const { service } = setup([{ id, owner_id: A_ID, title: '가상 메모', content: '실습용 가상 본문', created_at: 0 }]);
    const out = await attempt(service);
    assert.equal(out.status, status, name);
    assert.equal(out.headers.get(header), 'vault.note', name);
  }
  const { service } = setup([], {});
  const broken = await send(service.collection, { url: '/api/notes', headers: a });
  assert.equal(broken.status, 500);
  assert.equal(broken.headers.get(header), 'vault.note', '설정 오류 500에도 자원 ID');
});

test('브라우저가 보낸 자원 ID 헤더·쿼리·본문 값은 서버의 자원 ID를 바꾸지 못한다', async () => {
  const a = await withA();
  const { service } = setup();
  for (const request of [
    { url: '/api/notes', headers: { ...a, 'x-resource-id': 'class.notice' } },
    { url: '/api/notes?resource=class.notice', query: { resource: 'class.notice' }, headers: a },
    { method: 'POST', url: '/api/notes', headers: a, body: { title: '가상', body: '가상', resource: 'class.notice', resourceId: 'class.notice' } },
  ]) {
    const out = await send(service.collection, request);
    assert.ok([200, 201].includes(out.status));
    assert.equal(out.headers.get(header), 'vault.note');
    assert.ok(!JSON.stringify(out.body ?? '').includes('class.notice'));
  }
});

test('기존 자료와 API 주소는 그대로다: 응답 본문 모양·메모 행이 바뀌지 않고, 허용 경로의 메모 경로는 vault.note다', async () => {
  const id = crypto.randomUUID();
  const row = { id, owner_id: A_ID, title: '가상 메모', content: '실습용 가상 본문', created_at: 0 };
  const { store, service } = setup([row]);
  const out = await send(service.collection, { url: '/api/notes', headers: await withA() });
  assert.deepEqual(out.body, [{ id, title: '가상 메모', body: '실습용 가상 본문' }], '응답 본문에는 자원 ID를 넣지 않음');
  assert.deepEqual(store.rows, [row]);
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.allowedRoutes, ['GET /api/notes/:id', 'PUT /api/notes/:id', 'DELETE /api/notes/:id', 'GET /api/notices', 'GET /api/notices/:id']);
  for (const route of config.allowedRoutes.filter((item) => item.includes('/api/notes'))) {
    assert.equal(resourceOf(route.split(' ')[1].replace(':id', id)), 'vault.note', route);
  }
});

// 8단계 판정기 구역 규칙(resource_zone). 계약 모양의 가상 요청으로 시험합니다. 심판 판정이 아닙니다.
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const req = (service, method, path, route = `${method} ${path}`, extra = {}) => ({
  ...fixtureRequests().normal, requestId: crypto.randomUUID(), service, method, path, route, ...extra });
const verdict = async (request) => { const r = await decide(request); return `${r.decision} ${r.reasonCode} ${r.ruleIds.join(',')}`; };
const OK = 'allow approved device_registered,resource_zone';
const NO = 'deny route_not_allowed resource_zone';

test('RULE_IDS에 resource_zone을 더했고 이전 규칙은 그대로다', () => {
  assert.deepEqual([...RULE_IDS], ['starter.deny', 'device_registered', 'step_up_required', 'resource_zone']);
});

test('메모: 자료 ID 하나를 고르는 GET·PUT·DELETE만 허용하고, ID 없는 목록·추가는 거부한다', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal(await verdict(req('notes', method, '/notes/demo', `${method} /notes/:id`)), OK, method);
    assert.equal(await verdict(req('notes', method, `/api/notes/${A_ID}`, `${method} /api/notes/:id`)), OK, `${method} /api`);
  }
  for (const [method, path, route] of [['GET', '/notes', 'GET /notes'], ['POST', '/notes', 'POST /notes'], ['GET', '/api/notes', 'GET /api/notes'],
    ['POST', '/notes/demo', 'POST /notes/:id'], ['PATCH', '/notes/demo', 'PATCH /notes/:id'], ['HEAD', '/notes/demo', 'HEAD /notes/:id'],
    ['GET', '/notes/', 'GET /notes/:id'], ['GET', '/notes/demo/', 'GET /notes/:id'], ['GET', '/notes/a/b', 'GET /notes/:id'],
    ['GET', '/notes/demo/export', 'GET /notes/:id/export'], ['GET', '/notes/..', 'GET /notes/:id'], ['GET', '/notes/a%2Fb', 'GET /notes/:id']]) {
    assert.equal(await verdict(req('notes', method, path, route)), NO, `${method} ${path}`);
  }
});

test('메모 ID 형식은 좁히지 않는다: UUID가 아닌 가상 ID도 한 칸이면 허용(주인 비교는 메모 API가 함)', async () => {
  for (const id of ['demo', 'note-1', 'SAMPLE_NOTE_1', '42', A_ID, 'export', '한글']) {
    assert.equal(await verdict(req('notes', 'GET', `/notes/${id}`, 'GET /notes/:id')), OK, id);
  }
  const source = readFileSync(new URL('../src/decider.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /owner|request\.subjectId|\[0-9a-f\]\{8\}/u, '판정기는 주인 비교나 UUID 검사를 하지 않음');
});

test('반 공지: 읽기(GET)만 허용하고, 쓰기는 누구에게나 notice_read_only로 거부한다', async () => {
  assert.equal(await verdict(req('notices', 'GET', '/notices')), OK);
  assert.equal(await verdict(req('notices', 'GET', '/notices/n1', 'GET /notices/:id')), OK);
  assert.equal(await verdict(req('notices', 'GET', '/api/notices/n1', 'GET /api/notices/:id')), OK);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const [path, route] of [['/notices', `${method} /notices`], ['/notices/n1', `${method} /notices/:id`], ['/api/notices/n1', `${method} /api/notices/:id`]]) {
      assert.equal(await verdict(req('notices', method, path, route)), 'deny notice_read_only resource_zone', `${method} ${path}`);
      assert.equal(await verdict(req('notes', method, path, route)), 'deny notice_read_only resource_zone', `서비스 이름을 바꿔도 ${method} ${path}`);
    }
  }
  assert.equal(await verdict(req('notices', 'GET', '/notices/n1/edit', 'GET /notices/:id/edit')), NO);
});

test('강사 자료: 판정기에서 모두 거부한다', async () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const [service, path] of [['materials', '/materials'], ['materials', '/materials/m1'], ['notes', '/materials/m1'], ['materials', '/api/materials/m1']]) {
      assert.equal(await verdict(req(service, method, path, `${method} ${path}`)), 'deny instructor_materials_denied resource_zone', `${service} ${method} ${path}`);
    }
  }
});

test('알 수 없는 경로·서비스와 경로 불일치·쿼리로 기능 고르기는 거부한다', async () => {
  for (const request of [
    req('notes', 'GET', '/', 'GET /'), req('auth', 'POST', '/api/auth/login'), req('admin', 'GET', '/admin'), req('notes', 'GET', '/notesx/demo', 'GET /notesx/:id'),
    req('notices', 'GET', '/notes/demo', 'GET /notes/:id'), req('notes', 'GET', '/notices/n1', 'GET /notices/:id'),
    req('notes', 'GET', '/notes/demo', 'GET /notes/demo'), req('notes', 'GET', '/notes/demo', 'GET /api/notes/:id'), req('notes', 'GET', '/notes/demo', 'PUT /notes/:id'),
    req('notes', 'GET', '/notes/demo', 'GET /notes/:id', { queryLength: 11, querySha256: 'a'.repeat(64) }),
    req('notes', 'GET', '/notes/demo', 'GET /notes/:id', { queryLength: 0, querySha256: 'a'.repeat(64) }),
    req('notices', 'GET', '/notices', 'GET /notices', { queryLength: 6 }),
    req(undefined, undefined, undefined, undefined),
  ]) {
    assert.equal(await verdict(request), NO, JSON.stringify([request.service, request.method, request.path, request.route, request.queryLength]));
  }
  assert.equal(req('notes', 'GET', '/notes/demo', 'GET /notes/:id').querySha256, EMPTY_SHA);
});

test('이전 규칙 유지: 미등록 기기는 어느 구역이든 먼저 거부하고, 허용 구역의 복합 이상은 추가 확인한다', async () => {
  for (const [service, method, path, route] of [['notes', 'GET', '/notes/demo', 'GET /notes/:id'], ['notices', 'POST', '/notices', 'POST /notices'], ['materials', 'GET', '/materials', 'GET /materials']]) {
    assert.equal(await verdict(req(service, method, path, route, { deviceRegistered: false })), 'deny device_not_registered device_registered');
  }
  const { suspicious } = fixtureRequests();
  assert.equal(await verdict({ ...suspicious, service: 'notices', path: '/notices/n1', route: 'GET /notices/:id' }), 'step_up step_up_required step_up_required');
  assert.equal(await verdict({ ...suspicious, service: 'materials', path: '/materials', route: 'GET /materials' }), 'deny instructor_materials_denied resource_zone', '구역 거부가 추가 확인보다 먼저');
  assert.equal((await decide(null)).decision, 'deny');
});

test('allowedRoutes에는 판정기가 허용하는 경로만 메서드를 붙여 적었다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  for (const route of config.allowedRoutes) {
    assert.match(route, /^(GET|PUT|DELETE) \/api\/[a-z]+(\/:id)?$/u, route);
    const [method, shape] = route.split(' ');
    const service = shape.split('/')[2];
    assert.equal(await verdict(req(service, method, shape.replace(':id', 'demo'), route)), OK, route);
  }
  for (const route of ['GET /api/notes', 'POST /api/notes', 'POST /api/notices', 'GET /api/materials', 'POST /api/auth/login']) {
    assert.ok(!config.allowedRoutes.includes(route), `판정기가 거부하는 ${route}는 허용 경로에 없음`);
  }
});

// 8단계 제작 3: 자료 API의 권한 다시 대조(src/access-check.mjs). 가짜 저장소로 시험합니다. 심판 판정이 아닙니다.
const B_ID = crypto.randomUUID();
const capture = async (handler, request) => {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET', headers: {}, ...request }, response));
  return { ...out, logs };
};
// DB가 owner_id 조건을 무시하고 남의 행까지 돌려주는 상황(정책 실수·질의 실수)을 흉내 냅니다.
const leakyClient = (rows) => () => {
  const query = new Proxy({}, { get: (_t, prop) => (prop === 'then' ? (resolve) => resolve({ data: rows.single ?? rows.list, error: null }) : () => query) });
  return { from: () => query };
};
const withLeak = (rows) => createNotesService({ env: FAKE_ENV, createSupabase: leakyClient(rows), loginConfig, loginOptions });

test('권한 대조: 메모는 저장된 주인 본인만, 강사라도 남의 메모는 안 된다', () => {
  const note = (ownerId, storedRole) => checkAccess({ resource: 'vault.note', action: 'read', userId: A_ID, ownerId, storedRole });
  assert.deepEqual(note(A_ID), { allowed: true });
  assert.deepEqual(note(A_ID.toUpperCase()), { allowed: true });
  assert.deepEqual(note(B_ID), { allowed: false, reason: DENY.NOT_OWNER });
  assert.deepEqual(note(B_ID, 'instructor'), { allowed: false, reason: 'not_owner' }, '강사 예외 없음');
  for (const ownerId of [null, undefined, '']) assert.deepEqual(note(ownerId), { allowed: false, reason: 'owner_missing' });
  for (const userId of [undefined, '', 'a', 'admin']) {
    assert.deepEqual(checkAccess({ resource: 'vault.note', action: 'read', userId, ownerId: userId }), { allowed: false, reason: 'no_verified_user' });
  }
});

test('권한 대조: 반 공지 쓰기와 강사 자료는 저장된 강사 권한이 있을 때만, 모르는 자원은 거부', () => {
  const as = (resource, action, storedRole) => checkAccess({ resource, action, userId: A_ID, storedRole });
  assert.deepEqual(as('class.notice', 'read'), { allowed: true });
  assert.deepEqual(as('class.notice', 'write'), { allowed: false, reason: 'not_instructor' });
  assert.deepEqual(as('class.notice', 'write', 'instructor'), { allowed: true });
  assert.deepEqual(as('instructor.material', 'read'), { allowed: false, reason: 'not_instructor' });
  assert.deepEqual(as('instructor.material', 'read', 'instructor'), { allowed: true });
  for (const role of ['Instructor', 'admin', 'teacher', true, ['instructor']]) assert.equal(as('class.notice', 'write', role).allowed, false, String(role));
  assert.deepEqual(as('class.notice', 'export', 'instructor'), { allowed: false, reason: 'unknown_resource' });
  assert.deepEqual(as('vault.admin', 'read', 'instructor'), { allowed: false, reason: 'unknown_resource' });
});

test('저장된 강사 권한은 서버 전용 키로 app_metadata에서만 읽고, user_metadata·실패·다른 사용자는 강사가 아니다', async () => {
  const admin = (user, error = null) => ({ auth: { admin: { getUserById: async () => ({ data: { user }, error }) } } });
  assert.equal(await readStoredRole(admin({ id: A_ID, app_metadata: { class_role: 'instructor' } }), A_ID), 'instructor');
  assert.equal(await readStoredRole(admin({ id: A_ID, app_metadata: {}, user_metadata: { class_role: 'instructor', role: 'instructor' } }), A_ID), null);
  assert.equal(await readStoredRole(admin({ id: B_ID, app_metadata: { class_role: 'instructor' } }), A_ID), null);
  assert.equal(await readStoredRole(admin(null, { code: 'user_not_found' }), A_ID), null);
  assert.equal(await readStoredRole({ auth: { admin: { getUserById: async () => { throw new Error('down'); } } } }, A_ID), null);
  assert.equal(await readStoredRole({}, A_ID), null);
  assert.equal(await readStoredRole(admin({ id: A_ID, app_metadata: { class_role: 'instructor' } }), 'judge-sub'), null);
});

test('메모 API: DB가 남의 행을 돌려줘도 저장된 소유자를 다시 대조해 숨기고, 짧은 사유만 남긴다', async () => {
  const mine = { id: crypto.randomUUID(), title: '내 메모', content: '내 본문', owner_id: A_ID };
  const other = { id: crypto.randomUUID(), title: '남의 메모', content: '남의 본문', owner_id: B_ID };
  const list = await capture(withLeak({ list: [mine, other] }).collection, { url: '/api/notes', headers: await withA() });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, [{ id: mine.id, title: '내 메모', body: '내 본문' }]);
  assert.deepEqual(list.logs, ['NOTES_ACCESS_DENIED {"method":"GET","route":"collection","reason":"not_owner"}']);

  const one = await capture(withLeak({ single: other }).item, { url: `/api/notes/${other.id}`, query: { id: other.id }, headers: await withA() });
  assert.equal(one.status, 404);
  assert.deepEqual(one.body, { error: 'NOT_FOUND' }, '남의 메모가 있다는 사실도 알리지 않음');
  assert.deepEqual(one.logs, ['NOTES_ACCESS_DENIED {"method":"GET","route":"item","reason":"not_owner"}']);

  const del = await capture(withLeak({ list: [other] }).item, { method: 'DELETE', url: `/api/notes/${other.id}`, query: { id: other.id }, headers: await withA() });
  assert.equal(del.status, 500);
  assert.deepEqual(del.logs, ['NOTES_OWNER_MISMATCH']);
  for (const out of [list, one, del]) {
    const seen = JSON.stringify([out.body, out.logs]);
    for (const secret of [B_ID, A_ID, '남의 본문', 'Bearer']) assert.ok(!seen.includes(secret), `로그·응답에 ${secret} 없음`);
  }
});

test('메모 API: 화면 메뉴·요청 본문·헤더·쿼리의 role은 믿지 않는다', async () => {
  const other = { id: crypto.randomUUID(), owner_id: B_ID, title: 'B의 메모', content: 'B 본문', created_at: 0 };
  const { store, service } = setup([other]);
  const role = { role: 'instructor', class_role: 'instructor', isInstructor: true };
  const headers = { ...(await withA()), 'x-role': 'instructor', 'x-class-role': 'instructor', 'x-menu': 'instructor' };
  const tries = [
    await capture(service.item, { url: `/api/notes/${other.id}?role=instructor`, query: { id: other.id, role: 'instructor' }, headers }),
    await capture(service.item, { method: 'PUT', url: `/api/notes/${other.id}`, query: { id: other.id }, headers, body: { title: '강사가 고침', body: 'x', ...role } }),
    await capture(service.item, { method: 'DELETE', url: `/api/notes/${other.id}`, query: { id: other.id }, headers, body: role }),
  ];
  for (const out of tries) {
    assert.equal(out.status, 404);
    assert.deepEqual(out.logs, [`NOTES_ACCESS_DENIED {"method":"${out === tries[0] ? 'GET' : out === tries[1] ? 'PUT' : 'DELETE'}","route":"item","reason":"not_found_or_not_owner"}`]);
  }
  assert.deepEqual(store.rows, [other], 'B의 메모는 그대로');
  const created = await capture(service.collection, { method: 'POST', url: '/api/notes', headers, body: { title: '새 메모', body: 'x', owner_id: B_ID, ...role } });
  assert.equal(created.status, 201);
  assert.equal(store.rows.at(-1).owner_id, A_ID, '주인은 검증된 사용자');
  assert.ok(!('role' in store.rows.at(-1)) && !('class_role' in store.rows.at(-1)));
});

test('정상 요청(본인 메모 목록·조회)은 거부 로그를 남기지 않는다', async () => {
  const mine = { id: crypto.randomUUID(), owner_id: A_ID, title: '내 메모', content: '본문', created_at: 0 };
  const { service } = setup([mine]);
  assert.deepEqual((await capture(service.collection, { url: '/api/notes', headers: await withA() })).logs, []);
  const one = await capture(service.item, { url: `/api/notes/${mine.id}`, query: { id: mine.id }, headers: await withA() });
  assert.equal(one.status, 200);
  assert.deepEqual(one.logs, []);
});
