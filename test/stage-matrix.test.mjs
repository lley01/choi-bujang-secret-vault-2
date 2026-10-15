import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { MATRIX, buildMatrix, evidenceTemplate, readEvidence, renderMarkdown } from '../src/stage-matrix.mjs';
import { createNotesService } from '../src/notes-service.mjs';
import { createAuthService } from '../src/auth-service.mjs';
import { createDeviceService } from '../src/device-service.mjs';
import { createRestoreService } from '../src/restore-service.mjs';
import { FAKE_ENV, fakeResponse } from './helpers/fakes.mjs';

// 1~11단계 대조표(npm run matrix). 배포 주소 대신 실제 서버 함수 코드를 붙인 가짜 fetch로 시험합니다. 심판 판정이 아닙니다.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const config = { ...JSON.parse(read('aleph.config.json')), publicAppUrl: 'https://matrix-test.vercel.app/' };
const NOW = Date.parse('2026-10-15T07:00:00Z');
const MEMO_BODY = '비밀 본문 BODY-XYZ';

// 실제 서버 함수(로그인은 모두 실패하도록)와 public/ 파일로 배포를 흉내 냅니다. 모든 응답에 x-vercel-id를 붙입니다.
function fakeApp({ override } = {}) {
  const reject = async () => null;
  const notes = createNotesService({ env: FAKE_ENV, verifyLogin: reject, createSupabase: () => { throw new Error('DB를 부르면 안 됨'); } });
  const auth = createAuthService({ env: FAKE_ENV, createSupabase: () => { throw new Error('Auth를 부르면 안 됨'); } });
  const devices = createDeviceService({ env: FAKE_ENV, verifyLogin: reject, createSupabase: () => { throw new Error('DB를 부르면 안 됨'); } });
  const restore = createRestoreService({ env: FAKE_ENV, verifyLogin: reject, createSupabase: () => { throw new Error('DB를 부르면 안 됨'); } });
  const sent = [];
  let counter = 0;
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    sent.push({ host: target.host, method: init.method, path: target.pathname + target.search, headers, credentials: init.credentials });
    const id = `icn1::matrix-${++counter}`;
    const reply = (status, body, type = 'application/json; charset=utf-8', extra = {}) => new Response(body, { status, headers: { 'content-type': type, 'x-vercel-id': id, ...extra } });
    if (override) {
      const forced = override(target, init, reply);
      if (forced) return forced;
    }
    const path = target.pathname;
    if (init.method === 'GET' && path === '/') return reply(200, read('public/index.html'), 'text/html; charset=utf-8');
    if (init.method === 'GET' && path === '/aleph.json') return reply(200, JSON.stringify({ step: config.step }));
    if (init.method === 'GET' && path === '/manifest.webmanifest') return reply(200, read('public/manifest.webmanifest'), 'application/manifest+json; charset=utf-8');
    if (init.method === 'GET' && path === '/offline.html') return reply(200, read('public/offline.html'), 'text/html; charset=utf-8');
    let handler = null;
    if (path === '/api/notes') handler = notes.collection;
    else if (path.startsWith('/api/notes/')) handler = notes.item;
    else if (path.startsWith('/api/auth/')) handler = auth.route;
    else if (path.startsWith('/api/devices/')) handler = devices.route;
    else if (path.startsWith('/api/restore/')) handler = restore.restore;
    if (!handler) return reply(404, 'Not Found', 'text/plain');
    const { response, out } = fakeResponse();
    const request = { method: init.method, url: path + target.search, headers: { host: target.host, ...headers }, body: init.body };
    await handler(request, response);
    const extra = Object.fromEntries([...out.headers].filter(([k]) => k !== 'content-type'));
    return reply(out.status, out.body === undefined ? null : JSON.stringify(out.body), 'application/json; charset=utf-8', extra);
  };
  return { fetchImpl, sent };
}

