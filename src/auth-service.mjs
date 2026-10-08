// 로그인·로그아웃 서버 함수(/api/auth/login, /api/auth/session, /api/auth/logout)의 공통 로직입니다.
// Supabase Auth는 서버에서만 부르고, 서버 전용 설정(SUPABASE_URL, SUPABASE_SECRET_KEY)만 씁니다. 화면 코드에는 키가 없습니다.
// 로그인 토큰은 HttpOnly 쿠키로만 브라우저에 두고, 응답 본문과 로그에는 넣지 않습니다. 이메일·비밀번호도 기록하지 않습니다.
import { createClient } from '@supabase/supabase-js';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearedCookies, isCookieToken, readCookie, sessionCookies } from './auth-cookies.mjs';

const LOGIN_REQUIRED_BODY = Object.freeze({ error: 'LOGIN_REQUIRED', message: '로그인이 필요합니다. 먼저 로그인하세요.' });

// Supabase Auth 오류 코드 → 화면에 보일 이유
const REASONS = {
  invalid_credentials: '이메일 또는 비밀번호가 맞지 않습니다.',
  email_not_confirmed: '이메일 인증이 아직 끝나지 않았습니다. 받은 편지함의 인증 메일을 먼저 확인하세요.',
  user_banned: '이 계정은 지금 사용할 수 없습니다.',
  validation_failed: '이메일 또는 비밀번호 형식이 올바르지 않습니다.',
  over_request_rate_limit: '요청이 너무 많습니다. 잠시 뒤에 다시 시도하세요.',
  email_provider_disabled: 'Supabase에서 이메일 로그인이 꺼져 있습니다. 프로젝트의 Auth 설정을 확인하세요.',
};
const safeCode = (value) => (typeof value === 'string' && /^[a-z0-9_]{1,60}$/u.test(value) ? value : undefined);
const isNetworkError = (error) => error?.name === 'AuthRetryableFetchError' || error?.status === 0 || error?.status >= 500;

