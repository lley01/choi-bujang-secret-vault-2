// 11단계 기기 승인: /api/devices/status·challenge·register·verify 와 메모 API가 쓰는 기기 확인(checkDeviceSession)입니다.
// - 기기 키: 브라우저의 WebAuthn(패스키)으로 만든 ES256 키입니다. 개인키는 기기의 인증 장치 안에만 있고, 서버와 브라우저 저장소에 저장하지 않습니다.
//   서버(public.user_devices)에는 공개키(SPKI)와 자격 ID만 저장합니다.
// - 승인 요청(register): 로그인한 사용자가 이 사이트에서 만든 패스키인지(서버 일회용 챌린지·출처·rpId·사용자 확인 플래그) 확인한 뒤 status='pending' 으로만 저장합니다.
//   이 요청은 권한을 주지 않습니다. 승인은 학생이 SQL Editor에서 status='approved' 로 바꿔야만 됩니다(승인 API 없음).
// - 열기(verify): 서버 챌린지에 대한 그 기기의 서명을 저장된 공개키로 검증하고, DB에서 승인(approved) 상태와 주인을 확인한 뒤에만
//   15분짜리 기기 세션 쿠키(aleph_dev, HttpOnly, 서버 HMAC 서명)를 줍니다.
// - 메모 API는 요청마다 이 쿠키의 서명·만료·사용자를 확인하고 DB에서 그 기기가 지금도 승인 상태인지 다시 확인합니다(승인 취소는 다음 요청부터 반영).
// - 서명 키(HMAC)는 서버 전용 설정 SUPABASE_SECRET_KEY 에서 HKDF로 따로 만듭니다(새 환경변수 없음). 키·토큰·공개키 원문은 로그에 남기지 않습니다.
import { createHash, createHmac, createPublicKey, hkdfSync, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import alephConfig from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from './verify-login.mjs';
import { bearerFromCookie, isCookieToken, readCookie } from './auth-cookies.mjs';

export const DEVICE_COOKIE = 'aleph_dev';
export const CHALLENGE_COOKIE = 'aleph_dch';
export const DEVICE_SESSION_SECONDS = 15 * 60;
const CHALLENGE_SECONDS = 120;
const MAX_DEVICES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const B64URL = /^[A-Za-z0-9_-]+$/u;
const DEVICE_ID = /^[0-9a-f]{16}$/u;
const HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/u;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const fromB64url = (value, max) => (typeof value === 'string' && value.length > 0 && value.length <= max && B64URL.test(value)
  ? Buffer.from(value, 'base64url') : null);
const sha256 = (data) => createHash('sha256').update(data).digest();
export const deviceIdOf = (credentialId) => sha256(Buffer.from(credentialId, 'base64url')).toString('hex').slice(0, 16);

const cookie = (name, value, path, maxAge) => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
export const clearedDeviceCookie = () => cookie(DEVICE_COOKIE, '', '/api', 0);

function signingKey(env, purpose) {
  const secret = env.SUPABASE_SECRET_KEY;
  if (typeof secret !== 'string' || !secret) return null;
  return Buffer.from(hkdfSync('sha256', secret, 'aleph-device-v1', purpose, 32));
}
function seal(key, payload) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(createHmac('sha256', key).update(body).digest())}`;
}
function unseal(key, token, nowSeconds) {
  if (!key || typeof token !== 'string' || !isCookieToken(token)) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload?.v === 1 && Number.isSafeInteger(payload.exp) && payload.exp > nowSeconds ? payload : null;
  } catch {
    return null;
  }
}

// 요청이 온 사이트(호스트)로 WebAuthn의 rpId와 기대 출처를 정합니다. localhost만 http, 나머지는 https.
function siteOf(request) {
  const host = String(request.headers?.host ?? '').toLowerCase();
  if (!HOST.test(host)) return null;
  const rpId = host.replace(/:\d+$/u, '');
  const local = rpId === 'localhost' || rpId === '127.0.0.1';
  return { rpId, origin: `${local ? 'http' : 'https'}://${host}` };
}
function crossSite(request) {
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || !origin) return false;
  if (origin === 'null') return true;
  try { return new URL(origin).host !== request.headers?.host; } catch { return true; }
}
function parseJsonBody(request) {
  let value = request.body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// clientDataJSON: 종류·챌린지·출처가 서버가 기대한 값인지 봅니다.
function checkClientData(raw, { type, challenge, origin }) {
  try {
    const data = JSON.parse(raw.toString('utf8'));
    return data?.type === type && data.challenge === challenge && data.origin === origin && data.crossOrigin !== true;
  } catch {
    return false;
  }
}
// authenticatorData: rpId 해시와 사용자 확인(UP·UV) 플래그를 봅니다.
function readAuthData(raw, rpId) {
  if (!raw || raw.length < 37) return null;
  if (!raw.subarray(0, 32).equals(sha256(rpId))) return null;
  const flags = raw[32];
  if (!(flags & FLAG_UP) || !(flags & FLAG_UV)) return null;
  return { flags, signCount: raw.readUInt32BE(33) };
}
// 등록 때 authenticatorData 안의 자격 ID가 보낸 자격 ID와 같은지 봅니다.
function attestedCredentialId(raw) {
  if (!raw || raw.length < 55 || !(raw[32] & FLAG_AT)) return null;
  const length = raw.readUInt16BE(53);
  return raw.length >= 55 + length ? raw.subarray(55, 55 + length) : null;
}
function p256Key(spki) {
  try {
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
  } catch {
    return null;
  }
}

// 메모·복원 API가 부르는 기기 확인. 쿠키 서명·만료·사용자를 보고, DB에서 지금도 승인 상태인지 다시 확인합니다.
export function createDeviceChecker({ env = process.env, now = () => Date.now() } = {}) {
  return async function checkDeviceSession(request, me, supabase) {
    const key = signingKey(env, 'device-session');
    const token = readCookie(request.headers?.cookie, DEVICE_COOKIE);
    if (!token) return { ok: false, reason: 'no_device_session' };
    const session = unseal(key, token, Math.floor(now() / 1000));
    if (!session || session.u !== me || !DEVICE_ID.test(session.d ?? '')) return { ok: false, reason: 'invalid_device_session' };
    const { data, error } = await supabase.from('user_devices').select('id, status').eq('id', session.d).eq('owner_id', me).maybeSingle();
    if (error) return { ok: false, reason: 'device_lookup_failed' };
    if (data?.status !== 'approved') return { ok: false, reason: data ? `device_${data.status}` : 'device_unknown' };
    return { ok: true, deviceId: session.d };
  };
}

export function createDeviceService({ env = process.env, createSupabase = createClient, loginConfig = alephConfig,
  loginOptions = {}, verifyLogin, now = () => Date.now(), random = (size) => randomBytes(size) } = {}) {
  let verifier = verifyLogin ?? null;
  const getVerifier = () => {
    verifier ??= createLoginVerifier({ config: loginConfig, supabaseSecretKey: env.SUPABASE_SECRET_KEY, ...loginOptions });
    return verifier;
  };
  const checkDeviceSession = createDeviceChecker({ env, now });
  const send = (response, status, body) => response.status(status).json(body);
  const fail = (response, status, error, message) => send(response, status, message ? { error, message } : { error });
  const denied = (reason) => console.warn('DEVICE_DENIED', JSON.stringify({ reason }));
  const nowSeconds = () => Math.floor(now() / 1000);

  async function enter(request, response, method) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== method) {
      response.setHeader('Allow', method);
      fail(response, 405, 'METHOD_NOT_ALLOWED');
      return null;
    }
    if (method === 'POST' && crossSite(request)) {
      denied('cross_site');
      fail(response, 403, 'CROSS_SITE_REQUEST');
      return null;
    }
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) {
      console.error('DEVICE_ENV_MISSING');
      fail(response, 500, 'SERVER_NOT_CONFIGURED');
      return null;
    }
    let identity;
    try {
      identity = await getVerifier()(request.headers?.authorization ?? bearerFromCookie(request.headers?.cookie));
    } catch {
      console.error('DEVICE_AUTH_UNAVAILABLE');
      fail(response, 500, 'AUTH_UNAVAILABLE');
      return null;
    }
    if (!identity || !UUID.test(identity.userId ?? '')) {
      denied('login_required');
      fail(response, 401, 'LOGIN_REQUIRED', '로그인이 필요합니다. 먼저 로그인하세요.');
      return null;
    }
    const site = siteOf(request);
    if (!site) {
      fail(response, 400, 'INVALID_HOST');
      return null;
    }
    let supabase;
    try {
      supabase = createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch {
      console.error('DEVICE_CLIENT_FAILED');
      fail(response, 500, 'DEVICE_UNAVAILABLE');
      return null;
    }
    return { me: identity.userId.toLowerCase(), supabase, site };
  }
  const upstream = (response, name, error) => {
    console.error(name, typeof error?.code === 'string' && /^[A-Z0-9_]{1,10}$/u.test(error.code) ? error.code : 'unknown');
    return fail(response, 500, 'DEVICE_UNAVAILABLE');
  };

  // GET /api/devices/status → { devices: [{ id, status }], current: { id, status: 'approved' } | null }
  async function status(request, response) {
    const entered = await enter(request, response, 'GET');
    if (!entered) return undefined;
    const { me, supabase } = entered;
    const { data, error } = await supabase.from('user_devices').select('id, status').eq('owner_id', me)
      .order('created_at', { ascending: false }).limit(10);
    if (error || !Array.isArray(data)) return upstream(response, 'DEVICE_STATUS_FAILED', error);
    const current = await checkDeviceSession(request, me, supabase);
    return send(response, 200, { devices: data.map(({ id, status: state }) => ({ id, status: state })),
      current: current.ok ? { id: current.deviceId, status: 'approved' } : null });
  }

  // POST /api/devices/challenge { purpose: 'register' | 'unlock' } → WebAuthn에 넘길 일회용 챌린지(HttpOnly 쿠키에 서버 서명으로 묶음)
  async function challenge(request, response) {
    const entered = await enter(request, response, 'POST');
    if (!entered) return undefined;
    const { me, supabase, site } = entered;
    const purpose = parseJsonBody(request)?.purpose;
    if (purpose !== 'register' && purpose !== 'unlock') return fail(response, 400, 'INVALID_PURPOSE');
    const value = b64url(random(32));
    const body = { challenge: value, rpId: site.rpId };
    if (purpose === 'register') {
      const { data, error } = await supabase.from('user_devices').select('id, status').eq('owner_id', me).in('status', ['pending', 'approved']);
      if (error || !Array.isArray(data)) return upstream(response, 'DEVICE_LIST_FAILED', error);
      if (data.length >= MAX_DEVICES) return fail(response, 409, 'TOO_MANY_DEVICES', `기기는 ${MAX_DEVICES}대까지 요청할 수 있습니다.`);
      // 사용자 핸들은 이메일·실명이 아닌 가명(사용자 ID의 해시 일부)입니다.
      body.user = { id: b64url(sha256(`aleph-device-user:${me}`).subarray(0, 16)), name: 'byteback-device', displayName: '내 자료실 기기' };
      body.rpName = 'BYTE BACK 내 자료실';
    } else {
      const { data, error } = await supabase.from('user_devices').select('credential_id').eq('owner_id', me).eq('status', 'approved').limit(MAX_DEVICES);
      if (error || !Array.isArray(data)) return upstream(response, 'DEVICE_LIST_FAILED', error);
      if (!data.length) return fail(response, 409, 'NO_APPROVED_DEVICE', '승인된 기기가 없습니다. 먼저 승인을 요청하고 승인을 기다리세요.');
      body.allowCredentials = data.map((row) => row.credential_id);
    }
    const sealed = seal(signingKey(env, 'device-challenge'), { v: 1, u: me, p: purpose, c: value, exp: nowSeconds() + CHALLENGE_SECONDS });
    response.setHeader('Set-Cookie', cookie(CHALLENGE_COOKIE, sealed, '/api/devices', CHALLENGE_SECONDS));
    return send(response, 200, body);
  }

  function takeChallenge(request, response, me, purpose) {
    response.setHeader('Set-Cookie', cookie(CHALLENGE_COOKIE, '', '/api/devices', 0));
    const sealed = unseal(signingKey(env, 'device-challenge'), readCookie(request.headers?.cookie, CHALLENGE_COOKIE), nowSeconds());
    return sealed && sealed.u === me && sealed.p === purpose ? sealed.c : null;
  }

  // POST /api/devices/register { credentialId, publicKey, authenticatorData, clientDataJSON } → 201 { id, status: 'pending' }
  async function register(request, response) {
    const entered = await enter(request, response, 'POST');
    if (!entered) return undefined;
    const { me, supabase, site } = entered;
    const input = parseJsonBody(request) ?? {};
    const credentialId = fromB64url(input.credentialId, 1366);
    const spki = fromB64url(input.publicKey, 400);
    const authData = fromB64url(input.authenticatorData, 4096);
    const clientData = fromB64url(input.clientDataJSON, 4096);
    const expected = takeChallenge(request, response, me, 'register');
    if (!expected) { denied('challenge_missing'); return fail(response, 400, 'CHALLENGE_EXPIRED', '요청 시간이 지났습니다. 다시 시도하세요.'); }
    if (!credentialId || credentialId.length < 16 || !spki || !authData || !clientData) return fail(response, 400, 'INVALID_DEVICE_DATA');
    if (!checkClientData(clientData, { type: 'webauthn.create', challenge: expected, origin: site.origin })
        || !readAuthData(authData, site.rpId) || !attestedCredentialId(authData)?.equals(credentialId) || !p256Key(spki)) {
      denied('registration_check_failed');
      return fail(response, 400, 'DEVICE_CHECK_FAILED', '이 기기의 키를 확인하지 못했습니다.');
    }
    const id = deviceIdOf(b64url(credentialId));
    const { error } = await supabase.from('user_devices').insert({
      id, owner_id: me, credential_id: b64url(credentialId), public_key_spki: b64url(spki),
    });
    if (error?.code === '23505') return fail(response, 409, 'DEVICE_EXISTS');
    if (error) return upstream(response, 'DEVICE_REGISTER_FAILED', error);
    // 승인 대기로만 저장합니다. 이 응답은 권한을 주지 않습니다(기기 세션 쿠키 없음).
    return send(response, 201, { id, status: 'pending' });
  }

  // POST /api/devices/verify { credentialId, authenticatorData, clientDataJSON, signature } → 승인된 기기의 서명이면 200 + 기기 세션 쿠키
  async function verify(request, response) {
    const entered = await enter(request, response, 'POST');
    if (!entered) return undefined;
    const { me, supabase, site } = entered;
    const input = parseJsonBody(request) ?? {};
    const credentialId = typeof input.credentialId === 'string' && B64URL.test(input.credentialId) ? input.credentialId : null;
    const authData = fromB64url(input.authenticatorData, 4096);
    const clientData = fromB64url(input.clientDataJSON, 4096);
    const signature = fromB64url(input.signature, 256);
    const expected = takeChallenge(request, response, me, 'unlock');
    const deny = (reason) => {
      denied(reason);
      return fail(response, 403, 'DEVICE_NOT_APPROVED', '이 기기는 서버에서 승인된 기기로 확인되지 않았습니다.');
    };
    if (!expected) { denied('challenge_missing'); return fail(response, 400, 'CHALLENGE_EXPIRED', '요청 시간이 지났습니다. 다시 시도하세요.'); }
    if (!credentialId || !authData || !clientData || !signature) return fail(response, 400, 'INVALID_DEVICE_DATA');
    const auth = readAuthData(authData, site.rpId);
    if (!auth || !checkClientData(clientData, { type: 'webauthn.get', challenge: expected, origin: site.origin })) return deny('assertion_check_failed');
    const { data: device, error } = await supabase.from('user_devices')
      .select('id, owner_id, public_key_spki, status, sign_count').eq('credential_id', credentialId).maybeSingle();
    if (error) return upstream(response, 'DEVICE_LOOKUP_FAILED', error);
    if (!device || String(device.owner_id).toLowerCase() !== me) return deny('device_unknown');
    if (device.status !== 'approved') return deny(`device_${device.status}`);
    const key = p256Key(Buffer.from(device.public_key_spki, 'base64url'));
    const signed = Buffer.concat([authData, sha256(clientData)]);
    if (!key || !verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, signature)) return deny('signature_invalid');
    const previous = Number(device.sign_count) || 0;
    if (auth.signCount !== 0 || previous !== 0) {
      if (auth.signCount <= previous) return deny('sign_count_replay');
    }
    const { error: updateError } = await supabase.from('user_devices')
      .update({ sign_count: auth.signCount, last_used_at: new Date(now()).toISOString() })
      .eq('id', device.id).eq('owner_id', me).eq('status', 'approved');
    if (updateError) return upstream(response, 'DEVICE_UPDATE_FAILED', updateError);
    const session = seal(signingKey(env, 'device-session'), { v: 1, u: me, d: device.id, exp: nowSeconds() + DEVICE_SESSION_SECONDS });
    response.setHeader('Set-Cookie', [cookie(CHALLENGE_COOKIE, '', '/api/devices', 0), cookie(DEVICE_COOKIE, session, '/api', DEVICE_SESSION_SECONDS)]);
    return send(response, 200, { id: device.id, status: 'approved' });
  }

  async function route(request, response) {
    const action = typeof request.url === 'string' ? /^\/api\/devices\/([a-z]+)\/?(?:[?#]|$)/u.exec(request.url)?.[1] : undefined;
    const handlers = new Map([['status', status], ['challenge', challenge], ['register', register], ['verify', verify]]);
    const handler = handlers.get(action ?? (typeof request.query?.action === 'string' ? request.query.action : ''));
    if (handler) return handler(request, response);
    response.setHeader('Cache-Control', 'no-store');
    return fail(response, 404, 'NOT_FOUND');
  }

  return { status, challenge, register, verify, route };
}
