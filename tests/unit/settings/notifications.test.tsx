// tests/unit/settings/notifications.test.tsx
// Contract v0.8 §6, the screen. Turning notifications on is the person's tap: the permission is asked from the "Ativar" button and nowhere else, and the
// server gets only {endpoint, kinds} (the browser's keys are not sent: the push carries no payload). A device's kinds change by sending its endpoint
// again (the server's upsert; there is no PATCH), a non-empty list; stopping everything is removing the device. iPhone needs the installed app, said in
// words. The server's refusals are said in words, never by code. A notification only opens a screen: it approves nothing.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { NotificationsCard } from "@/components/settings/Notifications";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";

vi.mock("@/components/costs", async (orig) => ({ ...(await orig<typeof import("@/components/costs")>()), CostsView: () => <div data-testid="costs-view" /> }));

type Dev = { id: number; host: string; kinds: string[]; created_at: number };
type Call = { method: string; url: string; body: any; csrf: string | null };
let devices: Dev[], calls: Call[], configFail: ApiError | null, postFail: ApiError | null, deleteFail: ApiError | null, nextId: number;
let configExtra: Record<string, unknown> = {}, testAnswer: () => unknown = () => ({ devices: [] }), testFail: ApiError | null = null;
const bare = (u: string) => u.replace("/api/plugins/luvebot", "");
const days = (n: number) => 1_800_000_000 + n * 86400;

function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (!url.includes("/notifications/")) return {};
    calls.push({ method, url: bare(url), body: init?.body ? JSON.parse(String(init.body)) : null, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/notifications/config")) { if (configFail) throw configFail; return { public_key: "AQID", enabled_kinds: ["approval", "budget"], ...configExtra }; }
    if (method === "GET") return { subscriptions: devices };
    if (method === "POST" && url.endsWith("/notifications/test")) { if (testFail) throw testFail; return testAnswer(); }
    if (method === "POST") {
      if (postFail) throw postFail;
      const body = JSON.parse(String(init!.body));
      const known = devices.find((d) => (d as any).endpoint === body.endpoint);
      if (known) { known.kinds = body.kinds; return { id: known.id, kinds: known.kinds }; }
      const d = { id: nextId++, host: new URL(body.endpoint).host, kinds: body.kinds ?? ["approval", "budget"], created_at: days(9), endpoint: body.endpoint } as any;
      devices.push(d);
      return { id: d.id, kinds: d.kinds };
    }
    if (method === "DELETE") {
      if (deleteFail) throw deleteFail;
      const id = Number(url.split("/").pop());
      devices = devices.filter((d) => d.id !== id);
      return { removed: 1 };
    }
    throw new Error("unexpected " + method + " " + url);
  });
}

// a browser that CAN do push: a registration with a pushManager, a Notification with a permission to ask
let permission: NotificationPermission, requestPermission: ReturnType<typeof vi.fn>, subscribe: ReturnType<typeof vi.fn>, unsubscribe: ReturnType<typeof vi.fn>, held: { endpoint: string; unsubscribe: any } | null;
function browser(ua?: string) {
  held = null;
  unsubscribe = vi.fn(async () => { held = null; return true; });
  subscribe = vi.fn(async () => { held = { endpoint: "https://web.push.apple.com/device-1", unsubscribe }; return held; });
  requestPermission = vi.fn(async () => { permission = "granted"; return permission; });
  const registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => held), subscribe } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: Object.assign(new EventTarget(), { getRegistration: vi.fn(async () => registration), startMessages: vi.fn() }) });
  vi.stubGlobal("PushManager", class {});
  permission = "default";
  const N: any = function () {};
  Object.defineProperty(N, "permission", { get: () => permission });   // a live getter: Object.assign would copy the value once
  N.requestPermission = requestPermission;
  vi.stubGlobal("Notification", N);
  if (ua) vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
}
const apple: Dev = { id: 3, host: "web.push.apple.com", kinds: ["approval", "budget"], created_at: days(1) };
const writes = () => calls.filter((c) => c.method !== "GET");
const open = async () => { render(<NotificationsCard />); await screen.findByRole("group", { name: "Avisar quando" }); };
const open2 = async () => { render(<NotificationsCard />); await screen.findByRole("group", { name: "Alert me when" }); };

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); devices = []; calls = []; configFail = postFail = deleteFail = null; configExtra = { subject: { ok: true, source: "public_url" } }; testFail = null; testAnswer = () => ({ devices: [] }); nextId = 20; permission = "default"; try { window.localStorage.clear(); } catch { /* */ } backend(); browser(); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (navigator as any).serviceWorker; });

