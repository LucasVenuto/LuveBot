"use strict";
(() => {
  // dashboard/src/pwa/service-worker.ts
  var CACHE_NAME = "luvebot-static-v1";
  var ALLOWED_STATIC_EXTENSIONS = [
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
    ".map"
  ];
  function isApiUrl(urlInput) {
    try {
      const url = typeof urlInput === "string" ? new URL(urlInput, "http://localhost") : urlInput;
      const pathname = url.pathname;
      return pathname.includes("/api/") || pathname.startsWith("/api") || pathname.includes("/v1/") || pathname.includes("/p/") || pathname.includes("/api-server") || pathname.includes("/ws");
    } catch {
      const str = String(urlInput);
      return str.includes("/api/") || str.includes("/v1/") || str.includes("/ws");
    }
  }
  function isCacheablePluginAsset(urlInput, method = "GET") {
    if (method.toUpperCase() !== "GET") {
      return false;
    }
    if (isApiUrl(urlInput)) {
      return false;
    }
    try {
      const url = typeof urlInput === "string" ? new URL(urlInput, "http://localhost") : urlInput;
      const pathname = url.pathname;
      if (!pathname.includes("/dashboard-plugins/luvebot/")) {
        return false;
      }
      const hasAllowedExt = ALLOWED_STATIC_EXTENSIONS.some(
        (ext) => pathname.toLowerCase().endsWith(ext)
      );
      return hasAllowedExt;
    } catch {
      return false;
    }
  }
  async function handleFetch(request, fetchFn = fetch, cacheInstance) {
    const isCacheable = isCacheablePluginAsset(request.url, request.method);
    if (!isCacheable) {
      return fetchFn(request);
    }
    try {
      if (cacheInstance) {
        const cached = await cacheInstance.match(request);
        if (cached) {
          return cached;
        }
      }
      const networkResponse = await fetchFn(request);
      if (networkResponse && networkResponse.status === 200 && cacheInstance) {
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
  if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
    const swSelf = self;
    swSelf.addEventListener("install", (event) => {
      event.waitUntil(swSelf.skipWaiting());
    });
    swSelf.addEventListener("activate", (event) => {
      event.waitUntil(swSelf.clients.claim());
    });
    swSelf.addEventListener("fetch", (event) => {
      const url = new URL(event.request.url);
      if (url.pathname.includes("/dashboard-plugins/luvebot/")) {
        event.respondWith(
          caches.open(CACHE_NAME).then((cache) => handleFetch(event.request, fetch, cache))
        );
      }
    });
  }
})();
