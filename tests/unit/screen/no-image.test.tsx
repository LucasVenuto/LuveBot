// tests/unit/screen/no-image.test.tsx
// "Sem imagem há N s" with "Reconectar" (approved after the WebKit analysis of test_11): with the link open, no picture
// N s after connecting, or data arriving with no new picture for N s (how noVNC 1.7.0 looks when its render queue stalls,
// vendored display.js:516-522, untouched). A still screen sends nothing and never warns. The canvas is a stand-in here.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { noImageFor, NO_IMAGE_S } from "@/components/screen/screen";
import type { BotScreen } from "@/api/types";

class FakeRFB extends EventTarget {
  static all: FakeRFB[] = [];
  viewOnly = false; scaleViewport = false; resizeSession = true; focusOnClick = true;
  canvas: HTMLCanvasElement;
  constructor(public target: HTMLElement, public channel: FakeWS) {
    super(); FakeRFB.all.push(this);
    this.canvas = document.createElement("canvas"); this.canvas.width = 1440; this.canvas.height = 900;  // noVNC's own canvas
    target.appendChild(this.canvas);
  }
  disconnect() { this.canvas.remove(); }
  focus() {}
  sendKey() {}
}
vi.mock("@/components/screen/novnc", async (orig) => ({ ...(await orig<typeof import("@/components/screen/novnc")>()), loadRFB: async () => FakeRFB }));
class FakeWS extends EventTarget {
  static all: FakeWS[] = [];
  binaryType = "blob";
  constructor(public url: string) { super(); FakeWS.all.push(this); }
  close() {}
  data() { this.dispatchEvent(new Event("message")); }
}
const { ScreenTab } = await import("@/components/screen/ScreenTab");

// What the canvas shows, as the sampler reads it: 0 = nothing drawn yet (transparent), anything else = a picture.
let picture = 0;
let unreadable = false;
const ctx = {
  clearRect() {}, drawImage() {},
  getImageData(_x: number, _y: number, w: number, h: number) {
    if (unreadable) throw new DOMException("tainted", "SecurityError");
    return { data: new Uint8ClampedArray(w * h * 4).fill(picture) };
  },
};

const running: BotScreen = { supported: true, installed: true, missing: [], install_command: null, running: true, geometry: "1440x900", placement: "gateway",
  memory: { available_mb: 2900, limit_mb: null, needed_mb: 1536 }, blocker: null, lease: { holder: "agent", since: 1, mine: false, by_luvebot: false } };
const posts: string[] = [];
function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") posts.push(url.split("/").pop()!);
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "GET" && url.endsWith("/bots/vendas/screen")) return { screen: running };
    if (url.endsWith("/screen/watch") || url.endsWith("/screen/take")) return { ticket: `t${posts.length}`, path: "/api/display/ws", expires_in: 30 };
    throw new Error("unexpected " + method + " " + url);
  });
}
const last = <T,>(a: T[]) => a[a.length - 1];
const seconds = async (s: number) => { for (let i = 0; i < s; i++) await act(async () => { vi.advanceTimersByTime(1000); }); };
async function watching() {
  render(<ScreenTab bot="vendas" label="Vendas" />);
  await waitFor(() => expect(FakeRFB.all.length).toBe(1));
  act(() => { last(FakeRFB.all).dispatchEvent(new Event("connect")); });
  await screen.findByRole("button", { name: "Assumir controle" });
}
const warning = () => screen.queryByText(/^Sem imagem há \d+ s/);

beforeEach(() => {
  cleanup(); resetCsrfToken(); FakeRFB.all = []; FakeWS.all = []; posts.length = 0; picture = 0; unreadable = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("WebSocket", FakeWS);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
  backend();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("when to say there is no picture", () => {
  it("decides from the times only: none yet after N s, or data with no new picture for N s; a still screen never", () => {
    const t0 = 1_000_000;
    expect(noImageFor(t0 + 9_900, { since: t0, painted: null, pending: null })).toBeNull();
    expect(noImageFor(t0 + NO_IMAGE_S * 1000, { since: t0, painted: null, pending: null })).toBe(10);
    expect(noImageFor(t0 + 600_000, { since: t0, painted: t0 + 1000, pending: null })).toBeNull();          // still screen
    expect(noImageFor(t0 + 60_000, { since: t0, painted: t0 + 1000, pending: t0 + 55_000 })).toBeNull();    // data 5 s ago
    expect(noImageFor(t0 + 60_000, { since: t0, painted: t0 + 1000, pending: t0 + 48_000 })).toBe(12);
  });
});

describe("Sem imagem há N s, in the Tela tab", () => {
  it("no picture N s after connecting: the warning with 'Reconectar', which opens a new watch", async () => {
    await watching();
    await seconds(9);
    expect(warning()).toBeNull();
    await seconds(2);
    expect(warning()?.textContent).toBe("Sem imagem há 10 s. A conexão está aberta, mas nenhuma imagem nova chegou.");
    expect(posts.filter((p) => p === "watch")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    await waitFor(() => expect(posts.filter((p) => p === "watch")).toHaveLength(2));
    await waitFor(() => expect(FakeRFB.all.length).toBe(2));
    expect(warning()).toBeNull();
  });

  it("a still screen (a picture, then nothing arriving) never warns", async () => {
    await watching();
    picture = 90;
    await seconds(60);
    expect(warning()).toBeNull();
  });

  it("data keeps coming but the picture stopped changing: warns after N s, and goes away when the picture moves again", async () => {
    await watching();
    picture = 90;
    await seconds(2);
    last(FakeWS.all).data();          // an update arrived... and the canvas did not change
    await seconds(9);
    expect(warning()).toBeNull();
    await seconds(2);
    expect(warning()).toBeTruthy();
    picture = 140;                    // the picture moves again
    await seconds(1);
    expect(warning()).toBeNull();
  });

  it("a canvas this browser cannot read: says nothing rather than guess", async () => {
    unreadable = true;
    await watching();
    await seconds(30);
    expect(warning()).toBeNull();
  });

  it("in control, 'Reconectar' reconnects in control (the take is asked and audited again)", async () => {
    await watching();
    fireEvent.click(screen.getByRole("button", { name: "Assumir controle" }));
    fireEvent.click(await screen.findByRole("button", { name: "Assumir" }));
    await waitFor(() => expect(FakeRFB.all.length).toBe(2));
    act(() => { last(FakeRFB.all).dispatchEvent(new Event("connect")); });
    await seconds(11);
    fireEvent.click(screen.getByRole("button", { name: "Reconectar" }));
    await waitFor(() => expect(posts.filter((p) => p === "take")).toHaveLength(2));
  });
});
