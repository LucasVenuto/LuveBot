// tests/unit/screen/screen.test.tsx
// The work panel's "Tela" tab (D-007 §4): honest refusals with Hermes's words as text, watching, taking and giving back
// control only after a confirmation, Hermes's close codes, the phone keyboard, and noVNC kept out of the bundle.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { screenState, closeOutcome } from "@/components/screen/screen";
import type { BotScreen } from "@/api/types";

// noVNC is loaded at run time from the vendored URL; here a stand-in with the same small surface.
class FakeRFB extends EventTarget {
  static all: FakeRFB[] = [];
  viewOnly = false; scaleViewport = false; resizeSession = true; focusOnClick = true;
  keys: Array<[number, string | null]> = [];
  disconnected = false;
  constructor(public target: HTMLElement, public channel: FakeWS) { super(); FakeRFB.all.push(this); }
  disconnect() { this.disconnected = true; }
  focus() {}
  sendKey(keysym: number, code: string | null) { this.keys.push([keysym, code]); }
}
vi.mock("@/components/screen/novnc", async (orig) => ({ ...(await orig<typeof import("@/components/screen/novnc")>()), loadRFB: async () => FakeRFB }));
class FakeWS extends EventTarget {
  static all: FakeWS[] = [];
  binaryType = "blob";
  constructor(public url: string) { super(); FakeWS.all.push(this); }
  close() {}
  closeWith(code: number) { const e = new Event("close"); Object.assign(e, { code }); this.dispatchEvent(e); }
}

const { ScreenTab } = await import("@/components/screen/ScreenTab");
const { WorkPanel } = await import("@/components/conversation/WorkPanel");

const base = (over: Partial<BotScreen> = {}): BotScreen => ({
  supported: true, installed: true, missing: [], install_command: null, running: true, geometry: "1440x900", placement: "gateway",
  memory: { available_mb: 2900, limit_mb: null, needed_mb: 1536 }, blocker: null,
  lease: { holder: "agent", since: 1, mine: false, by_luvebot: false }, ...over,
});
type World = { screen: BotScreen; calls: Array<{ method: string; url: string; body?: any; csrf: string | null }>; tickets: number; start?: () => unknown };
function backend(world: World) {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    world.calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "GET" && url.endsWith("/bots/vendas/screen")) return { screen: world.screen };
    if (url.endsWith("/screen/start")) { if (world.start) return world.start(); world.screen = base(); return { screen: world.screen }; }
    if (url.endsWith("/screen/watch")) return { ticket: `t${++world.tickets}`, path: "/api/display/ws", expires_in: 30 };
    if (url.endsWith("/screen/take")) { world.screen = base({ lease: { holder: "human", since: 2, mine: true, by_luvebot: true } }); return { ticket: `t${++world.tickets}`, path: "/api/display/ws", expires_in: 30, lease: world.screen.lease }; }
    if (url.endsWith("/screen/return")) { world.screen = base(); return { lease: world.screen.lease }; }
    throw new Error("unexpected " + method + " " + url);
  });
}
const posts = (w: World, suffix: string) => w.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const lastRFB = () => FakeRFB.all[FakeRFB.all.length - 1];
const lastWS = () => FakeWS.all[FakeWS.all.length - 1];
const connected = async () => { await waitFor(() => expect(FakeRFB.all.length).toBeGreaterThan(0)); act(() => { lastRFB().dispatchEvent(new Event("connect")); }); };
const phone = (on: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: on && q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));

beforeEach(() => { cleanup(); resetCsrfToken(); FakeRFB.all = []; FakeWS.all = []; vi.stubGlobal("WebSocket", FakeWS); });
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("what Hermes's status means", () => {
  it("maps the status to an honest state and the close codes to what the tab does", () => {
    expect(screenState(base({ supported: false })).kind).toBe("unsupported");
    expect(screenState(base({ installed: false, missing: ["Xvnc"], install_command: "apt install x" }))).toEqual({ kind: "not_installed", missing: ["Xvnc"], installCommand: "apt install x" });
    expect(screenState(base({ running: false, blocker: "low memory" })).kind).toBe("no_memory");
    expect(screenState(base({ placement: "terminal:docker" }))).toEqual({ kind: "sandbox", placement: "terminal:docker" });
    expect(screenState(base({ running: false })).kind).toBe("stopped");
    expect(screenState(base()).kind).toBe("running");
    expect([4000, 4401, 4001, 4403, 1006].map(closeOutcome)).toEqual(["taken", "ticket", "stopped", "refused", "lost"]);
  });
});

