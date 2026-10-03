// tests/unit/shell.test.tsx
// MessengerShell (T7.1 F2, D-016): rail + contacts + conversation; no menu of dashboard pages; phone = stack.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import type { Bot } from "@/api/types";

const bot = (name: string, label: string, extra: Partial<Bot> = {}): Bot => ({
  name, is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
  display: { label, role: "Papel", color: "#60a5fa", avatar: { kind: "emoji", value: "🦊" } }, ...extra,
});
const phone = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("MessengerShell", () => {
  it("renders the brand and the workspace with no invented spend and no pause without a route", () => {
    render(<MessengerShell><div data-testid="workspace-content">Content</div></MessengerShell>);
    expect(screen.getByRole("img", { name: "LuveBot" }).getAttribute("src")).toMatch(/\/dashboard-plugins\/luvebot\/icons\/luvebot-wordmark(-white)?\.svg$/);
    expect(screen.getByTestId("workspace-content")).toBeDefined();
    expect(screen.queryByText(/R\$ 0,00 hoje/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /pausar tudo|pause all/i })).toBeNull();
  });

  it("the rail has Hoje, Aprovações, Atividade, Mapa, Buscar and Configurações; no Rotinas or Custos pages (D-016; Mapa by the CEO)", () => {
    render(<MessengerShell />);
    const nav = within(screen.getByRole("navigation"));
    for (const name of [/^hoje$/i, /aprovações/i, /^atividade$/i, /^mapa$/i, /^buscar$/i, /^configurações$/i]) expect(nav.getByRole("button", { name })).toBeDefined();
    for (const name of [/rotinas/i, /custos/i]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("the contacts column lists Bots and rooms; hidden Bots only appear with a real count", () => {
    const { rerender } = render(<MessengerShell />);
    const aside = within(screen.getByRole("complementary", { name: "sidebar" }));
    expect(aside.getByText("Bots")).toBeDefined();
    expect(aside.getByText("Nenhum Bot ainda")).toBeDefined();
    expect(aside.getByText("Salas")).toBeDefined();
    expect(aside.getByText("Nenhuma sala")).toBeDefined();
    expect(screen.queryByText(/Ocultos/)).toBeNull(); // the old shell printed a fixed "Ocultos (0)"

    const hiddenBot = bot("arquivo", "Arquivo", { display: { ...bot("x", "x").display, label: "Arquivo", hidden: true } });
    rerender(<MessengerShell bots={[bot("vendas", "Vendas"), hiddenBot]} />);
    const toggle = screen.getByRole("button", { name: "Ocultos (1)" });
    expect(screen.queryByText("Arquivo")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Arquivo")).toBeDefined();
  });

  it("a Bot with a pending approval needs you even while its status says idle", () => {
    render(<MessengerShell bots={[bot("vendas", "Vendas")]} pendingByBot={{ vendas: 1 }} />);
    const row = screen.getByRole("button", { name: /Vendas/ });
    expect(within(row).getByRole("img", { name: "Precisa de você" })).toBeDefined();
  });

  it("⌘K asks for the search palette", () => {
    const onOpenSearch = vi.fn();
    render(<MessengerShell onOpenSearch={onOpenSearch} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.click(screen.getByRole("button", { name: /^buscar$/i }));
    expect(onOpenSearch).toHaveBeenCalledTimes(2);
  });

  it("phone: contacts first; an open conversation replaces them and Back returns", () => {
    phone();
    const onBack = vi.fn();
    const { rerender } = render(<MessengerShell bots={[bot("vendas", "Vendas")]} onBack={onBack}><div>conversa</div></MessengerShell>);
    expect(screen.getByRole("complementary", { name: "sidebar" })).toBeDefined();
    expect(screen.queryByText("conversa")).toBeNull();

    rerender(<MessengerShell bots={[bot("vendas", "Vendas")]} selectedBotName="vendas" onBack={onBack}><div>conversa</div></MessengerShell>);
    expect(screen.queryByRole("complementary", { name: "sidebar" })).toBeNull();
    expect(screen.getByText("conversa")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Voltar para as conversas" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("phone: a rail tab opens its screen over the contacts, with Back", () => {
    phone();
    const onTabChange = vi.fn();
    render(<MessengerShell onTabChange={onTabChange}><div>tela</div></MessengerShell>);
    fireEvent.click(screen.getByRole("button", { name: /aprovações/i }));
    expect(onTabChange).toHaveBeenCalledWith("aprovacoes");
    expect(screen.getByText("tela")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Voltar para as conversas" }));
    expect(screen.getByRole("complementary", { name: "sidebar" })).toBeDefined();
  });
});
