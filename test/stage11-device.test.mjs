import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEVICE_COOKIE, createDeviceChecker, createDeviceService, deviceIdOf } from '../src/device-service.mjs';
import { createNotesService } from '../src/notes-service.mjs';
import { createRestoreService } from '../src/restore-service.mjs';
import { FAKE_ENV, createFakeStore, fakeResponse, withCapturedErrors } from './helpers/fakes.mjs';
import { judgeToken, loginConfig, loginOptions, studentToken } from './helpers/login-fixtures.mjs';

// 11단계 기기 승인. 실제 P-256 키로 패스키(WebAuthn)의 등록·서명 과정을 흉내 내 서버 검증을 시험합니다. 심판 판정이 아닙니다.
const HOST = 'app.vercel.app';
const ORIGIN = `https://${HOST}`;
const sha256 = (data) => createHash('sha256').update(data).digest();
const b64 = (data) => Buffer.from(data).toString('base64url');

// user_devices 테이블만 흉내 내는 가짜 DB(select·eq·in·order·limit·maybeSingle·insert·update).
function deviceTable() {
  const rows = [];
  class Query {
    constructor() { this.op = 'select'; this.filters = []; this.single = false; this.columns = null; this.payload = null; this.max = null; }
    select(columns) { this.columns = columns; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    in(column, values) { this.filters.push((row) => values.includes(row[column])); return this; }
    order() { return this; }
    limit(count) { this.max = count; return this; }
    maybeSingle() { this.single = true; return this; }
    then(resolve, reject) { return Promise.resolve(this.run()).then(resolve, reject); }
    pick(row) { return this.columns ? Object.fromEntries(this.columns.split(',').map((c) => c.trim()).map((c) => [c, row[c]])) : { ...row }; }
    run() {
      if (this.op === 'insert') {
        if (rows.some((row) => row.id === this.payload.id || row.credential_id === this.payload.credential_id)) return { data: null, error: { code: '23505' } };
        rows.push({ status: 'pending', sign_count: 0, created_at: rows.length, ...this.payload });
        return { data: null, error: null };
      }
      const hit = rows.filter((row) => this.filters.every((f) => f(row)));
      if (this.op === 'update') { hit.forEach((row) => Object.assign(row, this.payload)); return { data: null, error: null }; }
      const data = hit.slice(0, this.max ?? hit.length).map((row) => this.pick(row));
      return { data: this.single ? (data[0] ?? null) : data, error: null };
    }
  }
  return { rows, from: () => new Query() };
}
// 메모(notes)는 기존 가짜 저장소, 기기(user_devices)는 위 가짜 DB를 씁니다.
function world() {
  const notes = createFakeStore();
  const devices = deviceTable();
  const createSupabase = (...args) => {
    const client = notes.createSupabase(...args);
    return { ...client, from: (table) => (table === 'user_devices' ? devices.from(table) : client.from(table)) };
  };
  let clock = Date.parse('2026-10-15T05:00:00Z');
  const now = () => clock;
  const options = { env: FAKE_ENV, createSupabase, loginConfig, loginOptions, now };
  const checkDevice = createDeviceChecker({ env: FAKE_ENV, now }); // 메모·복원 API의 실제 기기 확인(같은 가짜 시계)
  return { notes, devices, now, tick: (ms) => { clock += ms; },
    device: createDeviceService(options), notesApi: createNotesService({ ...options, checkDevice }), restoreApi: createRestoreService({ ...options, checkDevice }) };
}

const cookiesOf = (out) => [out.headers.get('set-cookie') ?? []].flat();
const cookieValue = (out, name) => cookiesOf(out).map((c) => new RegExp(`^${name}=([^;]*);`).exec(c)?.[1]).find((v) => v !== undefined);
async function call(handler, { method = 'GET', url, user, cookies = {}, body, headers = {} }) {
  const cookie = Object.entries({ ...(user ? { aleph_at: user.token } : {}), ...cookies }).map(([k, v]) => `${k}=${v}`).join('; ');
  const { response, out } = fakeResponse();
  const logs = await withCapturedErrors(() => handler({ method, url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...headers }, body }, response));
  return { ...out, logs };
}
const newUser = () => { const id = crypto.randomUUID(); return { id, token: studentToken(id) }; };

