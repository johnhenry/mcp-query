// App-shell service worker: network-first for same-origin GETs with an offline cache
// fallback. Never touches the proxy WebSocket or MCP traffic (different origin/protocol).

const CACHE = "mcp-inspector-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await fetch(event.request);
        cache.put(event.request, net.clone());
        return net;
      } catch {
        return (await cache.match(event.request)) ?? (await cache.match("/")) ?? Response.error();
      }
    })(),
  );
});
