import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RULE_IDS, decide, readAccessContext } from '../src/decider.mjs';
import { fixtureRequests } from '../scripts/fixture-7.mjs';

// 7단계 입력 검사(readAccessContext). 요청은 계약 모양의 가상 요청입니다. 심판 판정이 아닙니다.
const normal = () => ({ ...fixtureRequests().normal, requestId: crypto.randomUUID() });
const suspicious = () => ({ ...fixtureRequests().suspicious, requestId: crypto.randomUUID() });
const NOTHING = { region: null, network: null, hour: null };

test('엔진의 가상 접속 정보(judge_fixture)는 출처를 표시해 그대로 읽는다', () => {
  const context = readAccessContext(suspicious());
  assert.equal(context.source, 'judge_fixture');
  assert.equal(context.virtual, true, '가상 정보이며 실제 위치 증거가 아님');
  assert.deepEqual({ region: context.region, network: context.network, hour: context.hour }, { region: 'foreign', network: 'unusual', hour: 3 });
  assert.deepEqual(context.recentEvents, [{ kind: 'risk_signal', ageSeconds: 60, count: 20 }]);
  assert.deepEqual(context.missing, []);
  assert.ok(Object.isFrozen(context));
});

test('실제 경로(source: none)는 지역·네트워크·시각을 정상값으로 채우지 않는다', () => {
  const request = { ...normal(), signals: { source: 'none', region: 'unknown', network: 'unknown', hour: 14 } };
  const context = readAccessContext(request);
  assert.equal(context.source, 'none');
  assert.equal(context.virtual, false);
  assert.deepEqual({ region: context.region, network: context.network, hour: context.hour }, NOTHING);
  assert.deepEqual(context.recentEvents, [], '엔진이 준 빈 배열은 "사건 없음"');
  assert.deepEqual(context.missing, ['region', 'network', 'hour']);
});

test('값이 없거나 형식이 틀리면 null(모름)로 두고 missing에 적는다', () => {
  const cases = [
    [{ source: 'judge_fixture', region: 'unknown', network: 'unknown', hour: 24 }, NOTHING],
    [{ source: 'judge_fixture', region: '', network: 'Usual', hour: '14' }, NOTHING],
    [{ source: 'judge_fixture', region: null, network: 7, hour: 14.5 }, NOTHING],
    [{ source: 'judge_fixture', region: 'local', network: undefined, hour: -1 }, { region: 'local', network: null, hour: null }],
  ];
  for (const [signals, expected] of cases) {
    const context = readAccessContext({ ...normal(), signals });
    assert.equal(context.source, 'judge_fixture');
    assert.deepEqual({ region: context.region, network: context.network, hour: context.hour }, expected, JSON.stringify(signals));
    for (const name of ['region', 'network', 'hour']) assert.equal(context.missing.includes(name), expected[name] === null);
  }
  const { signals, recentEvents, ...bare } = normal();
  const context = readAccessContext(bare);
  assert.equal(context.source, 'unclear', 'signals가 없으면 출처 불명');
  assert.deepEqual({ region: context.region, network: context.network, hour: context.hour, recentEvents: context.recentEvents },
    { ...NOTHING, recentEvents: null });
  assert.deepEqual(context.missing, ['region', 'network', 'hour', 'recentEvents']);
});

test('출처가 불명확한 signals는 값이 정상처럼 보여도 모두 버린다', () => {
  const good = { region: 'local', network: 'usual', hour: 14 };
  const inherited = Object.create({ source: 'judge_fixture', ...good });
  const getter = { source: 'judge_fixture', network: 'usual', hour: 14, get region() { return 'local'; } };
  for (const signals of [
    { source: 'client', ...good }, { source: 'browser', ...good }, { source: 'header', ...good },
    { source: 'JUDGE_FIXTURE', ...good }, { source: ' judge_fixture', ...good }, { ...good },
    { source: 'judge_fixture', ...good, forwardedFor: '203.0.113.7' },
    { source: 'judge_fixture', region: 'local', network: 'usual' },
    inherited, getter, ['judge_fixture', 'local', 'usual', 14], 'judge_fixture', null,
  ]) {
    const context = readAccessContext({ ...normal(), signals });
    assert.equal(context.source, 'unclear', JSON.stringify(signals));
    assert.equal(context.virtual, false);
    assert.deepEqual({ region: context.region, network: context.network, hour: context.hour }, NOTHING);
  }
});