// 이 기기의 인증 장치(패스키) 흉내: 개인키는 이 객체 안에만 있고 서버로 보내지 않습니다.
function authenticator({ rpId = HOST, origin = ORIGIN } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = randomBytes(32);
  let counter = 0;
  const flagsAndCount = (flags) => { const b = Buffer.alloc(5); b[0] = flags; b.writeUInt32BE(counter, 1); return b; };
  return {
    credentialId: b64(credentialId),
    create(challenge, over = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: over.origin ?? origin }));
      const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([sha256(over.rpId ?? rpId), flagsAndCount(over.flags ?? 0x45), Buffer.alloc(16), idLen, over.attestedId ?? credentialId, Buffer.from([0xa5])]);
      return { credentialId: b64(credentialId), publicKey: b64(over.spki ?? publicKey.export({ type: 'spki', format: 'der' })),
        authenticatorData: b64(authData), clientDataJSON: b64(clientData) };
    },
    get(challenge, over = {}) {
      counter += over.sameCounter ? 0 : 1;
      const clientData = Buffer.from(JSON.stringify({ type: over.type ?? 'webauthn.get', challenge, origin: over.origin ?? origin }));
      const authData = Buffer.concat([sha256(over.rpId ?? rpId), flagsAndCount(over.flags ?? 0x05)]);
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), over.key ?? privateKey);
      return { credentialId: b64(credentialId), authenticatorData: b64(authData), clientDataJSON: b64(clientData), signature: b64(signature) };
    },
  };
}
async function challenge(w, user, purpose) {
  const out = await call(w.device.route, { method: 'POST', url: '/api/devices/challenge', user, body: { purpose } });
  return { out, value: out.body?.challenge, cookie: cookieValue(out, 'aleph_dch') };
}
async function requestApproval(w, user, key, over) {
  const ch = await challenge(w, user, 'register');
  return call(w.device.route, { method: 'POST', url: '/api/devices/register', user, cookies: { aleph_dch: ch.cookie }, body: key.create(ch.value, over) });
}
async function unlock(w, user, key, over) {
  const ch = await challenge(w, user, 'unlock');
  if (ch.out.status !== 200) return ch.out;
  return call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, cookies: { aleph_dch: ch.cookie }, body: key.get(ch.value, over) });
}
const approveInSql = (w, id) => { const row = w.devices.rows.find((r) => r.id === id && r.status === 'pending'); if (row) { row.status = 'approved'; row.approved_at = 'now'; } };
const notesWith = (w, user, deviceCookie) => call(w.notesApi.collection, { url: '/api/notes', user, cookies: deviceCookie ? { [DEVICE_COOKIE]: deviceCookie } : {} });

test('승인 요청은 대기(pending)로만 저장되고, 요청 버튼만으로는 자료실이 열리지 않는다', async () => {
  const w = world();
  const user = newUser();
  const key = authenticator();
  assert.equal((await notesWith(w, user)).status, 403, '승인 전에는 보호 자료 없음');
  const out = await requestApproval(w, user, key);
  assert.equal(out.status, 201);
  assert.deepEqual(out.body, { id: deviceIdOf(key.credentialId), status: 'pending' });
  assert.equal(cookieValue(out, DEVICE_COOKIE), undefined, '요청 응답은 기기 세션을 주지 않음');
  assert.deepEqual(w.devices.rows.map((r) => [r.owner_id, r.status]), [[user.id, 'pending']]);
  assert.ok(!('private_key' in w.devices.rows[0]) && w.devices.rows[0].public_key_spki.length > 60, '공개키만 저장');
  const blocked = await notesWith(w, user);
  assert.deepEqual([blocked.status, blocked.body.error], [403, 'DEVICE_NOT_APPROVED']);
  assert.ok(!JSON.stringify(blocked.body).includes('title'), '403 응답에 자료 없음');
  const status = await call(w.device.route, { url: '/api/devices/status', user });
  assert.deepEqual(status.body, { devices: [{ id: deviceIdOf(key.credentialId), status: 'pending' }], current: null });
  const early = await unlock(w, user, key);
  assert.deepEqual([early.status, early.body.error], [409, 'NO_APPROVED_DEVICE'], '승인 전에는 열 수 없음');
});

test('서버(SQL)에서 승인한 뒤 그 기기가 서명하면 기기 세션이 생기고, 그때만 자료실이 열린다', async () => {
  const w = world();
  const user = newUser();
  const key = authenticator();
  const id = (await requestApproval(w, user, key)).body.id;
  approveInSql(w, id);
  const opened = await unlock(w, user, key);
  assert.deepEqual([opened.status, opened.body], [200, { id, status: 'approved' }]);
  const session = cookieValue(opened, DEVICE_COOKIE);
  assert.ok(session && cookiesOf(opened).some((c) => /^aleph_dev=.+; Path=\/api; Max-Age=900; HttpOnly; Secure; SameSite=Strict$/u.test(c)));
  const notes = await notesWith(w, user, session);
  assert.deepEqual([notes.status, notes.body], [200, []]);
  const status = await call(w.device.route, { url: '/api/devices/status', user, cookies: { [DEVICE_COOKIE]: session } });
  assert.deepEqual(status.body.current, { id, status: 'approved' });
  assert.equal(w.devices.rows[0].sign_count, 1, '서명 횟수 기록');
});

