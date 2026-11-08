// tests/unit/bots/create.test.tsx
// Unit tests for BotCreateModal wizard (spec 4.6)

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BotCreateModal } from "@/components/bots/BotCreateModal";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Bot, CreateBotResponse } from "@/api/types";

describe("BotCreateModal (spec 4.6)", () => {
  beforeEach(() => {
    resetCsrfToken();
    setCustomFetchJSON(null);
  });

  const createdBotFixture: Bot = {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Prospecção B2B",
      call_me: "Lucas",
      color: "#60a5fa",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Pesquisa leads",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "idle",
  };

  it("Step 1: renders all 7 templates from spec 4.6 plus 'Criar do Zero'", () => {
    render(<BotCreateModal isOpen={true} onClose={vi.fn()} />);

    // Check all 7 templates
    expect(screen.getByText("Chefe de Gabinete")).toBeDefined();
    expect(screen.getByText("Vendas")).toBeDefined();
    expect(screen.getByText("Suporte")).toBeDefined();
    expect(screen.getByText("Operações e Financeiro")).toBeDefined();
    expect(screen.getByText("Engenheiro Dev")).toBeDefined();
    expect(screen.getByText("Pesquisa")).toBeDefined();
    expect(screen.getByText("Conteúdo")).toBeDefined();

    // Plus Do Zero
    expect(screen.getByText("Criar do Zero")).toBeDefined();

    // Invariante 8: Step 1 does NOT mention 'regras restritivas por padrão'
    expect(screen.queryByText(/regras restritivas por padrão/i)).toBeNull();
    expect(screen.getByText(/Cada modelo vem configurado com instruções especializadas e ferramentas adequadas\./i)).toBeDefined();
  });

  it("Step 2: validates profile name against regex ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", () => {
    render(<BotCreateModal isOpen={true} onClose={vi.fn()} />);

    // Select template "Vendas" to advance to Step 2
    fireEvent.click(screen.getByText("Vendas"));

    const nameInput = screen.getByDisplayValue("vendas");

    // Invalid character in name
    fireEvent.change(nameInput, { target: { value: "invalid name with space!" } });
    expect(screen.getByText(/apenas letras, números, hífens ou sublinhados/i)).toBeDefined();

    // Valid name
    fireEvent.change(nameInput, { target: { value: "vendas_b2b-01" } });
    expect(screen.queryByText(/apenas letras, números, hífens ou sublinhados/i)).toBeNull();
  });

  it("Invariante 8 (selo honesto): wizard does NOT display deceptive 🔒 or ✋ badges or 'ativadas por padrão'", () => {
    render(<BotCreateModal isOpen={true} onClose={vi.fn()} />);

    // Step 1: select template
    fireEvent.click(screen.getByText("Vendas"));

    // Step 2 -> Step 3
    const advanceBtn = screen.getByText("Avançar");
    fireEvent.click(advanceBtn);

    // Step 3 displays guidelines and states that technical rules arrive in Phase 3
    expect(screen.getByText(/Diretrizes e Políticas Operacionais/i)).toBeDefined();
    expect(screen.getByText(/integrado na Fase 3/i)).toBeDefined();

    // MUST NOT display deceptive 🔒 or ✋ badges or dishonest 'ativadas por padrão'
    expect(screen.queryByText(/🔒/)).toBeNull();
    expect(screen.queryByText(/✋/)).toBeNull();
    expect(screen.queryByText(/Bloqueio real/i)).toBeNull();
    expect(screen.queryByText(/Aprovação real/i)).toBeNull();
    expect(screen.queryByText(/ativadas por padrão/i)).toBeNull();
  });

  it("completes creation and advances to Step 5: O Bot se apresenta (spec 4.6 §7)", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody = "";

    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) {
        return { csrf: "csrf-create-test", actor: "basic:user", auth_mode: "gated" };
      }
      if (url.endsWith("/bots") && init?.method === "POST") {
        capturedHeaders = init.headers;
        capturedBody = init.body as string;
        return {
          bot: createdBotFixture,
          intro: { session_id: null },
        } as unknown as CreateBotResponse;
      }
      // the introduction is real now (contract v0.4 B4): the step reads it, and starts it only on a click
      if (url.endsWith("/bots/vendas/introduction") && (init?.method ?? "GET") === "GET") {
        return { state: "none", session_id: null, run_id: null, estimate_cents: 3, requires_confirm: true };
      }
      if (url.endsWith("/bots/vendas/introduction") && init?.method === "POST") {
        return { state: "running", session_id: "sess_intro_xyz", run_id: "run_intro_1", estimate_cents: 3, requires_confirm: true };
      }
      if (url.endsWith("/bots/vendas/runs/run_intro_1")) {
        return { run: { id: "run_intro_1", status: "completed", output: "Oi, eu sou o **Vendas**." } };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const onBotCreated = vi.fn();
    render(<BotCreateModal isOpen={true} onClose={vi.fn()} onBotCreated={onBotCreated} />);

    // Step 1: select "Vendas"
    fireEvent.click(screen.getByText("Vendas"));

    // Step 2 -> Step 3
    fireEvent.click(screen.getByText("Avançar"));

    // Step 3 -> Step 4
    fireEvent.click(screen.getByText("Avançar"));

    // Step 4: Click "Criar Bot"
    const submitBtn = screen.getByText("Criar Bot");
    fireEvent.click(submitBtn);

    // Step 5: Presentation message
    await waitFor(() => {
      expect(screen.getByTestId("bot-presentation")).toBeDefined();
    });

    // The Bot introduces itself for real: no sample card any more (it said things the Bot never said)
    expect(screen.queryByText(/Apresentação inicial do Bot/i)).toBeNull();
    expect(screen.queryByText(/O que posso fazer sozinho/i)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Pedir que o Bot se apresente" }));
    expect(await screen.findByTestId("bot-introduction-answer")).toBeDefined();
    expect(screen.getByTestId("bot-introduction-answer").textContent).toBe("Oi, eu sou o Vendas.");

    // Verify CSRF was sent on POST
    const headers = new Headers(capturedHeaders);
    expect(headers.get("X-LuveBot-CSRF")).toBe("csrf-create-test");

    // The Vendas template wears its mascot (T8.3): the id goes to the backend, never a URL
    expect(JSON.parse(capturedBody).display.avatar).toEqual({ kind: "mascot", value: "zuca" });

    const parsed = JSON.parse(capturedBody);
    expect(parsed.name).toBe("vendas");

    // Contract §4 invariant: soul and description MUST NOT be sent in CreateBotRequest
    expect(parsed.soul).toBeUndefined();
    expect(parsed.description).toBeUndefined();

    // Click "Iniciar com este Bot"
    const finishBtn = screen.getByText("Iniciar com este Bot");
    fireEvent.click(finishBtn);
    expect(onBotCreated).toHaveBeenCalledWith(createdBotFixture, "sess_intro_xyz");
  });

  it("a template card shows its mascot face, and the picker swaps it only by a click (T8.3)", () => {
    const { container } = render(<BotCreateModal isOpen={true} onClose={vi.fn()} />);
    const faces = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(faces).toContain("/dashboard-plugins/luvebot/icons/mascots/zuca-mini.svg");
    expect(faces).toContain("/dashboard-plugins/luvebot/icons/mascots/luvi-mini.svg"); // Criar do Zero
    fireEvent.click(screen.getByText("Vendas"));
    const group = screen.getByRole("group", { name: "Rosto do Bot (mascote)" });
    expect(group.querySelectorAll("button")).toHaveLength(15);
    expect(screen.getByRole("button", { name: "Zuca" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Pipo" }));
    expect(screen.getByRole("button", { name: "Pipo" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Zuca" }).getAttribute("aria-pressed")).toBe("false");
  });
});
