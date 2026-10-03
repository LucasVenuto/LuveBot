// tests/unit/bots/reopen.test.tsx
// Mochi's demo (falha.png): "Novo Bot" opened a second time, without a reload, showed the PREVIOUS Bot's final step. The shell
// keeps BotCreateModal mounted and only flips isOpen, so every opening must start at step 1 with an empty form, also after
// closing halfway.
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BotCreateModal } from "@/components/bots/BotCreateModal";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

const bot = { name: "vendas", is_default: false, status: "idle", model: { provider: "openrouter", name: "m" },
  display: { label: "Vendas", role: "Prospecção B2B", color: "#60a5fa", avatar: { kind: "mascot", value: "zuca" } } };

beforeEach(() => {
  resetCsrfToken();
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:user", auth_mode: "gated" };
    if (url.endsWith("/bots") && init?.method === "POST") return { bot, intro: { session_id: null } };
    if (url.endsWith("/introduction")) return { state: "unavailable", session_id: null, run_id: null, estimate_cents: null, requires_confirm: true, reason: "no_template" };
    throw new Error("unexpected " + url);
  });
});

const atStep1 = () => {
  expect(screen.getByText(/Passo 1 de 4/)).toBeTruthy();
  expect(screen.getByText("Criar do Zero")).toBeTruthy();
  expect(screen.queryByTestId("bot-presentation")).toBeNull();
};

describe("Novo Bot always opens at step 1 with an empty form", () => {
  it("after a Bot was created and 'Iniciar com este Bot' closed the wizard", async () => {
    const onClose = vi.fn();
    const view = render(<BotCreateModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("Vendas"));
    fireEvent.click(screen.getByText("Avançar"));
    fireEvent.click(screen.getByText("Avançar"));
    fireEvent.click(screen.getByText("Criar Bot"));
    await waitFor(() => expect(screen.getByTestId("bot-presentation")).toBeTruthy());
    fireEvent.click(screen.getByText("Iniciar com este Bot"));
    expect(onClose).toHaveBeenCalled();

    view.rerender(<BotCreateModal isOpen={false} onClose={onClose} />);  // the shell closes it but keeps it mounted
    view.rerender(<BotCreateModal isOpen onClose={onClose} />);
    atStep1();
    expect(screen.queryByText("Bot criado com sucesso!")).toBeNull();
  });

  it("after closing halfway: the step and what was typed do not come back", () => {
    const view = render(<BotCreateModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Vendas"));
    fireEvent.change(screen.getByPlaceholderText("ex: Alex"), { target: { value: "Lucas" } });  // a field no template fills
    fireEvent.click(screen.getByLabelText("Fechar"));

    view.rerender(<BotCreateModal isOpen={false} onClose={vi.fn()} />);
    view.rerender(<BotCreateModal isOpen onClose={vi.fn()} />);
    atStep1();
    fireEvent.click(screen.getByText("Vendas"));
    expect((screen.getByPlaceholderText("ex: Alex") as HTMLInputElement).value).toBe("");
  });
});
