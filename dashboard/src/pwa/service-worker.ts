// dashboard/src/pwa/service-worker.ts
// Service Worker for LuveBot PWA inside Hermes dashboard (spec §4.16, contract v0.3 §7).
//
// Rules and Invariants:
// 1. Worker scope is STRICTLY restricted to /dashboard-plugins/luvebot/
// 2. NEVER cache any /api/ response (Invariant 1 & Secrets rule: authenticated/API data must NEVER be cached)
// 3. Only cache public static assets belonging to this plugin (/dashboard-plugins/luvebot/*)
// 4. Offline mode is NOT supported within the dashboard (host shell is not controlled)

export const CACHE_NAME = "luvebot-static-v1";

export const ALLOWED_STATIC_EXTENSIONS = [
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".html",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff2",
  ".woff",
  ".ttf",
  ".otf",
  ".map",
];

/**
 * Checks whether a URL is an API or authenticated endpoint.
 * Any request matching this MUST NEVER be cached.
 */
export function isApiUrl(urlInput: string | URL): boolean {
  try {
    const url = typeof urlInput === "string" ? new URL(urlInput, "http://localhost") : urlInput;
    const pathname = url.pathname;
    return (
      pathname.includes("/api/") ||
      pathname.startsWith("/api") ||
      pathname.includes("/v1/") ||
      pathname.includes("/p/") ||
      pathname.includes("/api-server") ||
      pathname.includes("/ws")
    );
  } catch {
    const str = String(urlInput);
    return str.includes("/api/") || str.includes("/v1/") || str.includes("/ws");
  }
}

/**
 * Determines if a request is eligible for caching in the service worker.
 * Strictly enforces:
 * - Must be GET method
 * - Must NOT be an API route
 * - Must be within /dashboard-plugins/luvebot/
 * - Must have an allowed static extension
 */
export function isCacheablePluginAsset(urlInput: string | URL, method = "GET"): boolean {
  if (method.toUpperCase() !== "GET") {
    return false;
  }

  // INVARIANT: API responses must NEVER be cached
  if (isApiUrl(urlInput)) {
    return false;
  }

  try {
    const url = typeof urlInput === "string" ? new URL(urlInput, "http://localhost") : urlInput;
    const pathname = url.pathname;

    // Must be inside the plugin's own static asset path
    if (!pathname.includes("/dashboard-plugins/luvebot/")) {
      return false;
    }

    // Must have allowed static extension
    const hasAllowedExt = ALLOWED_STATIC_EXTENSIONS.some((ext) =>
      pathname.toLowerCase().endsWith(ext)
    );
    return hasAllowedExt;
  } catch {
    return false;
  }
}

/**
 * Handles incoming fetch requests for the service worker.
 * Bypasses cache completely for all API / authenticated requests.
 */
export async function handleFetch(
  request: Request,
  fetchFn: typeof fetch = fetch,
  cacheInstance?: Cache
): Promise<Response> {
  const isCacheable = isCacheablePluginAsset(request.url, request.method);

  // If not a cacheable static asset (e.g. any /api/ route), pass directly to network
  if (!isCacheable) {
    return fetchFn(request);
  }

  // For cacheable static assets, try cache first, fallback to network and update cache
  try {
    if (cacheInstance) {
      const cached = await cacheInstance.match(request);
      if (cached) {
        return cached;
      }
    }

    const networkResponse = await fetchFn(request);

    if (networkResponse && networkResponse.status === 200 && cacheInstance) {
      // Re-verify invariant before writing into cache
      if (isCacheablePluginAsset(request.url, request.method)) {
        await cacheInstance.put(request, networkResponse.clone());
      }
    }

    return networkResponse;
  } catch (err) {
    if (cacheInstance) {
      const cached = await cacheInstance.match(request);
      if (cached) {
        return cached;
      }
    }
    throw err;
  }
}

// Service Worker event listeners (active when running in SW context)
if (typeof self !== "undefined" && typeof (self as any).addEventListener === "function") {
  const swSelf = self as any;

  swSelf.addEventListener("install", (event: any) => {
    event.waitUntil(swSelf.skipWaiting());
  });

  swSelf.addEventListener("activate", (event: any) => {
    event.waitUntil(swSelf.clients.claim());
  });

  swSelf.addEventListener("fetch", (event: any) => {
    const url = new URL(event.request.url);
    // Only intercept requests for the plugin's scope
    if (url.pathname.includes("/dashboard-plugins/luvebot/")) {
      event.respondWith(
        caches.open(CACHE_NAME).then((cache) => handleFetch(event.request, fetch, cache))
      );
    }
  });
}
