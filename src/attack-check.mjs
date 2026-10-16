// The student changes this check as each stage adds an attack to the same app.
// Never return tokens, private keys, real names, or note bodies.
import { randomUUID } from 'node:crypto';
import { RULE_IDS } from './decider.mjs';
async function readJson(url, { headers, method, body } = {}) {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    ...(method ? { method } : {}), ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body }),
  });
  // 성공·실패와 관계없이 JSON 본문을 읽어, 거부한 쪽이 우리 앱인지 가릴 수 있게 합니다.
  let data = null;
  try {
    data = await response.json();
  } catch {
    // A non-JSON response is a failed check, not a successful deployment.
  }
  return { status: response.status, data };
}
// 응답을 받지 못한 요청(네트워크 오류·리디렉션 등)은 기록할 HTTP 응답이 없으므로 null 을 돌려주고, observed 는 not_run 으로 둡니다.
async function tryRead(url, options) {
  try {
    return await readJson(url, options);
  } catch {
    return null;
  }
}

// 1단계는 { notes: [...] }, 이후 목록은 [...] 배열입니다. 둘 중 하나라도 메모가 들어 있으면 자료가 보인 것으로 봅니다.
const noteList = (data) => (Array.isArray(data) ? data : data?.notes);
const hasNotes = (data) => Array.isArray(noteList(data)) && noteList(data).length > 0;

