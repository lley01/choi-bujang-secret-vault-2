import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

// 11단계 설치형 웹앱(manifest)·오프라인 안내·앱·기기 상태 표시. 브라우저 없이 파일과 서비스 워커 동작을 시험합니다. 심판 판정이 아닙니다.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('public/index.html');
const root = new URL('..', import.meta.url);

test('설정은 11단계이고, 실제 빌드(Vercel 흉내)가 만든 /aleph.json도 11단계다', () => {
  const config = JSON.parse(read('aleph.config.json'));
  assert.equal(config.step, 11);
  const output = new URL('../public/aleph.json', import.meta.url);
  try {
    execFileSync(process.execPath, ['scripts/build-public.mjs'], { cwd: root, stdio: 'pipe', env: { ...process.env,
      VERCEL_GIT_PROVIDER: 'github', VERCEL_GIT_REPO_OWNER: 'student', VERCEL_GIT_REPO_SLUG: 'defense-app',
      VERCEL_GIT_COMMIT_SHA: 'f'.repeat(40), VERCEL_URL: 'defense-app-mno345.vercel.app' } });
    const written = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(written.step, 11);
    assert.equal(written.restoreRoute, config.restoreRoute);
  } finally {
    rmSync(output, { force: true });
  }
});

test('manifest: 앱 이름·짧은 이름·standalone·시작 주소·아이콘 192/512가 있고, 설치가 기기 확인이 아니라고 적는다', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.name, 'BYTE BACK 내 자료실');
  assert.equal(manifest.short_name, '내 자료실');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.match(manifest.description, /설치는 바로가기일 뿐이며, 로그인과 기기 승인은 따로 확인/u);
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((item) => item.sizes === `${size}x${size}`);
    assert.ok(icon && icon.type === 'image/png', `${size} 아이콘`);
    const png = readFileSync(new URL(`../public${icon.src}`, import.meta.url));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [size, size], `${icon.src}의 실제 크기`);
  }
  assert.ok(!/https?:\/\//u.test(JSON.stringify(manifest)), '외부 주소 없음');
});

test('화면이 manifest·아이콘을 연결하고, 외부 스크립트나 브라우저 저장소를 쓰지 않는다', () => {
  assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest">/u);
  assert.match(page, /<meta name="theme-color" content="#101a28">/u);
  assert.match(page, /<link rel="apple-touch-icon" href="\/icons\/icon-192\.png">/u);
  assert.doesNotMatch(page, /<script[^>]+src=/iu);
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/u);
  assert.match(page, /navigator\.serviceWorker\.register\('\/sw\.js', \{ scope: '\/' \}\)\.catch\(\(\) => \{\}\)/u);
});

