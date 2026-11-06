// tests/unit/redteam/always-allow-draft-error-redteam.test.tsx
// Red team (Lume, 31/10), the last question of A-211: "does the code reach the answer of Sempre permitir, and not a generic draft_not_saved?"
// The BACKEND is honest: POST .../resolve returns `{ approval, draft_error: <code> }` and no `draft_rule` when "Sempre permitir" decided the request ONCE and could not make the draft
// (backend/approvals.py `_draft`: the RuleError code, `noncanonical_action`, `command_too_long`, `multiple_paths`, `unusable_path`..., or `draft_not_saved`; tests/invariants/test_approvals.py:267), and A-210/A-211 add
// `fold_divergence` (an U+00DF, U+03C2 or U+1E9E in the approved command). The SCREEN is not: both surfaces that send it, the inbox (ApprovalsInbox.tsx `handleConfirmAlways`) and the card in the conversation (InlineApproval.tsx `decide`), DROP the
// answer (`await resolveApproval(...)`: `draft_error` is not even in `ResolveApprovalResponse`) and say "regra criada em rascunho" / "a regra ficou em rascunho" whatever came back. So a person who clicks "Sempre permitir" on a
// command the engine refused to turn into a rule is told a rule exists. That is reachable TODAY (a command that touches two files, or is too long, or is not canonical) and A-211 widens it to every command with an U+00DF.
// It is not a bypass (no rule is safe: the person is asked again) but the screen states what is not true (the honest-state principle of invariant 8, on the control a person trusts most). CLOSED by R-15 (A-211): the screen reads the code and says the rule was NOT saved (the twelve tests were `it.fails`).
// Reference fix (a model, not a patch): patches/redteam-a211-sempre-permitir-conserto-prova.diff. The sentence for the code itself is R-15 (Vitral); here: the false claim goes away and the person is told no draft was made.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { parseSse } from "@/components/transcript";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Approval, Bot } from "@/api/types";

const CODES = ["noncanonical_action", "multiple_paths", "command_too_long", "unusable_path", "draft_not_saved", "fold_divergence"];
const CLAIM = /regra criada em rascunho|a regra ficou em rascunho|a regra ainda é só um rascunho/i;

const bots = [{ name: "vendas", is_default: false, display: { label: "Vendas", role: "Vendas", color: "#60a5fa", avatar: { kind: "emoji", value: "x" } }, description: "", model: { provider: "x", name: "y" }, status: "waiting_approval" }] as unknown as Bot[];
const pending: Approval = {
  request_id: "req-1", bot: "vendas", surface: "gateway", mechanism: "command", source: "transport", digest: "d".repeat(64), command_redacted: "curl -X POST https://api.example.com/sync",
  description: "Sync", pattern_keys: ["curl"], allowed_choices: ["once", "deny", "always"], action_class_hash: "h", created_at: new Date(Date.now() - 60000).toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(), status: "pending",
} as Approval;

type Call = { method: string; url: string; body?: any };
function inboxBackend(answer: (body: any) => object) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "tester", auth_mode: "gated" };
    if (method === "GET" && url.includes("/approvals")) return { ok: true, approvals: [pending], total: 1 };
    if (method === "POST" && url.includes("/resolve")) return answer(body);
    throw new Error(`Unexpected call: ${method} ${url}`);
  });
  return calls;
}
const decided = (body: any) => ({ ok: true, approval: { request_id: "req-1", status: "decided", decided_choice: body?.choice } });

async function alwaysInInbox() {
  render(<ApprovalsInbox bots={bots} authMode="gated" />);
  const card = await screen.findByTestId("approval-card-req-1");
  fireEvent.click(within(card).getByRole("button", { name: /sempre permitir…/i }));
  fireEvent.click(screen.getByRole("button", { name: /criar rascunho e permitir uma vez/i }));
}

describe("Sempre permitir in the inbox", () => {
  beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); setLuveLocale("pt"); });
  afterEach(() => { cleanup(); setCustomFetchJSON(null); });

  it("control: when the backend made the draft, the screen says so", async () => {
    inboxBackend((body) => ({ ...decided(body), draft_rule: { id: "aa-1", label: body.draft_rule.label, state: "draft" } }));
    await alwaysInInbox();
    expect(await screen.findByText(CLAIM)).toBeTruthy();
  });

  it("control: the request is decided ONCE either way (the approval row is decided, so the person is not asked twice)", async () => {
    const calls = inboxBackend((body) => ({ ...decided(body), draft_error: "noncanonical_action" }));
    await alwaysInInbox();
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/resolve") && c.body.choice === "once")).toBe(true));
  });

  for (const code of CODES) {
    it(`F-A211-1: with draft_error "${code}" the screen does not say a rule was created`, async () => {
      inboxBackend((body) => ({ ...decided(body), draft_error: code }));
      await alwaysInInbox();
      await waitFor(() => expect(screen.getAllByRole("status").length + screen.queryAllByText(/resolvida uma vez/i).length).toBeGreaterThan(0));
      expect(document.body.textContent).not.toMatch(CLAIM);
    });
  }
});

describe("Sempre permitir in the card of the conversation", () => {
  const real = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));
  const stored = { ...real, luvebot_digest: "dg-123" };
  beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); setLuveLocale("pt"); });
  afterEach(() => { cleanup(); setCustomFetchJSON(null); });
  const backend = (answer: () => object) => setCustomFetchJSON(async (url: string, init?: RequestInit) => (url.endsWith("/session") ? { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" } : answer()));

  async function always() {
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText("Sempre permitir…"));
    fireEvent.click(screen.getByText("Criar rascunho e permitir uma vez"));
  }

  it("control: when the backend made the draft, the card says the rule is a draft", async () => {
    backend(() => ({ approval: { status: "decided" }, draft_rule: { id: "aa-1", label: "x", state: "draft" } }));
    await always();
    expect(await screen.findByText(CLAIM)).toBeTruthy();
  });

  for (const code of CODES) {
    it(`F-A211-1: with draft_error "${code}" the card does not say the rule was saved`, async () => {
      backend(() => ({ approval: { status: "decided" }, draft_error: code }));
      await always();
      await screen.findByRole("status");
      expect(document.body.textContent).not.toMatch(CLAIM);
    });
  }
});
