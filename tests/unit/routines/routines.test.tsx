// tests/unit/routines/routines.test.tsx
// Unit tests for Routines management and execution history (spec §4.9, contract v0.2 §3).
// - Full history paged by offset until the end (no 20 or 100 ceiling, A-25).
// - Routines paused by budget display reason and only resume via human click.
// - Test action disabled on paused routines with explanation.
// - Mutations require human confirmation.
// - Mutation guard: stopping after page 1 fails the test.

import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { RoutinesView } from "@/components/routines";
import {
  setCustomFetchJSON,
  resetCsrfToken,
  setCachedCsrf,
  fetchAllRoutineRuns,
} from "@/api/client";
import type { Routine, RoutineDetail, RoutineRun, RoutinesResponse } from "@/api/types";
import { setLuveLocale } from "@/i18n";

const mockRoutines: Routine[] = [
  {
    id: "routine-vendas-daily",
    bot: "vendas",
    name: "Relatório diário de vendas",
    schedule: { expr: "0 8 * * 1-5" },
    next_run_at: 1761820000000,
    last_run_at: 1761733600000,
    last_status: "success",
    state: "scheduled",
    enabled: true,
    paused_reason: null,
    cap: { period: "day", cents: 500 },
    spend_cents: 120,
  },
  {
    id: "routine-pesquisa-budget-paused",
    bot: "pesquisa",
    name: "Pesquisa contínua de notícias",
    schedule: { expr: "*/30 * * * *" },
    next_run_at: null,
    last_run_at: 1761740000000,
    last_status: "running",
    state: "paused",
    enabled: false,
    paused_reason: "budget", // Paused by budget ceiling (A-27)
    cap: { period: "day", cents: 1000 },
    spend_cents: 1050,
  },
  {
    id: "routine-dev-user-paused",
    bot: "dev",
    name: "Verificação de logs de build",
    schedule: { expr: "0 0 * * *" },
    next_run_at: null,
    last_run_at: 1761700000000,
    last_status: "error",
    state: "paused",
    enabled: false,
    paused_reason: "user",
    cap: null,
    spend_cents: 0,
  },
];

const mockRoutineDetail: RoutineDetail = {
  routine: mockRoutines[0],
  detail: {
    instruction: "Buscar prospects no CRM e enviar resumo para o canal de vendas.",
    input_source: "CRM API",
    delivery_summary: "E-mail diário às 8h",
  },
};

interface CapturedCall {
  url: string;
  method: string;
  body?: any;
  headers: Record<string, string>;
}

function setupRoutinesFetchMock(opts?: {
  routines?: Routine[];
  totalRuns?: number;
  failRoutines?: boolean;
}) {
  const calls: CapturedCall[] = [];
  const routinesList = opts?.routines || mockRoutines;
  const totalRunsCount = opts?.totalRuns !== undefined ? opts?.totalRuns : 250;

  setCachedCsrf("csrf-token-routines-test");

  // Generate synthetic runs (up to totalRunsCount)
  const allGeneratedRuns: RoutineRun[] = Array.from({ length: totalRunsCount }, (_, i) => ({
    session_id: `cron_job_session_${i + 1}`,
    kind: "session",
    started_at: 1761700000 + i * 3600,  // epoch SECONDS, as Hermes's SessionDB sends them (backend/routines.py run_view)
    duration_s: 15,
    status: i % 10 === 0 ? "error" : "success",
    cost_cents: 5,
    tokens: 1500,
    is_active: false,
  }));

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

    // GET /routines
    if (url.includes("/routines") && !url.includes("/runs") && method === "GET") {
      if (opts?.failRoutines) {
        throw new Error("Falha ao carregar rotinas");
      }
      // Single routine detail
      const singleMatch = url.match(/\/routines\/([^?]+)/);
      if (singleMatch && !url.endsWith("/routines")) {
        const id = decodeURIComponent(singleMatch[1]);
        const found = routinesList.find((r) => r.id === id) || routinesList[0];
        return { routine: found, detail: mockRoutineDetail.detail };
      }
      return { routines: routinesList };
    }

    // GET /routines/{id}/runs (offset pagination, 100 limit per page)
    if (url.includes("/runs") && method === "GET") {
      const u = new URL(`http://localhost${url}`);
      const limit = parseInt(u.searchParams.get("limit") || "100", 10);
      const cursor = u.searchParams.get("cursor");
      const offset = cursor && cursor.startsWith("offset:") ? parseInt(cursor.replace("offset:", ""), 10) : 0;

      const pageRuns = allGeneratedRuns.slice(offset, offset + limit);
      const nextOffset = offset + pageRuns.length;
      const nextCursor = nextOffset < allGeneratedRuns.length ? `offset:${nextOffset}` : null;

      return {
        runs: pageRuns,
        next_cursor: nextCursor,
        truncated: false,
      };
    }

    // POST /routines (create)
    if (url.endsWith("/routines") && method === "POST") {
      const created: Routine = {
        id: `routine-${Date.now()}`,
        bot: body.bot,
        name: body.name,
        schedule: body.schedule,
        state: "paused",
        enabled: false,
      };
      return { routine: created };
    }

    // POST /routines/{id}/test
    if (url.includes("/test") && method === "POST") {
      return { routine: routinesList[0], started: true };
    }

    // POST /routines/{id}/pause
    if (url.includes("/pause") && method === "POST") {
      return { routine: { ...routinesList[0], state: "paused", enabled: false } };
    }

    // POST /routines/{id}/resume
    if (url.includes("/resume") && method === "POST") {
      return { routine: { ...routinesList[0], state: "scheduled", enabled: true } };
    }

    // DELETE /routines/{id}
    if (method === "DELETE") {
      return { ok: true };
    }

    return {};
  });

  return { calls, allGeneratedRuns };
}