test('앱·기기 상태: 기기 승인 표시는 서버 응답(current)으로만 「승인됨」이 되고, 설치 표시로 기기 확인이 끝났다고 쓰지 않는다', () => {
  assert.match(page, /<dd id="device-approval" role="status">로그인하면 서버에 확인합니다<\/dd>/u);
  assert.match(page, /앱을 설치했다고 기기가 확인된 것은 아닙니다/u);
  assert.match(page, /'설치한 앱 창\(설치는 기기 확인이 아님\)'/u);
  const script = page.slice(page.indexOf('<script>'));
  // 「승인됨」 문구와 deviceConfirmed = true 는 서버 상태 응답의 current 가 approved 일 때 한 곳에서만 나온다.
  assert.equal((script.match(/deviceConfirmed = true/gu) ?? []).length, 1);
  assert.match(script, /if \(current\?\.status === 'approved' && typeof current\.id === 'string'\) \{\s+deviceConfirmed = true;\s+deviceApproval\.textContent = `승인됨 — 서버가/u);
  assert.equal((script.match(/승인됨 — /gu) ?? []).length, 1);
  for (const claim of [/기기 확인 완료/u, /승인 완료/u, /인증된 기기/u, /신뢰할 수 있는 기기/u]) assert.doesNotMatch(page, claim, String(claim));
});

test('오프라인 안내: 연결이 없으면 메모를 볼 수도 저장할 수도 없다고 알리고, 설치만으로 기기 확인이 끝나지 않는다고 적는다', () => {
  const offline = read('public/offline.html');
  assert.match(offline, /<h1>지금은 오프라인입니다<\/h1>/u);
  assert.match(offline, /오프라인에서는 메모를 볼 수도, 저장할 수도 없습니다/u);
  assert.match(offline, /설치만으로 기기 확인이 끝나지 않습니다/u);
  assert.doesNotMatch(offline, /<script/iu);
  assert.match(page, /'오프라인: 메모를 불러오거나 저장할 수 없습니다\. 연결되면 다시 시도하세요\.'/u);
});

// 서비스 워커를 가짜 self·caches·fetch 위에서 실행합니다.
function loadWorker({ network = async () => new Response('online page') } = {}) {
  const listeners = {};
  const stored = new Map();
  const puts = [];
  const cache = {
    addAll: async (urls) => { for (const url of urls) stored.set(url, new Response(`cached ${url}`)); },
    put: async (...args) => { puts.push(args); },
    keys: async () => [...stored.keys()],
  };
  const sandbox = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { origin: 'https://app.vercel.app' }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, keys: async () => ['byteback-offline-v1', 'byteback-offline-v0', 'other-app'], delete: async (key) => { sandbox.deleted.push(key); return true; },
      match: async (url) => stored.get(url) },
    fetch: async (request) => network(request), Response, URL, Promise, deleted: [],
  };
  vm.runInNewContext(read('public/sw.js'), sandbox);
  const run = async (type, extra = {}) => {
    let waited; let responded;
    listeners[type]({ ...extra, waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; } });
    await waited;
    return responded === undefined ? undefined : await responded;
  };
  return { run, stored, puts, sandbox };
}
const navigate = (url, extra = {}) => ({ request: { url, mode: 'navigate', method: 'GET', ...extra } });

test('서비스 워커: 오프라인 안내·manifest·아이콘만 저장하고, 첫 화면이나 메모 API는 저장하지 않는다', async () => {
  const worker = loadWorker();
  await worker.run('install');
  assert.deepEqual([...worker.stored.keys()], ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
  await worker.run('activate');
  assert.deepEqual(worker.sandbox.deleted, ['byteback-offline-v0'], '이 앱의 옛 캐시만 지움');
  const online = await worker.run('fetch', navigate('https://app.vercel.app/'));
  assert.equal(await online.text(), 'online page', '연결되어 있으면 늘 네트워크의 첫 화면');
  assert.equal(worker.puts.length, 0, '응답을 캐시에 넣지 않음');
});

test('서비스 워커: 화면 이동이 네트워크 오류로 실패할 때만 오프라인 안내를 보여 준다', async () => {
  const worker = loadWorker({ network: async () => { throw new TypeError('Failed to fetch'); } });
  await worker.run('install');
  const offline = await worker.run('fetch', navigate('https://app.vercel.app/'));
  assert.equal(await offline.text(), 'cached /offline.html');
});

test('서비스 워커: 메모 API·다른 사이트·화면 이동이 아닌 요청은 가로채지 않는다', async () => {
  const worker = loadWorker({ network: async () => { throw new Error('가로채면 안 됨'); } });
  await worker.run('install');
  for (const event of [
    navigate('https://app.vercel.app/api/notes'), navigate('https://app.vercel.app/api/restore/x', { method: 'POST' }),
    { request: { url: 'https://app.vercel.app/api/notes', mode: 'cors', method: 'GET' } },
    { request: { url: 'https://app.vercel.app/icons/icon-192.png', mode: 'no-cors', method: 'GET' } },
    navigate('https://other.example/'),
  ]) {
    assert.equal(await worker.run('fetch', event), undefined, event.request.url);
  }
});

test('vercel.json: 서비스 워커는 캐시하지 않고(no-cache), manifest 형식을 알리며, nosniff는 그대로다', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const headersOf = (source) => Object.fromEntries((vercel.headers.find((item) => item.source === source)?.headers ?? []).map(({ key, value }) => [key, value]));
  assert.equal(headersOf('/(.*)')['X-Content-Type-Options'], 'nosniff');
  assert.equal(headersOf('/sw.js')['Cache-Control'], 'no-cache');
  assert.match(headersOf('/manifest.webmanifest')['Content-Type'], /^application\/manifest\+json/u);
});

test('따로 접속 프로그램을 만들지 않았다: 서버 함수·패키지 의존성·설치 스크립트가 늘지 않았다', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ['@supabase/supabase-js', 'jose'], '새 의존성 없음');
  assert.ok(!Object.keys(pkg.scripts).some((name) => /install|client|agent|connector|tunnel/iu.test(name)), '접속 프로그램용 명령 없음');
  for (const path of ['client', 'agent', 'connector', 'desktop', 'electron']) assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
});
