// tests/unit/voice/radio.test.tsx
// The Radio (contract v0.7 section 2 and 4): the microphone is asked only on the button's gesture, in ONE module; hold and release
// sends ONE recording, drag out cancels with no upload, a quick tap is "toque para começar/parar", Space works; the tracks are
// stopped on release, cancel, 120 s, unmount and a hidden page; an empty transcript sends nothing; the text goes as a normal turn
// and the reply to it is spoken (blob: URL); typed turns are never spoken; any reply has "Ouvir"; plain HTTP says "precisa de HTTPS".
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { useRadio } from "@/voice/useRadio";
import { RadioButton } from "@/voice/RadioButton";
import { Conversation } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

// jsdom has no PointerEvent: a MouseEvent with pointerId carries button and coordinates like a browser's (the product checks them)
if (typeof (window as any).PointerEvent === "undefined") {
  (window as any).PointerEvent = class extends MouseEvent { pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; } };
}

class FakeTrack { stopped = false; stop() { this.stopped = true; } }
class FakeRecorder {
  static isTypeSupported = (type: string) => type.startsWith("audio/webm");
  state = "inactive"; mimeType: string; ondataavailable: ((e: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null;
  constructor(_s: unknown, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? "audio/webm"; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["voz"], { type: "audio/webm" }) }); this.onstop?.(); }
}
class FakeAudio { src = ""; play = vi.fn(async () => {}); pause = vi.fn(); onended: (() => void) | null = null; onerror: (() => void) | null = null; removeAttribute() { this.src = ""; } }

let tracks: FakeTrack[];
let gum: ReturnType<typeof vi.fn>;
let uploads: Array<{ url: string; type: string | null; csrf: string | null; size: number }>;
let spoken: string[];
let transcript: { text: string; provider: string | null };
let now: number;
let gate: Promise<void> | null;   // when set, the transcription answers only after it is released
const sdkBefore = (window as any).__HERMES_PLUGIN_SDK__;

beforeEach(() => {
  cleanup(); resetCsrfToken();
  gate = null; tracks = []; uploads = []; spoken = []; transcript = { text: "Separe os leads de ontem", provider: "openai" }; now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  gum = vi.fn(async () => { const track = new FakeTrack(); tracks.push(track); return { getTracks: () => [track] }; });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gum }, configurable: true });
  (globalThis as any).MediaRecorder = FakeRecorder;
  (globalThis as any).Audio = FakeAudio;
  (URL as any).createObjectURL = vi.fn(() => "blob:luvebot/voz");
  (URL as any).revokeObjectURL = vi.fn();
  (window as any).__HERMES_PLUGIN_SDK__ = { ...sdkBefore, authedFetch: async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (url.split("?")[0].endsWith("/voice/transcribe")) {
      uploads.push({ url, type: h.get("Content-Type"), csrf: h.get("X-LuveBot-CSRF"), size: (init?.body as Blob).size });
      if (gate) await gate;
      return new Response(JSON.stringify(transcript), { status: 200 });
    }
    if (url.split("?")[0].endsWith("/voice/speak")) { spoken.push(JSON.parse(String(init?.body)).text); return new Response(new Blob(["mp3"], { type: "audio/mpeg" })); }
    return new Response("{}");
  } };
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" } : {}));
});
afterEach(() => { (window as any).__HERMES_PLUGIN_SDK__ = sdkBefore; setCustomFetchJSON(null); vi.restoreAllMocks(); vi.useRealTimers(); });

