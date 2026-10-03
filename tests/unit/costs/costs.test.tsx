// tests/unit/costs/costs.test.tsx
// Unit tests for Costs and Budget management view (spec §4.13, contract v0.2 §4).
// Invariant 7: Honest UI - only display spend and ceilings from backend (never estimated or hardcoded).
// Loopback enforcement (D-014 / A-29): lowering ceilings allowed; raising/removing ceilings and resuming bots are blocked (loopback_not_human).
// Resuming a paused bot requires explicit human click and confirmation.
// Values in integer cents formatted according to locale.

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CostsView, formatCents } from "@/components/costs";
import { setCustomFetchJSON, resetCsrfToken, setCachedCsrf } from "@/api/client";
import type { CostsResponse, BudgetSnapshot } from "@/api/types";
import { setLuveLocale } from "@/i18n";

const mockCostsData: CostsResponse = {
  period: "day",
  currency: "USD",
  totals: {
    spend_cents: 4520, // $45.20
    unpriced_sessions: 2,
  },
  groups: [
    { key: "vendas", spend_cents: 2500, tokens: 45000, sessions: 12 },
    { key: "dev", spend_cents: 2020, tokens: 32000, sessions: 8 },
  ],
  ledger: {
    lag_s: 15,
    watcher_stale: false,
  },
};

const mockBudgetData: BudgetSnapshot = {
  limits: [
    {
      scope: "global",
      period: "day",
      cents: 10000, // $100.00
      spent_cents: 4520,
      reserved_cents: 500,
      percent: 45,
    },
    {
      scope: "bot",
      ref: "vendas",
      period: "day",
      cents: 5000, // $50.00
      spent_cents: 2500,
      percent: 50,
    },
    {
      scope: "bot",
      ref: "pesquisa",
      period: "day",
      cents: 500, // $5.00
      spent_cents: 550,
      percent: 110,
    },
    {
      scope: "routine",
      ref: "cron-blocked",
      period: "day",
      cents: 0, // Cap 0: blocked
      spent_cents: 0,
      percent: 0,
    },
  ],
  paused: [
    {
      bot: "pesquisa",
      since: 1761800000000,
      plan_status: "teto diário atingido",
    },
  ],
  watcher: {
    last_at: 1761801000000,
    stale: false,
  },
  alerts: [
    {
      scope: "bot",
      ref: "pesquisa",
      percent: 110,
    },
  ],
};

interface RecordedCall {
  url: string;
  method: string;
  body?: any;
  headers?: Record<string, string>;
}

function setupFetchMock(options?: {
  authMode?: "loopback" | "gated";
  costs?: CostsResponse;
  budget?: BudgetSnapshot;
  failCosts?: boolean;
  failBudget?: boolean;
}) {
  const calls: RecordedCall[] = [];
  const currentCosts = options?.costs || mockCostsData;
  const currentBudget = options?.budget || mockBudgetData;
  const authMode = options?.authMode || "gated";

  setCachedCsrf("csrf-token-costs-test");

  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method || "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    let body: any = undefined;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    calls.push({ url, method, body, headers });

    if (url.endsWith("/session")) {
      return { auth_mode: authMode };
    }

    if (url.includes("/costs")) {
      if (options?.failCosts) {
        throw new Error("Falha ao carregar custos");
      }
      return currentCosts;
    }

    if (url.endsWith("/budget")) {
      if (options?.failBudget) {
        throw new Error("Falha ao carregar orçamento");
      }
      return currentBudget;
    }

    if (url.endsWith("/budget/limits") && method === "PUT") {
      return { ok: true, limit: body };
    }

    if (url.includes("/budget/resume") && method === "POST") {
      return { ok: true, bot: "pesquisa", resumed: true };
    }

    return {};
  });

  return { calls };
}

