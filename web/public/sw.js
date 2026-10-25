// 마이오피스 서비스 워커: 휴대폰 앱 설치 · 3D 모델 저장 · 푸시 알림
const CACHE = 'myoffice-assets-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

// /assets/ (빌드된 화면 파일·3D 모델)은 한 번 받으면 저장해 두고 다음부터 바로 쓴다. API·화면 첫 페이지는 항상 서버에서
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/assets/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) await cache.put(e.request, res.clone());
    return res;
  })());
});

self.addEventListener('push', e => {
  let n;
  try { n = e.data.json(); } catch { return; }
  e.waitUntil((async () => {
    if (n.type === 'clear') {
      // 다른 곳(PC 등)에서 처리된 결재: 그 알림을 닫는다. 남은 알림이 하나도 없으면
      // 크롬이 "백그라운드에서 업데이트됨" 알림을 대신 띄우므로, 조용한 "처리됨" 알림으로 바꿔 둔다
      for (const x of await self.registration.getNotifications({ tag: n.tag })) x.close();
      if (!(await self.registration.getNotifications()).length) {
        await self.registration.showNotification('✅ 처리됨', { body: '다른 곳에서 결재했어요', tag: 'handled', silent: true, icon: '/icon-192.png', badge: '/badge.png' });
      }
      return;
    }
    await self.registration.showNotification(n.title, {
      body: n.body, tag: n.tag, renotify: true, icon: '/icon-192.png', badge: '/badge.png', data: { url: n.url || '/' },
    });
  })());
});

// 알림을 누르면: 앱이 열려 있으면 그 화면으로 가져와서 해당 항목을 열고, 없으면 새로 연다
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ open: url });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
