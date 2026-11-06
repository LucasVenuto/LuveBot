// dashboard/src/voice/CallScreen.tsx
// The call screen (paginas-ui §9): the Bot's face big (animated while it speaks), the time, the two captions ("Você" and "Bot"), and Mudo,
// Minimizar, Encerrar. A red dot and the timer are always visible while the microphone is on (contract v0.7 4.2). Minimized, it is a pill at
// the top of the conversation. A line says the voice approves nothing: an approval a task raises is decided on screen, by a click.
import React from "react";
import { useLuveI18n } from "../i18n";
import { Avatar } from "../components/ui/Avatar";
import { ErrorNote } from "../components/ui/ErrorNote";
import { callProblemText } from "./CallNotes";
import type { BotAvatar } from "../api/types";
import type { CallPhase, CallProblem, Captions } from "./useCall";

export const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

type Props = {
  name: string; avatar?: BotAvatar | null; color?: string;
  phase: CallPhase; seconds: number; muted: boolean; speaking: boolean; captions: Captions; problem: CallProblem | null;
  onMute: () => void; onMinimize: () => void; onEnd: () => void;
};

export function CallScreen({ name, avatar, color, phase, seconds, muted, speaking, captions, problem, onMute, onMinimize, onEnd }: Props) {
  const { t } = useLuveI18n();
  const live = phase === "live";
  return (
    <div role="dialog" aria-modal="false" aria-label={t("callWith", { name })} data-testid="call-screen"
      style={{ position: "absolute", inset: 0, zIndex: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14,
        padding: 24, background: "var(--color-background)", color: "var(--color-foreground)", overflowY: "auto" }}>
      <Avatar name={name} avatar={avatar ?? undefined} color={color} size={144} attention={speaking ? "working" : undefined} />
      <div style={{ textAlign: "center" }}>
        <h2 className="lb-title" style={{ margin: 0 }}>{t("callWith", { name })}</h2>
        <div role="status" data-testid="call-timer" className="lb-headline" style={{ marginTop: 4, display: "inline-flex", alignItems: "center", gap: 8, fontVariantNumeric: "tabular-nums" }}>
          {phase === "connecting" ? t("callConnecting") : phase === "ending" ? t("callEnding") : (
            <>
              <span aria-hidden="true" data-testid="call-indicator" style={{ width: 10, height: 10, borderRadius: 5, background: muted ? "var(--color-muted-foreground)" : "var(--color-destructive)" }} />
              <span>{clock(seconds)}</span>
              <span className="lb-caption">{t(muted ? "callMuted" : "callMic")}</span>
            </>
          )}
        </div>
      </div>
      <div aria-live="polite" data-testid="call-captions" style={{ width: "100%", maxWidth: 480, display: "grid", gap: 8 }}>
        <p className="lb-body" style={{ margin: 0, minHeight: 22 }}><strong>{t("callYou")}:</strong> <span data-testid="caption-you">{captions.you}</span></p>
        <p className="lb-body" style={{ margin: 0, minHeight: 22 }}><strong>{t("callBot")}:</strong> <span data-testid="caption-bot">{captions.bot}</span></p>
      </div>
      <p className="lb-caption" style={{ margin: 0, textAlign: "center" }}>{t("callNoApprove")}</p>
      {problem && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)", textAlign: "center" }}><ErrorNote error={callProblemText(problem, t)} /></p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "center" }}>
        <button type="button" className="lb-btn" aria-pressed={muted} disabled={!live} onClick={onMute}>{t(muted ? "callUnmute" : "callMute")}</button>
        <button type="button" className="lb-btn" onClick={onMinimize}>{t("callMinimize")}</button>
        <button type="button" className="lb-btn lb-btn-destructive" disabled={phase === "ending"} onClick={onEnd}>{t("callEnd")}</button>
      </div>
    </div>
  );
}

export function CallPill({ name, seconds, phase, onOpen, onEnd }: { name: string; seconds: number; phase: CallPhase; onOpen: () => void; onEnd: () => void }) {
  const { t } = useLuveI18n();
  return (
    <div role="status" data-testid="call-pill" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", margin: "8px 16px 0", borderRadius: 18,
      background: "color-mix(in srgb, var(--color-destructive) 14%, transparent)" }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: "var(--color-destructive)", flexShrink: 0 }} />
      <button type="button" className="lb-btn lb-btn-plain" style={{ flex: 1, minWidth: 0, justifyContent: "flex-start" }} aria-label={t("callPillOpen")} onClick={onOpen}>
        <span className="lb-headline lb-truncate" style={{ fontVariantNumeric: "tabular-nums" }}>{t("callPill", { name, time: phase === "live" ? clock(seconds) : "…" })}</span>
      </button>
      <button type="button" className="lb-btn lb-btn-destructive" disabled={phase === "ending"} onClick={onEnd}>{t("callEnd")}</button>
    </div>
  );
}
