// tests/unit/voice/call.test.tsx
// Contract v0.7 sections 3 and 4: the Call. The browser holds the media (a fake WebRTC peer and data channel stand in for the vendor); LuveBot
// exchanges the SDP, counts the time, turns each delegation into a normal turn of the conversation and speaks the reply back. The microphone
// opens only on the Call button's click; every track is stopped on end, stop, 15 minutes, loss, pagehide and unmount; nothing is recorded;
// the voice approves nothing.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { chunkForCommentary, contextText, lastSaid, type Fragment } from "@/voice/live";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const BOT = { name: "vendas", label: "Vendas" };

// ---- the browser's WebRTC and microphone, as doubles ----
class Channel {
  readyState = "open"; sent: any[] = []; closed = false; private on: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, fn: (e: any) => void) { (this.on[type] ??= []).push(fn); }
  send(m: string) { this.sent.push(JSON.parse(m)); }
  close() { this.closed = true; this.readyState = "closed"; }
  emit(event: object) { (this.on.message ?? []).forEach((f) => f({ data: JSON.stringify(event) })); }
  kinds() { return this.sent.map((e) => e.type); }
}
class Peer {
  static last: Peer | null = null;
  channel = new Channel(); channelName = ""; iceGatheringState = "complete"; connectionState = "new"; localDescription = { sdp: "offer-sdp" };
  remote: any = null; closed = false; tracks: any[] = []; private on: Record<string, Array<(e?: any) => void>> = {};
  constructor() { Peer.last = this; }
  addEventListener(type: string, fn: (e?: any) => void) { (this.on[type] ??= []).push(fn); }
  removeEventListener() {}
  createDataChannel(name: string) { this.channelName = name; return this.channel; }
  addTrack(track: any) { this.tracks.push(track); }
  async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
  async setLocalDescription() {}
  async setRemoteDescription(d: any) { this.remote = d; }
  close() { this.closed = true; }
  drop() { this.connectionState = "failed"; (this.on.connectionstatechange ?? []).forEach((f) => f()); }
}
let tracks: Array<{ enabled: boolean; stopped: boolean; stop: () => void }>;
const gum = vi.fn();

type Calls = { posts: Array<{ url: string; body: any; csrf: string | null }>; delegations: any[] };
type World = { start?: () => unknown; beat?: () => unknown; end?: (body: any) => unknown; voice?: any; delegate?: (init: RequestInit) => Response };
let calls: Calls, world: World;

const status = (over: any = {}) => ({ radio: { available: true, reason: null }, call: { available: true, reason: null, cents_per_minute: 5, max_seconds: 900, max_delegations: 6, ...over }, client_direct: true });
const sse = (...frames: object[]) => new Response(new ReadableStream({ start(c) { frames.forEach((f, i) => c.enqueue(new TextEncoder().encode(`id: ${i + 1}\ndata: ${JSON.stringify(f)}\n\n`))); c.close(); } }),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const reply = (text: string) => sse({ event: "message.delta", delta: text }, { event: "run.completed", run_id: "run_d1", output: text });
const fetcher = async (url: string, init?: RequestInit) => {
  if (url.endsWith("/delegations")) { calls.delegations.push(JSON.parse(String(init?.body))); return world.delegate ? world.delegate(init!) : reply("Abri a página de vendas."); }
  return new Response(new ReadableStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
};

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  calls = { posts: [], delegations: [] }; world = {}; tracks = []; Peer.last = null;
  gum.mockReset();
  gum.mockImplementation(async () => {
    const t = { enabled: true, stopped: false, stop() { t.stopped = true; } };
    tracks.push(t);
    return { getAudioTracks: () => [t], getTracks: () => [t] };
  });
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: gum }, configurable: true });
  (globalThis as any).RTCPeerConnection = Peer;
  (globalThis as any).MediaStream = class { constructor(public t?: any[]) {} };
  (globalThis as any).Audio = class { autoplay = false; srcObject: any = null; play() { return Promise.resolve(); } pause() {} };
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (method === "GET" && url.endsWith("/bots/vendas/voice")) return world.voice ?? status();
    if (method === "POST" && url.endsWith("/sessions")) return { session: { id: "s1" } };
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (method === "POST" && url.includes("/voice/calls")) calls.posts.push({ url, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (method === "POST" && url.endsWith("/voice/calls")) return world.start ? world.start() : { call_id: "call_1", sdp: "answer-sdp", max_seconds: 900, max_delegations: 6, heartbeat_seconds: 30 };
    if (method === "POST" && url.endsWith("/heartbeat")) return world.beat ? world.beat() : { stop: false, reason: null, remaining_seconds: 800 };
    if (method === "POST" && url.endsWith("/end")) return world.end ? world.end(body) : { seconds: 70, delegations: calls.delegations.length, cents: 10 };
    return {};
  });
});
afterEach(() => { setCustomFetchJSON(null); vi.useRealTimers(); delete (globalThis as any).RTCPeerConnection; });

