// dashboard/src/pwa/register.ts
// Client-side PWA manifest injection and Service Worker registration (spec §4.16, contract v0.3 §7).
//
// Constraints:
// - Host index.html cannot be edited; manifest <link> must be injected dynamically at load.
// - Service Worker registration scope is STRICTLY restricted to /dashboard-plugins/luvebot/
// - Worker does not control root / and cannot provide offline shell inside Hermes dashboard.

export interface PwaRegistrationResult {
  manifestInjected: boolean;
  serviceWorkerRegistered: boolean;
  scope?: string;
  error?: string;
}

export function getPluginBasePath(): string {
  if (typeof window === "undefined") return "";
  return (window as any).__HERMES_BASE_PATH__ || "";
}

/**
 * Dynamically injects the PWA manifest into document.head.
 */
export function injectManifestLink(basePath = getPluginBasePath()): HTMLLinkElement | null {
  if (typeof document === "undefined") return null;

  const manifestHref = `${basePath}/dashboard-plugins/luvebot/pwa.json`;
  let existing = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');

  if (!existing) {
    existing = document.createElement("link");
    existing.rel = "manifest";
    existing.href = manifestHref;
    document.head.appendChild(existing);
  }

  // Ensure theme-color meta tag is present
  if (!document.querySelector('meta[name="theme-color"]')) {
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    meta.content = "#0b0f19";
    document.head.appendChild(meta);
  }

  return existing;
}

/** URL of a file in the plugin's own icons folder (copied into dist/icons by the build; never an external host). */
export function pluginIconUrl(file: string, basePath = getPluginBasePath()): string {
  return `${basePath}/dashboard-plugins/luvebot/icons/${file}`;
}

/**
 * Adds the LuveBot favicon and home-screen icon. The host page keeps its own links; ours come last, so the
 * browser uses them while LuveBot is the dashboard home. Idempotent.
 */
export function injectIconLinks(basePath = getPluginBasePath()): HTMLLinkElement[] {
  if (typeof document === "undefined") return [];
  const want: Array<[string, string, string?]> = [
    ["icon", "favicon-32.png", "32x32"],
    ["icon", "icon.svg"],
    ["apple-touch-icon", "apple-touch-icon.png", "180x180"],
  ];
  return want.map(([rel, file, sizes]) => {
    const href = pluginIconUrl(file, basePath);
    let link = document.querySelector<HTMLLinkElement>(`link[data-luvebot][rel="${rel}"][href="${href}"]`);
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      link.href = href;
      if (sizes) link.setAttribute("sizes", sizes);
      link.setAttribute("data-luvebot", "");
      document.head.appendChild(link);
    }
    return link;
  });
}

/**
 * Registers the Service Worker strictly scoped to the plugin directory.
 */
export async function registerServiceWorker(
  basePath = getPluginBasePath()
): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  const isSecure =
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  if (!isSecure) {
    return null;
  }

  const swUrl = `${basePath}/dashboard-plugins/luvebot/sw.js`;
  const scope = `${basePath}/dashboard-plugins/luvebot/`;

  try {
    const registration = await navigator.serviceWorker.register(swUrl, { scope });
    return registration;
  } catch (err) {
    // Non-fatal: log debug message in dev/test
    return null;
  }
}

/**
 * Initializes PWA assets for the LuveBot plugin.
 */
export async function registerPwa(basePath = getPluginBasePath()): Promise<PwaRegistrationResult> {
  const link = injectManifestLink(basePath);
  const manifestInjected = link !== null;
  injectIconLinks(basePath);

  const sw = await registerServiceWorker(basePath);
  const serviceWorkerRegistered = sw !== null;

  return {
    manifestInjected,
    serviceWorkerRegistered,
    scope: `${basePath}/dashboard-plugins/luvebot/`,
  };
}
