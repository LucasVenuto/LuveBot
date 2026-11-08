// tests/unit/activity/activity.test.tsx
// Unit tests for Activity View (spec §4.7, contract v0.2 §2)
// Testing: list/kanban toggle preserves filters; Parar only disappears with confirmed terminal status;
// task title with markup appears as sanitized text; redirect & context with CSRF and confirmation;
// Kanban renders the 8 official Hermes Kanban columns; mutation guard for Parar visibility.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ActivityView, mapActivityItemToKanbanColumn } from "@/components/activity/ActivityView";
import type { ActivityItem, Bot } from "@/api/types";
import { HERMES_KANBAN_COLUMNS } from "@/api/types";
import * as client from "@/api/client";
import { setLuveLocale } from "@/i18n";

const mockBots: Bot[] = [
  {
    name: "vendas",
    is_default: false,
    description: "Bot de vendas B2B",
    model: { provider: "openai", name: "gpt-4o" },
    status: "idle",
    display: {
      label: "Vendas B2B",
      role: "Vendedor",
      color: "#3b82f6",
      avatar: { kind: "initials", value: "VB" },
    },
  },
  {
    name: "dev",
    is_default: false,
    description: "Bot de desenvolvimento",
    model: { provider: "anthropic", name: "claude-3-5-sonnet" },
    status: "idle",
    display: {
      label: "Engenheiro Dev",
      role: "Desenvolvedor",
      color: "#10b981",
      avatar: { kind: "initials", value: "ED" },
    },
  },
];

const mockItems: ActivityItem[] = [
  {
    id: "run-vendas-1",
    kind: "run",
    bot: "vendas",
    title: "Qualificação de leads inbound de São Paulo",
    origin: "message",
    status: "running",
    checkpoint: { done: 3, total: 10, to_review: 1 },
    started_at: "2026-10-01T10:00:00Z",
    duration_s: 45,
    cost_cents: 120,
    links: { session_id: "sess-vendas-101", run_id: "run-vendas-1" },
  },
  {
    id: "routine-dev-2",
    kind: "routine_run",
    bot: "dev",
    title: "Execução de testes de regressão no sandbox",
    origin: "routine",
    status: "done",
    started_at: "2026-10-01T09:30:00Z",
    ended_at: "2026-10-01T09:32:00Z",
    duration_s: 120,
    cost_cents: 350,
    links: { session_id: "sess-dev-202", job_id: "cron-job-dev" },
  },
  {
    id: "task-kanban-3",
    kind: "task",
    bot: "vendas",
    title: "<script>alert('xss')</script><b>Follow-up</b> com cliente XPTO",
    origin: "handoff",
    status: "waiting_approval",
    cost_cents: 80,
    links: { task_id: "task-kanban-3" },
    column: "review",
  },
];

