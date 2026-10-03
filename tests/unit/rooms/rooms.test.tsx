// tests/unit/rooms/rooms.test.tsx
// Comprehensive unit tests for Salas (Rooms) adhering strictly to T5.1:
// - Contract docs/contracts/plugin-api-v0.3.md (/rooms, /handoffs)
// - @ mention autocomplete ONLY offers and accepts member bots (and @todos)
// - 422 not_a_member backend refusal rendered with clear error message
// - @todos triggers cost confirmation (confirm_cost)
// - Handoff cards render in the room with link to the Kanban task
// - Hostile bot/tool markup rendered safely as text/markdown (never raw HTML)
// - Parar and retry with confirmation; Parar stays visible until confirmed terminal state
// - Mutation Guard: offering a non-member in the @ list MUST leave test RED

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RoomsView } from "@/components/rooms/RoomsView";
import type { Room, Bot, Handoff, RoomEvent } from "@/api/types";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

const mockBots: Bot[] = [
  {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Prospecção B2B",
      color: "#60a5fa",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Bot de Vendas",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "idle",
  },
  {
    name: "dev",
    is_default: false,
    display: {
      label: "Dev",
      role: "Engenheiro de Software",
      color: "#a78bfa",
      avatar: { kind: "emoji", value: "💻" },
    },
    description: "Bot Desenvolvedor",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "idle",
  },
  {
    name: "pesquisa", // Non-member bot!
    is_default: false,
    display: {
      label: "Pesquisa",
      role: "Pesquisador de Mercado",
      color: "#34d399",
      avatar: { kind: "emoji", value: "🔍" },
    },
    description: "Bot de Pesquisa",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "idle",
  },
];

const mockRoom: Room = {
  id: "room-123",
  name: "Esquadrão Suporte",
  members: [
    {
      member_id: "mem-vendas",
      bot: "vendas",
      handle: "vendas",
      display_name: "Vendas",
      color: "#60a5fa",
    },
    {
      member_id: "mem-dev",
      bot: "dev",
      handle: "dev",
      display_name: "Dev",
      color: "#a78bfa",
    },
  ],
  created_at: "2026-10-01T00:00:00Z",
  driver: {
    running: true,
    pending_actions_count: 0,
  },
  goal: "Coordenar atendimento e correção de bugs",
  owner: "vendas",
  coordinator: "dev",
  open_tasks: 1,
};

const mockHandoff: Handoff = {
  id: "hand-456",
  from: "vendas",
  to: "dev",
  title: "Investigar falha no webhook de pagamento",
  task_id: "task-kanban-789",
  state: "ready",
  room_id: "room-123",
  created_at: "2026-10-01T01:00:00Z",
  updated_at: "2026-10-01T01:00:00Z",
};

const mockEvents: RoomEvent[] = [
  {
    seq: 1,
    event_id: "evt-1",
    kind: "message.member",
    actor: { kind: "member", id: "vendas", display_name: "Vendas" },
    payload: { text: "Olá time! Temos um caso urgente para resolver." },
    at: "2026-10-01T01:05:00Z",
  },
  {
    seq: 2,
    event_id: "evt-2",
    kind: "handoff.card",
    actor: { kind: "system", id: "system" },
    payload: {
      handoff_id: "hand-456",
      from: "vendas",
      to: "dev",
      title: "Investigar falha no webhook de pagamento",
      task_id: "task-kanban-789",
      status: "ready",
    },
    at: "2026-10-01T01:10:00Z",
  },
];

