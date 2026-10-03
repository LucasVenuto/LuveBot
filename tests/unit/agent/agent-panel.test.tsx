// tests/unit/agent/agent-panel.test.tsx
// The Bot's profile panel (T7.1 F4): only backend data, real pause/resume (contract v0.4 B3), a pause that is not
// LuveBot's is explained and never lifted, nothing acts without a confirmation click.
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import type { Bot } from "@/api/types";

const BOT: Bot = {
  name: "vendas", is_default: false, description: "", status: "idle",
  model: { provider: "openrouter", name: "modelo-real-x" },
  display: { label: "Vendas", role: "Prospecção B2B", call_me: "Lucas", color: "#60a5fa", avatar: { kind: "emoji", value: "🐳" } },
};

type Call = { method: string; url: string; csrf: string | null; body?: any };
function backend(over: (c: Call) => any = () => undefined) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? "GET", url, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const custom = over(c);
    if (custom !== undefined) return custom;
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (url.includes("/activity?") && url.includes("tab=running")) return { items: [{ id: "a1", kind: "run", bot: "vendas", title: "Follow-up dos leads", origin: "message", status: "running" }] };
    if (url.includes("/activity?")) return { items: [] };
    if (url.includes("/routines")) return { routines: [{ id: "r1", bot: "vendas", name: "Relatório diário", schedule: { expr: "0 8 * * 1-5" }, state: "scheduled", enabled: true }] };
    if (url.endsWith("/budget")) return { limits: [
      { scope: "bot", ref: "vendas", period: "day", cents: 500, spent_cents: 120, percent: 24 },
      { scope: "bot", ref: "dev", period: "day", cents: 900, spent_cents: 10, percent: 1 },
      { scope: "global", ref: null, period: "day", cents: 2000, spent_cents: 300, percent: 15 },
    ], paused: [], watcher: { last_at: 0, stale: false }, alerts: [] };
    if (c.method === "POST") return { ok: true, paused: c.url.endsWith("/pause"), scope: "profile" };
    throw new Error("unexpected " + c.method + " " + url);
  });
  return calls;
}
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("AgentPanel", () => {
  it("shows who the Bot is from its real fields only", async () => {
    backend();
    render(<AgentPanel bot={BOT} onOpenPage={() => {}} />);
    expect(screen.getByRole("heading", { name: "Vendas" })).toBeTruthy();
    expect(screen.getByText("Prospecção B2B")).toBeTruthy();
    expect(screen.getByText("Te chama de Lucas")).toBeTruthy();
    expect(screen.getByText("Modelo: modelo-real-x")).toBeTruthy();
    await screen.findByText("Follow-up dos leads");
  });

  it("asks the backend for THIS Bot's activity and routines, and shows honest empty states", async () => {
    const calls = backend();
    render(<AgentPanel bot={BOT} onOpenPage={() => {}} />);
    await screen.findByText("Follow-up dos leads");
    const reads = calls.filter((c) => c.method === "GET").map((c) => c.url);
    expect(reads).toContain("/api/plugins/luvebot/activity?tab=running&bot=vendas");
    expect(reads).toContain("/api/plugins/luvebot/activity?tab=done&bot=vendas");
    expect(reads).toContain("/api/plugins/luvebot/routines?bot=vendas");
    fireEvent.click(screen.getByRole("tab", { name: "Agendado" }));
    expect(screen.getByText("Relatório diário")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Concluído" }));
    expect(screen.getByText("Ainda não terminei nada por aqui.")).toBeTruthy();
  });

  it("budget shows only this Bot's caps", async () => {
    backend();
    render(<AgentPanel bot={BOT} onOpenPage={() => {}} />);
    const line = await screen.findByText(/^Teto diário: US\$\s?1,20 de US\$\s?5,00$/);
    expect(line).toBeTruthy();
    expect(screen.queryByText(/9,00/)).toBeNull();   // dev's cap
    expect(screen.queryByText(/20,00/)).toBeNull();  // the global cap
  });

  it("no cap for this Bot says so", async () => {
    backend((c) => (c.url.endsWith("/budget") ? { limits: [], paused: [], watcher: { last_at: 0, stale: false }, alerts: [] } : undefined));
    render(<AgentPanel bot={BOT} onOpenPage={() => {}} />);
    expect(await screen.findByText("Você ainda não definiu um teto para mim.")).toBeTruthy();
  });

  it("stopping work needs a second click, then POSTs stop with CSRF", async () => {
    const calls = backend();
    render(<AgentPanel bot={BOT} onOpenPage={() => {}} />);
    await screen.findByText("Follow-up dos leads");
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect(posts(calls)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar parada" }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ url: "/api/plugins/luvebot/activity/a1/stop", csrf: "csrf-1" });
  });

  it("pausing needs a confirmation and sends the real pause route", async () => {
    const calls = backend();
    const onChanged = vi.fn();
    render(<AgentPanel bot={BOT} onOpenPage={() => {}} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Pausar Bot" }));
    expect(posts(calls)).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Parar também o trabalho em andamento"));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar pausa" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posts(calls)).toEqual([{ method: "POST", url: "/api/plugins/luvebot/bots/vendas/pause", csrf: "csrf-1", body: { stop_active: true } }]);
  });

  it("only a pause LuveBot set for you can be resumed here", async () => {
    const calls = backend();
    const { rerender } = render(<AgentPanel bot={{ ...BOT, status: "paused", status_reason: "user" }} onOpenPage={() => {}} />);
    expect(screen.getByText("Pausado por você")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retomar Bot" }));
    await waitFor(() => expect(posts(calls).map((c) => c.url)).toEqual(["/api/plugins/luvebot/bots/vendas/resume"]));

    for (const [reason, text] of [["estop", "Pausado no Hermes (não pelo LuveBot)"], ["budget", "Pausado pelo teto de gasto"], ["all", "Tudo está pausado"]]) {
      rerender(<AgentPanel bot={{ ...BOT, status: "paused", status_reason: reason }} onOpenPage={() => {}} />);
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Retomar Bot" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Pausar Bot" })).toBeNull();
    }
  });

  it("a refused resume is explained (not_ours)", async () => {
    backend((c) => { if (c.url.endsWith("/resume")) throw new ApiError({ code: "not_ours", message: "x", status: 409 }); });
    render(<AgentPanel bot={{ ...BOT, status: "paused", status_reason: "user" }} onOpenPage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Retomar Bot" }));
    expect((await screen.findByText(/o LuveBot não a altera/)).getAttribute("role")).toBe("alert");
  });

  it("Personalizar opens the Bot's rules, routines, identity and costs screens", () => {
    backend();
    const onOpenPage = vi.fn();
    render(<AgentPanel bot={BOT} onOpenPage={onOpenPage} />);
    fireEvent.click(screen.getByRole("button", { name: /Regras deste Bot/ }));
    fireEvent.click(screen.getByRole("button", { name: /Rotinas deste Bot/ }));
    fireEvent.click(screen.getByRole("button", { name: /Identidade e instruções/ }));
    fireEvent.click(screen.getByRole("button", { name: "Gerenciar tetos" }));
    expect(onOpenPage.mock.calls.map((c) => c[0])).toEqual(["rules", "routines", "profile", "costs"]);
  });

  it("has no form: it sits next to the conversation's composer", () => {
    backend();
    const { container } = render(<AgentPanel bot={BOT} onOpenPage={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Pausar Bot" }));
    expect(container.querySelector("form")).toBeNull();
    expect(within(container).queryAllByRole("tab")).toHaveLength(3);
  });
});