const open = async () => {
  render(<Conversation bot={BOT} fetcher={fetcher} pollMs={10} />);
  await waitFor(() => expect((screen.getByTestId("call-button") as HTMLButtonElement).disabled).toBe(false));
};
const press = async () => {   // the click on the phone (and on the notice's "Ligar mesmo assim" the first time)
  await act(async () => { fireEvent.click(screen.getByTestId("call-button")); });
  const go = screen.queryByRole("button", { name: "Ligar mesmo assim" });
  if (go) await act(async () => { fireEvent.click(go); });
};
const ring = async () => { await press(); await waitFor(() => expect(Peer.last?.remote).toBeTruthy()); };
const channel = () => Peer.last!.channel;
const live = async () => { await ring(); await act(async () => { channel().emit({ type: "session.started" }); }); };
const tick = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
const posted = (suffix: string) => calls.posts.filter((p) => p.url.endsWith(suffix));

describe("the microphone and the cost notice", () => {
  it("nothing on mount; the first call shows the cost notice first, 'Agora não' asks for nothing, 'Ligar mesmo assim' is the click that opens the microphone", async () => {
    await open();
    expect(gum).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId("call-button")); });
    const notice = screen.getByTestId("call-notice");
    expect(notice.textContent).toContain("US$ 0,05 por minuto");
    expect(notice.textContent).toContain("linha “voz” do orçamento");
    expect(notice.textContent).toContain("até US$ 0,75 do teto");
    expect(notice.textContent).toContain("no máximo 15 min");
    expect(gum).not.toHaveBeenCalled();
    fireEvent.click(within(notice).getByRole("button", { name: "Agora não" }));
    expect(screen.queryByTestId("call-notice")).toBeNull();
    expect(gum).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByTestId("call-button")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ligar mesmo assim" })); });
    await waitFor(() => expect(gum).toHaveBeenCalledTimes(1));
    expect(gum.mock.calls[0][0]).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  });

  it("it is the person's call button: with the notice already read, the next click starts at once (no other trigger anywhere)", async () => {
    await open();
    await ring();
    expect(gum).toHaveBeenCalledTimes(1);
  });
});

