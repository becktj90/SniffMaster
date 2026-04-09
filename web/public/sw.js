// Service Worker — enables PWA install + offline shell caching
// BUMPED TO v42 — forces a fresh shell after PRs #16 & #17 (app.js/style.css/index.html updates)
const CACHE_NAME = "sniffmaster-v42";
const SHELL = ["/", "/style.css", "/app.js", "/manifest.json", "/melody_library.h"];
self.addEventListener("install", (e) => {
 e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)));
 self.skipWaiting();           // new SW activates immediately
});
self.addEventListener("activate", (e) => {
 e.waitUntil(
   caches.keys().then((keys) =>
     Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
   )
 );
 self.clients.claim();         // take control of all open tabs
});
// Allow the main app to force the new service worker to take over
self.addEventListener("message", (event) => {
 if (event.data && event.data.type === "SKIP_WAITING") {
   self.skipWaiting();
 }
});
self.addEventListener("fetch", (e) => {
 const url = new URL(e.request.url);
 // API calls: always go to network (live sensor data)
 if (url.pathname.startsWith("/api/")) return;
 // Static shell: cache-first with network fallback + background refresh
 e.respondWith(
   caches.match(e.request).then((cached) => {
     const fetched = fetch(e.request).then((resp) => {
       if (resp.ok) {
         const clone = resp.clone();
         caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
       }
       return resp;
     }).catch(() => cached);
     return cached || fetched;
   })
 );
});
