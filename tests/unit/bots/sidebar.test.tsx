// tests/unit/bots/sidebar.test.tsx
// Unit tests for BotSidebarList component (spec 4.1: 5 bot states + 4 list states)

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContactList } from "@/components/messenger/ContactList";
import type { Bot } from "@/api/types";

describe("ContactList (spec 4.1)", () => {
  const baseBot: Bot = {
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
    status: "idle",
  };

  it("renders the 5 mandatory Bot states: waiting_approval, unread, working, paused, error", () => {
    const botsWithAllStates: Bot[] = [
      {
        ...baseBot,
        name: "bot-waiting",
        display: { ...baseBot.display, label: "Bot Aprovação" },
        status: "waiting_approval",
      },
      {
        ...baseBot,
        name: "bot-unread",
        display: { ...baseBot.display, label: "Bot Não Lido" },
        status: "idle",
        unread: true,
      },
      {
        ...baseBot,
        name: "bot-working",
        display: { ...baseBot.display, label: "Bot Trabalhando" },
        status: "working",
      },
      {
        ...baseBot,
        name: "bot-paused",
        display: { ...baseBot.display, label: "Bot Pausado" },
        status: "paused",
      },
      {
        ...baseBot,
        name: "bot-error",
        display: { ...baseBot.display, label: "Bot Erro" },
        status: "error",
      },
    ];

    render(<ContactList bots={botsWithAllStates} />);

    // 1. ! for waiting_approval (needs you)
    expect(screen.getByLabelText("Precisa de você")).toBeDefined();
    expect(screen.getByText("!")).toBeDefined();

    // 2. • for unread
    expect(screen.getByLabelText("Não lido")).toBeDefined();

    // 3. animated for working
    expect(screen.getByLabelText("Trabalhando")).toBeDefined();
    expect(screen.getByText(/digitando/i)).toBeDefined();

    // 4. ‖ for paused
    expect(screen.getByLabelText("Pausado")).toBeDefined();
    expect(screen.getByText("‖")).toBeDefined();

    // 5. × for error
    expect(screen.getByLabelText("Erro")).toBeDefined();
    expect(screen.getByText("×")).toBeDefined();
  });

  it("renders the empty list state with 'Nenhum Bot ainda' and CTA to create", () => {
    const onOpenCreate = vi.fn();
    render(<ContactList bots={[]} onOpenCreate={onOpenCreate} />);

    expect(screen.getByText("Nenhum Bot ainda")).toBeDefined();
    const createBtn = screen.getByText("Criar primeiro Bot");
    expect(createBtn).toBeDefined();

    fireEvent.click(createBtn);
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
  });

  it("renders the loading state with skeletons and aria-busy", () => {
    render(<ContactList bots={[]} loading={true} />);

    const container = screen.getByLabelText("Carregando bots");
    expect(container).toBeDefined();
    expect(container.getAttribute("aria-busy")).toBe("true");
  });

  it("renders the error list state with retry button", () => {
    const onRetry = vi.fn();
    render(<ContactList bots={[]} error="Falha 502 upstream" onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toBeDefined();
    expect(screen.getByText("Falha 502 upstream")).toBeDefined();

    const retryBtn = screen.getByText("Tentar novamente");
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the offline/disconnected state with message", () => {
    const onRetry = vi.fn();
    render(<ContactList bots={[]} isOffline={true} onRetry={onRetry} />);

    expect(screen.getByRole("status")).toBeDefined();
    expect(screen.getByText("Sem conexão com o Hermes")).toBeDefined();

    const reconnBtn = screen.getByText("Reconectar agora");
    fireEvent.click(reconnBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("triggers onSelectBot when a bot item is clicked", () => {
    const onSelectBot = vi.fn();
    render(<ContactList bots={[baseBot]} onSelectBot={onSelectBot} />);

    const botButton = screen.getByText("Vendas");
    fireEvent.click(botButton);

    expect(onSelectBot).toHaveBeenCalledWith(baseBot);
  });
});
