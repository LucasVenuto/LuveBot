// tests/unit/empty-states.test.tsx
// Comprehensive unit tests verifying empty states across ALL 10 LuveBot screens:
// Bots, Conversa, Aprovações, Regras, Custos, Rotinas, Atividade, Salas, Mapa, Busca.
// Each screen must display:
// 1. Clear explanation of what is empty (no fake data).
// 2. A useful, actionable next step.
// 3. Complete i18n dictionary backing (accessible).

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Components
import { ContactList } from "@/components/messenger/ContactList";
import { Conversation } from "@/components/conversation/Conversation";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";
import { RulesView } from "@/components/rules/RulesView";
import { CostsView } from "@/components/costs/CostsView";
import { RoutinesView } from "@/components/routines/RoutinesView";
import { ActivityView } from "@/components/activity/ActivityView";
import { RoomsView } from "@/components/rooms/RoomsView";
import { TeamMapView } from "@/components/map/TeamMapView";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";

import type { Bot, Room, TeamMapResponse, CostsResponse, BudgetSnapshot } from "@/api/types";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const mockBot: Bot = {
  name: "assistente",
  is_default: true,
  description: "Assistente de Operações",
  model: { provider: "openai", name: "gpt-4o" },
  status: "idle",
  display: {
    label: "Assistente",
    role: "Operações",
    color: "#38bdf8",
    avatar: { kind: "emoji", value: "🤖" },
  },
};