describe("the Tela tab", () => {
  it("a missing install shows Hermes's own words as TEXT, never runs or renders them, and links the README", async () => {
    const world: World = { screen: base({ installed: false, running: false, missing: ["Xvnc", "<b>xdotool</b>"], install_command: "sudo apt install <b>x</b>" }), calls: [], tickets: 0 };
    backend(world);
    const { container } = render(<ScreenTab bot="vendas" label="Vendas" />);
    expect(await screen.findByText(/Faltam pacotes da tela no servidor/)).toBeTruthy();
    expect(screen.getByText("sudo apt install <b>x</b>")).toBeTruthy();
    expect(screen.getByText(/<b>xdotool<\/b>/)).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("link", { name: /Tela ao vivo/ }).getAttribute("href")).toContain("#live-screen");
    expect(world.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("no memory and the sandbox say why; a machine without screens says so", async () => {
    const world: World = { screen: base({ running: false, blocker: "memória livre 900 MB < 1536 MB", memory: { available_mb: 900, needed_mb: 1536 } }), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    expect(await screen.findByText("Pouca memória livre para iniciar a tela agora.")).toBeTruthy();
    expect(screen.getByText("Livre: 900 MB · necessário: 1536 MB")).toBeTruthy();
    expect(screen.getByText("memória livre 900 MB < 1536 MB")).toBeTruthy();
    cleanup();
    backend({ screen: base({ placement: "terminal:docker" }), calls: [], tickets: 0 });
    render(<ScreenTab bot="vendas" label="Vendas" />);
    expect(await screen.findByText(/sandbox do terminal \(terminal:docker\)/)).toBeTruthy();
    cleanup();
    backend({ screen: base({ supported: false }), calls: [], tickets: 0 });
    render(<ScreenTab bot="vendas" label="Vendas" />);
    expect(await screen.findByText(/não tem tela de Bot/)).toBeTruthy();
  });

  it("stopped: Iniciar posts start with CSRF; a refused start shows Hermes's reason", async () => {
    const world: World = { screen: base({ running: false }), calls: [], tickets: 0,
      start: () => { throw new ApiError({ code: "screen_not_installed", message: "x", status: 409, details: { missing: ["Xvnc"], install_command: "apt install tigervnc" } }); } };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Iniciar a tela" }));
    expect(await screen.findByText("apt install tigervnc")).toBeTruthy();
    expect(posts(world, "/screen/start")[0].csrf).toBe("csrf-1");
  });

  it("running: it WATCHES (view only) through Hermes's socket with the single-use ticket", async () => {
    const world: World = { screen: base(), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    expect(posts(world, "/screen/watch")).toHaveLength(1);
    expect(posts(world, "/screen/take")).toHaveLength(0);
    expect(lastWS().url).toMatch(/^ws:\/\/[^/]+\/api\/display\/ws\?display_ticket=t1$/);
    expect(lastWS().binaryType).toBe("arraybuffer");
    expect(lastRFB().channel).toBe(lastWS());
    expect(lastRFB().viewOnly).toBe(true);
    expect(lastRFB().scaleViewport).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Você está vendo a tela");
    expect(screen.getByRole("region", { name: "Tela do Bot Vendas" })).toBeTruthy();
  });

  it("taking control needs a confirmation (Cancel sends nothing); confirmed, it reconnects with control and says so", async () => {
    const world: World = { screen: base(), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }));
    let dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Cancelar" }));
    expect(posts(world, "/screen/take")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }));
    dialog = within(await screen.findByRole("dialog"));
    // the sheet's text, the reason field and the buttons sit in the dialog body (its side margins: phone capture, 2026-10-02)
    const body = (dialog.getByLabelText(/Motivo/) as HTMLElement).closest(".lb-dialog-body");
    expect(body).toBeTruthy();
    expect(body!.contains(dialog.getByText(/^Enquanto você controla/))).toBe(true);
    expect(dialog.getByRole("button", { name: "Assumir" }).closest(".lb-dialog-body")).toBe(body);
    fireEvent.change(dialog.getByLabelText(/Motivo/), { target: { value: "corrigir o formulário" } });
    fireEvent.click(dialog.getByRole("button", { name: "Assumir" }));
    await waitFor(() => expect(posts(world, "/screen/take")).toHaveLength(1));
    expect(posts(world, "/screen/take")[0].body).toEqual({ reason: "corrigir o formulário" });
    await waitFor(() => expect(FakeRFB.all.length).toBe(2));
    expect(FakeRFB.all[0].disconnected).toBe(true);
    expect(lastWS().url).toContain("display_ticket=t2");
    expect(lastRFB().viewOnly).toBe(false);
    act(() => { lastRFB().dispatchEvent(new Event("connect")); });
    expect(screen.getByRole("note").textContent).toBe("Você está no controle");
  });

  it("giving back needs a confirmation and returns to watching", async () => {
    const world: World = { screen: base(), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Assumir" }));
    await waitFor(() => expect(FakeRFB.all.length).toBe(2));
    act(() => { lastRFB().dispatchEvent(new Event("connect")); });
    fireEvent.click(screen.getByRole("button", { name: "Devolver ao Bot" }));
    expect(posts(world, "/screen/return")).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Devolver" }));
    await waitFor(() => expect(posts(world, "/screen/return")).toHaveLength(1));
    await waitFor(() => expect(FakeRFB.all.length).toBe(3));
    expect(lastRFB().viewOnly).toBe(true);
  });

  it("4000: someone took control, back to watching with a notice; 4401: ticket spent, watch again, twice in a row stops", async () => {
    const world: World = { screen: base(), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    act(() => { lastWS().closeWith(4000); });
    await waitFor(() => expect(posts(world, "/screen/watch")).toHaveLength(2));
    expect(screen.getByRole("status").textContent).toContain("Outra pessoa assumiu o controle");
    act(() => { lastRFB().dispatchEvent(new Event("connect")); });
    act(() => { lastWS().closeWith(4401); });
    await waitFor(() => expect(posts(world, "/screen/watch")).toHaveLength(3));
    act(() => { lastWS().closeWith(4401); });  // a second spent ticket in a row: no loop
    expect(await screen.findByRole("button", { name: "Reconectar" })).toBeTruthy();
    expect(posts(world, "/screen/watch")).toHaveLength(3);
  });

  it("4001: the screen stopped, the status is read again; 4403: origin refused, an error and no reconnection", async () => {
    const world: World = { screen: base(), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    world.screen = base({ running: false });
    act(() => { lastWS().closeWith(4001); });
    expect(await screen.findByRole("button", { name: "Iniciar a tela" })).toBeTruthy();
    expect(world.calls.filter((c) => c.method === "GET" && c.url.endsWith("/screen"))).toHaveLength(2);
    cleanup();
    const w2: World = { screen: base(), calls: [], tickets: 0 };
    backend(w2);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    act(() => { lastWS().closeWith(4403); });
    expect((await screen.findByRole("alert")).textContent).toContain("recusou a origem");
    expect(posts(w2, "/screen/watch")).toHaveLength(1);
  });

  it("on a phone, in control, the Teclado field types into the Bot's screen", async () => {
    phone(true);
    vi.stubGlobal("WebSocket", FakeWS);
    const world: World = { screen: base(), calls: [], tickets: 0 };
    backend(world);
    render(<ScreenTab bot="vendas" label="Vendas" />);
    await connected();
    fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Assumir" }));
    await waitFor(() => expect(FakeRFB.all.length).toBe(2));
    act(() => { lastRFB().dispatchEvent(new Event("connect")); });
    expect(screen.getByRole("button", { name: "Teclado" })).toBeTruthy();
    const field = screen.getByLabelText("Digitar na tela do Bot") as HTMLTextAreaElement;
    field.value = "aé";
    fireEvent.input(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(lastRFB().keys).toEqual([[0x61, null], [0xe9, null], [0xff0d, "Enter"]]);
  });

  it("the work panel has the Tela tab beside Atividade, Terminal and Arquivos", async () => {
    backend({ screen: base({ running: false }), calls: [], tickets: 0 });
    render(<WorkPanel items={[]} bot={{ name: "vendas", label: "Vendas" }} />);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Atividade", "Terminal", "Arquivos", "Tela"]);
    fireEvent.click(screen.getByRole("tab", { name: "Tela" }));
    expect(await screen.findByRole("button", { name: "Iniciar a tela" })).toBeTruthy();
  });

  it("noVNC never enters the bundle: no static import of the vendored code, only its URL at run time", () => {
    const src = path.resolve(__dirname, "../../../dashboard/src");
    const files = (fs.readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.(t|j)sx?$/.test(f));
    for (const f of files) {
      const text = fs.readFileSync(path.join(src, f), "utf8");
      // any static import of the vendored code, named or bare ("import x from …", "import …"); the dynamic import(url) is allowed
      expect(/^\s*import\s+(?:[^;(]*?\s+from\s+)?["'][^"']*vendor\/novnc/m.test(text), f).toBe(false);
      expect(/require\(["'][^"']*vendor\/novnc/.test(text), f).toBe(false);
    }
    const loader = fs.readFileSync(path.join(src, "components/screen/novnc.ts"), "utf8");
    expect(loader).toContain("/dashboard-plugins/luvebot/vendor/novnc/core/rfb.js");
    expect(loader).toMatch(/import\(\s*\/\*[^*]*\*\/\s*url\s*\)/);
  });
});