test('위조한 클라이언트 헤더는 신뢰하는 접속 정보로 승격되지 않는다', () => {
  const forged = {
    'x-forwarded-for': '203.0.113.7', 'x-region': 'local', 'x-network': 'usual', 'x-hour': '14',
    'cf-ipcountry': 'KR', 'x-vercel-ip-country': 'KR', 'x-signal-source': 'judge_fixture',
  };
  const signals = { source: 'none', region: 'unknown', network: 'unknown', hour: 3 };
  const attempts = [
    { ...normal(), signals, headers: forged },
    { ...normal(), signals, ...forged },
    { ...normal(), signals, geo: { region: 'local' }, network: 'usual', region: 'local', hour: 14 },
    { ...suspicious(), headers: forged },
  ];
  for (const request of attempts) {
    const context = readAccessContext(request);
    assert.equal(context.source, 'unclear', '계약 밖 항목이 섞인 요청은 엔진이 만든 요청으로 보지 않음');
    assert.deepEqual({ region: context.region, network: context.network, hour: context.hour, recentEvents: context.recentEvents },
      { ...NOTHING, recentEvents: null });
    assert.ok(!JSON.stringify(context).includes('203.0.113.7') && !JSON.stringify(context).includes('KR'));
  }
});

test('행동(recentEvents)은 형식이 맞을 때만 읽고, 틀리면 빈 배열이 아니라 null(모름)이다', () => {
  const event = { kind: 'risk_signal', ageSeconds: 60, count: 20 };
  for (const recentEvents of [undefined, null, 'none', {}, [{ ...event, count: 0 }], [{ ...event, ageSeconds: -1 }],
    [{ ...event, kind: 'Risk' }], [{ ...event, source: 'header' }], [{ kind: 'risk_signal', count: 1 }], Array(13).fill(event)]) {
    assert.equal(readAccessContext({ ...suspicious(), recentEvents }).recentEvents, null, JSON.stringify(recentEvents));
  }
  assert.equal(readAccessContext({ ...suspicious(), recentEvents: Array(12).fill(event) }).recentEvents.length, 12);
});

test('요청이 객체가 아니어도 오류 없이 모두 모름으로 답한다', () => {
  for (const request of [undefined, null, 'request', 42, []]) {
    assert.deepEqual({ ...readAccessContext(request) },
      { source: 'unclear', virtual: false, ...NOTHING, recentEvents: null, missing: ['region', 'network', 'hour', 'recentEvents'] });
  }
});

test('입력 검사는 기기 규칙의 판정을 바꾸지 않는다(복합 이상은 아래 step_up_required 시험)', async () => {
  const cases = [[normal(), 'allow', 'approved'],
    [{ ...normal(), deviceRegistered: false }, 'deny', 'device_not_registered'],
    [{ ...normal(), method: 'PATCH' }, 'deny', 'route_not_allowed']];
  for (const [request, decision, reasonCode] of cases) {
    const response = await decide(request);
    assert.equal(response.decision, decision);
    assert.equal(response.reasonCode, reasonCode);
  }
});

// 7단계 step_up_required 규칙: 평소와 다른 시각 + 처음 보는 네트워크 + 갑작스러운 대량 읽기가 모두 보일 때만 추가 확인.
const judged = async (request) => { const r = await decide(request); return [r.decision, r.reasonCode, r.ruleIds.join(',')]; };
const STEP_UP = ['step_up', 'step_up_required', 'step_up_required'];
const ALLOW = ['allow', 'approved', 'device_registered,resource_zone'];
const signalsOf = (overrides) => ({ source: 'judge_fixture', region: 'foreign', network: 'unusual', hour: 3, ...overrides });
const BURST = [{ kind: 'risk_signal', ageSeconds: 60, count: 20 }];

test('RULE_IDS에 step_up_required를 더했고 기존 규칙은 그대로다', () => {
  assert.deepEqual([...RULE_IDS].slice(0, 3), ['starter.deny', 'device_registered', 'step_up_required']);
});

