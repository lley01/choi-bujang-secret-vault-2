import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { createOpsService } from '../src/ops-service.mjs';
import { RULE_IDS } from '../src/decider.mjs';
import { APPROVED_DEVICE, FAKE_ENV, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeToken, loginConfig, loginOptions, studentToken } from './helpers/login-fixtures.mjs';

// 12단계 탈환 작전실 요약(GET /api/ops). 가짜 DB로 시험합니다. 심판 판정이 아닙니다.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = JSON.parse(read('aleph.config.json'));
const ME = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const SECRET_TITLE = '비밀 제목 TITLE-XYZ';
const SECRET_BODY = '비밀 본문 BODY-XYZ';

// 작전실이 읽는 세 테이블과 메모 테이블을 흉내 냅니다. 쓰기 요청이 오면 기록해 읽기 전용인지 봅니다.
function fakeDb({ missing = [] } = {}) {
  const tables = {
    notes: [{ id: 'n1', owner_id: ME, title: SECRET_TITLE, content: SECRET_BODY }],
    user_devices: [{ owner_id: ME, status: 'approved' }, { owner_id: ME, status: 'pending' }, { owner_id: ME, status: 'revoked' }, { owner_id: OTHER, status: 'approved' }],
    notes_backup: [{ id: 'note-b1', owner_id: ME, title: SECRET_TITLE, content: SECRET_BODY, content_sha256: 'ab'.repeat(32), backed_up_at: '2026-10-14T07:11:56Z' },
      { id: 'note-other', owner_id: OTHER, title: 'x', content: 'y', content_sha256: 'cd'.repeat(32), backed_up_at: '2026-10-14T07:00:00Z' }],
    notes_restore_audit: [{ note_id: 'note-b1', owner_id: ME, outcome: 'restored', at: '2026-10-14T08:00:00Z', requested_sha256: 'ab'.repeat(32) },
      { note_id: 'note-b1', owner_id: OTHER, outcome: 'owner_mismatch', at: '2026-10-14T08:01:00Z', requested_sha256: '0'.repeat(64) }],
  };
  const writes = [];
  const queried = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.cols = '*'; this.max = null; }
    select(cols) { this.cols = cols; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    order() { return this; }
    limit(n) { this.max = n; return this; }
    insert() { writes.push(this.table); return this; }
    update() { writes.push(this.table); return this; }
    delete() { writes.push(this.table); return this; }
    then(ok, bad) {
      queried.push({ table: this.table, cols: this.cols });
      if (missing.includes(this.table)) return Promise.resolve({ data: null, error: { code: '42P01', message: `relation "public.${this.table}" does not exist` } }).then(ok, bad);
      const rows = tables[this.table].filter((r) => this.filters.every((f) => f(r))).slice(0, this.max ?? undefined);
      const cols = this.cols.split(',').map((c) => c.trim());
      return Promise.resolve({ data: rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))), error: null }).then(ok, bad);
    }
  }
  return { writes, queried, createSupabase: () => ({ from: (table) => new Query(table) }) };
}
const service = (db, extra = {}) => createOpsService({ env: FAKE_ENV, createSupabase: db.createSupabase, loginConfig, loginOptions,
  checkDevice: APPROVED_DEVICE, now: () => Date.parse('2026-10-15T07:00:00Z'), ...extra });
async function call(handler, request) {
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method: 'GET', url: '/api/ops', headers: {}, ...request }, response));
  return { ...out, logs };
}
const asMe = () => ({ authorization: `Bearer ${studentToken(ME)}` });

test('설정은 12단계이고, 실제 빌드(Vercel 흉내)가 만든 /aleph.json도 12단계다', () => {
  assert.equal(config.step, 12);
  const output = new URL('../public/aleph.json', import.meta.url);
  try {
    execFileSync(process.execPath, ['scripts/build-public.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'pipe', env: { ...process.env,
      VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
      VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40), VERCEL_URL: 'defense-app-pqr678.vercel.app' } });
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).step, 12);
  } finally {
    rmSync(output, { force: true });
  }
});

