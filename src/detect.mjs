// 9단계에서 학생이 채우는 탐지 함수입니다. 이 기본값은 어떤 접속도 회수하지 않습니다.
// 반 엔진이 검증한 사건만 전달해야 하며, 브라우저가 보낸 사용자 번호는 받지 않습니다.

import { burstRead, readAccessContext } from './decider.mjs';

// 9단계 입력 정리: 가상 사건(docs/DETECT_EVENTS.md)에서 아래 값만 읽고 나머지는 버립니다.
// - at: 사건 시각(10분 구간을 세는 데 필요). 밀리초 숫자로 바꿉니다.
// - subject: 가명 사용자(identity.sub). identity의 다른 값(이메일·이름 등)은 읽지 않습니다.
// - device: 기기 ID(deviceId, 16자리 소문자 16진수). 현재 연습 사건에는 없어서 null입니다.
// - method: 요청 종류(GET·POST·PUT·PATCH·DELETE).
// - decision: 판정(allow·deny·step_up). 현재 연습 사건에는 없어서 null입니다.
// - network: (9단계 제작 2) 엔진이 확인한 가상 네트워크 표시. 판정 계약과 같은 모양 signals {source, network}에서
//   source가 'judge_fixture'일 때만 읽습니다('usual'·'unusual' 등). 출처가 없거나 불명확하면 null입니다. 지역(region)은 읽지 않습니다.
// 메모 제목·본문, 토큰, 실명, 요청 본문·헤더는 읽지도 저장하지도 출력하지도 않습니다. 이 파일은 로그를 남기지 않습니다.
// 값이 없거나 형식이 틀리면 정상값으로 채우지 않고 null로 둡니다. 시각이나 가명 사용자가 없는 사건은 누구의 것인지 알 수 없어 뺍니다.
// 가명이 이메일·공백·한글처럼 실명이나 연락처로 보이는 값이면 저장하지 않고 그 사건을 뺍니다.
const PSEUDONYM = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DEVICE_ID = /^[0-9a-f]{16}$/u;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DECISIONS = new Set(['allow', 'deny', 'step_up']);
const NETWORK = /^[a-z][a-z0-9_]{0,31}$/u;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, name) => (isPlainObject(value) && Object.hasOwn(value, name)
  && Object.getOwnPropertyDescriptor(value, name).get === undefined ? value[name] : undefined);

function timeOf(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function readEvent(event) {
  const at = timeOf(own(event, 'at'));
  const sub = own(own(event, 'identity'), 'sub');
  const subject = typeof sub === 'string' && PSEUDONYM.test(sub) ? sub : null;
  if (at === null || subject === null) return null;
  const deviceId = own(event, 'deviceId');
  const method = own(event, 'method');
  const decision = own(event, 'decision');
  const signals = own(event, 'signals');
  const network = own(signals, 'source') === 'judge_fixture' ? own(signals, 'network') : undefined;
  return Object.freeze({
    at,
    subject,
    device: typeof deviceId === 'string' && DEVICE_ID.test(deviceId) ? deviceId : null,
    method: METHODS.has(method) ? method : null,
    decision: DECISIONS.has(decision) ? decision : null,
    network: typeof network === 'string' && NETWORK.test(network) && network !== 'unknown' ? network : null,
  });
}

// 정리된 사건 목록(시각 순). 원본 배열과 사건은 바꾸지 않습니다.
export function readDetectionEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('invalid_detection_events');
  return Object.freeze(events.map(readEvent).filter(Boolean).sort((a, b) => a.at - b.at));
}

// 9단계 제작 2 탐지 규칙 unusual_network_burst: "평소와 다른 네트워크"와 "갑작스러운 다량 조회"가 함께 나타날 때만 의심으로 표시합니다.
// - 같은 가명 사용자가 평소와 다른 네트워크(network: 'unusual')에서 보낸 조회(GET)가 어느 10분 구간에서든 120건을 넘을 때만 표시합니다.
//   (120건 기준과 10분 구간은 docs/DETECT_EVENTS.md의 다량 조회 기준을 그대로 씁니다. 정확히 120건은 표시하지 않습니다.)
// - 둘 중 하나만 보이면(평소 네트워크의 다량 조회, 다른 네트워크의 적은 조회) 표시하지 않습니다. 네트워크를 모르는 사건(null)은 세지 않습니다.
// - 지역은 읽지도 쓰지도 않으므로 지역 하나만으로 확정하는 일이 없습니다. 다른 사용자의 사건은 합치지 않습니다.
// - 결과는 의심 표시 목록입니다([{ subject, reasonCode }], 먼저 탐지된 순). 회수 제안은 아래 detect가 따로 만듭니다.
export const SUSPICION_RULE = 'unusual_network_burst';
const WINDOW_MS = 10 * 60 * 1000;
const BURST_LIMIT = 120;

// 같은 가명 사용자의 "다른 네트워크 조회"가 처음으로 10분 안 120건을 넘은 구간을 찾습니다(사용자당 하나).
// 그 구간 사건들의 기기 ID 목록과, 기기를 모르는 사건이 섞였는지도 함께 돌려줍니다.
function burstWindows(events) {
  const reads = new Map();
  for (const event of readDetectionEvents(events)) {
    if (event.method !== 'GET' || event.network !== 'unusual') continue;
    if (!reads.has(event.subject)) reads.set(event.subject, []);
    reads.get(event.subject).push(event);
  }
  const windows = [];
  for (const [subject, list] of reads) {
    let start = 0;
    for (let end = 0; end < list.length; end += 1) {
      while (list[end].at - list[start].at >= WINDOW_MS) start += 1;
      if (end - start + 1 > BURST_LIMIT) {
        const inWindow = list.slice(start, end + 1);
        windows.push({ subject, detectedAt: list[end].at,
          devices: new Set(inWindow.map((event) => event.device).filter(Boolean)),
          unknownDevice: inWindow.some((event) => event.device === null) });
        break;
      }
    }
  }
  return windows.sort((a, b) => a.detectedAt - b.detectedAt || (a.subject < b.subject ? -1 : 1));
}

