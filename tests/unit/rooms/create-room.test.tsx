// tests/unit/rooms/create-room.test.tsx
// Creating a room never looks like "clicking does nothing" (T11.7, the CEO on the VPS): the error shows by the button and takes
// focus, a hung request ends in 20 s with a clear message, rooms that Hermes cannot run are announced before trying, and the
// new room shows in the list.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor, within } from "@testing-library/react";
import { CreateRoomModal, ROOM_CREATE_TIMEOUT_MS } from "@/components/rooms/CreateRoomModal";
import { LuveBotApp, LuveBotOverlaySlot } from "@/index";
import { LuveBotRoute } from "@/host/overlay";
import fs from "node:fs";
import path from "node:path";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import type { Bot } from "@/api/types";

const bot = (name: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
  display: { label: name[0].toUpperCase() + name.slice(1), role: "", color: "#60a5fa", avatar: { kind: "emoji", value: "🤖" } },
});
const BOTS = ["vendas", "dev", "suporte", "pesquisa", "conteudo", "ops", "juridico"].map(bot);  // 7 Bots, like the VPS
const health = (groups: string, message?: string) => ({
  ok: true, features: { groups }, problems: message ? [{ code: "capability_missing", feature: "groups", message }] : [],
});
type Opts = { groups?: string; message?: string; create?: () => Promise<unknown> };
function backend(o: Opts = {}) {
  const calls: string[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    if (url.endsWith("/health")) return health(o.groups ?? "ok", o.message);
    if (method === "POST" && url.endsWith("/rooms")) return (o.create ?? (async () => ({ room: { id: "r1", name: "Lançamento", members: [], driver: { running: false, pending_actions_count: 0 }, created_at: "" } })))();
    return {};
  });
  return calls;
}
function fill() {
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText(/nome da sala/i), { target: { value: "Lançamento" } });
  fireEvent.click(dialog.getByRole("button", { name: /Vendas/ }));
  fireEvent.click(dialog.getByRole("button", { name: /Dev/ }));
}

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => { vi.useRealTimers(); setCustomFetchJSON(null); });

