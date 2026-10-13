/* Pass Card backup plan: keep the last good copy of the Pass Card page and the
   customer's QR so they still open with no internet. Always tries the network
   first, so a new version shows up straight away when online. Nothing else
   on the site is touched. */
const CACHE = "pass-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.add("/pass")).catch(() => {})); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const page = req.mode === "navigate" && (url.pathname === "/pass" || url.pathname.startsWith("/pass/"));
  const qr = url.pathname === "/api/pass/qr.svg";
  if (!page && !qr) return;
  const key = page ? "/pass" : "/api/pass/qr.svg";
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then((hit) => hit || Response.error()))
  );
});
