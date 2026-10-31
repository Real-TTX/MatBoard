/* MatBoard service worker: the app as a PWA – small on purpose.
   - Static files (toolkit, styles, scripts, icons): from the cache first, refreshed in the background (their addresses carry ?v=<hash>).
   - Pages come from the network. Without one: the last copy of a board page you opened (so a board can still be shown, its data comes from the
     copy that board-net.js keeps), else the offline page (offline.html) with a button to try again.
   - The live connection (WebSocket), the APIs and every POST are never touched. */
const VERSION = 'matboard-v1';
const BOARDS = 'mb-pages';
const SHELL = ['/offline.html', '/js/offline.js', '/matui/matui.css', '/css/app.css', '/favicon.svg', '/img/icon-192.png', '/img/icon-512.png', '/img/logo/matboard-logo.svg', '/img/logo/matboard-logo-dark.svg', '/manifest.webmanifest'];
const MAX_PAGES = 12;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

// an older version of the shell is gone (the copies of board pages stay: they are the person's)
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== BOARDS && k !== 'mb-boards').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// signing out clears what was kept for this person: the pages and the data of their boards (sent by pwa.js)
self.addEventListener('message', event => {
  if (event.data === 'mb-clear') {
    event.waitUntil(Promise.all([caches.delete(BOARDS), caches.delete('mb-boards')]));
  }
});

function isStatic(url) {
  return /^\/(matui|css|js|img)\//.test(url.pathname) || url.pathname === '/favicon.svg' || url.pathname === '/manifest.webmanifest' || url.pathname === '/offline.html';
}

function isBoardPage(url) {
  return /^\/Boards\/Canvas\/\d+$/i.test(url.pathname) || /^\/b\/[0-9a-f-]{36}$/i.test(url.pathname);
}

function trim(cache) {
  return cache.keys().then(keys => { if (keys.length > MAX_PAGES) { return cache.delete(keys[0]); } });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') { return; }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/live/') || url.pathname === '/health' || url.pathname === '/sw.js') { return; }

  if (request.mode === 'navigate') {
    if (isBoardPage(url)) {
      // a board page: from the network (and kept), without one the copy of the last visit
      event.respondWith(fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(BOARDS).then(cache => cache.put(request, copy).then(() => trim(cache)));
        }
        return response;
      }).catch(() => caches.open(BOARDS).then(cache => cache.match(request)).then(hit => hit || caches.match('/offline.html'))));
      return;
    }
    event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
    return;
  }

  if (isStatic(url)) {
    event.respondWith(caches.open(VERSION).then(cache => cache.match(request).then(hit => {
      const fresh = fetch(request).then(response => { if (response.ok) { cache.put(request, response.clone()); } return response; }).catch(() => hit);
      return hit || fresh;
    })));
  }
});
