// tests/unit/settings/notifications-redteam-n6.test.tsx
// Red team (Lume, 31/10) of the screen of N-2 (d8de65e) against contract v0.11 7.4: "a renewal removes the row it replaces, so it never leaves a zombie that counts against the
// 10 per person". The server counts the person's OTHER devices when it sees a new endpoint (`too_many_devices` at 10), and `renew()` sends the NEW endpoint first and takes the old
// row away after: a person who is AT 10 devices, this one included, can never renew. The refusal comes after the browser has already dropped its old subscription and made a new
// one, so the device is left half renewed (the browser holds the current key, the server still lists the stale row, and the answer is an error about a limit the renewal would not
// have crossed). The old endpoint is dead the moment `enable()` unsubscribes it, so taking its row away FIRST loses nothing.
//
// F-N6-6 (Baixa, fixed in N-2c): `renew()` removes the old row before it adds the new one, so the case below, once `it.fails`, is a plain test. What holds is in notifications.test.tsx (the Vitral) and was read, not repeated.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { NotificationsCard } from "@/components/settings/Notifications";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const LIMIT = 10;
const OLD = "https://web.push.apple.com/old";
const NEW = "https://web.push.apple.com/new";
const KEY_OLD = new Uint8Array([9, 9, 9]).buffer;
type Dev = { id: number; host: string; kinds: string[]; created_at: number; endpoint: string; stale?: boolean };
let devices: Dev[], calls: Array<{ method: string; url: string }>, held: { endpoint: string; unsubscribe: unknown; options?: { applicationServerKey: ArrayBuffer } } | null;
let nextId: number;

function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (!url.includes("/notifications/")) return {};
    calls.push({ method, url: url.replace("/api/plugins/luvebot", "") });
    if (url.endsWith("/notifications/config")) return { public_key: "AQID", enabled_kinds: ["approval", "budget"], subject: { ok: true, source: "public_url" } };
    if (method === "GET") return { subscriptions: devices.map(({ endpoint: _endpoint, ...shown }) => shown) };
    if (method === "POST") {
      const body = JSON.parse(String(init!.body));
      const known = devices.find((d) => d.endpoint === body.endpoint);
      if (known) { known.kinds = body.kinds; return { id: known.id, kinds: known.kinds }; }
      // the server's rule (backend/push.py `subscribe`): the person's OTHER devices, the one being sent excluded
      if (devices.filter((d) => d.endpoint !== body.endpoint).length >= LIMIT) throw new ApiError({ code: "too_many_devices", message: "At most 10 devices per person receive notifications.", status: 409 });
      const d: Dev = { id: nextId++, host: new URL(body.endpoint).host, kinds: body.kinds, created_at: 1_800_000_000, endpoint: body.endpoint };
      devices.push(d);
      return { id: d.id, kinds: d.kinds };
    }
    if (method === "DELETE") {
      devices = devices.filter((d) => d.id !== Number(url.split("/").pop()));
      return { removed: 1 };
    }
    throw new Error("unexpected " + method + " " + url);
  });
}

function browser() {
  const unsubscribe = vi.fn(async () => { held = null; return true; });
  const subscribe = vi.fn(async (o: { applicationServerKey: Uint8Array }) => { held = { endpoint: NEW, unsubscribe, options: { applicationServerKey: o.applicationServerKey.buffer as ArrayBuffer } }; return held; });
  held = { endpoint: OLD, unsubscribe, options: { applicationServerKey: KEY_OLD } };
  const registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => held), subscribe } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: Object.assign(new EventTarget(), { getRegistration: vi.fn(async () => registration), startMessages: vi.fn() }) });
  vi.stubGlobal("PushManager", class {});
  const N: any = function () {};
  Object.defineProperty(N, "permission", { get: () => "granted" });
  N.requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", N);
  return { unsubscribe, subscribe };
}

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); calls = []; nextId = 100; window.localStorage.clear(); backend(); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (navigator as any).serviceWorker; });

describe("Renovar notificações at the limit of 10 devices (7.4 iii)", () => {
  it("control: with room (2 devices) the same scene renews, so the harness is faithful and only the limit decides", async () => {
    const { unsubscribe } = browser();
    devices = [{ id: 1, host: "fcm.googleapis.com", kinds: ["approval"], created_at: 1_800_000_000, endpoint: "https://fcm.googleapis.com/fcm/send/d0" },
               { id: 50, host: "web.push.apple.com", kinds: ["approval", "budget"], created_at: 1_800_000_000, endpoint: OLD, stale: true }];
    window.localStorage.setItem("luvebot.push.device", "50");
    render(<NotificationsCard />);
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await screen.findByText("Notificações renovadas neste aparelho, com a chave atual do servidor.", {}, { timeout: 1500 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(devices.map((d) => d.endpoint).sort()).toEqual([NEW, "https://fcm.googleapis.com/fcm/send/d0"].sort());
    expect(screen.queryByTestId("notifications-renew")).toBeNull();
  });

  it("a person at 10 devices, this browser's stale one included, can still renew: the old row goes first, so the new one is never the 11th (F-N6-6)", async () => {
    const { unsubscribe } = browser();
    devices = Array.from({ length: LIMIT - 1 }, (_v, i): Dev => ({ id: i + 1, host: "fcm.googleapis.com", kinds: ["approval"], created_at: 1_800_000_000, endpoint: `https://fcm.googleapis.com/fcm/send/d${i}` }));
    devices.push({ id: 50, host: "web.push.apple.com", kinds: ["approval", "budget"], created_at: 1_800_000_000, endpoint: OLD, stale: true });
    window.localStorage.setItem("luvebot.push.device", "50");
    render(<NotificationsCard />);
    fireEvent.click(within(await screen.findByTestId("notifications-renew")).getByRole("button", { name: "Renovar notificações" }));
    await screen.findByText("Notificações renovadas neste aparelho, com a chave atual do servidor.", {}, { timeout: 1500 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(devices.some((d) => d.endpoint === NEW) && !devices.some((d) => d.id === 50)).toBe(true);        // the new row is there and the stale one is not
    expect(devices).toHaveLength(LIMIT);
    expect(screen.queryByTestId("notifications-renew")).toBeNull();
  });
});
