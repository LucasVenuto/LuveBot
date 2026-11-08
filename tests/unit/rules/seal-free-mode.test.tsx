// tests/unit/rules/seal-free-mode.test.tsx
// Invariant 8 + modo Livre: a rule that asks, on a Bot in Free mode, comes from the backend with the problem `free_mode`. When it is the
// ONLY problem, Regras says it calmly (same line as "Aprovações") instead of the red "Problemas detectados"; the seal stays broken.
// Any other problem next to it (hook_stale…) is a real break and keeps the normal alarm. Read from the SealResult only.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { onlyFreeMode } from "@/components/rules/seal";
import { setLuveLocale } from "@/i18n";

const FREE = { code: "free_mode", detail: "the Bot is in Free mode" };
const STALE = { code: "hook_stale", detail: "the hook has not reported in 90 s" };
const rule = (id: string) => ({ id, label: id, level: "ask", scope: { kind: "global", ref: null }, match: { commands: ["rm -rf"] }, state: "active", origin: "human", builtin: false, version: 1 });
const RULES = [
  { rule: rule("only.free"), seal_result: { seal: "broken", problems: [FREE] } },
  { rule: rule("free.stale"), seal_result: { seal: "broken", problems: [FREE, STALE] } },
  { rule: rule("only.stale"), seal_result: { seal: "broken", problems: [STALE] } },
] as any[];

beforeEach(() => { cleanup(); setLuveLocale("pt"); });
afterEach(() => setLuveLocale("pt"));

describe("Regras: free_mode sozinho é dito com calma", () => {
  it("onlyFreeMode: true only when free_mode is the whole list", () => {
    expect(onlyFreeMode({ seal: "broken", problems: [FREE] })).toBe(true);
    expect(onlyFreeMode({ seal: "broken", problems: [FREE, STALE] })).toBe(false);
    expect(onlyFreeMode({ seal: "broken", problems: [STALE] })).toBe(false);
    expect(onlyFreeMode({ seal: "broken", problems: [] })).toBe(false);
    expect(onlyFreeMode({ seal: "broken" })).toBe(false);
    expect(onlyFreeMode(undefined)).toBe(false);
  });

  it("free_mode only: calm line, no red box, and the seal is still the backend's (broken)", () => {
    render(<RulesView authMode="gated" initialRules={RULES} />);
    const card = within(screen.getByTestId("rule-card-only.free"));
    expect(card.getByTestId("rule-free-why-only.free").textContent).toBe("Não pergunta: Bot no modo Livre.");
    expect(card.queryByTestId("rule-problems-only.free")).toBeNull();
    expect(card.getByTestId("seal-broken")).toBeTruthy();
  });

  it("free_mode + hook_stale, or hook_stale alone: no calm line; the real problems are listed as always", () => {
    render(<RulesView authMode="gated" initialRules={RULES} />);
    for (const id of ["free.stale", "only.stale"]) {
      const card = within(screen.getByTestId(`rule-card-${id}`));
      expect(card.queryByTestId(`rule-free-why-${id}`), id).toBeNull();
      expect(card.getByTestId(`rule-problems-${id}`).textContent, id).toContain("hook_stale");
    }
    expect(screen.getByTestId("rule-problems-free.stale").textContent).toContain("free_mode");
  });

  it("in English", () => {
    setLuveLocale("en");
    render(<RulesView authMode="gated" initialRules={RULES} />);
    expect(screen.getByTestId("rule-free-why-only.free").textContent).toBe("Does not ask: Bot in Free mode.");
  });
});
