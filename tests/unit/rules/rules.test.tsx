// tests/unit/rules/rules.test.tsx
// Unit tests for Rules and Governance view (spec §4.10, contract v0.1 §3, ADR-002).
// Invariant 8: Seal is honest and derived strictly from backend SealResult (never inferred from rule.level).
// Broken seal displays exact problems and qualifiers.
// Drafts are visually distinct and have NO effect.
// Activation requires human click and is blocked in loopback mode (D-012, loopback_not_human).
// Agent suggestions appear as pending suggestions and can never be active (Red Team 6).
// Builtin rules are immutable.
// Simulator executes POST /rules/simulate and displays decision, winner and hits.

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import type { RuleWithSeal, Simulation } from "@/api/types";

const mockRulesWithSeals: RuleWithSeal[] = [
  {
    rule: {
      id: "builtin.delete_permanent",
      label: "Confirmar apagar permanentemente",
      level: "ask",
      scope: { kind: "global" },
      match: { tools: ["*delete*", "*destroy*"], commands: ["rm *-r*", "rm *-f*"] },
      state: "active",
      origin: "builtin",
      builtin: true,
      version: 1,
    },
    seal_result: {
      seal: "hand",
      mechanisms: [{ id: "hook", verified: true, covers: ["*delete*"] }],
      problems: [],
      qualifiers: [],
    },
  },
  {
    rule: {
      id: "rule-block-curl",
      label: "Bloquear requisições curl externas",
      level: "block",
      scope: { kind: "bot", ref: "vendas" },
      match: { commands: ["curl *"] },
      state: "active",
      origin: "human",
      builtin: false,
      version: 2,
    },
    seal_result: {
      seal: "broken", // INVARIANT 8: Level is block, but seal is broken!
      mechanisms: [],
      problems: [
        {
          code: "toolset_still_enabled",
          detail: "Toolset ainda habilitado no perfil vendas",
        },
      ],
      qualifiers: ["writes_only"],
    },
  },
  {
    rule: {
      id: "rule-lock-mcp",
      label: "Desligar servidor MCP financeiro",
      level: "block",
      scope: { kind: "global" },
      match: { mcp_servers: ["finance_mcp"] },
      state: "active",
      origin: "human",
      builtin: false,
      version: 3,
    },
    seal_result: {
      seal: "lock",
      mechanisms: [{ id: "mcp_toggle", verified: true, covers: ["finance_mcp"] }],
      problems: [],
      qualifiers: [],
    },
  },
  {
    rule: {
      id: "rule-draft-install",
      label: "Permitir npm install para dev",
      level: "allow",
      scope: { kind: "bot", ref: "dev" },
      match: { commands: ["npm install *"] },
      state: "draft",
      origin: "always_allow",
      builtin: false,
      version: 1,
    },
    seal_result: {
      seal: "note",
      mechanisms: [],
      problems: [],
      qualifiers: [],
    },
  },
  {
    rule: {
      id: "rule-suggestion-email",
      label: "Sugestão: perguntar antes de enviar e-mail em massa",
      level: "ask",
      scope: { kind: "bot", ref: "vendas" },
      match: { tools: ["send_bulk_email"] },
      state: "suggestion",
      origin: "bot_suggestion",
      builtin: false,
      version: 1,
    },
    seal_result: {
      seal: "note",
      mechanisms: [],
      problems: [],
      qualifiers: [],
    },
  },
];

type CapturedCall = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
};

function setupFetchMock(opts: {
  rules?: RuleWithSeal[];
  authMode?: string;
  patchError?: ApiError;
  simulationResponse?: Simulation;
} = {}) {
  const calls: CapturedCall[] = [];
  const rulesList = opts.rules ?? [...mockRulesWithSeals];
  const authMode = opts.authMode ?? "gated";

  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers, body });

    if (url.endsWith("/session")) {
      return { csrf: "csrf-token-test-123", actor: "tester", auth_mode: authMode };
    }

    if (method === "GET" && url.includes("/rules")) {
      return { ok: true, rules: rulesList };
    }

    if (method === "PATCH" && url.endsWith("/rules")) {
      if (opts.patchError) throw opts.patchError;
      const found = rulesList.find((r) => r.rule.id === body?.id);
      const updatedRule = found
        ? { ...found.rule, state: body?.state || found.rule.state, version: found.rule.version + 1 }
        : { id: body?.id, state: body?.state, version: 2 };
      return {
        ok: true,
        rule: updatedRule,
        seal_result: found?.seal_result || { seal: "note" },
      };
    }

    if (method === "POST" && url.endsWith("/rules")) {
      return {
        ok: true,
        rule: {
          id: `rule-custom-${Date.now()}`,
          label: body?.label,
          level: body?.level,
          scope: body?.scope,
          match: body?.match,
          state: "draft",
          origin: "human",
          builtin: false,
          version: 1,
        },
        seal_result: { seal: "note", mechanisms: [], problems: [], qualifiers: [] },
      };
    }

    if (method === "POST" && url.endsWith("/rules/simulate")) {
      if (opts.simulationResponse) return opts.simulationResponse;
      return {
        ok: true,
        decision: {
          effect: "ask",
          winner: "builtin.delete_permanent",  // the rule id, as backend/rules.py Decision.winner sends it
          hits: [
            {
              rule_id: "builtin.delete_permanent",
              level: "ask",
              scope: { kind: "global" },
              builtin: true,
              matched_on: "rm *-r*",
            },
          ],
          reason: "ask_beats_allow",  // a backend ReasonCode (backend/rules.py), as the real route sends it
        },
        seals: {},
      };
    }

    throw new Error(`Unexpected call: ${method} ${url}`);
  });

  return { calls };
}

