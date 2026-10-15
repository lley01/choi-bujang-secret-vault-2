// 10단계: 비공개 가상 메모 사본에서 지정한 한 건만 복원합니다. 서비스 restore, 경로 POST /api/restore/:id
// - 로그인: 메모 API와 같은 검사기(src/verify-login.mjs)로 Authorization 헤더 또는 HttpOnly 쿠키의 토큰을 검사합니다.
// - 대조: DB 함수 public.restore_note_from_backup 이 한 트랜잭션에서
//   ① 사본의 ID = 경로의 ID, ② 사본의 소유자 = 로그인 검사로 확인한 사용자, ③ 사본 내용을 다시 계산한 해시 = 사본에 저장된 해시 = 요청 본문의 contentSha256
//   을 모두 확인한 뒤 그 한 건만 되돌리고, 결과와 관계없이 감사 기록(notes_restore_audit)에 한 줄을 덧붙입니다.
//   지금 메모의 주인이 다른 사람이면 덮어쓰지 않습니다. 다른 메모와 기존 감사 기록은 건드리지 않습니다.
// - 요청 본문에서는 contentSha256 만 읽습니다. 제목·본문·owner_id·role 은 읽지 않습니다(복원 내용은 사본에서만 가져옴).
// - 사본이 없거나 남의 사본·남의 메모면 있다는 사실도 알리지 않도록 404로 답합니다. 로그에는 짧은 사유만 남기고 ID·토큰·본문은 남기지 않습니다.
import { createClient } from '@supabase/supabase-js';
import alephConfig from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from './verify-login.mjs';
import { bearerFromCookie } from './auth-cookies.mjs';
import { RESOURCE_HEADER, RESOURCES } from './resources.mjs';
import { createDeviceChecker } from './device-service.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const LOGIN_REQUIRED_BODY = Object.freeze({ error: 'LOGIN_REQUIRED', message: '로그인이 필요합니다. 유효한 로그인 토큰과 함께 요청해 주세요.' });
// DB 함수의 결과 → 응답. 남의 것이거나 없는 것은 모두 404로 같게 답합니다.
const OUTCOMES = Object.freeze({
  restored: [200, null],
  backup_not_found: [404, 'NOT_FOUND'],
  owner_mismatch: [404, 'NOT_FOUND'],
  note_owner_mismatch: [404, 'NOT_FOUND'],
  backup_hash_mismatch: [409, 'BACKUP_INTEGRITY_FAILED'],
  requested_hash_mismatch: [409, 'HASH_MISMATCH'],
});

function parseJsonBody(request) {
  let value = request.body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readPathId(request) {
  const fromUrl = typeof request.url === 'string' ? /^\/api\/restore\/([^/?#]+)\/?(?:[?#]|$)/u.exec(request.url)?.[1] : undefined;
  if (fromUrl !== undefined) return fromUrl;
  return typeof request.query?.id === 'string' ? request.query.id : undefined;
}

// 다른 사이트에서 보낸 요청이면 막습니다(Origin 헤더가 있고 우리 호스트와 다를 때).
function crossSite(request) {
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || !origin) return false;
  if (origin === 'null') return true;
  try { return new URL(origin).host !== request.headers?.host; } catch { return true; }
}

export function createRestoreService({ env = process.env, createSupabase = createClient,
  loginConfig = alephConfig, loginOptions = {}, verifyLogin, checkDevice = createDeviceChecker({ env }) } = {}) {
  let verifier = verifyLogin ?? null;
  const getVerifier = () => {
    verifier ??= createLoginVerifier({ config: loginConfig, supabaseSecretKey: env.SUPABASE_SECRET_KEY, ...loginOptions });
    return verifier;
  };
  const fail = (response, status, error) => response.status(status).json({ error });
  const denied = (reason) => console.warn('RESTORE_DENIED', JSON.stringify({ reason }));

  // POST /api/restore/:id  { contentSha256 }
  async function restore(request, response) {
    response.setHeader(RESOURCE_HEADER, RESOURCES.NOTE);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Authorization');
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return fail(response, 405, 'METHOD_NOT_ALLOWED');
    }
    if (crossSite(request)) {
      denied('cross_site');
      return fail(response, 403, 'CROSS_SITE_REQUEST');
    }
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) {
      console.error('RESTORE_ENV_MISSING');
      return fail(response, 500, 'SERVER_NOT_CONFIGURED');
    }
    let identity;
    try {
      identity = await getVerifier()(request.headers?.authorization ?? bearerFromCookie(request.headers?.cookie));
    } catch {
      console.error('RESTORE_AUTH_UNAVAILABLE');
      return fail(response, 500, 'AUTH_UNAVAILABLE');
    }
    if (!identity) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      denied('login_required');
      return response.status(401).json({ ...LOGIN_REQUIRED_BODY });
    }
    if (!UUID.test(identity.userId ?? '')) {
      console.error('RESTORE_USER_ID_INVALID');
      return fail(response, 500, 'AUTH_UNAVAILABLE');
    }
    const rawId = readPathId(request);
    if (typeof rawId !== 'string' || !UUID.test(rawId)) return fail(response, 400, 'INVALID_ID');
    const input = parseJsonBody(request);
    if (!input) return fail(response, 400, 'INVALID_JSON');
    if (typeof input.contentSha256 !== 'string' || !SHA256.test(input.contentSha256)) return fail(response, 400, 'INVALID_HASH');
    const id = rawId.toLowerCase();
    let outcome;
    try {
      const supabase = createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      // 11단계: 화면(학생 로그인)으로 온 복원 요청도 서버가 승인한 기기 세션이 있어야 합니다(심판 토큰은 반 엔진이 기기를 확인).
      if (identity.kind !== 'judge') {
        const gate = await checkDevice(request, identity.userId.toLowerCase(), supabase).catch(() => ({ ok: false, reason: 'device_check_failed' }));
        if (!gate?.ok) {
          denied(gate?.reason ?? 'device_unknown');
          return fail(response, 403, 'DEVICE_NOT_APPROVED');
        }
      }
      const { data, error } = await supabase.rpc('restore_note_from_backup', {
        p_note_id: id, p_owner_id: identity.userId.toLowerCase(), p_content_sha256: input.contentSha256,
      });
      if (error) {
        console.error('RESTORE_FAILED', typeof error.code === 'string' && /^[A-Z0-9_]{1,10}$/u.test(error.code) ? error.code : 'unknown');
        return fail(response, 500, 'RESTORE_UNAVAILABLE');
      }
      outcome = data;
    } catch {
      console.error('RESTORE_FAILED', 'unknown');
      return fail(response, 500, 'RESTORE_UNAVAILABLE');
    }
    const mapped = OUTCOMES[outcome];
    if (!mapped) {
      console.error('RESTORE_FAILED', 'unexpected_outcome');
      return fail(response, 500, 'RESTORE_UNAVAILABLE');
    }
    const [status, error] = mapped;
    if (error) {
      denied(outcome);
      return fail(response, status, error);
    }
    return response.status(200).json({ id, restored: true });
  }

  return { restore };
}
