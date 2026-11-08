// tests/unit/rules/hermes-gate.test.tsx
// F6.3 / C-4: the simulator says side by side what LuveBot would do and what HERMES's own gate would do with the command. The remedy for
// "I turned Free on and it still asks". Every sentence is ours, by the backend's verdict / caveat / reason code; Hermes's text never shows;
// Free on the LuveBot side comes from the winning rule's SealResult (problem free_mode), not from the level.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { HermesGateRow } from "@/components/rules/HermesGate";
import { RulesView } from "@/components/rules";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { HermesGate, SealResult, RuleLevel } from "@/api/types";

const FREE_SEAL: SealResult = { seal: "broken", problems: [{ code: "free_mode", detail: "the Bot is in free mode" }] };
const ok = (verdict: any, over: Partial<Extract<HermesGate, { available: true }>> = {}): HermesGate => ({ available: true, verdict, rule: null, env_type: "local", caveats: [], ...over });
const row = (gate: HermesGate | null | undefined, effect: RuleLevel = "ask", winnerSeal?: SealResult) =>
  render(<HermesGateRow gate={gate} effect={effect} winnerSeal={winnerSeal} />);

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("simulador: LuveBot e Hermes lado a lado", () => {
  it("nothing when the backend sends no hermes_gate (older backend) or null (not a terminal command)", () => {
    for (const g of [undefined, null]) { const r = row(g); expect(screen.queryByTestId("hermes-gate")).toBeNull(); r.unmount(); }
  });

  it("a Free Bot: 'LuveBot: não pergunta (Livre)' next to what Hermes would do, and says plainly that Hermes still asks", () => {
    row(ok("ask"), "ask", FREE_SEAL);
    expect(screen.getByTestId("gate-luvebot").textContent).toBe("não pergunta (Livre)");
    expect(screen.getByTestId("gate-hermes").textContent).toBe("pediria aprovação");
    expect(screen.getByText("Neste Bot o LuveBot não pergunta, mas o Hermes ainda pediria a sua aprovação aqui.")).toBeTruthy();
  });

  it("the four Hermes verdicts, each in its own words; a Free Bot also hears when Hermes would block", () => {
    const words: Record<string, string> = { allow: "liberaria", ask: "pediria aprovação", hardline_deny: "bloquearia (proteção fixa do Hermes)", user_deny: "bloquearia (negado na configuração do Hermes)" };
    for (const [v, w] of Object.entries(words)) { const r = row(ok(v)); expect(screen.getByTestId("gate-hermes").textContent).toBe(w); r.unmount(); }
    row(ok("hardline_deny"), "ask", FREE_SEAL);
    expect(screen.getByText("Neste Bot o LuveBot não pergunta, mas o Hermes bloquearia isto.")).toBeTruthy();
  });

  it("not Free: the LuveBot side says what the level does; 'Livre' is claimed only when the winning seal says free_mode", () => {
    const sides: Array<[RuleLevel, string]> = [["ask", "pede sua aprovação"], ["block", "bloqueia"], ["handback", "devolve ao Bot"], ["allow", "deixa passar"]];
    for (const [lv, w] of sides) { const r = row(ok("allow"), lv); expect(screen.getByTestId("gate-luvebot").textContent).toBe(w); r.unmount(); }
    row(ok("ask"), "ask", { seal: "hand", problems: [] });
    expect(screen.getByTestId("gate-luvebot").textContent).toBe("pede sua aprovação");     // an ask on a Bot that is not Free
    expect(screen.queryByText(/o Hermes ainda pediria/)).toBeNull();
  });

  it("caveats in words: approvals_off explains why Hermes would allow; an unknown code says nothing", () => {
    row(ok("allow", { caveats: ["approvals_off", "session_yolo_not_seen", "docker_host_access_not_seen", "something_new"] }));
    const t = screen.getByTestId("hermes-gate").textContent!;
    expect(t).toContain("As aprovações do Hermes estão desligadas neste Bot (approvals.mode: off): por isso ele liberaria sem perguntar.");
    expect(t).toContain("/yolo ou --yolo");
    expect(t).toContain("container (docker)");
    expect(t).not.toContain("something_new");
  });

  it("the dry run could not be done: says why in words, and the LuveBot side is still there", () => {
    const reasons: Array<[string, string]> = [
      ["hermes_without_dry_run", "Este Hermes não tem o teste de aprovação, então não dá para dizer o que ele faria."],
      ["unreadable", "Não foi possível perguntar ao Hermes o que ele faria agora."],
      ["command_too_long", "O comando é grande demais para o teste do Hermes; encurte para ver o que ele faria."],
      ["whatever_new", "Não foi possível perguntar ao Hermes o que ele faria agora."],
    ];
    for (const [reason, said] of reasons) {
      const r = row({ available: false, reason } as HermesGate, "block");
      expect(screen.getByTestId("hermes-gate-note").textContent).toBe(said);
      expect(screen.getByTestId("gate-luvebot").textContent).toBe("bloqueia");
      expect(screen.queryByTestId("gate-hermes")).toBeNull();
      r.unmount();
    }
  });

  it("a verdict this UI does not know is not guessed", () => {
    row(ok("maybe"), "ask");
    expect(screen.queryByTestId("gate-hermes")).toBeNull();
    expect(screen.getByTestId("hermes-gate-note").textContent).toBe("Não foi possível perguntar ao Hermes o que ele faria agora.");
  });

  it("Hermes's own text never shows: a rule pattern or detail in the payload is left out of the screen", () => {
    row(ok("ask", { rule: "recursive delete <b>x</b>", detail: "secret hint" } as any));
    expect(screen.getByTestId("hermes-gate").textContent).not.toMatch(/recursive delete|secret hint/);
  });

  it("in English", () => {
    setLuveLocale("en");
    row(ok("ask"), "ask", FREE_SEAL);
    expect(screen.getByTestId("gate-luvebot").textContent).toBe("does not ask (Free)");
    expect(screen.getByTestId("gate-hermes").textContent).toBe("would ask for approval");
    expect(screen.getByText("On this Bot LuveBot does not ask, but Hermes would still ask for your approval here.")).toBeTruthy();
  });

  it("the simulator asks the backend ONLY when the person submits: not on a keystroke, not on a Bot or tab change (the Hermes dry run is a call to Hermes)", async () => {
    let simulated = 0;
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (init?.method === "POST" && url.endsWith("/rules/simulate")) { simulated++; return { decision: { effect: "allow", winner: null, hits: [] }, hermes_gate: ok("allow") }; }
      return {};
    });
    render(<RulesView authMode="gated" initialRules={[]} bots={[{ name: "vendas" }, { name: "dev" }] as any} />);
    fireEvent.click(screen.getByRole("tab", { name: /simulador/i }));
    fireEvent.change(screen.getByLabelText(/nome da ferramenta/i), { target: { value: "terminal" } });
    for (const v of ["r", "rm", "rm -r", "rm -r x"]) fireEvent.change(screen.getByLabelText(/comando executado/i), { target: { value: v } });
    fireEvent.change(document.getElementById("sim-bot-select")!, { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("tab", { name: /regras|ativas/i }));
    fireEvent.click(screen.getByRole("tab", { name: /simulador/i }));
    await new Promise((r) => setTimeout(r, 80));
    expect(simulated).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /simular ação/i }));
    await screen.findByTestId("simulation-result");
    expect(simulated).toBe(1);
    fireEvent.change(screen.getByLabelText(/comando executado/i), { target: { value: "ls" } });   // editing after a result asks nothing either
    await new Promise((r) => setTimeout(r, 80));
    expect(simulated).toBe(1);
  });

  it("in the simulator: the answer's hermes_gate shows with the result, the winning rule's seal tells Free", async () => {
    const rule = { id: "r.ask", label: "Perguntar antes de apagar", level: "ask", scope: { kind: "global", ref: null }, match: { commands: ["rm"] }, state: "active", origin: "human", builtin: false, version: 1 };
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (init?.method === "POST" && url.endsWith("/rules/simulate"))
        return { decision: { effect: "ask", winner: "r.ask", hits: [{ rule_id: "r.ask", level: "ask", scope: { kind: "global", ref: null }, builtin: false, matched_on: "rm" }], reason: "rule" },
          seals: { "r.ask": FREE_SEAL }, hermes_gate: ok("ask") };
      throw new Error("unexpected " + url);
    });
    render(<RulesView authMode="gated" initialRules={[{ rule, seal_result: FREE_SEAL }] as any} />);
    fireEvent.click(screen.getByRole("tab", { name: /simulador/i }));
    fireEvent.change(screen.getByLabelText(/nome da ferramenta/i), { target: { value: "terminal" } });
    fireEvent.change(screen.getByLabelText(/comando executado/i), { target: { value: "rm -r x" } });
    fireEvent.click(screen.getByRole("button", { name: /simular ação/i }));
    const result = await screen.findByTestId("simulation-result");
    await waitFor(() => expect(within(result).getByTestId("gate-luvebot").textContent).toBe("não pergunta (Livre)"));
    expect(within(result).getByTestId("gate-hermes").textContent).toBe("pediria aprovação");
  });
});