describe("a call, from the SDP to the receipt", () => {
  it("opens 'oai-events', sends the offer through LuveBot's route with the conversation's session and the CSRF, sets the vendor's answer, and goes live on session.started", async () => {
    await open();
    await ring();
    expect(Peer.last!.channelName).toBe("oai-events");
    expect(posted("/voice/calls")).toEqual([{ url: expect.stringMatching(/\/bots\/vendas\/voice\/calls$/), body: { sdp: "offer-sdp", session_id: "s1" }, csrf: "csrf-1" }]);
    expect(Peer.last!.remote).toEqual({ type: "answer", sdp: "answer-sdp" });
    expect(screen.getByTestId("call-screen")).toBeTruthy();
    expect(screen.getByTestId("call-timer").textContent).toBe("Conectando…");
    await act(async () => { channel().emit({ type: "session.started" }); });
    expect(screen.getByTestId("call-timer").textContent).toContain("00:00");
    expect(screen.getByTestId("call-timer").textContent).toContain("microfone ligado");
    expect(screen.getByText("A voz não aprova nada: aprove na tela.")).toBeTruthy();
  });

  it("the timer runs, captions are separate for 'Você' and 'Bot', and a new line starts when the other speaks", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await live();
    await tick(5000);
    expect(screen.getByTestId("call-timer").textContent).toContain("00:05");
    const say = (type: string, delta: string, end = 1000) => act(async () => { channel().emit({ type, delta, start_ms: 0, end_ms: end }); });
    await say("session.input_transcript.delta", "Oi,");
    await say("session.input_transcript.delta", " tudo bem?");
    await say("session.output_transcript.delta", "Tudo ótimo!");
    expect(screen.getByTestId("caption-you").textContent).toBe("Oi, tudo bem?");
    expect(screen.getByTestId("caption-bot").textContent).toBe("Tudo ótimo!");
    await say("session.input_transcript.delta", "Abre a página.");
    expect(screen.getByTestId("caption-you").textContent).toBe("Abre a página.");        // the Bot spoke in between: a new line
    await say("session.input_transcript.delta", "x".repeat(400));
    expect(screen.getByTestId("caption-you").textContent!.length).toBeLessThanOrEqual(281);
  });

  it("mute turns the track off AND tells the vendor; unmute turns both back on", async () => {
    await open();
    await live();
    const mute = screen.getByRole("button", { name: "Mudo" });
    fireEvent.click(mute);
    expect(tracks[0].enabled).toBe(false);
    expect(channel().kinds()).toContain("session.input_audio.mute");
    expect(screen.getByRole("button", { name: "Ligar o microfone" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("call-timer").textContent).toContain("microfone mudo");
    fireEvent.click(screen.getByRole("button", { name: "Ligar o microfone" }));
    expect(tracks[0].enabled).toBe(true);
    expect(channel().kinds()).toContain("session.input_audio.unmute");
  });

  it("Encerrar: asks the vendor to close, and ONLY when it answers session.closed are the tracks stopped, the vendor's seconds sent, and the receipt put in the conversation", async () => {
    await open();
    await live();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Encerrar" })); });
    expect(channel().kinds()).toContain("session.close");
    await act(async () => { channel().emit({ type: "session.closed", reason: "client_close", usage: { seconds: 70 } }); });
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    expect(posted("/end")[0].body).toEqual({ vendor_seconds: 70, reason: "hangup" });
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(Peer.last!.closed).toBe(true);
    const receipt = await screen.findByTestId("call-receipt");
    expect(receipt.textContent).toMatch(/^Chamada de 1 min 10 s · sem tarefas$/);
    expect(screen.queryByTestId("call-screen")).toBeNull();
  });
});

describe("the tasks the voice hands over (delegations)", () => {
  it("become a normal turn of the conversation: the transcript goes as context, the turn shows what was said and the Bot's reply, which is spoken back in chunks", async () => {
    await open();
    await live();
    await act(async () => {
      channel().emit({ type: "session.input_transcript.delta", delta: "Abre a página de vendas", start_ms: 0, end_ms: 1000 });
      channel().emit({ type: "session.output_transcript.delta", delta: "Claro, já vejo.", start_ms: 1000, end_ms: 2000 });
      channel().emit({ type: "session.delegation.created", delegation: { id: "d1", type: "x", target: "y" } });
    });
    await waitFor(() => expect(calls.delegations).toHaveLength(1));
    expect(calls.delegations[0]).toEqual({ delegation_id: "d1", context: "user: Abre a página de vendas\nassistant: Claro, já vejo." });
    await screen.findByText("Abri a página de vendas.", { selector: "[data-turn] *" });             // the reply is a turn in the conversation
    expect(document.querySelector("[data-turn]")!.textContent).toContain("Abre a página de vendas");  // and the turn says what was asked
    await waitFor(() => expect(channel().kinds()).toContain("session.commentary.append"));
    expect(channel().sent.filter((e) => e.type === "session.commentary.append")).toEqual([
      { type: "session.commentary.append", content: "Abri a página de vendas.", delegation_id: "d1", event_id: expect.any(String) }]);
  });

  it("a long reply goes in appends of at most 1,400 characters", async () => {
    world.delegate = () => reply(("Frase de teste um pouco longa. ").repeat(120));
    await open();
    await live();
    await act(async () => { channel().emit({ type: "session.delegation.created", delegation: { id: "d2" } }); });
    await waitFor(() => expect(channel().sent.filter((e) => e.type === "session.commentary.append").length).toBeGreaterThan(1));
    const appends = channel().sent.filter((e) => e.type === "session.commentary.append");
    expect(appends.every((e) => e.content.length <= 1400 && e.delegation_id === "d2")).toBe(true);
  });

  it("a refused task (limit, pause, cap) is said in words on the call screen and the voice is told it could not be done", async () => {
    world.delegate = () => { throw new ApiError({ code: "delegation_limit", message: "x", status: 409 }); };
    // the stream's own refusal path: a non-OK answer
    world.delegate = () => new Response(JSON.stringify({ error: { code: "delegation_limit", message: "English" } }), { status: 409 });
    await open();
    await live();
    await act(async () => { channel().emit({ type: "session.delegation.created", delegation: { id: "d3" } }); });
    await waitFor(() => expect(channel().kinds()).toContain("session.commentary.append"));
    expect(channel().sent.find((e) => e.type === "session.commentary.append").content).toBe("Não consegui concluir esse pedido.");
  });

  it("the voice never approves: an approval a task raises is only a card on the screen; no voice code calls an approval route", async () => {
    world.delegate = () => sse({ event: "approval.request", run_id: "run_d4", request_id: "req_1", command: "git push", description: "push", choices: ["once", "deny"], luvebot_digest: "dg-1" });
    await open();
    await live();
    await act(async () => { channel().emit({ type: "session.delegation.created", delegation: { id: "d4" } }); });
    await screen.findByText("Permitir uma vez");
    await act(async () => { channel().emit({ type: "session.input_transcript.delta", delta: "sim, aprova", start_ms: 0, end_ms: 1 }); });
    expect(calls.posts.some((p) => p.url.includes("/approval"))).toBe(false);
    expect(screen.getByText("Permitir uma vez")).toBeTruthy();                                       // still waiting for a human click
  });
});

describe("when the call must end", () => {
  it("every 30 s a heartbeat; the server's 'stop' (budget, pause) hangs up through the vendor and ends with reason stop", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await live();
    await tick(30_000);
    await waitFor(() => expect(posted("/heartbeat")).toHaveLength(1));
    world.beat = () => ({ stop: true, reason: "budget", remaining_seconds: 0 });
    await tick(30_000);
    await waitFor(() => expect(channel().kinds()).toContain("session.close"));
    await act(async () => { channel().emit({ type: "session.closed", reason: "client_close", usage: { seconds: 61 } }); });
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    expect(posted("/end")[0].body).toEqual({ vendor_seconds: 61, reason: "stop" });
  });

  it("at the 15-minute cap the page closes the call itself (the media is the browser's), reason max_time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await live();
    await tick(900_000);
    await waitFor(() => expect(channel().kinds()).toContain("session.close"));
    await act(async () => { channel().emit({ type: "session.closed", usage: { seconds: 900 } }); });
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    expect(posted("/end")[0].body.reason).toBe("max_time");
  });

  it("a vendor that never answers session.closed does not keep the microphone: after 15 s everything is torn down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await live();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Encerrar" })); });
    expect(tracks[0].stopped).toBe(false);
    await tick(15_100);
    expect(tracks.every((t) => t.stopped)).toBe(true);
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    expect(posted("/end")[0].body).toEqual({ vendor_seconds: null, reason: "hangup" });
  });

  it("a lost connection ends the call (tracks stopped, reason error)", async () => {
    await open();
    await live();
    await act(async () => { Peer.last!.drop(); });
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    expect(posted("/end")[0].body.reason).toBe("error");
    expect(tracks.every((t) => t.stopped)).toBe(true);
  });

  it("pagehide, and leaving the screen: tracks stopped and the peer closed AT ONCE (no waiting for the vendor), and the server is told", async () => {
    await open();
    await live();
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(tracks.every((t) => t.stopped)).toBe(true);
    expect(Peer.last!.closed).toBe(true);
    await waitFor(() => expect(posted("/end")).toHaveLength(1));
    cleanup();
    await open();
    await live();
    cleanup();                                                                                   // the conversation goes away mid-call
    expect(tracks[tracks.length - 1].stopped).toBe(true);
    expect(Peer.last!.closed).toBe(true);
  });

  it("hanging up while it still connects leaves nothing open: the call the server started in the meantime is ended", async () => {
    let release!: (v: unknown) => void;
    world.start = () => new Promise((r) => { release = r; });
    await open();
    await press();
    await waitFor(() => expect(posted("/voice/calls")).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Encerrar" })); });
    expect(tracks.every((t) => t.stopped)).toBe(true);
    await act(async () => { release({ call_id: "call_late", sdp: "answer-sdp", max_seconds: 900, max_delegations: 6, heartbeat_seconds: 30 }); });
    await waitFor(() => expect(posted("/call_late/end")).toHaveLength(1));
    expect(posted("/call_late/end")[0].body).toEqual({ vendor_seconds: null, reason: "hangup" });
  });
});

