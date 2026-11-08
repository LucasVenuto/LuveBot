// tests/unit/agent/can-ask.test.tsx
// A Bot whose api_server tools lack `clarify` never asks a person (Hermes sets the question aside; the Bot decides alone), so it never shows in
// "esperando você" and the feature looks broken. GET /bots/{bot} says `can_ask`: ONE calm line in the Bot's profile, ONLY when it is exactly `false`.
// true, absent (the backend could not read it: never a guess) and an unreadable Bot show nothing. No switch (turning a tool on gives the Bot a capability).
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { CanAskNote } from "@/components/agent/CanAskNote";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import type { Bot } from "@/api/types";

const LINE = "Este Bot não consegue te fazer perguntas: a ferramenta de perguntas (clarify) está desligada nas ferramentas dele. Ele segue sem perguntar e decide sozinho.";
type Detail = Record<string, unknown> | Error | Promise<Record<string, unknown>>;
let reads: string[];
function backend(details: Record<string, Detail>) {
  reads = [];
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    const bot = url.match(/\/bots\/([^/]+)$/)?.[1];
    if (bot && bot in details) {
      reads.push(bot);
      const d = await details[bot];
      if (d instanceof Error) throw d;
      return { name: bot, display: { label: bot }, soul: "", toolsets: [], mcp_servers: [], ...d };
    }
    if (url.includes("/activity")) return { items: [] };
    if (url.includes("/routines")) return { routines: [] };
    if (url.endsWith("/budget")) return { limits: [], paused: [], watcher: { last_at: 0, stale: false }, alerts: [] };
    return {};
  });
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("a linha 'não consegue te fazer perguntas'", () => {
  it("can_ask false: one calm line with how to turn it on; no switch, no button, no alert", async () => {
    backend({ vendas: { can_ask: false } });
    render(<CanAskNote bot="vendas" />);
    const line = await screen.findByTestId("bot-cannot-ask");
    expect(line.textContent).toContain(LINE);
    expect(line.textContent).toContain("Para ligar, abra as ferramentas do perfil deste Bot no Hermes");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();                                          // not announced at every visit
  });

  it("can_ask true shows nothing", async () => {
    backend({ vendas: { can_ask: true } });
    render(<CanAskNote bot="vendas" />);
    await waitFor(() => expect(reads).toEqual(["vendas"]));
    await settle();
    expect(screen.queryByTestId("bot-cannot-ask")).toBeNull();
  });

  it("can_ask absent (not readable, or no session authority) shows nothing: never a guess", async () => {
    backend({ vendas: {} });
    render(<CanAskNote bot="vendas" />);
    await waitFor(() => expect(reads).toEqual(["vendas"]));
    await settle();
    expect(screen.queryByTestId("bot-cannot-ask")).toBeNull();
  });

  it("only the boolean false counts (null, 0 and 'false' are not 'cannot')", async () => {
    for (const v of [null, 0, "false"]) {
      backend({ vendas: { can_ask: v } });
      const r = render(<CanAskNote bot="vendas" />);
      await waitFor(() => expect(reads).toEqual(["vendas"]));
      await settle();
      expect(screen.queryByTestId("bot-cannot-ask")).toBeNull();
      r.unmount();
    }
  });

  it("a Bot that cannot be read shows no line (it is an advisory, not an error)", async () => {
    backend({ vendas: new ApiError({ code: "hermes_error", message: "x", status: 502 } as never) });
    render(<CanAskNote bot="vendas" />);
    await waitFor(() => expect(reads).toEqual(["vendas"]));
    await settle();
    expect(screen.queryByTestId("bot-cannot-ask")).toBeNull();
  });

  it("switching Bot never keeps the last Bot's line, and a late answer of the old Bot is dropped", async () => {
    let late: (d: Record<string, unknown>) => void = () => {};
    backend({ vendas: new Promise<Record<string, unknown>>((r) => { late = r; }), suporte: { can_ask: true } });
    const r = render(<CanAskNote bot="vendas" />);
    r.rerender(<CanAskNote bot="suporte" />);
    await waitFor(() => expect(reads).toContain("suporte"));
    late({ can_ask: false });                                                                 // vendas answers after the switch
    await settle();
    expect(screen.queryByTestId("bot-cannot-ask")).toBeNull();
  });

  it("the line of the Bot just left is gone at once, while the next Bot's answer is still on its way", async () => {
    backend({ vendas: { can_ask: false }, suporte: new Promise<Record<string, unknown>>(() => {}) });
    const r = render(<CanAskNote bot="vendas" />);
    await screen.findByTestId("bot-cannot-ask");
    r.rerender(<CanAskNote bot="suporte" />);
    await waitFor(() => expect(reads).toContain("suporte"));
    expect(screen.queryByTestId("bot-cannot-ask")).toBeNull();
  });

  it("is in the Bot's profile, after the approval settings", async () => {
    backend({ vendas: { can_ask: false } });
    const bot = { name: "vendas", is_default: false, description: "", status: "idle", model: { provider: "p", name: "m" }, display: { label: "Vendas", role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "🐳" } } } as Bot;
    render(<AgentPanel bot={bot} onOpenPage={() => {}} />);
    expect((await screen.findByTestId("bot-cannot-ask")).textContent).toContain("não consegue te fazer perguntas");
  });
});
