// tests/unit/agent/reactions-see.test.tsx (docs/contracts/voice-language-reactions-v0.md section 4 and A-282, slice RX-2)
// "O Bot vê as minhas reações": ONE switch in the Bot's profile, off by default. The state is read from GET /bots/{bot} (`reactions: {bot_sees}`); when the server cannot tell (the object is absent, an unreadable answer) the
// switch is drawn OFF and disabled and says it is unavailable, never on. A click sends PUT /bots/{bot}/reactions/bot-sees with EXACTLY {enabled} and the CSRF header, and the server's answer is the truth. The page never says the Bot reacts.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, act, configure } from "@testing-library/react";
import { ReactionsSeeCard, botSees } from "@/components/agent/ReactionsSeeCard";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

type Call = { method: string; url: string; body?: unknown; csrf: string | null };
let calls: Call[];
let detail: Record<string, unknown>;                 // GET /bots/{bot}, by Bot (a value that is an Error is thrown)
let put: (bot: string, body: { enabled: boolean }) => unknown;
function backend() {
  calls = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    const toggle = url.match(/\/bots\/([^/]+)\/reactions\/bot-sees$/)?.[1];
    if (toggle && method === "PUT") { const r = put(toggle, JSON.parse(String(init!.body))); if (r instanceof Error) throw r; return r; }
    const one = url.match(/\/bots\/([^/]+)$/)?.[1];
    if (one && method === "GET") { const v = detail[one]; if (v instanceof Error) throw v; return v ?? { name: one, display: { label: one }, soul: "", toolsets: [], mcp_servers: [] }; }
    if (url.includes("/activity")) return { items: [] };
    if (url.includes("/routines")) return { routines: [] };
    if (url.endsWith("/budget")) return { limits: [], paused: [], watcher: { last_at: 0, stale: false }, alerts: [] };
    return {};
  });
}
const puts = () => calls.filter((c) => c.method === "PUT");
const sw = () => screen.getByRole("switch", { name: "O Bot vê as minhas reações" }) as HTMLButtonElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const err = (code: string, status = 500) => new ApiError({ code, message: "English for developers", status });

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); detail = {}; put = (_b, body) => ({ reactions: { bot_sees: body.enabled } }); backend(); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("the state the server gave", () => {
  it("false: the switch is off, enabled, with the words that say what it does; nothing is written on sight", async () => {
    detail = { vendas: { reactions: { bot_sees: false } } };
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch", { name: "O Bot vê as minhas reações" });
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().disabled).toBe(false);
    expect(screen.getByRole("heading", { name: "Reações" })).toBeTruthy();
    expect(screen.getByText("Desligado, o Bot não fica sabendo das reações. Ligado, ele fica sabendo na próxima mensagem que você enviar.")).toBeTruthy();
    expect(puts()).toEqual([]);
  });
  it("true: the switch is on", async () => {
    detail = { vendas: { reactions: { bot_sees: true } } };
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch");
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });
  it.each([
    ["the object is absent (a Hermes that cannot tell)", {}],
    ["an empty object", { reactions: {} }],
    ["the word 'true'", { reactions: { bot_sees: "true" } }],
    ["1", { reactions: { bot_sees: 1 } }],
    ["null", { reactions: { bot_sees: null } }],
    ["an unreadable Bot", err("hermes_unreachable", 502)],
  ])("when it cannot be told (%s): OFF, disabled, and it says it is unavailable, never on", async (_name, value) => {
    detail = { vendas: value as never };
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(sw().disabled).toBe(true);
    expect(screen.getByText("Indisponível agora: não foi possível saber se este Hermes conta as reações ao Bot.")).toBeTruthy();
    fireEvent.click(sw());
    await settle();
    expect(puts()).toEqual([]);                       // a disabled switch writes nothing
  });
  it("before the answer comes there is no card (it is not drawn off and then flipped)", async () => {
    let answer!: (v: unknown) => void;
    detail = { vendas: new Promise((r) => { answer = r; }) as never };
    render(<ReactionsSeeCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => /bots\/vendas$/.test(c.url))).toBe(true));
    await settle();
    expect(document.body.textContent).toBe("");
    answer({ reactions: { bot_sees: true } });
    await screen.findByRole("switch");
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });
  it("botSees reads only a boolean", () => {
    expect(botSees({ reactions: { bot_sees: true } })).toBe(true);
    expect(botSees({ reactions: { bot_sees: false } })).toBe(false);
    for (const bad of [null, undefined, {}, { reactions: null }, { reactions: { bot_sees: "no" } }, { bot_sees: true }]) expect(botSees(bad)).toBeNull();
  });
});

