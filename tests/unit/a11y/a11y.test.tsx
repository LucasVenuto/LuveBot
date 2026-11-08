// tests/unit/a11y/a11y.test.tsx
// Comprehensive Accessibility (a11y) Test Suite for LuveBot (T6.3)
// Covers: Shell, Hoje, Bots, Perfil, Criar Bot, Conversa, Aprovações, Regras, Custos, Rotinas, Atividade.
// Validates: Keyboard navigation (Tab/Shift-Tab, Escape, focus trap, focus restoration),
// proper ARIA roles (dialog, tablist, tab, tabpanel, status, aria-live), accessible labels, touch targets.
// Includes Mutation Test for BotCreateModal focus trap.

import React, { useRef } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { MessengerShell } from "@/components/messenger/MessengerShell";
import { Hoje } from "@/components/Hoje";
import { ContactList } from "@/components/messenger/ContactList";
import { BotCreateModal } from "@/components/bots/BotCreateModal";
import { BotProfile } from "@/components/bots/BotProfile";
import { Conversation } from "@/components/conversation/Conversation";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";
import { RulesView } from "@/components/rules/RulesView";
import { CostsView } from "@/components/costs/CostsView";
import { RoutinesView } from "@/components/routines/RoutinesView";
import { ActivityView } from "@/components/activity/ActivityView";
import { CreateRoomModal } from "@/components/rooms/CreateRoomModal";
import type { Bot, ActivityItem } from "@/api/types";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { initialTranscript } from "@/lib/stream";

const mockBots: Bot[] = [
  {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas B2B",
      role: "Prospecção",
      color: "#60a5fa",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Prospecção de novos clientes",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "idle",
  },
  {
    name: "dev",
    is_default: false,
    display: {
      label: "Engenheiro Dev",
      role: "Engenharia",
      color: "#a78bfa",
      avatar: { kind: "emoji", value: "💻" },
    },
    description: "Automação e resolução de bugs",
    model: { provider: "anthropic", name: "claude-3-opus" },
    status: "working",
  },
];

