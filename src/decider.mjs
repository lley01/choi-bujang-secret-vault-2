// ALEPH SDP 엔진이 확인한 요청만 받는 학생 판정기 시작점입니다.
// 6단계부터 규칙을 하나씩 추가합니다. 어느 규칙에도 해당하지 않으면 시작 틀의 기본 응답으로 거부합니다.
// 요청 본문의 userId, role, 기기 키, 토큰을 별도로 믿거나 저장하지 마세요.
// 요청 항목은 docs/DECIDER_REQUEST.md 의 계약(aleph.decision.v1)에 있는 값만 씁니다.
export const RULE_IDS = Object.freeze(['starter.deny', 'device_registered']);

const respond = (request, decision, reasonCode, ruleId) => ({
  schema: 'aleph.decision.v1',
  requestId: request.requestId,
  decision,
  reasonCode,
  ruleIds: [ruleId],
});

// 6단계 device_registered: 엔진이 확인한 기기 등록 여부(request.deviceRegistered)가 true일 때만 내 자료실 읽기(GET)를 허용합니다.
// 값이 없거나 true가 아니면(false, 문자열 "true", 1 등) 미등록으로 보고 거부합니다.
function deviceRegistered(request) {
  if (request.deviceRegistered !== true) return respond(request, 'deny', 'device_not_registered', 'device_registered');
  if (request.method === 'GET') return respond(request, 'allow', 'approved', 'device_registered');
  return null;
}

export async function decide(request) {
  return deviceRegistered(request)
    ?? respond(request, 'deny', 'starter_not_ready', RULE_IDS[0]);
}
