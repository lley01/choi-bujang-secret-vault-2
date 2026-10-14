import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, readAccessContext } from '../src/decider.mjs';
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

test('입력 검사만 더했고 판정 결과는 6단계와 같다', async () => {
  const cases = [[normal(), 'allow', 'approved'], [suspicious(), 'allow', 'approved'],
    [{ ...normal(), deviceRegistered: false }, 'deny', 'device_not_registered'],
    [{ ...normal(), method: 'PATCH' }, 'deny', 'starter_not_ready']];
  for (const [request, decision, reasonCode] of cases) {
    const response = await decide(request);
    assert.equal(response.decision, decision);
    assert.equal(response.reasonCode, reasonCode);
  }
});
