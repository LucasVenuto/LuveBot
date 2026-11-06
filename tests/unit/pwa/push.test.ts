// tests/unit/pwa/push.test.ts
// Contract v0.8 §6, the worker's side. The push carries nothing: the worker asks GET /notifications/latest and shows "<Bot> precisa de você" + the kind,
// NEVER any content (the lock screen is public). Apple revokes a subscription whose push shows nothing, so a notification is ALWAYS shown, inside
// event.waitUntil, even when the read fails, hangs, comes back empty or odd. A tap opens the Approvals box or Costs (decided here from the kind).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { specFor, newestEvent, showPush, openTarget, basePathOf, pushLang, LATEST_TIMEOUT_MS } from "@/pwa/push";
import "@/pwa/service-worker";

const ICON = "/dashboard-plugins/luvebot/icons/icon-192.png";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reg = () => ({ showNotification: vi.fn(async (_title: string, _options?: unknown) => undefined) });

describe("what the phone shows", () => {
  it("an approval: '<Bot> precisa de você' and the kind, nothing else; a budget: the same with 'Orçamento'", () => {
    const a = specFor({ kind: "approval", bot: "Vendas", at: 1, link: "/approvals" }, "pt", ICON);
    expect(a.title).toBe("Vendas precisa de você");
    expect(a.options.body).toBe("Aprovação");
    expect(a.options.data).toEqual({ target: "approvals" });
    const b = specFor({ kind: "budget", bot: "Dev", at: 1, link: "/costs" }, "pt", ICON);
    expect(b.title).toBe("Dev precisa de você");
    expect(b.options.body).toBe("Orçamento");
    expect(b.options.data).toEqual({ target: "costs" });
    const en = specFor({ kind: "approval", bot: "Sales" }, "en", ICON);
    expect([en.title, en.options.body]).toEqual(["Sales needs you", "Approval"]);
  });

  it("a question (the Bot waits for you outside the browser): '<Bot> precisa de você' and 'Pergunta', and tapping it goes to the Activity screen; nothing of what the Bot asked reaches the lock screen (N-4)", () => {
    const q = specFor({ kind: "question", bot: "Vendas", at: 1, link: "/activity", prompt: "Qual a senha do banco?", text: "segredo" }, "pt", ICON);
    expect([q.title, q.options.body]).toEqual(["Vendas precisa de você", "Pergunta"]);
    expect(q.options.data).toEqual({ target: "activity" });
    expect(JSON.stringify(q)).not.toMatch(/senha|segredo|banco/);
    const en = specFor({ kind: "question", bot: "Sales" }, "en", ICON);
    expect([en.title, en.options.body, en.options.data]).toEqual(["Sales needs you", "Question", { target: "activity" }]);
  });

  it("never carries anything else the event had: no action, command, text or link reaches the notification", () => {
    const spec = specFor({ kind: "approval", bot: "Vendas", at: 1, link: "https://evil.example/x", command: "rm -rf /", text: "apagar tudo", action: "terminal" }, "pt", ICON);
    const shown = JSON.stringify(spec);
    for (const leak of ["rm -rf", "apagar tudo", "terminal", "evil.example", "https://"]) expect(shown).not.toContain(leak);
    expect(Object.keys(spec.options).sort()).toEqual(["body", "data", "icon", "renotify", "tag"]);
  });

  it("a Bot name is cleaned (control and direction characters out, 40 characters at most); no name, no kind or an unknown kind is the generic line", () => {
    const wild = specFor({ kind: "approval", bot: "Ven\u202edas\n\n" + "x".repeat(100) }, "pt", ICON);
    expect(wild.title.startsWith("Ven das x")).toBe(true);
    expect(wild.title).not.toMatch(/[\u202e\n]/);
    expect(wild.title.length).toBeLessThanOrEqual(40 + " precisa de você".length);
    for (const odd of [null, undefined, "texto", 7, {}, { kind: "approval" }, { bot: "Vendas" }, { kind: "approvals", bot: "Vendas" }, { kind: "__proto__", bot: "Vendas" }, { kind: "constructor", bot: "Vendas" }]) {
      const s = specFor(odd, "pt", ICON);
      expect(s.title).toBe("LuveBot: algo precisa de você");
      expect(s.options.data).toEqual({ target: "approvals" });
    }
    expect(specFor(null, "en", ICON).title).toBe("LuveBot: something needs you");
  });

  it("the language is the phone's: English only when it says so", () => {
    expect([pushLang("en-US"), pushLang("pt-BR"), pushLang("fr"), pushLang(undefined)]).toEqual(["en", "pt", "pt", "pt"]);
  });

  it("the plugin's base path comes from the worker's own address", () => {
    expect([basePathOf("/dashboard-plugins/luvebot/sw.js"), basePathOf("/hermes/dashboard-plugins/luvebot/sw.js"), basePathOf("/x")]).toEqual(["", "/hermes", ""]);
  });
});