test('정해진 복합 사건은 추가 확인(step_up), 정상 사건은 허용으로 나오고 사유가 응답에 남는다', async () => {
  const request = suspicious();
  const response = await decide(request);
  assert.deepEqual(response, { schema: 'aleph.decision.v1', requestId: request.requestId, decision: 'step_up', reasonCode: 'step_up_required', ruleIds: ['step_up_required'] });
  assert.deepEqual(await judged(normal()), ALLOW);
});

test('지역 하나만으로는 거부하지도 추가 확인하지도 않는다(영구 차단 없음)', async () => {
  for (const region of ['foreign', 'unknown', 'local']) {
    assert.deepEqual(await judged({ ...normal(), signals: signalsOf({ region, network: 'usual', hour: 14 }), recentEvents: [] }), ALLOW, region);
  }
  assert.deepEqual(await judged({ ...suspicious(), signals: signalsOf({ region: 'local' }) }), STEP_UP, '지역이 평소여도 복합 이상이면 추가 확인');
  for (let i = 0; i < 3; i += 1) assert.notEqual((await decide(suspicious())).decision, 'deny', '같은 지역이 반복돼도 거부로 바뀌지 않음');
});

test('조건 하나나 둘만 보이면 허용한다', async () => {
  const cases = [
    [signalsOf({ network: 'usual' }), BURST], [signalsOf({ hour: 14 }), BURST], [signalsOf({}), []],
    [signalsOf({ network: 'usual', hour: 14 }), BURST], [signalsOf({ hour: 14 }), []],
    [signalsOf({}), [{ kind: 'risk_signal', ageSeconds: 60, count: 9 }]],
    [signalsOf({}), [{ kind: 'risk_signal', ageSeconds: 301, count: 50 }]],
  ];
  for (const [signals, recentEvents] of cases) {
    assert.deepEqual(await judged({ ...normal(), signals, recentEvents }), ALLOW, JSON.stringify([signals, recentEvents]));
  }
  assert.deepEqual(await judged({ ...normal(), signals: signalsOf({}), recentEvents: [{ kind: 'read', ageSeconds: 10, count: 4 }, { kind: 'read', ageSeconds: 200, count: 6 }] }), STEP_UP, '5분 안 합계 10건');
});

test('값이 없거나 출처가 불명확하면 정상값으로 채우지도, 이상으로 세지도 않는다', async () => {
  for (const signals of [signalsOf({ source: 'none' }), signalsOf({ source: 'client' }), signalsOf({ hour: null }), signalsOf({ network: 'unknown' })]) {
    assert.deepEqual(await judged({ ...suspicious(), signals }), ALLOW, JSON.stringify(signals));
  }
  assert.deepEqual(await judged({ ...suspicious(), recentEvents: 'many' }), ALLOW);
});

test('추가 확인을 마친 경우만 허용하고, stepUp 값이 틀리면 다시 묻는다', async () => {
  assert.deepEqual(await judged({ ...suspicious(), stepUp: { verified: true, authAgeSeconds: 60 } }), ALLOW);
  for (const stepUp of [{ verified: false, authAgeSeconds: null }, { verified: true, authAgeSeconds: 901 }, { verified: true, authAgeSeconds: null },
    { verified: 'true', authAgeSeconds: 60 }, { verified: true, authAgeSeconds: 60, extra: 1 }, null, undefined]) {
    assert.deepEqual(await judged({ ...suspicious(), stepUp }), STEP_UP, JSON.stringify(stepUp));
  }
  assert.deepEqual(await judged({ ...normal(), stepUp: { verified: true, authAgeSeconds: 60 } }).then(([d]) => d), 'allow');
});

test('기존 기기 규칙이 먼저다: 미등록 기기는 복합 이상이어도 거부, 구역 밖 요청은 구역 규칙이 거부', async () => {
  assert.deepEqual(await judged({ ...suspicious(), deviceRegistered: false }), ['deny', 'device_not_registered', 'device_registered']);
  assert.deepEqual(await judged({ ...suspicious(), method: 'PATCH' }), ['deny', 'route_not_allowed', 'resource_zone']);
  for (const method of ['PUT', 'DELETE']) assert.deepEqual(await judged({ ...suspicious(), method, route: `${method} /notes/:id` }), STEP_UP, method);
});

test('npm run fixture:7 연습이 정상 allow, 복합 이상 step_up으로 통과한다(심판 판정 아님)', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, ['scripts/fixture-7.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(output, '정상 사건: allow\n복합 이상 사건: step_up\n');
});

