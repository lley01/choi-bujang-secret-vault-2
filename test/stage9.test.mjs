import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SUSPICION_RULE, detect, findSuspicious, readDetectionEvents } from '../src/detect.mjs';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';

// 9단계 입력 정리. 가상 사건으로 시험합니다. 실제 접속 회수나 심판 판정이 아닙니다.
const AT = '2026-10-01T00:00:00.000Z';
const event = (extra = {}) => ({ at: AT, method: 'GET', identity: { sub: 'learner_fixture' }, ...extra });

test('설정은 9단계이고 빌드·배포 식별이 9단계를 받으며 10단계는 거부한다', () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.equal(config.step, 9);
  const env = { VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
    VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40), VERCEL_URL: 'defense-app-ghi789.vercel.app' };
  assert.equal(deploymentIdentity(env, config).step, 9);
  assert.throws(() => deploymentIdentity(env, { ...config, step: 10 }), /배포 식별 정보를 확인할 수 없습니다/u);
});

test('가명 사용자·기기·요청 종류·판정(과 시각, 9단계 제작 2의 네트워크)만 읽는다', () => {
  const [read] = readDetectionEvents([event({ deviceId: 'a1b2c3d4e5f60718', decision: 'step_up' })]);
  assert.deepEqual({ ...read }, { at: Date.parse(AT), subject: 'learner_fixture', device: 'a1b2c3d4e5f60718', method: 'GET', decision: 'step_up', network: null });
  assert.deepEqual(Object.keys(read), ['at', 'subject', 'device', 'method', 'decision', 'network']);
  assert.ok(Object.isFrozen(read));
});

test('제공된 연습 사건 모양(at·method·identity.sub)은 기기·판정이 없으므로 null로 두고 채우지 않는다', () => {
  const [read] = readDetectionEvents([event()]);
  assert.equal(read.device, null);
  assert.equal(read.decision, null);
});

test('메모 내용·토큰·실명·요청 본문은 결과에 남지 않는다', () => {
  const secret = {
    title: '가상 메모 제목', content: '가상 메모 본문', body: '요청 본문', note: { content: '본문' },
    token: `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`, authorization: 'Bearer abc', headers: { cookie: 'aleph_at=x' },
    name: '홍길동', realName: '홍길동', email: 'a@example.com',
    identity: { sub: 'learner_fixture', email: 'a@example.com', name: '홍길동', role: 'instructor' },
  };
  const out = readDetectionEvents([event(secret)]);
  const seen = JSON.stringify(out);
  for (const value of ['가상 메모', '본문', 'eyJ', 'Bearer', 'aleph_at', '홍길동', 'example.com', 'instructor']) {
    assert.ok(!seen.includes(value), `${value}가 남으면 안 됨`);
  }
  assert.equal(out[0].subject, 'learner_fixture');
});

test('실명·연락처처럼 보이는 가명, 시각이 없거나 틀린 사건은 빼고, 틀린 기기·요청 종류·판정은 null', () => {
  for (const sub of ['a@example.com', '홍길동', 'Kim Minsu', '', ' learner', null, 42, undefined]) {
    assert.deepEqual(readDetectionEvents([event({ identity: { sub } })]), [], String(sub));
  }
  for (const at of ['2026-10-01', 'yesterday', 1759276800000, null, '2026-13-40T99:00:00Z']) {
    assert.deepEqual(readDetectionEvents([event({ at })]), [], String(at));
  }
  assert.deepEqual(readDetectionEvents([event({ identity: undefined, userId: 'learner_fixture', sub: 'learner_fixture' })]), [], '브라우저식 userId·바깥 sub는 신원으로 쓰지 않음');
  const [odd] = readDetectionEvents([event({ deviceId: 'A1B2C3D4E5F60718', method: 'get', decision: 'ALLOW' })]);
  assert.deepEqual([odd.device, odd.method, odd.decision], [null, null, null]);
  const inherited = Object.create({ at: AT, identity: { sub: 'learner_fixture' } });
  assert.deepEqual(readDetectionEvents([inherited, null, 'x', [], 7]), []);
});

