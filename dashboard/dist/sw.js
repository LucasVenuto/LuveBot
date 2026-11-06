"use strict";
(() => {
  // dashboard/src/pwa/push.ts
  var KIND_TARGET = { approval: "approvals", budget: "costs", question: "activity" };
  var LATEST_TIMEOUT_MS = 3e3;
  var BOT_MAX = 40;
  var WORDS = {
    pt: { needs: "precisa de voc\xEA", generic: "LuveBot: algo precisa de voc\xEA", open: "Toque para abrir o LuveBot.", kinds: { approval: "Aprova\xE7\xE3o", budget: "Or\xE7amento", question: "Pergunta" } },
    en: { needs: "needs you", generic: "LuveBot: something needs you", open: "Tap to open LuveBot.", kinds: { approval: "Approval", budget: "Budget", question: "Question" } }
  };
  var pushLang = (language) => language && /^en/i.test(language) ? "en" : "pt";
  function basePathOf(swPathname) {
    const at = swPathname.indexOf("/dashboard-plugins/luvebot/");
    return at > 0 ? swPathname.slice(0, at) : "";
  }
  var clean = (value, max) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
  function specFor(event, lang, iconUrl) {
    const words = WORDS[lang];
    const e = event && typeof event === "object" ? event : null;
    const kind = e && typeof e.kind === "string" && Object.prototype.hasOwnProperty.call(KIND_TARGET, e.kind) ? e.kind : null;
    const bot = e ? clean(e.bot, BOT_MAX) : "";
    const target = kind ? KIND_TARGET[kind] : "approvals";
    const base = { tag: "luvebot", renotify: true, icon: iconUrl, data: { target } };
    if (!kind || !bot) return { title: words.generic, options: { ...base, body: words.open } };
    return { title: `${bot} ${words.needs}`, options: { ...base, body: words.kinds[kind] } };
  }
  async function newestEvent(fetchFn, apiBase, timeoutMs = LATEST_TIMEOUT_MS) {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(`${apiBase}/api/plugins/luvebot/notifications/latest`, { credentials: "same-origin", cache: "no-store", ...ac ? { signal: ac.signal } : {} });
      if (!res.ok) return null;
      const body = await res.json();
      return Array.isArray(body?.events) && body.events.length ? body.events[0] : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function showPush(registration, fetchFn, basePath, language, timeoutMs = LATEST_TIMEOUT_MS) {
    const lang = pushLang(language);
    const icon = `${basePath}/dashboard-plugins/luvebot/icons/icon-192.png`;
    let spec;
    try {
      spec = specFor(await newestEvent(fetchFn, basePath, timeoutMs), lang, icon);
    } catch {
      spec = specFor(null, lang, icon);
    }
    try {
      await registration.showNotification(spec.title, spec.options);
    } catch {
      const generic = specFor(null, lang, icon);
      await registration.showNotification(generic.title, generic.options);
    }
  }
  async function openTarget(clients, origin, basePath, data) {
    const raw = data && typeof data === "object" ? data.target : null;
    const target = raw === "costs" ? "costs" : raw === "activity" ? "activity" : "approvals";
    const home = `${origin}${basePath}/`;
    const isHome = (url) => {
      try {
        const u = new URL(url);
        return u.origin === origin && (u.pathname === `${basePath}/` || basePath !== "" && u.pathname === basePath);
      } catch {
        return false;
      }
    };
    const open = (await clients.matchAll({ type: "window", includeUncontrolled: true })).find((c) => isHome(c.url));
    if (open) {
      await open.focus();
      open.postMessage({ type: "luvebot.open", target });
      return;
    }
    await clients.openWindow(`${home}?luvebot=${target}`);
  }

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
    swSelf.addEventListener("push", (event) => {
      event.waitUntil(showPush(swSelf.registration, fetch, basePathOf(swSelf.location.pathname), swSelf.navigator?.language));
    });
    swSelf.addEventListener("notificationclick", (event) => {
      event.notification.close();
      event.waitUntil(openTarget(swSelf.clients, swSelf.location.origin, basePathOf(swSelf.location.pathname), event.notification.data));
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