// 7단계 다시 로그인 확인: 제공 엔진의 "같은 로그인 재로그인 시각" 확인 계약이 저장소에 없어 가상 사건으로만 시험합니다.
// 실제 자료 차단과 새 로그인 뒤 재판정은 자기 점검에 미실행으로 남깁니다. 실측은 계약이 준비된 환경에서만 합니다.
test('계약 확인: 판정 요청에 stepUp(나이)만 있고, 같은 로그인에 묶는 내용과 다시 로그인 흐름 계약은 아직 없다', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const contract = readFileSync(new URL('../docs/DECIDER_REQUEST.md', import.meta.url), 'utf8');
  assert.match(contract, /`stepUp` \| `\{verified, authAgeSeconds\}`/u);
  assert.doesNotMatch(contract, /sessionId|auth_time|reauthAt|sameLogin/u, '같은 로그인·세션을 묶는 항목이 생기면 이 시험과 자기 점검을 갱신');
  assert.equal(existsSync(new URL('../student-kit/sdp-core/decision-contract.mjs', import.meta.url)), false, '엔진 계약 코드는 저장소에 없음');
});

test('가상 사건: 다시 로그인 전에는 읽기·쓰기 모두 step_up으로 막고, 새 로그인 뒤 새 요청은 다시 판정해 허용한다', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const before = { ...suspicious(), method, route: `${method} /notes/:id` };
    assert.deepEqual(await judged(before), STEP_UP, `다시 로그인 전 ${method}`);
    const after = { ...before, requestId: crypto.randomUUID(), at: new Date().toISOString(), stepUp: { verified: true, authAgeSeconds: 5 } };
    const response = await decide(after);
    assert.equal(response.requestId, after.requestId, '새 요청 번호로 다시 판정');
    assert.deepEqual([response.decision, response.reasonCode], ['allow', 'approved'], `다시 로그인 뒤 ${method}`);
  }
});

test('가상 사건: 다시 로그인이 확인되지 않았거나 오래됐으면 계속 막는다(0초·900초는 계약 범위)', async () => {
  for (const authAgeSeconds of [0, 900]) assert.equal((await decide({ ...suspicious(), stepUp: { verified: true, authAgeSeconds } })).decision, 'allow');
  for (const stepUp of [{ verified: false, authAgeSeconds: null }, { verified: true, authAgeSeconds: 901 }, { verified: true, authAgeSeconds: -1 }]) {
    assert.equal((await decide({ ...suspicious(), stepUp })).decision, 'step_up', JSON.stringify(stepUp));
  }
});

test('토큰 원문을 기록하지 않는다: 판정기는 로그를 남기지 않고 응답에 요청 값을 싣지 않는다', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/decider.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /console\.|process\.std|writeFile|appendFile|fetch\(/u);
  const fakeToken = `eyJ${'A'.repeat(20)}.${'B'.repeat(20)}.${'C'.repeat(20)}`;
  const response = await decide({ ...suspicious(), subjectId: fakeToken });
  assert.ok(!JSON.stringify(response).includes(fakeToken));
});

test('자기 점검: 실제 자료 차단·재판정은 요청을 보내지 않고 미실행으로 남긴다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const original = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (url) => { sent += 1; return String(url).endsWith('/data.json') ? new Response('not found', { status: 404 })
    : new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 }); };
  try {
    const results = await runAttackChecks({ ...config, step: 11, restoreRoute: null, publicAppUrl: 'https://student-defense.vercel.app/' }); // 10단계 복원·12단계 작전실 점검은 stage10·stage12에서 따로 시험
    assert.equal(sent, 6, '로그인 없는 요청 6건 외에는 보내지 않음');
    const item = results.find((entry) => entry.attackId === 'step_up_reauth_notes_read');
    assert.ok(item, '다시 로그인 점검 항목');
    assert.match(item.observed, /^미실행: 제공 엔진의 다시 로그인 시각 확인 계약이 아직 없어/u);
    assert.doesNotMatch(JSON.stringify(results), /eyJ[A-Za-z0-9_-]{10,}|Bearer /u, '토큰 원문 없음');
    assert.ok(results.length <= 20 && new Set(results.map((entry) => entry.attackId)).size === results.length);
  } finally {
    globalThis.fetch = original;
  }
});
