// tests/unit/chat/inline-approval.test.tsx
// The approval card inside the conversation (T7.1 F3): decided for real, by a human click only (invariant 6),
// and only when the backend stored the request and gave it a luvebot_digest (contract v0.1 A-14).
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { parseSse } from "@/components/transcript";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

const real = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));
const stored = { ...real, luvebot_digest: "dg-123" };

type Call = { method: string; url: string; csrf: string | null; body?: any };
function backend(answer: (c: Call) => any = () => ({ approval: { status: "decided" } })) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? "GET", url, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    return answer(c);
  });
  return calls;
}
const decisions = (calls: Call[]) => calls.filter((c) => c.method === "POST" && /approval/.test(c.url));

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("InlineApproval", () => {
  it("shows the command and nothing is sent without a click", () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    expect(screen.getByText("rm -rf /tmp/luvebot-approval-canary")).toBeTruthy();
    // native "session" and "always" are never offered: once, always-as-draft, deny
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Permitir uma vez", "Sempre permitir…", "Negar…"]);
    expect(decisions(calls)).toHaveLength(0);
  });

  it("Permitir uma vez resolves this run's request with the stored digest and CSRF", async () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Permitir uma vez"));
    await screen.findByText("Permitida uma vez.");
    expect(decisions(calls)).toEqual([{
      method: "POST", url: "/api/plugins/luvebot/bots/vendas/runs/run_r1/approval", csrf: "csrf-1",
      body: { request_id: real.request_id, digest: "dg-123", choice: "once" },
    }]);
    expect(screen.queryByText("Permitir uma vez")).toBeNull(); // decided once; no second click possible
  });

  it("Sempre permitir sends once plus a draft rule, never 'always'", async () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Sempre permitir…"));
    expect(decisions(calls)).toHaveLength(0);
    fireEvent.click(screen.getByText("Criar rascunho e permitir uma vez"));
    await waitFor(() => expect(decisions(calls)).toHaveLength(1));
    const body = decisions(calls)[0].body;
    expect(body).toMatchObject({ request_id: real.request_id, digest: "dg-123", choice: "once", draft_rule: { level: "allow" } });
    expect(body.draft_rule.label).toContain("delete in root path");
    expect(JSON.stringify(body)).not.toContain('"always"');
  });

  it("Negar needs a reason; the reason goes to the backend", async () => {
    const calls = backend();
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Negar…"));
    const confirm = screen.getByText("Confirmar negação") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: " não apague nada " } });
    fireEvent.click(confirm);
    await screen.findByText("Negada.");
    expect(decisions(calls)[0].body).toEqual({ request_id: real.request_id, digest: "dg-123", choice: "deny", reason: "não apague nada" });
  });

  it("without luvebot_digest (the backend could not store it) nothing can be decided here", () => {
    const calls = backend();
    render(<InlineApproval frame={real} bot="vendas" runId="run_r1" pending />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/não pode ser decidido por aqui/)).toBeTruthy();
    expect(decisions(calls)).toHaveLength(0);
  });

  it("once the turn is over the request is no longer decidable", () => {
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending={false} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("Este pedido não está mais pendente.")).toBeTruthy();
  });

  it("a refusal from the server is shown and the buttons stay for a new human decision", async () => {
    backend(() => { throw new ApiError({ code: "loopback_not_human", message: "x", status: 403 }); });
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Permitir uma vez"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/loopback|humano|sessão/i);
    expect(screen.getByText("Permitir uma vez")).toBeTruthy();
  });
});
