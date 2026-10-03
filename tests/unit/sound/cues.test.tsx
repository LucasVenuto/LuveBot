// tests/unit/sound/cues.test.tsx
// LuveBot's sounds with a fake AudioContext: nothing before the first click (autoplay), only when the person is not looking
// at that Bot, never for their own doing, at most one every 2 s, the preference per browser, and two short quiet timbres.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { Bot } from "@/api/types";

type Tone = { type: string; freqs: number[]; start: number; stop: number; peak: number };
let tones: Tone[];
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  resume() { return Promise.resolve(); }
  createGain() {
    const g = { peak: 0, gain: { setValueAtTime() {}, exponentialRampToValueAtTime(v: number) { g.peak = Math.max(g.peak, v); } }, connect() {} };
    return g;
  }
  createOscillator() {
    const tone: Tone = { type: "", freqs: [], start: 0, stop: 0, peak: 0 };
    let gain: { peak: number } | null = null;
    const o = {
      set type(v: string) { tone.type = v; },
      frequency: { setValueAtTime: (f: number) => tone.freqs.push(f), exponentialRampToValueAtTime: (f: number) => tone.freqs.push(f) },
      connect: (g: { peak: number }) => { gain = g; },
      start: (at: number) => { tone.start = at; },
      stop: (at: number) => { tone.stop = at; tone.peak = gain?.peak ?? 0; tones.push(tone); },
    };
    return o;
  }
}

const bot = (name: string, over: Partial<Bot> & { replies?: number } = {}): Bot => ({
  name, is_default: false, description: "", model: { provider: "p", name: "m" }, status: over.status ?? "idle",
  unread: { count: over.replies ?? 0, replies: over.replies ?? 0, routine_results: 0 },
  display: { label: name, color: "#60a5fa" },
} as unknown as Bot);

let cues: typeof import("@/sound/cues");
let focused = true;
function Host({ bots, pending, open }: { bots: Bot[] | null; pending: Record<string, number> | null; open: string | null }) {
  cues.useCues(bots, pending, open);
  return null;
}
const click = () => fireEvent.pointerDown(document.body);

beforeEach(async () => {
  cleanup(); tones = []; focused = true;
  vi.resetModules();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  (window as any).AudioContext = FakeAudioContext;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  window.localStorage.removeItem("luvebot.sounds");
  cues = await import("@/sound/cues");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete (window as any).AudioContext; });

describe("when a sound plays", () => {
  it("never before the first click on the page (autoplay); after it, 'needs you' is two rising tones, short and quiet", () => {
    const r = render(<Host bots={[bot("vendas")]} pending={{}} open={null} />);
    r.rerender(<Host bots={[bot("vendas")]} pending={{ vendas: 1 }} open={null} />);
    expect(tones).toHaveLength(0);                       // no click yet: the browser would block it
    click();
    vi.advanceTimersByTime(2500);
    r.rerender(<Host bots={[bot("vendas")]} pending={{ vendas: 2 }} open={null} />);
    expect(tones).toHaveLength(2);
    const [a, b] = tones;
    expect(b.freqs[0]).toBeGreaterThan(a.freqs[0]);      // ascending
    expect(b.stop - a.start).toBeLessThan(0.3);
    expect(Math.max(a.peak, b.peak)).toBeLessThanOrEqual(0.1);
  });

  it("a new message is one soft blip under 300 ms", () => {
    const r = render(<Host bots={[bot("vendas")]} pending={{}} open={null} />);
    click();
    r.rerender(<Host bots={[bot("vendas", { replies: 1 })]} pending={{}} open={null} />);
    expect(tones).toHaveLength(1);
    expect(tones[0].stop - tones[0].start).toBeLessThan(0.3);
    expect(tones[0].peak).toBeLessThanOrEqual(0.1);
  });

  it("not while the person looks at that Bot (tab in focus, its conversation open); yes with the tab out of focus or another Bot open", () => {
    const r = render(<Host bots={[bot("vendas")]} pending={{}} open="vendas" />);
    click();
    r.rerender(<Host bots={[bot("vendas", { replies: 1 })]} pending={{}} open="vendas" />);
    expect(tones).toHaveLength(0);
    focused = false;
    r.rerender(<Host bots={[bot("vendas", { replies: 2 })]} pending={{}} open="vendas" />);
    expect(tones).toHaveLength(1);
    focused = true;
    vi.advanceTimersByTime(2500);
    r.rerender(<Host bots={[bot("vendas", { replies: 3 })]} pending={{}} open="dev" />);
    expect(tones).toHaveLength(2);
  });

  it("never for the person's own doing: the first load, a Bot just created, a decision (fewer pending), nothing new", () => {
    const r = render(<Host bots={null} pending={null} open={null} />);   // the app is up, the lists have not answered yet
    click();
    r.rerender(<Host bots={[bot("vendas", { replies: 5 })]} pending={{ vendas: 2 }} open={null} />);   // first answers: baseline
    vi.advanceTimersByTime(2500);
    r.rerender(<Host bots={[bot("vendas", { replies: 5 }), bot("novo", { replies: 1, status: "waiting_approval" })]} pending={{ vendas: 1, novo: 1 }} open={null} />);
    vi.advanceTimersByTime(2500);
    r.rerender(<Host bots={[bot("vendas", { replies: 5 }), bot("novo", { replies: 1, status: "waiting_approval" })]} pending={{ vendas: 1, novo: 1 }} open={null} />);
    expect(tones).toHaveLength(0);
  });

  it("at most one sound every 2 s: a burst plays once", () => {
    const r = render(<Host bots={[bot("a"), bot("b")]} pending={{}} open={null} />);
    click();
    r.rerender(<Host bots={[bot("a", { replies: 1 }), bot("b", { replies: 1 })]} pending={{}} open={null} />);
    r.rerender(<Host bots={[bot("a", { replies: 2 }), bot("b", { replies: 2 })]} pending={{ a: 1 }} open={null} />);
    expect(tones).toHaveLength(1);
    vi.advanceTimersByTime(2100);
    r.rerender(<Host bots={[bot("a", { replies: 3 }), bot("b", { replies: 2 })]} pending={{ a: 1 }} open={null} />);
    expect(tones).toHaveLength(2);
  });

  it("a Bot that stops to wait for you sounds 'needs you'", () => {
    const r = render(<Host bots={[bot("vendas")]} pending={null} open={null} />);
    click();
    r.rerender(<Host bots={[bot("vendas", { status: "waiting_approval" })]} pending={null} open={null} />);
    expect(tones).toHaveLength(2);
  });
});

