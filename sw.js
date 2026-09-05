/* Service worker — cache estático para uso offline */
const CACHE = 'cgi-pack-v17';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './css/styles.css?v=17',
  './js/app.js',
  './js/app.js?v=17',
  './js/config.js',
  './js/config.js?v=17',
  './js/storage.js',
  './js/storage.js?v=17',
  './js/db.js',
  './js/db.js?v=17',
  './js/sync.js',
  './js/sync.js?v=17',
  './js/firebase-config.js',
  './js/firebase-config.js?v=17',
  './js/ocr-fill.js',
  './js/ocr-fill.js?v=17',
  './js/cdn.json',
  './manifest.json',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/tesseract.min.js',
  './vendor/worker.min.js',
  './vendor/tesseract-core-simd-lstm.wasm.js',
  './vendor/tesseract-core-simd-lstm.wasm',
  './vendor/tesseract-core-lstm.wasm.js',
  './vendor/tesseract-core-lstm.wasm',
  './vendor/eng.traineddata.gz',
  './vendor/por.traineddata.gz',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // Não cachear SDKs Firebase remotos de forma agressiva — network first
  const url = new URL(req.url);
  if (url.hostname.includes('gstatic.com') || url.hostname.includes('googleapis.com')) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetched = fetch(req)
        .then((res) => {
          if (res && res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
