// tests/unit/bots/profile.test.tsx
// Unit tests for BotProfile component (spec 4.5 tabs 1-3)

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BotProfile } from "@/components/bots/BotProfile";
import type { BotDetail } from "@/api/types";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";

describe("BotProfile (spec 4.5 tabs 1-3)", () => {
  beforeEach(() => {
    resetCsrfToken();
    setCustomFetchJSON(null);
  });

  const detailFixture: BotDetail = {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Prospecção B2B",
      call_me: "Lucas",
      color: "#60a5fa",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Prospecção e follow-up",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "working",
    soul: `# SOUL do Bot Vendas\nRegras permanentes aqui; tarefas na conversa.`,
    toolsets: [{ name: "web", enabled: true }],
    mcp_servers: [{ name: "crm", enabled: true }],
  };

  it("renders the 3 tabs: Identidade, Instruções (SOUL.md), Modelo", () => {
    render(<BotProfile botName="vendas" initialBot={detailFixture} />);

    expect(screen.getByText("1. Identidade")).toBeDefined();
    expect(screen.getByText("2. Instruções (SOUL.md)")).toBeDefined();
    expect(screen.getByText("3. Modelo")).toBeDefined();

    // Tab 1 is active by default
    expect(screen.getByDisplayValue("Vendas")).toBeDefined();
    expect(screen.getByDisplayValue("Prospecção B2B")).toBeDefined();
    expect(screen.getByDisplayValue("Lucas")).toBeDefined();
  });

  it("the numbered tabs are the wrapping kind: two columns on a phone, each with its whole label (style.css, tests/unit/ui/layout-fixes.test.tsx)", () => {
    render(<BotProfile botName="vendas" initialBot={detailFixture} />);
    expect(screen.getByRole("tablist").className.split(" ")).toEqual(expect.arrayContaining(["lb-segmented", "lb-segmented-wrap"]));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["1. Identidade", "2. Instruções (SOUL.md)", "3. Modelo", "4. Regras"]);
  });

  it("navigates to Tab 2: Instruções and displays the mandatory tip 'Regras permanentes aqui; tarefas na conversa', with the SOUL editable (the editor itself is in bots/soul-editor.test.tsx)", async () => {
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" }
      : url.endsWith("/bots/vendas/soul") ? { content: detailFixture.soul, expected_digest: "d1", truncated: false, redacted: false, exists: true, rules_block: { present: false, digest: null } } : {}));
    render(<BotProfile botName="vendas" initialBot={detailFixture} />);

    fireEvent.click(screen.getByText("2. Instruções (SOUL.md)"));

    // Spec 4.5 mandatory tip: "regras permanentes aqui; tarefas na conversa"
    const tipMatches = screen.getAllByText(/regras permanentes aqui; tarefas na conversa/i);
    expect(tipMatches.length).toBeGreaterThanOrEqual(1);

    // The SOUL text is in an editable box, with its character count; the old "read-only, a future phase" claim is gone
    const textarea = (await screen.findByLabelText("Conteúdo do arquivo SOUL.md")) as HTMLTextAreaElement;
    expect(textarea.value).toBe(detailFixture.soul);
    expect(textarea.readOnly).toBe(false);
    expect(screen.queryByText(/será disponibilizada em fase futura/i)).toBeNull();
    expect(screen.queryByText(/Visualização somente leitura/i)).toBeNull();
    expect(screen.getByText(`${detailFixture.soul.length} caracteres`)).toBeDefined();
  });

  it("navigates to Tab 3: Modelo and, on a backend without the model route, displays the read-only notice with disabled inputs (the Model card is in bots/model-card.test.tsx)", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      throw new ApiError({ code: "plugin_route_missing", message: "x", status: 404 });
    });
    render(<BotProfile botName="vendas" initialBot={detailFixture} />);

    const tab3Btn = screen.getByText("3. Modelo");
    fireEvent.click(tab3Btn);

    expect(await screen.findByText("Provedor de IA")).toBeDefined();
    const modelInput = screen.getByDisplayValue("claude-sonnet-5-5");
    expect(modelInput.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Alteração de provedor e modelo pelo LuveBot será disponibilizada em fase futura/i)).toBeDefined();
  });

  it("saves Tab 1 changes via PATCH /bots/{bot}/display with CSRF without merging local soul", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody = "";

    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) {
        return { csrf: "csrf-token-abc", actor: "basic:user", auth_mode: "gated" };
      }
      if (url.includes("/bots/vendas/display") && init?.method === "PATCH") {
        capturedHeaders = init.headers;
        capturedBody = init.body as string;
        return {
          ...detailFixture,
          display: {
            ...detailFixture.display,
            label: "Vendas Pro",
            call_me: "Chefe",
          },
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const onBotUpdated = vi.fn();
    render(
      <BotProfile
        botName="vendas"
        initialBot={detailFixture}
        onBotUpdated={onBotUpdated}
      />
    );

    // Edit label
    const labelInput = screen.getByDisplayValue("Vendas");
    fireEvent.change(labelInput, { target: { value: "Vendas Pro" } });

    // Pick a mascot face (T8.3): only this click changes it
    fireEvent.click(screen.getByRole("button", { name: "Zuca" }));

    // Submit form
    const saveBtn = screen.getByText("Salvar alterações");
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText("Identidade atualizada com sucesso!")).toBeDefined();
    });

    const headers = new Headers(capturedHeaders);
    expect(headers.get("X-LuveBot-CSRF")).toBe("csrf-token-abc");

    const parsed = JSON.parse(capturedBody);
    expect(parsed.label).toBe("Vendas Pro");
    expect(parsed.avatar).toEqual({ kind: "mascot", value: "zuca" });

    // Must NOT merge soul as if it was saved; soul preserves server version
    expect(onBotUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "vendas",
        soul: detailFixture.soul,
      })
    );
  });
});
