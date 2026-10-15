// 12단계 탈환 작전실 요약: GET /api/ops
// 판정기 규칙·탐지 사건·회수 상태·복구 버전을 한 번에 요약합니다. 항목마다 어디서 확인한 값인지 status 로 구분합니다.
//   confirmed   : 이 요청을 처리하면서 서버가 실제로 읽은 값(배포된 서버 코드·설정, 또는 이번 DB 조회 결과)
//   not_run     : 이 앱이 받을 방법이 없어 확인하지 않은 것(반 엔진·심판 몫). 결과를 지어내지 않습니다.
//   unavailable : 확인하려 했지만 실패(예: 테이블을 만드는 SQL을 아직 실행하지 않음)
// - 메모 제목·본문은 읽지도 돌려주지도 않습니다. 복구 버전은 메모 ID·사본 시각·해시 앞 12자리만 보여 줍니다.
// - 화면 로그인(학생)은 메모 API와 같이 승인된 기기 세션이 있어야 합니다. 심판 토큰은 반 엔진이 기기를 먼저 확인합니다.
// - 아무것도 바꾸지 않는 읽기 전용 경로입니다. 판정·회수·복원을 실행하지 않습니다.
import { createClient } from '@supabase/supabase-js';
import alephConfig from '../aleph.config.json' with { type: 'json' };
import { createLoginVerifier } from './verify-login.mjs';
import { bearerFromCookie } from './auth-cookies.mjs';
import { createDeviceChecker } from './device-service.mjs';
import { RULE_IDS } from './decider.mjs';
import { REVOCATION_REASON, SUSPICION_RULE } from './detect.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LIMIT = 5;
const notRun = (reason) => ({ status: 'not_run', reason });
const unavailable = (reason) => ({ status: 'unavailable', reason });
const codeOf = (error) => (typeof error?.code === 'string' && /^[A-Z0-9_]{1,10}$/u.test(error.code) ? error.code : 'unknown');
// 테이블이 아직 없을 때(SQL 미실행)와 그 밖의 실패를 구분합니다.
const failed = (error, sql) => unavailable(codeOf(error) === '42P01' ? `${sql}을(를) 아직 실행하지 않았습니다(테이블 없음).` : `DB 조회 실패(오류 코드 ${codeOf(error)})`);