describe("turning it on and off", () => {
  it("a click sends PUT with EXACTLY {enabled: true} and the CSRF header; the answer is what is shown, with its words", async () => {
    detail = { vendas: { reactions: { bot_sees: false } } };
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch");
    fireEvent.click(sw());
    await screen.findByText("Ligado. O Bot fica sabendo na próxima mensagem.");
    expect(puts()).toEqual([{ method: "PUT", url: expect.stringMatching(/\/bots\/vendas\/reactions\/bot-sees$/), body: { enabled: true }, csrf: "csrf-1" }]);
    expect(sw().getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw());
    await screen.findByText("Desligado.");
    expect(puts().map((c) => c.body)).toEqual([{ enabled: true }, { enabled: false }]);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });
  it("a refusal is a sentence (never the server's English), the switch does not move, and the person can try again", async () => {
    detail = { vendas: { reactions: { bot_sees: false } } };
    put = () => err("loopback_not_human", 403);
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch");
    fireEvent.click(sw());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("English for developers");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    put = (_b, body) => ({ reactions: { bot_sees: body.enabled } });
    fireEvent.click(sw());
    await screen.findByText("Ligado. O Bot fica sabendo na próxima mensagem.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("an answer that disagrees with what was asked, or is not the shape, is an error: the server's word is the truth and nothing is said saved", async () => {
    detail = { vendas: { reactions: { bot_sees: false } } };
    put = () => ({ reactions: { bot_sees: false } });           // asked for true, the server kept false
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch");
    fireEvent.click(sw());
    expect((await screen.findByRole("alert")).textContent).toBe("Não foi possível mudar isto agora. Nada foi alterado.");
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/^Ligado\./)).toBeNull();
    put = () => ({ ok: true });                                  // not the shape: the state stays as it was
    fireEvent.click(sw());
    await waitFor(() => expect(puts()).toHaveLength(2));
    await settle();
    expect(sw().getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText(/^Ligado\./)).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Não foi possível mudar isto agora. Nada foi alterado.");
  });
  it("only one write at a time: a second click while it saves writes nothing more", async () => {
    detail = { vendas: { reactions: { bot_sees: false } } };
    let release!: () => void;
    put = (_b, body) => new Promise<unknown>((r) => { release = () => r({ reactions: { bot_sees: body.enabled } }); }) as never;
    render(<ReactionsSeeCard bot="vendas" />);
    await screen.findByRole("switch");
    fireEvent.click(sw());
    await screen.findByText("Salvando…");
    fireEvent.click(sw()); fireEvent.click(sw());
    expect(puts()).toHaveLength(1);
    await act(async () => { release(); });
    await screen.findByText("Ligado. O Bot fica sabendo na próxima mensagem.");
  });
  it("switching Bot drops the old Bot's switch at once and a LATE answer of the old one never shows under the new; a write goes to the Bot on screen only", async () => {
    let late!: (v: unknown) => void;
    detail = { vendas: new Promise((r) => { late = r; }) as never, dev: { reactions: { bot_sees: false } } };
    const r = render(<ReactionsSeeCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => /bots\/vendas$/.test(c.url))).toBe(true));
    r.rerender(<ReactionsSeeCard bot="dev" />);
    await screen.findByRole("switch");
    late({ reactions: { bot_sees: true } });
    await settle();
    expect(sw().getAttribute("aria-checked")).toBe("false");     // still dev's
    fireEvent.click(sw());
    await screen.findByText("Ligado. O Bot fica sabendo na próxima mensagem.");
    expect(puts().map((c) => c.url.match(/bots\/([^/]+)\//)?.[1])).toEqual(["dev"]);
  });
  it("the words never say the Bot reacts, and the English ones are English", async () => {
    setLuveLocale("en");
    detail = { vendas: { reactions: { bot_sees: false } } };
    render(<ReactionsSeeCard bot="vendas" />);
    const s = await screen.findByRole("switch", { name: "The Bot sees my reactions" });
    expect(screen.getByRole("heading", { name: "Reactions" })).toBeTruthy();
    expect(screen.getByText("Off, the Bot is not told about reactions. On, it is told with the next message you send.")).toBeTruthy();
    fireEvent.click(s);
    await screen.findByText("On. The Bot is told with the next message.");
    expect(document.body.textContent).not.toMatch(/Bot (reacts|reacted)|reage|reagiu/i);
  });
});

describe("in the Bot's profile", () => {
  const profile = (name: string) => ({ name, is_default: false, description: "", status: "idle", model: { provider: "p", name: "m" }, display: { label: name, role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "B" } } } as unknown as Bot);
  it("the profile has the switch, read from the Bot's own detail", async () => {
    detail = { vendas: { name: "vendas", display: { label: "Vendas" }, soul: "", toolsets: [], mcp_servers: [], reactions: { bot_sees: true } } };
    render(<AgentPanel bot={profile("vendas")} onOpenPage={() => {}} />);
    await screen.findByRole("switch", { name: "O Bot vê as minhas reações" });
    expect(sw().getAttribute("aria-checked")).toBe("true");
  });
});