describe("creating a room", () => {
  it("the error shows next to the Create button and takes focus (with 7 Bots the top of the form is out of view)", async () => {
    backend({ create: async () => { throw new ApiError({ code: "room_members_invalid", message: "Um Bot não pode entrar na sala.", status: 422 }); } });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<CreateRoomModal isOpen onClose={vi.fn()} availableBots={BOTS} />);
    fill();
    await waitFor(() => expect((screen.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    // where the focus is at the very moment the alert enters the DOM: a focus left to a passive effect came later, and a check
    // after findByRole raced it (flaky, 1 in 15 full runs)
    let focusedWhenShown: boolean | undefined;
    const seen = new MutationObserver(() => {
      const shown = document.querySelector('[role="alert"]');
      if (shown && focusedWhenShown === undefined) focusedWhenShown = document.activeElement === shown;
    });
    seen.observe(document.body, { childList: true, subtree: true });
    fireEvent.click(screen.getByRole("button", { name: "Criar Sala" }));
    const alert = await screen.findByRole("alert");
    seen.disconnect();
    expect(alert.textContent).toBe("Erro ao criar sala. Detalhe técnico");  // a code we have no sentence for: what the screen was doing
    expect(alert.nextElementSibling?.className).toContain("lb-dialog-footer");  // right above the buttons
    expect(focusedWhenShown).toBe(true);
    expect(document.activeElement).toBe(alert);
    expect(scroll).toHaveBeenCalled();
  });

  it("a request that hangs ends in 20 s with a clear message, and the button leaves 'Salvando'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    backend({ create: () => new Promise(() => {}) });
    render(<CreateRoomModal isOpen onClose={vi.fn()} availableBots={BOTS} />);
    fill();
    await waitFor(() => expect((screen.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Criar Sala" }));
    expect(await screen.findByRole("button", { name: "Salvando..." })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(ROOM_CREATE_TIMEOUT_MS); });
    expect((await screen.findByRole("alert")).textContent).toContain("não respondeu em 20 s");
    expect(screen.getByRole("button", { name: "Criar Sala" })).toBeTruthy();
  });

  it("when Hermes cannot run rooms, the modal says why BEFORE trying, and does not send anything", async () => {
    const calls = backend({ groups: "unavailable", message: "Group Chat is not running in this Hermes." });
    render(<CreateRoomModal isOpen onClose={vi.fn()} availableBots={BOTS} />);
    const notice = await screen.findByTestId("rooms-unavailable");
    expect(notice.textContent).toContain("As salas não estão disponíveis agora.");
    expect(notice.textContent).toContain("Group Chat is not running in this Hermes.");
    fill();
    const create = screen.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/rooms"))).toBe(false);
  });

  it("'Verificar de novo' re-reads the health: unknown blocks too, ok lets the person create", async () => {
    let groups = "unknown";
    setCustomFetchJSON(async (url: string) => (url.endsWith("/health") ? health(groups, groups === "ok" ? undefined : "Group Chat could not be checked right now.") : {}));
    render(<CreateRoomModal isOpen onClose={vi.fn()} availableBots={BOTS} />);
    expect((await screen.findByTestId("rooms-unavailable")).textContent).toContain("could not be checked");
    groups = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Verificar de novo" }));
    await waitFor(() => expect(screen.queryByTestId("rooms-unavailable")).toBeNull());
    fill();
    expect((screen.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("after creating, the new room is in the sidebar list (the app refreshes it from the server)", async () => {
    let created = false;
    const log: string[] = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      log.push(`${method} ${url}`);
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
      if (url.endsWith("/health")) return health("ok");
      if (method === "GET" && /\/bots$/.test(url)) return { bots: BOTS };
      if (method === "GET" && url.endsWith("/rooms")) return { rooms: created ? [{ id: "r1", name: "Lançamento", members: [], driver: { running: false, pending_actions_count: 0 }, created_at: "" }] : [] };
      if (method === "POST" && url.endsWith("/rooms")) { created = true; return { room: { id: "r1", name: "Lançamento", members: [], driver: { running: false, pending_actions_count: 0 }, created_at: "" } }; }
      if (url.includes("/budget")) return { limits: [] };
      return {};
    });
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/ });
    fireEvent.click(screen.getAllByLabelText("Nova sala")[0]);
    await screen.findByRole("dialog");
    fill();
    await waitFor(() => expect((screen.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Criar Sala" }));
    const sidebar = screen.getByRole("complementary", { name: "sidebar" });
    await waitFor(() => expect(within(sidebar).getByText("Lançamento")).toBeTruthy());
    // the list is read again from the server after the POST, not only patched locally
    await waitFor(() => {
      const post = log.findIndex((c) => c.startsWith("POST") && c.endsWith("/rooms"));
      expect(post).toBeGreaterThanOrEqual(0);
      expect(log.slice(post + 1).some((c) => c.startsWith("GET") && c.endsWith("/rooms"))).toBe(true);
    });
  });

  it("a disabled 'Criar Sala' says why, next to it, and is described by that text", async () => {
    backend();
    render(<CreateRoomModal isOpen onClose={vi.fn()} availableBots={BOTS} />);
    const dialog = within(screen.getByRole("dialog"));
    const create = dialog.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement;
    const why = () => document.getElementById(create.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(create.disabled).toBe(true);
    expect(why()).toBe("Dê um nome à sala.");
    fireEvent.change(dialog.getByLabelText(/nome da sala/i), { target: { value: "Lançamento" } });
    expect(why()).toBe("Escolha pelo menos 2 Bots (0 de 2).");
    fireEvent.click(dialog.getByRole("button", { name: /Vendas/ }));
    expect(why()).toBe("Escolha pelo menos 2 Bots (1 de 2).");
    fireEvent.click(dialog.getByRole("button", { name: /Dev/ }));
    await waitFor(() => expect(create.disabled).toBe(false), { timeout: 5000 });
    expect(create.getAttribute("aria-describedby")).toBeNull();
  });

  it("the disabled primary button looks disabled in every palette (not just 40% of a white button)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../../dashboard/src/style.css"), "utf8");
    expect(css).toMatch(/\.lb-btn-primary:disabled\s*\{[^}]*cursor:\s*not-allowed/);
    expect(css).toMatch(/\.lb-btn-primary:disabled\s*\{[^}]*color:\s*var\(--color-muted-foreground\)/);
  });

  it("on a phone, 'Nova sala' from the list opens the dialog, inside the Hermes overlay, and a tap on a Bot marks it", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      setCustomFetchJSON(async (url: string) => (url.endsWith("/health") ? health("ok") : /\/bots$/.test(url) ? { bots: BOTS } : url.includes("/budget") ? { limits: [] } : {}));
      render(<div><main><LuveBotRoute /></main><LuveBotOverlaySlot /></div>);
      fireEvent.click((await screen.findAllByLabelText("Nova sala"))[0]);
      const dialog = within(await screen.findByRole("dialog"));
      expect(document.querySelector(".lb-overlay")?.contains(screen.getByRole("dialog"))).toBe(true);
      const vendas = dialog.getByRole("button", { name: /Vendas/ });
      fireEvent.click(vendas);
      expect(vendas.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(vendas);
      expect(vendas.getAttribute("aria-pressed")).toBe("false");
    } finally { vi.unstubAllGlobals(); }
  });

  it("the VPS case: only one Bot (Maya) is connected; the others are disabled with the reason, and the top says what to do", async () => {
    const calls = backend();
    const vps = [{ ...bot("maya"), status: "idle" as const }, ...["default", "vendas", "juridico"].map((n) => ({ ...bot(n), status: "offline" as const }))];
    render(<CreateRoomModal isOpen onClose={vi.fn()} availableBots={vps} />);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByTestId("rooms-too-few-ready").textContent).toContain("Só 1 Bot conectado ao Hermes; uma sala precisa de 2.");
    expect(dialog.getByTestId("rooms-too-few-ready").textContent).toContain("ative o API server");
    const vendas = dialog.getByRole("button", { name: /Vendas/ }) as HTMLButtonElement;
    expect(vendas.disabled).toBe(true);
    expect(vendas.textContent).toContain("Sem conexão com o Hermes: habilite o API Server deste perfil.");
    fireEvent.click(vendas);
    expect(vendas.getAttribute("aria-pressed")).toBe("false");
    const maya = dialog.getByRole("button", { name: /Maya/ }) as HTMLButtonElement;
    expect(maya.disabled).toBe(false);
    expect(maya.textContent).not.toContain("Sem conexão");
    fireEvent.change(dialog.getByLabelText(/nome da sala/i), { target: { value: "Lançamento" } });
    fireEvent.click(maya);
    const create = dialog.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(document.getElementById(create.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Faltam Bots conectados ao Hermes.");
    fireEvent.click(create);
    expect(calls.some((c) => c.startsWith("POST") && c.endsWith("/rooms"))).toBe(false);
  });
});