test('대조표: 1~11단계의 정상·금지 시험만 담고 ID가 겹치지 않음', () => {
  assert.equal(MATRIX.length, 48);
  assert.deepEqual([...new Set(MATRIX.map((row) => row.stage))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(new Set(MATRIX.map((row) => row.id)).size, MATRIX.length);
  for (const row of MATRIX) {
    assert.ok(['정상', '금지'].includes(row.kind), row.id);
    assert.ok(['auto', 'manual', 'judge'].includes(row.how), row.id);
    if (row.how === 'auto') assert.equal(typeof row.check, 'function', row.id);
  }
  for (const stage of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    assert.ok(MATRIX.some((row) => row.stage === stage), `${stage}단계 행 없음`);
  }
});

test('보내지 않으면 모든 행이 미실행이고 요청 ID·확인 시각이 비어 있음', async () => {
  let called = 0;
  const matrix = await buildMatrix({ config, fetchImpl: () => { called += 1; }, now: () => NOW });
  assert.equal(called, 0);
  assert.deepEqual(matrix.counts, { match: 0, mismatch: 0, unknown: 0, not_run: 48 });
  for (const row of matrix.rows) {
    assert.equal(row.verdict, 'not_run');
    assert.match(row.observed, /^미실행:/u);
    assert.equal(row.requestId, '');
    assert.equal(row.checkedAt, '');
  }
  const markdown = renderMarkdown(matrix);
  assert.match(markdown, /미실행 48/u);
  assert.doesNotMatch(markdown, /\| 일치 \|/u);
});

test('--send: 실제 서버 함수 응답으로 자동 23건만 채우고, 직접·심판 25건은 미실행으로 남김', async () => {
  const { fetchImpl, sent } = fakeApp();
  const matrix = await buildMatrix({ config, send: true, fetchImpl, now: () => NOW });
  const auto = matrix.rows.filter((row) => row.how === 'auto');
  assert.equal(auto.length, 23);
  for (const row of auto) {
    assert.equal(row.verdict, 'match', `${row.id}: ${row.observed}`);
    assert.match(row.requestId, /^icn1::matrix-\d+$/u);
    assert.equal(row.checkedAt, '2026-10-15T07:00:00.000Z');
  }
  for (const row of matrix.rows.filter((r) => r.how !== 'auto')) {
    assert.equal(row.verdict, 'not_run', row.id);
    assert.equal(row.requestId, '');
  }
  assert.equal(sent.length, 23);
  for (const request of sent) {
    assert.equal(request.host, 'matrix-test.vercel.app');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.headers.cookie, undefined);
    assert.ok(request.headers.authorization === undefined || request.headers.authorization === 'Bearer aaaaaaaa.bbbbbbbb.cccccccc');
  }
  assert.equal(matrix.counts.match, 23);
  assert.equal(matrix.counts.not_run, 25);
});

test('--send: 거부되지 않거나 앱이 아닌 곳이 막거나 보내지 못하면 일치로 적지 않음(메모 내용도 적지 않음)', async () => {
  const { fetchImpl } = fakeApp({
    override: (target, init, reply) => {
      if (target.pathname === '/api/notes' && init.method === 'GET') return reply(200, JSON.stringify([{ id: 'x', title: 't', body: MEMO_BODY }]));
      if (target.pathname.startsWith('/api/restore/') && init.method === 'GET') return reply(403, '<html>Vercel Authentication</html>', 'text/html');
      if (target.pathname === '/api/devices/status') throw new TypeError('fetch failed');
      return null;
    },
  });
  const matrix = await buildMatrix({ config, send: true, fetchImpl, now: () => NOW });
  const byId = Object.fromEntries(matrix.rows.map((row) => [row.id, row]));
  assert.equal(byId.s3_list_no_token.verdict, 'mismatch');
  assert.equal(byId.s8_resource_id_forged.verdict, 'mismatch');
  assert.equal(byId.s10_restore_wrong_method.verdict, 'unknown');
  assert.equal(byId.s11_device_status_no_login.verdict, 'not_run');
  assert.equal(byId.s11_device_status_no_login.requestId, '');
  assert.doesNotMatch(JSON.stringify(matrix), /BODY-XYZ/u);
});

test('기록 파일: 직접·심판 결과는 요청 ID와 확인 시각이 있을 때만 반영하고 판정은 코드가 비교함', async () => {
  const evidence = readEvidence([
    { id: 's4_other_owner_read', status: 404, error: 'NOT_FOUND', requestId: 'icn1::abcde-1', checkedAt: 'Thu, 15 Oct 2026 06:50:00 GMT' },
    { id: 's11_revoked_device', status: 200, error: null, requestId: 'icn1::abcde-2', checkedAt: '2026-10-15T06:55:00Z' },
    { id: 's6_unregistered_device', decision: 'deny', reasonCode: 'device_not_registered', requestId: 'judge-req-77', checkedAt: '2026-10-15T06:40:00Z' },
    { id: 's3_login_list', status: null, error: null, requestId: null, checkedAt: null },
  ], { now: () => NOW });
  const matrix = await buildMatrix({ config, evidence, now: () => NOW });
  const byId = Object.fromEntries(matrix.rows.map((row) => [row.id, row]));
  assert.equal(byId.s4_other_owner_read.verdict, 'match');
  assert.equal(byId.s4_other_owner_read.checkedAt, '2026-10-15T06:50:00.000Z');
  assert.equal(byId.s11_revoked_device.verdict, 'mismatch');
  assert.equal(byId.s6_unregistered_device.verdict, 'match');
  assert.equal(byId.s3_login_list.verdict, 'not_run');
  assert.equal(matrix.counts.not_run, 45);
});

test('기록 파일: 자동 시험·통과 칸·토큰·반만 적은 줄·미래 시각은 거부', () => {
  const ok = { id: 's4_other_owner_read', status: 404, error: 'NOT_FOUND', requestId: 'icn1::abc', checkedAt: '2026-10-15T06:50:00Z' };
  const bad = [
    [{ id: 's3_list_no_token', status: 401, error: 'LOGIN_REQUIRED', requestId: 'x', checkedAt: '2026-10-15T06:50:00Z' }, /자동 시험은 기록 파일로 채울 수 없습니다/u],
    [{ ...ok, passed: true }, /「passed」 칸은 받지 않습니다/u],
    [{ ...ok, verdict: 'match' }, /「verdict」 칸은 받지 않습니다/u],
    [{ ...ok, requestId: ['eyJ', 'x'.repeat(10)].join('') }, /토큰·키·이메일/u],
    [{ ...ok, requestId: null }, /모두 적거나 모두 비워/u],
    [{ ...ok, checkedAt: '2026-10-16T00:00:00Z' }, /미래 시각/u],
    [{ ...ok, id: 'unknown_test' }, /표에 없는 시험 ID/u],
    [{ id: 's6_registered_device', decision: 'pass', requestId: 'j1', checkedAt: '2026-10-15T06:50:00Z' }, /allow·deny·step_up/u],
  ];
  for (const [entry, pattern] of bad) assert.throws(() => readEvidence([entry], { now: () => NOW }), pattern);
  assert.throws(() => readEvidence([ok, ok], { now: () => NOW }), /두 번/u);
});

test('기록 틀은 직접·심판 25건을 모두 비워 둔 채 만들고, 그대로 쓰면 전부 미실행', async () => {
  const template = evidenceTemplate();
  assert.equal(template.length, 25);
  assert.ok(template.every((entry) => Object.entries(entry).every(([key, value]) => key === 'id' || value === null)));
  const matrix = await buildMatrix({ config, evidence: readEvidence(template, { now: () => NOW }), now: () => NOW });
  assert.equal(matrix.counts.not_run, 48);
});

test('npm run matrix: 기록 파일·결과는 커밋 제외, --template 은 기존 파일을 덮어쓰지 않음', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^artifacts\/$/mu);
  assert.match(ignore, /^matrix-evidence\.json$/mu);
  assert.equal(JSON.parse(read('package.json')).scripts.matrix, 'node scripts/stage-matrix.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'matrix-'));
  try {
    const path = join(dir, 'e.json');
    // Windows에서는 URL.pathname이 /C:/… 모양이라 node가 찾지 못합니다. 운영체제 경로로 바꿔 씁니다.
    const script = fileURLToPath(new URL('../scripts/stage-matrix.mjs', import.meta.url));
    execFileSync(process.execPath, [script, '--template', '--evidence', path]);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).length, 25);
    writeFileSync(path, '["직접 적은 내용"]');
    execFileSync(process.execPath, [script, '--template', '--evidence', path]);
    assert.equal(readFileSync(path, 'utf8'), '["직접 적은 내용"]');
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
