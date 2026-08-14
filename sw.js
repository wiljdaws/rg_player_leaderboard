// Service Worker: stale-while-revalidate for the read-stats snapshot.
//
// Scope is deliberately narrow — we ONLY intercept the one raw.githubusercontent
// URL that the admin dashboard hammers on every activation. Everything else
// (leaderboard JSON, avatars, HTML, JS) falls through to the network untouched
// so the site's normal cache-busting and CDN behavior are preserved.
//
// Bump CACHE_VERSION to invalidate the cached snapshot for all users. The
// activate handler drops any cache whose name doesn't match CACHE_VERSION.

const CACHE_VERSION = "rgLB-read-stats-v1";
const SNAPSHOT_URL = "https://raw.githubusercontent.com/wiljdaws/rg_player_leaderboard/data/state/read-stats.json";

self.addEventListener("install", (event) => {
  // Take over immediately so users don't have to reload twice to get the SW.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith("rgLB-read-stats-") && name !== CACHE_VERSION)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.url !== SNAPSHOT_URL) return;

  event.respondWith(staleWhileRevalidate(event, request));
});

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  // Kick off the refresh in the background regardless of cache state.
  const networkPromise = fetch(request)
    .then((response) => {
      // Only cache successful responses. GitHub's raw endpoint returns 200
      // when healthy; anything else means don't overwrite the good copy.
      if (response && response.ok) {
        // Response is single-use; clone before handing it to the cache.
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Keep the SW alive long enough for the background refresh to land in
    // the cache. Wrapped in try/catch because waitUntil throws if the event
    // is already settled — non-fatal, we still return the cached copy.
    try { event.waitUntil(networkPromise); } catch (_) { /* ignore */ }
    return cached;
  }

  // Cold cache — must wait for the network. If the network fails and we
  // have nothing cached, return a 504 so the caller can surface it cleanly.
  const response = await networkPromise;
  if (response) return response;
  return new Response("", { status: 504, statusText: "read-stats snapshot unavailable" });
}
