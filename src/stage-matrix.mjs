// 1~11단계 정상·금지 요청 대조표(npm run matrix). 학생의 재시험 기록이며 심판 판정이 아닙니다.
// 표의 칸: 단계 · 구분 · 시험 ID · 요청 · 기대 결과 · 실제 API 결과 · 요청 ID · 확인 시각 · 판정 · 확인 방법
// 규칙
// - 「실제 API 결과」는 실제로 받은 응답에서만 채웁니다. 결과가 없으면 판정은 「미실행」이고 요청 ID·확인 시각도 비웁니다.
// - 판정은 기대값과 실제 결과를 이 코드가 비교해 정합니다. 기록 파일에 「통과」를 적는 칸은 없습니다(적으면 거부).
// - 자동(auto): 토큰 없이 보낼 수 있는 요청만 --send 일 때 배포 주소로 실제로 보냅니다. 요청 ID는 응답의 x-vercel-id 헤더입니다.
// - 직접(manual)·심판(judge): 학생이 직접 보낸 요청이나 심판 결과를 기록 파일(matrix-evidence.json, 커밋하지 않음)에 적은 것만 반영합니다.
//   자동 시험은 기록 파일로 채울 수 없습니다(손으로 적은 결과가 자동 실측처럼 보이지 않도록).
// - 응답 본문은 저장하지 않습니다. 상태 코드·오류 코드·확인 표시만 적고, 메모 제목·본문·토큰·쿠키는 남기지 않습니다.

const FORGED = 'Bearer aaaaaaaa.bbbbbbbb.cccccccc';
const JSON_TYPE = { 'Content-Type': 'application/json' };
const ATTACKER = 'https://attacker.invalid';
const randomId = () => crypto.randomUUID();

const noteList = (data) => (Array.isArray(data) ? data : data?.notes);
const hasNotes = (data) => Array.isArray(noteList(data)) && noteList(data).length > 0;
const errorOf = (data) => (typeof data?.error === 'string' && /^[A-Za-z0-9_]{1,40}$/u.test(data.error) ? data.error : null);
const show = (result) => `HTTP ${result.status}${errorOf(result.data) ? ` ${errorOf(result.data)}` : ''}`;

// 우리 앱의 JSON 오류 코드일 때만 「일치」. 앱이 아닌 곳(배포 보호 화면·프록시)이 막은 401·403은 「판정 불가」.
const apiError = (status, error) => (result) => {
  if (hasNotes(result.data)) return { verdict: 'mismatch', observed: `${show(result)}, 메모가 돌아옴(내용은 기록하지 않음)` };
  if (result.status === status && errorOf(result.data) === error) return { verdict: 'match', observed: show(result) };
  if ((result.status === 401 || result.status === 403) && !errorOf(result.data)) {
    return { verdict: 'unknown', observed: `${show(result)}, 앱이 아닌 곳의 응답으로 보임` };
  }
  return { verdict: 'mismatch', observed: show(result) };
};
const titled = (text) => typeof text === 'string' && text.includes('<title>BYTE BACK');

