// 8단계 제작 3: 자료 API의 마지막 권한 대조입니다. 판정기가 허용한 요청이라도 서버가 다시 확인합니다.
// - 사용자: 로그인 검사기(src/verify-login.mjs)가 확인한 userId만 씁니다.
// - 소유자: 저장소(public.notes)에 저장된 owner_id만 씁니다.
// - 강사 권한: 서버가 저장소에서 읽은 값(readStoredRole)만 씁니다. 화면 메뉴, 요청 본문·헤더·쿼리의 role, 토큰의 주장은 믿지 않습니다.
// 거부하면 짧은 사유 코드(아래 DENY)를 돌려주고, 호출한 API가 그 코드만 로그에 남깁니다. ID·토큰·본문은 남기지 않습니다.
import { RESOURCES } from './resources.mjs';

export const DENY = Object.freeze({
  NO_USER: 'no_verified_user',
  OWNER_MISSING: 'owner_missing',
  NOT_OWNER: 'not_owner',
  NOT_INSTRUCTOR: 'not_instructor',
  UNKNOWN: 'unknown_resource',
});

export const INSTRUCTOR_MATERIAL = 'instructor.material';
const INSTRUCTOR = 'instructor';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const sameUser = (a, b) => typeof a === 'string' && typeof b === 'string' && UUID.test(a) && a.toLowerCase() === b.toLowerCase();

// resource: 자원 ID, action: 'read' | 'write', userId: 검사기가 확인한 사용자, ownerId: 저장된 소유자, storedRole: 서버가 읽은 역할
export function checkAccess({ resource, action, userId, ownerId, storedRole } = {}) {
  const deny = (reason) => Object.freeze({ allowed: false, reason });
  if (typeof userId !== 'string' || !UUID.test(userId)) return deny(DENY.NO_USER);
  const instructor = storedRole === INSTRUCTOR;
  if (resource === RESOURCES.NOTE) {
    // 메모는 주인 본인만. 강사라도 남의 메모는 열 수 없습니다.
    if (ownerId === null || ownerId === undefined || ownerId === '') return deny(DENY.OWNER_MISSING);
    return sameUser(ownerId, userId) ? Object.freeze({ allowed: true }) : deny(DENY.NOT_OWNER);
  }
  if (resource === RESOURCES.NOTICE) {
    // 반 공지: 읽기는 로그인한 사용자 모두, 쓰기는 저장된 강사 권한이 있을 때만(서버의 관리 경로용).
    if (action === 'read') return Object.freeze({ allowed: true });
    if (action === 'write') return instructor ? Object.freeze({ allowed: true }) : deny(DENY.NOT_INSTRUCTOR);
    return deny(DENY.UNKNOWN);
  }
  if (resource === INSTRUCTOR_MATERIAL) {
    return ['read', 'write'].includes(action) && instructor ? Object.freeze({ allowed: true }) : deny(DENY.NOT_INSTRUCTOR);
  }
  return deny(DENY.UNKNOWN);
}

// 저장된 강사 권한을 서버 전용 키로 읽습니다. Supabase Auth 사용자의 app_metadata.class_role 이 'instructor'일 때만 강사입니다.
// app_metadata는 서버 전용 키로만 바꿀 수 있는 값입니다(사용자가 바꾸는 user_metadata는 쓰지 않습니다).
// 사용자가 없거나(심판의 가상 사용자 등) 읽기에 실패하면 강사가 아닌 것으로 봅니다.
export async function readStoredRole(supabase, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) return null;
  try {
    const { data, error } = (await supabase?.auth?.admin?.getUserById?.(userId)) ?? {};
    if (error || !data?.user || !sameUser(data.user.id, userId)) return null;
    return data.user.app_metadata?.class_role === INSTRUCTOR ? INSTRUCTOR : null;
  } catch {
    return null;
  }
}
