// dashboard/src/voice/RadioStrip.tsx
// While the Radio records, the composer shows a light red strip with the time and what releasing does (paginas-ui §9); while the
// recording is transcribed, "Transcrevendo… {s} s". The refusals and the provider line are said above the composer, in words.
import React from "react";
import { ApiError } from "../api/client";
import { useLuveI18n, type TranslationKey } from "../i18n";
import { humanError, ErrorNote, type ErrorState } from "../components/ui/ErrorNote";
import type { RadioPhase, RadioProblem } from "./useRadio";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export const SLOW_AFTER_S = 8;   // after this many seconds of transcribing, one line says it is slower than usual (voice-language-reactions-v0 section 2, A-278)

/** "Transcrevendo… {s} s", and after 8 s one line more: slower than usual, with the provider the status named (if it named one) and that the first time after a restart is the slowest. LuveBot never changes the provider. */
function Transcribing({ provider }: { provider: string | null }) {
  const { t } = useLuveI18n();
  const [s, setS] = React.useState(0);
  React.useEffect(() => { const started = Date.now(); const id = window.setInterval(() => setS(Math.floor((Date.now() - started) / 1000)), 500); return () => window.clearInterval(id); }, []);
  return (
    <div role="status" className="lb-body" style={{ flex: 1, minHeight: 40, display: "flex", flexDirection: "column", justifyContent: "center", gap: 2 }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("radioTranscribing", { s })}</span>
      {s >= SLOW_AFTER_S && <span className="lb-caption" data-testid="radio-slow">{provider ? t("radioSlow", { provider }) : t("radioSlowNoProvider")}</span>}
    </div>
  );
}

export function RadioStrip({ phase, seconds, tapMode, onCancel, provider = null }: { phase: RadioPhase; seconds: number; tapMode: boolean; onCancel: () => void; provider?: string | null }) {
  const { t } = useLuveI18n();
  if (phase === "sending") return <Transcribing provider={provider} />;
  return (
    <div role="status" data-testid="radio-strip" style={{ flex: 1, minHeight: 40, display: "flex", alignItems: "center", gap: 10, padding: "0 12px", borderRadius: 18,
      background: "color-mix(in srgb, var(--color-destructive) 14%, transparent)" }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: "var(--color-destructive)", flexShrink: 0 }} />
      <span className="lb-headline" style={{ fontVariantNumeric: "tabular-nums" }}>{phase === "starting" ? t("radioStarting") : t("radioRecording", { time: clock(seconds) })}</span>
      <span className="lb-caption lb-truncate" style={{ flex: 1, minWidth: 0 }}>{t(tapMode ? "radioTapHint" : "radioHoldHint")}</span>
      <button type="button" className="lb-btn lb-btn-plain" onClick={onCancel}>{t("radioCancel")}</button>
    </div>
  );
}

const MIC: Record<string, TranslationKey> = { mic_denied: "radioMicDenied", mic_missing: "radioMicMissing", mic_error: "radioMicError", empty: "radioEmpty" };
const API: Record<string, TranslationKey> = { voice_unavailable: "radioErrUnavailable", too_large: "radioErrTooLarge", unsupported_media: "radioErrUnsupported" };

export function radioProblemText(problem: RadioProblem, t: (k: TranslationKey) => string): ErrorState {
  if (problem instanceof ApiError) return API[problem.code] ? t(API[problem.code]) : humanError(problem, t, "radioErrGeneric");
  return t(MIC[problem]);
}

// Free, local providers (A-101): anything else is paid and outside LuveBot's cap
const FREE = new Set(["local", "faster-whisper", "faster_whisper", "whisper-local", "edge", "edge-tts", "piper", "kokoro", "neutts"]);
export const providerIsFree = (provider: string) => FREE.has(provider.toLowerCase());

export function RadioNotes({ problem, provider, speakError }: { problem: RadioProblem | null; provider: string | null; speakError: ErrorState | null }) {
  const { t } = useLuveI18n();
  if (!problem && !provider && !speakError) return null;
  return (
    <div style={{ margin: "0 16px 6px", display: "flex", flexDirection: "column", gap: 4 }}>
      {problem && <p role={problem === "empty" ? "status" : "alert"} className="lb-caption" style={{ margin: 0, color: problem === "empty" ? undefined : "var(--color-destructive)" }}><ErrorNote error={radioProblemText(problem, t)} /></p>}
      {speakError && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={speakError} /></p>}
      {provider && <p className="lb-caption" style={{ margin: 0 }}>{t(providerIsFree(provider) ? "radioProvider" : "radioProviderPaid", { provider })}</p>}
    </div>
  );
}
