// dashboard/src/pwa/push.ts
// What the phone shows when the push service wakes the worker (contract v0.8 §6). The push carries NOTHING: the worker asks LuveBot, behind the
// dashboard's gate, what happened, and shows only "<Bot> precisa de você" and the kind. Never the action, the command or any content: the lock screen is
// public. A push that shows nothing makes Safari revoke the subscription, so a notification is ALWAYS shown: if the read fails, takes too long or comes
// back empty or odd, the generic one. Tapping it opens the Approvals box, Costs or the Activity screen, chosen here from the kind (a server-supplied link is never opened).
// No imports and no DOM: this file is bundled into the worker (sw.js) and tested on its own.

export type PushTarget = "approvals" | "costs" | "activity";
export interface PushSpec { title: string; options: { body: string; tag: string; renotify: boolean; icon: string; data: { target: PushTarget } } }

/** The kinds a push can be about, and where tapping it goes. Anything else is shown as the generic line and opens the Approvals box. */
export const KIND_TARGET: Record<string, PushTarget> = { approval: "approvals", budget: "costs", question: "activity" };   // question: the Bot waits for a person outside the browser (contract v0.11 7.6)
export const LATEST_TIMEOUT_MS = 3000;
const BOT_MAX = 40;

// The worker cannot read the page's dictionary (it is big and the worker has no storage of the person's choice): it follows the phone's language.
const WORDS = {
  pt: { needs: "precisa de você", generic: "LuveBot: algo precisa de você", open: "Toque para abrir o LuveBot.", kinds: { approval: "Aprovação", budget: "Orçamento", question: "Pergunta" } },
  en: { needs: "needs you", generic: "LuveBot: something needs you", open: "Tap to open LuveBot.", kinds: { approval: "Approval", budget: "Budget", question: "Question" } },
} as const;
export type PushLang = keyof typeof WORDS;
export const pushLang = (language?: string | null): PushLang => (language && /^en/i.test(language) ? "en" : "pt");

/** `/dashboard-plugins/luvebot/sw.js` under any base path -> that base path ("" when the dashboard is at the root). */
export function basePathOf(swPathname: string): string {
  const at = swPathname.indexOf("/dashboard-plugins/luvebot/");
  return at > 0 ? swPathname.slice(0, at) : "";
}

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The text for one event, or the generic one when there is no event, no Bot name or no kind we know. Only the Bot's name and the kind ever reach it. */
export function specFor(event: unknown, lang: PushLang, iconUrl: string): PushSpec {
  const words = WORDS[lang];
  const e = event && typeof event === "object" ? (event as Record<string, unknown>) : null;
  const kind = e && typeof e.kind === "string" && Object.prototype.hasOwnProperty.call(KIND_TARGET, e.kind) ? (e.kind as keyof typeof words.kinds) : null;
  const bot = e ? clean(e.bot, BOT_MAX) : "";
  const target: PushTarget = kind ? KIND_TARGET[kind] : "approvals";
  const base = { tag: "luvebot", renotify: true, icon: iconUrl, data: { target } };
  if (!kind || !bot) return { title: words.generic, options: { ...base, body: words.open } };
  return { title: `${bot} ${words.needs}`, options: { ...base, body: words.kinds[kind] } };
}

/** GET /notifications/latest with the session cookie and a short timeout -> the newest event, or null on ANY failure (never throws). */
export async function newestEvent(fetchFn: typeof fetch, apiBase: string, timeoutMs = LATEST_TIMEOUT_MS): Promise<unknown> {
  const ac = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchFn(`${apiBase}/api/plugins/luvebot/notifications/latest`, { credentials: "same-origin", cache: "no-store", ...(ac ? { signal: ac.signal } : {}) });
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: unknown };
    return Array.isArray(body?.events) && body.events.length ? body.events[0] : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The whole push: ask, then ALWAYS show. Whatever goes wrong, the generic notification is shown instead of nothing. */
export async function showPush(
  registration: { showNotification: (title: string, options: PushSpec["options"]) => Promise<void> },
  fetchFn: typeof fetch, basePath: string, language?: string | null, timeoutMs = LATEST_TIMEOUT_MS,
): Promise<void> {
  const lang = pushLang(language);
  const icon = `${basePath}/dashboard-plugins/luvebot/icons/icon-192.png`;
  let spec: PushSpec;
  try { spec = specFor(await newestEvent(fetchFn, basePath, timeoutMs), lang, icon); } catch { spec = specFor(null, lang, icon); }
  try { await registration.showNotification(spec.title, spec.options); }
  catch { const generic = specFor(null, lang, icon); await registration.showNotification(generic.title, generic.options); }
}

/** Where a tap goes: LuveBot's own window, if one is open, is focused and told (the page moves); otherwise a new one opens at the home with the target. */
export async function openTarget(
  clients: { matchAll: (o: object) => Promise<Array<{ url: string; focus: () => Promise<unknown>; postMessage: (m: unknown) => void }>>; openWindow: (url: string) => Promise<unknown> },
  origin: string, basePath: string, data: unknown,
): Promise<void> {
  const raw = data && typeof data === "object" ? (data as { target?: unknown }).target : null;
  const target: PushTarget = raw === "costs" ? "costs" : raw === "activity" ? "activity" : "approvals";   // a whitelist: the notification's data is never used as an address
  const home = `${origin}${basePath}/`;
  // LuveBot's own window: the plugin's home page itself (the same origin and exactly `${basePath}/`, any query or hash), NOT any page of the dashboard under it:
  // with the dashboard at the root every window of the origin starts with `home` (/logs, /sessions…), and the first one may never listen for "luvebot.open" (red team N1)
  const isHome = (url: string) => { try { const u = new URL(url); return u.origin === origin && (u.pathname === `${basePath}/` || (basePath !== "" && u.pathname === basePath)); } catch { return false; } };
  const open = (await clients.matchAll({ type: "window", includeUncontrolled: true })).find((c) => isHome(c.url));
  if (open) { await open.focus(); open.postMessage({ type: "luvebot.open", target }); return; }
  await clients.openWindow(`${home}?luvebot=${target}`);
}