describe("Tela de Regras e Governança (RulesView)", () => {
  beforeEach(() => {
    resetCsrfToken();
  });

  it("renders 4 levels + block with honest seals (lock, hand, note, broken)", async () => {
    setupFetchMock();
    render(<RulesView authMode="gated" />);

    expect(await screen.findByText("Confirmar apagar permanentemente")).toBeDefined();
    expect(screen.getByText("Bloquear requisições curl externas")).toBeDefined();
    expect(screen.getByText("Desligar servidor MCP financeiro")).toBeDefined();
    expect(screen.getByText("Permitir npm install para dev")).toBeDefined();

    // Verify 4 seal states are present in the DOM
    expect(screen.getByTestId("seal-lock")).toBeDefined();
    expect(screen.getByTestId("seal-hand")).toBeDefined();
    expect(screen.getAllByTestId("seal-note").length).toBeGreaterThan(0);
    expect(screen.getByTestId("seal-broken")).toBeDefined();
  });

  it("Invariant 8: UI NEVER shows seal without SealResult and NEVER infers seal from rule.level", async () => {
    // Test rule with level 'block' but seal 'broken'
    setupFetchMock();
    render(<RulesView authMode="gated" />);

    await screen.findByText("Bloquear requisições curl externas");

    const curlCard = screen.getByTestId("rule-card-rule-block-curl");
    // INVARIANT 8: Although level is 'block', seal MUST be 'broken' (not 'lock')
    expect(within(curlCard).getByTestId("seal-broken")).toBeDefined();
    expect(within(curlCard).queryByTestId("seal-lock")).toBeNull();
  });

  it("Estado quebrado mostra o problema: displays problem codes and details when seal is broken", async () => {
    setupFetchMock();
    render(<RulesView authMode="gated" />);

    await screen.findByText("Bloquear requisições curl externas");

    const curlCard = screen.getByTestId("rule-card-rule-block-curl");
    expect(within(curlCard).getByTestId("seal-broken")).toBeDefined();
    expect(within(curlCard).getByText(/Problemas detectados no selo de execução/i)).toBeDefined();
    expect(within(curlCard).getByText("toolset_still_enabled")).toBeDefined();
    expect(within(curlCard).getByText(/Toolset ainda habilitado no perfil vendas/i)).toBeDefined();
    expect(within(curlCard).getByText(/writes_only/i)).toBeDefined();
  });

  it("Rascunho visualmente distinto e sem efeito: displays draft badge and inative notice", async () => {
    setupFetchMock();
    render(<RulesView authMode="gated" />);

    await screen.findByText("Permitir npm install para dev");

    const draftCard = screen.getByTestId("rule-card-rule-draft-install");
    expect(within(draftCard).getByTestId("badge-draft")).toBeDefined();
    expect(within(draftCard).getByText("Rascunho (sem efeito)")).toBeDefined();
    expect(within(draftCard).getByText(/Rascunho inativo — ative para aplicar/i)).toBeDefined();
    expect(within(draftCard).getByRole("button", { name: /ativar regra/i })).toBeDefined();
  });

  it("Ativar exige clique humano e envia PATCH /rules com versão e CSRF", async () => {
    const { calls } = setupFetchMock();
    render(<RulesView authMode="gated" />);

    await screen.findByText("Permitir npm install para dev");
    const draftCard = screen.getByTestId("rule-card-rule-draft-install");
    const activateBtn = within(draftCard).getByRole("button", { name: /ativar regra/i });

    fireEvent.click(activateBtn);

    await waitFor(() => {
      const patchCall = calls.find((c) => c.url.endsWith("/rules") && c.method === "PATCH");
      expect(patchCall).toBeDefined();
      expect(patchCall?.body).toEqual({
        id: "rule-draft-install",
        version: 1,
        state: "active",
      });
      expect(patchCall?.headers["x-luvebot-csrf"]).toBe("csrf-token-test-123");
    });
  });

  it("Loopback auth mode: activation is read-only and disabled (Contract §1 & D-012 loopback_not_human)", async () => {
    const { calls } = setupFetchMock({ authMode: "loopback" });
    render(<RulesView authMode="loopback" />);

    await screen.findByText("Permitir npm install para dev");

    // Loopback alert is displayed
    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText(/Modo loopback ativo/i)).toBeDefined();
    expect(screen.getByText(/loopback_not_human/i)).toBeDefined();

    const draftCard = screen.getByTestId("rule-card-rule-draft-install");
    const activateBtn = within(draftCard).getByRole("button", { name: /ativar regra/i });
    expect((activateBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(activateBtn);

    const patchCalls = calls.filter((c) => c.method === "PATCH");
    expect(patchCalls.length).toBe(0);
  });

  it("Deployment auth mode (the deployment token, a machine): activation is disabled, in the credential's words and never loopback's (v0.11 5.1)", async () => {
    const { calls } = setupFetchMock({ authMode: "deployment" });
    render(<RulesView authMode="deployment" />);
    await screen.findByText("Permitir npm install para dev");
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Este acesso não é um login que o LuveBot reconheça como de uma pessoa");
    expect(banner.textContent).not.toMatch(/loopback/i);
    const draftCard = screen.getByTestId("rule-card-rule-draft-install");
    const activateBtn = within(draftCard).getByRole("button", { name: /ativar regra/i }) as HTMLButtonElement;
    expect(activateBtn.disabled).toBe(true);
    expect(activateBtn.getAttribute("title")).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    fireEvent.click(activateBtn);
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(0);
  });

  it("a session that answers a mode nobody knows, or none, is not a person: activation is off (only `gated` decides)", async () => {
    for (const authMode of ["", "service", "GATED"]) {
      cleanup();
      setupFetchMock({ authMode });
      render(<RulesView />);
      await screen.findByText("Permitir npm install para dev");
      const btn = within(screen.getByTestId("rule-card-rule-draft-install")).getByRole("button", { name: /ativar regra/i }) as HTMLButtonElement;
      await waitFor(() => expect(btn.disabled, JSON.stringify(authMode)).toBe(true));
    }
  });

  it("an activation the server refuses with 403 credential_not_human (the screen could not tell) says it in the credential's words, never loopback's", async () => {
    setupFetchMock({ patchError: new ApiError({ code: "credential_not_human", message: "x", status: 403 }) });
    render(<RulesView authMode="gated" />);
    await screen.findByText("Permitir npm install para dev");
    fireEvent.click(within(screen.getByTestId("rule-card-rule-draft-install")).getByRole("button", { name: /ativar regra/i }));
    const alert = await screen.findByText(/não é um login que o LuveBot reconheça como de uma pessoa/);
    expect(alert.textContent).toContain("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(document.body.textContent).not.toMatch(/Modo loopback ativo/);
  });

  it("the same refusal names the provider it refused behind 'Detalhe técnico' (DT-1b), never in the sentence", async () => {
    setupFetchMock({ patchError: new ApiError({ code: "credential_not_human", message: "x", status: 403, details: { provider: "acme" } }) });
    render(<RulesView authMode="gated" />);
    await screen.findByText("Permitir npm install para dev");
    fireEvent.click(within(screen.getByTestId("rule-card-rule-draft-install")).getByRole("button", { name: /ativar regra/i }));
    const alert = await screen.findByText(/não é um login que o LuveBot reconheça como de uma pessoa/);
    expect(alert.textContent).not.toContain("acme");
    fireEvent.click(screen.getByRole("button", { name: "Detalhe técnico" }));
    expect(document.querySelector(".lb-error-code")!.textContent).toBe("credential_not_human (acme)");
  });

  it("a 403 that names no code still gets the loopback words (as before)", async () => {
    setupFetchMock({ patchError: new ApiError({ code: "forbidden", message: "x", status: 403 }) });
    render(<RulesView authMode="gated" />);
    await screen.findByText("Permitir npm install para dev");
    fireEvent.click(within(screen.getByTestId("rule-card-rule-draft-install")).getByRole("button", { name: /ativar regra/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/loopback/i));
    expect(document.body.textContent).not.toMatch(/login que o LuveBot reconheça como de uma pessoa/);
  });

  it("Sugestão de agente nunca aparece como ativa (Red Team 6)", async () => {
    setupFetchMock();
    render(<RulesView authMode="gated" />);

    await screen.findByText("Sugestão: perguntar antes de enviar e-mail em massa");

    const suggestionCard = screen.getByTestId("rule-card-rule-suggestion-email");
    expect(within(suggestionCard).getByTestId("badge-suggestion")).toBeDefined();
    expect(within(suggestionCard).getByText("Sugestão do Bot (pendente de revisão)")).toBeDefined();

    // Must NOT have direct "Ativar regra" button; has "Revisar como rascunho"
    expect(within(suggestionCard).queryByRole("button", { name: /^ativar regra$/i })).toBeNull();
    expect(within(suggestionCard).getByRole("button", { name: /revisar como rascunho/i })).toBeDefined();
  });

  it("Regras embutidas são imutáveis (builtin: true)", async () => {
    setupFetchMock();
    render(<RulesView authMode="gated" />);

    await screen.findByText("Confirmar apagar permanentemente");

    const builtinCard = screen.getByTestId("rule-card-builtin.delete_permanent");
    expect(within(builtinCard).getByTestId("badge-builtin")).toBeDefined();
    expect(within(builtinCard).getByText(/Embutida \(imutável\)/i)).toBeDefined();

    // No edit, archive, or activate buttons
    expect(within(builtinCard).queryByRole("button", { name: /arquivar/i })).toBeNull();
    expect(within(builtinCard).queryByRole("button", { name: /ativar/i })).toBeNull();
  });

  it("Simulador: executes POST /rules/simulate and renders decision, winner, and hits", async () => {
    const { calls } = setupFetchMock();
    render(<RulesView authMode="gated" />);

    // Switch to Simulador tab
    const simTabBtn = screen.getByRole("tab", { name: /simulador/i });
    fireEvent.click(simTabBtn);

    expect(screen.getByText("Simulador de Ações e Precedência de Regras")).toBeDefined();

    const toolInput = screen.getByLabelText(/nome da ferramenta/i);
    fireEvent.change(toolInput, { target: { value: "exec_command" } });

    const cmdInput = screen.getByLabelText(/comando executado/i);
    fireEvent.change(cmdInput, { target: { value: "rm -rf /" } });

    const simulateBtn = screen.getByRole("button", { name: /simular ação/i });
    fireEvent.click(simulateBtn);

    await waitFor(() => {
      const simCall = calls.find((c) => c.url.endsWith("/rules/simulate"));
      expect(simCall).toBeDefined();
      expect(simCall?.method).toBe("POST");
      expect(simCall?.body).toEqual({
        bot: "vendas",
        tool: "exec_command",
        command: "rm -rf /",
      });
    });

    const resultBox = await screen.findByTestId("simulation-result");
    expect(resultBox).toBeDefined();
    expect(within(resultBox).getAllByText(/3\. Perguntar antes/i).length).toBe(2);  // the decision and the hit's level, in words
    // the winner and the hit by the rule's own name; ids, the raw level and what matched only in the collapsed technical detail
    expect(within(resultBox).getAllByText("Confirmar apagar permanentemente").length).toBe(2);
    const technical = within(resultBox).getByTestId("simulation-technical");
    expect(technical.textContent).toContain("builtin.delete_permanent");
    expect(technical.textContent).toContain("rm *-r*");
    const firstRead = resultBox.textContent!.replace(technical.textContent!, "");
    expect(firstRead).not.toMatch(/builtin\.delete_permanent|\bask\b|rm \*-r\*/);
    // the reason code reads as words, never the raw code (guide photos, 03/10: "Motivo: single_rule")
    expect(within(resultBox).getByText(/Perguntar vence permitir: a regra que pede confirmação prevalece/i)).toBeDefined();
    expect(firstRead).not.toContain("ask_beats_allow");  // the code itself only in the technical detail
  });

  it("Mutation check: computing seal from rule.level in UI (instead of SealResult) leaves test red", () => {
    // When a rule has level 'block' and seal_result { seal: 'broken' },
    // the UI MUST display seal-broken and MUST NOT display seal-lock.
    render(
      <RulesView
        authMode="gated"
        initialRules={[
          {
            rule: {
              id: "mutation-test-rule",
              label: "Regra para teste de mutação",
              level: "block", // Level is block!
              scope: { kind: "global" },
              match: { commands: ["*"] },
              state: "active",
              origin: "human",
              builtin: false,
              version: 1,
            },
            seal_result: {
              seal: "broken", // SealResult is broken!
              problems: [{ code: "test_problem", detail: "Problema teste" }],
            },
          },
        ]}
      />
    );

    const card = screen.getByTestId("rule-card-mutation-test-rule");
    // Invariant 8 assertion:
    expect(within(card).getByTestId("seal-broken")).toBeDefined();
    expect(within(card).queryByTestId("seal-lock")).toBeNull();
  });
});
