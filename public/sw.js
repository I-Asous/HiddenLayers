// Network first, cache as a fallback: the app always runs the latest code when
// online and still opens from the home screen when the connection drops.
// API calls are never cached — balances and steps must come from the server.
const CACHE = 'stepbuddy-v28';
const SHELL = [
  '/', '/css/styles.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
  '/js/app.js', '/js/api.js', '/js/buddy.js', '/js/bestiary.js', '/js/palette.js', '/js/elements.js', '/js/fx.js', '/js/state.js', '/js/steps.js', '/js/icons.js',
  '/js/screens/home.js', '/js/screens/profile.js', '/js/screens/walk.js', '/js/screens/store.js',
  '/js/screens/battle.js', '/js/screens/stats.js', '/js/screens/map.js', '/js/geo.js', '/js/gps.js', '/js/rig.js',
  '/models/buddy.glb', '/sounds/punch.mp3', '/sounds/punch2.mp3', '/sounds/punch3.mp3', '/sounds/miss.mp3', '/sounds/win.mp3', '/sounds/lose.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
