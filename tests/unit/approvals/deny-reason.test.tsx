// tests/unit/approvals/deny-reason.test.tsx
// The deny modal promised "Ele será entregue ao Bot como instrução humana…" while the backend answers reason_delivered=false
// (R-4, b3 pending). Before the decision nothing is promised: the reason is recorded in LuveBot and its audit. After it, the
// resolve response says what happened: only reason_delivered === true says it reached the Bot; false or absent (the batch route
// does not report it) says it stayed in LuveBot. When the backend starts delivering, the same code says so on its own.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { parseSse } from "@/components/transcript";
import { denyReasonOutcome } from "@/components/approvals/decide";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Approval, Bot } from "@/api/types";

const KEPT = "O motivo ficou registrado no LuveBot e na auditoria; ele não foi entregue ao Bot.";
const DELIVERED = "O motivo foi entregue ao Bot como instrução humana.";

const bots = [{ name: "vendas", is_default: true, display: { label: "Vendas", role: "Vendas B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } },
  description: "", model: { provider: "x", name: "y" }, status: "waiting_approval" }] as unknown as Bot[];
const approval = (id: string, digest: string): Approval => ({
  request_id: id, bot: "vendas", surface: "gateway", mechanism: "command", source: "transport", digest,
  command_redacted: "curl -X POST https://api.crm.internal/sync", description: "Sincronização com o CRM", pattern_keys: ["curl"],
  allowed_choices: ["once", "deny"], action_class_hash: "hash-curl", created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(), status: "pending",
} as Approval);

/** `delivered`: what the backend says in reason_delivered; undefined = an older backend that does not say. */
function backend(delivered: boolean | undefined) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "tester", auth_mode: "gated" };
    if (method === "GET" && url.includes("/approvals")) return { approvals: [approval("req-1", "d1"), approval("req-2", "d2")] };
    if (method === "POST" && url.endsWith("/approvals/batch")) return { approvals: [], failed: [] };
    if (method === "POST" && /approval/.test(url))
      return { approval: { request_id: "req-1", status: "consumed" }, ...(delivered === undefined ? {} : { reason_delivered: delivered }) };
    throw new Error("unexpected " + method + " " + url);
  });
}

async function denyInInbox() {
  render(<ApprovalsInbox bots={bots} authMode="gated" />);
  const card = await screen.findByTestId("approval-card-req-1");
  fireEvent.click(within(card).getByRole("button", { name: /negar…/i }));
  const modal = screen.getByRole("dialog");
  fireEvent.change(within(modal).getByLabelText(/motivo da negação/i), { target: { value: "Endpoint não homologado." } });
  return modal;
}

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("the deny reason: promised only when the backend says it was delivered", () => {
  it("the modal promises no delivery before the decision; it says where the reason is kept", async () => {
    backend(false);
    const modal = await denyInInbox();
    expect(within(modal).queryByText(/entregue ao Bot/)).toBeNull();
    expect(within(modal).queryByText(/instrução humana/)).toBeNull();
    expect(within(modal).getByText(/fica registrado no LuveBot e na auditoria/)).toBeTruthy();
    expect((within(modal).getByLabelText(/motivo da negação/i) as HTMLTextAreaElement).placeholder).not.toMatch(/ao Bot/);
  });

  it("inbox, reason_delivered=false: says it stayed in LuveBot and the audit, never that the Bot got it", async () => {
    backend(false);
    const modal = await denyInInbox();
    fireEvent.click(within(modal).getByRole("button", { name: /confirmar negação/i }));
    expect(await screen.findByText(new RegExp(KEPT.replace(/[.;]/g, "\\$&")))).toBeTruthy();
    expect(screen.queryByText(new RegExp(DELIVERED.replace(/\./g, "\\.")))).toBeNull();
  });

  it("inbox, reason_delivered=true (once b3 lands): says it was delivered", async () => {
    backend(true);
    const modal = await denyInInbox();
    fireEvent.click(within(modal).getByRole("button", { name: /confirmar negação/i }));
    expect(await screen.findByText(new RegExp(DELIVERED.replace(/\./g, "\\.")))).toBeTruthy();
    expect(screen.queryByText(/não foi entregue/)).toBeNull();
  });

  it("batch deny: the route does not report delivery, so none is claimed", async () => {
    backend(true);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    for (const id of ["req-1", "req-2"]) fireEvent.click(within(await screen.findByTestId(`approval-card-${id}`)).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /negar selecionados/i }));
    const modal = screen.getByRole("dialog");
    fireEvent.change(within(modal).getByLabelText(/motivo da negação/i), { target: { value: "Lote recusado." } });
    fireEvent.click(within(modal).getByRole("button", { name: /confirmar decisão em lote/i }));
    expect(await screen.findByText(/não foi entregue ao Bot/)).toBeTruthy();
    expect(screen.queryByText(/instrução humana/)).toBeNull();
  });

  it("in the conversation card: the same rule, from that route's response", async () => {
    const frame = { ...parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8")), luvebot_digest: "dg" };
    for (const [delivered, expected, absent] of [[false, KEPT, DELIVERED], [undefined, KEPT, DELIVERED], [true, DELIVERED, KEPT]] as const) {
      cleanup(); resetCsrfToken(); backend(delivered);
      render(<InlineApproval frame={frame} bot="vendas" runId="run_r1" pending />);
      expect(screen.queryByText(/entregue ao Bot/)).toBeNull();  // nothing said before the decision
      fireEvent.click(screen.getByText("Negar…"));
      fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "não apague nada" } });
      fireEvent.click(screen.getByText("Confirmar negação"));
      await screen.findByText("Negada.");
      expect(screen.getByText(expected)).toBeTruthy();
      expect(screen.queryByText(absent)).toBeNull();
    }
  });

  it("only an explicit true counts as delivered", () => {
    expect(denyReasonOutcome({ reason_delivered: true })).toBe("denyReasonDelivered");
    for (const r of [{ reason_delivered: false }, { reason_delivered: "true" }, {}, null, undefined]) expect(denyReasonOutcome(r)).toBe("denyReasonKept");
  });
});