describe("turning it on", () => {
  it("nothing is asked on opening; the permission is asked from the click, then the server gets {endpoint, kinds, application_server_key} with the CSRF (no other key of the browser), and this device shows as 'Este aparelho'", async () => {
    await open();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(screen.getByTestId("notifications-none").textContent).toBe("Nenhum aparelho recebe notificações ainda.");
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByText("Notificações ligadas neste aparelho.");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const applicationServerKey = subscribe.mock.calls[0][0].applicationServerKey as Uint8Array;
    expect(Array.from(applicationServerKey)).toEqual([1, 2, 3]);                         // the server's base64url key, decoded
    expect(subscribe.mock.calls[0][0].userVisibleOnly).toBe(true);
    expect(writes()).toEqual([{ method: "POST", url: "/notifications/subscriptions", body: { endpoint: "https://web.push.apple.com/device-1", kinds: ["approval", "budget"], application_server_key: "AQID" }, csrf: "csrf-1" }]);
    expect(Object.keys(writes()[0].body).sort()).toEqual(["application_server_key", "endpoint", "kinds"]);   // the key the subscription was made with (7.4); the browser's own p256dh and auth keys are not sent, no expirationTime
    expect(screen.getByTestId("notifications-this").textContent).toBe("Este aparelho");
    expect(screen.queryByTestId("notifications-enable")).toBeNull();
    expect(screen.getByTestId("notifications-device").textContent).toContain("Apple (iPhone, iPad ou Mac)");
  });

  it("the kinds chosen BEFORE are what is sent; with none chosen the button is off", async () => {
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot for pausado pelo teto de gasto (orçamento)" }));
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByText("Notificações ligadas neste aparelho.");
    expect(writes()[0].body.kinds).toEqual(["approval"]);
    cleanup(); devices = []; calls = []; window.localStorage.clear(); browser(); backend();
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot pedir aprovação" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot for pausado pelo teto de gasto (orçamento)" }));
    expect((screen.getByTestId("notifications-enable") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refused permission says so and sends nothing; a server that refuses (the 11th device, a push service it does not accept) is said in words, and the browser does not stay subscribed to nothing", async () => {
    requestPermission.mockImplementation(async () => { permission = "denied"; return permission; });
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    expect((await screen.findByRole("alert")).textContent).toContain("As notificações estão bloqueadas neste navegador.");
    expect(writes()).toHaveLength(0);
    cleanup(); browser(); backend();
    postFail = new ApiError({ code: "too_many_devices", message: "English from the server", status: 409 });
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    expect((await screen.findByRole("alert")).textContent).toContain("Já são 10 aparelhos. Remova um para ligar outro.");
    expect(screen.getByRole("alert").textContent).not.toContain("English from the server");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("luvebot.push.device")).toBeNull();
    expect(screen.getByTestId("notifications-enable")).toBeTruthy();                       // still off: can try again
    postFail = new ApiError({ code: "invalid_field", message: "This is not a supported push service.", status: 422 });
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Este navegador usa um serviço de notificações que o LuveBot não aceita."));
  });
});

