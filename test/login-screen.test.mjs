import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const root = new URL('..', import.meta.url);

test('화면 코드에 Supabase 공개 키·anon 키·주소가 없다(키는 서버 함수에만 둔다)', () => {
  for (const forbidden of [/sb_publishable_/u, /sb_secret_/u, /\beyJ[A-Za-z0-9_-]{12,}/u, /supabase\.co/u, /service_role/iu,
    /SUPABASE_(?:URL|SECRET_KEY|PUBLISHABLE_KEY|ANON_KEY)/u, /anon[_-]?key/iu, /BEGIN [A-Z ]*PRIVATE KEY/u]) {
    assert.doesNotMatch(page, forbidden, `화면 코드에 ${forbidden}가 있으면 안 됩니다`);
  }
});

test('로그인·로그아웃은 서버 함수(/api/auth/*)가 하고, 화면은 비밀번호·JWT·토큰을 직접 다루지 않는다', () => {
  assert.match(page, /authRequest\('POST', '\/api\/auth\/login', \{ email, password \}\)/u);
  assert.match(page, /authRequest\('POST', '\/api\/auth\/logout'\)/u);
  assert.match(page, /authRequest\('GET', '\/api\/auth\/session'\)/u);
  for (const forbidden of [/signUp/u, /signInWithPassword/u, /SignJWT/u, /jose/u, /btoa\(/u, /localStorage/u, /sessionStorage/u,
    /document\.cookie/u, /access_token/u, /refresh_token/u, /Authorization/u]) {
    assert.doesNotMatch(page, forbidden, `화면 코드에 ${forbidden}가 있으면 안 됩니다`);
  }
});

test('화면은 외부 주소나 SDK 스크립트를 불러오지 않는다', () => {
  assert.doesNotMatch(page, /<script[^>]+src=/iu);
  assert.doesNotMatch(page, /import\s[^;]*from\s+['"]https?:/u);
});

test('빌드는 브라우저용 Supabase SDK를 내려주지 않고, 예전 복사본이 있으면 지운다', () => {
  const vendor = new URL('../public/vendor/', import.meta.url);
  mkdirSync(vendor, { recursive: true });
  writeFileSync(new URL('supabase.js', vendor), '// old copy');
  execFileSync(process.execPath, ['scripts/build-public.mjs', '--local'], { cwd: root, stdio: 'pipe' });
  assert.equal(existsSync(vendor), false);
});

test('메모 호출은 같은 사이트 쿠키로만 로그인 정보를 싣고 userId·role을 따로 보내지 않는다', () => {
  const start = page.indexOf('async function callApi(');
  const callApi = page.slice(start, page.indexOf('const messageOf', start));
  assert.match(callApi, /credentials: 'same-origin'/u);
  assert.match(callApi, /authRequest\('GET', '\/api\/auth\/session'\)/u, '토큰이 만료되면 서버에서 한 번 갱신');
  for (const forbidden of [/x-user-id/iu, /userId/u, /[?&]role=/u, /x-role/iu, /owner_id/u]) {
    assert.doesNotMatch(page, forbidden);
  }
});

test('점검 버튼은 로그인 정보(쿠키) 없이 목록을 요청해 상태·JSON 오류를 콘솔에 출력하고, 거부되지 않아도 자료 내용은 출력하지 않는다', () => {
  assert.match(page, /id="probe-button"/u);
  const start = page.indexOf("document.querySelector('#probe-button')");
  const end = page.indexOf("authRequest('GET', '/api/auth/session').then", start);
  assert.ok(start > 0 && end > start);
  const probe = page.slice(start, end);
  assert.match(probe, /fetch\('\/api\/notes', \{ cache: 'no-store', credentials: 'omit' \}\)/u);
  assert.doesNotMatch(probe, /Authorization|getSession|access_token|same-origin|include/u, '점검 요청에는 로그인 정보를 싣지 않는다');
  assert.match(probe, /console\.warn\(`로그인 없이 GET \/api\/notes → HTTP \$\{response\.status\}`, body\)/u);
  const accepted = probe.slice(probe.indexOf('if (response.ok) {'), probe.indexOf('} else {'));
  assert.ok(accepted.includes('console.error('));
  assert.doesNotMatch(accepted, /\bbody\b|json\(/u, '거부되지 않은 응답의 본문은 출력하지 않는다');
});

test('화면의 API 호출이 거부되면 상태 코드와 JSON 오류를 콘솔에 남긴다', () => {
  assert.match(page, /console\.warn\(`\$\{method\} \$\{path\} → HTTP \$\{response\.status\}`, errorBody\)/u);
});
