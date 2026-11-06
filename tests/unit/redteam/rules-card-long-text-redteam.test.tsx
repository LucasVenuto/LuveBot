// tests/unit/redteam/rules-card-long-text-redteam.test.tsx
// Red team (Lume, 31/10), the question of A-206: does the screen where a person reviews and activates a rule show a Bot-proposed pattern of 512 characters, with a long tail, in FULL and legible?
// MEASURED in headless Chrome on the real component (evidence/rules-suggestion/ of the role, README): the card (RulesView.tsx, the one a suggestion, its draft and an active rule share) holds the whole text in the DOM and cuts nothing
// (the first test), but draws the command, the tool and the condition as a `font-mono` chip of a flex-wrap row, and the label as an h3, with NO break rule: a text with no space is ONE line. 512 characters of `a` are 3711 px wide on a 1068 px card
// (about 148 characters on screen at 1100 px, about 45 on a phone; the rest is reachable only by scrolling an inner container 2.7 thousand px sideways), and the TAIL, the part that makes a glob costly, is exactly what is off screen. With spaces it wraps
// (4 lines at 1100 px, 11 on a phone). A 200-character tool chip overflows by 408 px at 1100, a 400-character path condition by 1860, a 120-character label by 470 on a phone. The approval cards already say `overflowWrap: "anywhere"`; RuleSuggestions too.
// jsdom has no layout, so the tests read the declaration that makes the text wrap (`overflow-wrap: anywhere` or `word-break: break-all`, inline or as a class; `break-word` does NOT do it on a flex item, its min-content stays the whole word). CLOSED by R-12 (A-208): the four tests of F-A206-1 were `it.fails` and are plain tests now; the same card (a suggestion, a draft with Activate and an active rule share it) is checked in its three states. The pixel measure (scrollWidth <= clientWidth at 390 and 1100 px) is a real-browser one, the Lume's (evidence/rules-suggestion/); here the declaration is what is read. The model of the fix was patches/redteam-a206-cartao-da-regra-conserto-prova.diff.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { setLuveLocale } from "@/i18n";
import type { Rule, RuleWithSeal } from "@/api/types";

const COMMAND = "*" + "a".repeat(510) + "b", TOOL = "t".repeat(200), LABEL = "L".repeat(120), PATH = "/" + "p".repeat(400);
const rule: Rule = {
  id: "r-long", label: LABEL, level: "allow", scope: { kind: "bot", ref: "vendas" },
  match: { tools: [TOOL], commands: [COMMAND], conditions: [{ fact: "path", op: "eq", value: PATH }] },
  state: "suggestion", origin: "bot_suggestion", builtin: false, version: 1, updated_by: "bot:vendas",
} as Rule;
const rules: RuleWithSeal[] = [{ rule, seal_result: { seal: "none" } }];

const WRAPS = /(^|[\s:])break-all(\s|$)|wrap-anywhere|overflow-wrap:\s*anywhere/;
/** Does the element, or an ancestor inside the card, carry a declaration that lets an unbroken text wrap? */
function wraps(el: HTMLElement): boolean {
  const card = el.closest("[data-testid^='rule-card-']");
  for (let e: HTMLElement | null = el; e && e !== card?.parentElement; e = e.parentElement) {
    if (e.style.overflowWrap === "anywhere" || e.style.wordBreak === "break-all" || WRAPS.test(e.className || "")) return true;
  }
  return false;
}
const chip = (text: string) => screen.getByText(text, { selector: "span" });
const draw = () => { setLuveLocale("pt"); render(<RulesView bots={[]} authMode="gated" initialRules={rules} />); };

describe("the card of a Bot-proposed rule (suggestion state)", () => {
  afterEach(() => cleanup());

  it("holds the whole text of the command, the tool, the path and the label, cut by nothing (the data is not the problem)", () => {
    draw();
    expect(chip(COMMAND).textContent).toBe(COMMAND);
    expect(chip(TOOL).textContent).toBe(TOOL);
    expect(chip(PATH).textContent).toBe(PATH);
    expect(screen.getByRole("heading", { name: LABEL }).textContent).toBe(LABEL);
    for (const el of [chip(COMMAND), chip(TOOL), chip(PATH)]) {
      expect(el.style.textOverflow).toBe("");
      expect(el.className).not.toMatch(/truncate|line-clamp|text-ellipsis/);
    }
  });

  it("the control of the reader: the text that RuleSuggestions draws wraps (the codebase knows the declaration)", () => {
    expect(readFileSync(path.resolve(__dirname, "../../../dashboard/src/components/rules/RuleSuggestions.tsx"), "utf8")).toContain('overflowWrap: "anywhere"');
  });

  it("F-A206-1: the command chip wraps, so a pattern of 512 characters with no space is read whole (3711 px on a 1068 px card today)", () => {
    draw();
    expect(wraps(chip(COMMAND))).toBe(true);
  });

  it("F-A206-1: the tool chip wraps (200 characters: 1457 px, 408 px past the card)", () => {
    draw();
    expect(wraps(chip(TOOL))).toBe(true);
  });

  it("F-A206-1: the path condition chip wraps (400 characters: 2909 px, 1860 px past the card)", () => {
    draw();
    expect(wraps(chip(PATH))).toBe(true);
  });

  it("F-A206-1: the label wraps (120 characters: 919 px, 470 px past the card on a phone)", () => {
    draw();
    expect(wraps(screen.getByRole("heading", { name: LABEL }))).toBe(true);
  });
});

describe("the same card for a draft with Activate and for an active rule (A-208: one card, no dialog)", () => {
  afterEach(() => cleanup());
  for (const state of ["draft", "active"] as const) {
    it(`${state}: the command, the tool, the path and the label wrap, and each holds its last character in the text the person sees`, () => {
      setLuveLocale("pt");
      render(<RulesView bots={[]} authMode="gated" initialRules={[{ rule: { ...rule, id: `r-${state}`, state, origin: "human", updated_by: "ceo" } as Rule, seal_result: { seal: "none" } }]} />);
      for (const [el, text] of [[chip(COMMAND), COMMAND], [chip(TOOL), TOOL], [chip(PATH), PATH], [screen.getByRole("heading", { name: LABEL }), LABEL]] as const) {
        expect(wraps(el)).toBe(true);
        expect(el.textContent).toBe(text);
        expect(el.textContent!.slice(-1)).toBe(text.slice(-1));         // the tail is what narrows a rule: it is on the card
      }
    });
  }
});
