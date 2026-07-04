// Service Worker — enables PWA install + offline shell caching
// v45 — FIXES BROKEN INSTALL: the shell list still included /melody_library.h
// (removed with the Melody feature); cache.addAll() rejects when any entry
// 404s, so the install event failed and NO shell caching ever happened.
// Also: navigations are now network-first, so a fresh deploy shows up on the
// next load without waiting for the skip-waiting handshake.
const CACHE_NAME = "sniffmaster-v46"; // v46: slim history fetch in app.js
const SHELL = ["/", "/style.css", "/app.js", "/manifest.json", "/icon-192.png", "/icon-512.png"];
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
 // HTML navigations: network-first so deploys are picked up immediately,
 // with the cached shell as the offline fallback.
 if (e.request.mode === "navigate") {
   e.respondWith(
     fetch(e.request)
       .then((resp) => {
         if (resp.ok) {
           const clone = resp.clone();
           caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
         }
         return resp;
       })
       .catch(() => caches.match(e.request).then((c) => c || caches.match("/")))
   );
   return;
 }
 // Other static assets: cache-first with network fallback + background refresh
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
