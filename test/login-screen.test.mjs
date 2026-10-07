import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const root = new URL('..', import.meta.url);

test('로그인 화면은 공식 SDK의 로그인·로그아웃만 쓰고 비밀번호·JWT를 직접 만들지 않는다', () => {
  assert.match(page, /client\.auth\.signInWithPassword\(\{ email, password \}\)/u);
  assert.match(page, /client\.auth\.signOut\(\)/u);
  for (const forbidden of [/signUp/u, /SignJWT/u, /jose/u, /btoa\(/u, /localStorage/u, /sessionStorage/u, /document\.cookie/u]) {
    assert.doesNotMatch(page, forbidden, `화면 코드에 ${forbidden}가 있으면 안 됩니다`);
  }
});

test('화면 코드에는 공개용 값만 있고 서버 전용 키나 JWT 모양의 값이 없다', () => {
  assert.match(page, /https:\/\/iaifwhhyhzyacfdwziuo\.supabase\.co/u);
  assert.match(page, /sb_publishable_[A-Za-z0-9_-]+/u);
  for (const forbidden of [/sb_secret_/u, /service_role/iu, /SUPABASE_SECRET_KEY/u, /\beyJ[A-Za-z0-9_-]{12,}/u, /BEGIN [A-Z ]*PRIVATE KEY/u]) {
    assert.doesNotMatch(page, forbidden);
  }
});

test('로그인 화면은 외부 주소의 스크립트를 불러오지 않는다', () => {
  assert.doesNotMatch(page, /<script[^>]+src=["']?(?:https?:)?\/\//iu);
  assert.doesNotMatch(page, /import\s[^;]*from\s+['"]https?:/u);
  assert.match(page, /<script src="\/vendor\/supabase\.js"><\/script>/u);
});

test('빌드가 공식 SDK의 브라우저용 파일을 public/vendor로 복사한다', () => {
  execFileSync(process.execPath, ['scripts/build-public.mjs', '--local'], { cwd: root, stdio: 'pipe' });
  const sdk = new URL('../public/vendor/supabase.js', import.meta.url);
  assert.ok(existsSync(sdk));
  assert.ok(statSync(sdk).size > 10000);
  assert.match(readFileSync(sdk, 'utf8'), /createClient/u);
});
