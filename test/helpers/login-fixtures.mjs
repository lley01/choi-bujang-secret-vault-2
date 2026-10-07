// 시험 전용 가짜 로그인 도구입니다. 키·토큰·주소는 모두 이 시험 안에서만 만든 가짜 값입니다.
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

export const APP_HOST = 'test-app.vercel.app';
export const JUDGE = 'https://aleph-judge-production.up.railway.app/defense/judge';
export const STUDENT_ISSUER = 'https://dummy-project.supabase.co/auth/v1';
export const loginConfig = {
  judgeIssuer: JUDGE,
  publicAppUrl: `https://${APP_HOST}/`,
  identityProvider: { issuer: STUDENT_ISSUER, audience: 'authenticated', jwksUrl: `${STUDENT_ISSUER}/.well-known/jwks.json` },
};

const { publicKey, privateKey } = await generateKeyPair('ES256');
export const otherKeys = await generateKeyPair('ES256');
export const judgeKeySet = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' }] });
export const now = () => Math.floor(Date.now() / 1000);

export function judgeToken({ sub = crypto.randomUUID(), role = 'judge', identity = 'a', aud = APP_HOST, iss = JUDGE,
  iat = now(), exp = iat + 600, key = privateKey } = {}) {
  return new SignJWT({ aleph_run: crypto.randomUUID(), aleph_role: role, aleph_identity: identity })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(iss).setAudience(aud).setSubject(sub)
    .setIssuedAt(iat).setExpirationTime(exp).sign(key);
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const knownStudents = new Map();
// 서명 없는 가짜 학생 토큰입니다. 가짜 supabaseClient가 등록된 토큰만 통과시킵니다.
export function studentToken(sub = crypto.randomUUID(), { register = true } = {}) {
  const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: STUDENT_ISSUER, sub, n: crypto.randomUUID() })}.sig`;
  if (register) knownStudents.set(token, sub);
  return token;
}
export const supabaseClient = {
  auth: {
    async getClaims(token) {
      const sub = knownStudents.get(token);
      if (!sub) return { data: null, error: { message: 'invalid' } };
      return { data: { claims: { iss: STUDENT_ISSUER, aud: 'authenticated', role: 'authenticated', sub, exp: now() + 600 } }, error: null };
    },
  },
};
export const loginOptions = { judgeKeySet, supabaseClient };
