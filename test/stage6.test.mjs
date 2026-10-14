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

test('RULE_IDS에 device_registered를 더했고 시작 틀의 starter.deny는 그대로 맨 앞에 있다(7단계 step_up_required, 8단계 resource_zone 추가)', () => {
  assert.deepEqual([...RULE_IDS], ['starter.deny', 'device_registered', 'step_up_required', 'resource_zone']);
  assert.ok(Object.isFrozen(RULE_IDS));
});

test('등록 기기의 메모 한 건 읽기(GET /notes/:id) 요청은 허용한다(8단계부터 구역 규칙도 함께 허용)', async () => {
  const request = base();
  const response = await decide(request);
  assertShape(request, response);
  assert.deepEqual(response, { schema: 'aleph.decision.v1', requestId: request.requestId, decision: 'allow', reasonCode: 'approved', ruleIds: ['device_registered', 'resource_zone'] });
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

// 8단계부터: 판정기는 allowedRoutes에 적은 구역 경로만 열고, 화면만 쓰는 목록·추가·로그인 경로(엔진을 거치지 않음)는 판정기에서 거부합니다.
test('등록 기기: allowedRoutes 경로는 열리고, 그 밖의 화면 경로는 구역 규칙이 거부한다. 미등록 기기는 모두 거부', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const screenRoutes = [...page.matchAll(/(?:authRequest|callApi)\('([A-Z]+)', [`']([^`']+)[`']/gu)]
    .map(([, method, path]) => `${method} ${path.replace(/\$\{[^}]+\}/u, ':id')}`);
  assert.ok(screenRoutes.length >= 7, '화면 코드에서 요청을 찾지 못했습니다');
  for (const route of new Set(['GET /', ...screenRoutes, ...config.allowedRoutes])) {
    const [method, shape] = route.split(' ');
    const path = shape.replace(':id', 'demo');
    const service = /^\/api\/([a-z]+)/u.exec(shape)?.[1] ?? 'notes';
    const request = { ...base(), method, path, route, service };
    const response = await decide(request);
    assertShape(request, response);
    const expected = config.allowedRoutes.includes(route)
      ? ['allow', 'approved', ['device_registered', 'resource_zone']] : ['deny', 'route_not_allowed', ['resource_zone']];
    assert.deepEqual([response.decision, response.reasonCode, response.ruleIds], expected, route);
    const denied = await decide({ ...request, requestId: crypto.randomUUID(), deviceRegistered: false });
    assert.deepEqual([denied.decision, denied.reasonCode], ['deny', 'device_not_registered'], `미등록 ${route}`);
  }
});

test('등록 기기라도 화면이 쓰지 않는 메서드는 허용하지 않는다(8단계부터 구역 규칙이 route_not_allowed로 거부)', async () => {
  for (const method of ['PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'get', '', undefined]) {
    const request = { ...base(), method };
    const response = await decide(request);
    assertShape(request, response);
    assert.deepEqual([response.decision, response.reasonCode, response.ruleIds], ['deny', 'route_not_allowed', ['resource_zone']], String(method));
  }
});

test('계약에 없는 값(device·identity·role·geo)은 판정에 쓰지 않는다', async () => {
  const spoofed = { ...base(), deviceRegistered: false, device: { registered: true, approval: 'ok' }, identity: 'a', role: 'admin', geo: 'kr' };
  assert.equal((await decide(spoofed)).reasonCode, 'device_not_registered');
  const source = readFileSync(new URL('../src/decider.mjs', import.meta.url), 'utf8').replace(/\/\/.*$/gmu, '');
  assert.doesNotMatch(source, /request\.(?:device\b|identity|role|geo)/u);
});

test('로컬 연습(npm run decider:test)의 기기 확인 두 건이 통과한다(심판 판정 아님, 7단계 확인 두 건은 stage7 시험)', async () => {
  const results = await checkDecider({ decide, ruleIds: [...RULE_IDS] });
  assert.deepEqual(results.map((item) => item.name).slice(0, 2), ['등록 기기의 정상 요청', '미등록 기기의 가상 요청']);
  for (const item of results) assert.equal(item.passed, true, item.name);
});

test('npm run decider:show 는 등록 기기 allow, 미등록 기기 deny·device_not_registered 를 그대로 보여 준다', async () => {
  const { execFileSync } = await import('node:child_process');
  const output = execFileSync(process.execPath, ['scripts/decider-show.mjs'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.match(output, /^등록 기기의 정상 요청 \(deviceRegistered: true, GET\) → allow · approved · device_registered,resource_zone$/mu);
  assert.match(output, /^미등록 기기의 가상 요청 \(deviceRegistered: false, GET\) → deny · device_not_registered · device_registered$/mu);
  assert.match(output, /심판 판정이 아닙니다/u);
});

test('설정은 6단계 이상이고, 실제 빌드(Vercel 흉내)가 만든 /aleph.json도 설정과 같은 단계로 보인다', async () => {
  const { execFileSync } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.ok(config.step >= 6);
  const output = new URL('../public/aleph.json', import.meta.url);
  try {
    execFileSync(process.execPath, ['scripts/build-public.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'pipe', env: { ...process.env,
      VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
      VERCEL_GIT_COMMIT_SHA: 'e'.repeat(40), VERCEL_URL: 'defense-app-mno345.vercel.app' } });
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.step, config.step);
    assert.deepEqual(written.allowedRoutes, config.allowedRoutes);
    assert.equal(written.originalApiUrl, config.originalApiUrl);
  } finally {
    rmSync(output, { force: true });
  }
});

test('6단계 자기 점검: 요청은 6건만 보내고, 미등록 기기 점검은 심판이 보내므로 미실행으로 남긴다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const { runAttackChecks } = await import('../src/attack-check.mjs');
  const original = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (url) => { sent += 1; return String(url).endsWith('/data.json') ? new Response('not found', { status: 404 })
    : new Response(JSON.stringify({ error: 'LOGIN_REQUIRED' }), { status: 401 }); };
  try {
    const results = await runAttackChecks({ ...config, publicAppUrl: 'https://student-defense.vercel.app/' });
    assert.equal(sent, 6);
    const unregistered = results.find((item) => item.attackId === 'unregistered_device_notes_read');
    assert.ok(unregistered, '미등록 기기 점검 항목');
    assert.match(unregistered.observed, /^미실행/u);
    assert.ok(results.length <= 20 && new Set(results.map((item) => item.attackId)).size === results.length);
  } finally {
    globalThis.fetch = original;
  }
});
