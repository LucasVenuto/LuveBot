// tests/unit/hoje.test.tsx
// Comprehensive unit tests for Home "Hoje" (spec §4.2, T6.4).
// Covers:
// - Header and active bots count.
// - All sources empty vs full:
//   1. Precisa de você (Approvals & Handoffs)
//   2. Em andamento (Active Tasks / Runs)
//   3. Concluído hoje (Completed Tasks & Artifacts)
//   4. Próximas rotinas (Upcoming Routines & Quick Test)
//   5. Bots (Onboarding templates when empty vs active bot count when full)
//   6. Custos & Budget (Honest financial badge when available, omitted when absent)
// - Dynamic counter validation (asserts strict '0' when empty, never a fixed fake number).

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Hoje } from "@/components/Hoje";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type {
  Bot,
  Approval,
  Handoff,
  ActivityItem,
  Routine,
  CostsResponse,
  BudgetSnapshot,
} from "@/api/types";

describe("Hoje Component (spec §4.2, T6.4)", () => {
  it("renders page header and active bots count in empty state", () => {
    render(<Hoje />);

    expect(screen.getByRole("heading", { level: 1, name: /hoje/i })).toBeDefined();
    expect(screen.getByText("0 Bots ativos")).toBeDefined();
  });

  describe("Fonte 5: Bots e Onboarding (Vazia vs Cheia)", () => {
    it("renders onboarding section with 3 starter templates when bots list is empty", () => {
      render(<Hoje bots={[]} />);

      expect(screen.getByText("Nenhum Bot criado ainda")).toBeDefined();
      expect(
        screen.getByText("Crie seu primeiro colega de trabalho a partir de um modelo comprovado:")
      ).toBeDefined();

      expect(screen.getByText("Chefe de Gabinete")).toBeDefined();
      expect(screen.getByText("Vendas B2B")).toBeDefined();
      expect(screen.getByText("Engenheiro Dev")).toBeDefined();

      const createBtns = screen.getAllByRole("button", { name: /criar este bot/i });
      expect(createBtns.length).toBe(3);
    });

    it("calls onOpenCreateBot when clicking 'Criar este Bot' on any template", () => {
      const onOpenCreateBot = vi.fn();
      render(<Hoje onOpenCreateBot={onOpenCreateBot} />);

      const createBtns = screen.getAllByRole("button", { name: /criar este bot/i });
      expect(createBtns.length).toBe(3);

      fireEvent.click(createBtns[0]);
      expect(onOpenCreateBot).toHaveBeenCalledWith("gabinete");

      fireEvent.click(createBtns[1]);
      expect(onOpenCreateBot).toHaveBeenCalledWith("vendas");

      fireEvent.click(createBtns[2]);
      expect(onOpenCreateBot).toHaveBeenCalledWith("dev");
    });

    it("renders dynamic active bots count and hides onboarding section when bots exist", () => {
      const mockBots: Bot[] = [
        {
          name: "default",
          is_default: true,
          display: {
            label: "Hermes",
            role: "Assistente Geral",
            color: "#38bdf8",
            avatar: { kind: "emoji", value: "🤖" },
          },
          description: "Assistente Geral",
          model: { provider: "openrouter", name: "claude-sonnet-5-5" },
          status: "idle",
        },
        {
          name: "vendas",
          is_default: false,
          display: {
            label: "Vendas",
            role: "Prospecção B2B",
            color: "#60a5fa",
            avatar: { kind: "emoji", value: "💼" },
          },
          description: "Prospecção",
          model: { provider: "openrouter", name: "claude-sonnet-5-5" },
          status: "working",
        },
        {
          name: "suporte",
          is_default: false,
          display: {
            label: "Suporte",
            role: "SAC",
            color: "#a78bfa",
            avatar: { kind: "emoji", value: "🎧" },
          },
          description: "Suporte ao cliente",
          model: { provider: "openrouter", name: "claude-sonnet-5-5" },
          status: "paused", // Should NOT count as active
        },
        {
          name: "dev",
          is_default: false,
          display: {
            label: "Dev",
            role: "Engenharia",
            color: "#34d399",
            avatar: { kind: "emoji", value: "💻" },
          },
          description: "Engenharia",
          model: { provider: "openrouter", name: "claude-sonnet-5-5" },
          status: "offline", // Should NOT count as active
        },
      ];

      render(<Hoje bots={mockBots} />);

      // 4 bots total, 2 active (idle + working; paused & offline excluded)
      expect(screen.getByText("2 Bots ativos")).toBeDefined();

      // Onboarding section must NOT be rendered when bots exist
      expect(screen.queryByText("Nenhum Bot criado ainda")).toBeNull();
      expect(screen.queryByRole("section", { name: "onboarding" })).toBeNull();
    });

    it("handles singular bot count correctly ('1 Bot ativo')", () => {
      const singleBot: Bot[] = [
        {
          name: "default",
          is_default: true,
          display: {
            label: "Hermes",
            role: "Assistente Geral",
            color: "#38bdf8",
            avatar: { kind: "emoji", value: "🤖" },
          },
          description: "Assistente Geral",
          model: { provider: "openrouter", name: "claude-sonnet-5-5" },
          status: "idle",
        },
      ];

      render(<Hoje bots={singleBot} />);
      expect(screen.getByText("1 Bot ativo")).toBeDefined();
      expect(screen.queryByText("Nenhum Bot criado ainda")).toBeNull();
    });
  });

  describe("Fonte 1: Precisa de você (Aprovações e Handoffs - Vazia vs Cheia)", () => {
    it("renders honest empty state when there are 0 pending approvals and handoffs", () => {
      render(<Hoje approvals={[]} handoffs={[]} />);

      expect(screen.getByTestId("needs-you-count").textContent).toBe("0");
      expect(screen.getByTestId("needs-you-empty")).toBeDefined();
      expect(
        screen.getByText("Tudo tranquilo. Nenhuma aprovação, pergunta ou handoff pendente no momento.")
      ).toBeDefined();
      expect(
        screen.getByText("Aprovações e perguntas que precisarem de você aparecerão aqui para decisão rápida.")
      ).toBeDefined();
    });

    it("renders approval and handoff items when populated, with interactive inline actions", async () => {
      resetCsrfToken();
      const onNavigateTab = vi.fn();
      const posts: Array<{ url: string; csrf: string | null; body: any }> = [];
      setCustomFetchJSON(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
        posts.push({ url, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF"), body: JSON.parse(String(init?.body ?? "{}")) });
        return { approval: { status: "decided" } };
      });

      const mockApprovals: Approval[] = [
        {
          request_id: "req-1",
          bot: "vendas",
          source: "transport",
          digest: "enviar_email para ana@fintech.com",
          description: "Envio de proposta comercial para cliente",
          allowed_choices: ["once", "deny"],
          created_at: "2026-09-30T10:00:00Z",
          expires_at: "2026-09-30T11:00:00Z",
          status: "pending",
        },
      ];

      const mockHandoffs: Handoff[] = [
        {
          id: "ho-1",
          from: "vendas",
          to: "dev",
          title: "Reproduzir erro na API de pagamentos",
          task_id: "task-99",
          state: "triage",
          needs_review: true,
          created_at: "2026-09-30T10:05:00Z",
          updated_at: "2026-09-30T10:05:00Z",
        },
      ];

      render(
        <Hoje
          approvals={mockApprovals}
          handoffs={mockHandoffs}
          onNavigateTab={onNavigateTab}
        />
      );

      // Counter dynamically displays 2
      expect(screen.getByTestId("needs-you-count").textContent).toBe("2");
      expect(screen.queryByTestId("needs-you-empty")).toBeNull();

      // Approval item rendered
      expect(screen.getByTestId("needs-you-item-req-1")).toBeDefined();
      expect(screen.getByText("Envio de proposta comercial para cliente")).toBeDefined(); // the description, never the digest
      expect(screen.queryByText("enviar_email para ana@fintech.com")).toBeNull();

      // Action: Deny needs a reason (D4: it used to call back with no reason and, in the app, with no handler at all)
      fireEvent.click(screen.getByRole("button", { name: "Negar…" }));
      expect((screen.getByRole("button", { name: "Confirmar negação" }) as HTMLButtonElement).disabled).toBe(true);
      expect(posts).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

      // Action: Allow once is decided for real, with the stored digest and CSRF
      fireEvent.click(screen.getByRole("button", { name: "Permitir uma vez" }));
      await screen.findByText("Permitida uma vez.");
      expect(posts).toEqual([{ url: "/api/plugins/luvebot/approvals/req-1/resolve", csrf: "csrf-1", body: { digest: "enviar_email para ana@fintech.com", choice: "once" } }]);
      setCustomFetchJSON(null);

      // Handoff item rendered
      expect(screen.getByTestId("needs-you-item-ho-1")).toBeDefined();
      expect(screen.getByText(/vendas → dev: Reproduzir erro na API/i)).toBeDefined();

      // Action: Review handoff
      const reviewBtn = screen.getByRole("button", { name: /revisar/i });
      fireEvent.click(reviewBtn);
      expect(onNavigateTab).toHaveBeenCalledWith("atividade");
    });
  });

  describe("Fonte 2: Em andamento (Tarefas e Runs Ativos - Vazia vs Cheia)", () => {
    it("renders honest empty state when there are 0 running tasks", () => {
      render(<Hoje inProgressItems={[]} />);

      expect(screen.getByTestId("in-progress-count").textContent).toBe("0");
      expect(screen.getByTestId("in-progress-empty")).toBeDefined();
      expect(
        screen.getByText("Nenhuma tarefa em andamento. Inicie uma conversa com um Bot ou aguarde a próxima rotina programada.")
      ).toBeDefined();
      expect(
        screen.getByText("Inicie uma conversa com um Bot para delegar novas tarefas ou acione uma rotina.")
      ).toBeDefined();
    });

    it("renders active running tasks with checkpoint, duration, cost and Stop action", () => {
      const onStopActivity = vi.fn();

      const mockRunning: ActivityItem[] = [
        {
          id: "act-run-1",
          kind: "run",
          bot: "vendas",
          title: "Prospecção de leads fintech SP",
          origin: "message",
          status: "running",
          checkpoint: { done: 12, total: 48, to_review: 0 },
          duration_s: 18,
          cost_cents: 35,
        },
      ];

      render(<Hoje inProgressItems={mockRunning} onStopActivity={onStopActivity} />);

      expect(screen.getByTestId("in-progress-count").textContent).toBe("1");
      expect(screen.queryByTestId("in-progress-empty")).toBeNull();

      expect(screen.getByTestId("in-progress-item-act-run-1")).toBeDefined();
      expect(screen.getByText("Prospecção de leads fintech SP")).toBeDefined();
      expect(screen.getByText("12 de 48")).toBeDefined();
      expect(screen.getByText("18s")).toBeDefined();

      // Stop button
      // Stop needs a second click
      fireEvent.click(screen.getByRole("button", { name: "Parar" }));
      expect(onStopActivity).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirmar parada" }));
      expect(onStopActivity).toHaveBeenCalledWith("act-run-1");
    });
  });

  describe("Fonte 3: Concluído hoje (Tarefas e Artefatos Finalizados - Vazia vs Cheia)", () => {
    it("renders honest empty state when there are 0 completed tasks", () => {
      render(<Hoje completedItems={[]} />);

      expect(screen.getByTestId("completed-today-count").textContent).toBe("0");
      expect(screen.getByTestId("completed-today-empty")).toBeDefined();
      expect(
        screen.getByText("Nenhuma tarefa concluída hoje ainda. Os resultados e artefatos entregues pelos Bots aparecerão aqui.")
      ).toBeDefined();
      expect(
        screen.getByText("Os resultados, relatórios e artefatos concluídos aparecerão aqui ao longo do dia.")
      ).toBeDefined();
    });

    it("renders completed tasks with cost and View Conversation link", () => {
      const onSelectBot = vi.fn();

      const mockCompleted: ActivityItem[] = [
        {
          id: "act-done-1",
          kind: "task",
          bot: "dev",
          title: "Correção de bug de autenticação OAuth",
          origin: "handoff",
          status: "done",
          cost_cents: 120,
        },
      ];

      render(<Hoje completedItems={mockCompleted} onSelectBot={onSelectBot} />);

      expect(screen.getByTestId("completed-today-count").textContent).toBe("1");
      expect(screen.queryByTestId("completed-today-empty")).toBeNull();

      expect(screen.getByTestId("completed-today-item-act-done-1")).toBeDefined();
      expect(screen.getByText("Correção de bug de autenticação OAuth")).toBeDefined();

      const viewBtn = screen.getByRole("button", { name: "Ver conversa" });
      fireEvent.click(viewBtn);
      expect(onSelectBot).toHaveBeenCalledWith("dev");
    });
  });

  describe("Fonte 4: Próximas Rotinas (Vazia vs Cheia)", () => {
    it("renders honest empty state and next step when there are 0 scheduled routines", () => {
      const onNavigateTab = vi.fn();
      render(<Hoje routines={[]} onNavigateTab={onNavigateTab} />);

      expect(screen.getByTestId("routines-count").textContent).toBe("0 agendadas");
      expect(screen.getByTestId("hoje-routines-empty")).toBeDefined();
      expect(screen.getByText("Nenhuma rotina agendada para hoje.")).toBeDefined();

      const createBtn = screen.getByRole("button", { name: "Criar rotina" });
      fireEvent.click(createBtn);
      expect(onNavigateTab).toHaveBeenCalledWith("rotinas");
    });

    it("renders up to 5 scheduled routines with schedule and Test Run action", () => {
      const onRunRoutine = vi.fn();

      const mockRoutines: Routine[] = [
        {
          id: "rot-1",
          bot: "vendas",
          name: "Sincronização matinal de leads",
          schedule: { expr: "0 8 * * 1-5" },
          enabled: true,
          state: "scheduled",
        },
        {
          id: "rot-2",
          bot: "suporte",
          name: "Verificação de tickets não respondidos",
          schedule: { expr: "*/30 * * * *" },
          enabled: true,
          state: "scheduled",
        },
      ];

      render(<Hoje routines={mockRoutines} onRunRoutine={onRunRoutine} />);

      expect(screen.getByTestId("routines-count").textContent).toBe("2 agendadas");
      expect(screen.queryByTestId("hoje-routines-empty")).toBeNull();

      expect(screen.getByTestId("routine-item-rot-1")).toBeDefined();
      expect(screen.getByText("Sincronização matinal de leads")).toBeDefined();
      expect(screen.getByText("0 8 * * 1-5")).toBeDefined();

      const testBtns = screen.getAllByRole("button", { name: "Rodar teste" });
      expect(testBtns.length).toBe(2);

      // A test run does real work: it needs a second click
      fireEvent.click(testBtns[0]);
      expect(onRunRoutine).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirmar teste" }));
      expect(onRunRoutine).toHaveBeenCalledWith("rot-1");
    });
  });

  describe("Fonte 6: Custos e Budget (Honestidade Financeira)", () => {
    it("omits financial badge when no cost data is available (never invents numbers)", () => {
      render(<Hoje costs={undefined} budget={undefined} />);
      expect(screen.queryByTestId("hoje-spend-badge")).toBeNull();
    });

    it("renders honest financial badge when costs and budget limits are present", () => {
      const mockCosts: CostsResponse = {
        period: "day",
        currency: "USD",
        totals: {
          spend_cents: 320,
          unpriced_sessions: 0,
        },
        groups: [],
        ledger: { lag_s: 2, watcher_stale: false },
      };

      const mockBudget: BudgetSnapshot = {
        limits: [
          {
            scope: "global",
            ref: "",
            period: "day",
            cents: 1500,
            spent_cents: 320,
            percent: 21,
          },
        ],
        alerts: [],
        paused: [],
        watcher: { stale: false, last_at: Date.now() },
      };

      render(<Hoje costs={mockCosts} budget={mockBudget} />);

      const badge = screen.getByTestId("hoje-spend-badge");
      expect(badge).toBeDefined();
      expect(badge.textContent).toContain("3,20");
      expect(badge.textContent).toContain("15,00");
    });
  });

  describe("Invariante de Honestidade dos Contadores (Detecção de Mutação)", () => {
    it("strictly displays '0' in counters when all lists are empty (MUTATION TARGET)", () => {
      render(
        <Hoje
          bots={[]}
          approvals={[]}
          handoffs={[]}
          inProgressItems={[]}
          completedItems={[]}
          routines={[]}
        />
      );

      // CRITICAL ASSERTION: All column counters MUST strictly equal "0" when sources are empty!
      // A mutation that introduces a fixed fake number like '3' or '5' will turn this test RED!
      expect(screen.getByTestId("needs-you-count").textContent).toBe("0");
      expect(screen.getByTestId("in-progress-count").textContent).toBe("0");
      expect(screen.getByTestId("completed-today-count").textContent).toBe("0");
    });
  });
});