test('승인을 취소하면 다음 요청부터 바로 막히고, 기기 세션은 15분 뒤 끝난다', async () => {
  const w = world();
  const user = newUser();
  const key = authenticator();
  const id = (await requestApproval(w, user, key)).body.id;
  approveInSql(w, id);
  const session = cookieValue(await unlock(w, user, key), DEVICE_COOKIE);
  w.devices.rows[0].status = 'revoked';
  const revoked = await notesWith(w, user, session);
  assert.deepEqual([revoked.status, revoked.body.error], [403, 'DEVICE_NOT_APPROVED']);
  assert.match(revoked.logs.join('\n'), /NOTES_DEVICE_REQUIRED .*"reason":"device_revoked"/u);
  w.devices.rows[0].status = 'approved';
  assert.equal((await notesWith(w, user, session)).status, 200);
  w.tick(15 * 60 * 1000 + 1000);
  assert.equal((await notesWith(w, user, session)).status, 403, '만료');
});

test('다른 기기·다른 사용자·위조한 세션으로는 열리지 않는다', async () => {
  const w = world();
  const a = newUser();
  const b = newUser();
  const keyA = authenticator();
  approveInSql(w, (await requestApproval(w, a, keyA)).body.id);
  const sessionA = cookieValue(await unlock(w, a, keyA), DEVICE_COOKIE);
  assert.equal((await notesWith(w, b, sessionA)).status, 403, 'A의 기기 세션을 B 로그인에 쓰면 거부');
  const [body, mac] = sessionA.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), u: b.id })).toString('base64url');
  assert.equal((await notesWith(w, b, `${forgedBody}.${mac}`)).status, 403, '내용을 바꾸면 서버 서명이 맞지 않음');
  assert.equal((await notesWith(w, a, `${body}.${b64(randomBytes(32))}`)).status, 403);
  const otherKey = authenticator();
  const stolen = await unlock(w, a, otherKey);
  assert.deepEqual([stolen.status, stolen.body.error], [403, 'DEVICE_NOT_APPROVED'], '등록되지 않은 다른 기기의 서명');
  const keyB = authenticator();
  approveInSql(w, (await requestApproval(w, b, keyB)).body.id);
  const crossed = await unlock(w, a, keyB);
  assert.equal(crossed.status, 403, 'B의 승인 기기는 A로 열 수 없음');
});

test('서명 검증: 틀린 서명·출처·rpId·사용자 확인 없음·챌린지 재사용·서명 횟수 되돌림은 거부한다', async () => {
  const w = world();
  const user = newUser();
  const key = authenticator();
  approveInSql(w, (await requestApproval(w, user, key)).body.id);
  const { privateKey: wrongKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const over of [{ key: wrongKey }, { origin: 'https://evil.example' }, { rpId: 'evil.example' }, { flags: 0x01 }, { type: 'webauthn.create' }]) {
    const out = await unlock(w, user, key, over);
    assert.equal(out.status, 403, JSON.stringify(Object.keys(over)));
    assert.equal(cookieValue(out, DEVICE_COOKIE), undefined);
  }
  const ch = await challenge(w, user, 'unlock');
  const first = await call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, cookies: { aleph_dch: ch.cookie }, body: key.get(ch.value) });
  assert.equal(first.status, 200);
  const replay = await call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, cookies: { aleph_dch: ch.cookie }, body: key.get(ch.value, { sameCounter: true }) });
  assert.equal(replay.status, 403, '같은 서명 횟수 되돌림');
  const wrongChallenge = await call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, cookies: { aleph_dch: ch.cookie }, body: key.get('AAAA') });
  assert.equal(wrongChallenge.status, 403);
  const noChallenge = await call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, body: key.get(ch.value) });
  assert.deepEqual([noChallenge.status, noChallenge.body.error], [400, 'CHALLENGE_EXPIRED']);
  const other = newUser();
  const otherCh = await challenge(w, other, 'register');
  const borrowed = await call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, cookies: { aleph_dch: otherCh.cookie }, body: key.get(otherCh.value) });
  assert.equal(borrowed.status, 400, '다른 사용자·다른 목적의 챌린지');
  const late = await challenge(w, user, 'unlock');
  w.tick(121 * 1000);
  const expired = await call(w.device.route, { method: 'POST', url: '/api/devices/verify', user, cookies: { aleph_dch: late.cookie }, body: key.get(late.value) });
  assert.equal(expired.status, 400, '2분 지난 챌린지');
});

