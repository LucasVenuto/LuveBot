// tests/unit/perf/health-slow.test.tsx
// /health can take up to 5 s (get_status, Brasa's finding). Pages and "Criar Sala" open at once and fill in what depends
// on health when it arrives, never releasing an action that depends on it earlier. And a hidden tab keeps refreshing
// once a minute only while the sounds are on (approved follow-up of the sounds).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor, act } from "@testing-library/react";
import { PagesLibrary } from "@/components/pages/PagesLibrary";
import { CreateRoomModal } from "@/components/rooms/CreateRoomModal";
import { LuveBotApp } from "@/index";
import { HIDDEN_REFRESH_MS } from "@/hooks/useLiveRefresh";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Bot, Page } from "@/api/types";

const bot = (name: string, status: Bot["status"] = "idle"): Bot => ({ name, is_default: false, description: "", model: { provider: "p", name: "m" }, status,
  display: { label: name[0].toUpperCase() + name.slice(1), color: "#60a5fa" } } as Bot);
const page: Page = { slug: "proposta", title: "Proposta Alder", excerpt: "x", size: 1, mtime: "2026-10-01T14:00:00Z", sha: "a".repeat(64), rev: 1,
  author: "bot", author_label: "Vendas", by_you: false, changed_outside: false, editable: true, readonly_reason: null } as Page;

/** /health answered by hand; everything else at once. */
function slowHealth(rest: (url: string) => unknown) {
  let answer!: (v: unknown) => void;
  let fail!: (e: unknown) => void;
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
    if (url.endsWith("/health")) return new Promise((ok, no) => { answer = ok; fail = no; });
    return rest(url);
  });
  return { ok: (pages: string, groups = "ok") => answer({ status: "ok", features: { pages, groups }, problems: [] }), fail: () => fail(new Error("timeout")) };
}

beforeEach(() => { cleanup(); resetCsrfToken(); try { localStorage.clear(); } catch { /* */ } });
afterEach(() => { setCustomFetchJSON(null); vi.useRealTimers(); });

describe("Pages library with a slow /health", () => {
  it("shows the pages at once; 'Nova página' only once health says Pages is writable", async () => {
    const h = slowHealth(() => ({ workspace: { state: "ready" }, pages: [page], skipped: 0 }));
    render(<PagesLibrary bot={bot("vendas")} onOpen={() => {}} />);
    expect(await screen.findByText("Proposta Alder")).toBeTruthy();       // health has not answered
    expect(screen.queryByRole("button", { name: /Nova página/ })).toBeNull();
    await act(async () => { h.ok("ok"); });
    expect(await screen.findByRole("button", { name: /Nova página/ })).toBeTruthy();
  });

  it("read-only from health: the note shows and nothing can be created", async () => {
    const h = slowHealth(() => ({ workspace: { state: "ready" }, pages: [page], skipped: 0 }));
    render(<PagesLibrary bot={bot("vendas")} onOpen={() => {}} />);
    await screen.findByText("Proposta Alder");
    await act(async () => { h.ok("read_only"); });
    expect(await screen.findByText(/mas esta versão do Hermes não deixa o LuveBot salvar/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Nova página/ })).toBeNull();
  });

  it("health's verdict wins: pages already shown go away when health says Pages is not here", async () => {
    const h = slowHealth(() => ({ workspace: { state: "ready" }, pages: [page], skipped: 0 }));
    render(<PagesLibrary bot={bot("vendas")} onOpen={() => {}} />);
    await screen.findByText("Proposta Alder");
    await act(async () => { h.ok("unavailable"); });
    await waitFor(() => expect(screen.queryByText("Proposta Alder")).toBeNull());
    expect(screen.queryByRole("button", { name: /Nova página/ })).toBeNull();
  });
});

describe("Criar Sala with a slow /health", () => {
  const ready = [bot("maya"), bot("dev")];
  it("opens at once and can be filled; 'Criar Sala' waits for health and then frees up", async () => {
    const h = slowHealth(() => ({ rooms: [] }));
    render(<CreateRoomModal isOpen onClose={() => {}} availableBots={ready} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/nome da sala/i), { target: { value: "Lançamento" } });
    fireEvent.click(dialog.getByRole("button", { name: /Maya/ }));
    fireEvent.click(dialog.getByRole("button", { name: /Dev/ }));
    const create = dialog.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(document.getElementById(create.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Verificando se as salas estão disponíveis neste Hermes…");
    await act(async () => { h.ok("ok", "ok"); });
    await waitFor(() => expect(create.disabled).toBe(false));
  });

  it("health says rooms are unavailable: never freed; health itself failed: the person may try", async () => {
    const h = slowHealth(() => ({ rooms: [] }));
    const r = render(<CreateRoomModal isOpen onClose={() => {}} availableBots={ready} />);
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(/nome da sala/i), { target: { value: "Lançamento" } });
    fireEvent.click(dialog.getByRole("button", { name: /Maya/ }));
    fireEvent.click(dialog.getByRole("button", { name: /Dev/ }));
    await act(async () => { h.ok("ok", "unavailable"); });
    expect(await screen.findByTestId("rooms-unavailable")).toBeTruthy();
    expect((dialog.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
    const h2 = slowHealth(() => ({ rooms: [] }));
    render(<CreateRoomModal isOpen onClose={() => {}} availableBots={ready} />);
    const d2 = within(screen.getByRole("dialog"));
    fireEvent.change(d2.getByLabelText(/nome da sala/i), { target: { value: "Lançamento" } });
    fireEvent.click(d2.getByRole("button", { name: /Maya/ }));
    fireEvent.click(d2.getByRole("button", { name: /Dev/ }));
    await act(async () => { h2.fail(); });
    await waitFor(() => expect((d2.getByRole("button", { name: "Criar Sala" }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe("a hidden tab keeps listening only for the sounds", () => {
  const hide = (hidden: boolean) => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  afterEach(() => hide(false));

  async function approvalsAskedWhileHidden(): Promise<number> {
    const calls: string[] = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (/\/bots$/.test(url)) return { bots: [bot("vendas")] };
      if (url.includes("/approvals")) return { approvals: [] };
      return {};
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<LuveBotApp />);
    await screen.findByRole("button", { name: /Vendas/ });
    const asked = () => calls.filter((c) => c.startsWith("GET") && c.includes("/approvals")).length;
    const before = asked();
    hide(true);
    await act(async () => { vi.advanceTimersByTime(HIDDEN_REFRESH_MS + 100); });
    return asked() - before;
  }

  it("sounds on (the default): one refresh a minute with the tab hidden", async () => {
    expect(await approvalsAskedWhileHidden()).toBe(1);
  });

  it("sounds off: a hidden tab asks nothing, as before", async () => {
    localStorage.setItem("luvebot.sounds", "off");
    expect(await approvalsAskedWhileHidden()).toBe(0);
  });
});
