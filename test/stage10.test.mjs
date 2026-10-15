import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PolicyStop, currentTestPolicy, diffPolicies, formatDiff, loadVerifiedCopy } from '../scripts/policy-diff.mjs';
import { AUDIT_FILE, applyRestore, formatPlan, parseArgs, planRestore } from '../scripts/policy-restore.mjs';
import { createRestoreService } from '../src/restore-service.mjs';
import { decide } from '../src/decider.mjs';
import { fixtureRequests } from '../scripts/fixture-7.mjs';
import { FAKE_ENV, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeToken, loginConfig, loginOptions } from './helpers/login-fixtures.mjs';

// 10단계 정책 차이 보기. 시험용 사본은 임시 폴더에만 만들고 지웁니다. 심판 판정이 아닙니다.
const root = new URL('..', import.meta.url);
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SAFE = { schema: 'aleph.policy.v1', step: 8, ruleIds: ['starter.deny', 'device_registered', 'step_up_required', 'resource_zone', 'old_rule'],
  allowedRoutes: ['GET /api/notes/:id', 'PUT /api/notes/:id', 'DELETE /api/notes/:id', 'GET /api/notices', 'GET /api/notices/:id', 'POST /api/restore/:id', 'GET /api/notes'] };

function withCopy(content, run) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  const path = join(dir, 'safe-policy.json');
  writeFileSync(path, content);
  try { return run(path, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function withCopyAsync(content, run) {
  const dir = mkdtempSync(join(tmpdir(), 'policy-'));
  const path = join(dir, 'safe-policy.json');
  writeFileSync(path, content);
  try { return await run(path, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const cli = (...args) => spawnSync(process.execPath, ['scripts/policy-diff.mjs', ...args], { cwd: root, encoding: 'utf8' });

test('현재 시험 정책은 저장소의 판정기 규칙과 설정의 단계·허용 경로다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const { RULE_IDS } = await import('../src/decider.mjs');
  assert.deepEqual(await currentTestPolicy(), { schema: 'aleph.policy.v1', step: config.step, ruleIds: [...RULE_IDS], allowedRoutes: config.allowedRoutes });
});

test('검증한 사본과의 차이만 보여 준다(같은 항목은 출력하지 않음)', () => {
  const text = `${JSON.stringify(SAFE)}\n`;
  withCopy(text, (path) => {
    const out = cli(path, sha(text));
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, '정책 차이(안전 사본 → 현재 시험 정책, 읽기 전용)\n~ 단계: 8 → 9\n- 규칙 빠짐: old_rule\n- 허용 경로 빠짐: GET /api/notes\n');
    for (const same of ['starter.deny', 'resource_zone', 'GET /api/notices']) assert.ok(!out.stdout.includes(same), `같은 항목 ${same}은 출력 안 함`);
  });
  assert.deepEqual(formatDiff(diffPolicies(SAFE, SAFE)), ['차이 없음']);
  const changed = diffPolicies(SAFE, { ...SAFE, ruleIds: [...SAFE.ruleIds, 'new_rule'], allowedRoutes: [...SAFE.allowedRoutes, 'POST /api/notices'] });
  assert.deepEqual(formatDiff(changed), ['+ 규칙 추가: new_rule', '+ 허용 경로 추가: POST /api/notices']);
});

test('사본이 없거나 지문이 없으면 중단한다', () => {
  const text = JSON.stringify(SAFE);
  for (const args of [[], ['/no/such/safe-policy.json', sha(text)]]) {
    const out = cli(...args);
    assert.equal(out.status, 1);
    assert.equal(out.stdout, '', '중단하면 차이를 출력하지 않음');
    assert.match(out.stderr, /중단합니다/u);
  }
  withCopy(text, (path) => {
    for (const bad of [undefined, '', 'abc', sha(text).toUpperCase(), `${sha(text)}0`]) {
      const out = cli(...[path, bad].filter((item) => item !== undefined));
      assert.equal(out.status, 1, String(bad));
      assert.match(out.stderr, /SHA-256 지문.*없습니다/u);
    }
  });
});

test('검증에 실패하면(지문 불일치·JSON 아님·형식 틀림·링크) 중단한다', async () => {
  const text = JSON.stringify(SAFE);
  withCopy(text, (path) => {
    const tampered = cli(path, sha(text.replace('old_rule', 'evil_rule')));
    assert.equal(tampered.status, 1);
    assert.equal(tampered.stderr, '안전 정책 사본 검증 실패: SHA-256 지문이 기록과 다릅니다. 비교를 중단합니다.\n');
  });
  for (const [content, reason] of [['not json', /JSON이 아닙니다/u], [JSON.stringify({ ...SAFE, schema: 'x' }), /schema/u],
    [JSON.stringify({ ...SAFE, extra: 1 }), /형식이 아닙니다/u], [JSON.stringify({ ...SAFE, ruleIds: ['a', 'a'] }), /ruleIds/u],
    [JSON.stringify({ ...SAFE, allowedRoutes: ['GET /api/notes?x=1'] }), /allowedRoutes/u], [JSON.stringify({ ...SAFE, step: '8' }), /step/u]]) {
    await withCopyAsync(content, async (path) => {
      await assert.rejects(loadVerifiedCopy(path, sha(content)), (error) => error instanceof PolicyStop && reason.test(error.message));
    });
  }
  await withCopyAsync(JSON.stringify(SAFE), async (path, dir) => {
    await assert.rejects(loadVerifiedCopy(dir, sha('')), /일반 파일이 아닙니다/u);
    // Windows는 관리자 권한이나 개발자 모드가 없으면 링크를 만들 수 없습니다(EPERM). 그때는 링크 확인만 건너뜁니다.
    const link = join(dir, 'link.json');
    try {
      symlinkSync(path, link);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return;
      throw error;
    }
    await assert.rejects(loadVerifiedCopy(link, sha(JSON.stringify(SAFE))), /일반 파일이 아닙니다/u);
  });
});

test('실제 운영 정책은 건드리지 않는다: 설정·판정기 파일이 그대로이고, 도구는 쓰기·네트워크 코드가 없다', () => {
  const files = ['../aleph.config.json', '../src/decider.mjs'].map((file) => new URL(file, import.meta.url));
  const before = files.map((file) => [readFileSync(file, 'utf8'), statSync(file).mtimeMs]);
  const text = JSON.stringify(SAFE);
  withCopy(text, (path) => {
    cli(path, sha(text));
    assert.equal(readFileSync(path, 'utf8'), text, '사본도 바꾸지 않음');
  });
  assert.deepEqual(files.map((file) => [readFileSync(file, 'utf8'), statSync(file).mtimeMs]), before);
  const source = readFileSync(new URL('../scripts/policy-diff.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rm\(|rename|mkdir|fetch\(|http|supabase|child_process/iu);
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', "import('./scripts/policy-diff.mjs').then(() => console.log('ok'))"], { cwd: root, encoding: 'utf8' });
  assert.equal(out, 'ok\n', '불러오기만 해서는 아무것도 실행하지 않음');
});

// 10단계 제작 2: 안전 정책 사본으로 시험 정책 되돌리기. 임시 폴더의 설정 사본으로만 실제 쓰기를 시험합니다.

const CURRENT = { schema: 'aleph.policy.v1', step: 9, ruleIds: ['starter.deny', 'device_registered', 'step_up_required', 'resource_zone'],
  allowedRoutes: ['GET /api/notes/:id', 'PUT /api/notes/:id', 'DELETE /api/notes/:id', 'GET /api/notices', 'GET /api/notices/:id'] };
const COPY = { schema: 'aleph.policy.v1', step: 8, ruleIds: ['starter.deny', 'device_registered', 'old_rule'],
  allowedRoutes: ['GET /api/notes/:id', 'GET /api/notes', 'GET /api/notices'] };
const COPY_SHA = 'f'.repeat(64);

function tempRoot({ eol = '\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'restore-'));
  mkdirSync(join(dir, 'src'));
  copyFileSync(new URL('../src/decider.mjs', import.meta.url), join(dir, 'src', 'decider.mjs'));
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, 'aleph.config.json'), `${JSON.stringify(config, null, 2)}\n`.replace(/\n/gu, eol));
  return dir;
}

test('미리보기: 고른 서비스의 바뀔 항목과 보존 항목, 직접 확인할 규칙을 보여 준다', () => {
  const plan = planRestore(COPY, CURRENT, 'notes', COPY_SHA);
  assert.deepEqual(plan.removed, ['PUT /api/notes/:id', 'DELETE /api/notes/:id']);
  assert.deepEqual(plan.added, ['GET /api/notes']);
  assert.deepEqual(plan.allowedRoutes, ['GET /api/notes/:id', 'GET /api/notes', 'GET /api/notices', 'GET /api/notices/:id'], '다른 서비스(notices) 경로와 순서는 그대로');
  assert.match(plan.code, /^[0-9a-f]{12}$/u);
  assert.deepEqual(formatPlan(plan), ['되돌릴 서비스: notes', '- 허용 경로 빠짐: PUT /api/notes/:id', '- 허용 경로 빠짐: DELETE /api/notes/:id',
    '+ 허용 경로 되돌림: GET /api/notes', '보존: 다른 서비스 허용 경로 2개, step 9, 판정기 규칙 코드, 감사 이력',
    '! 직접 확인(자동으로 되돌리지 않음): 사본에만 있는 규칙 old_rule', '! 직접 확인(자동으로 되돌리지 않음): 현재에만 있는 규칙 step_up_required',
    '! 직접 확인(자동으로 되돌리지 않음): 현재에만 있는 규칙 resource_zone']);
});

test('미리보기 명령은 아무 파일도 바꾸지 않는다(저장소 설정·감사 이력 그대로)', () => {
  const config = new URL('../aleph.config.json', import.meta.url);
  const before = readFileSync(config, 'utf8');
  const auditBefore = existsSync(new URL(`../${AUDIT_FILE}`, import.meta.url));
  const text = `${JSON.stringify(COPY)}\n`;
  withCopy(text, (path) => {
    const out = spawnSync(process.execPath, ['scripts/policy-restore.mjs', path, sha(text), '--service', 'notes'], { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /미리보기입니다\. 아무것도 바꾸지 않았습니다\.\n위 항목을 확인했으면 같은 명령 끝에 --apply [0-9a-f]{12} 를 붙여 실행하세요\./u);
  });
  assert.equal(readFileSync(config, 'utf8'), before);
  assert.equal(existsSync(new URL(`../${AUDIT_FILE}`, import.meta.url)), auditBefore);
});

test('확인 코드로 실행하면 그 서비스의 허용 경로만 되돌리고, 다른 설정·규칙 코드·기존 감사 이력은 보존한다', async () => {
  const dir = tempRoot();
  try {
    const auditPath = join(dir, AUDIT_FILE);
    mkdirSync(join(dir, 'audit'));
    writeFileSync(auditPath, '{"at":"2026-10-01T00:00:00.000Z","action":"earlier_entry"}\n');
    const configBefore = JSON.parse(readFileSync(join(dir, 'aleph.config.json'), 'utf8'));
    const deciderBefore = readFileSync(join(dir, 'src', 'decider.mjs'), 'utf8');
    const plan = planRestore(COPY, await currentTestPolicy(dir), 'notes', COPY_SHA);
    assert.equal(await applyRestore(plan, plan.code, { root: dir, copySha256: COPY_SHA, now: () => new Date('2026-10-14T07:00:00Z') }), true);
    const configAfter = JSON.parse(readFileSync(join(dir, 'aleph.config.json'), 'utf8'));
    assert.deepEqual(configAfter, { ...configBefore, allowedRoutes: plan.allowedRoutes }, 'allowedRoutes 말고는 그대로');
    assert.deepEqual(Object.keys(configAfter), Object.keys(configBefore), '항목 순서도 그대로');
    assert.deepEqual(configAfter.allowedRoutes.filter((route) => route.includes('/api/notices')), configBefore.allowedRoutes.filter((route) => route.includes('/api/notices')));
    assert.equal(readFileSync(join(dir, 'src', 'decider.mjs'), 'utf8'), deciderBefore, '판정기 규칙 코드는 그대로');
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], '{"at":"2026-10-01T00:00:00.000Z","action":"earlier_entry"}', '기존 감사 이력 보존');
    assert.deepEqual(JSON.parse(lines[1]), { at: '2026-10-14T07:00:00.000Z', action: 'restore_test_policy', service: 'notes', copySha256: COPY_SHA,
      code: plan.code, removed: plan.removed, added: plan.added });
    assert.equal(existsSync(join(dir, 'aleph.config.json.restore-tmp')), false);
    const again = planRestore(COPY, await currentTestPolicy(dir), 'notes', COPY_SHA);
    assert.equal(again.changed, false, '한 번 되돌리면 더 바뀔 항목 없음');
    assert.equal(await applyRestore(again, again.code, { root: dir, copySha256: COPY_SHA }), false);
    assert.equal(readFileSync(auditPath, 'utf8').trim().split('\n').length, 2, '바뀐 것이 없으면 감사 이력도 그대로');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('확인 코드가 없거나 다르거나, 미리보기 뒤에 상태가 바뀌면 중단하고 아무것도 바꾸지 않는다', async () => {
  const dir = tempRoot();
  try {
    const before = readFileSync(join(dir, 'aleph.config.json'), 'utf8');
    const plan = planRestore(COPY, await currentTestPolicy(dir), 'notes', COPY_SHA);
    for (const code of [undefined, '', 'abc', '0'.repeat(12)]) {
      await assert.rejects(applyRestore(plan, code, { root: dir, copySha256: COPY_SHA }), PolicyStop, String(code));
    }
    const otherService = planRestore(COPY, await currentTestPolicy(dir), 'notices', COPY_SHA);
    await assert.rejects(applyRestore(otherService, plan.code, { root: dir, copySha256: COPY_SHA }), /확인 코드가 다릅니다/u);
    const changedState = planRestore(COPY, { ...CURRENT, allowedRoutes: [...CURRENT.allowedRoutes, 'GET /api/notes'] }, 'notes', COPY_SHA);
    assert.notEqual(changedState.code, plan.code, '상태가 바뀌면 확인 코드도 바뀜');
    assert.equal(readFileSync(join(dir, 'aleph.config.json'), 'utf8'), before);
    assert.equal(existsSync(join(dir, AUDIT_FILE)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('사본이 없거나 검증에 실패하거나 서비스가 없으면 미리보기 전에 중단한다', () => {
  const run = (...args) => spawnSync(process.execPath, ['scripts/policy-restore.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const text = JSON.stringify(COPY);
  assert.match(run('/no/such.json', sha(text), '--service', 'notes').stderr, /사본이 없습니다/u);
  withCopy(text, (path) => {
    assert.match(run(path, sha('other'), '--service', 'notes').stderr, /검증 실패/u);
    assert.match(run(path, sha(text)).stderr, /되돌릴 서비스/u);
    assert.match(run(path, sha(text), '--service', 'Notes!').stderr, /되돌릴 서비스/u);
    assert.match(run(path, sha(text), '--service', 'notes', '--force').stderr, /알 수 없는 인자/u);
    for (const out of [run(path, sha('other'), '--service', 'notes')]) assert.equal(out.stdout, '');
  });
  assert.throws(() => planRestore({ ...COPY, allowedRoutes: [] }, { ...CURRENT, allowedRoutes: ['GET /api/notes/:id'] }, 'notes', COPY_SHA), /1~20개/u);
  assert.deepEqual(parseArgs(['a', 'b', '--service', 'notes', '--apply', 'c']), { copy: 'a', sha256: 'b', service: 'notes', apply: 'c' });
});

test('Windows 줄바꿈(CRLF) 설정 파일은 줄바꿈을 그대로 지킨다', async () => {
  const dir = tempRoot({ eol: '\r\n' });
  try {
    const plan = planRestore(COPY, await currentTestPolicy(dir), 'notes', COPY_SHA);
    await applyRestore(plan, plan.code, { root: dir, copySha256: COPY_SHA });
    const raw = readFileSync(join(dir, 'aleph.config.json'), 'utf8');
    assert.ok(raw.includes('\r\n') && !/[^\r]\n/u.test(raw));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 10단계 제작 3: 비공개 사본에서 메모 한 건 복원(POST /api/restore/:id). DB 함수는 가짜로 흉내 냅니다(실제 SQL은 따로 실행).
const B_ID = crypto.randomUUID();
const A_ID = crypto.randomUUID();
const NOTE = '00000000-0000-4000-8000-0000000000b1';
const HASH = createHash('sha256').update('B의 시험 메모').update(Buffer.from([0])).update('실습용 가상 시험 메모입니다(B 소유).').digest('hex');
const asB = async () => ({ authorization: `Bearer ${await judgeToken({ sub: B_ID, identity: 'b' })}` });
const asA = async () => ({ authorization: `Bearer ${await judgeToken({ sub: A_ID, identity: 'a' })}` });

// 가짜 DB 함수: 사본은 B의 메모 한 건. 실제 SQL 함수(restore_note_from_backup)와 같은 결과 이름을 돌려줍니다.
function fakeDb({ backup = { id: NOTE, owner_id: B_ID, sha: HASH, intact: true }, result } = {}) {
  const calls = [];
  const notes = new Map([[NOTE, { owner_id: B_ID, content: '훼손된 내용' }], ['other', { owner_id: A_ID, content: 'A의 메모' }]]);
  const rpc = async (name, args) => {
    calls.push({ name, args });
    if (result) return result;
    let outcome;
    if (args.p_note_id !== backup.id) outcome = 'backup_not_found';
    else if (args.p_owner_id !== backup.owner_id) outcome = 'owner_mismatch';
    else if (!backup.intact) outcome = 'backup_hash_mismatch';
    else if (args.p_content_sha256 !== backup.sha) outcome = 'requested_hash_mismatch';
    else { notes.set(NOTE, { owner_id: B_ID, content: '실습용 가상 시험 메모입니다(B 소유).' }); outcome = 'restored'; }
    return { data: outcome, error: null };
  };
  return { calls, notes, createSupabase: () => ({ rpc, from: () => { throw new Error('복원은 DB 함수 하나로만 함'); } }) };
}
async function restoreCall(db, request) {
  const service = createRestoreService({ env: FAKE_ENV, createSupabase: db.createSupabase, loginConfig, loginOptions });
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => service.restore({ method: 'POST', url: `/api/restore/${NOTE}`, query: { id: NOTE }, headers: {}, ...request }, response));
  return { ...out, logs };
}

test('복원: 시험 계정 B가 자기 메모 한 건을 ID·내용 해시로 복원하고, 다른 메모는 그대로다', async () => {
  const db = fakeDb();
  const out = await restoreCall(db, { headers: await asB(), body: { contentSha256: HASH } });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { id: NOTE, restored: true });
  assert.deepEqual(db.calls, [{ name: 'restore_note_from_backup', args: { p_note_id: NOTE, p_owner_id: B_ID, p_content_sha256: HASH } }]);
  assert.equal(db.notes.get(NOTE).content, '실습용 가상 시험 메모입니다(B 소유).');
  assert.deepEqual(db.notes.get('other'), { owner_id: A_ID, content: 'A의 메모' }, 'A의 메모는 그대로');
  assert.equal(out.headers.get('x-resource-id'), 'vault.note');
  assert.deepEqual(out.logs, []);
});

test('복원: 소유자는 로그인 검사로만 정하고, 본문의 owner_id·role·제목·본문은 읽지 않는다', async () => {
  const db = fakeDb();
  const out = await restoreCall(db, { headers: { ...(await asA()), 'x-user-id': B_ID, 'x-role': 'instructor' },
    body: { contentSha256: HASH, owner_id: B_ID, ownerId: B_ID, userId: B_ID, role: 'instructor', title: '가짜', content: '가짜 본문' } });
  assert.equal(out.status, 404, 'A는 B의 사본을 복원할 수 없고, 있다는 사실도 알 수 없음');
  assert.deepEqual(out.body, { error: 'NOT_FOUND' });
  assert.deepEqual(db.calls[0].args, { p_note_id: NOTE, p_owner_id: A_ID, p_content_sha256: HASH });
  assert.deepEqual(out.logs, ['RESTORE_DENIED {"reason":"owner_mismatch"}']);
  assert.equal(db.notes.get(NOTE).content, '훼손된 내용');
});

test('복원: 내용 해시가 다르거나 사본이 훼손됐거나 사본이 없으면 거부한다', async () => {
  const cases = [
    [fakeDb(), { contentSha256: 'a'.repeat(64) }, 409, 'HASH_MISMATCH', 'requested_hash_mismatch'],
    [fakeDb({ backup: { id: NOTE, owner_id: B_ID, sha: HASH, intact: false } }), { contentSha256: HASH }, 409, 'BACKUP_INTEGRITY_FAILED', 'backup_hash_mismatch'],
    [fakeDb({ backup: { id: 'none', owner_id: B_ID, sha: HASH, intact: true } }), { contentSha256: HASH }, 404, 'NOT_FOUND', 'backup_not_found'],
    [fakeDb({ result: { data: 'note_owner_mismatch', error: null } }), { contentSha256: HASH }, 404, 'NOT_FOUND', 'note_owner_mismatch'],
  ];
  for (const [db, body, status, error, reason] of cases) {
    const out = await restoreCall(db, { headers: await asB(), body });
    assert.deepEqual([out.status, out.body], [status, { error }], reason);
    assert.deepEqual(out.logs, [`RESTORE_DENIED {"reason":"${reason}"}`]);
    assert.ok(!JSON.stringify(out.logs).includes(NOTE) && !JSON.stringify(out.logs).includes(B_ID), '로그에 ID 없음');
  }
});

test('복원: 로그인 없음·잘못된 ID·해시·JSON·방법·다른 사이트 요청은 DB 함수를 부르지 않고 거부한다', async () => {
  const b = await asB();
  const cases = [
    [{ body: { contentSha256: HASH } }, 401, 'LOGIN_REQUIRED'],
    [{ headers: { authorization: 'Bearer aaa.bbb.ccc' }, body: { contentSha256: HASH } }, 401, 'LOGIN_REQUIRED'],
    [{ headers: b, url: '/api/restore/zzz', query: { id: 'zzz' }, body: { contentSha256: HASH } }, 400, 'INVALID_ID'],
    [{ headers: b, body: { contentSha256: HASH.toUpperCase() } }, 400, 'INVALID_HASH'],
    [{ headers: b, body: {} }, 400, 'INVALID_HASH'],
    [{ headers: b, body: 'not json' }, 400, 'INVALID_JSON'],
    [{ headers: b, method: 'GET' }, 405, 'METHOD_NOT_ALLOWED'],
    [{ headers: b, method: 'PUT', body: { contentSha256: HASH } }, 405, 'METHOD_NOT_ALLOWED'],
    [{ headers: { ...b, origin: 'https://evil.example', host: 'app.vercel.app' }, body: { contentSha256: HASH } }, 403, 'CROSS_SITE_REQUEST'],
  ];
  for (const [request, status, error] of cases) {
    const db = fakeDb();
    const out = await restoreCall(db, request);
    assert.equal(out.status, status, JSON.stringify(request.body ?? request.method));
    assert.equal(out.body.error, error);
    assert.equal(db.calls.length, 0, 'DB 함수를 부르지 않음');
    assert.ok(!JSON.stringify(out.logs).includes('aaa.bbb.ccc'), '토큰을 로그에 남기지 않음');
  }
  const sameSite = await restoreCall(fakeDb(), { headers: { ...b, origin: 'https://app.vercel.app', host: 'app.vercel.app' }, body: { contentSha256: HASH } });
  assert.equal(sameSite.status, 200, '같은 사이트의 화면 요청은 허용');
});

test('복원: DB 오류나 알 수 없는 결과는 내용 없이 500으로 닫는다', async () => {
  for (const result of [{ data: null, error: { code: '42501', message: 'permission denied for function restore_note_from_backup' } }, { data: 'weird', error: null }]) {
    const out = await restoreCall(fakeDb({ result }), { headers: await asB(), body: { contentSha256: HASH } });
    assert.deepEqual([out.status, out.body], [500, { error: 'RESTORE_UNAVAILABLE' }]);
    assert.ok(!JSON.stringify(out.logs).includes('permission denied'), '오류 원문은 남기지 않음');
  }
});

test('서비스 restore·경로 POST /api/restore/:id: 설정·허용 경로·판정기·자원 ID가 맞다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.equal(config.restoreRoute, 'POST /api/restore/:id');
  assert.ok(config.allowedRoutes.includes('POST /api/restore/:id'));
  const verdict = async (method, path, route) => (await decide({ ...fixtureRequests().normal, requestId: crypto.randomUUID(), service: 'restore', method, path, route })).decision;
  assert.equal(await verdict('POST', `/restore/${NOTE}`, 'POST /restore/:id'), 'allow');
  assert.equal(await verdict('POST', `/api/restore/${NOTE}`, 'POST /api/restore/:id'), 'allow');
  for (const [method, path, route] of [['GET', `/restore/${NOTE}`, 'GET /restore/:id'], ['POST', '/restore', 'POST /restore'], ['DELETE', `/restore/${NOTE}`, 'DELETE /restore/:id'],
    ['POST', `/restore/${NOTE}/all`, 'POST /restore/:id/all']]) {
    assert.equal(await verdict(method, path, route), 'deny', `${method} ${path}`);
  }
  const { resourceOf } = await import('../src/resources.mjs');
  assert.equal(resourceOf(`/api/restore/${NOTE}`), 'vault.note');
  assert.equal(resourceOf('/api/restore'), null);
});

// 10단계 고침: 복원 뒤 다시 시험. 자기 점검은 실제로 보낸 요청의 응답만 결과로 적고, 보내지 않은 시험은 미실행으로 남긴다.
async function selfCheck(respond) {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    const { pathname } = new URL(String(url));
    sent.push({ pathname, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    return respond(pathname, init);
  };
  try {
    return { results: await runAttackChecks({ ...config, publicAppUrl: 'https://student-defense.vercel.app/' }), sent, config };
  } finally {
    globalThis.fetch = original;
  }
}
const appLike = (pathname, init) => {
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (pathname === '/') return new Response('<!doctype html><title>BYTE BACK | 점령된 자료실</title>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (pathname === '/aleph.json') return json(200, { step: 9, allowedRoutes: ['GET /api/notes/:id', 'POST /api/restore/:id'] });
  if (pathname === '/data.json') return new Response('not found', { status: 404 });
  if (pathname.startsWith('/api/restore/')) {
    const headers = init.headers ?? {};
    if ((init.method ?? 'GET') !== 'POST') return json(405, { error: 'METHOD_NOT_ALLOWED' });
    if (headers.Origin) return json(403, { error: 'CROSS_SITE_REQUEST' });
    return json(401, { error: 'LOGIN_REQUIRED', message: '로그인이 필요합니다.' });
  }
  return json(401, { error: 'LOGIN_REQUIRED' });
};

test('자기 점검: 복원 뒤 금지 요청 4건과 정상 요청 2건을 실제로 보내고, 받은 응답대로 적는다', async () => {
  const { results, sent } = await selfCheck(appLike);
  const restoreSent = sent.filter((item) => item.pathname.startsWith('/api/restore/'));
  assert.equal(restoreSent.length, 4, '복원 경로에 금지 요청 4건');
  assert.ok(restoreSent.every((item) => /^\/api\/restore\/[0-9a-f-]{36}$/u.test(item.pathname)), '무작위 메모 ID');
  assert.ok(restoreSent.filter((item) => item.body).every((item) => JSON.parse(item.body).contentSha256 === '0'.repeat(64)), '실제 사본 해시를 쓰지 않음');
  assert.ok(sent.some((item) => item.pathname === '/') && sent.some((item) => item.pathname === '/aleph.json'), '정상 요청 2건');
  const byId = Object.fromEntries(results.map((item) => [item.attackId, item.observed]));
  assert.equal(byId.restore_anonymous_after_restore, '토큰 없이 POST /api/restore/:id이 거부됨 (HTTP 401 LOGIN_REQUIRED)');
  assert.equal(byId.restore_forged_token_after_restore, '엉터리 토큰으로 POST /api/restore/:id이 거부됨 (HTTP 401 LOGIN_REQUIRED)');
  assert.equal(byId.restore_cross_site_after_restore, '다른 사이트 Origin으로 POST /api/restore/:id이 거부됨 (HTTP 403 CROSS_SITE_REQUEST)');
  assert.equal(byId.restore_wrong_method_after_restore, 'GET /api/restore/:id이 거부됨 (HTTP 405 METHOD_NOT_ALLOWED)');
  assert.equal(byId.normal_screen_after_restore, '첫 화면이 열림 (HTTP 200, 자료실 화면 제목 확인)');
  assert.equal(byId.normal_identity_after_restore, '/aleph.json에 step 9과 복원 경로가 실림 (HTTP 200)');
  assert.match(byId.restore_owner_flow_needs_login, /^미실행: /u, '토큰이 필요한 시험은 보내지 않았으므로 미실행');
  assert.ok(!('restore_other_owner_note' in byId), '예전의 미실행 항목은 실제 요청 항목으로 바뀜');
  assert.ok(results.length <= 20 && new Set(results.map((item) => item.attackId)).size === results.length);
  assert.ok(results.every((item) => item.observed.length <= 300 && item.expected.length <= 300));
});

test('자기 점검: 거부되지 않거나 앱이 아닌 곳이 막았거나 배포가 다르면 그대로 적는다(성공으로 바꾸지 않음)', async () => {
  const leaky = await selfCheck((pathname, init) => (pathname.startsWith('/api/restore/')
    ? new Response(JSON.stringify({ id: 'x', restored: true }), { status: 200 }) : appLike(pathname, init)));
  const leakyIds = Object.fromEntries(leaky.results.map((item) => [item.attackId, item.observed]));
  assert.equal(leakyIds.restore_anonymous_after_restore, '토큰 없이 POST /api/restore/:id이 예상대로 거부되지 않음 (HTTP 200)');
  const proxy = await selfCheck((pathname, init) => (pathname.startsWith('/api/restore/') ? new Response('blocked', { status: 403 }) : appLike(pathname, init)));
  assert.match(Object.fromEntries(proxy.results.map((item) => [item.attackId, item.observed])).restore_anonymous_after_restore, /판정 불가/u);
  const stale = await selfCheck((pathname, init) => (pathname === '/aleph.json' ? new Response(JSON.stringify({ step: 8, allowedRoutes: [] }), { status: 200 })
    : pathname === '/' ? new Response('vercel login', { status: 401 }) : appLike(pathname, init)));
  const staleIds = Object.fromEntries(stale.results.map((item) => [item.attackId, item.observed]));
  assert.equal(staleIds.normal_identity_after_restore, '/aleph.json이 현재 설정과 다름 (HTTP 200, step 8)');
  assert.equal(staleIds.normal_screen_after_restore, '첫 화면이 자료실 화면이 아님 (HTTP 401)');
  const down = await selfCheck(() => { throw new TypeError('fetch failed'); }).catch((error) => error);
  assert.ok(down instanceof Error, '네트워크가 아예 안 되면 점검이 실패로 끝나고 결과를 지어내지 않음');
});