export function createOpsService({ env = process.env, createSupabase = createClient, loginConfig = alephConfig,
  loginOptions = {}, verifyLogin, checkDevice = createDeviceChecker({ env }), config = alephConfig, now = () => Date.now() } = {}) {
  let verifier = verifyLogin ?? null;
  const getVerifier = () => {
    verifier ??= createLoginVerifier({ config: loginConfig, supabaseSecretKey: env.SUPABASE_SECRET_KEY, ...loginOptions });
    return verifier;
  };
  const fail = (response, status, error, message) => response.status(status).json(message ? { error, message } : { error });

  async function rulesSection() {
    return {
      status: 'confirmed',
      source: '배포된 서버 코드와 설정(src/decider.mjs, src/detect.mjs, aleph.config.json)',
      note: '규칙 목록입니다. 실제 판정 결과는 반 엔진이 요청마다 내며 이 앱으로 전달되지 않습니다.',
      step: config.step,
      deciderRules: [...RULE_IDS],
      detectionRules: [SUSPICION_RULE, REVOCATION_REASON],
      allowedRoutes: [...(config.allowedRoutes ?? [])],
      restoreRoute: config.restoreRoute ?? null,
    };
  }

  async function revocationSection(supabase, me) {
    const engine = notRun('반 엔진의 실제 기기 권한 회수와 걸린 시간은 심판이 확인합니다(이 앱으로 전달되지 않음).');
    const { data, error } = await supabase.from('user_devices').select('status').eq('owner_id', me);
    if (error || !Array.isArray(data)) return { devices: failed(error, '11단계 SQL(step11_user_devices.sql)'), engine };
    const counts = { approved: 0, pending: 0, revoked: 0 };
    for (const row of data) if (Object.hasOwn(counts, row.status)) counts[row.status] += 1;
    return { devices: { status: 'confirmed', source: '이번 요청의 user_devices 조회(내 기기만)', counts }, engine };
  }

  async function restoreSection(supabase, me) {
    const backups = await supabase.from('notes_backup').select('id, backed_up_at, content_sha256').eq('owner_id', me)
      .order('backed_up_at', { ascending: false }).limit(LIMIT);
    const audits = await supabase.from('notes_restore_audit').select('note_id, outcome, at').eq('owner_id', me)
      .order('at', { ascending: false }).limit(LIMIT);
    const sql = '10단계 SQL(step10_notes_restore.sql)';
    return {
      versions: backups.error || !Array.isArray(backups.data) ? failed(backups.error, sql) : {
        status: 'confirmed', source: '이번 요청의 notes_backup 조회(내 사본만, 제목·본문 제외)',
        items: backups.data.map((row) => ({ noteId: row.id, backedUpAt: row.backed_up_at, sha256Prefix: String(row.content_sha256).slice(0, 12) })),
      },
      audit: audits.error || !Array.isArray(audits.data) ? failed(audits.error, sql) : {
        status: 'confirmed', source: '이번 요청의 notes_restore_audit 조회(내 기록만)',
        items: audits.data.map((row) => ({ noteId: row.note_id, outcome: row.outcome, at: row.at })),
      },
      policy: notRun('안전 정책 사본 비교·되돌리기는 학생 컴퓨터의 npm run policy:diff·policy:restore 로만 합니다(배포 서버는 실행하지 않음).'),
    };
  }

  // GET /api/ops
  async function summary(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return fail(response, 405, 'METHOD_NOT_ALLOWED');
    }
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY;
    if (typeof url !== 'string' || !url || typeof key !== 'string' || !key) {
      console.error('OPS_ENV_MISSING');
      return fail(response, 500, 'SERVER_NOT_CONFIGURED');
    }
    let identity;
    try {
      identity = await getVerifier()(request.headers?.authorization ?? bearerFromCookie(request.headers?.cookie));
    } catch {
      console.error('OPS_AUTH_UNAVAILABLE');
      return fail(response, 500, 'AUTH_UNAVAILABLE');
    }
    if (!identity || !UUID.test(identity.userId ?? '')) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      return fail(response, 401, 'LOGIN_REQUIRED', '로그인이 필요합니다. 유효한 로그인 토큰과 함께 요청해 주세요.');
    }
    const me = identity.userId.toLowerCase();
    let supabase;
    try {
      supabase = createSupabase(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    } catch {
      console.error('OPS_CLIENT_FAILED');
      return fail(response, 500, 'OPS_UNAVAILABLE');
    }
    if (identity.kind !== 'judge') {
      const gate = await checkDevice(request, me, supabase).catch(() => ({ ok: false, reason: 'device_check_failed' }));
      if (!gate?.ok) {
        console.warn('OPS_DEVICE_REQUIRED', JSON.stringify({ reason: gate?.reason ?? 'unknown' }));
        return fail(response, 403, 'DEVICE_NOT_APPROVED', '이 기기가 서버에서 승인된 기기로 확인되지 않았습니다.');
      }
    }
    try {
      const [rules, revocation, restore] = await Promise.all([rulesSection(), revocationSection(supabase, me), restoreSection(supabase, me)]);
      return response.status(200).json({
        schema: 'aleph.ops.summary.v1',
        generatedAt: new Date(now()).toISOString(),
        rules,
        detection: notRun('반 엔진이 탐지 사건(조회 기록)을 이 앱에 보내는 계약이 없어 실제 사건을 받지 않습니다. 탐지 규칙은 npm run detect:test 와 심판이 가상 사건으로 확인합니다.'),
        revocation,
        restore,
      });
    } catch {
      console.error('OPS_SUMMARY_FAILED');
      return fail(response, 500, 'OPS_UNAVAILABLE');
    }
  }

  return { summary };
}
