// tests/unit/f7.test.tsx
// T7.1 F7: what looked like an action now is one, or is gone (D2, D3, D4 errors, D7, D8), and Settings holds the
// global costs and rules that left the main menu (D-016).
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";
import { ActivityView } from "@/components/activity/ActivityView";
import { SettingsView } from "@/components/settings/SettingsView";
import { Hoje } from "@/components/Hoje";
import { ApprovalsInbox } from "@/components/approvals/ApprovalsInbox";
import { setCustomFetchJSON, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { ActivityItem, Approval } from "@/api/types";

beforeEach(() => { cleanup(); setLuveLocale("pt"); setCustomFetchJSON(async () => ({})); });

const item: ActivityItem = { id: "a1", kind: "run", bot: "vendas", title: "Follow-up", origin: "message", status: "running" };

describe("F7", () => {
  it("⌘K: no 'Pausar tudo' without a real pause, and no shortcut hints nothing handles (D2)", () => {
    render(<CommandPaletteModal isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /ações/i }));
    expect(screen.queryByText("Pausar tudo")).toBeNull();
    expect(screen.queryByText("⌘N")).toBeNull();
    expect(screen.getByText("Criar Novo Bot")).toBeTruthy();
  });

  it("Atividade: 'Conversa' opens the Bot's conversation; the fake 'Eventos' is gone (D7)", () => {
    const onOpenConversation = vi.fn();
    render(<ActivityView initialItems={[item]} onOpenConversation={onOpenConversation} />);
    fireEvent.click(screen.getByRole("button", { name: "Conversa" }));
    expect(onOpenConversation).toHaveBeenCalledWith("vendas");
    expect(screen.queryByText("Eventos")).toBeNull();
  });

  it("Atividade: a handoff's Kanban link opens straight on the board", () => {
    render(<ActivityView initialItems={[item]} initialView="kanban" />);
    expect(screen.getByTestId("kanban-board")).toBeTruthy();
  });

  it("Configurações: general, global costs and global rules, one at a time", () => {
    render(<SettingsView />);
    expect(screen.getAllByRole("tab").map((x) => x.textContent)).toEqual(["Geral", "Custos", "Regras"]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "en" } });
    expect(screen.getByRole("tab", { name: "General" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Rules" }));
    expect(screen.getByRole("heading", { name: "Rules and Governance" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Costs and Budget" })).toBeNull();
  });

  it("Hoje: today's real date, never a fixed one (D3)", () => {
    render(<Hoje />);
    const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
    expect(screen.getByText(today)).toBeTruthy();
    expect(screen.queryByText("30 de setembro de 2026")).toBeNull();
  });

  it("Hoje: a stop that the backend refuses is shown, not swallowed", async () => {
    render(<Hoje inProgressItems={[item]} onStopActivity={() => Promise.reject(new ApiError({ code: "run_not_found", message: "Run not found.", status: 404 }))} />);
    fireEvent.click(screen.getByRole("button", { name: "Parar" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar parada" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Esta execução não foi encontrada no Hermes; ela pode já ter terminado.");
    expect(alert.textContent).not.toContain("Run not found.");  // the backend's English stays out; its code only behind "Detalhe técnico"
  });

  it("Aprovações: 'Editar' (which edited nothing) became 'Ver parâmetros' (D8)", () => {
    const a: Approval = { request_id: "r1", bot: "vendas", source: "transport", digest: "d", allowed_choices: ["once", "deny"], created_at: "2026-10-01T10:00:00Z", expires_at: "2026-10-01T11:00:00Z", status: "pending", command_redacted: "rm x" };
    render(<ApprovalsInbox initialApprovals={[a]} authMode="gated" />);
    const card = within(screen.getByTestId("approval-card-r1"));
    expect(card.queryByRole("button", { name: /^editar$/i })).toBeNull();
    fireEvent.click(card.getByRole("button", { name: "Ver parâmetros" }));
    expect(screen.getByText(/não edita argumentos/)).toBeTruthy();
  });
});
