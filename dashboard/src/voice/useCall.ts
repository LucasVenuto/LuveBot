// dashboard/src/voice/useCall.ts
// The Call's state (contract v0.7 section 3 and 4): one call at a time per conversation. `begin` is the Call button's click: it opens the
// microphone, makes the WebRTC offer, and LuveBot's route (not the browser) exchanges the SDP with the vendor. While it is live the page
// sends a heartbeat every 30 s (the server says when to hang up: time, budget, pause), turns each delegation of the voice model into a
// normal turn of the conversation and speaks the reply back, and counts the time on screen. The call ends with the person's Encerrar,
// the server's stop, 15 minutes, a lost connection, `pagehide` or the screen going away: every track stopped and the peer closed.
// Nothing is recorded or stored: captions are in memory for the call (A-98), the receipt is the server's {seconds, delegations, cents}.
// The voice never approves anything (invariant 6): a delegation is a turn, and an approval it raises is decided on screen by a click.

import React from "react";
import { ApiError, startCall, heartbeatCall, endCall, callDelegationUrl, getCsrf } from "../api/client";
import type { CallReceipt } from "../api/types";
import { openStream, type Frame } from "../lib/stream";
import { LiveCall, contextText, lastSaid, type Fragment } from "./live";

export type CallPhase = "idle" | "connecting" | "live" | "ending";
export type CallProblem = "mic_denied" | "mic_missing" | "mic_error" | "connection" | "lost" | ApiError;
export type Captions = { you: string; bot: string };

const CAPTION_CHARS = 280;
const CONNECT_TIMEOUT_MS = 30_000;
type EndReason = "hangup" | "max_time" | "stop" | "error";

