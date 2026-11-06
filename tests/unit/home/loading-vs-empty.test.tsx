// tests/unit/home/loading-vs-empty.test.tsx
// "Nenhum Bot criado ainda" only once the Bot list LOADED and came back empty (bug on the VPS: Hoje showed the onboarding
// while the sidebar was still loading). While it loads: a skeleton. A failed load: an error with "Tentar novamente".
// The same for every screen that decides "empty" by the list: Hoje, criar sala, ⌘K; the Mapa decides by its own answer.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { LuveBotApp } from "@/index";
import { CreateRoomModal } from "@/components/rooms/CreateRoomModal";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";
import { TeamMapView } from "@/components/map/TeamMapView";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import type { Bot } from "@/api/types";

const vendas: Bot = { name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
  display: { label: "Vendas", role: "Prospecção", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } } } as Bot;

/** The app's backend with /bots answered by hand: each call waits for the test to resolve or reject it. */
function app() {
  const pending: Array<{ ok: (v: unknown) => void; fail: (e: unknown) => void }> = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
    if (method === "GET" && /\/bots$/.test(url)) return new Promise((ok, fail) => pending.push({ ok, fail }));
    if (url.includes("/approvals")) return { approvals: [] };
    if (url.includes("/budget")) return { limits: [] };
    if (url.includes("/rooms")) return { rooms: [] };
    return {};
  });
  render(<LuveBotApp />);
  return { bots: () => pending };
}
const hoje = () => screen.getByRole("main");

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("Hoje: loading is never 'no Bot'", () => {
  it("while the list loads: a skeleton, no onboarding, no '0 Bots ativos'; empty only after it loaded empty", async () => {
    const a = app();
    await waitFor(() => expect(a.bots()).toHaveLength(1));
    expect(within(hoje()).getByTestId("bots-loading")).toBeTruthy();
    expect(screen.queryByText("Nenhum Bot criado ainda")).toBeNull();
    expect(screen.queryByTestId("active-bots-count")).toBeNull();
    a.bots()[0].ok({ bots: [] });
    expect(await screen.findByText("Nenhum Bot criado ainda")).toBeTruthy();
    expect(within(hoje()).queryByTestId("bots-loading")).toBeNull();
  });

  it("a failed load is an error with 'Tentar novamente', never an empty team; retrying loads the list", async () => {
    const a = app();
    await waitFor(() => expect(a.bots()).toHaveLength(1));
    a.bots()[0].fail(new ApiError({ code: "hermes_error", message: "x", status: 502 }));
    const alert = await within(hoje()).findByTestId("bots-error");
    expect(alert.textContent).toContain("Erro ao carregar bots");
    expect(screen.queryByText("Nenhum Bot criado ainda")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Tentar novamente" }));
    await waitFor(() => expect(a.bots()).toHaveLength(2));
    a.bots()[1].ok({ bots: [vendas] });
    await waitFor(() => expect(within(hoje()).queryByTestId("bots-error")).toBeNull());
    expect(screen.queryByText("Nenhum Bot criado ainda")).toBeNull();
  });

  it("Hermes unreachable on the first load is not an empty team either", async () => {
    const a = app();
    await waitFor(() => expect(a.bots()).toHaveLength(1));
    a.bots()[0].fail(new ApiError({ code: "hermes_unreachable", message: "x", status: 503 }));
    expect(await within(hoje()).findByTestId("bots-error")).toBeTruthy();
    expect(screen.queryByText("Nenhum Bot criado ainda")).toBeNull();
  });
});

describe("the other screens that decide 'empty' by the list", () => {
  beforeEach(() => setCustomFetchJSON(async (url: string) => {
    if (url.includes("/search")) throw new Error("offline");  // the palette falls back to the list it was given
    return { rooms: [] };
  }));

  it("criar sala: no '0 Bots conectados' while loading or after a failure; the button says why", async () => {
    const r = render(<CreateRoomModal isOpen onClose={() => {}} availableBots={[]} botsStatus="loading" />);
    expect(screen.getByTestId("bots-loading")).toBeTruthy();
    expect(screen.queryByTestId("rooms-too-few-ready")).toBeNull();
    expect(screen.getByText("Carregando bots", { selector: "#create-room-why" })).toBeTruthy();
    r.rerender(<CreateRoomModal isOpen onClose={() => {}} availableBots={[]} botsStatus="error" onRetryBots={() => {}} />);
    expect(screen.getByTestId("bots-error")).toBeTruthy();
    expect(screen.queryByTestId("rooms-too-few-ready")).toBeNull();
    r.rerender(<CreateRoomModal isOpen onClose={() => {}} availableBots={[]} botsStatus="ready" />);
    expect(await screen.findByTestId("rooms-too-few-ready")).toBeTruthy();
  });

  it("⌘K: 'nenhum resultado' only once the list loaded", async () => {
    const type = () => fireEvent.change(screen.getByRole("combobox"), { target: { value: "vendas" } });
    const r = render(<CommandPaletteModal isOpen onClose={() => {}} availableBots={[]} botsStatus="loading" />);
    type();
    expect(await screen.findByText("Carregando bots")).toBeTruthy();
    expect(screen.queryByTestId("search-empty-state")).toBeNull();
    r.rerender(<CommandPaletteModal isOpen onClose={() => {}} availableBots={[]} botsStatus="error" onRetryBots={() => {}} />);
    expect(await screen.findByTestId("bots-error")).toBeTruthy();
    expect(screen.queryByTestId("search-empty-state")).toBeNull();
    r.rerender(<CommandPaletteModal isOpen onClose={() => {}} availableBots={[]} botsStatus="ready" />);
    expect(await screen.findByTestId("search-empty-state")).toBeTruthy();
  });

  it("Mapa: a failed map is an error with 'Tentar novamente', and retrying asks again", async () => {
    let calls = 0;
    setCustomFetchJSON(async (url: string) => {
      if (url.includes("/map")) { calls++; if (calls === 1) throw new ApiError({ code: "hermes_error", message: "Falhou", status: 502 }); return { nodes: [], edges: [] }; }
      return {};
    });
    render(<TeamMapView availableBots={[]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByTestId("map-empty-state")).toBeTruthy();   // empty only from its own answer
    expect(calls).toBe(2);
  });
});
