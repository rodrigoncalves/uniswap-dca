// Service worker (F11, DECISIONS.md #29): caches ONLY the static shell so the
// app opens offline. Never /api/*, login or any authenticated response --
// balances and history must always come from the server (invariant 6).
// Bump CACHE when a shell file changes shape; old caches are dropped on activate.
const CACHE = "dca-shell-v3";
const SHELL = ["/", "/app.js", "/vendor/qrcode.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Network first, cache only when the network fails. Anything not in SHELL
// (every /api/* call included) is left to the browser untouched.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request).then(
      (res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return res;
      },
      () => caches.match(url.pathname).then((hit) => hit ?? Response.error()),
    ),
  );
});
