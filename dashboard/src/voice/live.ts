// dashboard/src/voice/live.ts
// The Call's transport (contract v0.7 section 3): one WebRTC session with the vendor's voice model (GPT-Live). The browser holds the media
// and the `oai-events` data channel; LuveBot only exchanges the SDP (through its own route, so the vendor key never reaches the page),
// counts the minutes and turns each delegation into a normal turn. The voice model has no tools: on `session.delegation.created` the page
// sends the recent transcript as a turn, and speaks the reply back with `session.commentary.append` (at most 1,400 characters each).
// Event names follow the Hermes desktop client at the commit the contract cites (apps/desktop/src/lib/voice-live.ts).
//
// Nothing is recorded: no MediaRecorder, no storage, the transcript lives in memory for the call (A-98). The microphone is asked in
// mic.ts only, from the Call button's click, and every track is stopped on close, loss, pagehide and unmount.

import { openMic } from "./mic";

export interface Fragment { speaker: "assistant" | "user"; text: string; startMs: number; endMs: number }

export interface LiveHandlers {
  /** The voice model asked for real work: `context` is the recent transcript, newest last (the event itself carries no text). */
  onDelegation: (delegationId: string, context: Fragment[]) => void;
  onTranscript: (fragment: Fragment) => void;
  /** The remote track is making sound (the Bot is speaking). */
  onSpeaking: (speaking: boolean) => void;
  /** The session is up (`session.started`). */
  onStarted: () => void;
  /** A vendor-side error that does not end the session. */
  onError: (message: string) => void;
  /** The session is over, whatever the way: `session.closed` (with the vendor's seconds), a lost connection, or our own close. */
  onClosed: (reason: string, vendorSeconds: number | null) => void;
}

interface ServerEvent {
  type: string;
  delta?: string;
  start_ms?: number;
  end_ms?: number;
  delegation?: { id?: string };
  error?: { code?: string | null; message?: string };
  usage?: { seconds?: number };
  reason?: string;
}

export const APPEND_LIMIT = 1_400;          // the vendor caps an append at 500 tokens: keep headroom
export const CONTEXT_MAX_CHARS = 6_000;     // what a delegation may carry to LuveBot (contract 3.3)
const CONTEXT_WINDOW_MS = 5 * 60_000;
const CONTEXT_MAX_FRAGMENTS = 80;
const CLOSE_TIMEOUT_MS = 15_000;
const ICE_GATHER_TIMEOUT_MS = 10_000;

/** A reply split into append-sized chunks on sentence boundaries. */
export function chunkForCommentary(text: string, limit = APPEND_LIMIT): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > limit) {
      if (current) { chunks.push(current); current = ""; }
      for (let i = 0; i < sentence.length; i += limit) chunks.push(sentence.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > limit) { chunks.push(current); current = sentence; } else current = candidate;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The transcript as one text, a line per run of the same speaker, cut at the START so the newest words stay (at most 6,000 characters). */
export function contextText(fragments: readonly Fragment[], max = CONTEXT_MAX_CHARS): string {
  const lines: string[] = [];
  let last: Fragment["speaker"] | null = null;
  for (const f of fragments) {
    if (!f.text) continue;
    if (f.speaker === last) lines[lines.length - 1] += f.text;
    else { lines.push(`${f.speaker}: ${f.text.trimStart()}`); last = f.speaker; }
  }
  const text = lines.join("\n").trim();
  return text.length > max ? text.slice(text.length - max) : text;
}

/** What the person said last, for the turn the delegation becomes in the conversation. */
export function lastSaid(fragments: readonly Fragment[]): string {
  let at = fragments.length;
  while (at > 0 && fragments[at - 1].speaker !== "user") at--;      // skip the Bot's words after it
  let from = at;
  while (from > 0 && fragments[from - 1].speaker === "user") from--;
  return fragments.slice(from, at).map((f) => f.text).join("").replace(/\s+/g, " ").trim();
}

async function iceGathered(connection: RTCPeerConnection): Promise<void> {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { connection.removeEventListener("icegatheringstatechange", on); resolve(); }, ICE_GATHER_TIMEOUT_MS);  // trickle is fine
    function on() {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", on);
      resolve();
    }
    connection.addEventListener("icegatheringstatechange", on);
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed") { window.clearTimeout(timer); reject(new Error("webrtc_failed")); }
    });
  });
}

export class LiveCall {
  private peer: RTCPeerConnection | null = null;
  private events: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private closeTimer: number | null = null;
  private probe: number | null = null;
  private analyserContext: AudioContext | null = null;
  private finished = false;
  private started = false;
  private counter = 0;
  private transcript: Fragment[] = [];
  private speaking = false;
  constructor(private readonly handlers: LiveHandlers) {}