function Harness({ onText }: { onText: (text: string) => void }) {
  const radio = useRadio({ bot: "vendas", onText });
  const [tap, setTap] = React.useState(false);
  return (
    <>
      <RadioButton radio={radio} disabled={false} onTapMode={setTap} />
      <span data-testid="phase">{radio.phase}</span>
      <span data-testid="problem">{radio.problem ? (radio.problem instanceof Error ? (radio.problem as any).code : radio.problem) : ""}</span>
      <span data-testid="tap">{String(tap)}</span>
    </>
  );
}
const button = () => screen.getByRole("button", { name: "Rádio: segure para falar" });
const phase = () => screen.getByTestId("phase").textContent;
async function hold(ms: number, release: { x?: number } = {}) {
  await act(async () => { fireEvent.pointerDown(button(), { button: 0, pointerId: 1, clientX: 10, clientY: 10 }); });
  // the harness shows the phase; in the conversation, recording is the red strip in the composer
  await waitFor(() => expect(screen.queryByTestId("phase")?.textContent === "recording" || !!screen.queryByTestId("radio-strip")?.textContent?.includes("Gravando")).toBe(true));
  now += ms;
  await act(async () => { fireEvent.pointerUp(button(), { button: 0, pointerId: 1, clientX: release.x ?? 10, clientY: 10 }); });
}

