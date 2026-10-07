// The student changes this check as each stage adds an attack to the same app.
// Never return tokens, private keys, real names, or note bodies.
async function readJson(url, headers) {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(10000), ...(headers ? { headers } : {}),
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

const hasNotes = (data) => Array.isArray(data?.notes) && data.notes.length > 0;

export async function runAttackChecks(config) {
  if (config.step !== 1 && config.step !== 2) throw new Error('이 단계의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');
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
  const forged = await readJson(new URL('/api/notes', app), { Authorization: 'Bearer aaaaaaaa.bbbbbbbb.cccccccc' });
  const denied = (result) => !hasNotes(result.data) && (result.status === 401 || result.status === 403);
  return [
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
  ];
}
