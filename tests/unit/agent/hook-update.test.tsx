// tests/unit/agent/hook-update.test.tsx
// t161 (Brasa's finding): a Bot that already exists keeps its old hook, and nothing on the screen could bring it the new one.
// In "Onde aprovar", when the backend says hook_outdated (or, when it tells the version LuveBot ships, the Bot's hook is older),
// "Atualizar o hook deste Bot" calls POST /bots/{bot}/hook/install (no body, CSRF, audited by the backend), then reads the card
// again; a restart_required answer is said plainly: this Bot's gateway must be restarted.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ApprovalSurfaceCard, olderVersion } from "@/components/agent/ApprovalSurfaceCard";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import type { ApprovalSurface } from "@/api/types";

const surface = (over: Partial<ApprovalSurface> = {}): ApprovalSurface => ({
  bot: "vendas", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null,
  applied: false, applied_reason: "hook_outdated", hook_version: "0.1.0", updated_at: null, updated_by: null, ...over,
});
type Call = { method: string; url: string; body: string | undefined; csrf: string | null };
function backend(state: { surface: ApprovalSurface }, install: () => unknown) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body as string | undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/bots/vendas/approval-surface")) return { approval_surface: state.surface };
    if (url.endsWith("/bots/vendas/hook/install") && method === "POST") return install();
    if (url.includes("/rules")) return { rules: [] };
    throw new Error("unexpected " + method + " " + url);
  });
  return calls;
}
const BTN = "Atualizar o hook deste Bot";
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
const reads = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url.endsWith("/approval-surface")).length;

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("Atualizar o hook deste Bot", () => {
  it("hook_outdated offers it; only the click installs (no body, CSRF), then the card is read again", async () => {
    const state = { surface: surface() };
    const calls = backend(state, () => { state.surface = surface({ applied: true, applied_reason: "applied", hook_version: "0.3.2" });
      return { hook: { status: "live", version: "0.3.2" }, changed: true, gateway_reloaded: true, restart_required: false }; });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: BTN }));
    expect(await screen.findByText("Hook atualizado.")).toBeTruthy();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]).toMatchObject({ url: "/api/plugins/luvebot/bots/vendas/hook/install", body: undefined, csrf: "csrf-1" });
    await waitFor(() => expect(reads(calls)).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: BTN })).toBeNull());  // the card now says the hook is current
  });

  it("restart_required is said in a sentence: this Bot's gateway must be restarted", async () => {
    backend({ surface: surface() }, () => ({ hook: { status: "pending_reload", version: "0.1.0" }, changed: true, gateway_reloaded: false, restart_required: true }));
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: BTN }));
    expect(await screen.findByText(/o gateway deste Bot precisa ser reiniciado para usar a versão nova/)).toBeTruthy();
    expect(screen.queryByText("Hook atualizado.")).toBeNull();
  });

  it("nothing to change, and a failure, are said as they are", async () => {
    backend({ surface: surface() }, () => ({ hook: { status: "live", version: "0.1.0" }, changed: false, gateway_reloaded: null, restart_required: false }));
    const r = render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: BTN }));
    expect(await screen.findByText("O hook deste Bot já estava na versão atual.")).toBeTruthy();
    r.unmount();
    backend({ surface: surface() }, () => { throw new ApiError({ code: "hook_install_failed", message: "x", status: 502 }); });
    render(<ApprovalSurfaceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: BTN }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Não deu para atualizar o hook deste Bot agora\. Nada mudou/);
  });

  it("not offered when the hook is current or simply not live; offered when the backend says LuveBot ships a newer one", async () => {
    for (const s of [surface({ applied: true, applied_reason: "applied", hook_version: "0.3.2" }), surface({ applied_reason: "hook_not_live" }),
                     surface({ applied: true, applied_reason: "applied", hook_version: "0.3.2", hook_latest_version: "0.3.2" })]) {
      backend({ surface: s }, () => ({}));
      const r = render(<ApprovalSurfaceCard bot="vendas" />);
      await screen.findByRole("button", { name: "Salvar alterações" });
      expect(screen.queryByRole("button", { name: BTN })).toBeNull();
      r.unmount();
    }
    backend({ surface: surface({ applied: true, applied_reason: "applied", hook_version: "0.2.9", hook_latest_version: "0.3.2" }) }, () => ({}));
    render(<ApprovalSurfaceCard bot="vendas" />);
    expect(await screen.findByRole("button", { name: BTN })).toBeTruthy();
  });

  it("compares versions by number; anything unreadable is not called older", () => {
    expect(olderVersion("0.2.9", "0.3.2")).toBe(true);
    expect(olderVersion("0.3.10", "0.3.2")).toBe(false);
    expect(olderVersion("0.3.2", "0.3.2")).toBe(false);
    expect(olderVersion("1.0", "1.0.1")).toBe(true);
    for (const [a, b] of [[null, "0.3.2"], ["0.3.2", undefined], ["dev", "0.3.2"], ["0.3.x", "0.4"]] as const) expect(olderVersion(a, b)).toBe(false);
  });
});