describe("Tela de Salas (RoomsView - T5.1)", () => {
  beforeEach(() => {
    resetCsrfToken();
  });

  function setupSimulatedApi(overrides: {
    sendResult?: any;
    sendError?: any;
    roomDriverRunning?: boolean;
    roomsList?: Room[];
    eventsList?: RoomEvent[];
    handoffsList?: Handoff[];
  } = {}) {
    const calls: { url: string; method?: string; body?: any; headers?: any }[] = [];

    const currentDriverRunning = overrides.roomDriverRunning !== undefined ? overrides.roomDriverRunning : true;

    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method || "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body, headers: init?.headers });

      if (url.includes("/session")) {
        return { csrf: "mock-csrf-token", actor: "dashboard", auth_mode: "gated" };
      }

      if (url === "/api/plugins/luvebot/rooms" && method === "GET") {
        return { rooms: overrides.roomsList ?? [mockRoom] };
      }

      if (url === `/api/plugins/luvebot/rooms/${mockRoom.id}` && method === "GET") {
        return {
          room: {
            ...mockRoom,
            driver: {
              ...mockRoom.driver,
              running: currentDriverRunning,
            },
          },
        };
      }

      if (url.includes(`/api/plugins/luvebot/rooms/${mockRoom.id}/log`)) {
        return { events: overrides.eventsList ?? mockEvents, next_seq: 3 };
      }

      if (url.includes("/api/plugins/luvebot/handoffs")) {
        return { handoffs: overrides.handoffsList ?? [mockHandoff] };
      }

      if (url.includes(`/api/plugins/luvebot/rooms/${mockRoom.id}/messages`)) {
        if (overrides.sendError) {
          throw overrides.sendError;
        }
        return (
          overrides.sendResult ?? {
            event: {
              seq: 3,
              event_id: "evt-3",
              kind: "message.user",
              actor: { kind: "user", id: "desktop" },
              payload: { text: body?.text || "" },
              at: "2026-10-01T01:15:00Z",
            },
            targets: ["vendas"],
            accepted: true,
          }
        );
      }

      if (url.includes(`/api/plugins/luvebot/rooms/${mockRoom.id}/stop`)) {
        return { stopped: true, cancel_id: "req-stop-1" };
      }

      if (url.includes(`/api/plugins/luvebot/rooms/${mockRoom.id}/tasks/`)) {
        return { retried: true };
      }

      return {};
    });

    return { calls };
  }

  it("1. @ mention autocomplete ONLY offers member bots and @todos, NEVER non-members", async () => {
    setupSimulatedApi();

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
      />
    );

    // Wait for room to load
    await waitFor(() => {
      expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
    });

    const textarea = screen.getByPlaceholderText(/Digite uma mensagem/i);
    // Type @ to trigger autocomplete
    fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });

    // Autocomplete listbox must be visible
    const listbox = await screen.findByRole("listbox");
    expect(listbox).toBeDefined();

    // Must offer @todos, @vendas, and @dev
    expect(screen.getByText(/todos — Acionar todos os membros/i)).toBeDefined();
    expect(screen.getByText(/Vendas \(@vendas\)/i)).toBeDefined();
    expect(screen.getByText(/Dev \(@dev\)/i)).toBeDefined();

    // MUST NOT offer non-member bot 'pesquisa'!
    expect(screen.queryByText(/pesquisa/i)).toBeNull();
  });

  it("2. Backend refusal 422 not_a_member displays clear error alert in UI", async () => {
    const error422 = new ApiError({
      code: "not_a_member",
      message: "handle not a member",
      status: 422,
      details: { handles: ["pesquisa"] },
    });

    setupSimulatedApi({ sendError: error422 });

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
    });

    const textarea = screen.getByPlaceholderText(/Digite uma mensagem/i);
    fireEvent.change(textarea, { target: { value: "Aviso para @pesquisa" } });

    const sendBtn = screen.getByRole("button", { name: "Enviar" });
    fireEvent.click(sendBtn);

    // Refusal error alert appears with the offending handle
    const alert = await screen.findByRole("alert");
    expect(alert).toBeDefined();
    expect(alert.textContent).toContain("O Bot '@pesquisa' não é membro desta sala");
  });

  it("3. @todos or multi-target mentions trigger cost confirmation modal before dispatching confirm_cost", async () => {
    const { calls } = setupSimulatedApi();

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
    });

    const textarea = screen.getByPlaceholderText(/Digite uma mensagem/i);
    // User mentions @todos
    fireEvent.change(textarea, { target: { value: "Atenção @todos reunião geral" } });

    const sendBtn = screen.getByRole("button", { name: "Enviar" });
    fireEvent.click(sendBtn);

    // Cost confirmation modal MUST open
    const costModal = await screen.findByRole("dialog");
    expect(costModal).toBeDefined();
    expect(screen.getByText(/Aviso de Custo: @todos/i)).toBeDefined();
    expect(screen.getByText(/Mencionar @todos ou múltiplos Bots acionará rodadas coordenadas/i)).toBeDefined();

    // Confirm cost
    const confirmBtn = screen.getByRole("button", { name: "Confirmar e Enviar" });
    fireEvent.click(confirmBtn);

    // Verify API was called with confirm_cost: true
    await waitFor(() => {
      const msgCall = calls.find((c) => c.url.includes("/messages"));
      expect(msgCall).toBeDefined();
      expect(msgCall?.body?.confirm_cost).toBe(true);
      expect(msgCall?.body?.text).toBe("Atenção @todos reunião geral");
    });
  });

  it("4. Handoff appears in the room with direct link to the Kanban task", async () => {
    const onNavigateToKanban = vi.fn();
    setupSimulatedApi();

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
        onNavigateToKanban={onNavigateToKanban}
      />
    );

    // Wait for room events to load
    await waitFor(() => {
      expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
    });

    // Handoff card rendered in room timeline
    expect(screen.getByText("De @vendas para @dev")).toBeDefined();
    expect(screen.getByText("Investigar falha no webhook de pagamento")).toBeDefined();

    // Kanban link button
    const kanbanLink = screen.getByTestId("handoff-kanban-link");
    expect(kanbanLink).toBeDefined();
    expect(kanbanLink.textContent).toContain("Ver tarefa no Kanban");

    fireEvent.click(kanbanLink);
    expect(onNavigateToKanban).toHaveBeenCalledWith("task-kanban-789");
  });

  it("5. Hostile HTML/script in bot or tool messages is rendered as safe text/markdown, NEVER executed", async () => {
    const hostileEvent: RoomEvent = {
      seq: 10,
      event_id: "evt-hostile",
      kind: "message.member",
      actor: { kind: "member", id: "vendas", display_name: "Vendas" },
      payload: {
        text: "<script>window.pwned = true;</script><img src='x' onerror='window.pwned = true' />Texto normal",
      },
      at: "2026-10-01T01:20:00Z",
    };

    setupSimulatedApi({ eventsList: [hostileEvent] });

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
    });

    // Global window must NOT have been pwned
    expect((window as any).pwned).toBeUndefined();

    // Dangerous tags are escaped as text, not evaluated DOM elements
    expect(document.querySelector("script:not([type])")).toBeNull();
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByText(/Texto normal/i)).toBeDefined();
  });

  it("6. 'Parar' button requires confirmation and CONTINUES VISIBLE until backend confirms terminal state", async () => {
    // Room starts running
    let isRunning = true;

    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.includes("/session")) {
        return { csrf: "mock-csrf-token", actor: "dashboard", auth_mode: "gated" };
      }
      if (url === "/api/plugins/luvebot/rooms") {
        return { rooms: [mockRoom] };
      }
      if (url === `/api/plugins/luvebot/rooms/${mockRoom.id}`) {
        return { room: { ...mockRoom, driver: { ...mockRoom.driver, running: isRunning } } };
      }
      if (url.includes("/log")) {
        return { events: [], next_seq: 1 };
      }
      if (url.includes("/handoffs")) {
        return { handoffs: [] };
      }
      if (url.includes(`/api/plugins/luvebot/rooms/${mockRoom.id}/stop`)) {
        // Stop called, but isRunning is not yet false until next poll
        return { stopped: true, cancel_id: "req-1" };
      }
      return {};
    });

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
      />
    );

    // Parar button is visible
    const stopBtn = await screen.findByTestId("btn-stop-room");
    expect(stopBtn).toBeDefined();
    expect(stopBtn.textContent).toBe("Parar");

    // Click Parar -> opens confirmation modal
    fireEvent.click(stopBtn);
    expect(screen.getByText("Parar Execução da Sala")).toBeDefined();

    // Confirm Stop
    const confirmStopBtn = screen.getByRole("button", { name: "Confirmar Parada" });
    fireEvent.click(confirmStopBtn);

    // PARAR MUST CONTINUE VISIBLE IN THE DOM with 'Parando...' while waiting for confirmation!
    await waitFor(() => {
      const pendingStopBtn = screen.getByTestId("btn-stop-room");
      expect(pendingStopBtn).toBeDefined();
      expect(pendingStopBtn.textContent).toBe("Parando...");
      expect((pendingStopBtn as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("7. Failed turn renders Retry button with confirmation", async () => {
    const failedEvent: RoomEvent = {
      seq: 20,
      event_id: "evt-fail",
      kind: "turn.failed",
      actor: { kind: "system", id: "system" },
      payload: {
        task_id: "task-failed-123",
        error: "Timeout na execução do subagente",
      },
      at: "2026-10-01T02:00:00Z",
    };

    const { calls } = setupSimulatedApi({ eventsList: [failedEvent] });

    render(
      <RoomsView
        roomId={mockRoom.id}
        availableBots={mockBots}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
    });

    expect(screen.getByText("Falhou")).toBeDefined();
    expect(screen.getByText("Timeout na execução do subagente")).toBeDefined();

    // Retry button exists
    const retryBtn = screen.getByRole("button", { name: "Tentar novamente" });
    fireEvent.click(retryBtn);

    // Modal confirmation opens
    expect(screen.getByText("Repetir Tarefa da Sala")).toBeDefined();
    const confirmRetryBtn = screen.getByRole("button", { name: "Repetir Tarefa" });
    fireEvent.click(confirmRetryBtn);

    await waitFor(() => {
      const retryCall = calls.find((c) => c.url.includes("/tasks/task-failed-123/retry"));
      expect(retryCall).toBeDefined();
      expect(retryCall?.body?.confirm).toBe(true);
    });
  });

  describe("8. Mutation Guard: Offering a non-member in @ mentions MUST FAIL THE TEST", () => {
    it("mutation guard: non-member bot 'pesquisa' MUST NOT be offered; if offered, test turns RED", async () => {
      setupSimulatedApi();

      // In this test, we verify that the component's mention filter rejects non-members.
      // If a faulty implementation were to pass `overrideMentionSuggestionsForMutationTest`
      // containing the non-member 'pesquisa', this assertion WILL FAIL.
      render(
        <RoomsView
          roomId={mockRoom.id}
          availableBots={mockBots}
          // Default behavior: uses mockRoom.members only!
        />
      );

      await waitFor(() => {
        expect(screen.getByText("Esquadrão Suporte")).toBeDefined();
      });

      const textarea = screen.getByPlaceholderText(/Digite uma mensagem/i);
      fireEvent.change(textarea, { target: { value: "@", selectionStart: 1 } });

      const listbox = await screen.findByRole("listbox");
      expect(listbox).toBeDefined();

      // Guard: under no circumstances should 'pesquisa' appear
      const pesquisaItem = screen.queryByText(/pesquisa/i);
      expect(pesquisaItem).toBeNull();
    });
  });
});