describe("asking LuveBot what happened", () => {
  it("GET /notifications/latest with the session cookie, no cache; the FIRST event is the one shown", async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => json({ events: [{ kind: "approval", bot: "Novo" }, { kind: "budget", bot: "Velho" }] }));
    expect(await newestEvent(f as any, "/hermes")).toEqual({ kind: "approval", bot: "Novo" });
    expect(f.mock.calls[0][0]).toBe("/hermes/api/plugins/luvebot/notifications/latest");
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });

  it("every failure is null, never a throw: 401, 500, a network error, a body that is not JSON, no events, events that are not a list", async () => {
    const cases: Array<() => Promise<Response>> = [async () => json({}, 401), async () => json({}, 500), async () => { throw new TypeError("offline"); },
      async () => new Response("<html>", { status: 200 }), async () => json({ events: [] }), async () => json({ events: "x" }), async () => json(null)];
    for (const c of cases) expect(await newestEvent(vi.fn(c) as any, "")).toBeNull();
  });

  it("a read that never answers is given up on after the short timeout (3 s by default), not waited for", async () => {
    expect(LATEST_TIMEOUT_MS).toBeLessThanOrEqual(3000);
    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const t0 = Date.now();
    expect(await newestEvent(hang as any, "", 30)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("a notification is ALWAYS shown (Apple revokes a push that shows nothing)", () => {
  it("with an event: its text; the read failing, hanging, empty or odd: the generic text; showNotification refusing the first: the generic one is tried", async () => {
    const ok = reg();
    await showPush(ok, vi.fn(async () => json({ events: [{ kind: "budget", bot: "Dev" }] })) as any, "", "pt-BR");
    expect(ok.showNotification).toHaveBeenCalledTimes(1);
    expect(ok.showNotification.mock.calls[0][0]).toBe("Dev precisa de você");
    for (const bad of [async () => json({}, 401), async () => { throw new Error("down"); }, async () => json({ events: [] }), async () => json({ events: [{ kind: "x" }] })]) {
      const r = reg();
      await showPush(r, vi.fn(bad) as any, "", "pt-BR");
      expect(r.showNotification).toHaveBeenCalledTimes(1);
      expect(r.showNotification.mock.calls[0][0]).toBe("LuveBot: algo precisa de você");
    }
    const hang = reg();
    await showPush(hang, vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_a, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as any, "", "en", 20);
    expect(hang.showNotification.mock.calls[0][0]).toBe("LuveBot: something needs you");
    const refuses = { showNotification: vi.fn(async (_title: string, _options?: unknown): Promise<void> => undefined).mockRejectedValueOnce(new Error("icon unreadable")) };
    await showPush(refuses, vi.fn(async () => json({ events: [{ kind: "approval", bot: "Vendas" }] })) as any, "", "pt");
    expect(refuses.showNotification).toHaveBeenCalledTimes(2);
    expect(refuses.showNotification.mock.calls[1][0]).toBe("LuveBot: algo precisa de você");
  });
});

describe("the worker's listeners", () => {
  beforeEach(() => { delete (self as any).registration; });

  it("'push' hands showNotification to event.waitUntil (the browser keeps the worker alive until it shows), even when the read fails", async () => {
    const r = reg();
    (self as any).registration = r;
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 401)));
    const waited: Promise<unknown>[] = [];
    const event = Object.assign(new Event("push"), { waitUntil: (p: Promise<unknown>) => { waited.push(p); } });
    self.dispatchEvent(event);
    expect(waited).toHaveLength(1);                                         // inside waitUntil, in the same turn of the event loop
    await Promise.all(waited);
    expect(r.showNotification).toHaveBeenCalledTimes(1);
    expect(r.showNotification.mock.calls[0][0]).toBe("LuveBot: algo precisa de você");
    vi.unstubAllGlobals();
  });

  it("a tap closes the notification and opens the right screen: an open window is focused and told; none open means a new one at /?luvebot=<where>; data is a whitelist, never an address", async () => {
    const focus = vi.fn(async () => undefined), post = vi.fn();
    const win = { url: "https://painel.example/", focus, postMessage: post };
    const clients = { matchAll: vi.fn(async () => [{ url: "https://other.example/", focus: vi.fn(), postMessage: vi.fn() }, win]), openWindow: vi.fn(async () => undefined) };
    await openTarget(clients as any, "https://painel.example", "", { target: "costs" });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ type: "luvebot.open", target: "costs" });
    expect(clients.openWindow).not.toHaveBeenCalled();
    const none = { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => undefined) };
    await openTarget(none as any, "https://painel.example", "/hermes", { target: "activity" });                      // N-4: the question's target is honoured, in a new window...
    expect(none.openWindow).toHaveBeenCalledWith("https://painel.example/hermes/?luvebot=activity");
    await openTarget(clients as any, "https://painel.example", "", { target: "activity" });                         // ...and in the open one
    expect(post).toHaveBeenCalledWith({ type: "luvebot.open", target: "activity" });
    await openTarget(none as any, "https://painel.example", "/hermes", { target: "approvals" });
    expect(none.openWindow).toHaveBeenCalledWith("https://painel.example/hermes/?luvebot=approvals");
    const sneaky = { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => undefined) };
    await openTarget(sneaky as any, "https://painel.example", "", { target: "https://evil.example/", url: "https://evil.example/" });
    expect(sneaky.openWindow).toHaveBeenCalledWith("https://painel.example/?luvebot=approvals");
    await openTarget(sneaky as any, "https://painel.example", "", undefined);
    expect(sneaky.openWindow).toHaveBeenLastCalledWith("https://painel.example/?luvebot=approvals");
  });

  it("only LuveBot's OWN window takes the tap: another page of the dashboard (/logs), another origin, or a lookalike path is not it; with none, a new window opens (red team N1)", async () => {
    const win = (url: string) => ({ url, focus: vi.fn(async () => undefined), postMessage: vi.fn() });
    const withWindows = (list: ReturnType<typeof win>[]) => ({ matchAll: vi.fn(async () => list), openWindow: vi.fn(async () => undefined) });
    const logs = win("https://h.example/logs"), sessions = win("https://h.example/sessions?x=1"), other = win("https://evil.example/"), luve = win("https://h.example/?luvebot=costs#top");
    const c = withWindows([logs, sessions, other, luve]);
    await openTarget(c as any, "https://h.example", "", { target: "approvals" });
    expect(luve.focus).toHaveBeenCalledTimes(1);                                  // its query and hash do not matter
    expect(luve.postMessage).toHaveBeenCalledWith({ type: "luvebot.open", target: "approvals" });
    for (const not of [logs, sessions, other]) { expect(not.focus).not.toHaveBeenCalled(); expect(not.postMessage).not.toHaveBeenCalled(); }
    expect(c.openWindow).not.toHaveBeenCalled();
    const onlyOthers = withWindows([logs, sessions, other]);                      // no LuveBot window at all: a new one opens at the home with the target
    await openTarget(onlyOthers as any, "https://h.example", "", { target: "costs" });
    expect(onlyOthers.openWindow).toHaveBeenCalledWith("https://h.example/?luvebot=costs");
    expect([logs, sessions, other].every((w) => w.focus.mock.calls.length === 0)).toBe(true);
    const subList = [win("https://h.example/hermes/logs"), win("https://h.example/hermes-other/"), win("https://h.example/hermes/")], sub = withWindows(subList);
    await openTarget(sub as any, "https://h.example", "/hermes", { target: "approvals" });   // under a base path: /hermes/ only
    expect(subList.map((w) => w.focus.mock.calls.length)).toEqual([0, 0, 1]);
  });

  it("'notificationclick' closes the notification before anything else and waits for the opening", async () => {
    const close = vi.fn();
    const none = { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => undefined) };
    (self as any).clients = none;
    const waited: Promise<unknown>[] = [];
    const event = Object.assign(new Event("notificationclick"), { notification: { close, data: { target: "costs" } }, waitUntil: (p: Promise<unknown>) => { waited.push(p); } });
    self.dispatchEvent(event);
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.all(waited);
    expect(none.openWindow).toHaveBeenCalledWith(expect.stringMatching(/\/\?luvebot=costs$/));
    self.dispatchEvent(Object.assign(new Event("notificationclick"), { notification: { close, data: { target: "activity" } }, waitUntil: (p: Promise<unknown>) => { waited.push(p); } }));   // N-4: a question's tap
    await Promise.all(waited);
    expect(none.openWindow).toHaveBeenLastCalledWith(expect.stringMatching(/\/\?luvebot=activity$/));
    delete (self as any).clients;
  });
});
