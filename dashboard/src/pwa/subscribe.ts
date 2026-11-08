// dashboard/src/pwa/subscribe.ts
// This device's side of the notifications (contract v0.8 §6): can it get them, and make it get them. The permission is asked in `enable` ONLY, which the
// Ativar button calls from its click (a prompt out of nowhere is refused by Safari and annoys everywhere). The browser's keys are never read or sent:
// the push has no payload, so the server needs only the endpoint. The id the server gave this device is kept in this browser to say "Este aparelho".

import { getPluginBasePath } from "./register";

export type PushSupport = "ready" | "unsupported" | "needs_install" | "needs_https" | "denied";
const KEY = "luvebot.push.device";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && (navigator as { maxTouchPoints?: number }).maxTouchPoints! > 1);
const standalone = () => (navigator as { standalone?: boolean }).standalone === true || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);

/** What this browser can do right now, without asking for anything. iOS only delivers to the installed app (Home Screen) over https. */
export function pushSupport(): PushSupport {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return isIos() && !standalone() ? "needs_install" : "unsupported";
  if (isIos() && !standalone()) return "needs_install";
  if (window.location.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(window.location.hostname)) return "needs_https";
  return Notification.permission === "denied" ? "denied" : "ready";
}

export const thisDevice = (): string | null => { try { return window.localStorage.getItem(KEY); } catch { return null; } };
const remember = (id: string | null) => { try { if (id) window.localStorage.setItem(KEY, id); else window.localStorage.removeItem(KEY); } catch { /* the device is still subscribed; only the "Este aparelho" label is lost */ } };

/** The worker's registration, once it is active (the page lives outside the worker's scope, so `serviceWorker.ready` would never resolve). */
async function activeRegistration(timeoutMs = 8000): Promise<ServiceWorkerRegistration> {
  const scope = `${getPluginBasePath()}/dashboard-plugins/luvebot/`;
  const reg = await navigator.serviceWorker.getRegistration(scope);
  if (!reg) throw new Error("sw_missing");
  if (reg.active) return reg;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("sw_timeout")), timeoutMs);
    const worker = reg.installing ?? reg.waiting;
    if (!worker) { window.clearTimeout(timer); reject(new Error("sw_missing")); return; }
    worker.addEventListener("statechange", () => { if (worker.state === "activated") { window.clearTimeout(timer); resolve(reg); } });
  });
}

const keyBytes = (base64Url: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(base64Url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(base64Url.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const sameBytes = (have: ArrayBuffer | null | undefined, want: Uint8Array): boolean => {
  if (!have) return false;
  const got = new Uint8Array(have);
  return got.length === want.length && got.every((v, i) => v === want[i]);
};
const base64Url = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Was this browser's subscription made with the server's CURRENT key? A subscription belongs to the key it was made with: after the server's key changes the push service refuses every send to it (403) for ever,
 *  and nothing looks wrong. `none`: not subscribed; `unknown`: the browser does not say which key it holds (older ones hide `options`) or could not be asked. */
export type KeyState = "match" | "mismatch" | "none" | "unknown";
export async function keyState(publicKey: string): Promise<KeyState> {
  try {
    const reg = await navigator.serviceWorker.getRegistration(`${getPluginBasePath()}/dashboard-plugins/luvebot/`);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return "none";
    const have = sub.options?.applicationServerKey;
    if (!have) return "unknown";
    return sameBytes(have, keyBytes(publicKey)) ? "match" : "mismatch";
  } catch { return "unknown"; }
}

/** Asks for the permission (call ONLY from a click: iOS refuses `subscribe` without a gesture, and nothing renews itself) and subscribes this browser to the server's VAPID key -> the endpoint to give the server and
 *  the key the subscription holds (base64url, for the server to compare). A subscription already there is reused ONLY when it is known to hold the current key: one made with another key is refused for ever by the
 *  push service, and one whose key the browser will not say cannot be vouched for, so both are dropped and made again. */
export async function enable(publicKey: string): Promise<{ endpoint: string; key: string } | "denied"> {
  const asked = await Notification.requestPermission();
  if (asked !== "granted") return "denied";
  const reg = await activeRegistration();
  const want = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options?.applicationServerKey, want)) { await sub.unsubscribe(); sub = null; }
  sub = sub ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want }));
  const held = sub.options?.applicationServerKey;
  return { endpoint: sub.endpoint, key: held ? base64Url(held) : base64Url(want.buffer) };
}

/** The key (base64url) this browser's subscription holds, when the browser says; else null. For the server's upsert when the person only changes the kinds. */
export async function currentKey(): Promise<string | null> {
  try {
    const reg = await navigator.serviceWorker.getRegistration(`${getPluginBasePath()}/dashboard-plugins/luvebot/`);
    const have = (await reg?.pushManager.getSubscription())?.options?.applicationServerKey;
    return have ? base64Url(have) : null;
  } catch { return null; }
}

/** The endpoint this browser is subscribed with now (the server's upsert key), or null when it is not subscribed. */
export async function currentEndpoint(): Promise<string | null> {
  try { const reg = await navigator.serviceWorker.getRegistration(`${getPluginBasePath()}/dashboard-plugins/luvebot/`); return (await reg?.pushManager.getSubscription())?.endpoint ?? null; } catch { return null; }
}

/** This browser stops listening (best effort) and forgets which device it was. */
export async function disable(): Promise<void> {
  try { const reg = await navigator.serviceWorker.getRegistration(`${getPluginBasePath()}/dashboard-plugins/luvebot/`); await (await reg?.pushManager.getSubscription())?.unsubscribe(); } catch { /* the server's row is what stops the notifications */ }
  remember(null);
}
export const rememberDevice = remember;
