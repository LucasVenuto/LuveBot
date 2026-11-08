// tests/unit/conversation/pages-button.test.tsx
// The CEO did not find where to edit documents: the Pages library was only under Perfil > Páginas. On a computer the
// conversation's header has "Páginas" beside "Perfil"; on a phone the header already holds Painel and Perfil, so there it
// stays under Perfil (no squeezed fourth button).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { setCustomFetchJSON } from "@/api/client";

const BOT = { name: "vendas", label: "Vendas" };
const viewport = (phone: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: phone && q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));

beforeEach(() => { cleanup(); setCustomFetchJSON(async () => ({})); });
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("Páginas from the conversation", () => {
  it("on a computer, 'Páginas' sits beside 'Perfil' and opens the Bot's Pages", () => {
    viewport(false);
    const onOpenPages = vi.fn();
    render(<Conversation bot={BOT} initialTurns={[]} onOpenProfile={vi.fn()} onOpenPages={onOpenPages} />);
    const header = screen.getByRole("button", { name: "Perfil" }).parentElement!;
    fireEvent.click(screen.getByRole("button", { name: "Páginas" }));
    expect(onOpenPages).toHaveBeenCalledTimes(1);
    expect(header.contains(screen.getByRole("button", { name: "Páginas" }))).toBe(true);
  });

  it("on a phone, the header keeps Painel and Perfil only", () => {
    viewport(true);
    render(<Conversation bot={BOT} initialTurns={[]} onOpenProfile={vi.fn()} onOpenPages={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Perfil" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Páginas" })).toBeNull();
  });
});

describe("in the app", () => {
  it("'Páginas' in a Bot's conversation opens that Bot's Pages, with the way back to the conversation", async () => {
    viewport(false);
    const { LuveBotApp } = await import("@/index");
    const vendas = { name: "vendas", is_default: false, status: "idle", description: "", model: { provider: "p", name: "m" },
      display: { label: "Vendas", role: "Prospecção", color: "#60a5fa", avatar: { kind: "mascot", value: "brisa" } } };
    setCustomFetchJSON(async (url: string) => (/\/bots$/.test(url) ? { bots: [vendas] } : url.includes("/pages") ? { pages: [] }
      : url.includes("/budget") ? { limits: [] } : url.includes("/sessions") ? { sessions: [] } : {}));
    render(<LuveBotApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Vendas/, pressed: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Páginas" }));
    expect(await screen.findByRole("button", { name: /Voltar para a conversa/ })).toBeTruthy();
  });
});
