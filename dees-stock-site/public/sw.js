/* Pass Card backup plan: keep the last good copy of the Pass Card page and the
   customer's QR so they still open with no internet. Always tries the network
   first, so a new version shows up straight away when online. Nothing else
   on the site is touched. */
const CACHE = "pass-v4";   /* v3: the page only; QR images are never touched here */
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.add("/tap")).catch(() => {})); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const page = req.mode === "navigate" && (url.pathname === "/tap" || url.pathname.startsWith("/tap/"));
  if (!page) return;   /* QR images always come straight from the server, per person */
  const key = "/tap";
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key).then((hit) => hit || Response.error()))
  );
});