describe("the browser cannot or must not yet", () => {
  it("no push in this browser: said, the button is off and nothing is asked", async () => {
    delete (navigator as any).serviceWorker;
    await open();
    expect(screen.getByTestId("notifications-support").textContent).toBe("Este navegador não recebe notificações.");
    expect((screen.getByTestId("notifications-enable") as HTMLButtonElement).disabled).toBe(true);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("an iPhone with LuveBot not on the Home Screen is told to install it; the text about it is always there", async () => {
    vi.restoreAllMocks(); browser("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
    await open();
    expect(screen.getByTestId("notifications-support").textContent).toContain("instale o LuveBot na Tela de Início");
    expect((screen.getByTestId("notifications-enable") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No iPhone e no iPad, funciona só com o LuveBot instalado na Tela de Início/)).toBeTruthy();
  });

  it("a blocked permission is said before the click", async () => {
    permission = "denied";
    await open();
    expect(screen.getByTestId("notifications-support").textContent).toContain("bloqueadas neste navegador");
    expect((screen.getByTestId("notifications-enable") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the devices", () => {
  it("lists them with the service's name, the date and the kinds; only the kinds the server can send are offered", async () => {
    devices = [apple, { id: 4, host: "fcm.googleapis.com", kinds: ["approval"], created_at: days(2) }, { id: 5, host: "x1.notify.windows.com", kinds: ["budget"], created_at: days(3) }, { id: 6, host: "updates.push.services.mozilla.com", kinds: ["approval"], created_at: days(4) }];
    await open();
    const rows = screen.getAllByTestId("notifications-device").map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Apple (iPhone, iPad ou Mac)");
    expect(rows[0]).toContain("um Bot pedir aprovação, um Bot for pausado pelo teto de gasto (orçamento)");
    expect(rows[1]).toContain("Chrome ou Android");
    expect(rows[2]).toContain("Windows (Edge)");
    expect(rows[3]).toContain("Firefox");
    expect(rows.join()).not.toContain("web.push.apple.com");                               // the service's address is never shown
    expect(screen.queryByTestId("notifications-this")).toBeNull();
  });

  it("a kind of THIS device changes by sending its endpoint again (the upsert, no PATCH); the last kind cannot be turned off, the way to stop is removing the device", async () => {
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByTestId("notifications-this");
    calls = [];
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot for pausado pelo teto de gasto (orçamento)" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/notifications/subscriptions", body: { endpoint: "https://web.push.apple.com/device-1", kinds: ["approval"] } });
    await waitFor(() => expect(screen.getByTestId("notifications-last-kind")).toBeTruthy());
    expect((screen.getByRole("checkbox", { name: "um Bot pedir aprovação" }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("notifications-last-kind").textContent).toContain("remova o aparelho");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot for pausado pelo teto de gasto (orçamento)" }));       // turning one back on is allowed
    await waitFor(() => expect(writes()[1].body.kinds).toEqual(["approval", "budget"]));
  });

  it("removing ANOTHER device is a DELETE of its id and leaves this browser listening", async () => {
    devices = [apple];
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByTestId("notifications-this");
    const other = screen.getAllByTestId("notifications-device").find((r) => !r.textContent?.includes("Este aparelho"))!;
    calls = [];
    fireEvent.click(within(other).getByRole("button", { name: /^Remover o aparelho/ }));
    await screen.findByText("Aparelho removido.");
    expect(writes()).toEqual([expect.objectContaining({ method: "DELETE", url: "/notifications/subscriptions/3", csrf: "csrf-1" })]);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(screen.getByTestId("notifications-this")).toBeTruthy();
    expect(screen.getAllByTestId("notifications-device")).toHaveLength(1);
  });

  it("removing THIS device: DELETE, the browser unsubscribes, the button to turn it on is back", async () => {
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    const me = await screen.findByTestId("notifications-this");
    const row = me.closest("[data-testid=notifications-device]") as HTMLElement;
    calls = [];
    fireEvent.click(within(row).getByRole("button", { name: /^Remover o aparelho/ }));
    await screen.findByText("Aparelho removido.");
    expect(writes()).toEqual([expect.objectContaining({ method: "DELETE", url: "/notifications/subscriptions/20", csrf: "csrf-1" })]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("notifications-enable")).toBeTruthy();
    expect(window.localStorage.getItem("luvebot.push.device")).toBeNull();
  });

  it("a device the push service already dropped (404 subscription_not_found) is simply gone from the list, no error", async () => {
    devices = [apple];
    await open();
    deleteFail = new ApiError({ code: "subscription_not_found", message: "x", status: 404 });
    fireEvent.click(screen.getByRole("button", { name: /^Remover o aparelho/ }));
    await screen.findByText("Aparelho removido.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("what this server and this Hermes can do", () => {
  it("a Hermes without the pieces (409 capability_missing) is said, with no button; an older LuveBot (404) is said differently", async () => {
    configFail = new ApiError({ code: "capability_missing", message: "x", status: 409 });
    render(<NotificationsCard />);
    expect((await screen.findByTestId("notifications-off")).textContent).toContain("Este Hermes ainda não consegue enviar notificações.");
    expect(screen.queryByTestId("notifications-enable")).toBeNull();
    cleanup(); configFail = new ApiError({ code: "not_found", message: "x", status: 404 });
    render(<NotificationsCard />);
    expect((await screen.findByTestId("notifications-off")).textContent).toContain("Esta versão do LuveBot ainda não envia notificações.");
  });

  it("an answer that is not the contract's (a server that answers {} for everything) is said calmly, and never takes Settings down with it", async () => {
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : {}));
    render(<NotificationsCard />);
    expect((await screen.findByTestId("notifications-off")).textContent).toContain("Esta versão do LuveBot ainda não envia notificações.");
    expect(screen.queryByTestId("notifications-enable")).toBeNull();
    expect(screen.queryAllByRole("status")).toHaveLength(0);                     // static text on every visit to Settings: not a live region (other cards' notes stay findable)
    cleanup();
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : url.endsWith("/notifications/config") ? { public_key: "AQID" } : { subscriptions: "x" }));
    render(<NotificationsCard />);
    expect((await screen.findByTestId("notifications-off")).textContent).toContain("Esta versão do LuveBot ainda não envia notificações.");
  });

  it("in English", async () => {
    setLuveLocale("en");
    devices = [apple];
    render(<NotificationsCard />);
    await screen.findByRole("group", { name: "Alert me when" });
    expect(screen.getByTestId("notifications-enable").textContent).toBe("Turn on notifications on this device");
    expect(screen.getByTestId("notifications-device").textContent).toContain("Apple (iPhone, iPad or Mac)");
  });
});

describe("tapping a notification", () => {
  function app() {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (/\/bots$/.test(url)) return { bots: [] };
      if (url.includes("/approvals")) return { approvals: [] };
      return {};
    });
  }
  const tell = (data: unknown) => act(async () => { (navigator.serviceWorker as unknown as EventTarget).dispatchEvent(new MessageEvent("message", { data })); });

  it("the worker's 'luvebot.open' moves the app to the Approvals box or to Costs; anything else is ignored", async () => {
    app(); render(<LuveBotApp />);
    await tell({ type: "luvebot.open", target: "approvals" });
    await screen.findByTestId("approvals-empty-state");
    await tell({ type: "luvebot.open", target: "costs" });
    await screen.findByTestId("costs-view");
    await tell({ type: "luvebot.open", target: "approve-everything" });
    await tell({ type: "other", target: "approvals" });
    expect(screen.getByTestId("costs-view")).toBeTruthy();                                   // neither moved it
    expect((navigator.serviceWorker as any).startMessages).toHaveBeenCalled();
  });

  it("a tap on a question goes to the Activity screen: by the worker's message and by /?luvebot=activity (N-4)", async () => {
    app(); render(<LuveBotApp />);
    await tell({ type: "luvebot.open", target: "activity" });
    await screen.findByTestId("activity-empty-state");
    cleanup();
    window.history.replaceState({}, "", "/?luvebot=activity&x=1");
    app(); render(<LuveBotApp />);
    await screen.findByTestId("activity-empty-state");
    expect(window.location.search).toBe("?x=1");
    window.history.replaceState({}, "", "/");
  });

  it("a window opened by the tap (/?luvebot=costs) goes to Costs and the address is cleaned", async () => {
    window.history.replaceState({}, "", "/?luvebot=costs&x=1");
    app(); render(<LuveBotApp />);
    await screen.findByTestId("costs-view");
    expect(window.location.search).toBe("?x=1");
    window.history.replaceState({}, "", "/?luvebot=nonsense");
    cleanup(); app(); render(<LuveBotApp />);
    await waitFor(() => expect(document.body.textContent).toBeTruthy());
    expect(screen.queryByTestId("costs-view")).toBeNull();
    window.history.replaceState({}, "", "/");
  });
});

// ---- the repair of notifications (contract v0.11 section 7): the CEO's phone received nothing ----
const KEY_OK = new Uint8Array([1, 2, 3]).buffer;       // the server's public key: AQID
const KEY_OLD = new Uint8Array([9, 9, 9]).buffer;      // the key the server had before
const NEW = "https://web.push.apple.com/new";
/** This browser is subscribed with `endpoint` (made with `options`; `undefined` = a browser that does not say its key) and the server has it as device 3, which this browser remembers. */
function hereWith(options: ArrayBuffer | null | undefined, extra: Record<string, unknown> = {}, endpoint = "https://web.push.apple.com/old") {
  held = { endpoint, unsubscribe, ...(options === undefined ? {} : { options: { applicationServerKey: options } }) } as any;
  devices = [{ ...apple, endpoint, ...extra } as any];
  window.localStorage.setItem("luvebot.push.device", "3");
}
/** The new subscription carries the key it was made with, as a real one does. */
const madeWithItsKey = () => subscribe.mockImplementation(async (o: any) => { held = { endpoint: NEW, unsubscribe, options: { applicationServerKey: (o.applicationServerKey as Uint8Array).buffer } } as any; return held as any; });
const renewBanner = () => screen.queryByTestId("notifications-renew");
const quiet = (ms = 120) => new Promise((r) => setTimeout(r, ms));

describe("the third switch: a Bot waits for you outside the browser (contract v0.11 7.6, N-4)", () => {
  const QUESTION = /um Bot esperar uma resposta sua fora do navegador/;
  it("is offered only when the server can send it; a NEW device gets all three kinds", async () => {
    await open();                                                                                 // enabled_kinds: approval and budget
    expect(screen.queryByRole("checkbox", { name: QUESTION })).toBeNull();
    cleanup(); configExtra = { enabled_kinds: ["approval", "budget", "question"] };
    await open();
    expect(screen.getByRole("checkbox", { name: QUESTION })).toBeTruthy();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByTestId("notifications-this");
    expect(writes()[0].body.kinds).toEqual(["approval", "budget", "question"]);
  });

  it("a device that was made before the kind is NOT given it silently; turning it on sends the endpoint again with the three", async () => {
    configExtra = { enabled_kinds: ["approval", "budget", "question"] };
    hereWith(KEY_OK, { stale: false });
    await open();
    const box = screen.getByRole("checkbox", { name: QUESTION }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(writes()).toHaveLength(0);
    fireEvent.click(box);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ method: "POST", url: "/notifications/subscriptions", body: { kinds: ["approval", "budget", "question"] } });
  });

  it("in English", async () => {
    setLuveLocale("en");
    configExtra = { enabled_kinds: ["approval", "budget", "question"] };
    await open2();
    expect(screen.getByRole("checkbox", { name: "a Bot waits for an answer from you outside the browser (a question, a password, an approval on another channel)" })).toBeTruthy();
  });
});

describe("the contact the push services need (7.1)", () => {
  it("a server with no accepted contact says so in words, naming what to set; nothing about it when the contact is set, or on a server that does not say", async () => {
    configExtra = { subject: { ok: false, source: null } };
    await open();
    expect(screen.getByTestId("notifications-subject").textContent).toBe("O LuveBot ainda não pode enviar notificações: falta um endereço de contato que os serviços de notificação aceitem. Configure o endereço público do painel (https://…) ou LUVEBOT_PUSH_SUBJECT.");
    cleanup(); configExtra = { subject: { ok: true, source: "public_url" } }; await open();
    expect(screen.queryByTestId("notifications-subject")).toBeNull();
    cleanup(); configExtra = {}; await open();
    expect(screen.queryByTestId("notifications-subject")).toBeNull();
  });

  it("a server that does not say `subject` (before this repair) is sent NO application_server_key: it would refuse the body and Ativar would break", async () => {
    configExtra = {};
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByText("Notificações ligadas neste aparelho.");
    expect(writes()[0].body).toEqual({ endpoint: "https://web.push.apple.com/device-1", kinds: ["approval", "budget"] });
  });
});

describe("the last send to each device (7.2): a refusal is never shown as 'on'", () => {
  it.each([
    ["bad_jwt", "o serviço não aceitou a identificação do envio (confira o contato do servidor)."],
    ["key_mismatch", "este aparelho foi ativado com outra chave. Use Renovar notificações."],
    ["expired", "o serviço esqueceu este aparelho. Remova-o e ative de novo."],
    ["too_large", "o envio era grande demais para o serviço."],
    ["rate_limited", "o serviço pediu para esperar. Tente de novo em alguns minutos."],
    ["timeout", "o serviço não respondeu a tempo. Tente de novo daqui a pouco."],
    ["other", "o serviço recusou o envio."],
    ["brand_new_reason", "o serviço recusou o envio."],
    [null, "o serviço recusou o envio."],
  ])("refused for %s", async (reason, words) => {
    hereWith(KEY_OK, { last: { at: days(2), ok: false, status: 403, reason }, stale: false });
    await open();
    const line = screen.getByTestId("notifications-last-refused");
    expect(line.textContent).toBe(`Última notificação recusada pelo serviço: ${words}`);
    expect(screen.queryByTestId("notifications-last-ok")).toBeNull();
  });

  it("an accepted last send says when; no send yet (null or absent) says nothing", async () => {
    hereWith(KEY_OK, { last: { at: days(3), ok: true, status: 201, reason: null } });
    await open();
    expect(screen.getByTestId("notifications-last-ok").textContent).toMatch(/^Último envio aceito pelo serviço em .+\.$/);
    expect(screen.queryByTestId("notifications-last-refused")).toBeNull();
    cleanup(); hereWith(KEY_OK, { last: null }); await open();
    expect(screen.queryByTestId("notifications-last-ok")).toBeNull();
    expect(screen.queryByTestId("notifications-last-refused")).toBeNull();
  });

  it("another device that is stale is said, with what to do (this browser's own gets the Renovar button)", async () => {
    hereWith(KEY_OK, { stale: false });
    devices.push({ id: 4, host: "fcm.googleapis.com", kinds: ["approval"], created_at: days(2), endpoint: "https://fcm.googleapis.com/x", stale: true } as any);
    await open();
    const rows = screen.getAllByTestId("notifications-device");
    expect(within(rows[1]).getByTestId("notifications-stale-other").textContent).toBe("Precisa ser renovado: abra o LuveBot nele e use Renovar notificações.");
    expect(within(rows[0]).queryByTestId("notifications-stale-other")).toBeNull();
    expect(renewBanner()).toBeNull();
  });
});

describe("Renovar notificações (7.4): a gesture, never silent", () => {
  it("a subscription made with another key: the line and the button appear, and NOTHING happens by itself (no permission asked, no unsubscribe, no subscribe, no write), even with the permission granted", async () => {
    hereWith(KEY_OLD); permission = "granted"; madeWithItsKey();
    await open();
    const banner = await screen.findByTestId("notifications-renew");
    expect(banner.textContent).toContain("Este aparelho foi ativado com uma chave que o servidor não usa mais, então as notificações não chegam.");
    await quiet();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it("a contact the person SET that the services would refuse says so in its own words (not 'there is none'); with none, or one from the public address, the other sentence (N-2c)", async () => {
    configExtra = { subject: { ok: false, source: "setting" } };
    await open();
    expect((await screen.findByTestId("notifications-subject")).textContent).toBe("O contato que você configurou (LUVEBOT_PUSH_SUBJECT) não é um que os serviços de notificação aceitam, então o LuveBot não envia nada. Use um endereço https:// ou mailto: com um domínio de verdade (sem localhost, .local nem .test).");
    for (const source of [null, "public_url"]) {
      cleanup(); configExtra = { subject: { ok: false, source } };
      await open();
      expect((await screen.findByTestId("notifications-subject")).textContent).toMatch(/^O LuveBot ainda não pode enviar notificações: falta um endereço de contato/);
    }
  });

  it("the test button's 409 needs_subject, with a contact the person set, says the same words (N-2c)", async () => {
    configExtra = { subject: { ok: false, source: "setting" } };
    hereWith(KEY_OK, { stale: false });
    await open();
    testFail = new ApiError({ code: "needs_subject", message: "English from the server", status: 409 });
    fireEvent.click(await screen.findByTestId("notifications-test"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O contato que você configurou (LUVEBOT_PUSH_SUBJECT) não é um que os serviços de notificação aceitam");
    expect(alert.textContent).not.toContain("English from the server");
  });

  it("the click renews: unsubscribe, subscribe with the CURRENT key, the old row removed FIRST, then the new endpoint with this device's kinds and the key it holds", async () => {
    hereWith(KEY_OLD, { kinds: ["approval"] }); permission = "granted"; madeWithItsKey();
    await open();
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await screen.findByText("Notificações renovadas neste aparelho, com a chave atual do servidor.");
    expect(requestPermission).toHaveBeenCalledTimes(1);                                       // asked from the click
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(Array.from(subscribe.mock.calls[0][0].applicationServerKey as Uint8Array)).toEqual([1, 2, 3]);
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual(["DELETE /notifications/subscriptions/3", "POST /notifications/subscriptions"]);   // F-N6-6: the new row is never the one over the limit
    expect(writes()[1].body).toEqual({ endpoint: NEW, kinds: ["approval"], application_server_key: "AQID" });
    expect(writes()[1].csrf).toBe("csrf-1");
    expect(window.localStorage.getItem("luvebot.push.device")).toBe(String(nextId - 1));
    expect(renewBanner()).toBeNull();
    expect(screen.getAllByTestId("notifications-device")).toHaveLength(1);
  });

  it("the server calls this device stale (stored with no key id, or another one) while the browser holds the current key: the button is there too", async () => {
    hereWith(KEY_OK, { stale: true }); permission = "granted";
    await open();
    expect(await screen.findByTestId("notifications-renew")).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });

  it("a browser that cannot say its key is not guessed at (no banner) unless the server says stale; renewing then drops the subscription anyway, since it cannot be vouched for", async () => {
    hereWith(undefined, { stale: false }); permission = "granted";
    await open();
    await quiet();
    expect(renewBanner()).toBeNull();
    cleanup(); hereWith(undefined, { stale: true }); madeWithItsKey(); unsubscribe.mockClear(); subscribe.mockClear();
    await open();
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await screen.findByText("Notificações renovadas neste aparelho, com a chave atual do servidor.");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("the current key and not stale: no banner, no write", async () => {
    hereWith(KEY_OK, { stale: false }); permission = "granted";
    await open();
    await quiet();
    expect(renewBanner()).toBeNull();
    expect(writes()).toHaveLength(0);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("the browser lost its subscription while the server still lists the device: the button is there", async () => {
    hereWith(KEY_OK, { stale: false }); held = null; permission = "granted";
    await open();
    expect(await screen.findByTestId("notifications-renew")).toBeTruthy();
  });

  it("a refused permission says so and writes nothing; a server that answers 409 key_mismatch after the old row went says it in words AND says what is left", async () => {
    hereWith(KEY_OLD); requestPermission.mockImplementation(async () => { permission = "denied"; return permission; });
    await open();
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /As notificações estão bloqueadas neste navegador\./.test(a.textContent ?? ""))).toBe(true));
    expect(writes()).toHaveLength(0);
    cleanup(); browser(); backend(); hereWith(KEY_OLD); madeWithItsKey();
    postFail = new ApiError({ code: "key_mismatch", message: "English from the server", status: 409 });
    await open();
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /A inscrição antiga foi removida, mas o servidor não aceitou a nova: este aparelho ficou sem notificações\. Ative-as de novo\. A chave desta inscrição não é a atual do servidor/.test(a.textContent ?? ""))).toBe(true));
    expect(screen.getAllByRole("alert").every((a) => !/English from the server/.test(a.textContent ?? ""))).toBe(true);
    expect(writes().map((w) => w.method)).toEqual(["DELETE", "POST"]);                          // the old row went first, then the new one was refused
    expect(unsubscribe).toHaveBeenCalledTimes(2);                                               // the old subscription, then the new one: this browser does not stay subscribed to nothing
    expect(window.localStorage.getItem("luvebot.push.device")).toBeNull();
    expect(await screen.findByTestId("notifications-enable")).toBeTruthy();                      // and Ativar is back
  });

  it("when taking the old row away FAILS too, the sentence does not claim it was removed", async () => {
    hereWith(KEY_OLD); madeWithItsKey();
    deleteFail = new ApiError({ code: "hermes_unreachable", message: "x", status: 502 });
    postFail = new ApiError({ code: "key_mismatch", message: "English from the server", status: 409 });
    await open();
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /A chave desta inscrição não é a atual do servidor/.test(a.textContent ?? ""))).toBe(true));
    expect(screen.getAllByRole("alert").every((a) => !/foi removida/.test(a.textContent ?? ""))).toBe(true);
    await screen.findByTestId("notifications-enable");                                          // the screen settles (the list is read again) before the test ends
  });

  it("Ativar reuses nothing that is not KNOWN to hold the current key: a stale subscription, or one the browser will not name, is dropped before the new one is made", async () => {
    held = { endpoint: "https://web.push.apple.com/old", unsubscribe, options: { applicationServerKey: KEY_OLD } } as any;
    madeWithItsKey();
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByText("Notificações ligadas neste aparelho.");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(writes()[0].body).toEqual({ endpoint: NEW, kinds: ["approval", "budget"], application_server_key: "AQID" });
    cleanup(); browser(); backend(); window.localStorage.clear();
    held = { endpoint: "https://web.push.apple.com/unnamed", unsubscribe } as any;
    madeWithItsKey();
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByText("Notificações ligadas neste aparelho.");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a subscription that DOES hold the current key is reused (nothing dropped, nothing made again)", async () => {
    held = { endpoint: "https://web.push.apple.com/same", unsubscribe, options: { applicationServerKey: KEY_OK } } as any;
    await open();
    fireEvent.click(screen.getByTestId("notifications-enable"));
    await screen.findByText("Notificações ligadas neste aparelho.");
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(writes()[0].body).toEqual({ endpoint: "https://web.push.apple.com/same", kinds: ["approval", "budget"], application_server_key: "AQID" });
  });

  it("changing the kinds of a device sends the key too when the browser says it, and leaves it out when it does not (a kinds change is not a renewal)", async () => {
    hereWith(KEY_OK, { stale: false }); permission = "granted";
    await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot for pausado pelo teto de gasto (orçamento)" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ endpoint: "https://web.push.apple.com/old", kinds: ["approval"], application_server_key: "AQID" });
    cleanup(); calls = []; hereWith(undefined, { stale: false }); await open();
    fireEvent.click(screen.getByRole("checkbox", { name: "um Bot for pausado pelo teto de gasto (orçamento)" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ endpoint: "https://web.push.apple.com/old", kinds: ["approval"] });
  });
});

describe("Enviar teste (7.3): the answer per device, in words", () => {
  const sendTest = async () => { fireEvent.click(await screen.findByTestId("notifications-test")); return screen.findByTestId("notifications-test-results"); };

  it("no device, no button; with a device the sentence says BEFORE sending how the test arrives (the generic text, the proof)", async () => {
    await open();
    expect(screen.queryByTestId("notifications-test")).toBeNull();
    cleanup(); hereWith(KEY_OK); await open();
    expect(screen.getByTestId("notifications-test-note").textContent).toBe("O teste chega como o texto genérico “LuveBot: algo precisa de você”: é o sinal de que as notificações funcionam neste aparelho.");
    expect(calls.filter((c) => c.url === "/notifications/test")).toHaveLength(0);
  });

  it("the click sends ONE request with the exact body {} and the CSRF, and says what each device got, by name", async () => {
    hereWith(KEY_OK, { stale: false });
    devices.push({ id: 4, host: "fcm.googleapis.com", kinds: ["approval"], created_at: days(2), endpoint: "https://fcm.googleapis.com/x", stale: false } as any);
    testAnswer = () => ({ devices: [{ id: 3, host: "web.push.apple.com", ok: true, status: 201, reason: null }, { id: 4, host: "fcm.googleapis.com", ok: false, status: 410, reason: "expired" }] });
    await open();
    const list = await sendTest();
    const posts = calls.filter((c) => c.url === "/notifications/test");
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe("POST");
    expect(posts[0].body).toEqual({});                                                      // exactly {}: nothing else is asked of the route
    expect(posts[0].csrf).toBe("csrf-1");
    expect(within(list).getAllByTestId("notifications-test-row").map((r) => r.textContent)).toEqual([
      "Apple (iPhone, iPad ou Mac) (Este aparelho): o serviço aceitou o envio. Ele deve chegar como “LuveBot: algo precisa de você” (isso não garante que o aparelho o mostre).",
      "Chrome ou Android: o serviço esqueceu este aparelho. Remova-o e ative de novo.",
    ]);
  });

  it.each([
    ["bad_jwt", "o serviço não aceitou a identificação do envio (confira o contato do servidor)."],
    ["key_mismatch", "este aparelho foi ativado com outra chave. Use Renovar notificações."],
    ["timeout", "o serviço não respondeu a tempo. Tente de novo daqui a pouco."],
    ["something_new", "o serviço recusou o envio."],
  ])("a refusal for %s is said in words, never in the service's own", async (reason, words) => {
    hereWith(KEY_OK, { stale: false });
    testAnswer = () => ({ devices: [{ id: 3, host: "web.push.apple.com", ok: false, status: 403, reason, detail: "https://web.push.apple.com/secret-endpoint English from the service" }] });
    await open();
    const row = (await sendTest()).querySelector("li")!;
    expect(row.textContent).toContain(words);
    expect(row.textContent).not.toContain("secret-endpoint");
    expect(row.textContent).not.toContain("English from the service");
    expect(row.getAttribute("data-ok")).toBe("false");
  });

  it("a refusal for THIS device because of its key shows the Renovar button, and the click renews it", async () => {
    hereWith(undefined, { stale: false }); permission = "granted"; madeWithItsKey();       // a browser that cannot tell its key: only the service's refusal says it
    testAnswer = () => ({ devices: [{ id: 3, host: "web.push.apple.com", ok: false, status: 403, reason: "key_mismatch" }] });
    await open();
    expect(renewBanner()).toBeNull();
    await sendTest();
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await screen.findByText("Notificações renovadas neste aparelho, com a chave atual do servidor.");
    expect(screen.queryByTestId("notifications-test-results")).toBeNull();                 // the old result is not left over a renewed device
  });

  it("no device in the answer says so; the rate limit (429) says to wait; any other refusal says its general words", async () => {
    hereWith(KEY_OK, { stale: false });
    await open();
    fireEvent.click(await screen.findByTestId("notifications-test"));
    expect((await screen.findByTestId("notifications-test-none")).textContent).toBe("Nenhum aparelho para testar. Ative as notificações em um aparelho primeiro.");
    testFail = new ApiError({ code: "rate_limited", message: "English from the server", status: 429 });
    fireEvent.click(screen.getByTestId("notifications-test"));
    expect((await screen.findByRole("alert")).textContent).toContain("Espere uns 10 segundos entre um teste e outro.");
    testFail = new ApiError({ code: "capability_missing", message: "English from the server", status: 409 });
    fireEvent.click(screen.getByTestId("notifications-test"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).not.toContain("Espere uns 10 segundos"));
    expect(screen.getByRole("alert").textContent).not.toContain("English from the server");
  });

  it("a test answered with 409 needs_subject says the contact words the card already has, not the general error (N-2b)", async () => {
    hereWith(KEY_OK, { stale: false });
    await open();
    testFail = new ApiError({ code: "needs_subject", message: "English from the server", status: 409 });
    fireEvent.click(await screen.findByTestId("notifications-test"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O LuveBot ainda não pode enviar notificações: falta um endereço de contato");
    expect(alert.textContent).not.toContain("English from the server");
  });

  it("while it runs the button is off (one test at a time)", async () => {
    hereWith(KEY_OK, { stale: false });
    let release!: () => void;
    testAnswer = () => new Promise((res) => { release = () => res({ devices: [] }); }) as any;
    await open();
    fireEvent.click(await screen.findByTestId("notifications-test"));
    await waitFor(() => expect((screen.getByTestId("notifications-test") as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("notifications-test").textContent).toBe("Enviando o teste…");
    release();
    await waitFor(() => expect((screen.getByTestId("notifications-test") as HTMLButtonElement).disabled).toBe(false));
    expect(calls.filter((c) => c.url === "/notifications/test")).toHaveLength(1);
  });
});

describe("in English", () => {
  it("the new lines speak English", async () => {
    setLuveLocale("en");
    configExtra = { subject: { ok: false, source: null } };
    hereWith(KEY_OLD, { last: { at: days(2), ok: false, status: 403, reason: "bad_jwt" } });
    render(<NotificationsCard />);
    await screen.findByTestId("notifications-test");
    expect(screen.getByTestId("notifications-subject").textContent).toContain("LuveBot cannot send notifications yet");
    expect(screen.getByTestId("notifications-last-refused").textContent).toBe("Last notification refused by the service: the service did not accept the send's identification (check the server's contact).");
    expect(within(screen.getByTestId("notifications-renew")).getByRole("button", { name: "Renew notifications" })).toBeTruthy();
    expect(screen.getByTestId("notifications-test").textContent).toBe("Send a test");
    expect(screen.getByTestId("notifications-test-note").textContent).toBe("The test arrives as the generic text “LuveBot: something needs you”: that is how you know notifications work on this device.");
  });
});
