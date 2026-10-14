// ALEPH SDP 엔진이 확인한 요청만 받는 학생 판정기 시작점입니다.
// 6단계부터 규칙을 하나씩 추가합니다. 어느 규칙에도 해당하지 않으면 시작 틀의 기본 응답으로 거부합니다.
// 요청 본문의 userId, role, 기기 키, 토큰을 별도로 믿거나 저장하지 마세요.
// 요청 항목은 docs/DECIDER_REQUEST.md 의 계약(aleph.decision.v1)에 있는 값만 씁니다.
export const RULE_IDS = Object.freeze(['starter.deny', 'device_registered', 'step_up_required', 'resource_zone']);

const respond = (request, decision, reasonCode, ruleId) => ({
  schema: 'aleph.decision.v1',
  requestId: request.requestId,
  decision,
  reasonCode,
  ruleIds: Array.isArray(ruleId) ? [...ruleId] : [ruleId],
});

// 6단계 device_registered: 엔진이 확인한 기기 등록 여부(request.deviceRegistered)가 true일 때만 내 자료실을 열어 줍니다.
// 값이 없거나 true가 아니면(false, 문자열 "true", 1 등) 미등록으로 보고 어떤 요청이든 거부합니다.
// (8단계부터) 등록 기기라도 어느 경로를 열지는 아래 resource_zone 규칙이 정합니다. 이 규칙은 미등록 거부만 맡습니다.
function deviceRegistered(request) {
  if (request.deviceRegistered !== true) return respond(request, 'deny', 'device_not_registered', 'device_registered');
  return null;
}

// 8단계 resource_zone: 계약의 service·method·path·route만 보고 자료를 세 구역으로 나눕니다. 맞는 모양만 열고 나머지는 모두 거부합니다.
//
// | 구역 | service | 허용(정확한 경로 모양) | 거부 |
// |---|---|---|---|
// | 메모 | notes | GET·PUT·DELETE /notes/:id (자료 ID 하나) | ID 없는 목록·추가(/notes), 그 밖의 메서드, 더 깊은 경로 |
// | 반 공지 | notices | GET /notices, GET /notices/:id | 쓰기(POST·PUT·PATCH·DELETE)는 누구에게나 거부 |
// | 강사 자료 | materials | 없음 | 모든 요청 |
//
// - 경로 모양은 계약 예시(route: 'GET /notes/:id', path: '/notes/demo')를 따르고, aleph.config.json과 같은 '/api' 접두 모양도 받습니다.
//   route는 'METHOD 모양'과 글자 그대로 같아야 하고, path는 그 모양에 ID 한 칸을 넣은 것이어야 하며, service도 구역과 같아야 합니다.
// - 쿼리로 기능을 고르지 않습니다. 쿼리가 붙은 요청(queryLength가 0이 아니거나 빈 쿼리 지문이 아님)은 거부합니다.
// - :id와 같은 깊이에 export 같은 기능 경로를 두지 않습니다. 그래서 /notes/export도 "ID가 export인 메모"일 뿐이고, 기능으로 해석하지 않습니다.
// - 심판의 가상 메모 ID는 UUID가 아닐 수 있어 ID 형식을 좁히지 않습니다. 빈 칸·'.'·'..'·인코딩된 / 와 \ 처럼 한 칸이 아닌 것만 막습니다.
// - 판정 요청에는 역할(role)이 없으므로 강사의 공지 수정은 판정기가 아니라 서버의 관리 경로에서 처리합니다. 판정기는 공지 쓰기를 모두 거부합니다.
// - 메모 주인 비교는 판정기가 하지 않습니다. 허용된 요청도 메모 API(src/notes-service.mjs)가 로그인과 owner_id를 다시 확인합니다.
// - 이유 코드: 허용 approved, 알 수 없는 경로·쿼리·모양 불일치 route_not_allowed, 공지 쓰기 notice_read_only, 강사 자료 instructor_materials_denied.
const EMPTY_QUERY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const PREFIXES = ['', '/api'];
const ZONES = Object.freeze([
  { name: 'notes', allow: [['GET', '/notes/:id'], ['PUT', '/notes/:id'], ['DELETE', '/notes/:id']] },
  { name: 'notices', allow: [['GET', '/notices'], ['GET', '/notices/:id']], readOnly: true },
  { name: 'materials', allow: [], closed: true },
]);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const isOneSegment = (value) => typeof value === 'string' && value.length > 0 && !/[/?#\\]/u.test(value)
  && value !== '.' && value !== '..' && !/%(?:2f|5c|2e%2e)/iu.test(value) && !/^%2e$/iu.test(value);

// path가 모양(:id 자리 한 칸)과 맞는지 봅니다.
function pathFits(path, shape) {
  if (!shape.endsWith('/:id')) return path === shape;
  const base = shape.slice(0, -':id'.length);
  return path.startsWith(base) && isOneSegment(path.slice(base.length));
}

// 경로가 어느 구역에 속하는지(서비스 이름의 첫 칸) 봅니다. '/api' 접두는 떼고 봅니다.
function zoneOfPath(path) {
  if (typeof path !== 'string') return null;
  const rest = path.startsWith('/api/') ? path.slice(4) : path;
  return ZONES.find((zone) => rest === `/${zone.name}` || rest.startsWith(`/${zone.name}/`)) ?? null;
}

function resourceZone(request) {
  const deny = (reasonCode) => respond(request, 'deny', reasonCode, 'resource_zone');
  const { service, method, path, route } = request;
  // service와 path가 가리키는 구역을 둘 다 보고, 더 엄격한 쪽을 먼저 적용합니다(이름만 바꿔 공지 쓰기·강사 자료를 피할 수 없게).
  const zones = [ZONES.find((item) => item.name === service), zoneOfPath(path)].filter(Boolean);
  if (zones.some((zone) => zone.closed)) return deny('instructor_materials_denied');
  if (zones.some((zone) => zone.readOnly) && WRITE_METHODS.has(method)) return deny('notice_read_only');
  const zone = zones[0];
  if (!zone || zones.length !== 2 || zones[1] !== zone) return deny('route_not_allowed');
  if (request.queryLength !== 0 || request.querySha256 !== EMPTY_QUERY_SHA256) return deny('route_not_allowed');
  const fits = zone.allow.some(([allowedMethod, shape]) => PREFIXES.some((prefix) => method === allowedMethod
    && route === `${allowedMethod} ${prefix}${shape}` && pathFits(path, `${prefix}${shape}`)));
  return fits ? null : deny('route_not_allowed');
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

// (9단계) 탐지의 회수 제안(src/detect.mjs)도 같은 다량 조회 기준을 쓰도록 내보냅니다. 판정 결과에는 영향이 없습니다.
export function burstRead(events) {
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

// 순서: ① 기기(미등록이면 거부) → ② 구역(허용 모양이 아니면 거부) → ③ 복합 이상이면 추가 확인 → ④ 허용.
// 요청이 객체가 아니면 시작 틀의 기본 거부로 답합니다.
export async function decide(request) {
  if (request === null || typeof request !== 'object') return respond(request ?? {}, 'deny', 'starter_not_ready', RULE_IDS[0]);
  return deviceRegistered(request)
    ?? resourceZone(request)
    ?? stepUpRequired(request)
    ?? respond(request, 'allow', 'approved', ['device_registered', 'resource_zone']);
}