test('시각 순으로 정리하고 원본 배열·사건은 바꾸지 않는다. 배열이 아니면 기존처럼 거부', () => {
  const events = [event({ at: '2026-10-01T00:00:05.000Z' }), event({ at: '2026-10-01T00:00:01Z' })];
  const copy = structuredClone(events);
  assert.deepEqual(readDetectionEvents(events).map((item) => item.at), [Date.parse('2026-10-01T00:00:01Z'), Date.parse('2026-10-01T00:00:05Z')]);
  assert.deepEqual(events, copy);
  for (const value of [null, {}, 'events']) {
    assert.throws(() => readDetectionEvents(value), /invalid_detection_events/u);
    assert.throws(() => detect(value), /invalid_detection_events/u);
  }
});

test('detect는 아무것도 출력하지 않는다(9단계 제작 3부터 다량 조회에는 회수 제안)', () => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  Object.assign(console, { log: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a) });
  try {
    const many = Array.from({ length: 200 }, (_, i) => event({ at: new Date(Date.parse(AT) + i * 1000).toISOString(), content: '본문' }));
    assert.deepEqual(detect(many), { action: 'propose_revocation', reasonCode: 'burst_read', subject: 'learner_fixture' });
    assert.deepEqual(detect(many.slice(0, 120)), { action: 'observe' });
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(lines, []);
  const source = readFileSync(new URL('../src/detect.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /console\.|process\.std|writeFile|appendFile|fetch\(/u);
});

// 9단계 제작 2: unusual_network_burst. 가상 사건 연습이며 실제 회수나 심판 판정이 아닙니다.
const START = Date.parse(AT);
const reads = (count, { sub = 'learner_fixture', network = 'unusual', source = 'judge_fixture', region = 'foreign', intervalSeconds = 2, start = START, method = 'GET' } = {}) =>
  Array.from({ length: count }, (_, i) => ({ at: new Date(start + i * intervalSeconds * 1000).toISOString(), method, identity: { sub },
    signals: { source, region, network, hour: 3 } }));
const MARK = [{ subject: 'learner_fixture', reasonCode: 'unusual_network_burst' }];

test('평소와 다른 네트워크 + 10분 안 다량 조회(120건 초과)가 함께 나타나면 의심으로 표시한다', () => {
  assert.equal(SUSPICION_RULE, 'unusual_network_burst');
  assert.deepEqual(findSuspicious(reads(121)), MARK);
  assert.deepEqual(findSuspicious(reads(300)), MARK, '같은 사용자는 한 번만 표시');
  assert.ok(Object.isFrozen(findSuspicious(reads(121))));
});

test('둘 중 하나만 보이면 표시하지 않는다(정상 사건은 그대로)', () => {
  assert.deepEqual(findSuspicious(reads(120)), [], '다른 네트워크라도 정확히 120건은 다량 아님');
  assert.deepEqual(findSuspicious(reads(30)), [], '다른 네트워크의 적은 조회');
  assert.deepEqual(findSuspicious(reads(500, { network: 'usual' })), [], '평소 네트워크의 다량 조회');
  assert.deepEqual(findSuspicious(reads(200, { intervalSeconds: 7 })), [], '10분 밖으로 흩어진 조회');
  assert.deepEqual(findSuspicious(reads(200, { method: 'POST' })), [], '조회(GET)가 아닌 요청');
  assert.deepEqual(findSuspicious([...reads(100), ...reads(100, { sub: 'other_fixture' })]), [], '다른 사용자 사건은 합치지 않음');
  assert.deepEqual(findSuspicious([...reads(100), ...reads(100, { network: 'usual', start: START + 1000 })]), [], '다른 네트워크 100 + 평소 네트워크 100');
});

test('지역 하나만으로는 확정하지 않는다', () => {
  for (const region of ['foreign', 'overseas', 'unknown']) {
    assert.deepEqual(findSuspicious(reads(500, { region, network: 'usual' })), [], region);
    assert.deepEqual(findSuspicious(reads(10, { region })), [], `${region} + 적은 조회`);
  }
  assert.deepEqual(findSuspicious(reads(121, { region: 'local' })), MARK, '지역이 평소여도 네트워크·다량 조회가 함께면 표시');
  assert.ok(!JSON.stringify(readDetectionEvents(reads(1))).includes('foreign'), '지역은 읽지 않음');
});

test('네트워크 출처가 불명확하면(source: none·없음·client) 정상값으로도 이상값으로도 세지 않는다', () => {
  for (const source of ['none', 'client', 'JUDGE_FIXTURE', ' judge_fixture']) {
    assert.deepEqual(findSuspicious(reads(300, { source })), [], source);
  }
  assert.deepEqual(findSuspicious(reads(300).map(({ signals, ...rest }) => ({ ...rest, signals: { network: 'unusual' } }))), [], '출처 없음');
  assert.deepEqual(findSuspicious(reads(300).map(({ signals, ...rest }) => rest)), [], 'signals 없음');
  assert.deepEqual(findSuspicious(reads(300, { network: 'unknown' })), []);
  const forged = reads(300).map(({ signals, ...rest }) => ({ ...rest, network: 'unusual', headers: { 'x-network': 'unusual' } }));
  assert.deepEqual(findSuspicious(forged), [], '사건 바깥의 network·헤더는 읽지 않음');
});

test('제공된 연습 사건(npm run detect:test) 여섯 건이 모두 계약대로 나온다(심판 판정 아님)', async () => {
  const { checkDetection } = await import('../scripts/detect-test.mjs');
  const results = await checkDetection(detect);
  assert.deepEqual(results.map((item) => [item.name, item.passed]), [
    ['정상 조회 30건', true], ['10분 안에 120건', true], ['10분 안에 121건', true], ['폭주 조회 200건', true],
    ['서로 다른 사용자 각 100건', true], ['10분 밖으로 흩어진 조회 200건', true]]);
  const plain = Array.from({ length: 300 }, (_, i) => event({ at: new Date(START + i * 1000).toISOString() }));
  assert.deepEqual(findSuspicious(plain), [], '네트워크 정보가 없는 연습 사건은 표시하지 않음');
});

test('의심 표시에는 가명과 이유 코드만 있고 메모 내용·토큰·실명은 없다', () => {
  const noisy = reads(121).map((item) => ({ ...item, content: '메모 본문', token: 'Bearer abc', identity: { ...item.identity, name: '홍길동' } }));
  const seen = JSON.stringify(findSuspicious(noisy));
  assert.equal(seen, JSON.stringify(MARK));
});

// 9단계 제작 3: 탐지 결과의 회수 제안. 가상 사건 연습이며 실제 회수나 심판 판정이 아닙니다.
const DEV_A = 'a1b2c3d4e5f60718';
const DEV_B = '0f1e2d3c4b5a6978';
const onDevice = (list, deviceId) => list.map((item) => ({ ...item, deviceId }));
const PROPOSAL = { action: 'propose_revocation', reasonCode: 'burst_read', subject: 'learner_fixture', deviceId: DEV_A };
const BY_SUBJECT = { action: 'propose_revocation', reasonCode: 'burst_read', subject: 'learner_fixture' };

test('복합 이상 패턴(다른 네트워크 + 10분 안 다량 조회)이 기기 한 개에서 나오면 그 기기의 회수를 계약 이유 코드로 제안한다', () => {
  assert.deepEqual(detect(onDevice(reads(121), DEV_A)), PROPOSAL);
  assert.deepEqual(Object.keys(detect(onDevice(reads(121), DEV_A))), ['action', 'reasonCode', 'subject', 'deviceId']);
  const mixed = [...onDevice(reads(121), DEV_A), ...onDevice(reads(50, { network: 'usual', start: START - 3_600_000 }), DEV_B)];
  assert.deepEqual(detect(mixed), PROPOSAL, '탐지 구간 밖의 다른 기기는 대상이 아님');
});

test('기기 칸이 없으면 가명으로 제안하고, 기기가 둘 이상 섞이면 한 기기로 좁힐 수 없어 제안하지 않는다', () => {
  assert.deepEqual(detect(reads(300)), BY_SUBJECT, '기기 칸 없음(계약 사건 모양)');
  assert.deepEqual(detect(onDevice(reads(200), 'A1B2C3D4E5F60718')), BY_SUBJECT, '형식이 틀린 기기 ID는 지어내지 않음');
  const half = reads(200).map((item, i) => ({ ...item, deviceId: i % 2 ? DEV_A : DEV_B }));
  assert.deepEqual(detect(half), { action: 'observe' }, '두 기기');
  const someUnknown = reads(200).map((item, i) => (i === 50 ? item : { ...item, deviceId: DEV_A }));
  assert.deepEqual(detect(someUnknown), { action: 'observe' }, '기기를 모르는 사건이 섞이면 그 기기로 확정하지 않음');
});

test('정상 사건과 평소 네트워크로 확인된 다량 조회는 제안하지 않는다(지역 하나만으로도 제안 없음)', () => {
  for (const list of [reads(120), reads(30), reads(500, { network: 'usual' }), reads(500, { network: 'usual', region: 'foreign' }), reads(200, { intervalSeconds: 7 }), reads(200, { method: 'POST' })]) {
    assert.deepEqual(detect(onDevice(list, DEV_A)), { action: 'observe' });
  }
  assert.deepEqual(detect(onDevice([...reads(100), ...reads(100, { network: 'usual', start: START + 1000 })], DEV_A)), PROPOSAL,
    '평소 네트워크와 다른 네트워크가 섞인 다량 조회는 제안');
});

test('대상이 여럿이면 가장 먼저 탐지된 하나만 제안한다', () => {
  const later = onDevice(reads(121, { sub: 'other_fixture', start: START + 60_000 }), DEV_B);
  assert.deepEqual(detect([...later, ...onDevice(reads(121), DEV_A)]), PROPOSAL);
});

test('회수 API를 부르거나 권한을 바꾸지 않는다: 탐지는 제안만 돌려주고 네트워크·파일·로그를 쓰지 않는다', async () => {
  const source = readFileSync(new URL('../src/detect.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]), ['./decider.mjs'], '판정기의 입력 검사만 가져옴');
  assert.doesNotMatch(source, /fetch\(|require\(|writeFile|appendFile|console\.|process\.|supabase|revoke\(/iu);
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; return new Response('{}'); };
  try {
    const input = onDevice(reads(121), DEV_A);
    const copy = structuredClone(input);
    assert.equal(detect(input).action, 'propose_revocation');
    assert.deepEqual(input, copy, '사건 원본을 바꾸지 않음');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, 0);
  const { existsSync } = await import('node:fs');
  for (const path of ['../api/revoke.js', '../api/revocations.js', '../api/devices.js']) assert.equal(existsSync(new URL(path, import.meta.url)), false, path);
});

test('기존 접속 허용/거부 응답(판정기 5항목)은 그대로다', async () => {
  const { decide } = await import('../src/decider.mjs');
  const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
  const response = await decide(fixtureRequests().normal);
  assert.deepEqual(Object.keys(response).sort(), ['decision', 'reasonCode', 'requestId', 'ruleIds', 'schema']);
  assert.equal(response.decision, 'allow');
});

test('자기 점검: 실제 회수와 시간은 심판이 확인하므로 요청을 보내지 않고 미실행으로 남긴다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const original = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (url) => { sent += 1; return String(url).endsWith('/data.json') ? new Response('not found', { status: 404 })
    : new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 }); };
  try {
    const results = await runAttackChecks({ ...config, publicAppUrl: 'https://student-defense.vercel.app/' });
    assert.equal(sent, 6);
    const item = results.find((entry) => entry.attackId === 'doppelganger_device_revocation');
    assert.match(item.observed, /^미실행: 실제 회수와 걸린 시간은 심판이 확인함/u);
    assert.ok(results.length <= 20);
  } finally {
    globalThis.fetch = original;
  }
});

// 9단계 고침: 복합 의심 사건(판정 요청 모양)에도 별도 결과로 회수 제안을 낸다. 판정기 응답은 그대로.
test('복합 의심 사건(다른 네트워크 + 다량 조회)은 그 가상 기기 한 개의 회수를 이유 코드와 함께 제안한다', async () => {
  const { proposeRevocation } = await import('../src/detect.mjs');
  const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
  const { suspicious, normal } = fixtureRequests();
  const expected = { action: 'propose_revocation', reasonCode: 'burst_read', subject: 'learner_fixture', deviceId: 'a'.repeat(16) };
  assert.deepEqual(detect([suspicious]), expected);
  assert.deepEqual(proposeRevocation(suspicious), expected);
  assert.deepEqual(detect([normal, suspicious]), expected, '정상 사건이 섞여도 의심 사건의 기기만');
  assert.deepEqual(detect([normal]), { action: 'observe' }, '정상 사건은 그대로');
  assert.equal(proposeRevocation(normal), null);
  const seen = JSON.stringify(detect([suspicious]));
  for (const value of [suspicious.requestId, 'foreign', '/notes/demo', 'risk_signal']) assert.ok(!seen.includes(value), `${value}는 결과에 없음`);
});

test('복합 의심 사건이라도 한쪽만 보이거나 기기·출처를 확정할 수 없으면 제안하지 않는다', async () => {
  const { proposeRevocation } = await import('../src/detect.mjs');
  const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
  const { suspicious } = fixtureRequests();
  const without = (extra) => proposeRevocation({ ...suspicious, ...extra });
  assert.equal(without({ signals: { ...suspicious.signals, network: 'usual' } }), null, '평소 네트워크 + 다량 조회');
  assert.equal(without({ recentEvents: [] }), null, '다른 네트워크 + 조회 적음');
  assert.equal(without({ recentEvents: [{ kind: 'risk_signal', ageSeconds: 400, count: 50 }] }), null, '오래된 조회');
  assert.equal(without({ signals: { ...suspicious.signals, network: 'usual', region: 'foreign' } }), null, '지역만 다름');
  assert.equal(without({ signals: { ...suspicious.signals, source: 'none' } }), null, '출처 없음');
  assert.equal(without({ signals: { ...suspicious.signals, source: 'client' } }), null, '출처 불명');
  assert.equal(without({ headers: { 'x-network': 'unusual' } }), null, '계약 밖 항목이 섞임');
  assert.equal(without({ deviceRegistered: false }), null, '미등록 기기');
  assert.equal(without({ deviceId: 'A'.repeat(16) }), null, '기기 ID 형식 틀림');
  assert.notEqual(without({ signals: { ...suspicious.signals, region: 'local', hour: 14 } }), null, '지역·시각과 관계없이 네트워크 + 다량 조회면 제안');
  for (const value of [null, 'x', [], {}]) assert.equal(proposeRevocation(value), null);
});

test('판정기의 허용/거부 응답 형식은 그대로다: 복합 의심 사건의 판정은 여전히 step_up 5항목', async () => {
  const { decide } = await import('../src/decider.mjs');
  const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
  const { suspicious } = fixtureRequests();
  const response = await decide(suspicious);
  assert.deepEqual(response, { schema: 'aleph.decision.v1', requestId: suspicious.requestId, decision: 'step_up', reasonCode: 'step_up_required', ruleIds: ['step_up_required'] });
});
