// tests/unit/approvals/deny-reason-follow.test.tsx
// t164 (b3, Brasa): the deny answer may bring reason_delivered null: Hermes accepted the reason as a steer and the run still goes
// on. The screen says "Enviando o motivo ao Bot…" and reads the approval again until it is true ("entregue") or false (kept in
// LuveBot). It never says "entregue" before a true; still null when it stops asking, it says there is no confirmation yet.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { parseSse } from "@/components/transcript";
import { FOLLOW_MS, FOLLOW_TRIES, reasonsState } from "@/components/approvals/decide";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Approval, Bot } from "@/api/types";

const SENDING = "Enviando o motivo ao Bot…";
const DELIVERED = "O motivo foi entregue ao Bot como instrução humana.";
const KEPT = "O motivo ficou registrado no LuveBot e na auditoria; ele não foi entregue ao Bot.";
const UNKNOWN = "O motivo foi enviado, mas ainda não há confirmação de que o Bot o recebeu.";
const bots = [{ name: "vendas", is_default: false, status: "idle", description: "", model: { provider: "x", name: "y" },
  display: { label: "Vendas", role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } } }] as unknown as Bot[];
const approval = (id: string, extra: Partial<Approval> = {}): Approval => ({
  request_id: id, bot: "vendas", surface: "gateway", mechanism: "command", source: "run", digest: `d-${id}`,
  command_redacted: "chmod 600 /tmp/x", description: "Proteger o arquivo", pattern_keys: ["chmod"], allowed_choices: ["once", "deny"],
  action_class_hash: "same", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  status: "pending", ...extra,
} as Approval);

/** `later`: what the approvals list says about each reason after the deny (what the backend settles when the run ends). */
function backend(answer: unknown, later: Record<string, boolean | null>) {
  let decided = false;
  const ids = [...new Set(["r1", "r2", ...Object.keys(later)])];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "c", actor: "x", auth_mode: "gated" };
    if (method === "GET" && url.includes("/approvals"))
      return { approvals: ids.map((id) => approval(id, decided ? { status: "consumed", decided_choice: "deny", reason_delivered: later[id] } : {})) };
    if (method === "POST") { decided = true; return answer; }
    throw new Error("unexpected " + method + " " + url);
  });
  return later;  // the test changes it to say what the backend settled
}
const tick = (n = 1) => act(async () => { for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(FOLLOW_MS); });
async function denyInInbox() {
  render(<ApprovalsInbox bots={bots} authMode="gated" />);
  const card = await screen.findByTestId("approval-card-r1");
  fireEvent.click(within(card).getByRole("button", { name: /negar…/i }));
  const modal = screen.getByRole("dialog");
  fireEvent.change(within(modal).getByLabelText(/motivo da negação/i), { target: { value: "Não mande para esse lead." } });
  fireEvent.click(within(modal).getByRole("button", { name: /confirmar negação/i }));
}

beforeEach(() => { cleanup(); resetCsrfToken(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); setCustomFetchJSON(null); });

describe("a reason still being sent (reason_delivered null)", () => {
  it("inbox: 'Enviando…' first, then 'entregue' only once the approval says true", async () => {
    const later = backend({ approval: approval("r1", { status: "consumed" }), reason_delivered: null }, { r1: null });
    await denyInInbox();
    expect(await screen.findByText(new RegExp(SENDING))).toBeTruthy();
    expect(screen.queryByText(/entregue ao Bot como/)).toBeNull();
    await tick(2);
    expect(screen.queryByText(/entregue ao Bot como/)).toBeNull();                 // still null: still sending, never "entregue"
    later.r1 = true;                                                                  // the run ended with nothing pending
    await tick(2);
    expect(await screen.findByText(new RegExp(DELIVERED.replace(/\./g, "\\.")))).toBeTruthy();
  });

  it("in the conversation card: 'Enviando…', then false is the kept sentence", async () => {
    const frame: Record<string, any> = { ...parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8")), luvebot_digest: "dg" };
    backend({ approval: approval("r1"), reason_delivered: null }, { [frame.request_id]: false });
    render(<InlineApproval frame={frame} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Negar…"));
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "não" } });
    fireEvent.click(screen.getByText("Confirmar negação"));
    expect(await screen.findByText(SENDING)).toBeTruthy();
    await tick(2);
    expect(await screen.findByText(KEPT)).toBeTruthy();
    expect(screen.queryByText(DELIVERED)).toBeNull();
  });

  it("still null when it stops asking: no confirmation yet, never 'entregue'", async () => {
    backend({ approval: approval("r1", { status: "consumed" }), reason_delivered: null }, { r1: null });
    await denyInInbox();
    await screen.findByText(new RegExp(SENDING));
    await tick(FOLLOW_TRIES);                                                      // (the final word hides itself 4 s later)
    expect(await screen.findByText(new RegExp(UNKNOWN))).toBeTruthy();
    expect(screen.queryByText(/entregue ao Bot como/)).toBeNull();
  });

  it("a batch: delivered only when every reason is; sending while any is", async () => {
    expect(reasonsState([true, true])).toBe("delivered");
    expect(reasonsState([true, null])).toBe("sending");
    expect(reasonsState([true, false])).toBe("kept");
    expect(reasonsState([undefined])).toBe("kept");
    backend({ approvals: [approval("r1", { reason_delivered: null }), approval("r2", { reason_delivered: true })], failed: [] }, { r1: true, r2: true });
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    for (const id of ["r1", "r2"]) fireEvent.click(within(await screen.findByTestId(`approval-card-${id}`)).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /negar selecionados/i }));
    const modal = screen.getByRole("dialog");
    fireEvent.change(within(modal).getByLabelText(/motivo da negação/i), { target: { value: "Lote recusado." } });
    fireEvent.click(within(modal).getByRole("button", { name: /confirmar decisão em lote/i }));
    expect(await screen.findByText(new RegExp(SENDING))).toBeTruthy();
    await tick(2);
    expect(await screen.findByText(new RegExp(DELIVERED.replace(/\./g, "\\.")))).toBeTruthy();
  });
});