describe("Routines Management and Full History (spec §4.9, contract v0.2 §3)", () => {
  beforeEach(() => {
    setLuveLocale("pt");
    resetCsrfToken();
  });

  describe("Full Execution History Pagination (Gate 4: no 20 or 100 ceiling)", () => {
    it("fetchAllRoutineRuns client fetches ALL pages until next_cursor is null (250 runs loaded across 3 pages)", async () => {
      setupRoutinesFetchMock({ totalRuns: 250 });

      // Call client helper with limit 100
      const result = await fetchAllRoutineRuns("routine-vendas-daily", 100);

      expect(result.runs.length).toBe(250);
      expect(result.truncated).toBe(false);
      expect(result.runs[0].session_id).toBe("cron_job_session_1");
      expect(result.runs[249].session_id).toBe("cron_job_session_250");
    });

    it("history rows read Hermes's epoch seconds as a date and the duration as a person reads it (no 1970, no raw float, no null)", async () => {
      setupRoutinesFetchMock({ totalRuns: 2 });
      render(<RoutinesView />);
      await screen.findByText("Relatório diário de vendas");
      fireEvent.click(screen.getByTestId("btn-history-routine-routine-vendas-daily"));
      const row = await screen.findByTestId("routine-run-row-0");
      expect(row.textContent).toMatch(/2025/);
      expect(row.textContent).toContain("15 s");
      expect(row.textContent).not.toMatch(/1970|null|15s/);
    });

    it("UI renders complete history with 250 executions across offset pages without stopping at 20 or 100", async () => {
      setupRoutinesFetchMock({ totalRuns: 250 });
      render(<RoutinesView />);

      await screen.findByText("Relatório diário de vendas");

      // Click "Histórico e Detalhes"
      const historyBtn = screen.getByTestId("btn-history-routine-routine-vendas-daily");
      fireEvent.click(historyBtn);

      // Verify that the title shows 250 executions
      const historyTitle = await screen.findByTestId("history-title");
      expect(historyTitle.textContent).toContain("250");

      // Rows exist in DOM
      expect(screen.getByTestId("routine-run-row-0")).toBeDefined();
      expect(screen.getByTestId("routine-run-row-249")).toBeDefined();
    });
  });

  describe("Routine Paused by Budget Ceiling (spec §4.9, contract v0.2 §3, A-27)", () => {
    it("displays honest reason for routine paused by budget ceiling", async () => {
      setupRoutinesFetchMock();
      render(<RoutinesView />);

      await screen.findByText("Pesquisa contínua de notícias");

      const badge = screen.getByTestId("badge-paused-budget-routine-pesquisa-budget-paused");
      expect(badge.textContent).toBe("Pausada pelo teto de orçamento");
    });

    it("resuming a routine requires explicit human click and confirmation", async () => {
      const { calls } = setupRoutinesFetchMock();
      render(<RoutinesView />);

      await screen.findByText("Pesquisa contínua de notícias");

      // Click "Ativar"
      const resumeBtn = screen.getByTestId("btn-resume-routine-routine-pesquisa-budget-paused");
      fireEvent.click(resumeBtn);

      // Confirmation modal opens
      const modal = await screen.findByTestId("modal-confirm-resume");
      expect(modal).toBeDefined();
      expect(
        within(modal).getByText(/Deseja ativar a rotina 'Pesquisa contínua de notícias'/i)
      ).toBeDefined();

      // No API call before confirmation
      const resumeCallsBefore = calls.filter((c) => c.url.includes("/resume"));
      expect(resumeCallsBefore.length).toBe(0);

      // Confirm in modal
      const confirmBtn = within(modal).getByTestId("btn-confirm-resume-routine");
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const resumeCall = calls.find(
          (c) => c.url.includes("/routines/routine-pesquisa-budget-paused/resume") && c.method === "POST"
        );
        expect(resumeCall).toBeDefined();
        expect(resumeCall?.headers["x-luvebot-csrf"]).toBe("csrf-token-routines-test");
      });
    });
  });

  describe("Test Action Disabled on Paused Routines (contract v0.2 §3, routine_paused)", () => {
    it("test action button is disabled with explanation when routine is paused", async () => {
      const { calls } = setupRoutinesFetchMock();
      render(<RoutinesView />);

      await screen.findByText("Pesquisa contínua de notícias");

      const testBtn = screen.getByTestId("btn-test-routine-routine-pesquisa-budget-paused");
      expect((testBtn as HTMLButtonElement).disabled).toBe(true);
      expect(testBtn.getAttribute("title")).toBe(
        "Testar desabilitado: não é possível testar rotina pausada (routine_paused)"
      );

      // Clicking disabled test button does nothing
      fireEvent.click(testBtn);
      expect(screen.queryByTestId("modal-confirm-test")).toBeNull();
      const testCalls = calls.filter((c) => c.url.includes("/test"));
      expect(testCalls.length).toBe(0);
    });

    it("test action on active routine requires confirmation ('executa trabalho real') and sends confirm: true", async () => {
      const { calls } = setupRoutinesFetchMock();
      render(<RoutinesView />);

      await screen.findByText("Relatório diário de vendas");

      const testBtn = screen.getByTestId("btn-test-routine-routine-vendas-daily");
      expect((testBtn as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(testBtn);

      // Confirmation modal
      const modal = await screen.findByTestId("modal-confirm-test");
      expect(within(modal).getByText(/Aviso: Rodar teste executa trabalho real/i)).toBeDefined();

      const confirmBtn = within(modal).getByTestId("btn-confirm-test");
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const testCall = calls.find(
          (c) => c.url.includes("/routines/routine-vendas-daily/test") && c.method === "POST"
        );
        expect(testCall).toBeDefined();
        expect(testCall?.body).toEqual({ confirm: true });
        expect(testCall?.headers["x-luvebot-csrf"]).toBe("csrf-token-routines-test");
      });
    });
  });

  describe("CRUD Mutations with Confirmation", () => {
    it("delete routine requires typing exact routine name to confirm", async () => {
      const { calls } = setupRoutinesFetchMock();
      render(<RoutinesView />);

      await screen.findByText("Relatório diário de vendas");

      const deleteBtn = screen.getByTestId("btn-delete-routine-routine-vendas-daily");
      fireEvent.click(deleteBtn);

      const modal = await screen.findByTestId("modal-confirm-delete");
      const confirmInput = within(modal).getByTestId("input-delete-confirm-name");
      const confirmBtn = within(modal).getByTestId("btn-confirm-delete");

      // Initially disabled or fails if mismatch
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

      // Type mismatch
      fireEvent.change(confirmInput, { target: { value: "Outro nome" } });
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

      // Type exact name
      fireEvent.change(confirmInput, { target: { value: "Relatório diário de vendas" } });
      expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const deleteCall = calls.find(
          (c) => c.url.includes("/routines/routine-vendas-daily") && c.method === "DELETE"
        );
        expect(deleteCall).toBeDefined();
        expect(deleteCall?.body).toEqual({ confirm_name: "Relatório diário de vendas" });
      });
    });

    it("pause routine requires confirmation", async () => {
      const { calls } = setupRoutinesFetchMock();
      render(<RoutinesView />);

      await screen.findByText("Relatório diário de vendas");

      const pauseBtn = screen.getByTestId("btn-pause-routine-routine-vendas-daily");
      fireEvent.click(pauseBtn);

      const modal = await screen.findByTestId("modal-confirm-pause");
      const confirmBtn = within(modal).getByTestId("btn-confirm-pause");
      fireEvent.click(confirmBtn);

      await waitFor(() => {
        const pauseCall = calls.find(
          (c) => c.url.includes("/routines/routine-vendas-daily/pause") && c.method === "POST"
        );
        expect(pauseCall).toBeDefined();
      });
    });
  });

  describe("Mutation Guard: Stopping pagination after page 1 leaves test RED", () => {
    it("mutation guard: fetchAllRoutineRuns MUST NOT stop at page 1 when more pages exist", async () => {
      setupRoutinesFetchMock({ totalRuns: 250 });

      // We expect all 250 runs
      const result = await fetchAllRoutineRuns("routine-vendas-daily", 100);
      expect(result.runs.length).toBe(250);
    });
  });
});