  /** Opens the microphone (the caller is the Call button's click), makes the offer and hands its SDP to `exchange`, which returns the
   *  vendor's answer. Rejects when the microphone is refused or the exchange fails; whatever opened is closed first. */
  async start(exchange: (offerSdp: string) => Promise<string>): Promise<void> {
    if (this.peer) throw new Error("call_already_started");
    this.audio = new Audio();            // made inside the gesture: the phone lets the remote voice play
    this.audio.autoplay = true;
    try {
      this.mic = await openMic({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
      const connection = new RTCPeerConnection();
      this.peer = connection;
      connection.addEventListener("track", (event) => {
        const stream = new MediaStream([event.track]);
        if (this.audio) { this.audio.srcObject = stream; void Promise.resolve(this.audio.play?.()).catch(() => undefined); }
        this.listen(stream);
      });
      connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed" || connection.connectionState === "disconnected") this.finish("connection_lost", null);
      });
      for (const track of this.mic.getAudioTracks()) connection.addTrack(track, this.mic);
      const channel = connection.createDataChannel("oai-events");     // before the offer, so its m-line is negotiated
      this.events = channel;
      channel.addEventListener("message", (e) => this.handle(String((e as MessageEvent).data)));
      channel.addEventListener("close", () => { if (!this.finished) this.finish("connection_lost", null); });
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      await iceGathered(connection);
      const sdp = connection.localDescription?.sdp;
      if (!sdp) throw new Error("missing_offer");
      const answer = await exchange(sdp);
      if (this.finished) return;                                       // hung up while the answer was on its way
      await connection.setRemoteDescription({ type: "answer", sdp: answer });
    } catch (e) {
      this.teardown();
      throw e;
    }
  }

  get live(): boolean { return this.started && !this.finished; }

  private send(event: Record<string, unknown>): boolean {
    if (!this.events || this.events.readyState !== "open") return false;
    this.events.send(JSON.stringify(event));
    return true;
  }

  private id(prefix: string) { this.counter += 1; return `${prefix}_${this.counter}`; }

  private contextWindow(): Fragment[] {
    const last = this.transcript[this.transcript.length - 1];
    if (!last) return [];
    const floor = last.endMs - CONTEXT_WINDOW_MS;
    return this.transcript.filter((f) => f.endMs >= floor).slice(-CONTEXT_MAX_FRAGMENTS);
  }

  private handle(raw: string): void {
    let event: ServerEvent;
    try { event = JSON.parse(raw) as ServerEvent; } catch { return; }
    switch (event.type) {
      case "session.started":
        this.started = true;
        this.handlers.onStarted();
        return;
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        const fragment: Fragment = { speaker: event.type === "session.input_transcript.delta" ? "user" : "assistant",
          text: typeof event.delta === "string" ? event.delta : "", startMs: event.start_ms ?? 0, endMs: event.end_ms ?? 0 };
        this.transcript.push(fragment);
        if (this.transcript.length > 2_000) this.transcript.splice(0, this.transcript.length - 1_500);   // memory only, bounded
        this.handlers.onTranscript(fragment);
        return;
      }
      case "session.delegation.created": {
        const id = event.delegation?.id;
        if (typeof id === "string" && id) this.handlers.onDelegation(id, this.contextWindow());
        return;
      }
      case "error":
        if (event.error?.code === "context_injection_incomplete") return;   // a late append after our own close: expected noise
        this.handlers.onError(typeof event.error?.message === "string" ? event.error.message : "error");
        return;
      case "session.closed":
        this.finish(typeof event.reason === "string" ? event.reason : "closed", typeof event.usage?.seconds === "number" ? event.usage.seconds : null);
        return;
      default:
        return;
    }
  }

  /** A result the voice should say aloud (it paraphrases it): in chunks of at most 1,400 characters. */
  speak(delegationId: string, text: string): void {
    for (const chunk of chunkForCommentary(text)) {
      this.send({ type: "session.commentary.append", content: chunk, delegation_id: delegationId, event_id: this.id("say") });
    }
  }

  setMuted(muted: boolean): void {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
    this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute", event_id: this.id(muted ? "mute" : "unmute") });
  }

  /** Graceful hang-up: asks the vendor to close and waits for `session.closed` (and its seconds), at most 15 s. */
  close(): void {
    if (this.finished) return;
    if (!this.send({ type: "session.close" })) { this.finish("close_requested", null); return; }
    this.closeTimer = window.setTimeout(() => this.finish("close_requested", null), CLOSE_TIMEOUT_MS);
  }

  /** Immediate hang-up (page hidden for good, unmount): every track stopped and the peer closed NOW. */
  hangUp(): void { this.finish("hangup", null); }

  private listen(stream: MediaStream): void {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      this.analyserContext = context;
      const buffer = new Uint8Array(analyser.frequencyBinCount);
      let quiet = 0;
      this.probe = window.setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128));
        quiet = peak > 6 ? 0 : quiet + 1;
        const speaking = peak > 6 || quiet < 4;
        if (speaking !== this.speaking) { this.speaking = speaking; this.handlers.onSpeaking(speaking); }
      }, 100);
    } catch { /* no analyser: no speaking indicator, the call works */ }
  }

  private teardown(): void {
    if (this.closeTimer !== null) { window.clearTimeout(this.closeTimer); this.closeTimer = null; }
    if (this.probe !== null) { window.clearInterval(this.probe); this.probe = null; }
    void this.analyserContext?.close?.().catch?.(() => undefined);
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    try { this.events?.close(); } catch { /* already closed */ }
    try { this.peer?.close(); } catch { /* already closed */ }
    if (this.audio) { try { this.audio.srcObject = null; this.audio.pause?.(); } catch { /* nothing playing */ } }
  }

  private finish(reason: string, vendorSeconds: number | null): void {
    if (this.finished) return;
    this.finished = true;
    this.teardown();
    this.handlers.onClosed(reason, vendorSeconds);
  }
}