describe("Activity View (spec §4.7, contract v0.2 §2)", () => {
  beforeEach(() => {
    setLuveLocale("pt");
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads and displays activity items from backend API", async () => {
    vi.spyOn(client, "getActivity").mockResolvedValueOnce({
      items: mockItems,
      next_cursor: null,
    });

    render(<ActivityView bots={mockBots} />);

    const item1 = await screen.findByText("Qualificação de leads inbound de São Paulo");
    expect(item1).toBeDefined();
    expect(screen.getByText("Execução de testes de regressão no sandbox")).toBeDefined();
    // the Bot's name (not its slug) is on the rows as well as in the filter
    expect(screen.getAllByText("Vendas B2B").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Engenheiro Dev").length).toBeGreaterThanOrEqual(2);
  });

  it("displays partial sources warning banner when backend returns partial", async () => {
    vi.spyOn(client, "getActivity").mockResolvedValueOnce({
      items: mockItems,
      next_cursor: null,
      partial: ["cron", "kanban"],
    });

    render(<ActivityView bots={mockBots} />);

    const alertBanner = await screen.findByText("Aviso: fontes parciais indisponíveis (cron, kanban)");
    expect(alertBanner).toBeDefined();
  });

  it("toggling between list and kanban view PRESERVES all active filters", async () => {
    vi.spyOn(client, "getActivity").mockResolvedValue({
      items: mockItems,
      next_cursor: null,
    });

    render(<ActivityView bots={mockBots} initialItems={mockItems} />);

    // Apply filters in List view
    const botSelect = screen.getByTestId("filter-bot") as HTMLSelectElement;
    const originSelect = screen.getByTestId("filter-origin") as HTMLSelectElement;
    const statusSelect = screen.getByTestId("filter-status") as HTMLSelectElement;
    const searchInput = screen.getByTestId("input-search-activity") as HTMLInputElement;

    fireEvent.change(botSelect, { target: { value: "vendas" } });
    fireEvent.change(originSelect, { target: { value: "message" } });
    fireEvent.change(statusSelect, { target: { value: "running" } });
    fireEvent.change(searchInput, { target: { value: "leads" } });

    // Assert filters are set
    expect(botSelect.value).toBe("vendas");
    expect(originSelect.value).toBe("message");
    expect(statusSelect.value).toBe("running");
    expect(searchInput.value).toBe("leads");

    // Only 1 item matches: run-vendas-1
    expect(screen.getByTestId("activity-item-run-vendas-1")).toBeDefined();
    expect(screen.queryByTestId("activity-item-routine-dev-2")).toBeNull();

    // Toggle to Kanban view
    const toggleKanban = screen.getByTestId("toggle-view-kanban");
    fireEvent.click(toggleKanban);

    // Verify Kanban board is visible
    expect(screen.getByTestId("kanban-board")).toBeDefined();

    // Verify filter controls PRESERVED their values
    const botSelectKanban = screen.getByTestId("filter-bot") as HTMLSelectElement;
    const originSelectKanban = screen.getByTestId("filter-origin") as HTMLSelectElement;
    const statusSelectKanban = screen.getByTestId("filter-status") as HTMLSelectElement;
    const searchInputKanban = screen.getByTestId("input-search-activity") as HTMLInputElement;

    expect(botSelectKanban.value).toBe("vendas");
    expect(originSelectKanban.value).toBe("message");
    expect(statusSelectKanban.value).toBe("running");
    expect(searchInputKanban.value).toBe("leads");

    // In Kanban board: run-vendas-1 is under running column
    expect(screen.getByTestId("kanban-card-run-vendas-1")).toBeDefined();
    expect(screen.queryByTestId("kanban-card-routine-dev-2")).toBeNull();

    // Toggle back to List view
    const toggleList = screen.getByTestId("toggle-view-list");
    fireEvent.click(toggleList);

    // Verify still preserved in List view
    expect(screen.getByTestId("activity-item-run-vendas-1")).toBeDefined();
    expect((screen.getByTestId("filter-bot") as HTMLSelectElement).value).toBe("vendas");
    expect((screen.getByTestId("input-search-activity") as HTMLInputElement).value).toBe("leads");
  });

  it("renders task title containing HTML markup strictly as sanitized text (never executes or evaluates HTML)", () => {
    render(<ActivityView bots={mockBots} initialItems={mockItems} />);

    // Assert no script tag was injected into DOM
    expect(document.querySelector("script")).toBeNull();

    // The title with <script> and <b> tags must be rendered safely as text
    const titleEl = screen.getByTestId("activity-title-task-kanban-3");
    expect(titleEl.textContent).toContain("<script>alert('xss')</script><b>Follow-up</b> com cliente XPTO");
  });

  it("Parar button CONTINUES VISIBLE until termination is confirmed by backend (same rule as conversation)", async () => {
    const stopSpy = vi.spyOn(client, "stopActivity").mockResolvedValue({ ok: true });

    // Render with 1 running item
    const runningItem: ActivityItem = {
      id: "run-active-1",
      kind: "run",
      bot: "vendas",
      title: "Processamento de propostas",
      origin: "message",
      status: "running",
    };

    const { rerender } = render(<ActivityView bots={mockBots} initialItems={[runningItem]} />);

    // Parar button is initially present
    const stopBtn = screen.getByTestId("btn-stop-run-active-1") as HTMLButtonElement;
    expect(stopBtn).toBeDefined();
    expect(stopBtn.textContent).toContain("Parar");

    // Click Parar to open confirmation modal
    fireEvent.click(stopBtn);

    // Confirm modal opens
    expect(screen.getByRole("dialog", { name: "Confirmar Parada" })).toBeDefined();

    // Optional reason
    const reasonInput = screen.getByTestId("input-stop-reason");
    fireEvent.change(reasonInput, { target: { value: "Interrupção manual de teste" } });

    // Confirm Stop
    const confirmBtn = screen.getByTestId("btn-confirm-stop");
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Verify stopActivity API was called with item id and reason
    expect(stopSpy).toHaveBeenCalledWith("run-active-1", {
      reason: "Interrupção manual de teste",
    });

    // CRUCIAL INVARIANT: Parar button is STILL IN THE DOM immediately after click!
    // It is marked as stopping / disabled, but NOT REMOVED!
    const inFlightStopBtn = screen.getByTestId("btn-stop-run-active-1") as HTMLButtonElement;
    expect(inFlightStopBtn).toBeDefined();
    expect(inFlightStopBtn.disabled).toBe(true);
    expect(inFlightStopBtn.textContent).toContain("Parando...");

    // Now simulate backend confirming the terminal status (e.g. status: "stopped")
    const stoppedItem: ActivityItem = {
      ...runningItem,
      status: "stopped",
    };

    rerender(<ActivityView bots={mockBots} initialItems={[stoppedItem]} />);

    // ONLY NOW does the Parar button disappear from the DOM
    expect(screen.queryByTestId("btn-stop-run-active-1")).toBeNull();
  });

  it("mutation guard: Parar button MUST NOT disappear immediately upon clicking before terminal confirmation", async () => {
    vi.spyOn(client, "stopActivity").mockResolvedValue({ ok: true });

    const runningItem: ActivityItem = {
      id: "run-guard-1",
      kind: "run",
      bot: "vendas",
      title: "Tarefa crítica em execução",
      origin: "message",
      status: "running",
    };

    render(<ActivityView bots={mockBots} initialItems={[runningItem]} />);

    const stopBtn = screen.getByTestId("btn-stop-run-guard-1");
    expect(stopBtn).toBeDefined();

    // Click stop and confirm modal
    fireEvent.click(stopBtn);
    await act(async () => {
      fireEvent.click(screen.getByTestId("btn-confirm-stop"));
    });

    // Mutation guard: If code hides the button immediately on click, this query fails!
    const stillPresentBtn = screen.queryByTestId("btn-stop-run-guard-1");
    expect(stillPresentBtn).not.toBeNull();
  });

  it("redirect action requires confirmation and calls redirectActivity with CSRF", async () => {
    const redirectSpy = vi.spyOn(client, "redirectActivity").mockResolvedValue({ ok: true });

    render(<ActivityView bots={mockBots} initialItems={mockItems} />);

    // Click Redirect on task-kanban-3
    const redirectBtn = screen.getByTestId("btn-redirect-task-kanban-3");
    fireEvent.click(redirectBtn);

    // Modal opens
    expect(screen.getByRole("dialog", { name: "Redirecionar Tarefa" })).toBeDefined();

    // Select target bot 'dev'
    const botSelect = screen.getByTestId("select-redirect-bot");
    fireEvent.change(botSelect, { target: { value: "dev" } });

    // Enter reason
    const reasonInput = screen.getByTestId("input-redirect-reason");
    fireEvent.change(reasonInput, { target: { value: "Precisa de análise técnica" } });

    // Confirm
    await act(async () => {
      fireEvent.click(screen.getByTestId("btn-confirm-redirect"));
    });

    expect(redirectSpy).toHaveBeenCalledWith("task-kanban-3", {
      bot: "dev",
      reason: "Precisa de análise técnica",
    });
  });

  it("context action requires confirmation and calls addActivityContext with CSRF", async () => {
    const contextSpy = vi.spyOn(client, "addActivityContext").mockResolvedValue({ ok: true });

    render(<ActivityView bots={mockBots} initialItems={mockItems} />);

    // Only a task has a thread the Bot reads: a run or a routine offers no "Adicionar contexto" (the backend refuses them)
    expect(screen.queryByTestId("btn-context-run-vendas-1")).toBeNull();
    expect(screen.queryByTestId("btn-context-routine-dev-2")).toBeNull();
    const contextBtn = screen.getByTestId("btn-context-task-kanban-3");
    fireEvent.click(contextBtn);
    // It says what really happens: a comment in the task's thread, read when the Bot next opens the task
    expect(screen.getByText(/entra no fio da tarefa e o Bot lê na próxima vez que abrir a tarefa/)).toBeDefined();
    expect(screen.queryByText(/será entregue ao Bot/)).toBeNull();

    // Modal opens
    expect(screen.getByRole("dialog", { name: "Adicionar Contexto ou Correção" })).toBeDefined();

    // Switch kind to correction
    fireEvent.click(screen.getByTestId("btn-kind-correction"));

    // Enter text
    const textarea = screen.getByTestId("textarea-context");
    fireEvent.change(textarea, { target: { value: "Priorizar clientes com mais de 50 funcionários" } });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByTestId("btn-confirm-context"));
    });

    expect(contextSpy).toHaveBeenCalledWith("task-kanban-3", {
      text: "Priorizar clientes com mais de 50 funcionários",
      kind: "correction",
    });
  });

  it("Kanban board reflects the 8 official Hermes Kanban columns without inventing extra states", () => {
    render(<ActivityView bots={mockBots} initialItems={mockItems} />);

    // Switch to Kanban
    fireEvent.click(screen.getByTestId("toggle-view-kanban"));

    // The 8 official Hermes Kanban columns must all be rendered
    for (const col of HERMES_KANBAN_COLUMNS) {
      expect(screen.getByTestId(`kanban-col-${col}`)).toBeDefined();
    }
    // the card's "Adicionar contexto" only on the task, like the list
    expect(screen.getByTestId("kanban-btn-context-task-kanban-3")).toBeDefined();
    expect(screen.queryByTestId("kanban-btn-context-run-vendas-1")).toBeNull();

    // Verify mapping function adheres to the 8 Hermes columns
    expect(mapActivityItemToKanbanColumn(mockItems[0])).toBe("running");
    expect(mapActivityItemToKanbanColumn(mockItems[1])).toBe("done");
    expect(mapActivityItemToKanbanColumn(mockItems[2])).toBe("review");
  });
});
