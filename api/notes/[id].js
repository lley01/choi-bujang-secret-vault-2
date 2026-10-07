// GET·PUT·DELETE /api/notes/:id (메모 한 건 조회·수정·삭제).
// 공통 로직과 로그인 토큰 검사는 src/notes-service.mjs 에 있습니다.
// 본인 메모만 다룹니다. 남의 메모나 주인 없는 메모는 없는 메모와 똑같이 404로 답합니다.
import { createNotesService } from '../../src/notes-service.mjs';

export default createNotesService().item;