// 확인 방법: auto = 이 도구가 --send 로 실제로 보냄, manual = 학생이 직접(로그인·승인 기기 필요), judge = 심판 결과
export const MATRIX = Object.freeze([
  // 1단계
  { stage: 1, kind: '정상', id: 's1_screen', how: 'auto', request: 'GET /', expected: '200, 자료실 화면(제목 BYTE BACK)',
    send: { method: 'GET', path: '/' },
    check: (r) => (r.status === 200 && titled(r.text) ? { verdict: 'match', observed: 'HTTP 200, 자료실 화면 제목 확인' }
      : { verdict: 'mismatch', observed: `HTTP ${r.status}, 자료실 화면 제목 없음` }) },
  { stage: 1, kind: '정상', id: 's1_identity', how: 'auto', request: 'GET /aleph.json', expected: '200, 현재 step',
    send: { method: 'GET', path: '/aleph.json' },
    check: (r, config) => (r.status === 200 && r.data?.step === config.step ? { verdict: 'match', observed: `HTTP 200, step ${r.data.step}` }
      : { verdict: 'mismatch', observed: `HTTP ${r.status}, step ${typeof r.data?.step === 'number' ? r.data.step : '없음'}` }) },
  // 2단계
  { stage: 2, kind: '금지', id: 's2_legacy_data_json', how: 'auto', request: 'GET /data.json', expected: '404, 메모 없음',
    send: { method: 'GET', path: '/data.json' },
    check: (r) => (hasNotes(r.data) ? { verdict: 'mismatch', observed: `HTTP ${r.status}, 메모가 보임(내용은 기록하지 않음)` }
      : r.status === 404 ? { verdict: 'match', observed: 'HTTP 404, 메모 없음' }
        : (r.status === 401 || r.status === 403) ? { verdict: 'unknown', observed: `HTTP ${r.status}, 앱이 아닌 곳의 응답으로 보임` }
          : { verdict: 'mismatch', observed: `HTTP ${r.status}, 메모 없음` }) },
  { stage: 2, kind: '금지', id: 's2_db_direct_publishable', how: 'manual', request: '공개 키로 학습 DB GET /rest/v1/notes 직접', expected: { status: 403, error: '42501' } },
  // 3단계
  { stage: 3, kind: '금지', id: 's3_list_no_token', how: 'auto', request: '토큰 없이 GET /api/notes', expected: '401 LOGIN_REQUIRED, 메모 없음',
    send: { method: 'GET', path: '/api/notes' }, check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 3, kind: '금지', id: 's3_list_forged_token', how: 'auto', request: '엉터리 토큰으로 GET /api/notes', expected: '401 LOGIN_REQUIRED, 메모 없음',
    send: { method: 'GET', path: '/api/notes', headers: { Authorization: FORGED } }, check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 3, kind: '금지', id: 's3_create_no_token', how: 'auto', request: '토큰 없이 POST /api/notes', expected: '401 LOGIN_REQUIRED',
    send: { method: 'POST', path: '/api/notes', headers: JSON_TYPE, body: () => JSON.stringify({ title: '점검', body: '점검' }) },
    check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 3, kind: '금지', id: 's3_read_no_token', how: 'auto', request: '토큰 없이 GET /api/notes/<무작위 ID>', expected: '401 LOGIN_REQUIRED',
    send: { method: 'GET', path: () => `/api/notes/${randomId()}` }, check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 3, kind: '금지', id: 's3_update_no_token', how: 'auto', request: '토큰 없이 PUT /api/notes/<무작위 ID>', expected: '401 LOGIN_REQUIRED',
    send: { method: 'PUT', path: () => `/api/notes/${randomId()}`, headers: JSON_TYPE, body: () => JSON.stringify({ title: '점검', body: '점검' }) },
    check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 3, kind: '금지', id: 's3_delete_no_token', how: 'auto', request: '토큰 없이 DELETE /api/notes/<무작위 ID>', expected: '401 LOGIN_REQUIRED',
    send: { method: 'DELETE', path: () => `/api/notes/${randomId()}` }, check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 3, kind: '금지', id: 's3_patch_method', how: 'auto', request: 'PATCH /api/notes/<무작위 ID>', expected: '405 METHOD_NOT_ALLOWED',
    send: { method: 'PATCH', path: () => `/api/notes/${randomId()}`, headers: JSON_TYPE, body: () => '{}' }, check: apiError(405, 'METHOD_NOT_ALLOWED') },
  { stage: 3, kind: '정상', id: 's3_login_list', how: 'manual', request: '로그인(B, 승인 기기) GET /api/notes', expected: { status: 200 } },
  { stage: 3, kind: '정상', id: 's3_login_create', how: 'manual', request: '로그인(B, 승인 기기) POST /api/notes', expected: { status: 201 } },
  { stage: 3, kind: '정상', id: 's3_login_update', how: 'manual', request: '로그인(B, 승인 기기) PUT /api/notes/<B의 새 메모 ID>', expected: { status: 200 } },
  { stage: 3, kind: '정상', id: 's3_login_delete', how: 'manual', request: '로그인(B, 승인 기기) DELETE /api/notes/<B의 새 메모 ID>', expected: { status: 204 } },
  { stage: 3, kind: '금지', id: 's3_login_empty_title', how: 'manual', request: '로그인(B, 승인 기기) 빈 제목으로 POST /api/notes', expected: { status: 400, error: 'INVALID_TITLE' } },
  // 4단계
  { stage: 4, kind: '금지', id: 's4_other_owner_read', how: 'manual', request: 'A가 GET /api/notes/<B의 시험 메모 ID>', expected: { status: 404, error: 'NOT_FOUND' } },
  { stage: 4, kind: '금지', id: 's4_other_owner_update', how: 'manual', request: 'A가 PUT /api/notes/<B의 시험 메모 ID>', expected: { status: 404, error: 'NOT_FOUND' } },
  { stage: 4, kind: '금지', id: 's4_other_owner_delete', how: 'manual', request: 'A가 DELETE /api/notes/<B의 시험 메모 ID>', expected: { status: 404, error: 'NOT_FOUND' } },
  // 5단계
  { stage: 5, kind: '정상', id: 's5_screen_no_db_key', how: 'auto', request: 'GET / (화면 코드)', expected: '200, sb_publishable_·supabase.co 없음',
    send: { method: 'GET', path: '/' },
    check: (r) => (r.status === 200 && titled(r.text) && !/sb_publishable_|supabase\.co/u.test(r.text)
      ? { verdict: 'match', observed: 'HTTP 200, 화면 코드에 DB 키·주소 없음' }
      : { verdict: 'mismatch', observed: `HTTP ${r.status}, ${/sb_publishable_|supabase\.co/u.test(r.text ?? '') ? 'DB 키·주소가 보임' : '자료실 화면 아님'}` }) },
  { stage: 5, kind: '금지', id: 's5_login_cross_site', how: 'auto', request: '다른 사이트 Origin으로 POST /api/auth/login', expected: '403 CROSS_SITE_REQUEST',
    send: { method: 'POST', path: '/api/auth/login', headers: { ...JSON_TYPE, Origin: ATTACKER },
      body: () => JSON.stringify({ email: 'matrix-check@example.invalid', password: randomId() }) },
    check: apiError(403, 'CROSS_SITE_REQUEST') },
  { stage: 5, kind: '금지', id: 's5_login_not_json', how: 'auto', request: '폼 형식으로 POST /api/auth/login', expected: '415 JSON_REQUIRED',
    send: { method: 'POST', path: '/api/auth/login', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: () => 'email=x&password=y' },
    check: apiError(415, 'JSON_REQUIRED') },
  { stage: 5, kind: '금지', id: 's5_session_no_cookie', how: 'auto', request: '쿠키 없이 GET /api/auth/session', expected: '401 LOGIN_REQUIRED',
    send: { method: 'GET', path: '/api/auth/session' }, check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 5, kind: '정상', id: 's5_login_ok', how: 'manual', request: '화면에서 B로 로그인(POST /api/auth/login)', expected: { status: 200 } },
  { stage: 5, kind: '금지', id: 's5_login_wrong_password', how: 'manual', request: '틀린 비밀번호로 로그인(POST /api/auth/login)', expected: { status: 401, error: 'LOGIN_FAILED' } },
  { stage: 5, kind: '금지', id: 's5_db_direct_login_token', how: 'manual', request: '로그인 토큰으로 학습 DB GET /rest/v1/notes 직접', expected: { status: 403, error: '42501' } },
  // 6단계(반 엔진·판정기: 심판 결과로만 확인)
  { stage: 6, kind: '정상', id: 's6_registered_device', how: 'judge', request: '등록 기기의 자료실 요청(심판)', expected: { decision: 'allow', reasonCode: 'approved' } },
  { stage: 6, kind: '금지', id: 's6_unregistered_device', how: 'judge', request: '미등록 기기의 자료실 요청(심판)', expected: { decision: 'deny', reasonCode: 'device_not_registered' } },
  // 7단계
  { stage: 7, kind: '금지', id: 's7_composite_step_up', how: 'judge', request: '새벽·처음 보는 네트워크·대량 읽기 복합 요청(심판)', expected: { decision: 'step_up', reasonCode: 'step_up_required' } },
  { stage: 7, kind: '정상', id: 's7_reauth_allow', how: 'judge', request: '같은 로그인으로 다시 로그인한 뒤 새 요청(심판, 엔진 계약 아직 없음)', expected: { decision: 'allow', reasonCode: null } },
  // 8단계
  { stage: 8, kind: '금지', id: 's8_resource_id_forged', how: 'auto', request: 'X-Resource-Id·?resource=class.notice 위조로 GET /api/notes', expected: '401 LOGIN_REQUIRED, 응답 X-Resource-Id: vault.note',
    send: { method: 'GET', path: '/api/notes?resource=class.notice', headers: { 'X-Resource-Id': 'class.notice' } },
    check: (r) => {
      const base = apiError(401, 'LOGIN_REQUIRED')(r);
      const resource = r.headers?.['x-resource-id'] ?? '없음';
      if (base.verdict !== 'match') return { ...base, observed: `${base.observed}, X-Resource-Id ${resource}` };
      return resource === 'vault.note' ? { verdict: 'match', observed: `${base.observed}, X-Resource-Id vault.note` }
        : { verdict: 'mismatch', observed: `${base.observed}, X-Resource-Id ${String(resource).slice(0, 40)}` };
    } },
  { stage: 8, kind: '금지', id: 's8_notice_write', how: 'judge', request: 'POST /notices(공지 쓰기, 심판)', expected: { decision: 'deny', reasonCode: 'notice_read_only' } },
  { stage: 8, kind: '금지', id: 's8_instructor_materials', how: 'judge', request: 'GET /materials(강사 자료, 심판)', expected: { decision: 'deny', reasonCode: 'instructor_materials_denied' } },
  // 9단계
  { stage: 9, kind: '금지', id: 's9_doppelganger_revoked', how: 'judge', request: '회수 제안 뒤 그 기기의 자료 요청(심판)', expected: { decision: 'deny', reasonCode: null } },
  // 10단계
  { stage: 10, kind: '금지', id: 's10_restore_no_token', how: 'auto', request: '토큰 없이 POST /api/restore/<무작위 ID>', expected: '401 LOGIN_REQUIRED',
    send: { method: 'POST', path: () => `/api/restore/${randomId()}`, headers: JSON_TYPE, body: () => JSON.stringify({ contentSha256: '0'.repeat(64) }) },
    check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 10, kind: '금지', id: 's10_restore_forged_token', how: 'auto', request: '엉터리 토큰으로 POST /api/restore/<무작위 ID>', expected: '401 LOGIN_REQUIRED',
    send: { method: 'POST', path: () => `/api/restore/${randomId()}`, headers: { ...JSON_TYPE, Authorization: FORGED }, body: () => JSON.stringify({ contentSha256: '0'.repeat(64) }) },
    check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 10, kind: '금지', id: 's10_restore_cross_site', how: 'auto', request: '다른 사이트 Origin으로 POST /api/restore/<무작위 ID>', expected: '403 CROSS_SITE_REQUEST',
    send: { method: 'POST', path: () => `/api/restore/${randomId()}`, headers: { ...JSON_TYPE, Origin: ATTACKER }, body: () => JSON.stringify({ contentSha256: '0'.repeat(64) }) },
    check: apiError(403, 'CROSS_SITE_REQUEST') },
  { stage: 10, kind: '금지', id: 's10_restore_wrong_method', how: 'auto', request: 'GET /api/restore/<무작위 ID>', expected: '405 METHOD_NOT_ALLOWED',
    send: { method: 'GET', path: () => `/api/restore/${randomId()}` }, check: apiError(405, 'METHOD_NOT_ALLOWED') },
  { stage: 10, kind: '정상', id: 's10_restore_owner', how: 'manual', request: 'B가 POST /api/restore/<B의 시험 메모 ID> (사본 해시)', expected: { status: 200 } },
  { stage: 10, kind: '금지', id: 's10_restore_hash_mismatch', how: 'manual', request: 'B가 해시 한 글자를 바꿔 같은 요청', expected: { status: 409, error: 'HASH_MISMATCH' } },
  { stage: 10, kind: '금지', id: 's10_restore_other_owner', how: 'manual', request: 'A가 B 메모로 같은 요청', expected: { status: 404, error: 'NOT_FOUND' } },
  // 11단계
  { stage: 11, kind: '정상', id: 's11_manifest', how: 'auto', request: 'GET /manifest.webmanifest', expected: '200, application/manifest+json, 앱 이름',
    send: { method: 'GET', path: '/manifest.webmanifest' },
    check: (r) => (r.status === 200 && /application\/manifest\+json/u.test(r.headers?.['content-type'] ?? '') && typeof r.data?.name === 'string'
      ? { verdict: 'match', observed: 'HTTP 200, manifest 형식·앱 이름 확인' }
      : { verdict: 'mismatch', observed: `HTTP ${r.status}, manifest 형식 또는 앱 이름 없음` }) },
  { stage: 11, kind: '정상', id: 's11_offline_page', how: 'auto', request: 'GET /offline.html', expected: '200, 오프라인 안내',
    send: { method: 'GET', path: '/offline.html' },
    check: (r) => (r.status === 200 && (r.text ?? '').includes('오프라인') ? { verdict: 'match', observed: 'HTTP 200, 오프라인 안내 확인' }
      : { verdict: 'mismatch', observed: `HTTP ${r.status}, 오프라인 안내 없음` }) },
  { stage: 11, kind: '금지', id: 's11_device_status_no_login', how: 'auto', request: '로그인 없이 GET /api/devices/status', expected: '401 LOGIN_REQUIRED',
    send: { method: 'GET', path: '/api/devices/status' }, check: apiError(401, 'LOGIN_REQUIRED') },
  { stage: 11, kind: '금지', id: 's11_device_register_cross_site', how: 'auto', request: '다른 사이트 Origin으로 POST /api/devices/register', expected: '403 CROSS_SITE_REQUEST',
    send: { method: 'POST', path: '/api/devices/register', headers: { ...JSON_TYPE, Origin: ATTACKER }, body: () => '{}' },
    check: apiError(403, 'CROSS_SITE_REQUEST') },
  { stage: 11, kind: '금지', id: 's11_unapproved_device', how: 'manual', request: '승인 전 기기(로그인 B) GET /api/notes', expected: { status: 403, error: 'DEVICE_NOT_APPROVED' } },
  { stage: 11, kind: '정상', id: 's11_approved_device', how: 'manual', request: '승인 뒤 「이 기기로 열기」(로그인 B) GET /api/notes', expected: { status: 200 } },
  { stage: 11, kind: '금지', id: 's11_revoked_device', how: 'manual', request: '승인 취소 뒤(로그인 B) GET /api/notes', expected: { status: 403, error: 'DEVICE_NOT_APPROVED' } },
].map((row, index) => Object.freeze({ n: index + 1, ...row })));

