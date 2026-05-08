const CACHE_NAME = 'deentok-v11';

// عند التثبيت: تخطي الانتظار فوراً
self.addEventListener('install', () => {
  self.skipWaiting();
});

// عند التفعيل: حذف كل الكاش القديم والسيطرة فوراً
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-First: دائماً يحمّل من الخادم أولاً
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // حفظ نسخة في الكاش للاستخدام بدون إنترنت
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          if (event.request.method === 'GET') cache.put(event.request, clone);
        });
        return response;
      })
      .catch(() => caches.match(event.request)) // فقط إذا لا يوجد إنترنت
  );
});