test('승인 요청 검사: 이 사이트의 패스키가 아니거나 형식이 틀리면 저장하지 않는다', async () => {
  const w = world();
  const user = newUser();
  const key = authenticator();
  const { publicKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const over of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { flags: 0x41 }, { attestedId: randomBytes(32) }, { spki: rsa.export({ type: 'spki', format: 'der' }) }]) {
    const out = await requestApproval(w, user, key, over);
    assert.equal(out.status, 400, JSON.stringify(Object.keys(over)));
  }
  assert.equal(w.devices.rows.length, 0);
  const ch = await challenge(w, user, 'register');
  const wrongType = key.create(ch.value);
  wrongType.clientDataJSON = b64(JSON.stringify({ type: 'webauthn.get', challenge: ch.value, origin: ORIGIN }));
  assert.equal((await call(w.device.route, { method: 'POST', url: '/api/devices/register', user, cookies: { aleph_dch: ch.cookie }, body: wrongType })).status, 400);
  assert.equal((await call(w.device.route, { method: 'POST', url: '/api/devices/challenge', body: { purpose: 'register' } })).status, 401, '로그인 없음');
  assert.equal((await call(w.device.route, { method: 'POST', url: '/api/devices/challenge', user, body: { purpose: 'register' }, headers: { origin: 'https://evil.example' } })).status, 403, '다른 사이트');
  assert.equal((await call(w.device.route, { method: 'POST', url: '/api/devices/challenge', user, body: { purpose: 'approve' } })).status, 400, '승인 목적은 없음');
  assert.equal((await call(w.device.route, { url: '/api/devices/approve', user })).status, 404, '승인 API 없음');
  assert.equal((await call(w.device.route, { url: '/api/devices/constructor', user })).status, 404);
  for (let i = 0; i < 5; i += 1) assert.equal((await requestApproval(w, user, authenticator())).status, 201);
  assert.deepEqual((await challenge(w, user, 'register')).out.body.error, 'TOO_MANY_DEVICES');
});

test('복원 API도 화면 로그인에는 승인 기기 세션을 요구하고, 심판 토큰은 반 엔진의 기기 확인을 따른다', async () => {
  const w = world();
  const user = newUser();
  const restore = await call(w.restoreApi.restore, { method: 'POST', url: `/api/restore/${crypto.randomUUID()}`, user, body: { contentSha256: '0'.repeat(64) } });
  assert.deepEqual([restore.status, restore.body.error], [403, 'DEVICE_NOT_APPROVED']);
  const judge = { authorization: `Bearer ${await judgeToken({ sub: crypto.randomUUID(), identity: 'a' })}` };
  const judged = await call(w.notesApi.collection, { url: '/api/notes', headers: judge });
  assert.equal(judged.status, 200, '심판 요청은 반 엔진이 기기 등록을 먼저 확인(판정기 device_registered)');
});

test('로그와 응답에 기기 키·서명·세션 원문을 남기지 않는다', async () => {
  const w = world();
  const user = newUser();
  const key = authenticator();
  const reg = await requestApproval(w, user, key);
  approveInSql(w, reg.body.id);
  const bad = await unlock(w, user, key, { origin: 'https://evil.example' });
  const good = await unlock(w, user, key);
  const session = cookieValue(good, DEVICE_COOKIE);
  const seen = JSON.stringify([reg.body, reg.logs, bad.body, bad.logs, good.body, good.logs]);
  for (const secret of [w.devices.rows[0].public_key_spki, key.credentialId, session, user.token]) assert.ok(!seen.includes(secret));
  assert.deepEqual(bad.logs, ['DEVICE_DENIED {"reason":"assertion_check_failed"}']);
});

test('화면: 기기 키를 브라우저 저장소에 넣지 않고, 승인 버튼은 서버 요청만 보낸다', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = page.slice(page.indexOf('<script>'));
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|caches\.|document\.cookie|exportKey|generateKey|crypto\.subtle/u);
  assert.match(script, /navigator\.credentials\.create\(\{ publicKey: \{/u);
  assert.match(script, /authenticatorSelection: \{ authenticatorAttachment: 'platform', residentKey: 'discouraged', userVerification: 'required' \}/u);
  const requestHandler = script.slice(script.indexOf("deviceRequest.addEventListener('click'"), script.indexOf("deviceUnlock.addEventListener('click'"));
  assert.doesNotMatch(requestHandler, /deviceConfirmed|승인됨|applyAccess\(\)|loadNotes/u, '요청 버튼은 승인 상태를 바꾸지 않음');
  assert.match(requestHandler, /postDevice\('\/api\/devices\/register'/u);
  const access = script.slice(script.indexOf('function applyAccess()'), script.indexOf('const webauthnReady'));
  assert.match(access, /if \(currentEmail && deviceConfirmed\) \{\s+noteForm\.hidden = false;\s+loadNotes\(\);/u, '서버가 확인한 뒤에만 자료 요청');
  assert.match(script, /refreshDevice\(\)\.then\(applyAccess\);/u);
});

test('화면 스크립트가 문법 오류 없이 실행될 수 있다(같은 이름 선언 겹침 등)', () => {
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = page.slice(page.indexOf('<script>') + '<script>'.length, page.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(script));
});
