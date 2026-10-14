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

test('RULE_IDS에 device_registered를 더했고 시작 틀의 starter.deny는 그대로 맨 앞에 있다(7단계에서 step_up_required 추가)', () => {
  assert.deepEqual([...RULE_IDS], ['starter.deny', 'device_registered', 'step_up_required']);
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

test('등록 기기에서 기존 화면이 쓰는 모든 요청(화면 열기·로그인·로그아웃·메모 읽기·추가·수정·삭제)이 열린다', async () => {
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const screenRoutes = [...page.matchAll(/(?:authRequest|callApi)\('([A-Z]+)', [`']([^`']+)[`']/gu)]
    .map(([, method, path]) => `${method} ${path.replace(/\$\{[^}]+\}/u, ':id')}`);
  assert.ok(screenRoutes.length >= 7, '화면 코드에서 요청을 찾지 못했습니다');
  for (const route of new Set(['GET /', ...screenRoutes, ...config.allowedRoutes])) {
    const [method, path] = route.split(' ');
    const request = { ...base(), method, path, route };
    const response = await decide(request);
    assertShape(request, response);
    assert.deepEqual([response.decision, response.reasonCode, response.ruleIds], ['allow', 'approved', ['device_registered']], route);
    const denied = await decide({ ...request, requestId: crypto.randomUUID(), deviceRegistered: false });
    assert.deepEqual([denied.decision, denied.reasonCode], ['deny', 'device_not_registered'], `미등록 ${route}`);
  }
});

test('등록 기기라도 화면이 쓰지 않는 메서드는 이 규칙이 허용하지 않고, 기존 기본 거부(starter.deny)가 그대로 답한다', async () => {
  for (const method of ['PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'get', '', undefined]) {
    const request = { ...base(), method };
    const response = await decide(request);
    assertShape(request, response);
    assert.deepEqual([response.decision, response.reasonCode, response.ruleIds], ['deny', 'starter_not_ready', ['starter.deny']], String(method));
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
  assert.match(output, /^등록 기기의 정상 요청 \(deviceRegistered: true, GET\) → allow · approved · device_registered$/mu);
  assert.match(output, /^미등록 기기의 가상 요청 \(deviceRegistered: false, GET\) → deny · device_not_registered · device_registered$/mu);
  assert.match(output, /심판 판정이 아닙니다/u);
});

test('설정은 6단계이고, 실제 빌드(Vercel 흉내)가 만든 /aleph.json도 6단계로 보인다', async () => {
  const { execFileSync } = await import('node:child_process');
  const { rmSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.equal(config.step, 6);
  const output = new URL('../public/aleph.json', import.meta.url);
  try {
    execFileSync(process.execPath, ['scripts/build-public.mjs'], { cwd: new URL('..', import.meta.url), stdio: 'pipe', env: { ...process.env,
      VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
      VERCEL_GIT_COMMIT_SHA: 'e'.repeat(40), VERCEL_URL: 'defense-app-mno345.vercel.app' } });
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.step, 6);
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
    assert.equal(results.at(-1).attackId, 'unregistered_device_notes_read');
    assert.match(results.at(-1).observed, /^미실행/u);
    assert.ok(results.length <= 20 && new Set(results.map((item) => item.attackId)).size === results.length);
  } finally {
    globalThis.fetch = original;
  }
});
