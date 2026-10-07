// GET·PUT·DELETE /api/notes/:id (메모 한 건 조회·수정·삭제).
// 공통 로직과 로그인 토큰 검사는 src/notes-service.mjs 에 있습니다.
// 알려진 허점(4단계에서 고칠 것): 아직 메모의 소유자를 검사하지 않습니다.
import { createNotesService } from '../../src/notes-service.mjs';

export default createNotesService().item;
