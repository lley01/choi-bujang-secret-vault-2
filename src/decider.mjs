// ALEPH SDP 엔진이 확인한 요청만 받는 학생 판정기 시작점입니다.
// 6단계부터 규칙을 하나씩 추가합니다. 어느 규칙에도 해당하지 않으면 시작 틀의 기본 응답으로 거부합니다.
// 요청 본문의 userId, role, 기기 키, 토큰을 별도로 믿거나 저장하지 마세요.
// 요청 항목은 docs/DECIDER_REQUEST.md 의 계약(aleph.decision.v1)에 있는 값만 씁니다.
export const RULE_IDS = Object.freeze(['starter.deny', 'device_registered', 'step_up_required']);

const respond = (request, decision, reasonCode, ruleId) => ({
  schema: 'aleph.decision.v1',
  requestId: request.requestId,
  decision,
  reasonCode,
  ruleIds: [ruleId],
});

// 6단계 device_registered: 엔진이 확인한 기기 등록 여부(request.deviceRegistered)가 true일 때만 내 자료실을 열어 줍니다.
// 등록 기기는 기존 화면이 쓰는 메서드(aleph.config.json의 allowedRoutes: 화면 열기·로그인·메모 읽기와 추가·수정·삭제)를 허용합니다.
// 이 판정 뒤에도 서버 함수의 로그인 검사와 메모 소유자 검사는 그대로 거칩니다. 그 밖의 메서드는 기본 거부가 답합니다.
// 값이 없거나 true가 아니면(false, 문자열 "true", 1 등) 미등록으로 보고 어떤 요청이든 거부합니다.
const SCREEN_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

function deviceRegistered(request) {
  if (request.deviceRegistered !== true) return respond(request, 'deny', 'device_not_registered', 'device_registered');
  if (SCREEN_METHODS.has(request.method)) return respond(request, 'allow', 'approved', 'device_registered');
  return null;
}

// 7단계 입력 검사: 엔진이 넘긴 접속 정보(signals·recentEvents)를 출처별로 읽습니다. 아래 step_up_required 규칙이 이 값만 씁니다.
// - 계약의 18개 이름 밖의 항목(예: headers, x-forwarded-for, geo)이 섞인 요청은 엔진이 만든 요청이 아니므로 출처 'unclear'로 봅니다.
//   그 항목의 값은 어떤 경우에도 읽지 않습니다. 클라이언트가 보낸 헤더가 신뢰하는 접속 정보로 올라가지 않게 하려는 것입니다.
// - signals.source 'judge_fixture': 심판의 가상 접속 정보입니다(virtual: true). 실제 위치 증거가 아닙니다.
// - signals.source 'none': 현재 실제 경로입니다. 엔진이 확인한 지역·네트워크·시각이 없으므로 모두 null입니다.
// - 그 밖의 출처, 대소문자·공백이 다른 값, 모양이 다른 signals: 'unclear'이고 모두 null입니다.
// 값이 없거나 형식이 틀리면 null(모름)로 두고 missing에 적습니다. 'local'·'usual'·현재 시각 같은 정상값으로 채우지 않습니다.
// 행동(recentEvents)은 엔진이 직접 넘긴 항목이라 signals.source와 따로 검사합니다. 빈 배열 []은 "사건 없음"이고, 값이 없거나 틀리면 null(모름)입니다.
const CONTRACT_FIELDS = new Set(['schema', 'requestId', 'classId', 'projectId', 'subjectId', 'deviceId', 'service', 'method', 'path', 'route',
  'queryLength', 'querySha256', 'at', 'policyRevision', 'deviceRegistered', 'stepUp', 'recentEvents', 'signals']);
const SIGNAL_FIELDS = ['hour', 'network', 'region', 'source'];
const EVENT_FIELDS = ['ageSeconds', 'count', 'kind'];
const TOKEN = /^[a-z][a-z0-9_]{0,31}$/u;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hasExactly = (value, names) => isPlainObject(value) && Object.keys(value).sort().join(',') === names.join(',')
  && names.every((name) => Object.getOwnPropertyDescriptor(value, name)?.get === undefined);
const token = (value) => (typeof value === 'string' && TOKEN.test(value) && value !== 'unknown' ? value : null);
const hourOf = (value) => (Number.isInteger(value) && value >= 0 && value <= 23 ? value : null);
const count = (value, min) => Number.isSafeInteger(value) && value >= min;