export function findSuspicious(events) {
  return Object.freeze(burstWindows(events).map(({ subject }) => Object.freeze({ subject, reasonCode: SUSPICION_RULE })));
}

// 9단계 제작 3 회수 제안(고침): 탐지 규칙이 복합 이상 패턴을 찾으면 별도의 탐지 결과(detect의 반환값)로 propose_revocation을 제안합니다.
// 판정기의 허용/거부 응답(5항목)은 그대로입니다. 이 파일은 제안만 돌려주고, 회수 API를 만들거나 부르지 않으며 권한·세션·DB를 바꾸지 않고 로그도 남기지 않습니다.
// 실제 회수와 걸린 시간은 심판이 확인합니다.
//
// 결과 모양은 docs/DETECT_EVENTS.md 계약을 따릅니다: { action: 'propose_revocation', reasonCode: 'burst_read', subject: 가명 }
// - 이유 코드는 계약에 적힌 burst_read를 씁니다(운영 등록부에 없는 코드를 새로 만들지 않음).
// - 대상 기기: 탐지 구간의 사건이 모두 같은 확인된 기기 ID(16자리 deviceId)에서 왔으면 그 기기 하나를 deviceId로 덧붙입니다.
//   기기 칸이 없는 계약 사건은 가명만으로 제안합니다(기기를 지어내지 않음). 기기가 둘 이상 섞이면 한 기기로 좁힐 수 없어 제안하지 않습니다.
// 복합 이상 패턴(탐지 사건 모양): 같은 가명의 조회(GET)가 어느 10분 구간에서든 120건을 넘고, 그 구간의 네트워크가 "모두 평소(usual)"로
//   확인되지 않은 경우입니다. 다른 네트워크(unusual)가 섞였거나 네트워크 정보가 없으면(계약 사건) 제안합니다.
//   평소 네트워크로 확인된 다량 조회만 있으면 제안하지 않습니다. 지역은 보지 않습니다. 정확히 120건은 제안하지 않습니다.
export const REVOCATION_REASON = 'burst_read';

function readWindows(events) {
  const reads = new Map();
  for (const event of readDetectionEvents(events)) {
    if (event.method !== 'GET') continue;
    if (!reads.has(event.subject)) reads.set(event.subject, []);
    reads.get(event.subject).push(event);
  }
  const windows = [];
  for (const [subject, list] of reads) {
    let start = 0;
    for (let end = 0; end < list.length; end += 1) {
      while (list[end].at - list[start].at >= WINDOW_MS) start += 1;
      if (end - start + 1 > BURST_LIMIT) {
        windows.push({ subject, detectedAt: list[end].at, events: list.slice(start, end + 1) });
        break;
      }
    }
  }
  return windows.sort((a, b) => a.detectedAt - b.detectedAt || (a.subject < b.subject ? -1 : 1));
}

function proposalFor({ subject, events }) {
  if (events.every((event) => event.network === 'usual')) return null;
  const devices = new Set(events.map((event) => event.device));
  if (devices.size > 1) return null;
  const [device] = devices;
  return device ? { action: 'propose_revocation', reasonCode: REVOCATION_REASON, subject, deviceId: device }
    : { action: 'propose_revocation', reasonCode: REVOCATION_REASON, subject };
}

// 복합 의심 사건(판정 요청 모양, docs/DECIDER_REQUEST.md): 엔진이 확인한 등록 기기(deviceRegistered: true, 16자리 deviceId)에서
// 다른 네트워크(signals.source 'judge_fixture'의 network 'unusual')와 다량 조회(recentEvents 최근 300초 합계 10건 이상)가 함께 보이면
// 그 기기 하나의 회수를 같은 모양으로 제안합니다. 입력 검사는 판정기의 readAccessContext를 그대로 씁니다.
export function proposeRevocation(request) {
  if (!isPlainObject(request) || own(request, 'schema') !== 'aleph.decision.v1') return null;
  const deviceId = own(request, 'deviceId');
  const subject = own(request, 'subjectId');
  if (own(request, 'deviceRegistered') !== true || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)
      || typeof subject !== 'string' || !PSEUDONYM.test(subject)) return null;
  const context = readAccessContext(request);
  if (context.network !== 'unusual' || !burstRead(context.recentEvents)) return null;
  return { action: 'propose_revocation', reasonCode: REVOCATION_REASON, subject, deviceId };
}

// 한 번에 한 대상만 제안합니다. 판정 요청 모양의 복합 의심 사건이 있으면 배열에서 먼저 나온 것을, 없으면 가장 먼저 탐지된 구간을 고릅니다.
export function detect(events) {
  if (!Array.isArray(events)) throw new TypeError('invalid_detection_events');
  for (const item of events) {
    const composite = proposeRevocation(item);
    if (composite) return composite;
  }
  for (const window of readWindows(events)) {
    const proposal = proposalFor(window);
    if (proposal) return proposal;
  }
  return { action: 'observe' };
}
