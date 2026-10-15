// 11단계 설치형 웹앱의 서비스 워커입니다. 하는 일은 하나뿐입니다: 화면 이동(navigate)이 네트워크 오류로 실패하면 오프라인 안내를 보여 줍니다.
// - 메모 API(/api/…)와 그 밖의 요청은 가로채지도, 저장하지도 않습니다. 메모·토큰·쿠키는 캐시에 들어가지 않습니다.
// - 첫 화면(/)도 저장하지 않고 늘 네트워크에서 받습니다. 저장하는 것은 오프라인 안내 화면과 아이콘·manifest 뿐입니다.
// - 기기 확인·로그인과는 관계가 없습니다. 이 파일은 기기를 승인하거나 승인 상태를 만들지 않습니다.
const CACHE = 'byteback-offline-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('byteback-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE_URL))
    ?? new Response('오프라인입니다. 연결을 확인하세요.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
});