function readEvents(events) {
  if (!Array.isArray(events) || events.length > 12) return null;
  const ok = events.every((event) => hasExactly(event, EVENT_FIELDS) && token(event.kind) !== null
    && count(event.ageSeconds, 0) && count(event.count, 1));
  return ok ? Object.freeze(events.map(({ kind, ageSeconds, count: n }) => Object.freeze({ kind, ageSeconds, count: n }))) : null;
}

export function readAccessContext(request) {
  const fromEngine = isPlainObject(request) && Object.keys(request).every((name) => CONTRACT_FIELDS.has(name));
  const signals = fromEngine && hasExactly(request.signals, SIGNAL_FIELDS) ? request.signals : null;
  const source = ['judge_fixture', 'none'].includes(signals?.source) ? signals.source : 'unclear';
  const known = source === 'judge_fixture';
  const context = {
    source,
    virtual: known,
    region: known ? token(signals.region) : null,
    network: known ? token(signals.network) : null,
    hour: known ? hourOf(signals.hour) : null,
    recentEvents: fromEngine ? readEvents(request.recentEvents) : null,
  };
  context.missing = Object.freeze(['region', 'network', 'hour', 'recentEvents'].filter((name) => context[name] === null));
  return Object.freeze(context);
}

// 7단계 step_up_required: 평소와 다른 시각 + 처음 보는 네트워크 + 갑작스러운 대량 읽기가 "모두" 보일 때만 추가 본인 확인(step_up)을 요청합니다.
// - 사유는 reasonCode 'step_up_required'와 ruleIds ['step_up_required']로 응답에 남습니다(응답 다섯 항목은 그대로).
// - 지역(region)은 조건에 넣지 않습니다. 지역 하나만으로는 거부도 추가 확인도 하지 않고, 영구 차단(deny)은 이 규칙에 없습니다.
// - 값이 없거나 출처가 불명확하면(readAccessContext가 null) 그 조건은 "이상"으로도 "정상"으로도 세지 않으므로 이 규칙이 켜지지 않습니다.
// - 이미 추가 확인을 마친 경우(stepUp.verified가 true이고 authAgeSeconds가 계약 범위 0~900초)에만 다시 묻지 않습니다.
//   이 값은 복합 이상이 보였을 때만 확인하며, 이 값만으로 다른 규칙을 건너뛰지 않습니다.
// - 기준값은 연습용 고정값입니다. 사용자별 "평소" 이력은 계약에 없어 쓰지 않습니다.
const UNUSUAL_HOURS = new Set([0, 1, 2, 3, 4, 5]);
const UNFAMILIAR_NETWORKS = new Set(['unusual']);
const BURST_WINDOW_SECONDS = 300;
const BURST_MIN_COUNT = 10;

function burstRead(events) {
  if (events === null) return false;
  const recent = events.filter((event) => event.ageSeconds <= BURST_WINDOW_SECONDS);
  return recent.reduce((total, event) => total + event.count, 0) >= BURST_MIN_COUNT;
}

function recentlyVerified(stepUp) {
  return hasExactly(stepUp, ['authAgeSeconds', 'verified']) && stepUp.verified === true
    && Number.isInteger(stepUp.authAgeSeconds) && stepUp.authAgeSeconds >= 0 && stepUp.authAgeSeconds <= 900;
}

function stepUpRequired(request) {
  const context = readAccessContext(request);
  const unusual = context.hour !== null && UNUSUAL_HOURS.has(context.hour)
    && context.network !== null && UNFAMILIAR_NETWORKS.has(context.network)
    && burstRead(context.recentEvents);
  if (!unusual || recentlyVerified(request.stepUp)) return null;
  return respond(request, 'step_up', 'step_up_required', 'step_up_required');
}

// 순서: 기기 규칙이 먼저입니다(미등록이면 거부, 화면이 쓰지 않는 메서드면 기본 거부).
// 기기 규칙이 허용할 요청에만 step_up_required를 확인합니다.
export async function decide(request) {
  const device = deviceRegistered(request);
  if (device?.decision === 'allow') return stepUpRequired(request) ?? device;
  return device ?? respond(request, 'deny', 'starter_not_ready', RULE_IDS[0]);
}