test('작전실 요약: 서버가 이번 요청에서 확인한 값은 confirmed, 앱이 받을 수 없는 것은 not_run으로 구분한다', async () => {
  const db = fakeDb();
  const out = await call(service(db).summary, { headers: asMe() });
  assert.equal(out.status, 200);
  const body = out.body;
  assert.equal(body.schema, 'aleph.ops.summary.v1');
  assert.equal(body.generatedAt, '2026-10-15T07:00:00.000Z');
  assert.equal(body.rules.status, 'confirmed');
  assert.deepEqual(body.rules.deciderRules, [...RULE_IDS]);
  assert.deepEqual(body.rules.detectionRules, ['unusual_network_burst', 'burst_read']);
  assert.deepEqual(body.rules.allowedRoutes, config.allowedRoutes);
  assert.equal(body.rules.restoreRoute, 'POST /api/restore/:id');
  assert.equal(body.detection.status, 'not_run', '실제 탐지 사건은 받지 않음');
  assert.deepEqual(body.revocation.devices, { status: 'confirmed', source: '이번 요청의 user_devices 조회(내 기기만)', counts: { approved: 1, pending: 1, revoked: 1 } });
  assert.equal(body.revocation.engine.status, 'not_run', '반 엔진의 회수는 심판이 확인');
  assert.deepEqual(body.restore.versions.items, [{ noteId: 'note-b1', backedUpAt: '2026-10-14T07:11:56Z', sha256Prefix: 'abababababab' }]);
  assert.deepEqual(body.restore.audit.items, [{ noteId: 'note-b1', outcome: 'restored', at: '2026-10-14T08:00:00Z' }], '내 기록만');
  assert.equal(body.restore.policy.status, 'not_run');
  for (const part of [body.detection, body.revocation.engine, body.restore.policy]) assert.ok(part.reason.length > 10 && !('items' in part) && !('counts' in part), '미실행 항목에는 결과가 없음');
});

test('작전실 요약은 메모 제목·본문을 읽지도 돌려주지도 않고, 아무것도 바꾸지 않는다', async () => {
  const db = fakeDb();
  const out = await call(service(db).summary, { headers: asMe() });
  const seen = JSON.stringify([out.body, out.logs]);
  for (const secret of [SECRET_TITLE, SECRET_BODY, 'TITLE-XYZ', 'BODY-XYZ', 'ab'.repeat(32)]) assert.ok(!seen.includes(secret), secret);
  assert.ok(!db.queried.some((q) => q.table === 'notes'), '메모 테이블은 조회하지 않음');
  assert.ok(db.queried.every((q) => !/title|content(?!_sha256)/u.test(q.cols)), '제목·본문 칸을 고르지 않음');
  assert.deepEqual(db.writes, [], '읽기 전용');
  assert.equal((await call(service(db).summary, { method: 'POST', headers: asMe() })).status, 405);
});

test('SQL을 아직 실행하지 않아 테이블이 없으면 그 항목만 unavailable로 적고 나머지는 그대로 보여 준다', async () => {
  const db = fakeDb({ missing: ['notes_backup', 'notes_restore_audit'] });
  const out = await call(service(db).summary, { headers: asMe() });
  assert.equal(out.status, 200);
  assert.equal(out.body.restore.versions.status, 'unavailable');
  assert.match(out.body.restore.versions.reason, /10단계 SQL\(step10_notes_restore\.sql\)을\(를\) 아직 실행하지 않았습니다/u);
  assert.equal(out.body.restore.audit.status, 'unavailable');
  assert.equal(out.body.rules.status, 'confirmed');
  assert.equal(out.body.revocation.devices.status, 'confirmed');
  const noDevices = await call(service(fakeDb({ missing: ['user_devices'] })).summary, { headers: asMe() });
  assert.equal(noDevices.body.revocation.devices.status, 'unavailable');
  assert.ok(!JSON.stringify(out.body).includes('does not exist'), 'DB 오류 원문은 보내지 않음');
});

