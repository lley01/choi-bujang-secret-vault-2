// The student changes this check as each stage adds an attack to the same app.
// Never return tokens, private keys, real names, or note bodies.
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

// 1단계는 { notes: [...] }, 이후 목록은 [...] 배열입니다. 둘 중 하나라도 메모가 들어 있으면 자료가 보인 것으로 봅니다.
const noteList = (data) => (Array.isArray(data) ? data : data?.notes);
const hasNotes = (data) => Array.isArray(noteList(data)) && noteList(data).length > 0;

export async function runAttackChecks(config) {
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(config.step)) throw new Error('이 단계의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');
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
  const legacy = await readJson(new URL('/data.json', app));
  const api = await readJson(new URL('/api/notes', app));
  const forged = await readJson(new URL('/api/notes', app), { headers: { Authorization: 'Bearer aaaaaaaa.bbbbbbbb.cccccccc' } });
  // 쓰기 경로도 로그인 없이는 거부되어야 합니다. 무작위 id를 쓰므로 거부되지 않아도 기존 메모는 건드리지 않습니다.
  const json = { 'Content-Type': 'application/json' };
  const writes = {
    create: await readJson(new URL('/api/notes', app), { method: 'POST', headers: json, body: JSON.stringify({ title: '점검', body: '점검' }) }),
    update: await readJson(new URL(`/api/notes/${crypto.randomUUID()}`, app), { method: 'PUT', headers: json, body: JSON.stringify({ title: '점검', body: '점검' }) }),
    remove: await readJson(new URL(`/api/notes/${crypto.randomUUID()}`, app), { method: 'DELETE' }),
  };
  // 거부는 우리 앱이 보낸 401 JSON({ error: 'LOGIN_REQUIRED' })일 때만 인정합니다.
  // 네트워크 프록시나 Vercel 로그인 보호 화면처럼 다른 곳이 막은 401·403은 앱의 거부가 아니므로 '판정 불가'로 적습니다.
  const denied = (result) => !hasNotes(result.data) && result.status === 401 && result.data?.error === 'LOGIN_REQUIRED';
  const blockedElsewhere = (result) => !denied(result) && !hasNotes(result.data) && (result.status === 401 || result.status === 403);
  const elsewhere = (result) => `판정 불가: 앱이 아닌 곳(네트워크 프록시·배포 보호 화면 등)의 응답으로 보임 (HTTP ${result.status})`;
  const writeCheck = (attackId, label, result) => ({ attackId, expected: `토큰 없이 ${label}을 보내면 자료 없이 거부됨(401)`,
    observed: denied(result) ? `토큰 없는 ${label}이 거부됨 (HTTP ${result.status})`
      : blockedElsewhere(result) ? `토큰 없는 ${label}: ${elsewhere(result)}`
        : `토큰 없는 ${label}이 거부되지 않음 (HTTP ${result.status})` });
  const results = [
    { attackId: 'anonymous_note_read', expected: '비로그인으로 옛 공개 /data.json을 요청해도 가상 메모가 보이지 않음',
      // 우리 앱은 /data.json에 401·403을 주지 않습니다(파일이 없으면 404). 401·403은 다른 곳이 막은 것이라 판정 불가로 적습니다.
      observed: hasNotes(legacy.data) ? '비로그인 요청에서 /data.json에 가상 메모가 아직 보임'
        : (legacy.status === 401 || legacy.status === 403) ? `비로그인 요청 ${elsewhere(legacy)}`
          : `비로그인 요청에서 /data.json에 가상 메모가 보이지 않음 (HTTP ${legacy.status})` },
    { attackId: 'anonymous_notes_api_read', expected: '토큰 없이 /api/notes를 요청하면 자료 없이 거부됨(401)',
      observed: denied(api) ? `토큰 없는 요청에서 /api/notes가 자료 없이 거부됨 (HTTP ${api.status})`
        : hasNotes(api.data) ? '토큰 없는 요청에서 /api/notes가 가상 메모를 돌려줌 (거부되지 않음)'
          : blockedElsewhere(api) ? `토큰 없는 요청 ${elsewhere(api)}`
            : `토큰 없는 요청에서 자료는 없지만 거부 코드(401·403)가 아님 (HTTP ${api.status})` },
    { attackId: 'forged_token_notes_api_read', expected: '엉터리 토큰으로 /api/notes를 요청하면 자료 없이 거부됨(401)',
      observed: denied(forged) ? `엉터리 토큰 요청에서 /api/notes가 자료 없이 거부됨 (HTTP ${forged.status})`
        : hasNotes(forged.data) ? '엉터리 토큰 요청에서 /api/notes가 가상 메모를 돌려줌 (거부되지 않음)'
          : blockedElsewhere(forged) ? `엉터리 토큰 요청 ${elsewhere(forged)}`
            : `엉터리 토큰 요청에서 자료는 없지만 거부 코드(401·403)가 아님 (HTTP ${forged.status})` },
    writeCheck('anonymous_note_create', 'POST /api/notes', writes.create),
    writeCheck('anonymous_note_update', 'PUT /api/notes/:id', writes.update),
    writeCheck('anonymous_note_delete', 'DELETE /api/notes/:id', writes.remove),
  ];
  if (config.step >= 3) {
    // 정상 로그인 요청은 학생 비밀번호나 심판이 발급한 토큰이 있어야 보낼 수 있습니다. 보내지 않았으므로 성공으로 쓰지 않고 미실행으로 남깁니다.
    results.push({ attackId: 'normal_login_notes_read', expected: '정상 로그인(심판 A 또는 학생)으로 /api/notes를 요청하면 자기 메모 목록을 받음',
      observed: '미실행: 로그인 토큰이 필요해 이 점검에서는 요청을 보내지 않음' });
  }
  if (config.step >= 4) {
    // 소유자 검사는 서로 다른 두 사용자의 로그인 토큰이 있어야 확인할 수 있습니다. 보내지 않았으므로 미실행으로 남깁니다.
    results.push({ attackId: 'other_owner_note_access', expected: '로그인한 B가 A의 메모 id로 GET·PUT·DELETE를 보내면 404로 거부되고 A의 메모는 그대로',
      observed: '미실행: 서로 다른 두 사용자의 로그인 토큰이 필요해 이 점검에서는 요청을 보내지 않음' });
  }
  if (config.step >= 5) {
    // 학습 DB의 Supabase REST를 직접 부르는 길은 로그인 토큰과 학습 DB 주소가 있어야 시험할 수 있습니다. 보내지 않았으므로 미실행으로 남깁니다.
    results.push({ attackId: 'direct_db_rest_access', expected: '로그인 토큰이나 publishable key로 학습 DB의 /rest/v1/notes를 직접 부르면 권한 없음으로 거부되고 메모는 서버 함수로만 다룸',
      observed: '미실행: 로그인 토큰과 학습 DB 주소가 필요해 이 점검에서는 요청을 보내지 않음(DB 권한은 SQL 확인 쿼리로 확인)' });
  }
  if (config.step >= 6) {
    // 미등록 기기 요청은 반 엔진이 확인한 기기 정보로만 만들 수 있어 심판이 보냅니다. 여기서는 보내지 않았으므로 미실행으로 남깁니다.
    results.push({ attackId: 'unregistered_device_notes_read', expected: '미등록 기기(deviceRegistered: false)의 자료실 요청은 판정기가 deny·device_not_registered로 거부',
      observed: '미실행: 미등록 기기 요청은 반 엔진의 기기 정보가 필요해 심판이 보냄(이 점검에서는 요청을 보내지 않음)' });
  }
  if (config.step >= 6 && RULE_IDS.includes('step_up_required')) {
    // 7단계: 제공 엔진이 "같은 내 로그인으로 다시 로그인한 시각"을 확인해 넘기는 계약이 저장소에 없습니다
    // (판정 요청의 stepUp에는 나이만 있고 같은 로그인에 묶는다는 내용, 다시 로그인 흐름, 앱 연결 계약이 없음).
    // 그래서 실제 자료 차단과 새 로그인 뒤 재판정은 보내지 않고 미실행으로 남깁니다. 토큰은 만들거나 기록하지 않습니다.
    results.push({ attackId: 'step_up_reauth_notes_read', expected: '복합 이상 접속은 다시 로그인 전 자료를 막고(step_up), 같은 로그인으로 다시 로그인한 뒤의 새 요청만 다시 판정해 허용',
      observed: '미실행: 제공 엔진의 다시 로그인 시각 확인 계약이 아직 없어 실제 자료 차단·재판정을 실측하지 않음(가상 사건 규칙만 npm run test:stage7로 시험)' });
  }
  if (config.step >= 9) {
    // 9단계: 탐지는 회수 제안(propose_revocation)만 만듭니다. 실제 기기 권한 회수와 걸린 시간은 심판이 확인하므로 여기서는 요청을 보내지 않습니다.
    results.push({ attackId: 'doppelganger_device_revocation', expected: '다른 네트워크 + 10분 안 다량 조회가 한 기기에서 나오면 그 기기 하나의 회수를 제안하고, 회수 뒤 그 기기의 자료 요청은 거부',
      observed: '미실행: 실제 회수와 걸린 시간은 심판이 확인함(탐지 제안만 npm run test:stage9로 시험, 이 점검에서는 요청을 보내지 않음)' });
  }
  if (config.step >= 9 && config.restoreRoute === 'POST /api/restore/:id') {
    // 10단계: 복원 뒤 다시 시험합니다. 이 점검은 복원을 마친 배포 주소에 실제로 요청을 보내고, 받은 응답만 결과로 적습니다.
    // - 금지 요청 4건: 토큰 없이·엉터리 토큰·다른 사이트 Origin·GET 으로 복원 경로를 부릅니다. 무작위 메모 ID와 0으로 채운 해시를 쓰므로
    //   거부되지 않더라도 실제 메모는 복원되지 않습니다. 우리 앱이 보낸 JSON 오류 코드일 때만 "거부됨"으로 적습니다.
    // - 정상 요청 2건: 로그인 없이도 열려야 하는 첫 화면과 배포 식별 파일(/aleph.json)을 받아, 복원 뒤에도 앱과 복원 경로가 배포돼 있는지 봅니다.
    // - 로그인 토큰이 필요한 시험(B의 정상 복원, 복원한 메모 읽기, A의 B 메모 복원 거부)은 보내지 않았으므로 미실행으로 남깁니다.
    const target = new URL(`/api/restore/${crypto.randomUUID()}`, app);
    const body = JSON.stringify({ contentSha256: '0'.repeat(64) });
    const restoreTry = (headers, method = 'POST') => readJson(target, { method, headers: { ...json, ...headers }, ...(method === 'POST' ? { body } : {}) });
    const forbidden = [
      ['restore_anonymous_after_restore', '토큰 없이 POST /api/restore/:id', await restoreTry({}), 401, 'LOGIN_REQUIRED'],
      ['restore_forged_token_after_restore', '엉터리 토큰으로 POST /api/restore/:id', await restoreTry({ Authorization: 'Bearer aaaaaaaa.bbbbbbbb.cccccccc' }), 401, 'LOGIN_REQUIRED'],
      ['restore_cross_site_after_restore', '다른 사이트 Origin으로 POST /api/restore/:id', await restoreTry({ Origin: 'https://attacker.invalid' }), 403, 'CROSS_SITE_REQUEST'],
      ['restore_wrong_method_after_restore', 'GET /api/restore/:id', await restoreTry({}, 'GET'), 405, 'METHOD_NOT_ALLOWED'],
    ];
    for (const [attackId, label, result, status, error] of forbidden) {
      const ours = result.status === status && result.data?.error === error;
      results.push({ attackId, expected: `복원 뒤 ${label}을 보내면 ${status} ${error}로 거부되고 아무것도 복원되지 않음`,
        observed: ours ? `${label}이 거부됨 (HTTP ${result.status} ${error})`
          : (result.status === 401 || result.status === 403) && !result.data?.error ? `${label}: ${elsewhere(result)}`
            : `${label}이 예상대로 거부되지 않음 (HTTP ${result.status}${typeof result.data?.error === 'string' ? ` ${result.data.error.slice(0, 40)}` : ''})` });
    }
    let screen = 0;
    try {
      const response = await fetch(new URL('/', app), { redirect: 'error', signal: AbortSignal.timeout(10000) });
      screen = response.status;
      const text = await response.text();
      screen = response.ok && text.includes('<title>BYTE BACK') ? 200 : -response.status;
    } catch {
      screen = 0;
    }
    results.push({ attackId: 'normal_screen_after_restore', expected: '복원 뒤 로그인 없이 첫 화면(/)을 열면 200과 자료실 화면이 옴',
      observed: screen === 200 ? '첫 화면이 열림 (HTTP 200, 자료실 화면 제목 확인)'
        : screen === 0 ? '첫 화면 요청 실패(네트워크 오류)' : `첫 화면이 자료실 화면이 아님 (HTTP ${Math.abs(screen)})` });
    const identity = await readJson(new URL('/aleph.json', app));
    // 10단계부터 /aleph.json에 restoreRoute도 실리므로 함께 확인합니다.
    const deployed = identity.status === 200 && identity.data?.step === config.step
      && Array.isArray(identity.data?.allowedRoutes) && identity.data.allowedRoutes.includes('POST /api/restore/:id')
      && (config.step < 10 || identity.data?.restoreRoute === config.restoreRoute);
    results.push({ attackId: 'normal_identity_after_restore', expected: '복원 뒤 /aleph.json에 현재 단계와 복원 경로(허용 경로, 10단계부터 restoreRoute)가 실림',
      observed: deployed ? `/aleph.json에 step ${identity.data.step}과 복원 경로가 실림 (HTTP 200)`
        : `/aleph.json이 현재 설정과 다름 (HTTP ${identity.status}, step ${typeof identity.data?.step === 'number' ? identity.data.step : '없음'})` });
    results.push({ attackId: 'restore_owner_flow_needs_login', expected: '시험 계정 B가 자기 메모를 복원하면 200이고, 복원한 메모를 다시 읽으면 사본 내용이며, A가 같은 요청을 보내면 404',
      observed: '미실행: B·A의 로그인 토큰과 사본 해시가 필요해 이 점검에서는 요청을 보내지 않음(README의 B 계정 확인 순서로 직접 확인)' });
  }
  return results;
}