describe("minimized, and what the screen says when it cannot start", () => {
  it("Minimizar: a pill 'Em chamada com Vendas · 00:05' at the top, 'Abrir a chamada' brings the screen back, Encerrar works from the pill", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open();
    await live();
    await tick(5000);
    fireEvent.click(screen.getByRole("button", { name: "Minimizar" }));
    expect(screen.queryByTestId("call-screen")).toBeNull();
    const pill = screen.getByTestId("call-pill");
    expect(pill.textContent).toContain("Em chamada com Vendas · 00:05");
    fireEvent.click(within(pill).getByRole("button", { name: "Abrir a chamada" }));
    expect(screen.getByTestId("call-screen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Minimizar" }));
    await act(async () => { fireEvent.click(within(screen.getByTestId("call-pill")).getByRole("button", { name: "Encerrar" })); });
    expect(channel().kinds()).toContain("session.close");
  });

  it("off, with the reason, when the Bot's voice status does not allow a call (no key, no audio, paused, cap) or the page has no HTTPS", async () => {
    for (const [why, said] of [["no_openai_key", "A chamada precisa da chave da OpenAI neste Bot."], ["hermes_audio_missing", "Este Hermes não tem voz em tempo real."],
      ["bot_paused", "Este Bot está pausado."], ["budget", "O teto de gasto foi atingido."]] as const) {
      world.voice = status({ available: false, reason: why });
      render(<Conversation bot={BOT} fetcher={fetcher} />);
      await waitFor(() => expect((screen.getByTestId("call-button") as HTMLButtonElement).title).toBe(said));
      expect((screen.getByTestId("call-button") as HTMLButtonElement).disabled).toBe(true);
      cleanup();
    }
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    world.voice = status();
    render(<Conversation bot={BOT} fetcher={fetcher} />);
    await waitFor(() => expect((screen.getByTestId("call-button") as HTMLButtonElement).title).toBe("O microfone precisa de HTTPS."));
    expect(gum).not.toHaveBeenCalled();
  });

  it("start failures in words, nothing left open: microphone refused (no call is even asked for), 409 call_in_progress, 502 voice_unavailable", async () => {
    gum.mockImplementationOnce(async () => { throw Object.assign(new Error("x"), { name: "NotAllowedError" }); });
    await open();
    await press();
    await screen.findByText("Permita o microfone no navegador para ligar a chamada.");
    expect(posted("/voice/calls")).toHaveLength(0);
    cleanup();
    for (const [code, status_, said] of [["call_in_progress", 409, "Já existe uma chamada aberta com este Bot."], ["voice_unavailable", 502, "A voz em tempo real não respondeu agora."]] as const) {
      world.start = () => { throw new ApiError({ code, message: "x", status: status_ }); };
      await open();
      await press();
      await screen.findByText(new RegExp(said));
      expect(tracks.every((t) => t.stopped)).toBe(true);
      expect(screen.queryByTestId("call-screen")).toBeNull();
      cleanup();
    }
  });
});