describe("Costs and Budget View (Contract v0.2 §4, spec §4.13)", () => {
  beforeEach(() => {
    setLuveLocale("pt");
    resetCsrfToken();
  });

  describe("formatCents Utility", () => {
    it("formats integer cents to USD currency according to locale", () => {
      // In English
      expect(formatCents(4520, "en")).toBe("$45.20");
      expect(formatCents(0, "en")).toBe("$0.00");
      expect(formatCents(123456, "en")).toBe("$1,234.56");

      // In Portuguese
      const pt4520 = formatCents(4520, "pt");
      expect(pt4520).toContain("45,20");
      const pt0 = formatCents(0, "pt");
      expect(pt0).toContain("0,00");
    });
  });

  describe("Invariant 7: Honest UI (No values without backend data)", () => {
    it("renders loading or empty states and NEVER displays hardcoded spend or ceiling numbers when backend has not responded", () => {
      // Render without initial data and custom fetch that does not resolve immediately
      setCustomFetchJSON(async () => new Promise(() => {}));

      render(<CostsView authMode="gated" />);

      // Should show loading text
      expect(screen.getAllByText("Carregando bots").length).toBeGreaterThan(0);

      // Must NOT render any spend numbers or totals
      expect(screen.queryByTestId("total-spend-card")).toBeNull();
      expect(screen.queryByTestId("total-spend-amount")).toBeNull();
      expect(screen.queryByText("$45.20")).toBeNull();
    });

    it("displays error message if backend costs or budget fetch fails without showing estimated values", async () => {
      setupFetchMock({ failCosts: true, failBudget: true });

      render(<CostsView authMode="gated" />);

      await waitFor(() => {
        expect(screen.getByText("Erro ao carregar dados de custos.")).toBeDefined();  // our words, never the thrown text
      });

      // No estimated values
      expect(screen.queryByTestId("total-spend-amount")).toBeNull();
    });
  });

  describe("Spend Overview Tab (GET /costs)", () => {
    it("renders total spend, ledger lag, unpriced sessions, and group breakdowns strictly from backend", async () => {
      setupFetchMock();
      render(<CostsView authMode="gated" />);

      // Wait for data load
      await screen.findByTestId("total-spend-amount");

      // Total spend formatted
      const totalAmountEl = screen.getByTestId("total-spend-amount");
      expect(totalAmountEl.textContent).toContain("45,20");

      // Unpriced sessions notice
      expect(screen.getByText("2 sessões sem precificação do modelo")).toBeDefined();

      // Ledger lag and badge
      const lagSecondsEl = screen.getByTestId("ledger-lag-seconds");
      expect(lagSecondsEl.textContent).toBe("15s de atraso");
      expect(screen.getAllByTestId("badge-ledger").length).toBeGreaterThan(0);

      // Groups table rows
      expect(screen.getByTestId("cost-group-row-vendas")).toBeDefined();
      expect(screen.getByTestId("cost-group-spend-vendas").textContent).toContain("25,00");

      expect(screen.getByTestId("cost-group-row-dev")).toBeDefined();
      expect(screen.getByTestId("cost-group-spend-dev").textContent).toContain("20,20");
    });

    it("displays stale watcher warning when ledger.watcher_stale is true", async () => {
      const staleCosts: CostsResponse = {
        ...mockCostsData,
        ledger: { lag_s: 350, watcher_stale: true },
      };
      setupFetchMock({ costs: staleCosts });

      render(<CostsView authMode="gated" />);

      await screen.findByTestId("total-spend-amount");
      expect(
        screen.getByText("Watcher desatualizado: novos runs podem ser recusados (watcher_stale)")
      ).toBeDefined();
    });
  });

  describe("Budget Ceilings Tab (GET /budget & PUT /budget/limits)", () => {
    it("renders active budget limits, percentages, and cap 0 block warning", async () => {
      setupFetchMock();
      render(<CostsView authMode="gated" />);

      // Switch to limits tab
      const limitsTabBtn = screen.getByRole("button", { name: "Tetos e Limites" });
      fireEvent.click(limitsTabBtn);

      await screen.findByTestId("budget-limit-card-global-all-day");

      // Global limit card
      const globalCard = screen.getByTestId("budget-limit-card-global-all-day");
      expect(within(globalCard).getByText("Global")).toBeDefined();
      expect(within(globalCard).getByText("Diário")).toBeDefined();
      expect(within(globalCard).getByTestId("badge-ledger")).toBeDefined();

      // Cap 0 (blocked) card
      const blockedCard = screen.getByTestId("budget-limit-card-routine-cron-blocked-day");
      expect(within(blockedCard).getByText("Teto 0: todo trabalho bloqueado para este escopo")).toBeDefined();
    });
  });

  describe("Paused Bots & Human-only Resume (POST /bots/{bot}/budget/resume)", () => {
    it("shows paused bots with breach reason and requires explicit human click and confirmation modal", async () => {
      const { calls } = setupFetchMock();
      render(<CostsView authMode="gated" />);

      // Switch to paused bots tab
      const pausedTabBtn = screen.getByRole("button", { name: /bots pausados/i });
      fireEvent.click(pausedTabBtn);

      await screen.findByTestId("paused-bot-pesquisa");

      const pausedCard = screen.getByTestId("paused-bot-pesquisa");
      expect(within(pausedCard).getByText("pesquisa")).toBeDefined();
      expect(within(pausedCard).getByText("Motivo: Estouro de teto orçamentário (teto diário atingido)")).toBeDefined();

      // Click "Retomar Bot"
      const resumeBtn = within(pausedCard).getByRole("button", { name: /retomar bot/i });
      fireEvent.click(resumeBtn);

      // Must open confirmation modal (human click requirement)
      const modal = await screen.findByTestId("modal-resume-confirmation");
      expect(modal).toBeDefined();
      expect(within(modal).getByText(/Tem certeza de que deseja retomar o bot 'pesquisa'/i)).toBeDefined();

      // No resume call dispatched before explicit confirmation
      const resumeCallsBefore = calls.filter((c) => c.url.includes("/budget/resume"));
      expect(resumeCallsBefore.length).toBe(0);

      // Click confirm in modal
      const confirmBtn = within(modal).getByRole("button", { name: "Confirmar Retomada" });
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const resumeCall = calls.find((c) => c.url.includes("/bots/pesquisa/budget/resume"));
        expect(resumeCall).toBeDefined();
        expect(resumeCall?.method).toBe("POST");
        expect(resumeCall?.headers?.["x-luvebot-csrf"]).toBe("csrf-token-costs-test");
      });
    });
  });

  describe("Loopback Auth Mode Enforcement (D-014 / A-29)", () => {
    it("in loopback mode, displays warning banner with loopback_not_human badge", async () => {
      setupFetchMock({ authMode: "loopback" });
      render(<CostsView authMode="loopback" />);

      await screen.findByRole("alert");
      expect(screen.getByText("Modo Loopback Ativo (D-014)")).toBeDefined();
      expect(screen.getByTestId("badge-loopback").textContent).toBe("loopback_not_human");
    });

    it("in loopback mode: lowering an existing ceiling is ALLOWED", async () => {
      const { calls } = setupFetchMock({ authMode: "loopback" });
      render(<CostsView authMode="loopback" />);

      // Switch to limits tab
      const limitsTabBtn = screen.getByRole("button", { name: "Tetos e Limites" });
      fireEvent.click(limitsTabBtn);

      await screen.findByTestId("budget-limit-card-bot-vendas-day");

      // Bot vendas has limit 5000 cents ($50.00)
      const editBtn = screen.getByTestId("btn-edit-limit-bot-vendas");
      fireEvent.click(editBtn);

      const modal = await screen.findByTestId("modal-limit-config");
      const amountInput = within(modal).getByTestId("input-limit-amount");

      // Lower to $30.00 (3000 cents < 5000 cents)
      fireEvent.change(amountInput, { target: { value: "30.00" } });

      const saveBtn = within(modal).getByTestId("btn-save-limit");
      // Must NOT be disabled because lowering is allowed
      expect((saveBtn as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(saveBtn);

      await waitFor(() => {
        const putCall = calls.find((c) => c.url.endsWith("/budget/limits") && c.method === "PUT");
        expect(putCall).toBeDefined();
        expect(putCall?.body?.cents).toBe(3000);
        expect(putCall?.body?.scope).toBe("bot");
        expect(putCall?.body?.ref).toBe("vendas");
      });
    });

    it("in loopback mode: raising an existing ceiling is BLOCKED (disabled with warning)", async () => {
      setupFetchMock({ authMode: "loopback" });
      render(<CostsView authMode="loopback" />);

      // Switch to limits tab
      const limitsTabBtn = screen.getByRole("button", { name: "Tetos e Limites" });
      fireEvent.click(limitsTabBtn);

      await screen.findByTestId("budget-limit-card-bot-vendas-day");

      // Bot vendas has limit $50.00
      const editBtn = screen.getByTestId("btn-edit-limit-bot-vendas");
      fireEvent.click(editBtn);

      const modal = await screen.findByTestId("modal-limit-config");
      const amountInput = within(modal).getByTestId("input-limit-amount");

      // Raise to $80.00 (8000 cents > 5000 cents)
      fireEvent.change(amountInput, { target: { value: "80.00" } });

      const saveBtn = within(modal).getByTestId("btn-save-limit");
      // Must be disabled
      expect((saveBtn as HTMLButtonElement).disabled).toBe(true);

      // Warning message displayed
      expect(
        within(modal).getByText("Aumentar ou remover teto bloqueado em modo loopback (loopback_not_human).")
      ).toBeDefined();
    });

    it("in loopback mode: creating a new ceiling or removing an existing ceiling is BLOCKED", async () => {
      setupFetchMock({ authMode: "loopback" });
      render(<CostsView authMode="loopback" />);

      // Switch to limits tab
      const limitsTabBtn = screen.getByRole("button", { name: "Tetos e Limites" });
      fireEvent.click(limitsTabBtn);

      await screen.findByTestId("btn-new-limit");

      // "Definir novo teto" button is disabled in loopback
      const newLimitBtn = screen.getByTestId("btn-new-limit");
      expect((newLimitBtn as HTMLButtonElement).disabled).toBe(true);

      // Edit limit and check remove button is disabled
      const editBtn = screen.getByTestId("btn-edit-limit-bot-vendas");
      fireEvent.click(editBtn);

      const modal = await screen.findByTestId("modal-limit-config");
      const removeBtn = within(modal).getByTestId("btn-remove-limit");
      expect((removeBtn as HTMLButtonElement).disabled).toBe(true);
    });

    it("in loopback mode: resuming a paused bot is BLOCKED (disabled with warning)", async () => {
      const { calls } = setupFetchMock({ authMode: "loopback" });
      render(<CostsView authMode="loopback" />);

      // Switch to paused bots tab
      const pausedTabBtn = screen.getByRole("button", { name: /bots pausados/i });
      fireEvent.click(pausedTabBtn);

      await screen.findByTestId("paused-bot-pesquisa");

      const pausedCard = screen.getByTestId("paused-bot-pesquisa");
      const resumeBtn = within(pausedCard).getByRole("button", { name: /retomar bot/i });

      // Button is disabled in loopback
      expect((resumeBtn as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(resumeBtn);

      // Confirmation modal must NOT open and no resume API calls
      expect(screen.queryByTestId("modal-resume-confirmation")).toBeNull();
      const resumeCalls = calls.filter((c) => c.url.includes("/budget/resume"));
      expect(resumeCalls.length).toBe(0);
    });
  });

  describe("Mutation Check: Allowing ceiling raise in loopback mode leaves test red", () => {
    it("mutation guard: in loopback mode, raising a ceiling from $50 to $80 MUST have save disabled", async () => {
      setupFetchMock({ authMode: "loopback" });
      render(<CostsView authMode="loopback" />);

      // Switch to limits tab
      const limitsTabBtn = screen.getByRole("button", { name: "Tetos e Limites" });
      fireEvent.click(limitsTabBtn);

      await screen.findByTestId("budget-limit-card-bot-vendas-day");

      // Bot vendas has limit 5000 cents ($50.00)
      const editBtn = screen.getByTestId("btn-edit-limit-bot-vendas");
      fireEvent.click(editBtn);

      const modal = await screen.findByTestId("modal-limit-config");
      const amountInput = within(modal).getByTestId("input-limit-amount");

      // Attempt to raise to $80.00
      fireEvent.change(amountInput, { target: { value: "80.00" } });

      const saveBtn = within(modal).getByTestId("btn-save-limit") as HTMLButtonElement;

      // Invariant assertion: In loopback, raising is strictly disabled!
      expect(saveBtn.disabled).toBe(true);
    });
  });
});