export async function runAttackChecks(config) {
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].includes(config.step)) throw new Error('이 단계의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');
  let app;
  try {
    app = new URL(config.publicAppUrl);
  } catch {
    throw new Error('aleph.config.json의 실제 배포 주소를 먼저 넣어 주세요.');
  }
  if (app.protocol !== 'https:' || app.username || app.password || app.search || app.hash
      || app.pathname !== '/' || app.hostname.endsWith('.example')) {
    throw new Error('aleph.config.json의 실제 배포 주소를 먼저 넣어 주세요.');
  }
  if (typeof config.sampleMarker !== 'string' || !config.sampleMarker) throw new Error('가상 메모의 확인 표시를 넣어 주세요.');

  if (config.step === 1) {
    const { status, data } = await readJson(new URL('/data.json', app));
    const visible = data?.sampleMarker === config.sampleMarker && hasNotes(data);
    return [{ attackId: 'anonymous_note_read', expected: '비로그인 화면에서 가상 메모를 확인',
      observed: visible ? '비로그인 요청에서 공개 가상 메모 확인 표시가 보임' : `비로그인 요청에서 확인 표시가 보이지 않음 (HTTP ${status})` }];
  }

  // 2~3단계: 옛 공개 파일은 사라져야 하고, 자료 API는 토큰이 없거나 엉터리면 자료 없이 거부해야 합니다.
  // 정상 로그인 요청은 학생 비밀번호나 심판 토큰이 필요해 여기서 보내지 않습니다(미실행).
  const legacy = await tryRead(new URL('/data.json', app));
  const api = await tryRead(new URL('/api/notes', app));
  const forged = await tryRead(new URL('/api/notes', app), { headers: { Authorization: 'Bearer aaaaaaaa.bbbbbbbb.cccccccc' } });
  // 쓰기 요청 점검(POST·PUT·DELETE /api/notes)은 배포 주소로 보내지 않습니다. 보내지 않았으므로 observed는 not_run 입니다.
  const json = { 'Content-Type': 'application/json' };
  // 실제로 보낸 요청의 observed 는 받은 HTTP 응답 그대로입니다: 상태 코드와, JSON 본문에 오류 코드(error)가 있으면 그 코드.
  // 해석·추측 문장은 쓰지 않고, 응답 본문(메모 등)은 적지 않습니다. 오류 코드는 영문·숫자·_ 모양일 때만 적습니다.
  // 응답을 받지 못했으면(null) 기록할 응답이 없으므로 not_run 입니다.
  const httpObserved = (result) => (result === null ? 'not_run' : `HTTP ${result.status}${typeof result.data?.error === 'string' && /^[A-Za-z0-9_]{1,60}$/u.test(result.data.error) ? ` ${result.data.error}` : ''}`);
  const writeCheck = (attackId, label) => ({ attackId, expected: `토큰 없이 ${label}을 보내면 자료 없이 거부됨(401)`, observed: 'not_run' });
  const results = [
    { attackId: 'anonymous_note_read', expected: '비로그인으로 옛 공개 /data.json을 요청해도 가상 메모가 보이지 않음',
      observed: httpObserved(legacy) },
    { attackId: 'anonymous_notes_api_read', expected: '토큰 없이 /api/notes를 요청하면 자료 없이 거부됨(401)',
      observed: httpObserved(api) },
    { attackId: 'forged_token_notes_api_read', expected: '엉터리 토큰으로 /api/notes를 요청하면 자료 없이 거부됨(401)',
      observed: httpObserved(forged) },
    writeCheck('anonymous_note_create', 'POST /api/notes'),
    writeCheck('anonymous_note_update', 'PUT /api/notes/:id'),
    writeCheck('anonymous_note_delete', 'DELETE /api/notes/:id'),
  ];
  if (config.step >= 3) {
    // 정상 로그인 요청은 학생 비밀번호나 심판이 발급한 토큰이 있어야 보낼 수 있습니다. 보내지 않았으므로 성공으로 쓰지 않고 미실행으로 남깁니다.
    results.push({ attackId: 'normal_login_notes_read', expected: '정상 로그인(심판 A 또는 학생)으로 /api/notes를 요청하면 자기 메모 목록을 받음',
      observed: 'not_run' }); // 보내지 않음: 로그인 토큰이 필요해 이 점검에서는 요청을 보내지 않음
  }
  if (config.step >= 4) {
    // 소유자 검사는 서로 다른 두 사용자의 로그인 토큰이 있어야 확인할 수 있습니다. 보내지 않았으므로 미실행으로 남깁니다.
    results.push({ attackId: 'other_owner_note_access', expected: '로그인한 B가 A의 메모 id로 GET·PUT·DELETE를 보내면 404로 거부되고 A의 메모는 그대로',
      observed: 'not_run' }); // 보내지 않음: 서로 다른 두 사용자의 로그인 토큰이 필요해 이 점검에서는 요청을 보내지 않음
  }
  if (config.step >= 5) {
    // 학습 DB의 Supabase REST를 직접 부르는 길은 로그인 토큰과 학습 DB 주소가 있어야 시험할 수 있습니다. 보내지 않았으므로 미실행으로 남깁니다.
    results.push({ attackId: 'direct_db_rest_access', expected: '로그인 토큰이나 publishable key로 학습 DB의 /rest/v1/notes를 직접 부르면 권한 없음으로 거부되고 메모는 서버 함수로만 다룸',
      observed: 'not_run' }); // 보내지 않음: 로그인 토큰과 학습 DB 주소가 필요해 이 점검에서는 요청을 보내지 않음(DB 권한은 SQL 확인 쿼리로 확인)
  }
  if (config.step >= 6) {
    // 미등록 기기 요청은 반 엔진이 확인한 기기 정보로만 만들 수 있어 심판이 보냅니다. 여기서는 보내지 않았으므로 미실행으로 남깁니다.
    results.push({ attackId: 'unregistered_device_notes_read', expected: '미등록 기기(deviceRegistered: false)의 자료실 요청은 판정기가 deny·device_not_registered로 거부',
      observed: 'not_run' }); // 보내지 않음: 미등록 기기 요청은 반 엔진의 기기 정보가 필요해 심판이 보냄(이 점검에서는 요청을 보내지 않음)
  }
  if (config.step >= 6 && RULE_IDS.includes('step_up_required')) {
    // 7단계: 제공 엔진이 "같은 내 로그인으로 다시 로그인한 시각"을 확인해 넘기는 계약이 저장소에 없습니다
    // (판정 요청의 stepUp에는 나이만 있고 같은 로그인에 묶는다는 내용, 다시 로그인 흐름, 앱 연결 계약이 없음).
    // 그래서 실제 자료 차단과 새 로그인 뒤 재판정은 보내지 않고 미실행으로 남깁니다. 토큰은 만들거나 기록하지 않습니다.
    results.push({ attackId: 'step_up_reauth_notes_read', expected: '복합 이상 접속은 다시 로그인 전 자료를 막고(step_up), 같은 로그인으로 다시 로그인한 뒤의 새 요청만 다시 판정해 허용',
      observed: 'not_run' }); // 보내지 않음: 제공 엔진의 다시 로그인 시각 확인 계약이 아직 없어 실제 자료 차단·재판정을 실측하지 않음(가상 사건 규칙만 npm run test:stage7로 시험)
  }
  if (config.step >= 9) {
    // 9단계: 탐지는 회수 제안(propose_revocation)만 만듭니다. 실제 기기 권한 회수와 걸린 시간은 심판이 확인하므로 여기서는 요청을 보내지 않습니다.
    results.push({ attackId: 'doppelganger_device_revocation', expected: '다른 네트워크 + 10분 안 다량 조회가 한 기기에서 나오면 그 기기 하나의 회수를 제안하고, 회수 뒤 그 기기의 자료 요청은 거부',
      observed: 'not_run' }); // 보내지 않음: 실제 회수와 걸린 시간은 심판이 확인함(탐지 제안만 npm run test:stage9로 시험, 이 점검에서는 요청을 보내지 않음)
  }
  if (config.step >= 9 && config.restoreRoute === 'POST /api/restore/:id') {
    // 10단계: 복원 뒤 다시 시험합니다. 이 점검은 복원을 마친 배포 주소에 실제로 요청을 보내고, 받은 응답만 결과로 적습니다.
    // - 금지 요청 4건: 토큰 없이·엉터리 토큰·다른 사이트 Origin·GET 으로 복원 경로를 부릅니다. 무작위 메모 ID와 0으로 채운 해시를 쓰므로
    //   거부되지 않더라도 실제 메모는 복원되지 않습니다. 우리 앱이 보낸 JSON 오류 코드일 때만 "거부됨"으로 적습니다.
    // - 정상 요청 2건: 로그인 없이도 열려야 하는 첫 화면과 배포 식별 파일(/aleph.json)을 받아, 복원 뒤에도 앱과 복원 경로가 배포돼 있는지 봅니다.
    // - 로그인 토큰이 필요한 시험(B의 정상 복원, 복원한 메모 읽기, A의 B 메모 복원 거부)은 보내지 않았으므로 미실행으로 남깁니다.
    const target = new URL(`/api/restore/${randomUUID()}`, app);
    const body = JSON.stringify({ contentSha256: '0'.repeat(64) });
    const restoreTry = (headers, method = 'POST') => tryRead(target, { method, headers: { ...json, ...headers }, ...(method === 'POST' ? { body } : {}) });
    // 쓰기가 필요한 POST 복원 점검 3건은 배포 주소로 보내지 않습니다. 보내지 않았으므로 observed는 not_run 입니다.
    const notSent = [
      ['restore_anonymous_after_restore', '토큰 없이 POST /api/restore/:id', 401, 'LOGIN_REQUIRED'],
      ['restore_forged_token_after_restore', '엉터리 토큰으로 POST /api/restore/:id', 401, 'LOGIN_REQUIRED'],
      ['restore_cross_site_after_restore', '다른 사이트 Origin으로 POST /api/restore/:id', 403, 'CROSS_SITE_REQUEST'],
    ];
    for (const [attackId, label, status, error] of notSent) {
      results.push({ attackId, expected: `복원 뒤 ${label}을 보내면 ${status} ${error}로 거부되고 아무것도 복원되지 않음`, observed: 'not_run' });
    }
    const forbidden = [
      ['restore_wrong_method_after_restore', 'GET /api/restore/:id', await restoreTry({}, 'GET'), 405, 'METHOD_NOT_ALLOWED'],
    ];
    for (const [attackId, label, result, status, error] of forbidden) {
      results.push({ attackId, expected: `복원 뒤 ${label}을 보내면 ${status} ${error}로 거부되고 아무것도 복원되지 않음`,
        observed: httpObserved(result) });
    }
    // 첫 화면은 HTML이라 상태 코드만 적습니다. 응답을 받지 못하면(네트워크 오류 등) 기록할 응답이 없으므로 not_run 입니다.
    let screen;
    try {
      const response = await fetch(new URL('/', app), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      screen = `HTTP ${response.status}`;
    } catch {
      screen = 'not_run';
    }
    results.push({ attackId: 'normal_screen_after_restore', expected: '복원 뒤 로그인 없이 첫 화면(/)을 열면 200과 자료실 화면이 옴',
      observed: screen });
    const identity = await tryRead(new URL('/aleph.json', app));
    results.push({ attackId: 'normal_identity_after_restore', expected: '복원 뒤 /aleph.json에 현재 단계와 복원 경로(허용 경로, 10단계부터 restoreRoute)가 실림',
      observed: httpObserved(identity) });
    results.push({ attackId: 'restore_owner_flow_needs_login', expected: '시험 계정 B가 자기 메모를 복원하면 200이고, 복원한 메모를 다시 읽으면 사본 내용이며, A가 같은 요청을 보내면 404',
      observed: 'not_run' }); // 보내지 않음: B·A의 로그인 토큰과 사본 해시가 필요해 이 점검에서는 요청을 보내지 않음(README의 B 계정 확인 순서로 직접 확인)
  }
  if (config.step >= 12) {
    // 12단계: 탈환 작전실 요약(/api/ops)도 로그인 없이는 거부되어야 합니다. 실제로 보내고 받은 응답만 적습니다.
    // 로그인·승인 기기로 연 작전실 화면의 내용은 토큰이 필요해 보내지 않습니다(README의 확인 순서로 직접 확인).
    const ops = await tryRead(new URL('/api/ops', app));
    results.push({ attackId: 'ops_summary_anonymous', expected: '토큰 없이 GET /api/ops를 요청하면 요약 없이 401 LOGIN_REQUIRED로 거부됨',
      observed: httpObserved(ops) });
  }
  return results;
}
