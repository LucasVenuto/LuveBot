// tests/unit/rules/fold-divergence.test.tsx
// R-13 gives the server a code of its own, `fold_divergence`, for an allow whose pattern names a letter (the sharp s, the final sigma) that the engine's case fold and the network's resolvers read differently. The screen has no
// sentence for a code it has not seen: it must say this one in words, PT and EN, never the raw code, where a person MEETS it: the rule editor (create) and the activation of a draft (contract v0.11 section 8, R-15, A-211). A stored
// rule that the engine now reads as broken says it on its card too (the seal's list of problems). The words of "Always allow" are in tests/unit/approvals/always-not-saved.test.tsx.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Rule, RuleWithSeal } from "@/api/types";

const PT = "Esta regra cita uma letra (como ß ou ς) que o LuveBot e a rede leem de jeitos diferentes, então não pode liberar o comando. Escreva o endereço só em ASCII (xn--…) ou use o nível Perguntar.";
const EN = "This rule names a letter (such as ß or ς) that LuveBot and the network read differently, so it cannot allow the command. Write the address in plain ASCII (xn--…) or use the Ask level.";
const BOTS = [{ name: "vendas", is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle", display: { label: "Vendas", role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } } } as Bot];
const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, label: `Regra ${id}`, level: "allow", scope: { kind: "bot", ref: "vendas" }, match: { tools: ["terminal"], commands: ["curl *"] }, state: "draft", origin: "human", builtin: false, version: 1, ...over,
} as Rule);
const withSeal = (r: Rule, seal: Partial<RuleWithSeal["seal_result"]> = {}): RuleWithSeal => ({ rule: r, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [], ...seal } });
const refusal = () => new ApiError({ code: "fold_divergence", message: "English for developers: a permissive rule names a folded letter.", status: 422 } as never);

let refuse: ApiError | null;
beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-c"); refuse = null;
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/suggestions")) return { suggestions: [] };
    if (method !== "GET" && url.includes("/rules")) { if (refuse) throw refuse; return { rule: rule("novo"), seal_result: { seal: "hand" } }; }
    return { rules: [] };
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); });

const view = (initialRules: RuleWithSeal[] = []) => render(<RulesView bots={BOTS} authMode="gated" initialRules={initialRules} />);
const create = (label = "Permitir curl") => {
  fireEvent.click(screen.getAllByRole("button", { name: /Nova regra|New rule/ })[0]);
  fireEvent.change(screen.getByLabelText(/Nome \/ Rótulo da regra|Rule Name \/ Label/), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: /Criar rascunho|Create draft/ }));
};

describe("the rule editor (create)", () => {
  it("says it in Portuguese, inside the editor, in words and not as the code", async () => {
    refuse = refusal();
    view(); create();
    const alert = await screen.findByTestId("create-rule-error");
    expect(alert.textContent).toContain(PT);
    expect(alert.textContent).not.toContain("fold_divergence");                      // the code waits behind "Detalhe técnico", closed
    expect(alert.textContent).not.toContain("English for developers");               // the server's own English is never shown
    expect(screen.getByRole("dialog")).toBeDefined();                                  // the editor stays open, with what was typed
  });

  it("and in English", async () => {
    setLuveLocale("en");
    refuse = refusal();
    view(); create();
    const alert = await screen.findByTestId("create-rule-error");
    expect(alert.textContent).toContain(EN);
    expect(alert.textContent).not.toContain("fold_divergence");
  });
});

describe("activating a draft", () => {
  it("the refusal of the activation is said in words, in both languages", async () => {
    refuse = refusal();
    view([withSeal(rule("r1"))]);
    fireEvent.click(screen.getByRole("button", { name: "Ativar regra" }));
    await waitFor(() => expect(document.body.textContent).toContain(PT));
    expect(document.body.textContent).not.toContain("fold_divergence");
    cleanup(); setLuveLocale("en");
    view([withSeal(rule("r2"))]);
    fireEvent.click(screen.getByRole("button", { name: /Activate rule/ }));
    await waitFor(() => expect(document.body.textContent).toContain(EN));
  });
});

describe("a stored rule the engine now reads as broken", () => {
  it("the seal's problem is the sentence, not the server's English detail (the code stays beside it, as for every problem)", () => {
    view([withSeal(rule("a"), { seal: "broken", problems: [{ code: "fold_divergence", detail: "English detail of the server" }] })]);
    const box = screen.getByTestId("rule-problems-a");
    expect(within(box).getByText(/Esta regra cita uma letra/).textContent).toContain(PT);
    expect(box.textContent).not.toContain("English detail of the server");
  });
});