describe("the pure parts", () => {
  const f = (speaker: Fragment["speaker"], text: string, end = 1): Fragment => ({ speaker, text, startMs: 0, endMs: end });
  it("chunks on sentence boundaries, never over the limit; an empty reply makes none", () => {
    expect(chunkForCommentary("")).toEqual([]);
    expect(chunkForCommentary("Oi. Tudo bem?")).toEqual(["Oi. Tudo bem?"]);
    const chunks = chunkForCommentary("Uma frase curta. ".repeat(300), 1400);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1400)).toBe(true);
    expect(chunkForCommentary("x".repeat(3000), 1400).map((c) => c.length)).toEqual([1400, 1400, 200]);
  });

  it("the context keeps the newest words (cut at the start) and what the person said last", () => {
    expect(contextText([f("user", "Oi"), f("user", " lá"), f("assistant", "Olá!")])).toBe("user: Oi lá\nassistant: Olá!");
    const long = contextText([f("user", "a".repeat(5000)), f("assistant", "b".repeat(5000))]);
    expect(long.length).toBe(6000);
    expect(long.endsWith("b".repeat(5000))).toBe(true);
    expect(lastSaid([f("user", "Abre"), f("user", " a página"), f("assistant", "Ok")])).toBe("Abre a página");
    expect(lastSaid([f("assistant", "Oi")])).toBe("");
  });
});

describe("in English", () => {
  it("the button, the notice and the receipt", async () => {
    setLuveLocale("en");
    await open();
    await act(async () => { fireEvent.click(screen.getByTestId("call-button")); });
    const go = screen.queryByRole("button", { name: "Call anyway" });
    if (go) { expect(screen.getByTestId("call-notice").textContent).toContain("US$ 0.05 per minute"); await act(async () => { fireEvent.click(go); }); }
    await waitFor(() => expect(Peer.last?.remote).toBeTruthy());
    await act(async () => { channel().emit({ type: "session.started" }); });
    expect(screen.getByText("The voice approves nothing: approve on screen.")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "End" })); });
    await act(async () => { channel().emit({ type: "session.closed", usage: { seconds: 70 } }); });
    expect((await screen.findByTestId("call-receipt")).textContent).toMatch(/^Call of .* · no tasks$/);
  });
});
