// The student changes this check as each stage adds an attack to the same app.
// Never return tokens, private keys, real names, or note bodies.
async function readJson(url, { headers, method, body } = {}) {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(10000),
    ...(method ? { method } : {}), ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body }),
  });
  let data = null;
  if (response.ok) {
    try {
      data = await response.json();
    } catch {
      // A non-JSON response is a failed check, not a successful deployment.
    }
  }
  return { status: response.status, data };
}

// 1단계는 { notes: [...] }, 이후 목록은 [...] 배열입니다. 둘 중 하나라도 메모가 들어 있으면 자료가 보인 것으로 봅니다.
const noteList = (data) => (Array.isArray(data) ? data : data?.notes);
const hasNotes = (data) => Array.isArray(noteList(data)) && noteList(data).length > 0;

export async function runAttackChecks(config) {
  if (![1, 2, 3].includes(config.step)) throw new Error('이 단계의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');
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
  const writeCheck = (attackId, label, result) => ({ attackId, expected: `토큰 없이 ${label}을 보내면 자료 없이 거부됨(401)`,
    observed: denied(result) ? `토큰 없는 ${label}이 거부됨 (HTTP ${result.status})` : `토큰 없는 ${label}이 거부되지 않음 (HTTP ${result.status})` });
  const denied = (result) => !hasNotes(result.data) && (result.status === 401 || result.status === 403);
  const results = [
    { attackId: 'anonymous_note_read', expected: '비로그인으로 옛 공개 /data.json을 요청해도 가상 메모가 보이지 않음',
      observed: hasNotes(legacy.data) ? '비로그인 요청에서 /data.json에 가상 메모가 아직 보임' : `비로그인 요청에서 /data.json에 가상 메모가 보이지 않음 (HTTP ${legacy.status})` },
    { attackId: 'anonymous_notes_api_read', expected: '토큰 없이 /api/notes를 요청하면 자료 없이 거부됨(401)',
      observed: denied(api) ? `토큰 없는 요청에서 /api/notes가 자료 없이 거부됨 (HTTP ${api.status})`
        : hasNotes(api.data) ? '토큰 없는 요청에서 /api/notes가 가상 메모를 돌려줌 (거부되지 않음)'
          : `토큰 없는 요청에서 자료는 없지만 거부 코드(401·403)가 아님 (HTTP ${api.status})` },
    { attackId: 'forged_token_notes_api_read', expected: '엉터리 토큰으로 /api/notes를 요청하면 자료 없이 거부됨(401)',
      observed: denied(forged) ? `엉터리 토큰 요청에서 /api/notes가 자료 없이 거부됨 (HTTP ${forged.status})`
        : hasNotes(forged.data) ? '엉터리 토큰 요청에서 /api/notes가 가상 메모를 돌려줌 (거부되지 않음)'
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
  return results;
}