test('로그인 없음은 401, 화면 로그인은 승인 기기 세션이 없으면 403, 심판 토큰은 반 엔진의 기기 확인을 따른다', async () => {
  const db = fakeDb();
  const anon = await call(service(db).summary, {});
  assert.deepEqual([anon.status, anon.body.error], [401, 'LOGIN_REQUIRED']);
  assert.ok(!('rules' in anon.body));
  const noDevice = await call(service(db, { checkDevice: async () => ({ ok: false, reason: 'no_device_session' }) }).summary, { headers: asMe() });
  assert.deepEqual([noDevice.status, noDevice.body.error], [403, 'DEVICE_NOT_APPROVED']);
  assert.deepEqual(noDevice.logs, ['OPS_DEVICE_REQUIRED {"reason":"no_device_session"}']);
  const judge = await call(service(db, { checkDevice: async () => ({ ok: false }) }).summary, { headers: { authorization: `Bearer ${await judgeToken({ sub: ME })}` } });
  assert.equal(judge.status, 200);
});

test('화면: 작전실은 서버가 기기를 확인한 뒤에만 열고, 배지는 서버 status로만 정하며 메모 내용을 쓰지 않는다', () => {
  const page = read('public/index.html');
  assert.match(page, /<section class="panel ops" id="ops" aria-labelledby="ops-title" hidden>/u);
  const script = page.slice(page.indexOf('<script>'));
  const access = script.slice(script.indexOf('function applyAccess()'), script.indexOf('// ── 12단계 탈환 작전실'));
  assert.match(access, /if \(currentEmail && deviceConfirmed\) \{[\s\S]*opsPanel\.hidden = false;\s+loadOps\(\);[\s\S]*\} else \{[\s\S]*closeOps\(\);/u);
  assert.equal((script.match(/loadOps\(\);/gu) ?? []).length, 2, 'applyAccess와 다시 불러오기(기기 확인 뒤)에서만 부름');
  const ops = script.slice(script.indexOf('// ── 12단계 탈환 작전실'), script.indexOf("opsRefresh.addEventListener"));
  assert.match(ops, /const BADGE = \{ confirmed: 'API로 확인', not_run: '미실행', unavailable: '확인 실패' \};/u);
  assert.doesNotMatch(ops, /\.title\b|\.body\b|\.content\b|innerHTML/u);
  assert.doesNotThrow(() => new Function(page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'))));
});

test('자기 점검: 토큰 없이 GET /api/ops를 실제로 보내고 받은 응답대로 적는다(결과 20개 이하)', async () => {
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const original = globalThis.fetch;
  const sent = [];
  const respond = (pathname, opsResponse) => {
    if (pathname === '/api/ops') return opsResponse();
    if (pathname === '/') return new Response('<title>BYTE BACK | 점령된 자료실</title>', { status: 200 });
    if (pathname === '/aleph.json') return new Response(JSON.stringify({ step: 12, allowedRoutes: ['POST /api/restore/:id'], restoreRoute: 'POST /api/restore/:id' }), { status: 200 });
    if (pathname === '/data.json') return new Response('nf', { status: 404 });
    return new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 });
  };
  const run = async (opsResponse) => {
    globalThis.fetch = async (url) => { const { pathname } = new URL(String(url)); sent.push(pathname); return respond(pathname, opsResponse); };
    try { return await runAttackChecks({ ...config, publicAppUrl: 'https://student-defense.vercel.app/' }); } finally { globalThis.fetch = original; }
  };
  const denied = await run(() => new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 }));
  const item = denied.find((entry) => entry.attackId === 'ops_summary_anonymous');
  assert.equal(item.observed, '토큰 없는 GET /api/ops가 거부됨 (HTTP 401 LOGIN_REQUIRED)');
  assert.ok(sent.includes('/api/ops'));
  assert.ok(denied.length <= 20, `결과 ${denied.length}개`);
  const leaky = await run(() => new Response(JSON.stringify({ rules: {} }), { status: 200 }));
  assert.equal(leaky.find((entry) => entry.attackId === 'ops_summary_anonymous').observed, '토큰 없는 GET /api/ops가 요약을 돌려줌 (거부되지 않음)');
});
