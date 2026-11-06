// tests/unit/agent/voice-direct.test.tsx (contract v0.10 4.1, V6, slice VO-1)
// While Hermes's `voice.client_direct` is true (its default) the voice providers' KEYS go to the browser of anyone who opens the Hermes dashboard. One plain card in
// the Bot's profile, only when the voice status says `true`; one button that turns it off (PUT {"enabled": false}); false or absent: nothing; success: the card goes
// away; 502: it says it did not stick and stays; and there is no "turn it on" anywhere.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act, configure } from "@testing-library/react";
import { VoiceDirectCard } from "@/components/agent/VoiceDirectCard";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { Bot } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const WHY = "Enquanto isto estiver ligado, o Hermes entrega as chaves dos provedores de voz ao navegador de quem abrir o painel. O LuveBot nunca as mostra, mas o Hermes mostra. Desligue.";
const SIDE = "Desligar pode impedir que o cliente de voz do próprio Hermes, neste perfil, se conecte direto ao provedor. A Chamada do LuveBot não usa esse caminho: ela passa pelo servidor.";
const STATUS = { radio: { available: true, reason: null }, call: { available: true, reason: null, cents_per_minute: 5, max_seconds: 900, max_delegations: 6 } };

type Call = { method: string; url: string; body?: unknown; csrf: string | null };
let calls: Call[];
let voice: Record<string, unknown | Error>;
let put: (bot: string) => unknown;
function backend() {
  calls = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    const bot = url.match(/\/bots\/([^/]+)\/voice(?:\/client-direct)?$/)?.[1];
    if (bot && method === "GET") { const v = voice[bot]; if (v instanceof Error) throw v; return v; }
    if (bot && method === "PUT") return put(bot);
    if (url.includes("/activity")) return { items: [] };
    if (url.includes("/routines")) return { routines: [] };
    if (url.endsWith("/budget")) return { limits: [], paused: [], watcher: { last_at: 0, stale: false }, alerts: [] };
    if (/\/bots\/[^/]+$/.test(url)) return { name: "vendas", display: { label: "Vendas" }, soul: "", toolsets: [], mcp_servers: [] };
    return {};
  });
}
const puts = () => calls.filter((c) => c.method === "PUT");
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); voice = {}; put = () => ({ client_direct: false }); backend(); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("true: the card", () => {
  it("says what it is in plain words, with ONE button and the line about Hermes's own client", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    render(<VoiceDirectCard bot="vendas" />);
    expect(await screen.findByRole("heading", { name: "Chaves de voz no navegador" })).toBeTruthy();
    const section = screen.getByRole("heading", { name: "Chaves de voz no navegador" }).closest("section")!;
    expect(section.textContent).toContain(WHY);
    expect(section.textContent).toContain(SIDE);
    expect(within(section).getAllByRole("button")).toHaveLength(1);
    expect(within(section).getByRole("button", { name: "Desligar" })).toBeTruthy();
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);                          // nothing is written on sight
  });

  it("is in English too", async () => {
    setLuveLocale("en");
    voice = { vendas: { ...STATUS, client_direct: true } };
    render(<VoiceDirectCard bot="vendas" />);
    const section = (await screen.findByRole("heading", { name: "Voice keys in the browser" })).closest("section")!;
    expect(section.textContent).toContain("While this is on, Hermes hands the voice providers' keys to the browser of anyone who opens the dashboard. LuveBot never shows them, but Hermes does. Turn it off.");
    expect(section.textContent).toContain("LuveBot's Call does not use that path: it goes through the server.");
    expect(within(section).getByRole("button", { name: "Turn it off" })).toBeTruthy();
  });

  it("is a plain card, not an alarm: no alert role, no destructive colour on it", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    render(<VoiceDirectCard bot="vendas" />);
    const section = (await screen.findByRole("heading", { name: "Chaves de voz no navegador" })).closest("section")!;
    expect(section.querySelector("[role=alert], [role=status]")).toBeNull();
    expect(section.innerHTML).not.toMatch(/destructive/);
  });
});

