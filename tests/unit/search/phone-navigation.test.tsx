// tests/unit/search/phone-navigation.test.tsx
// On a phone the shell shows the contact list OR the open screen. A place chosen in ⌘K / "Buscar" ("Ver Rotinas", "Ver Aprovações"...) must take the
// person TO that screen; it used to change the tab behind the list and leave the contact list on screen (the screenshots guide's last open finding).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, configure } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const bot: Bot = {
  name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
  display: { label: "Vendas", role: "Prospecção", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } },
};
function backend() {
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (/\/bots$/.test(url)) return { bots: [bot] };
    if (url.includes("/approvals")) return { approvals: [] };
    if (url.includes("/budget")) return { limits: [], paused: [], watcher: { last_at: null }, alerts: [] };
    if (url.includes("/costs/quota")) return { available: false, reason: "hermes_without_quota", fetched_at: 1, stale: false, bots: [] };
    if (url.includes("/costs")) return { period: "day", currency: "USD", totals: { spend_cents: 0, unpriced_sessions: 0 }, groups: [], ledger: { lag_s: 0, watcher_stale: false } };
    if (url.includes("/routines")) return { routines: [] };
    if (url.includes("/search")) return { messages: [], bots: [], rooms: [], routines: [], files: [] };
    return {};
  });
}
const phone = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
const desktop = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
const list = () => screen.queryByRole("complementary", { name: "sidebar" });
async function openPalette() {
  fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
  return screen.findByRole("dialog");
}
async function choose(title: string) {
  const dialog = await openPalette();
  fireEvent.click(await within(dialog).findByRole("option", { name: new RegExp(`^${title}`) }));
}

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); backend(); });
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("a place chosen in the search, on a phone", () => {
  it("'Ver Rotinas' leaves the contact list and opens Rotinas", async () => {
    phone();
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/, pressed: false });
    expect(list()).not.toBeNull();                                                       // the phone starts on the contact list
    await choose("Ver Rotinas");
    expect(await screen.findByRole("heading", { name: "Rotinas e Agendamentos" })).toBeTruthy();
    expect(list()).toBeNull();                                                           // the list is not left on screen
  });

  it("the same place twice: back to the list, then 'Ver Rotinas' again opens it again (the tab did not change)", async () => {
    phone();
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/, pressed: false });
    await choose("Ver Rotinas");
    await screen.findByRole("heading", { name: "Rotinas e Agendamentos" });
    fireEvent.click(screen.getByRole("button", { name: "Voltar para as conversas" }));
    await waitFor(() => expect(list()).not.toBeNull());
    await choose("Ver Rotinas");
    expect(await screen.findByRole("heading", { name: "Rotinas e Agendamentos" })).toBeTruthy();
    expect(list()).toBeNull();
  });

  it("every other tab of the search does the same (Aprovações, Atividade, Mapa, Custos)", async () => {
    phone();
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/, pressed: false });
    for (const action of ["Ir para Caixa de Aprovações", "Ver Atividade", "Ver Mapa do Time", "Ver Custos e Orçamento"]) {
      await choose(action);
      await waitFor(() => expect(list(), action).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: "Voltar para as conversas" }));
      await waitFor(() => expect(list()).not.toBeNull());
    }
  });

  it("on a wide screen nothing changes: the list stays beside the screen", async () => {
    desktop();
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/, pressed: false });
    await choose("Ver Rotinas");
    expect(await screen.findByRole("heading", { name: "Rotinas e Agendamentos" })).toBeTruthy();
    expect(list()).not.toBeNull();
  });
});