describe("the microphone is asked only on the gesture, in one module", () => {
  it("getUserMedia lives in dashboard/src/voice/mic.ts, openMic only in useRadio, begin only in the button; voice keeps nothing in storage", () => {
    const src = path.resolve(__dirname, "../../../dashboard/src");
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const where = (re: RegExp) => files(src).filter((f) => /\.tsx?$/.test(f) && re.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(src, f)).sort();
    expect(where(/getUserMedia\s*\(/)).toEqual(["voice/mic.ts"]);
    expect(where(/\bopenMic\(/)).toEqual(["voice/live.ts", "voice/mic.ts", "voice/useRadio.ts"]);   // the Call's transport opens it for a call (v0.7 4.1)
    expect(where(/radio\.begin\(/)).toEqual(["voice/RadioButton.tsx"]);
    expect(where(/call\.begin\(/)).toEqual(["voice/CallButton.tsx"]);                                  // the Call button's click, and nowhere else
    expect(where(/new LiveCall\(/)).toEqual(["voice/useCall.ts"]);
    expect(where(/new MediaRecorder\(/)).toEqual(["voice/useRadio.ts"]);                                     // no recording in a call (4.2)
    expect(files(path.join(src, "voice")).filter((f) => /localStorage|sessionStorage|indexedDB/.test(fs.readFileSync(f, "utf8")))).toEqual([]);
  });

  it("nothing on mount, nor on focus", () => {
    render(<Harness onText={() => {}} />);
    fireEvent.focus(button());
    expect(gum).not.toHaveBeenCalled();
  });
});

describe("hold to talk", () => {
  it("hold and release: ONE upload of the recording (its type, CSRF), the text back, the microphone released", async () => {
    const onText = vi.fn();
    render(<Harness onText={onText} />);
    await hold(1500);
    await waitFor(() => expect(onText).toHaveBeenCalledWith("Separe os leads de ontem", "openai"));
    expect(uploads).toEqual([{ url: "/api/plugins/luvebot/bots/vendas/voice/transcribe?profile=current", type: "audio/webm", csrf: "csrf-1", size: 3 }]);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(phase()).toBe("idle");
  });

  it("dragging out cancels before any upload", async () => {
    render(<Harness onText={() => {}} />);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0, toJSON() {} } as DOMRect);
    await hold(1500, { x: 300 });
    expect(uploads).toEqual([]);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(phase()).toBe("idle");
  });

  it("a quick tap keeps recording ('toque para começar e toque para parar'); the next tap sends", async () => {
    const onText = vi.fn();
    render(<Harness onText={onText} />);
    await hold(100);
    expect(phase()).toBe("recording");
    expect(screen.getByTestId("tap").textContent).toBe("true");
    expect(uploads).toEqual([]);
    await act(async () => { fireEvent.pointerDown(button(), { button: 0, pointerId: 1 }); });
    await waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
    expect(uploads).toHaveLength(1);
  });

  it("Space held on the button records and sends on release", async () => {
    const onText = vi.fn();
    render(<Harness onText={onText} />);
    await act(async () => { fireEvent.keyDown(button(), { key: " " }); });
    await waitFor(() => expect(phase()).toBe("recording"));
    now += 1200;
    await act(async () => { fireEvent.keyUp(button(), { key: " " }); });
    await waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
  });

  it("an empty transcript sends nothing and says 'Não ouvi nada'", async () => {
    transcript = { text: "  ", provider: "local" };
    const onText = vi.fn();
    render(<Harness onText={onText} />);
    await hold(1500);
    await waitFor(() => expect(screen.getByTestId("problem").textContent).toBe("empty"));
    expect(onText).not.toHaveBeenCalled();
  });

  it("stops by itself at 120 s and sends what it has", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const onText = vi.fn();
    render(<Harness onText={onText} />);
    await act(async () => { fireEvent.pointerDown(button(), { button: 0, pointerId: 1 }); });
    await waitFor(() => expect(phase()).toBe("recording"));
    now += 120_000;
    await act(async () => { vi.advanceTimersByTime(300); });
    await waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
    expect(tracks.every((t) => t.stopped)).toBe(true);
  });

  it("a hidden page or an unmount drops the recording and releases the microphone, with no upload", async () => {
    const view = render(<Harness onText={() => {}} />);
    await act(async () => { fireEvent.pointerDown(button(), { button: 0, pointerId: 1 }); });
    await waitFor(() => expect(phase()).toBe("recording"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(tracks[0].stopped).toBe(true);
    await act(async () => { fireEvent.pointerDown(button(), { button: 0, pointerId: 1 }); });
    await waitFor(() => expect(phase()).toBe("recording"));
    view.unmount();
    expect(tracks[1].stopped).toBe(true);
    expect(uploads).toEqual([]);
  });

  it("a refused microphone is said in words", async () => {
    gum.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotAllowedError" }));
    render(<Harness onText={() => {}} />);
    await act(async () => { fireEvent.pointerDown(button(), { button: 0, pointerId: 1 }); });
    await waitFor(() => expect(screen.getByTestId("problem").textContent).toBe("mic_denied"));
  });
});

describe("in the conversation", () => {
  const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
  const sse = (reply: string) => new TextEncoder().encode(
    `id: 0\ndata: ${JSON.stringify({ event: "message.delta", run_id: "run_r1", delta: reply, seq: 0 })}\n\n` +
    `id: 1\ndata: ${JSON.stringify({ event: "run.completed", run_id: "run_r1", output: reply, completed: true, seq: 1 })}\n\n`);
  const languagePuts: unknown[] = [];
  function app(voice: { radio: { available: boolean }; settings?: unknown }) {
    const runs: string[] = [];
    languagePuts.length = 0;
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
      if (method === "PUT" && url.endsWith("/voice/language")) { const body = JSON.parse(String(init!.body)); languagePuts.push(body); return { settings: { stt: { provider: "local", language: body.language }, tts: { provider: "edge", voice: null }, language: body.language } }; }
      if (url.endsWith("/voice")) return { ...voice, call: { available: false, reason: "no_openai_key" }, client_direct: false };
      if (url.endsWith("/sessions")) return { session: { id: "api_s1" } };
      if (method === "POST" && url.endsWith("/runs")) { runs.push(JSON.parse(String(init!.body)).input); return { run: { id: "run_r1", status: "started", session_id: "api_s1" } }; }
      if (method === "GET" && url.includes("/runs/")) return { run: { id: "run_r1", status: "completed" } };
      return {};
    });
    const fetcher = async () => new Response(new ReadableStream({ start(c) { c.enqueue(sse("Combinado: separo os leads de ontem.")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    render(<Conversation bot={BOT} fetcher={fetcher as any} pollMs={0} />);
    return runs;
  }

  it("the transcription is sent as a normal turn, and the reply to it is spoken; the paid provider is said once", async () => {
    const runs = app({ radio: { available: true } });
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    await hold(1500);
    await waitFor(() => expect(runs).toEqual(["Separe os leads de ontem"]));
    expect(await screen.findByText("Separe os leads de ontem")).toBeTruthy();   // the person's bubble shows what was sent
    await waitFor(() => expect(spoken).toEqual(["Combinado: separo os leads de ontem."]));
    expect(screen.getByText("Transcrição por openai: esse provedor é pago e não entra no teto do LuveBot.")).toBeTruthy();
  });

  it("a typed turn is never spoken by itself; 'Ouvir' speaks a reply on request", async () => {
    const runs = app({ radio: { available: true } });
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Oi" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("Combinado: separo os leads de ontem.");
    await waitFor(() => expect(runs).toEqual(["Oi"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(spoken).toEqual([]);
    fireEvent.click(screen.getAllByRole("button", { name: /Mais ações|Ações/ })[0]);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ouvir/ }));
    await waitFor(() => expect(spoken).toEqual(["Combinado: separo os leads de ontem."]));
  });

  const SETTINGS = (language: string, raw: string | null) => ({ stt: { provider: "local", language: raw }, tts: { provider: "edge", voice: null }, language });
  const NO_LANG = "A transcrição deste Bot não tem idioma definido e pode sair em inglês.";
  it("VL-2: after the Radio is pressed once on a Bot whose raw stt.language is empty, a line under it proposes the screen's language; one click writes it, and nothing was written before", async () => {
    app({ radio: { available: true }, settings: SETTINGS("auto", "") });
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(NO_LANG)).toBeNull();                       // not before the first press
    await hold(1500);
    expect(await screen.findByText(NO_LANG)).toBeTruthy();
    expect(languagePuts).toEqual([]);                                     // a proposal, never a silent write
    fireEvent.click(screen.getByRole("button", { name: "Usar Português" }));
    expect(await screen.findByText("Idioma da voz salvo.")).toBeTruthy();
    expect(languagePuts).toEqual([{ language: "pt" }]);
    expect(screen.queryByText(NO_LANG)).toBeNull();
  });

  it("VL-2: while it transcribes the strip counts the seconds and, after 8 s, names the provider the status gave", async () => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    app({ radio: { available: true }, settings: { stt: { provider: "local", language: "pt" }, tts: { provider: "edge", voice: null }, language: "pt" } });
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    await hold(1500);
    expect(await screen.findByText(/^Transcrevendo… \d+ s$/)).toBeTruthy();
    expect(screen.queryByTestId("radio-slow")).toBeNull();
    now += 9000;
    expect((await screen.findByTestId("radio-slow")).textContent).toBe("Demorou mais que o normal (local). A primeira vez depois de reiniciar costuma ser a mais lenta.");
    release();
    await screen.findByText("Separe os leads de ontem");
  });

  it.each([
    ["a language the person set in Hermes (`other`)", { radio: { available: true }, settings: SETTINGS("other", "fr") }],
    ["pt already chosen", { radio: { available: true }, settings: SETTINGS("pt", "pt") }],
    ["a server older than VL-1 (no settings)", { radio: { available: true } }],
  ])("VL-2: no line about the language for %s", async (_name, voice) => {
    app(voice);
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    await hold(1500);
    await screen.findByText("Separe os leads de ontem");
    expect(screen.queryByText(NO_LANG)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Usar |^Use / })).toBeNull();
    expect(languagePuts).toEqual([]);
  });

  it("plain HTTP: the button says the microphone needs HTTPS, and a press asks for nothing", async () => {
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    app({ radio: { available: true } });
    const radio = await screen.findByRole("button", { name: "Rádio: segure para falar" });
    expect((radio as HTMLButtonElement).disabled).toBe(true);
    expect(radio.getAttribute("title")).toBe("O microfone precisa de HTTPS.");
    fireEvent.pointerDown(radio, { button: 0, pointerId: 1 });
    expect(gum).not.toHaveBeenCalled();
  });
});