describe("false, absent or unreadable: nothing", () => {
  it.each([
    ["false", { ...STATUS, client_direct: false }],
    ["absent", { ...STATUS }],
    ["null", { ...STATUS, client_direct: null }],
    ["the word 'true'", { ...STATUS, client_direct: "true" }],
    ["1", { ...STATUS, client_direct: 1 }],
    ["an empty answer", {}],
  ])("client_direct %s shows no card", async (_name, v) => {
    voice = { vendas: v };
    render(<VoiceDirectCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/bots/vendas/voice"))).toBe(true));
    await settle();
    expect(screen.queryByRole("heading", { name: "Chaves de voz no navegador" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("before the answer comes there is no card (the keys are not 'exposed' until the Bot says so)", async () => {
    let answer!: (v: unknown) => void;
    voice = { vendas: new Promise((r) => { answer = r; }) as unknown as Record<string, unknown> };
    render(<VoiceDirectCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/bots/vendas/voice"))).toBe(true));
    await settle();
    expect(screen.queryByRole("heading", { name: "Chaves de voz no navegador" })).toBeNull();
    expect(document.body.textContent).toBe("");
    answer({ ...STATUS, client_direct: true });
    expect(await screen.findByRole("button", { name: "Desligar" })).toBeTruthy();
  });

  it("a read that fails says nothing (no word without the answer), and no alert", async () => {
    voice = { vendas: new ApiError({ code: "hermes_unreachable", message: "x", status: 503 }) };
    render(<VoiceDirectCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/bots/vendas/voice"))).toBe(true));
    await settle();
    expect(document.body.textContent).toBe("");
  });
});

describe("turning it off", () => {
  it("PUT {enabled: false} to THIS Bot's route with the CSRF header; on success the card goes away; nothing else is written", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    render(<VoiceDirectCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Chaves de voz no navegador" })).toBeNull());
    expect(puts()).toHaveLength(1);
    expect(puts()[0].url).toBe("/api/plugins/luvebot/bots/vendas/voice/client-direct");
    expect(puts()[0].body).toEqual({ enabled: false });
    expect(puts()[0].csrf).toBe("csrf-1");
    expect(calls.filter((c) => c.method === "POST" || c.method === "DELETE")).toEqual([]);
  });

  it("while it writes the button is busy and cannot be pressed twice", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    let release!: () => void;
    put = () => new Promise((r) => { release = () => r({ client_direct: false }); });
    render(<VoiceDirectCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    const busy = await screen.findByRole("button", { name: "Desligando…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(puts()).toHaveLength(1);
    release();
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });

  it("502: it says it did not stick, the keys are still exposed, the card STAYS, the code is behind the detail, and a second try works", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    put = () => { throw new ApiError({ code: "hermes_error", message: "Hermes did not keep this setting.", status: 502 }); };
    render(<VoiceDirectCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Não deu certo: o Hermes não guardou a mudança, e as chaves continuam expostas. Tente de novo.");
    expect(alert.textContent).not.toContain("hermes_error");
    expect(alert.textContent).not.toContain("Hermes did not keep");                            // the backend's English never shows
    fireEvent.click(within(alert).getByRole("button", { name: "Detalhe técnico" }));
    expect(within(alert).getByText("hermes_error").tagName).toBe("CODE");
    expect(screen.getByRole("heading", { name: "Chaves de voz no navegador" })).toBeTruthy();
    const again = screen.getByRole("button", { name: "Desligar" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    put = () => ({ client_direct: false });
    fireEvent.click(again);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Chaves de voz no navegador" })).toBeNull());
    expect(puts()).toHaveLength(2);
  });

  it("an answer that does not say false is NOT a success: the card stays, with the same words", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    put = () => ({ client_direct: true });
    render(<VoiceDirectCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Não deu certo");
    expect(screen.getByRole("heading", { name: "Chaves de voz no navegador" })).toBeTruthy();
  });

  it("another failure (Hermes unreachable) is that sentence, not 'did not stick'; the card stays", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    put = () => { throw new ApiError({ code: "hermes_unreachable", message: "x", status: 503 }); };
    render(<VoiceDirectCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    expect((await screen.findByRole("alert")).textContent).toContain(translations.pt.errHermesUnreachable);
    expect(screen.getByRole("heading", { name: "Chaves de voz no navegador" })).toBeTruthy();
  });

  it("in English the 502 says it in English", async () => {
    setLuveLocale("en");
    voice = { vendas: { ...STATUS, client_direct: true } };
    put = () => { throw new ApiError({ code: "hermes_error", message: "x", status: 502 }); };
    render(<VoiceDirectCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn it off" }));
    expect((await screen.findByRole("alert")).textContent).toContain("It did not stick: Hermes did not keep the change, and the keys are still exposed. Try again.");
  });
});

describe("there is no way to turn it on", () => {
  it("no control of the card says on/enable/ligar/ativar, and the only write the screen ever sends is {enabled: false}", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    render(<VoiceDirectCard bot="vendas" />);
    await screen.findByRole("button", { name: "Desligar" });
    for (const control of screen.queryAllByRole("button")) expect(control.textContent).not.toMatch(/^(ligar|ativar|turn it on|enable|turn on)/i);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("the source: the client function sends the literal false and nothing in dashboard/src ever sends {enabled: true} to that route", () => {
    const client = fs.readFileSync(path.resolve(__dirname, "../../../dashboard/src/api/client.ts"), "utf8");
    const fn = client.slice(client.indexOf("export async function turnOffVoiceClientDirect"), client.indexOf("export async function turnOffVoiceClientDirect") + 400);
    expect(fn).toContain('JSON.stringify({ enabled: false })');
    expect(fn).not.toMatch(/enabled: *(true|on|enable)/);
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const hits = walk(path.resolve(__dirname, "../../../dashboard/src")).filter((f) => fs.readFileSync(f, "utf8").includes("client-direct")).map((f) => path.basename(f));
    expect(hits).toEqual(["client.ts"]);                                                  // one place knows the route
  });
});

describe("in the Bot's profile, one Bot at a time", () => {
  const bot = (name: string) => ({ name, is_default: false, description: "", status: "idle", model: { provider: "p", name: "m" }, display: { label: name, role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "🐳" } } }) as Bot;

  it("the profile shows the card for a Bot whose voice says true", async () => {
    voice = { vendas: { ...STATUS, client_direct: true } };
    render(<AgentPanel bot={bot("vendas")} onOpenPage={() => {}} />);
    expect(await screen.findByRole("button", { name: "Desligar" })).toBeTruthy();
  });

  it("switching Bot drops the card of the previous one at once", async () => {
    voice = { vendas: { ...STATUS, client_direct: true }, dev: { ...STATUS, client_direct: false } };
    const r = render(<VoiceDirectCard bot="vendas" />);
    await screen.findByRole("button", { name: "Desligar" });
    r.rerender(<VoiceDirectCard bot="dev" />);
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();                // the old Bot's card is not left under the new Bot's name
    await settle();
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
  });

  it("a LATE answer of the old Bot ('true') never puts its card under the new Bot", async () => {
    let late!: (v: unknown) => void;
    voice = { vendas: new Promise((r) => { late = r; }) as unknown as Record<string, unknown>, dev: { ...STATUS, client_direct: false } };
    const r = render(<VoiceDirectCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/bots/vendas/voice"))).toBe(true));
    r.rerender(<VoiceDirectCard bot="dev" />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/bots/dev/voice"))).toBe(true));
    await settle();
    late({ ...STATUS, client_direct: true });                                             // vendas answers after the person moved on
    await settle();
    expect(screen.queryByRole("button", { name: "Desligar" })).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("turning it off on one Bot writes to that Bot only", async () => {
    voice = { vendas: { ...STATUS, client_direct: true }, dev: { ...STATUS, client_direct: true } };
    render(<VoiceDirectCard bot="dev" />);
    fireEvent.click(await screen.findByRole("button", { name: "Desligar" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].url).toContain("/bots/dev/voice/client-direct");
    expect(puts()[0].url).not.toContain("vendas");
  });
});
