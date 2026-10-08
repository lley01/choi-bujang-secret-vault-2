// 로그인 세션 쿠키. 브라우저 스크립트가 읽을 수 없도록(HttpOnly) 하고, 다른 사이트의 요청에는 실리지 않게(SameSite=Strict) 합니다.
// 화면 코드에는 키도 토큰도 두지 않고, 토큰은 이 쿠키로만 오갑니다.
export const ACCESS_COOKIE = 'aleph_at';
export const REFRESH_COOKIE = 'aleph_rt';
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,4096}$/u;

export const isCookieToken = (value) => typeof value === 'string' && TOKEN.test(value);

export function readCookie(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    return isCookieToken(value) ? value : undefined;
  }
  return undefined;
}

// 메모 API가 검사기에 넘길 값. 쿠키의 토큰을 Authorization 헤더와 같은 모양으로 바꿉니다.
export function bearerFromCookie(header) {
  const token = readCookie(header, ACCESS_COOKIE);
  return token ? `Bearer ${token}` : undefined;
}

const cookie = (name, value, path, maxAge) => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

export function sessionCookies(session) {
  const ttl = Number.isInteger(session.expires_in) && session.expires_in > 0 ? Math.min(session.expires_in, 24 * 60 * 60) : 3600;
  return [
    cookie(ACCESS_COOKIE, session.access_token, '/api', ttl),
    cookie(REFRESH_COOKIE, session.refresh_token, '/api/auth', REFRESH_MAX_AGE),
  ];
}

export const clearedCookies = () => [cookie(ACCESS_COOKIE, '', '/api', 0), cookie(REFRESH_COOKIE, '', '/api/auth', 0)];
