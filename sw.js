const CACHE_NAME = "wl-unified-v3";

const CORE_ASSETS = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "machines.json",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "logo-white.png",
  "logo.png",
  "i18n.js",
  "i18n_fr.js",
  // Worklog Sub-App (Zero Modification)
  "apps/worklog/index.html",
  "apps/worklog/manifest.webmanifest",
  "apps/worklog/machines.json",
  "apps/worklog/kb.js",
  "apps/worklog/coach.js",
  "apps/worklog/analysis.js",
  "apps/worklog/examples.js",
  "apps/worklog/i18n.js",
  "apps/worklog/i18n_fr.js",
  "apps/worklog/sugg_kb.js",
  "apps/worklog/suggest.js",
  "apps/worklog/viewer.html",
  "apps/worklog/icon-180.png",
  "apps/worklog/icon-192.png",
  "apps/worklog/logo.png",
  "apps/worklog/logo-white.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch((err) => {
        console.warn("Some offline assets failed to cache:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) {
    return;
  }
  const reqUrl = new URL(event.request.url);
  if (reqUrl.pathname.endsWith("gateway_url.txt") || reqUrl.pathname.endsWith("/gateway_url.txt")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
        const fetchPromise = fetch(event.request, { cache: "no-cache" })
          .then((networkResponse) => {
            if (networkResponse && networkResponse.ok) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);
        return cachedResponse || fetchPromise;
      })
    )
  );
});
