// tests/unit/rules/seal-per-bot.test.tsx
// Invariant 8, VPS 2026-10-02: on the default Bot's "Onde aprovar", builtin.delete_permanent.commands and
// builtin.unknown_software.commands showed "Quebrado" while GET /rules?bot=default said hand for all four ask rules. Cause:
// the card asked GET /rules WITHOUT bot, where a global rule's seal is the aggregate over every Bot (broken if any Bot is,
// problems prefixed "<bot>: …"). A screen about one Bot asks ?bot=<bot> and shows exactly that seal. Same for the Bot's Regras.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import { ApprovalSurfaceCard } from "@/components/agent/ApprovalSurfaceCard";
import { RulesView } from "@/components/rules";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

// the four ask rules of the capture, as the backend answers each route
const IDS = ["builtin.delete_permanent", "builtin.delete_permanent.commands", "builtin.unknown_software", "builtin.unknown_software.commands"];
const rule = (id: string) => ({ id, label: id, level: "ask", scope: { kind: "global", ref: null }, match: {}, state: "active", origin: "builtin", builtin: true, version: 1 });
const aggregate = IDS.map((id) => ({ rule: rule(id), seal_result: id.endsWith(".commands")
  ? { seal: "broken", problems: ["marketing: the hook does not see this command surface"], qualifiers: [] }
  : { seal: "hand", problems: [], qualifiers: [] } }));
const perBot = IDS.map((id) => ({ rule: rule(id), seal_result: { seal: "hand", problems: [], qualifiers: ["channel_dm:telegram"] } }));
// the card lists only active "ask" rules: a block rule and a draft come back from the route but are not shown there
const others = [{ rule: { ...rule("builtin.block_rm_root"), level: "block" }, seal_result: { seal: "lock", problems: [], qualifiers: [] } },
  { rule: { ...rule("rascunho.pedir_email"), state: "draft", origin: "human", builtin: false }, seal_result: { seal: "hand", problems: [], qualifiers: [] } }];

let asked: string[];
beforeEach(() => {
  cleanup(); resetCsrfToken(); asked = [];
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
    if (url.includes("/approval-surface")) return { approval_surface: { bot: "default", mode: "channel", approvers: ["telegram:1"], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.3.1", updated_at: null, updated_by: null } };
    if (url.includes("/rules")) {
      asked.push(url);
      return { rules: new URL(url, "http://x").searchParams.get("bot") === "default" ? [...others, ...perBot] : aggregate };
    }
    return {};
  });
});
afterEach(() => setCustomFetchJSON(null));

describe("a screen about one Bot shows that Bot's seal (GET /rules?bot=)", () => {
  it("'Onde aprovar' of the default Bot: the four ask rules carry the seal of /rules?bot=default, never the aggregate", async () => {
    render(<ApprovalSurfaceCard bot="default" />);
    await screen.findByText("builtin.unknown_software.commands");
    expect(asked).toEqual(["/api/plugins/luvebot/rules?bot=default"]);
    const rows = IDS.map((id) => screen.getByText(id).closest("li") as HTMLElement);
    for (const row of rows) {
      expect(within(row).getByTestId("seal-hand")).toBeTruthy();
      expect(within(row).queryByTestId("seal-broken")).toBeNull();
    }
    expect(screen.queryByText("builtin.block_rm_root")).toBeNull();
    expect(screen.queryByText("rascunho.pedir_email")).toBeNull();
  });

  it("the Bot's own Regras page asks ?bot= too; the global Regras keeps the aggregate (that is what it shows)", async () => {
    render(<RulesView authMode="gated" botName="default" />);
    await waitFor(() => expect(asked).toContain("/api/plugins/luvebot/rules?bot=default"));
    await waitFor(() => expect(screen.getAllByTestId("seal-hand").length).toBeGreaterThanOrEqual(IDS.length));
    expect(screen.queryAllByTestId("seal-broken")).toHaveLength(0);
    cleanup(); asked = [];
    render(<RulesView authMode="gated" />);
    await waitFor(() => expect(asked).toEqual(["/api/plugins/luvebot/rules"]));
    await waitFor(() => expect(screen.getAllByTestId("seal-broken").length).toBe(2));
  });
});