/** What the conversation provides: its session, and a way to run a streamed turn as one of its turns (resolving with the reply text). */
export interface CallHost {
  bot: string;
  /** The conversation's session id (made now if the conversation has none yet): the call belongs to it (contract 3.2). */
  ensureSession: () => Promise<string>;
  /** Runs `open` as a turn of the conversation and resolves with the Bot's reply, or the error. `said` is what the person said. */
  follow: (said: string, open: (onFrame: (frame: Frame) => void, signal: AbortSignal) => Promise<unknown>) => Promise<{ text: string | null; error: unknown }>;
  onReceipt: (receipt: CallReceipt) => void;
  /** Said to the voice model when a task could not be done (it paraphrases it aloud). */
  failureSpeech: string;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

const tail = (text: string) => (text.length > CAPTION_CHARS ? "…" + text.slice(text.length - CAPTION_CHARS) : text);

export function useCall(host: CallHost) {
  const [phase, setPhase] = React.useState<CallPhase>("idle");
  const [seconds, setSeconds] = React.useState(0);
  const [muted, setMuted] = React.useState(false);
  const [speaking, setSpeaking] = React.useState(false);
  const [captions, setCaptions] = React.useState<Captions>({ you: "", bot: "" });
  const [problem, setProblem] = React.useState<CallProblem | null>(null);
  const [minimized, setMinimized] = React.useState(false);
  const hostRef = React.useRef(host);
  hostRef.current = host;
  const live = React.useRef<LiveCall | null>(null);
  const callId = React.useRef<string | null>(null);
  const limits = React.useRef({ maxSeconds: 900, heartbeat: 30 });
  const startedAt = React.useRef(0);
  const reason = React.useRef<EndReason | null>(null);
  const timers = React.useRef<number[]>([]);
  const lastSpeaker = React.useRef<Fragment["speaker"] | null>(null);
  const alive = React.useRef(true);

  const clearTimers = () => { timers.current.forEach((id) => window.clearInterval(id)); timers.current = []; };

  /** The call is over (the vendor closed, the connection dropped, or we hung up): tell the server, show the receipt, go back to idle. */
  const closed = React.useCallback(async (why: string, vendorSeconds: number | null) => {
    clearTimers();
    const id = callId.current;
    callId.current = null;
    live.current = null;
    const end: EndReason = reason.current ?? (why === "connection_lost" ? "error" : "hangup");
    reason.current = null;
    if (alive.current) { setPhase("ending"); setSpeaking(false); }
    try {
      if (id) {
        const receipt = await endCall(hostRef.current.bot, id, { vendor_seconds: vendorSeconds, reason: end });
        if (alive.current) hostRef.current.onReceipt(receipt);
      }
    } catch { /* the server's sweeper closes and bills a call it never heard end */ }
    if (alive.current) { setPhase("idle"); setMinimized(false); setMuted(false); setSeconds(0); }
  }, []);

  /** Graceful hang-up: asks the vendor to close and waits for its `session.closed` (with its seconds), at most 15 s. */
  const hangUp = React.useCallback((why: EndReason = "hangup") => {
    const call = live.current;
    if (!call) return;
    reason.current ??= why;
    setPhase("ending");
    if (call.live) call.close();       // a live session is closed through the vendor (its own seconds come back)
    else call.hangUp();                // still connecting: there is no vendor session to ask, everything is torn down now
  }, []);

  const delegate = React.useCallback(async (delegationId: string, context: Fragment[]) => {
    const h = hostRef.current, call = live.current, id = callId.current;
    if (!call || !id) return;
    const said = lastSaid(context), text = contextText(context);
    const result = await h.follow(said, async (onFrame, signal) => {
      await openStream(callDelegationUrl(h.bot, id), onFrame, {
        method: "POST", body: JSON.stringify({ delegation_id: delegationId, context: text }),
        headers: { "Content-Type": "application/json", "X-LuveBot-CSRF": await getCsrf() }, signal, fetcher: h.fetcher,
      });
    });
    if (live.current !== call || !call.live) return;           // the call ended while Hermes worked: nobody to tell
    if (result.error instanceof ApiError) setProblem(result.error);
    call.speak(delegationId, result.text ?? h.failureSpeech);
  }, []);

  const begin = React.useCallback(async () => {
    if (live.current || phase !== "idle") return;
    setProblem(null); setCaptions({ you: "", bot: "" }); setMuted(false); setSeconds(0); setMinimized(false); setPhase("connecting");
    lastSpeaker.current = null; reason.current = null;
    const call = new LiveCall({
      onStarted: () => {
        if (!alive.current || live.current !== call) return;
        startedAt.current = Date.now();
        setPhase("live");
        const tick = window.setInterval(() => {
          const s = Math.floor((Date.now() - startedAt.current) / 1000);
          setSeconds(s);
          if (s >= limits.current.maxSeconds) hangUp("max_time");   // the cap: the vendor's media is the browser's, so the page closes it
        }, 1000);
        const beat = window.setInterval(async () => {
          const id = callId.current;
          if (!id) return;
          try {
            const b = await heartbeatCall(hostRef.current.bot, id);
            if (b.stop) hangUp(b.reason === "max_time" ? "max_time" : "stop");
          } catch { /* the next beat asks again; the server closes a call that stops beating */ }
        }, limits.current.heartbeat * 1000);
        timers.current.push(tick, beat);
      },
      onTranscript: (f) => {
        if (!alive.current) return;
        const key = f.speaker === "user" ? "you" : "bot";
        const fresh = lastSpeaker.current !== f.speaker;      // the other one spoke in between: this is a new line, not a longer one
        lastSpeaker.current = f.speaker;
        setCaptions((c) => ({ ...c, [key]: tail((fresh ? "" : c[key]) + f.text) }));
      },
      onSpeaking: (s) => { if (alive.current) setSpeaking(s); },
      onDelegation: (id, ctx) => { void delegate(id, ctx); },
      onError: () => { /* the vendor's words never reach the screen; a fatal one arrives as session.closed or a lost connection */ },
      onClosed: (why, vendorSeconds) => { void closed(why, vendorSeconds); },
    });
    live.current = call;
    const give = window.setTimeout(() => { if (live.current === call && !call.live) { reason.current ??= "error"; setProblem("connection"); call.hangUp(); } }, CONNECT_TIMEOUT_MS);
    try {
      await call.start(async (offer) => {
        const session = await hostRef.current.ensureSession();
        const started = await startCall(hostRef.current.bot, { sdp: offer, session_id: session });
        if (live.current !== call) {      // hung up while the server was starting it: close what it just opened, nothing is left running
          void endCall(hostRef.current.bot, started.call_id, { vendor_seconds: null, reason: "hangup" }).catch(() => undefined);
          return started.sdp;
        }
        callId.current = started.call_id;
        limits.current = { maxSeconds: started.max_seconds, heartbeat: started.heartbeat_seconds };
        return started.sdp;
      });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      reason.current ??= "error";
      if (alive.current) {
        setProblem(e instanceof ApiError ? e : name === "NotAllowedError" || name === "SecurityError" ? "mic_denied" : name === "NotFoundError" ? "mic_missing" : name === "NotReadableError" || name === "AbortError" ? "mic_error" : "connection");
      }
      if (live.current === call) { live.current = null; clearTimers(); const id = callId.current; callId.current = null; if (id) void endCall(hostRef.current.bot, id, { vendor_seconds: null, reason: "error" }).catch(() => undefined); }
      if (alive.current) { setPhase("idle"); setMinimized(false); }
    } finally {
      window.clearTimeout(give);
    }
  }, [phase, hangUp, delegate, closed]);

  const toggleMute = React.useCallback(() => {
    const call = live.current;
    if (!call) return;
    setMuted((m) => { call.setMuted(!m); return !m; });
  }, []);

  // Leaving the page or the screen: tracks stopped and peer closed at once (the server's sweeper bills what it never heard end)
  React.useEffect(() => {
    alive.current = true;
    const gone = () => { const call = live.current; if (call) { reason.current ??= "hangup"; call.hangUp(); } };
    window.addEventListener("pagehide", gone);
    return () => { alive.current = false; window.removeEventListener("pagehide", gone); clearTimers(); gone(); };
  }, []);

  return { phase, seconds, muted, speaking, captions, problem, minimized, setMinimized, begin, hangUp: () => hangUp("hangup"), toggleMute, clearProblem: () => setProblem(null) };
}
