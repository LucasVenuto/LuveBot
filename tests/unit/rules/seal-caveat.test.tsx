// tests/unit/rules/seal-caveat.test.tsx
// Invariant 8 (T13.9, Forja's rules-equivalent-forms): every rule by command pattern now carries the "pattern" qualifier, also
// on a HAND (before only on LOCK). A real HAND or LOCK with it says what it covers ("…para as formas que o padrão reconhece")
// and, in one short line, why (inline code, a command built at run time, scripts and aliases are not read). From the
// SealResult only: no qualifier, or a seal that is not a real HAND/LOCK, shows no caveat. In Regras and in "Onde aprovar".
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { ApprovalSurfaceCard } from "@/components/agent/ApprovalSurfaceCard";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const HAND = "Aprovação real para as formas que o padrão reconhece.";
const LOCK = "Bloqueio real para as formas que o padrão reconhece.";
const WHY = "O padrão lê o comando como foi escrito: código inline, comando montado na execução, scripts e alias não são lidos.";
const rule = (id: string, level: string) => ({ id, label: id, level, scope: { kind: "global", ref: null }, match: { commands: ["rm -rf"] }, state: "active", origin: "builtin", builtin: true, version: 1 });
const RULES = [
  { rule: rule("ask.pattern", "ask"), seal_result: { seal: "hand", problems: [], qualifiers: ["pattern"] } },
  { rule: rule("block.pattern", "block"), seal_result: { seal: "lock", problems: [], qualifiers: ["pattern", "channel_dm:telegram"] } },
  { rule: rule("ask.plain", "ask"), seal_result: { seal: "hand", problems: [], qualifiers: [] } },
  { rule: rule("ask.broken", "ask"), seal_result: { seal: "broken", problems: [{ code: "x", detail: "y" }], qualifiers: ["pattern"] } },
  { rule: rule("guide.pattern", "guide"), seal_result: { seal: "note", problems: [], qualifiers: ["pattern"] } },
] as any[];

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("the 'pattern' caveat next to a real seal", () => {
  it("Regras: HAND and LOCK with 'pattern' say what they cover and why; without it, broken or a note, nothing", () => {
    render(<RulesView authMode="gated" initialRules={RULES} />);
    const card = (id: string) => within(screen.getByTestId(`rule-card-${id}`));
    expect(card("ask.pattern").getByTestId("seal-caveat").textContent).toBe(HAND + WHY);
    expect(card("block.pattern").getByTestId("seal-caveat").textContent).toBe(LOCK + WHY);
    for (const id of ["ask.plain", "ask.broken", "guide.pattern"]) expect(card(id).queryByTestId("seal-caveat"), id).toBeNull();
    expect(card("ask.pattern").getByTestId("seal-hand")).toBeTruthy();                 // the seal itself is unchanged
  });

  it("'Onde aprovar': the Bot's ask rule by pattern carries the caveat under its name", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.includes("/approval-surface")) return { approval_surface: { bot: "default", mode: "luvebot", approvers: [], platforms: ["telegram"], allow_all: false, allow_all_reason: null, applied: true, applied_reason: "applied", hook_version: "0.3.1", updated_at: null, updated_by: null } };
      if (url.includes("/rules")) return { rules: RULES.filter((x) => x.rule.level === "ask") };
      return {};
    });
    render(<ApprovalSurfaceCard bot="default" />);
    const row = (await screen.findByText("ask.pattern")).closest("li") as HTMLElement;
    expect(within(row).getByTestId("seal-caveat").textContent).toBe(HAND + WHY);
    expect(within(screen.getByText("ask.plain").closest("li") as HTMLElement).queryByTestId("seal-caveat")).toBeNull();
  });

  it("in English too", () => {
    setLuveLocale("en");
    render(<RulesView authMode="gated" initialRules={RULES} />);
    expect(within(screen.getByTestId("rule-card-block.pattern")).getByTestId("seal-caveat").textContent)
      .toBe("Real block for the forms the pattern recognizes.The pattern reads the command as written: inline code, a command built at run time, scripts and aliases are not read.");
  });
});
