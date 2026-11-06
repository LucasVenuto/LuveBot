// tests/unit/pwa/pwa.test.ts
// Unit tests for LuveBot PWA, Manifest, Scoped Service Worker and Honest Offline Notice (spec §4.16, contract v0.3 §7).
//
// Covers:
// 1. Valid Web App Manifest (pwa.json) with Luve theme tokens and real icon assets on disk.
// 2. Service Worker cache filter: STRICT refusal to cache any /api/ endpoint or non-GET request.
// 3. Worker handleFetch: /api/ requests bypass cache completely (cache.put NEVER called).
// 4. Worker handleFetch: caches valid static plugin assets under /dashboard-plugins/luvebot/*.
// 5. Client PWA registration: dynamic manifest injection and SW registration restricted to plugin scope.
// 6. Static Canary Scan: no secrets, tokens, credentials, or private bot data in public static files.
// 7. UI Honest Notice: renders clear disclosure that offline mode is not supported in the Hermes dashboard.

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  isApiUrl,
  isCacheablePluginAsset,
  handleFetch,
  CACHE_NAME,
  ALLOWED_STATIC_EXTENSIONS,
} from "@/pwa/service-worker";
import {
  injectManifestLink,
  injectIconLinks,
  injectAppName,
  injectPwaHead,
  registerServiceWorker,
  registerPwa,
} from "@/pwa/register";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { SettingsView } from "@/components/settings/SettingsView";