function parseJsonBody(request) {
  let value = request.body;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// 다른 사이트에서 보낸 요청이면 막습니다(Origin 헤더가 있고 우리 호스트와 다를 때).
function crossSite(request) {
  const origin = request.headers?.origin;
  if (typeof origin !== 'string' || !origin || origin === 'null') return origin === 'null';
  try { return new URL(origin).host !== request.headers?.host; } catch { return true; }
}

function readAction(request) {
  const fromUrl = typeof request.url === 'string' ? /^\/api\/auth\/([a-z]+)\/?(?:[?#]|$)/u.exec(request.url)?.[1] : undefined;
  return fromUrl ?? (typeof request.query?.action === 'string' ? request.query.action : undefined);
}

export function createAuthService({ env = process.env, createSupabase = createClient } = {}) {
  const send = (response, status, body) => response.status(status).json(body);
  const fail = (response, status, error, message, code) => send(response, status, code ? { error, code, message } : { error, message });

  function start(request, response, method) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== method) {
      response.setHeader('Allow', method);
      fail(response, 405, 'METHOD_NOT_ALLOWED', '서버가 이 요청 방법을 받지 않습니다.');
      return false;
    }
    return true;
  }
  function client(response) {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) {
      console.error('AUTH_ENV_MISSING');
      fail(response, 500, 'SERVER_NOT_CONFIGURED', '서버 설정이 아직 끝나지 않았습니다.');
      return null;
    }
    try {
      return createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    } catch {
      console.error('AUTH_CLIENT_FAILED');
      fail(response, 500, 'AUTH_UNAVAILABLE', '서버가 로그인을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.');
      return null;
    }
  }
  const unavailable = (response) => fail(response, 502, 'AUTH_UNAVAILABLE', '서버가 로그인 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.');

  // POST /api/auth/login  {email, password} → 200 {email} + 세션 쿠키
  async function login(request, response) {
    if (!start(request, response, 'POST')) return undefined;
    if (crossSite(request)) return fail(response, 403, 'CROSS_SITE_REQUEST', '다른 사이트에서 보낸 로그인 요청은 받지 않습니다.');
    if (!String(request.headers?.['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return fail(response, 415, 'JSON_REQUIRED', '로그인 요청은 JSON 형식이어야 합니다.');
    }
    const input = parseJsonBody(request);
    const email = typeof input?.email === 'string' ? input.email.trim() : '';
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!email || email.length > 320 || !email.includes('@') || !password || password.length > 1024) {
      return fail(response, 400, 'INVALID_LOGIN_FORMAT', '이메일과 비밀번호를 올바르게 입력하세요.');
    }
    const supabase = client(response);
    if (!supabase) return undefined;
    let result;
    try {
      result = await supabase.auth.signInWithPassword({ email, password });
    } catch {
      console.error('AUTH_LOGIN_REQUEST_FAILED');
      return unavailable(response);
    }
    const { data, error } = result ?? {};
    if (error) {
      const code = safeCode(error.code);
      console.warn('AUTH_LOGIN_FAILED', code ?? 'unknown');
      if (isNetworkError(error)) return unavailable(response);
      const status = code === 'over_request_rate_limit' || error.status === 429 ? 429 : 401;
      return fail(response, status, 'LOGIN_FAILED', REASONS[code] ?? '로그인에 실패했습니다.', code);
    }
    const session = data?.session;
    if (!isCookieToken(session?.access_token) || !isCookieToken(session?.refresh_token)) {
      console.error('AUTH_SESSION_INVALID');
      return unavailable(response);
    }
    response.setHeader('Set-Cookie', sessionCookies(session));
    return send(response, 200, { email: data.user?.email ?? session.user?.email ?? null });
  }

  // GET /api/auth/session → 로그인 상태면 200 {email}(필요하면 쿠키를 갱신), 아니면 401
  async function session(request, response) {
    if (!start(request, response, 'GET')) return undefined;
    const access = readCookie(request.headers?.cookie, ACCESS_COOKIE);
    const refresh = readCookie(request.headers?.cookie, REFRESH_COOKIE);
    if (!access && !refresh) return send(response, 401, { ...LOGIN_REQUIRED_BODY });
    const supabase = client(response);
    if (!supabase) return undefined;
    try {
      if (access) {
        const { data, error } = await supabase.auth.getUser(access);
        if (!error && data?.user) return send(response, 200, { email: data.user.email ?? null });
        if (error && isNetworkError(error)) return unavailable(response);
      }
      if (refresh) {
        const { data, error } = await supabase.auth.refreshSession({ refresh_token: refresh });
        if (error && isNetworkError(error)) return unavailable(response);
        const fresh = data?.session;
        if (!error && isCookieToken(fresh?.access_token) && isCookieToken(fresh?.refresh_token)) {
          response.setHeader('Set-Cookie', sessionCookies(fresh));
          return send(response, 200, { email: data.user?.email ?? fresh.user?.email ?? null });
        }
      }
    } catch {
      console.error('AUTH_SESSION_REQUEST_FAILED');
      return unavailable(response);
    }
    response.setHeader('Set-Cookie', clearedCookies());
    return send(response, 401, { ...LOGIN_REQUIRED_BODY });
  }

  // POST /api/auth/logout → 204. 서버에서 이 세션을 끊고(가능하면) 쿠키를 지웁니다.
  async function logout(request, response) {
    if (!start(request, response, 'POST')) return undefined;
    if (crossSite(request)) return fail(response, 403, 'CROSS_SITE_REQUEST', '다른 사이트에서 보낸 로그아웃 요청은 받지 않습니다.');
    const access = readCookie(request.headers?.cookie, ACCESS_COOKIE);
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (access && typeof url === 'string' && url && typeof key === 'string' && key) {
      try {
        const supabase = createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        const { error } = (await supabase.auth.admin.signOut(access, 'local')) ?? {};
        if (error) console.warn('AUTH_LOGOUT_FAILED', safeCode(error.code) ?? 'unknown');
      } catch {
        console.warn('AUTH_LOGOUT_FAILED', 'unknown');
      }
    }
    response.setHeader('Set-Cookie', clearedCookies());
    return response.status(204).end();
  }

  async function route(request, response) {
    const action = readAction(request);
    if (action === 'login') return login(request, response);
    if (action === 'session') return session(request, response);
    if (action === 'logout') return logout(request, response);
    response.setHeader('Cache-Control', 'no-store');
    return fail(response, 404, 'NOT_FOUND', '없는 로그인 경로입니다.');
  }

  return { login, session, logout, route };
}
