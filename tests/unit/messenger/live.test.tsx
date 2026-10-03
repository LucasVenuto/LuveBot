// tests/unit/messenger/live.test.tsx
// The sidebar stays current without a reload (T11.6): the pending-approval "!" goes away once the approval is no longer
// pending, the Bot shows "digitando..." while its turn runs, and a hidden tab asks nothing.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Bot } from "@/api/types";

const bot = (status: Bot["status"]): Bot => ({
  name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status,
  display: { label: "Vendas", role: "Prospecção", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } },
});
const approval = (status: string) => ({ request_id: "a1", bot: "vendas", status, description: "enviar e-mail", created_at: "2026-10-02T00:00:00Z" });

type World = { status: Bot["status"]; approvals: unknown[]; calls: string[] };
function backend(world: World) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    world.calls.push(`${method} ${url}`);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (method === "GET" && /\/bots$/.test(url)) return { bots: [bot(world.status)] };
    if (method === "GET" && url.includes("/approvals")) return { approvals: world.approvals };
    if (method === "GET" && url.includes("/budget")) return { limits: [] };
    if (method === "POST" && url.endsWith("/bots/vendas/sessions")) return { session: { id: "s1" } };
    if (method === "POST" && url.endsWith("/runs")) { world.status = "working"; return { run: { id: "run_1", status: "started", session_id: "s1" } }; }
    if (method === "GET" && url.includes("/runs/")) return { run: { id: "run_1", status: world.status === "working" ? "started" : "completed" } };
    return {};
  });
}
const contact = () => screen.getByRole("button", { name: /Vendas/, pressed: false }) as HTMLElement;
const tick = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };

beforeEach(() => { cleanup(); resetCsrfToken(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  delete (window as any).__HERMES_PLUGIN_SDK__;
  setCustomFetchJSON(null);
});

describe("live sidebar", () => {
  it("the '!' of a pending approval goes away once it is no longer pending, without a reload", async () => {
    const world: World = { status: "idle", approvals: [approval("pending")], calls: [] };
    backend(world);
    render(<LuveBotApp />);
    await waitFor(() => expect(within(contact()).getByRole("img", { name: "Precisa de você" })).toBeTruthy());
    world.approvals = [approval("decided")];
    await tick(15_000);
    await waitFor(() => expect(within(contact()).queryByRole("img", { name: "Precisa de você" })).toBeNull());
  });

  it("a hidden tab asks nothing; coming back refreshes at once", async () => {
    const world: World = { status: "idle", approvals: [], calls: [] };
    backend(world);
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/ });
    const asked = () => world.calls.filter((c) => c.startsWith("GET") && c.includes("/approvals")).length;
    const before = asked();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await tick(45_000);
    expect(asked()).toBe(before);
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(asked()).toBe(before + 1));
  });

  it("while the Bot's turn runs the list says 'digitando...', and it stops when the turn ends", async () => {
    const world: World = { status: "idle", approvals: [], calls: [] };
    backend(world);
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    (window as any).__HERMES_PLUGIN_SDK__ = {
      authedFetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    };
    render(<LuveBotApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Vendas/ }));
    fireEvent.change(await screen.findByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    const row = () => screen.getByRole("button", { name: /Vendas/, pressed: true });
    await waitFor(() => expect(within(row()).getByText("digitando...")).toBeTruthy());  // no 15 s wait: the run start refreshed it
    world.status = "idle";
    await act(async () => {
      ctl.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify({ event: "run.completed", run_id: "run_1", seq: 1, output: "" })}\n\n`));
      ctl.close();
    });
    await waitFor(() => expect(within(row()).queryByText("digitando...")).toBeNull());
  });

  it("a budget answer without limits does not take the home screen down (found while wiring the refresh)", async () => {
    const { Hoje } = await import("@/components/Hoje");
    expect(() => render(<Hoje budget={{} as any} />)).not.toThrow();
    expect(screen.getByRole("heading", { level: 1, name: /hoje/i })).toBeTruthy();
  });
});

