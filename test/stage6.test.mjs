import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RULE_IDS, decide } from '../src/decider.mjs';
import { checkDecider } from '../scripts/decider-test.mjs';
import { fixtureRequests } from '../scripts/fixture-7.mjs';

// 6단계 device_registered 규칙. 요청은 docs/DECIDER_REQUEST.md 계약의 가상 요청(scripts/fixture-7.mjs)입니다. 심판 판정이 아닙니다.
const RESPONSE_KEYS = ['decision', 'reasonCode', 'requestId', 'ruleIds', 'schema'];
const base = () => ({ ...fixtureRequests().normal, requestId: crypto.randomUUID() });

function assertShape(request, response) {
  assert.deepEqual(Object.keys(response).sort(), RESPONSE_KEYS, '응답은 다섯 항목만');
  assert.equal(response.schema, 'aleph.decision.v1');
  assert.equal(response.requestId, request.requestId);
  assert.ok(response.ruleIds.length > 0 && response.ruleIds.every((id) => RULE_IDS.includes(id)));
}

test('RULE_IDS에 device_registered를 더했고 시작 틀의 starter.deny는 그대로 맨 앞에 있다', () => {
  assert.deepEqual([...RULE_IDS], ['starter.deny', 'device_registered']);
  assert.ok(Object.isFrozen(RULE_IDS));
});

test('등록 기기의 읽기(GET) 요청은 허용한다', async () => {
  const request = base();
  const response = await decide(request);
  assertShape(request, response);
  assert.deepEqual(response, { schema: 'aleph.decision.v1', requestId: request.requestId, decision: 'allow', reasonCode: 'approved', ruleIds: ['device_registered'] });
});

test('미등록이거나 값이 없거나 true가 아니면 device_not_registered로 거부한다', async () => {
  const { deviceRegistered, ...missing } = base();
  for (const request of [{ ...base(), deviceRegistered: false }, { ...missing, requestId: crypto.randomUUID() },
    { ...base(), deviceRegistered: null }, { ...base(), deviceRegistered: 'true' }, { ...base(), deviceRegistered: 1 }]) {
    const response = await decide(request);
    assertShape(request, response);
    assert.equal(response.decision, 'deny', String(request.deviceRegistered));
    assert.equal(response.reasonCode, 'device_not_registered');
    assert.deepEqual(response.ruleIds, ['device_registered']);
  }
});

test('미등록 기기는 쓰기 요청도 device_not_registered로 거부한다', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await decide({ ...base(), method, deviceRegistered: false });
    assert.equal(response.reasonCode, 'device_not_registered', method);
  }
});

test('등록 기기라도 읽기가 아닌 요청은 이 규칙이 허용하지 않고, 기존 기본 거부(starter.deny)가 그대로 답한다', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const request = { ...base(), method, route: `${method} /notes/:id` };
    const response = await decide(request);
    assertShape(request, response);
    assert.deepEqual([response.decision, response.reasonCode, response.ruleIds], ['deny', 'starter_not_ready', ['starter.deny']], method);
  }
});

test('계약에 없는 값(device·identity·role·geo)은 판정에 쓰지 않는다', async () => {
  const spoofed = { ...base(), deviceRegistered: false, device: { registered: true, approval: 'ok' }, identity: 'a', role: 'admin', geo: 'kr' };
  assert.equal((await decide(spoofed)).reasonCode, 'device_not_registered');
  const source = readFileSync(new URL('../src/decider.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /request\.(?:device\b|identity|role|geo)/u);
});

test('로컬 연습(npm run decider:test)의 두 확인이 모두 통과한다(심판 판정 아님)', async () => {
  const results = await checkDecider({ decide, ruleIds: [...RULE_IDS] });
  assert.deepEqual(results.map((item) => item.name), ['등록 기기의 정상 요청', '미등록 기기의 가상 요청']);
  for (const item of results) assert.equal(item.passed, true, item.name);
});

test('npm run decider:show 는 등록 기기 allow, 미등록 기기 deny·device_not_registered 를 그대로 보여 준다', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, ['scripts/decider-show.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.match(output, /^등록 기기의 정상 요청 \(deviceRegistered: true, GET\) → allow · approved · device_registered$/mu);
  assert.match(output, /^미등록 기기의 가상 요청 \(deviceRegistered: false, GET\) → deny · device_not_registered · device_registered$/mu);
  assert.match(output, /심판 판정이 아닙니다/u);
});
