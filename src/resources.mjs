// 8단계: 자료 종류마다 서로 다른 자원 ID를 붙입니다. 이후 "자료마다 갈 수 있는 구역"을 나눌 때 이 ID로 구별합니다.
// 자원 ID는 서버가 정합니다. 요청을 받은 서버 함수(경로)로만 정하고, 브라우저가 보낸 헤더·쿼리·본문의 값은 읽지 않습니다.
// 기존 자료와 주소(/api/notes, /api/notes/:id)는 그대로이고, 이 파일은 표시(이름 붙이기)만 합니다. 접근 규칙은 바꾸지 않습니다.
export const RESOURCE_HEADER = 'X-Resource-Id';

export const RESOURCES = Object.freeze({
  // 내 자료실 메모: Supabase public.notes, 주인 본인만(4단계 소유자 검사 그대로).
  NOTE: 'vault.note',
  // 강사 공지: 아직 서버 함수와 자료가 없습니다. 메모와 섞이지 않도록 ID와 예정 경로(/api/notices…)만 먼저 정해 둡니다.
  NOTICE: 'class.notice',
});

const ROUTES = Object.freeze([
  [/^\/api\/notes(?:\/[^/?#]+)?\/?$/u, RESOURCES.NOTE],
  [/^\/api\/notices(?:\/[^/?#]+)?\/?$/u, RESOURCES.NOTICE],
]);

// 서버가 받은 요청 경로로 자원 ID를 찾습니다. 쿼리(?resource=…)는 떼고 보며, 어느 구역에도 맞지 않으면 null입니다.
export function resourceOf(url) {
  if (typeof url !== 'string' || !url.startsWith('/')) return null;
  const path = url.split(/[?#]/u, 1)[0];
  return ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}
