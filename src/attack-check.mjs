// The student changes this check as each stage adds an attack to the same app.
// Never return tokens, private keys, real names, or note bodies.
async function readJson(url) {
  const response = await fetch(url, {
    redirect: 'error', signal: AbortSignal.timeout(10000),
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

  // 2단계: 옛 공개 파일은 사라져야 하고, 새 서버 함수는 아직 공개라는 약점을 있는 그대로 기록합니다.
  const legacy = await readJson(new URL('/data.json', app));
  const api = await readJson(new URL('/api/notes', app));
  return [
    { attackId: 'anonymous_note_read', expected: '비로그인으로 옛 공개 /data.json을 요청해도 가상 메모가 보이지 않음',
      observed: hasNotes(legacy.data) ? '비로그인 요청에서 /data.json에 가상 메모가 아직 보임' : `비로그인 요청에서 /data.json에 가상 메모가 보이지 않음 (HTTP ${legacy.status})` },
    { attackId: 'anonymous_notes_api_read', expected: '알려진 약점 확인: 로그인 없이 /api/notes로 가상 메모를 읽을 수 있음(아직 막지 않음)',
      observed: hasNotes(api.data) ? '비로그인 요청에서 /api/notes가 가상 메모를 돌려줌 (약점이 남아 있음)' : `비로그인 요청에서 /api/notes가 가상 메모를 돌려주지 않음 (HTTP ${api.status})` },
  ];
}