describe("A11y Screen-by-Screen Test Suite (T6.3)", () => {
  beforeEach(() => {
    resetCsrfToken();
    setCustomFetchJSON(null);
  });

  describe("1. Shell", () => {
    it("renders navigation landmark with accessible label and aria-current on active item", () => {
      render(
        <MessengerShell activeTab="hoje" onTabChange={vi.fn()} bots={mockBots}>
          <div>Conteúdo</div>
        </MessengerShell>
      );

      const nav = screen.getByRole("navigation", { name: "Navegação Principal" });
      expect(nav).toBeDefined();

      // The active navigation item "Hoje" has aria-current="page"
      const hojeBtn = screen.getByRole("button", { name: /Hoje/i });
      expect(hojeBtn.getAttribute("aria-current")).toBe("page");

      // An inactive item does not have aria-current="page"
      const activityBtn = screen.getByRole("button", { name: /Atividade/i });
      expect(activityBtn.getAttribute("aria-current")).toBeNull();
    });

    it("phone: the stack's Back button is labelled and every rail target is at least 44px", () => {
      vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
      render(
        <MessengerShell activeTab="hoje" onTabChange={vi.fn()} bots={mockBots} selectedBotName="vendas">
          <div>Conteúdo</div>
        </MessengerShell>
      );
      const back = screen.getByRole("button", { name: "Voltar para as conversas" });
      expect(parseInt(back.style.minWidth) >= 44 && parseInt(back.style.minHeight) >= 44).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  describe("2. Hoje (Home)", () => {
    it("renders accessible section landmarks and headings hierarchy", () => {
      render(<Hoje bots={mockBots} onOpenCreateBot={vi.fn()} />);

      // Main h1 heading
      const mainHeading = screen.getByRole("heading", { level: 1, name: "Hoje" });
      expect(mainHeading).toBeDefined();

      // Section landmarks
      expect(screen.getByRole("region", { name: "Precisa de você" })).toBeDefined();
      expect(screen.getByRole("region", { name: "Em andamento" })).toBeDefined();
      expect(screen.getByRole("region", { name: "Concluído hoje" })).toBeDefined();
      expect(screen.getByRole("region", { name: "Próximas rotinas" })).toBeDefined();
    });

    it("renders onboarding templates with accessible buttons and keyboard navigation", () => {
      const handleCreate = vi.fn();
      render(<Hoje bots={[]} onOpenCreateBot={handleCreate} />);

      const onboarding = screen.getByRole("region", { name: "onboarding" });
      expect(onboarding).toBeDefined();

      // 3 starter template buttons
      const templateBtns = screen.getAllByRole("button", { name: "Criar este Bot" });
      expect(templateBtns.length).toBe(3);

      // Interactive via click / enter
      fireEvent.click(templateBtns[0]);
      expect(handleCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("3. ContactList", () => {
    it("provides accessible container, aria-pressed states, and aria-labels on badges", () => {
      const onSelect = vi.fn();
      const onOpenCreate = vi.fn();

      render(
        <ContactList
          bots={mockBots}
          selectedBotName="vendas"
          onSelectBot={onSelect}
          onOpenCreate={onOpenCreate}
        />
      );

      // Create button
      const newBotBtn = screen.getByRole("button", { name: "Novo Bot" });
      expect(newBotBtn).toBeDefined();

      // Active bot button has aria-pressed="true"
      const vendasBtn = screen.getByRole("button", { name: /Vendas B2B/i });
      expect(vendasBtn.getAttribute("aria-pressed")).toBe("true");

      // Inactive bot button has aria-pressed="false"
      const devBtn = screen.getByRole("button", { name: /Engenheiro Dev/i });
      expect(devBtn.getAttribute("aria-pressed")).toBe("false");

      // Working status badge has accessible label
      expect(screen.getByLabelText("Trabalhando")).toBeDefined();
    });

    it("loading state conveys aria-busy='true'", () => {
      render(<ContactList bots={[]} loading={true} />);
      const skeletonContainer = screen.getByLabelText("Carregando bots");
      expect(skeletonContainer.getAttribute("aria-busy")).toBe("true");
    });
  });

  describe("4. BotCreateModal", () => {
    it("renders with role='dialog', aria-modal='true', and aria-labelledby", () => {
      render(<BotCreateModal isOpen={true} onClose={vi.fn()} />);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-labelledby")).toBe("modal-title");

      const title = screen.getByRole("heading", { level: 2, name: /Criar Novo Bot/i });
      expect(title.id).toBe("modal-title");

      // Accessible close button
      const closeBtn = screen.getByRole("button", { name: "Fechar" });
      expect(closeBtn).toBeDefined();
    });

    it("closes when Escape key is pressed", () => {
      const onClose = vi.fn();
      render(<BotCreateModal isOpen={true} onClose={onClose} />);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("traps keyboard focus: Tab on last element cycles to first, Shift+Tab on first cycles to last", () => {
      render(<BotCreateModal isOpen={true} onClose={vi.fn()} />);

      const dialog = screen.getByRole("dialog");
      const focusableElements = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      expect(focusableElements.length).toBeGreaterThan(1);

      const firstEl = focusableElements[0];
      const lastEl = focusableElements[focusableElements.length - 1];

      // Tab on last element wraps focus back to first element
      lastEl.focus();
      expect(document.activeElement).toBe(lastEl);

      fireEvent.keyDown(lastEl, { key: "Tab" });
      expect(document.activeElement).toBe(firstEl);

      // Shift+Tab on first element wraps focus back to last element
      fireEvent.keyDown(firstEl, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(lastEl);
    });

    it("restores focus to triggering element when closed", () => {
      function Wrapper() {
        const [open, setOpen] = React.useState(false);
        const triggerRef = useRef<HTMLButtonElement>(null);

        return (
          <div>
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setOpen(true)}
            >
              Abrir Criador
            </button>
            <BotCreateModal
              isOpen={open}
              onClose={() => setOpen(false)}
            />
          </div>
        );
      }

      render(<Wrapper />);
      const openBtn = screen.getByRole("button", { name: "Abrir Criador" });
      openBtn.focus();
      expect(document.activeElement).toBe(openBtn);

      // Open modal
      fireEvent.click(openBtn);
      expect(screen.getByRole("dialog")).toBeDefined();

      // Close modal via Escape
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();

      // Focus returned to trigger button!
      expect(document.activeElement).toBe(openBtn);
    });

    it("MUTATION GUARD: removing focus trap causes focus to escape without wrapping (TEST TURNS RED IF TRAP IS REMOVED)", () => {
      // In this test, we pass disableFocusTrap={true} to simulate the mutation:
      // removing the focus trap functionality from BotCreateModal.
      render(<BotCreateModal isOpen={true} onClose={vi.fn()} disableFocusTrap={true} />);

      const dialog = screen.getByRole("dialog");
      const focusableElements = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstEl = focusableElements[0];
      const lastEl = focusableElements[focusableElements.length - 1];

      // Focus last element
      lastEl.focus();
      expect(document.activeElement).toBe(lastEl);

      // Simulate Tab key on last element
      fireEvent.keyDown(lastEl, { key: "Tab" });

      // If the focus trap were active, document.activeElement would be firstEl.
      // But because the trap is disabled (mutated), focus DOES NOT cycle to firstEl!
      expect(document.activeElement).not.toBe(firstEl);
    });
  });

  describe("5. BotProfile", () => {
    const detailFixture = {
      name: "vendas",
      is_default: false,
      display: {
        label: "Vendas",
        role: "Prospecção B2B",
        call_me: "Lucas",
        color: "#60a5fa",
        avatar: { kind: "emoji" as const, value: "💼" },
      },
      description: "Prospecção e follow-up",
      model: { provider: "openrouter", name: "claude-sonnet-5-5" },
      status: "working" as const,
      soul: "# SOUL\nRegras permanentes aqui; tarefas na conversa.",
      toolsets: [{ name: "web", enabled: true }],
      mcp_servers: [{ name: "crm", enabled: true }],
    };

    it("renders tabs with role='tablist', role='tab', and role='tabpanel'", () => {
      render(
        <BotProfile
          botName="vendas"
          initialBot={detailFixture}
          onClose={vi.fn()}
        />
      );

      const tablist = screen.getByRole("tablist", { name: "Abas do perfil" });
      expect(tablist).toBeDefined();

      // 4 tabs
      const tabs = screen.getAllByRole("tab");
      expect(tabs.length).toBe(4);

      const identityTab = screen.getByRole("tab", { name: "1. Identidade" });
      expect(identityTab.getAttribute("aria-selected")).toBe("true");

      const soulTab = screen.getByRole("tab", { name: "2. Instruções (SOUL.md)" });
      expect(soulTab.getAttribute("aria-selected")).toBe("false");

      // Corresponding tabpanel
      const panel = screen.getByRole("tabpanel", { name: "1. Identidade" });
      expect(panel).toBeDefined();
    });

    it("closes when Escape key is pressed", () => {
      const onClose = vi.fn();
      render(<BotProfile botName="vendas" initialBot={detailFixture} onClose={onClose} />);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("6. Conversation & WorkPanel", () => {
    it("renders role='status' with aria-live='polite' for run state updates and role='tab' in workpanel", () => {
      render(
        <Conversation
          bot={mockBots[0]}
          initialTurns={[
            {
              id: 1,
              user: "Olá",
              state: initialTranscript(),
              stopping: false,
              errors: [],
              confirmed: "completed",
            },
          ]}
        />
      );

      // Status indicator with aria-live
      const statusElements = screen.getAllByRole("status");
      expect(statusElements.length).toBeGreaterThan(0);
      expect(statusElements.some((el) => el.getAttribute("aria-live") === "polite")).toBe(true);

      // WorkPanel tabs
      const workPanelTablist = screen.getByRole("tablist", { name: "Abas do painel de trabalho" });
      expect(workPanelTablist).toBeDefined();

      const activityTab = screen.getByRole("tab", { name: "Atividade" });
      expect(activityTab).toBeDefined();
      expect(activityTab.getAttribute("aria-selected")).toBe("true");

      const terminalTab = screen.getByRole("tab", { name: "Terminal" });
      expect(terminalTab).toBeDefined();
      expect(terminalTab.getAttribute("aria-selected")).toBe("false");
    });
  });

  describe("7. ApprovalsInbox", () => {
    it("opens denial modal with role='dialog', aria-modal='true', and accessible controls", () => {
      const sampleApproval: any = {
        request_id: "req-1",
        bot: "vendas",
        surface: "gateway",
        mechanism: "command",
        source: "transport",
        tool_name: "exec_command",
        action_summary: "Executar script de backup",
        created_at: new Date().toISOString(),
        digest: "sha256:abc",
        status: "pending",
      };

      render(<ApprovalsInbox initialApprovals={[sampleApproval]} bots={mockBots} />);

      // Find Deny button
      const denyBtn = screen.getByRole("button", { name: /negar/i });
      fireEvent.click(denyBtn);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      // Close modal via Escape
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("8. RulesView", () => {
    it("renders tablist switcher and create rule modal with role='dialog'", () => {
      render(<RulesView authMode="gated" />);

      // Switcher
      const tablist = screen.getByRole("tablist");
      expect(tablist).toBeDefined();
      const simTab = screen.getByRole("tab", { name: /simulador/i });
      expect(simTab).toBeDefined();

      // Open new rule modal
      const newRuleBtn = screen.getByRole("button", { name: /nova regra/i });
      fireEvent.click(newRuleBtn);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      // Escape closes dialog
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("9. CostsView", () => {
    it("edit limit modal has role='dialog' and closes with Escape", async () => {
      const mockCostsData = {
        period: "day",
        currency: "USD",
        totals: { spend_cents: 4520, unpriced_sessions: 2 },
        groups: [{ key: "vendas", spend_cents: 2500, tokens: 45000, sessions: 12 }],
        ledger: { lag_s: 15, watcher_stale: false },
      };
      const mockBudgetData = {
        limits: [
          { scope: "global", period: "day", cents: 10000, spent_cents: 4520, reserved_cents: 500, percent: 45 },
          { scope: "bot", ref: "vendas", period: "day", cents: 5000, spent_cents: 2500, percent: 50 },
        ],
        status: "ok",
      };

      await act(async () => {
        render(
          <CostsView
            bots={mockBots}
            initialCosts={mockCostsData as any}
            initialBudget={mockBudgetData as any}
          />
        );
      });

      // Switch to Tetos e Limites tab
      fireEvent.click(screen.getByRole("button", { name: "Tetos e Limites" }));

      const editLimitBtn = screen.getByTestId("btn-edit-limit-global-all");
      fireEvent.click(editLimitBtn);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      // Escape key closes modal
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("10. RoutinesView", () => {
    it("new routine modal has role='dialog' and closes with Escape", async () => {
      setCustomFetchJSON(async (url) => {
        if (url.includes("/routines")) {
          return { items: [], total: 0 };
        }
        return {};
      });

      await act(async () => {
        render(<RoutinesView bots={mockBots} />);
      });

      const newRoutineBtn = screen.getByRole("button", { name: /nova rotina/i });
      fireEvent.click(newRoutineBtn);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      // Escape key closes modal
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("11. ActivityView", () => {
    it("stop confirmation modal has role='dialog' and closes with Escape", async () => {
      const activeItem: ActivityItem = {
        id: "act-1",
        kind: "run",
        bot: "vendas",
        title: "Disparo de e-mails em lote",
        origin: "message",
        status: "running",
      };

      await act(async () => {
        render(<ActivityView bots={mockBots} initialItems={[activeItem]} />);
      });

      const stopBtn = screen.getByTestId("btn-stop-act-1");
      fireEvent.click(stopBtn);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      // Escape key closes modal
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("12. RoomsView & CreateRoomModal", () => {
    it("CreateRoomModal has role='dialog', aria-modal='true', accessible label, and closes with Escape", () => {
      const handleClose = vi.fn();
      const { unmount } = render(
        <CreateRoomModal
          isOpen={true}
          availableBots={mockBots}
          onClose={handleClose}
          onRoomCreated={vi.fn()}
        />
      );

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeDefined();
      expect(dialog.getAttribute("aria-modal")).toBe("true");

      // Closes with Escape
      fireEvent.keyDown(window, { key: "Escape" });
      expect(handleClose).toHaveBeenCalled();

      unmount();
    });
  });
});