describe("Estados Vazios em Todas as Telas (T6.4)", () => {
  beforeEach(() => {
    resetCsrfToken();
    setLuveLocale("pt");
    vi.clearAllMocks();
  });

  // 1. Bots
  it("1. Bots: exibe estado vazio claro com botão para criar primeiro Bot", () => {
    const handleOpenCreate = vi.fn();
    render(
      <ContactList
        bots={[]}
        loading={false}
        error={null}
        isOffline={false}
        selectedBotName={null}
        onSelectBot={() => {}}
        onOpenCreate={handleOpenCreate}
      />
    );

    const emptyContainer = screen.getByTestId("bots-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhum Bot ainda")).toBeDefined();

    const createBtn = screen.getByRole("button", { name: /Criar primeiro Bot/i });
    expect(createBtn).toBeDefined();
    fireEvent.click(createBtn);
    expect(handleOpenCreate).toHaveBeenCalledTimes(1);
  });

  // 2. Conversa
  it("2. Conversa: exibe estado vazio amigável com próximo passo e sugestões de prompt", () => {
    render(
      <Conversation
        bot={mockBot}
        initialTurns={[]}
      />
    );

    const emptyContainer = screen.getByTestId("conversation-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText(/Oi! Eu sou Assistente\./i)).toBeDefined(); // the Bot speaks for itself (F8)
    expect(
      screen.getByText(/Me diga o que você precisa. Se quiser, comece por uma destas:/i)
    ).toBeDefined();

    const suggestion1 = screen.getByRole("button", { name: /Como você pode me ajudar hoje\?/i });
    const suggestion2 = screen.getByRole("button", { name: /Liste as habilidades e ferramentas disponíveis\./i });
    expect(suggestion1).toBeDefined();
    expect(suggestion2).toBeDefined();
  });

  // 3. Aprovações
  it("3. Aprovações: exibe estado vazio limpo com aviso de que todas ações foram decididas", () => {
    render(
      <ApprovalsInbox
        bots={[mockBot]}
        authMode="gated"
        initialApprovals={[]}
      />
    );

    const emptyContainer = screen.getByTestId("approvals-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhuma aprovação pendente")).toBeDefined();
    expect(
      screen.getByText(/Tudo em dia! O LuveBot notificará você assim que algum Bot solicitar permissão/i)
    ).toBeDefined();
    expect(
      screen.getByText(/Seus Bots solicitarão autorização aqui antes de executar ações de risco ou ferramentas protegidas\./i)
    ).toBeDefined();
  });

  // 4. Regras
  it("4. Regras: exibe estado vazio explicativo com próximo passo para criar nova regra", () => {
    render(
      <RulesView
        bots={[mockBot]}
        authMode="gated"
        initialRules={[]}
      />
    );

    const emptyContainer = screen.getByTestId("rules-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhuma regra encontrada")).toBeDefined();
    expect(
      screen.getByText(/Crie uma nova regra ou ajuste os filtros para visualizar as diretivas de governança\./i)
    ).toBeDefined();

    const newRuleBtn = within(emptyContainer).getByRole("button", { name: /Nova regra/i });
    expect(newRuleBtn).toBeDefined();
  });

  // 5. Custos
  it("5. Custos: exibe estado vazio honesto com próximo passo para configurar limites de gasto", () => {
    const emptyCosts: CostsResponse = {
      period: "day",
      currency: "USD",
      totals: {
        spend_cents: 0,
        unpriced_sessions: 0,
      },
      groups: [],
      ledger: {
        lag_s: 0,
        watcher_stale: false,
      },
    };
    const emptyBudget: BudgetSnapshot = {
      limits: [
        {
          scope: "global",
          period: "day",
          cents: 1000,
          spent_cents: 0,
          percent: 0,
        },
      ],
      paused: [],
      watcher: {
        last_at: Date.now(),
        stale: false,
      },
      alerts: [],
    };

    render(
      <CostsView
        bots={[mockBot]}
        authMode="gated"
        initialCosts={emptyCosts}
        initialBudget={emptyBudget}
      />
    );

    const emptyContainer = screen.getByTestId("costs-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhum dado de custo registrado para os filtros selecionados.")).toBeDefined();
    expect(
      screen.getByText(/Os custos de execução e consumo de tokens aparecerão aqui conforme os Bots forem utilizados\./i)
    ).toBeDefined();

    const setLimitBtn = screen.getByRole("button", { name: /Definir novo teto/i });
    expect(setLimitBtn).toBeDefined();
  });

  // 6. Rotinas
  it("6. Rotinas: exibe estado vazio com explicação de cron e botão para criar primeira rotina", () => {
    render(
      <RoutinesView
        bots={[mockBot]}
        initialRoutines={[]}
      />
    );

    const emptyContainer = screen.getByTestId("routines-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhuma rotina encontrada com os filtros selecionados.")).toBeDefined();
    expect(
      within(emptyContainer).getByText(/Gerencie tarefas recorrentes, histórico completo e testes com segurança\./i)
    ).toBeDefined();

    const createRoutineBtn = screen.getByRole("button", { name: /Criar rotina/i });
    expect(createRoutineBtn).toBeDefined();
  });

  // 7. Atividade
  it("7. Atividade: exibe estado vazio quando não há tarefas com próximo passo para delegar ou acionar", () => {
    render(
      <ActivityView
        bots={[mockBot]}
        initialItems={[]}
      />
    );

    const emptyContainer = screen.getByTestId("activity-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhuma atividade encontrada para os filtros atuais.")).toBeDefined();
    expect(
      screen.getByText(/Inicie uma conversa com um Bot para delegar novas tarefas ou acione uma rotina\./i)
    ).toBeDefined();
  });

  // 8. Salas
  it("8. Salas: exibe estado vazio quando nenhuma sala está selecionada ou ativa", async () => {
    setCustomFetchJSON(async (endpoint: string) => {
      if (endpoint === "/api/plugins/luvebot/rooms") {
        return { rooms: [] };
      }
      return {};
    });

    render(
      <RoomsView
        roomId={null}
        availableBots={[mockBot]}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("rooms-empty-state")).toBeDefined();
    });

    expect(screen.getByText("Nenhuma sala selecionada. Selecione uma sala na barra lateral ou crie uma nova sala.")).toBeDefined();
    expect(
      screen.getByText("Crie uma sala para reunir múltiplos Bots e humanos colaborando em um objetivo comum.")
    ).toBeDefined();
  });

  // 9. Mapa
  it("9. Mapa: exibe estado vazio informativo quando não há nós ou handoffs", () => {
    const emptyMap: TeamMapResponse = {
      nodes: [],
      edges: [],
      generated_at: "2026-10-01T00:00:00Z",
    };

    render(
      <TeamMapView
        availableBots={[mockBot]}
        initialMapData={emptyMap}
      />
    );

    const emptyContainer = screen.getByTestId("map-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText("Nenhum Bot encontrado no mapa")).toBeDefined();
    expect(
      screen.getByText("Crie Bots e configure salas para visualizar a estrutura do time e os handoffs entre agentes.")
    ).toBeDefined();
  });

  // 10. Busca
  it("10. Busca: exibe estado vazio amigável com próximo passo útil quando busca não possui resultados", () => {
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={() => {}}
        availableBots={[]}
        availableRooms={[]}
      />
    );

    // Digita um termo sem correspondência
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "inexistente" } });

    const emptyContainer = screen.getByTestId("search-empty-state");
    expect(emptyContainer).toBeDefined();
    expect(screen.getByText('Nenhum resultado encontrado para "inexistente"')).toBeDefined();
    expect(screen.getByText("Use as setas para navegar ou selecione uma ação rápida.")).toBeDefined();
  });
});