describe("the preference (Configurações → Sons do LuveBot)", () => {
  it("'Só o que precisa de você' keeps 'needs you' and drops the blip; 'Desligados' drops both; kept in this browser", async () => {
    const { SettingsView } = await import("@/components/settings/SettingsView");
    render(<SettingsView />);
    expect((screen.getByRole("radio", { name: "Mensagens novas e o que precisa de você" }) as HTMLInputElement).checked).toBe(true);   // default on
    fireEvent.click(screen.getByRole("radio", { name: "Só o que precisa de você" }));
    expect(window.localStorage.getItem("luvebot.sounds")).toBe("needs_you");
    cleanup();
    const r = render(<Host bots={[bot("vendas")]} pending={{}} open={null} />);
    click();
    r.rerender(<Host bots={[bot("vendas", { replies: 1 })]} pending={{}} open={null} />);
    expect(tones).toHaveLength(0);
    r.rerender(<Host bots={[bot("vendas", { replies: 1 })]} pending={{ vendas: 1 }} open={null} />);
    expect(tones).toHaveLength(2);
    cues.writeSoundPref("off");
    vi.advanceTimersByTime(2500);
    r.rerender(<Host bots={[bot("vendas", { replies: 1 })]} pending={{ vendas: 2 }} open={null} />);
    expect(tones).toHaveLength(2);
  });

  it("a blocked storage falls back to 'all' and nothing breaks", () => {
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    try {
      expect(cues.readSoundPref()).toBe("all");
      expect(() => cues.writeSoundPref("off")).not.toThrow();
      expect(() => cues.writeSoundPref("all")).not.toThrow();
    } finally {
      Object.defineProperty(window, "localStorage", real);
    }
  });
});

describe("the open conversation tells the app at once when it waits for you", () => {
  it("onActivityChange fires when the run starts and again when it stops for an approval (the '!' and its sound do not wait 15 s)", async () => {
    vi.useRealTimers();
    const { Conversation } = await import("@/components/conversation");
    const { setCustomFetchJSON } = await import("@/api/client");
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (url.endsWith("/sessions")) return { session: { id: "s1" } };
      if ((init?.method ?? "GET") === "POST" && url.endsWith("/runs")) return { run: { id: "run_r1", status: "started", session_id: "s1" } };
      return { run: { id: "run_r1", status: "started" } };
    });
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
    const changed = vi.fn();
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} pollMs={10} onActivityChange={changed}
      fetcher={async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));   // the run has an id
    ctl.enqueue(new TextEncoder().encode(`id: 0\ndata: ${JSON.stringify({ event: "approval.request", request_id: "r9", command: "git push", description: "push", choices: ["once", "deny"], run_id: "run_r1", seq: 0 })}\n\n`));
    await screen.findByText("Aguardando aprovação");
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));  // it comes from an effect right after that render
    setCustomFetchJSON(null);
  });
});
