// tests/unit/approvals/plain-words.test.tsx
// Screens say what happens in words; ids and codes wait behind a collapsed "Detalhe técnico" (guide photos 03/10): the inbox
// card's header says the tool, not "hook_approve"; a "Sempre permitir" draft is named by the Bot and the rule's own label,
// never "Permitir uma vez plugin_rule:luvebot:<id>#… vendas", in the inbox and in the conversation's card alike.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { parseSse } from "@/components/transcript";

const RULE = "builtin.sensitive_access.commands";
const KEY = `plugin_rule:luvebot:${RULE}#5.a9689614b77c41ed896cd9d298d7be1e`;
const row = {
  request_id: "req-p", bot: "vendas", surface: "run", mechanism: "hook_approve", source: "run", run_id: "run_f12eeb0225d049",
  digest: "c".repeat(64), command_redacted: "chmod 600 /tmp/luvebot-demo/follow-up.txt", description: `luvebot:${RULE}`,
  pattern_keys: [KEY], allowed_choices: ["once", "deny"], tool: "terminal", rule_id: RULE, action_class_hash: "h",
  created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300e3).toISOString(), status: "pending",
};
const bots = [{ name: "vendas", is_default: false, display: { label: "Vendas", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } }, status: "idle" }] as any;

beforeEach(() => {
  cleanup();
  resetCsrfToken();
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "tester", auth_mode: "gated" };
    if (url.includes("/approvals")) return { ok: true, approvals: [row], total: 1 };
    if (url.includes("/rules")) return { rules: [{ rule: { id: RULE, label: "Acesso sensível (comandos)" } }] };
    return {};
  });
});

describe("plain words first, ids in a collapsed technical detail", () => {
  it("inbox: the header says the tool, and a draft is named by the Bot and the rule's label", async () => {
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const card = await screen.findByTestId("approval-card-req-p");
    await waitFor(() => expect(card.textContent).toContain("Acesso sensível (comandos)"));
    expect(within(card).getByText("Comando no terminal")).toBeTruthy();
    const technical = within(card).getByTestId("approval-technical-req-p");
    expect(technical.textContent).toContain("hook_approve");
    expect(technical.textContent).toContain(KEY);
    // the long pattern key used to run off a phone screen: inside the detail it wraps anywhere
    expect((technical.querySelector("pre") as HTMLElement).style.overflowWrap).toBe("anywhere");
    expect((technical as HTMLDetailsElement).open).toBe(false);
    const firstRead = card.textContent!.replace(technical.textContent!, "");
    expect(firstRead).not.toMatch(/hook_approve|plugin_rule|digest|run_f12/);
    fireEvent.click(within(card).getByRole("button", { name: /sempre permitir…/i }));
    const field = within(screen.getByRole("dialog")).getByRole("textbox") as HTMLInputElement;
    expect(field.value).toBe("Vendas: permitir Acesso sensível (comandos)");
  });

  it("the conversation's card names its draft the same way", async () => {
    const FRAME = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));
    const frame = { ...FRAME, request_id: "req-p", luvebot_digest: "dg", command: "<terminal> (plugin approval rule)", description: `luvebot:${RULE}`, pattern_key: KEY };
    render(<InlineApproval frame={frame} bot="Vendas" runId="run_f12eeb0225d049" pending />);
    await screen.findByText(/Acesso sensível \(comandos\)/);
    fireEvent.click(screen.getByRole("button", { name: /sempre permitir/i }));
    const field = await waitFor(() => {
      const input = document.querySelector("input") as HTMLInputElement | null;
      expect(input).not.toBeNull();
      return input!;
    });
    expect(field.value).toBe("Vendas: permitir Acesso sensível (comandos)");
    expect(field.value).not.toContain("plugin_rule");
  });
});
