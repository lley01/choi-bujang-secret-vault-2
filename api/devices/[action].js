// /api/devices/status·challenge·register·verify (11단계 기기 승인). 공통 로직은 src/device-service.mjs 에 있습니다.
// 승인 요청은 대기(pending)로만 저장하고, 승인은 학생이 SQL로 합니다. 승인된 기기의 서명을 확인한 뒤에만 기기 세션을 줍니다.
import { createDeviceService } from '../../src/device-service.mjs';

export default createDeviceService().route;
