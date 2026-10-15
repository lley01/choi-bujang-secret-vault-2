// GET /api/ops (12단계 탈환 작전실 요약). 공통 로직은 src/ops-service.mjs 에 있습니다.
// 읽기 전용이며, 서버가 이번 요청에서 실제로 확인한 값과 미실행을 구분해 돌려줍니다. 메모 제목·본문은 돌려주지 않습니다.
import { createOpsService } from '../src/ops-service.mjs';

export default createOpsService().summary;
