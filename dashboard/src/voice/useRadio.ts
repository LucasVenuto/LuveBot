// dashboard/src/voice/useRadio.ts
// Radio (contract v0.7 2.1 and 4.2): recording only while the person holds the button (or between the two taps of "toque para
// começar/parar"), at most 120 s, then ONE upload to POST /bots/{bot}/voice/transcribe and the text goes back to the caller, which
// sends it through the normal conversation route (A-97). The tracks are stopped on release, cancel, 120 s, unmount and when the
// page is hidden. The recording is a Blob in memory, sent once and dropped: nothing is written to storage.
import React from "react";
import { ApiError, transcribeVoice } from "../api/client";
import { openMic } from "./mic";

export const MAX_RECORDING_S = 120;  // A-102
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export type RadioPhase = "idle" | "starting" | "recording" | "sending";
export type RadioProblem = "mic_denied" | "mic_missing" | "mic_error" | "empty" | ApiError;

export function useRadio({ bot, onText }: { bot: string; onText: (text: string, provider: string | null) => void }) {
  const [phase, setPhase] = React.useState<RadioPhase>("idle");
  const [seconds, setSeconds] = React.useState(0);
  const [problem, setProblem] = React.useState<RadioProblem | null>(null);
  const stream = React.useRef<MediaStream | null>(null);
  const recorder = React.useRef<MediaRecorder | null>(null);
  const timer = React.useRef<number | null>(null);
  const wanted = React.useRef(false);   // still held (or in tap mode) when the microphone answers
  const onTextRef = React.useRef(onText);
  onTextRef.current = onText;

  const stopTracks = () => { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; };
  const stopTimer = () => { if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null; } };

  const upload = React.useCallback(async (recording: Blob) => {
    setPhase("sending");
    try {
      const { text, provider } = await transcribeVoice(bot, recording);
      if (!text.trim()) setProblem("empty");   // "Não ouvi nada": nothing is sent
      else onTextRef.current(text.trim(), provider);
    } catch (e) {
      setProblem(e instanceof ApiError ? e : "mic_error");
    } finally {
      setPhase("idle");
    }
  }, [bot]);

  /** Ends the recording: `send` uploads it once; otherwise it is dropped. Either way the microphone is released now. */
  const finish = React.useCallback((send: boolean) => {
    wanted.current = false;
    stopTimer();
    const rec = recorder.current;
    recorder.current = null;
    if (!rec || rec.state === "inactive") { stopTracks(); setPhase((p) => (p === "sending" ? p : "idle")); return; }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => {
      stopTracks();
      if (send && chunks.length) void upload(new Blob(chunks, { type: (rec.mimeType || "audio/webm").split(";")[0] }));
      else setPhase("idle");
    };
    rec.stop();
    stopTracks();
  }, [upload]);

  /** Starts a recording: only from the Radio button's gesture handlers (the microphone is asked here, never elsewhere). */
  const begin = React.useCallback(async () => {
    if (phase !== "idle") return;
    setProblem(null); setSeconds(0); setPhase("starting");
    wanted.current = true;
    let mic: MediaStream;
    try {
      mic = await openMic();
    } catch (e) {
      wanted.current = false;
      setPhase("idle");
      const name = (e as { name?: string })?.name;
      setProblem(name === "NotAllowedError" || name === "SecurityError" ? "mic_denied" : name === "NotFoundError" ? "mic_missing" : "mic_error");
      return;
    }
    if (!wanted.current) { mic.getTracks().forEach((track) => track.stop()); setPhase("idle"); return; }  // let go before it answered
    stream.current = mic;
    const type = TYPES.find((x) => typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(x));
    const rec = new MediaRecorder(mic, type ? { mimeType: type } : undefined);
    recorder.current = rec;
    rec.start();
    setPhase("recording");
    const started = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_RECORDING_S) finish(true);   // stops itself at 120 s and sends what it has
    }, 250);
  }, [phase, finish]);

  // Hidden page or unmount: drop the recording and release the microphone at once
  React.useEffect(() => {
    const away = () => { if (document.visibilityState === "hidden") finish(false); };
    document.addEventListener("visibilitychange", away);
    return () => document.removeEventListener("visibilitychange", away);
  }, [finish]);
  React.useEffect(() => () => { wanted.current = false; stopTimer(); recorder.current = null; stopTracks(); }, []);

  return { phase, seconds, problem, begin, send: () => finish(true), cancel: () => finish(false), clearProblem: () => setProblem(null) };
}
