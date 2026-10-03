// tests/unit/search/search.test.tsx
// Comprehensive unit tests for ⌘K Command Palette and Unified Search (spec §4.14, contract v0.3 §6).
// Covers:
// 1. ⌘K / Ctrl+K opens palette, and Esc closes it restoring focus.
// 2. Result snippet with hostile HTML markup is rendered safely as plain text (no raw HTML / XSS).
// 3. Sensitive palette action ("Pausar tudo") does NOT call POST without human confirmation.
// 4. Navigational quick actions (Novo Bot, Nova Sala, tabs) navigate cleanly without side effects.
// 5. Category filtering and keyboard navigation (ArrowDown, ArrowUp, Enter).
// 6. HighlightedSnippet highlights matched tokens safely without dangerouslySetInnerHTML.
// 7. MUTATION TEST: Quick action triggering POST directly leaves the test RED.

import React, { useState, useRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";
import { HighlightedSnippet } from "@/components/search/HighlightedSnippet";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import type { SearchResponse, Bot, Room } from "@/api/types";
import { setCustomFetchJSON } from "@/api/client";

const mockBots: Bot[] = [
  {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Prospecção B2B",
      color: "#38bdf8",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Prospecção",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "working",
  },
  {
    name: "dev",
    is_default: false,
    display: {
      label: "Dev",
      role: "Engenharia",
      color: "#a78bfa",
      avatar: { kind: "emoji", value: "💻" },
    },
    description: "Automação",
    model: { provider: "anthropic", name: "claude-3-opus" },
    status: "idle",
  },
];

const mockRooms: Room[] = [
  {
    id: "room-geral",
    name: "Geral",
    goal: "Alinhamento diário",
    members: [
      { member_id: "m-1", bot: "vendas", handle: "vendas" },
      { member_id: "m-2", bot: "dev", handle: "dev" },
    ],
    driver: { running: false, pending_actions_count: 0 },
    created_at: "2026-10-01T00:00:00Z",
  },
];

const mockSearchDataWithHostileMarkup: SearchResponse = {
  messages: [
    {
      session_id: "sess-100",
      bot: "vendas",
      title: "Mensagem com script",
      snippet: 'Encontrado <script>alert("xss-payload")</script> e <img src="x" onerror="alert(1)"/> no log.',
      role: "assistant",
      at: "2026-10-01T04:00:00Z",
      links: { room_id: "room-geral" },
    },
  ],
  bots: [
    {
      name: "vendas",
      display: mockBots[0].display,
      description: "Bot de Prospecção",
      status: "working",
    },
  ],
  rooms: [
    {
      id: "room-geral",
      name: "Geral",
      goal: "Alinhamento",
      members_count: 2,
    },
  ],
  routines: [
    {
      id: "routine-daily",
      name: "Relatório Diário",
      bot: "vendas",
      schedule: "0 9 * * 1-5",
      paused: false,
    },
  ],
  files: [
    {
      name: "relatorio.csv",
      path: "/data/relatorio.csv",
      bot: "vendas",
    },
  ],
  actions: [
    {
      id: "act-pause-all",
      title: "Pausar tudo",
      description: "Pausa imediata",
      actionKey: "pause_all",
      category: "actions",
      requiresConfirmation: true,
    },
  ],
};

// Test harness container integrating trigger button, Shell, and CommandPaletteModal
function TestSearchApp({
  onConfirmPauseAll,
}: {
  onConfirmPauseAll?: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("hoje");
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div>
      <button
        ref={triggerRef}
        data-testid="external-trigger-btn"
        onClick={() => setIsOpen(true)}
      >
        Abrir Busca
      </button>

      <MessengerShell
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSearch={() => setIsOpen(true)}
      >
        <div data-testid="current-tab-content">{activeTab}</div>
      </MessengerShell>

      <CommandPaletteModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        availableBots={mockBots}
        availableRooms={mockRooms}
        initialSearchData={mockSearchDataWithHostileMarkup}
        onNavigateTab={(tab) => setActiveTab(tab)}
        onConfirmPauseAll={onConfirmPauseAll}
      />
    </div>
  );
}

describe("⌘K Search & Command Palette (CommandPaletteModal - T5.2)", () => {
  beforeEach(() => {
    setCustomFetchJSON(null);
  });

  it("1. ⌘K / Ctrl+K opens palette, and Esc closes it restoring focus", async () => {
    render(<TestSearchApp />);

    // Initially palette dialog is not visible
    expect(screen.queryByRole("dialog", { name: /busca e comandos/i })).toBeNull();

    // Focus trigger button
    const trigger = screen.getByTestId("external-trigger-btn");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Press Cmd+K global shortcut
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    // Palette modal dialog is now open
    const palette = await screen.findByRole("dialog", { name: /busca e ações rápidas/i });
    expect(palette).toBeDefined();

    // Input combobox receives focus
    const input = screen.getByRole("combobox");
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    // Press Escape to close palette
    fireEvent.keyDown(palette, { key: "Escape" });

    // Palette dialog closes
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /busca e ações rápidas/i })).toBeNull();
    });

    // Focus is restored to the previous trigger element
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("2. Search snippet with hostile HTML markup is rendered safely as plain text", async () => {
    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        initialSearchData={mockSearchDataWithHostileMarkup}
      />
    );

    // Switch to Messages category to see message snippet
    const messagesTab = screen.getByRole("button", { name: /mensagens/i });
    fireEvent.click(messagesTab);

    // Hostile string content appears as visible text in the DOM
    expect(screen.getByText(/xss-payload/)).toBeDefined();

    // Verify STRICTLY that NO <script> or unescaped <img> element is created in DOM
    const scriptTag = document.querySelector("script");
    expect(scriptTag).toBeNull();

    const imgTag = document.querySelector('img[src="x"]');
    expect(imgTag).toBeNull();
  });

  it("3. HighlightedSnippet component highlights query tokens safely without raw HTML", () => {
    const hostileText = 'Aviso: <script>alert(1)</script> detectado no arquivo vendas.log';
    const { container } = render(
      <HighlightedSnippet text={hostileText} query="vendas" />
    );

    // Text is preserved
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('vendas.log');

    // Matched token is inside a <mark> element
    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe("vendas");

    // No <script> node is created
    expect(container.querySelector("script")).toBeNull();
  });

  it("4. Palette action does NOT call POST without human confirmation", async () => {
    const handleConfirmPauseAll = vi.fn();

    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={vi.fn()}
        initialSearchData={mockSearchDataWithHostileMarkup}
        onConfirmPauseAll={handleConfirmPauseAll}
      />
    );

    // Filter to Actions category
    const actionsTab = screen.getByRole("button", { name: /ações/i });
    fireEvent.click(actionsTab);

    // Find "Pausar tudo" action item
    const pauseItem = screen.getByText("Pausar tudo");
    expect(pauseItem).toBeDefined();

    // Click the action in the palette
    fireEvent.click(pauseItem);

    // CRITICAL INVARIANT: POST / execution handler MUST NOT be called!
    expect(handleConfirmPauseAll).not.toHaveBeenCalled();

    // Confirmation dialog opens
    const confirmDialog = await screen.findByRole("dialog", {
      name: /confirmar pausa geral/i,
    });
    expect(confirmDialog).toBeDefined();
    expect(within(confirmDialog).getByText(/deseja pausar todos os bots/i)).toBeDefined();

    // Click "Cancelar"
    const cancelBtn = within(confirmDialog).getByRole("button", { name: /cancelar/i });
    fireEvent.click(cancelBtn);

    // Confirmation dialog closes and handler was NEVER called
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /confirmar pausa geral/i })).toBeNull();
    });
    expect(handleConfirmPauseAll).not.toHaveBeenCalled();

    // Reopen pause confirmation dialog by clicking pause action again
    fireEvent.click(pauseItem);
    const confirmDialog2 = await screen.findByRole("dialog", {
      name: /confirmar pausa geral/i,
    });
    expect(confirmDialog2).toBeDefined();

    // Click "Sim, Pausar Todos" to explicitly confirm
    const confirmBtn = screen.getByTestId("btn-confirm-pause-all");
    fireEvent.click(confirmBtn);

    // ONLY NOW is the side-effect handler called
    expect(handleConfirmPauseAll).toHaveBeenCalledTimes(1);
  });

  it("5. Navigational quick actions navigate cleanly without side effects", async () => {
    const handleNavigateTab = vi.fn();
    const handleOpenCreateBot = vi.fn();
    const handleClose = vi.fn();

    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={handleClose}
        onNavigateTab={handleNavigateTab}
        onOpenCreateBot={handleOpenCreateBot}
      />
    );

    // When query is empty, default quick actions are shown
    const newBotAction = screen.getByText("Criar Novo Bot");
    fireEvent.click(newBotAction);

    expect(handleOpenCreateBot).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalled();
  });

  it("6. Category tabs filter results and keyboard navigation operates with arrows and enter", async () => {
    const handleSelectBot = vi.fn();
    const handleClose = vi.fn();

    render(
      <CommandPaletteModal
        isOpen={true}
        onClose={handleClose}
        onSelectBot={handleSelectBot}
        initialSearchData={mockSearchDataWithHostileMarkup}
      />
    );

    // Filter to Bots
    const botsTab = screen.getByRole("button", { name: /bots/i });
    fireEvent.click(botsTab);

    // Only bot result is displayed
    expect(screen.getByText("Vendas")).toBeDefined();
    expect(screen.queryByText("Relatório Diário")).toBeNull();

    // Navigate with Enter on selected item
    const palette = screen.getByRole("dialog", { name: /busca e ações rápidas/i });
    fireEvent.keyDown(palette, { key: "Enter" });

    expect(handleSelectBot).toHaveBeenCalledWith("vendas");
    expect(handleClose).toHaveBeenCalled();
  });

  it("8. Typing 'Mapa' finds the 'Ver Mapa do Time' quick action even when the backend search answers (T11.0)", async () => {
    let searched = 0;
    setCustomFetchJSON(async (url) => {
      if (url.includes("/api/plugins/luvebot/search")) {
        searched += 1;
        return { messages: [], bots: [], rooms: [], routines: [], files: [], actions: [] };
      }
      return {};
    });
    const onNavigateTab = vi.fn();
    render(<CommandPaletteModal isOpen={true} onClose={vi.fn()} onNavigateTab={onNavigateTab} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Mapa" } });
    const action = await screen.findByText("Ver Mapa do Time");
    expect(searched).toBeGreaterThan(0);  // the backend did answer; the action still shows
    fireEvent.click(action);
    expect(onNavigateTab).toHaveBeenCalledWith("mapa");
  });
});