const HOW = Object.freeze({ auto: '자동(--send)', manual: '직접', judge: '심판' });
const VERDICT = Object.freeze({ match: '일치', mismatch: '불일치', unknown: '판정 불가', not_run: '미실행' });

const expectedText = (row) => {
  if (typeof row.expected === 'string') return row.expected;
  if ('decision' in row.expected) return `${row.expected.decision}${row.expected.reasonCode ? ` · ${row.expected.reasonCode}` : ''}`;
  return `${row.expected.status}${row.expected.error ? ` ${row.expected.error}` : ''}`;
};

// ---- 기록 파일(직접·심판 결과) 검사 ----
const ID_TEXT = /^[A-Za-z0-9:_.-]{1,120}$/u;
const CODE_TEXT = /^[A-Za-z0-9_]{1,40}$/u;
const SECRETISH = /eyJ[A-Za-z0-9_-]{8,}|Bearer|sb_secret_|sb_publishable_|-----BEGIN|@/iu;
const MANUAL_FIELDS = ['id', 'status', 'error', 'requestId', 'checkedAt'];
const JUDGE_FIELDS = ['id', 'decision', 'reasonCode', 'requestId', 'checkedAt'];

export function readEvidence(entries, { now = () => Date.now() } = {}) {
  if (!Array.isArray(entries)) throw new Error('기록 파일은 [ { "id": … }, … ] 배열이어야 합니다.');
  const byId = new Map(MATRIX.map((row) => [row.id, row]));
  const out = new Map();
  entries.forEach((entry, index) => {
    const where = `기록 ${index + 1}번째`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where}: { … } 모양이어야 합니다.`);
    const row = byId.get(entry.id);
    if (!row) throw new Error(`${where}: 표에 없는 시험 ID입니다.`);
    if (row.how === 'auto') throw new Error(`${where}(${row.id}): 자동 시험은 기록 파일로 채울 수 없습니다. npm run matrix -- --send 로 실제로 보내세요.`);
    if (out.has(row.id)) throw new Error(`${where}(${row.id}): 같은 시험 ID가 두 번 있습니다.`);
    const fields = row.how === 'judge' ? JUDGE_FIELDS : MANUAL_FIELDS;
    for (const key of Object.keys(entry)) {
      if (!fields.includes(key)) throw new Error(`${where}(${row.id}): 「${key}」 칸은 받지 않습니다(받는 칸: ${fields.join(', ')}). 판정·메모·토큰은 적지 않습니다.`);
    }
    for (const key of fields) {
      if (typeof entry[key] === 'string' && SECRETISH.test(entry[key])) throw new Error(`${where}(${row.id}): 「${key}」에 토큰·키·이메일처럼 보이는 값이 있습니다. 지우세요.`);
    }
    const result = row.how === 'judge' ? entry.decision : entry.status;
    const filled = [result, entry.requestId, entry.checkedAt].filter((value) => value !== null && value !== undefined && value !== '');
    if (filled.length === 0) return; // 비워 둔 줄 = 미실행
    if (filled.length !== 3) {
      throw new Error(`${where}(${row.id}): ${row.how === 'judge' ? 'decision' : 'status'}·requestId·checkedAt 을 모두 적거나 모두 비워 두세요(비우면 미실행).`);
    }
    if (row.how === 'judge') {
      if (!['allow', 'deny', 'step_up'].includes(entry.decision)) throw new Error(`${where}(${row.id}): decision 은 allow·deny·step_up 중 하나입니다.`);
      if (entry.reasonCode != null && !CODE_TEXT.test(entry.reasonCode)) throw new Error(`${where}(${row.id}): reasonCode 형식이 틀렸습니다.`);
    } else {
      if (!Number.isInteger(entry.status) || entry.status < 100 || entry.status > 599) throw new Error(`${where}(${row.id}): status 는 HTTP 상태 숫자입니다.`);
      if (entry.error != null && !CODE_TEXT.test(entry.error)) throw new Error(`${where}(${row.id}): error 는 응답의 오류 코드(영문·숫자·_)만 적습니다.`);
    }
    if (typeof entry.requestId !== 'string' || !(entry.requestId === '없음' || ID_TEXT.test(entry.requestId))) {
      throw new Error(`${where}(${row.id}): requestId 는 응답 헤더의 요청 ID(예: x-vercel-id) 또는 헤더가 없을 때 "없음"입니다.`);
    }
    const at = typeof entry.checkedAt === 'string' ? Date.parse(entry.checkedAt) : Number.NaN;
    if (!Number.isFinite(at)) throw new Error(`${where}(${row.id}): checkedAt 은 응답의 date 헤더 값이나 ISO 시각입니다.`);
    if (at > now() + 5 * 60 * 1000) throw new Error(`${where}(${row.id}): checkedAt 이 미래 시각입니다.`);
    out.set(row.id, { ...entry, checkedAt: new Date(at).toISOString() });
  });
  return out;
}

function judgeEvidence(row, entry) {
  if (row.how === 'judge') {
    const ok = entry.decision === row.expected.decision && (row.expected.reasonCode === null || entry.reasonCode === row.expected.reasonCode);
    return { verdict: ok ? 'match' : 'mismatch', observed: `${entry.decision}${entry.reasonCode ? ` · ${entry.reasonCode}` : ''}` };
  }
  const ok = entry.status === row.expected.status && (row.expected.error === undefined || entry.error === row.expected.error);
  return { verdict: ok ? 'match' : 'mismatch', observed: `HTTP ${entry.status}${entry.error ? ` ${entry.error}` : ''}` };
}

// ---- 자동 시험 보내기 ----
async function sendOne(row, app, fetchImpl, now) {
  const path = typeof row.send.path === 'function' ? row.send.path() : row.send.path;
  const body = typeof row.send.body === 'function' ? row.send.body() : row.send.body;
  let response;
  try {
    response = await fetchImpl(new URL(path, app), {
      method: row.send.method, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10000),
      ...(row.send.headers ? { headers: row.send.headers } : {}), ...(body === undefined ? {} : { body }),
    });
  } catch {
    return { verdict: 'not_run', observed: '미실행: 요청을 보내지 못함(네트워크 오류)', requestId: '', checkedAt: '' };
  }
  const checkedAt = new Date(now()).toISOString();
  const headers = {};
  for (const name of ['content-type', 'x-resource-id', 'x-vercel-id']) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  let text = '';
  try { text = (await response.text()).slice(0, 200000); } catch { text = ''; }
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  const requestId = typeof headers['x-vercel-id'] === 'string' && ID_TEXT.test(headers['x-vercel-id']) ? headers['x-vercel-id'] : '없음';
  return { ...row.check({ status: response.status, headers, text, data }, row.config), requestId, checkedAt };
}

export async function buildMatrix({ config, send = false, evidence = new Map(), fetchImpl = fetch, now = () => Date.now() }) {
  let app = null;
  if (send) {
    try { app = new URL(config.publicAppUrl); } catch { app = null; }
    if (!app || app.protocol !== 'https:' || app.username || app.password || app.search || app.hash || app.pathname !== '/' || app.hostname.endsWith('.example')) {
      throw new Error('aleph.config.json의 실제 배포 주소(https://…/)를 먼저 넣어 주세요.');
    }
  }
  const rows = [];
  for (const row of MATRIX) {
    let result;
    if (row.how === 'auto') {
      result = send ? await sendOne({ ...row, config }, app, fetchImpl, now)
        : { verdict: 'not_run', observed: '미실행: --send 없이 실행함', requestId: '', checkedAt: '' };
    } else if (evidence.has(row.id)) {
      const entry = evidence.get(row.id);
      result = { ...judgeEvidence(row, entry), requestId: entry.requestId, checkedAt: entry.checkedAt };
    } else {
      result = { verdict: 'not_run', observed: row.how === 'judge' ? '미실행: 심판 결과 기록 없음' : '미실행: 직접 확인 기록 없음', requestId: '', checkedAt: '' };
    }
    rows.push({ n: row.n, stage: row.stage, kind: row.kind, id: row.id, how: row.how, request: row.request,
      expected: expectedText(row), observed: result.observed, requestId: result.requestId, checkedAt: result.checkedAt, verdict: result.verdict });
  }
  const counts = { match: 0, mismatch: 0, unknown: 0, not_run: 0 };
  for (const row of rows) counts[row.verdict] += 1;
  return { schema: 'aleph.stage-matrix.v1', generatedAt: new Date(now()).toISOString(), step: config.step, sent: Boolean(send), total: rows.length, counts, rows };
}

const cell = (value) => String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

export function renderMarkdown(matrix) {
  const lines = [
    '# 1~11단계 정상·금지 요청 대조표',
    '',
    `만든 시각 ${matrix.generatedAt} · 설정 step ${matrix.step} · 자동 요청 ${matrix.sent ? '보냄' : '보내지 않음'} · 학생 재시험 기록(심판 판정 아님)`,
    '',
    `전체 ${matrix.total} · 일치 ${matrix.counts.match} · 불일치 ${matrix.counts.mismatch} · 판정 불가 ${matrix.counts.unknown} · 미실행 ${matrix.counts.not_run}`,
    '',
    '| # | 단계 | 구분 | 시험 ID | 요청 | 기대 결과 | 실제 API 결과 | 요청 ID | 확인 시각 | 판정 | 확인 방법 |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const row of matrix.rows) {
    lines.push(`| ${[row.n, row.stage, row.kind, row.id, row.request, row.expected, row.observed, row.requestId || '-', row.checkedAt || '-', VERDICT[row.verdict], HOW[row.how]].map(cell).join(' | ')} |`);
  }
  lines.push('', '- 「일치」는 실제로 받은 응답(자동) 또는 기록 파일에 적은 실제 결과(직접·심판)가 기대와 같을 때만입니다. 결과가 없으면 「미실행」입니다.',
    '- 「판정 불가」는 앱이 아닌 곳(배포 보호 화면·프록시)이 막은 응답입니다.', '');
  return lines.join('\n');
}

// 기록 파일 틀: 직접·심판 시험만, 모두 비워 둔 채(= 미실행)
export function evidenceTemplate() {
  return MATRIX.filter((row) => row.how !== 'auto').map((row) => (row.how === 'judge'
    ? { id: row.id, decision: null, reasonCode: null, requestId: null, checkedAt: null }
    : { id: row.id, status: null, error: null, requestId: null, checkedAt: null }));
}
