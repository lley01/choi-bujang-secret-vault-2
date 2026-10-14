// POST /api/restore/:id (비공개 가상 메모 사본에서 지정한 한 건만 복원). 서비스 이름은 restore 입니다.
// 공통 로직과 로그인·ID·소유자·내용 해시 대조는 src/restore-service.mjs 와 DB 함수 restore_note_from_backup 에 있습니다.
import { createRestoreService } from '../../src/restore-service.mjs';

export default createRestoreService().restore;