describe("LuveBot PWA & Service Worker (T5.3 / Spec §4.16 / Contract v0.3 §7)", () => {
  const rootDir = path.resolve(__dirname, "../../../");
  const pwaJsonPath = path.resolve(rootDir, "dashboard/pwa.json");
  const swJsPath = path.resolve(rootDir, "dashboard/sw.js");

  /** Where the browser lands for a reference of the manifest, wherever the proxy mounts the dashboard (the manifest itself is fetched at <prefix>/dashboard-plugins/luvebot/pwa.json). */
  const resolve = (ref: string, prefix = "") => new URL(ref, `https://bot.example.com${prefix}/dashboard-plugins/luvebot/pwa.json`).pathname;
  const pngSize = (file: string) => { const b = fs.readFileSync(path.resolve(rootDir, "dashboard/icons", file)); return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };

  beforeEach(() => {
    document.head.innerHTML = "";
    vi.restoreAllMocks();
  });

  describe("1. Web App Manifest (pwa.json) Validation", () => {
    it("manifest file exists and is valid JSON matching Luve theme tokens", () => {
      expect(fs.existsSync(pwaJsonPath)).toBe(true);
      const raw = fs.readFileSync(pwaJsonPath, "utf-8");
      const manifest = JSON.parse(raw);

      // Core metadata
      expect(manifest.name).toBe("LuveBot");
      expect(manifest.short_name).toBe("LuveBot");
      expect(manifest.display).toBe("standalone");
      expect(resolve(manifest.start_url)).toBe("/");       // the app opens at the root of the dashboard...
      expect(resolve(manifest.scope)).toBe("/");
      expect(resolve(manifest.start_url, "/hermes")).toBe("/hermes/");   // ...and behind a path prefix at the prefix (an absolute "/" opened the proxy's root)

      // Luve theme colors (per theme/luve.yaml)
      expect(manifest.theme_color).toBe("#0b0f19");
      expect(manifest.background_color).toBe("#0b0f19");

      // Icons array
      expect(Array.isArray(manifest.icons)).toBe(true);
      expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

      // Verify that every icon referenced in manifest actually exists on disk
      manifest.icons.forEach((icon: { src: string; sizes: string; type: string }) => {
        expect(icon.src).toBeDefined();
        // Extract filename from a reference like "icons/icon-192.png"
        const filename = icon.src.split("/").pop()!;
        const diskPath = path.resolve(rootDir, "dashboard/icons", filename);
        expect(fs.existsSync(diskPath), `Missing icon on disk: ${diskPath}`).toBe(true);
        expect(fs.statSync(diskPath).size).toBeGreaterThan(0);
      });
    });
  });

  describe("1b. The Home Screen icon (an iPhone that adds the app reads the manifest and the icons WITHOUT the person's cookies)", () => {
    const manifest = () => JSON.parse(fs.readFileSync(pwaJsonPath, "utf-8")) as { icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>; start_url: string; scope: string };

    it("every icon address is relative to the manifest, so it reaches the plugin's folder with no prefix and behind any path prefix (an absolute one went to the proxy's root, outside Hermes)", () => {
      for (const i of manifest().icons) {
        expect(i.src.startsWith("/"), `${i.src} is absolute`).toBe(false);
        expect(i.src).not.toMatch(/^[a-z]+:/i);
        for (const prefix of ["", "/hermes", "/a/b"]) expect(resolve(i.src, prefix)).toBe(`${prefix}/dashboard-plugins/luvebot/${i.src}`);
      }
      for (const prefix of ["", "/hermes", "/a/b"]) { expect(resolve(manifest().start_url, prefix)).toBe(`${prefix}/`); expect(resolve(manifest().scope, prefix)).toBe(`${prefix}/`); }
    });

    it("the manifest lists PNG only: an iPhone cannot draw an SVG icon, and an entry with sizes 'any' is the first it may pick", () => {
      const icons = manifest().icons;
      for (const i of icons) { expect(i.type, i.src).toBe("image/png"); expect(i.src, i.src).toMatch(/\.png$/); expect(i.sizes, i.src).not.toBe("any"); }
    });

    it("each icon is the PNG it says it is: the declared size is the real size (an iPhone chooses by it), and the 180 x 180 one it asks for is there", () => {
      const icons = manifest().icons;
      for (const i of icons) expect(pngSize(i.src.split("/").pop()!), i.src).toEqual(i.sizes.split("x").map(Number));
      expect(icons.some((i) => i.sizes === "180x180" && i.purpose === "any")).toBe(true);
      expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    });

    it("the plugin's static folder stays the only public thing: the SW does not widen what the host serves, and no data route is in the manifest", () => {
      const raw = fs.readFileSync(pwaJsonPath, "utf-8");
      expect(raw).not.toMatch(/\/api\/|\/p\/|\/v1\//);
    });
  });

  describe("2. Service Worker URL Cache Filtering (isApiUrl & isCacheablePluginAsset)", () => {
    it("strictly flags all API, gateway, and authenticated endpoints as API URLs", () => {
      expect(isApiUrl("http://localhost:9119/api/plugins/luvebot/health")).toBe(true);
      expect(isApiUrl("http://localhost:9119/api/plugins/luvebot/bots")).toBe(true);
      expect(isApiUrl("http://localhost:9119/api/plugins/luvebot/rooms")).toBe(true);
      expect(isApiUrl("http://localhost:9119/api/sessions/search?q=test")).toBe(true);
      expect(isApiUrl("http://localhost:9119/v1/capabilities")).toBe(true);
      expect(isApiUrl("http://localhost:9119/p/vendas/sessions")).toBe(true);
      expect(isApiUrl("http://localhost:9119/api-server/runs")).toBe(true);
      expect(isApiUrl("http://localhost:9119/api/ws")).toBe(true);

      // Non-API static URLs
      expect(isApiUrl("http://localhost:9119/dashboard-plugins/luvebot/dist/style.css")).toBe(false);
      expect(isApiUrl("http://localhost:9119/dashboard-plugins/luvebot/pwa.json")).toBe(false);
    });

    it("STRICTLY REFUSES to cache any /api/ endpoint or authenticated route", () => {
      const apiUrls = [
        "http://localhost:9119/api/plugins/luvebot/bots",
        "http://localhost:9119/api/plugins/luvebot/approvals",
        "http://localhost:9119/api/plugins/luvebot/budget",
        "http://localhost:9119/api/plugins/luvebot/routines",
        "http://localhost:9119/api/plugins/luvebot/map",
        "http://localhost:9119/api/plugins/luvebot/search",
        "http://localhost:9119/v1/toolsets",
        "http://localhost:9119/p/default/runs",
      ];

      for (const url of apiUrls) {
        expect(
          isCacheablePluginAsset(url, "GET"),
          `Must NOT cache API endpoint: ${url}`
        ).toBe(false);
      }
    });

    it("strictly refuses to cache non-GET HTTP methods even for static URLs", () => {
      const staticUrl = "http://localhost:9119/dashboard-plugins/luvebot/dist/style.css";
      expect(isCacheablePluginAsset(staticUrl, "POST")).toBe(false);
      expect(isCacheablePluginAsset(staticUrl, "PUT")).toBe(false);
      expect(isCacheablePluginAsset(staticUrl, "PATCH")).toBe(false);
      expect(isCacheablePluginAsset(staticUrl, "DELETE")).toBe(false);
    });

    it("strictly refuses requests outside the plugin's own static directory (/dashboard-plugins/luvebot/)", () => {
      expect(isCacheablePluginAsset("http://localhost:9119/", "GET")).toBe(false);
      expect(isCacheablePluginAsset("http://localhost:9119/index.html", "GET")).toBe(false);
      expect(isCacheablePluginAsset("http://localhost:9119/assets/vendor.js", "GET")).toBe(false);
      expect(isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/other-plugin/file.js", "GET")).toBe(false);
    });

    it("allows caching only for valid static asset extensions inside /dashboard-plugins/luvebot/", () => {
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/dist/style.css", "GET")
      ).toBe(true);
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/dist/index.js", "GET")
      ).toBe(true);
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/pwa.json", "GET")
      ).toBe(true);
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/icons/icon-192.png", "GET")
      ).toBe(true);
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/icons/icon.svg", "GET")
      ).toBe(true);

      // Unknown or dangerous extensions are refused
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/secrets.env", "GET")
      ).toBe(false);
      expect(
        isCacheablePluginAsset("http://localhost:9119/dashboard-plugins/luvebot/data.db", "GET")
      ).toBe(false);
    });
  });

  describe("3. Service Worker handleFetch Execution Guard", () => {
    it("CRITICAL: handleFetch NEVER writes /api/ responses into cache", async () => {
      const mockCache = {
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
      } as unknown as Cache;

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ bots: [{ name: "vendas", secret_token: "NEVER_CACHE_THIS" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const apiRequest = new Request("http://localhost:9119/api/plugins/luvebot/bots", {
        method: "GET",
      });

      const response = await handleFetch(apiRequest, mockFetch, mockCache);
      expect(response).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(apiRequest);

      // INVARIANT: Cache MUST NOT have been queried or written to for API routes!
      expect(mockCache.match).not.toHaveBeenCalled();
      expect(mockCache.put).not.toHaveBeenCalled();
    });

    it("handleFetch caches legitimate static plugin assets on successful response", async () => {
      const mockCache = {
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
      } as unknown as Cache;

      const staticCssResponse = new Response("/* style.css */", {
        status: 200,
        headers: { "Content-Type": "text/css" },
      });

      const mockFetch = vi.fn().mockResolvedValue(staticCssResponse);

      const staticRequest = new Request(
        "http://localhost:9119/dashboard-plugins/luvebot/dist/style.css",
        { method: "GET" }
      );

      const response = await handleFetch(staticRequest, mockFetch, mockCache);
      expect(response).toBeDefined();
      expect(mockFetch).toHaveBeenCalledWith(staticRequest);

      // Static asset was checked and stored in cache
      expect(mockCache.match).toHaveBeenCalledWith(staticRequest);
      expect(mockCache.put).toHaveBeenCalledWith(staticRequest, expect.anything());
    });
  });

  describe("4. Client PWA Registration (registerPwa, injectManifestLink, registerServiceWorker)", () => {
    it("injectManifestLink injects <link rel='manifest'> and theme-color meta tag into document.head", () => {
      const link = injectManifestLink("/base");
      expect(link).not.toBeNull();
      expect(link?.getAttribute("rel")).toBe("manifest");
      expect(link?.getAttribute("href")).toBe("/base/dashboard-plugins/luvebot/pwa.json");

      const meta = document.querySelector('meta[name="theme-color"]');
      expect(meta).not.toBeNull();
      expect(meta?.getAttribute("content")).toBe("#0b0f19");
    });

    it("injectAppName names the Home Screen icon 'LuveBot' (the host's own title is 'Hermes Agent - Dashboard') and never overrides a name the host gave", () => {
      document.title = "Hermes Agent - Dashboard";
      const meta = injectAppName();
      injectAppName();
      expect(document.querySelectorAll('meta[name="apple-mobile-web-app-title"]')).toHaveLength(1);
      expect(meta?.getAttribute("content")).toBe("LuveBot");
      document.head.innerHTML = '<meta name="apple-mobile-web-app-title" content="Dono do host">';
      injectAppName();
      expect(document.querySelectorAll('meta[name="apple-mobile-web-app-title"]')).toHaveLength(1);
      expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content")).toBe("Dono do host");
    });

    it("injectPwaHead puts the manifest, the icons and the name in the head in ONE synchronous call, once, behind a prefix too", () => {
      for (const prefix of ["", "/hermes"]) {
        document.head.innerHTML = "";
        injectPwaHead(prefix);
        injectPwaHead(prefix);
        expect(document.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
        expect(document.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe(`${prefix}/dashboard-plugins/luvebot/pwa.json`);
        expect(document.querySelectorAll('link[rel="apple-touch-icon"]')).toHaveLength(1);
        expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(`${prefix}/dashboard-plugins/luvebot/icons/apple-touch-icon.png`);
        expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("sizes")).toBe("180x180");
        expect(document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content")).toBe("LuveBot");
      }
    });

    it("the entry injects the head when the bundle LOADS (module level, before any component draws), not only in an effect after the first paint", () => {
      const src = fs.readFileSync(path.resolve(rootDir, "dashboard/src/index.tsx"), "utf-8");
      expect(src).toMatch(/^injectPwaHead\(\);/m);                       // a statement at column 0: it runs at import, not inside a component
      expect(src).toMatch(/import \{[^}]*injectPwaHead[^}]*\} from "\.\/pwa"/);
    });

    it("injectIconLinks adds the LuveBot favicon and home-screen icon once, from the plugin's own icons folder", () => {
      injectIconLinks("/base");
      injectIconLinks("/base");
      const links = Array.from(document.querySelectorAll<HTMLLinkElement>("link[data-luvebot]"));
      expect(links.map((l) => [l.getAttribute("rel"), l.getAttribute("href")])).toEqual([
        ["icon", "/base/dashboard-plugins/luvebot/icons/favicon-32.png"],
        ["icon", "/base/dashboard-plugins/luvebot/icons/icon.svg"],
        ["apple-touch-icon", "/base/dashboard-plugins/luvebot/icons/apple-touch-icon.png"],
      ]);
    });

    it("every brand file the UI points at ships in dashboard/icons, and the SVGs carry no script or external reference", () => {
      for (const f of ["favicon-32.png", "apple-touch-icon.png", "icon.svg", "luvebot-wordmark.svg", "luvebot-wordmark-white.svg"]) {
        expect(fs.existsSync(path.resolve(rootDir, "dashboard/icons", f))).toBe(true);
      }
      for (const f of ["icon.svg", "luvebot-wordmark.svg", "luvebot-wordmark-white.svg"]) {
        const svg = fs.readFileSync(path.resolve(rootDir, "dashboard/icons", f), "utf8");
        expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+=|href="(?!#)|url\((?!#)/i);
      }
    });

    it("registerServiceWorker restricts scope strictly to /dashboard-plugins/luvebot/", async () => {
      const registerMock = vi.fn().mockResolvedValue({ scope: "/dashboard-plugins/luvebot/" });
      Object.defineProperty(globalThis.navigator, "serviceWorker", {
        value: { register: registerMock },
        writable: true,
        configurable: true,
      });

      const registration = await registerServiceWorker("");
      expect(registration).not.toBeNull();
      expect(registerMock).toHaveBeenCalledWith(
        "/dashboard-plugins/luvebot/sw.js",
        { scope: "/dashboard-plugins/luvebot/" }
      );
    });
  });

  describe("5. Static Asset Canary Scan (No secrets in public static files)", () => {
    it("all public static files in dashboard/ contain zero secrets, tokens, or private bot data", () => {
      const forbiddenTokens = [
        "secret",
        "api_key",
        "apikey",
        "authorization",
        "bearer",
        "private_key",
        "BEGIN RSA",
        "API_SERVER_KEY",
        "sk-",
        "password",
        "passwd",
      ];

      // Files served statically without authentication
      const filesToCheck = [
        pwaJsonPath,
        swJsPath,
        path.resolve(rootDir, "dashboard/manifest.json"),
      ];

      for (const filePath of filesToCheck) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
        for (const token of forbiddenTokens) {
          expect(
            content.includes(token.toLowerCase()),
            `Security Canary: Forbidden sensitive token '${token}' found in public file ${filePath}`
          ).toBe(false);
        }
      }
    });
  });

  describe("6. UI Honest Notice: Offline mode is not supported within the dashboard", () => {
    it("renders honest warning banner when isOffline is true, stating offline is not supported", () => {
      render(
        <MessengerShell isOffline={true}>
          <div data-testid="test-content">Conteúdo</div>
        </MessengerShell>
      );

      // Honest notice banner appears
      const banner = screen.getByTestId("pwa-offline-notice");
      expect(banner).toBeDefined();

      // Heading and explanatory body
      expect(banner.textContent).toContain("Modo offline não suportado");
      expect(banner.textContent).toContain("não funciona offline");
      expect(banner.textContent).toContain("requer conexão ativa com o Hermes");
    });

    it("the honest PWA facts live in Settings, not in the contact list (F8)", () => {
      render(
        <MessengerShell isOffline={false}>
          <div data-testid="test-content">Conteúdo</div>
        </MessengerShell>
      );
      expect(screen.queryByText("PWA Instalável")).toBeNull();
      cleanup();
      render(<SettingsView />);
      expect(screen.getByText("PWA Instalável")).toBeDefined();
      expect(screen.getByText("Modo offline não suportado")).toBeDefined();
      expect(screen.getByText(/Nenhuma rota de API é guardada em cache/)).toBeDefined();
    });
  });
});
