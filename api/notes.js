// GET /api/notes (로그인한 사용자의 메모 목록), POST /api/notes (메모 추가).
// 공통 로직과 로그인 토큰 검사는 src/notes-service.mjs 에 있습니다.
import { createNotesService } from '../src/notes-service.mjs';

export default createNotesService().collection;
