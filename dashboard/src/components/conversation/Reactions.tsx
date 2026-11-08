// dashboard/src/components/conversation/Reactions.tsx
// The team's mark on one message (contract v0.8 §4, voice-language-reactions-v0 §4): a closed set of 24, one mark per message for the whole team (Hermes keeps one `user` slot), saved in the conversation by Hermes. The strip shows
// the marks the message has; next to a hovered or focused message a bar of six quick ones (a pointer's shortcut: the keyboard goes through "+"), and a small "+" that opens the grid of 24 (out of the way until the turn is hovered or focused,
// always there on touch, where a long press on the row opens the grid too). The picker says, once, that a person has one reaction per message and that another replaces it; the page never says the Bot reacts (it does not, until v0.4) and says
// the Bot is told only on the Bot's own switch (the Profile). Nothing here is agent content: the emoji are our closed set, or a short symbol Hermes stored (the server already reduced anything else to a dot).

import React from "react";
import { ApiError } from "../../api/client";
import type { MessageReaction, ThreadInfo } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { QUICK_REACTIONS, REACTION_SET } from "./reactionSet";

export { QUICK_REACTIONS, REACTION_SET };
const LONG_PRESS_MS = 500;   // a touch held this long on the row opens the grid (the same time as the message menu's)
const OWN: Record<string, TranslationKey> = { message_not_saved: "reactErrNotSaved", capability_missing: "reactErrMissing", hermes_busy: "reactErrBusy" };
type T = (k: TranslationKey, p?: Record<string, string | number>) => string;

export function reactionError(e: unknown, t: T): ErrorState {
  return e instanceof ApiError && OWN[e.code] ? { text: t(OWN[e.code]), code: e.code } : humanError(e, t as (k: TranslationKey) => string, "reactErrGeneric");
}

export type Slot = "userRow" | "replyRow";
export const NO_MARKS: readonly MessageReaction[] = [];
export const NO_THREADS: readonly ThreadInfo[] = [];

export interface ReactionStripProps {
  side: "me" | "bot";
  marks: readonly MessageReaction[];
  /** Which turn and which of its two messages this strip is under; given back to `onReact` so ONE stable handler serves every strip. */
  turn: number;
  slot: Slot;
  /** Sets (or, with `clear`, takes off) the mark; rejects with the reason when it could not be saved. */
  onReact: (turn: number, slot: Slot, emoji: string, clear: boolean) => Promise<void>;
  /** The threads this message already has (contract v0.8 §4), a chip each; and the way to start one or open one. */
  threads?: readonly ThreadInfo[];
  onThread?: (turn: number, slot: Slot) => Promise<void>;
  onOpenThread?: (turn: number, slot: Slot, child: string) => void;
  /** This Hermes cannot keep marks: the "+" and the chips go away. */
  off?: boolean;
  onOff?: () => void;
}

// memo: the strip of a finished turn is not drawn again at every token of the turn that is streaming (perf-tela.md item 1)
export const ReactionStrip = React.memo(function ReactionStrip({ side, marks, turn, slot, onReact, threads = NO_THREADS, onThread, onOpenThread, off, onOff }: ReactionStripProps) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const root = React.useRef<HTMLDivElement>(null);
  const add = React.useRef<HTMLButtonElement>(null);
  const alive = React.useRef(true);
  const press = React.useRef<number | null>(null);
  React.useEffect(() => () => { alive.current = false; if (press.current !== null) window.clearTimeout(press.current); }, []);
  const cancelPress = () => { if (press.current !== null) { window.clearTimeout(press.current); press.current = null; } };
  React.useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const team = marks.find((m) => m.author === "user")?.emoji;
  const pick = async (emoji: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await onReact(turn, slot, emoji, emoji === team); if (alive.current) { setOpen(false); add.current?.focus(); } }
    catch (e) { if (!alive.current) return; if (e instanceof ApiError && e.code === "capability_missing") onOff?.(); setError(reactionError(e, t)); }
    finally { if (alive.current) setBusy(false); }
  };
  if (off && !marks.length && !error && !onThread && !threads.length) return null;       // this Hermes keeps none: nothing to show, but the strip that found out says why
  return (
    <div ref={root} className="lb-react" data-testid="reactions" style={{ justifyContent: side === "me" ? "flex-end" : "flex-start" }}
      onPointerDown={(e) => { if (off || e.pointerType !== "touch") return; cancelPress(); press.current = window.setTimeout(() => { press.current = null; setError(null); setOpen(true); }, LONG_PRESS_MS); }}
      onPointerUp={cancelPress} onPointerMove={cancelPress} onPointerCancel={cancelPress}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); add.current?.focus(); } }}>
      {marks.map((m) => m.author === "user" ? (
        <button key="user" type="button" className="lb-react-chip" data-testid="reaction-mark" aria-pressed="true" disabled={busy || off}
          title={t("reactTeam")} aria-label={`${t("reactTeam")}: ${t("reactRemove", { emoji: m.emoji })}`} onClick={() => void pick(m.emoji)}>{m.emoji}</button>
      ) : (
        <span key="agent" className="lb-react-chip" data-testid="reaction-mark-bot" role="img" title={t("reactBot")} aria-label={`${t("reactBot")}: ${m.emoji}`}>{m.emoji}</span>
      ))}
      {!off && (
        <span style={{ position: "relative" }}>
          <button ref={add} type="button" className="lb-icon-btn lb-react-add" aria-label={t("reactAdd")} title={t("reactAdd")} aria-haspopup="true" aria-expanded={open}
            onClick={() => { setError(null); setOpen((o) => !o); }}><span aria-hidden="true">+</span></button>
          {open && (
            <div role="group" aria-label={t("reactPick")} className="lb-react-picker" style={side === "me" ? { right: 0 } : { left: 0 }}>
              <div className="lb-react-grid">
                {REACTION_SET.map((emoji) => (
                  <button key={emoji} type="button" className="lb-react-pick" disabled={busy} aria-pressed={team === emoji}
                    aria-label={t(team === emoji ? "reactRemove" : "reactSet", { emoji })} onClick={() => void pick(emoji)}>{emoji}</button>
                ))}
              </div>
              <p className="lb-caption" style={{ margin: "4px 4px 2px", maxWidth: 230 }}>{t("reactNote")}</p>
            </div>
          )}
        </span>
      )}
      {!off && (
        <span className="lb-react-quick" data-testid="reaction-quick" role="group" aria-label={t("reactQuickLabel")}>
          {QUICK_REACTIONS.map((emoji) => (
            <button key={emoji} type="button" tabIndex={-1} className="lb-react-pick lb-react-quick-btn" disabled={busy} aria-pressed={team === emoji}
              aria-label={t(team === emoji ? "reactQuickRemove" : "reactQuickSet", { emoji })} onClick={() => void pick(emoji)}>{emoji}</button>
          ))}
        </span>
      )}
      {onThread && (
        <button type="button" className="lb-icon-btn lb-react-add" aria-label={t("threadStart")} title={t("threadStart")}
          onClick={() => { setError(null); onThread(turn, slot).catch((e) => { if (alive.current) setError(reactionError(e, t)); }); }}><span aria-hidden="true">↩</span></button>
      )}
      {threads.map((th) => {
        const label = th.replies === null ? t("threadChipOpen") : th.replies === 1 ? t("threadChipOne") : t("threadChipMany", { n: th.replies });
        return (
          <button key={th.child_session} type="button" className="lb-react-chip lb-react-thread" data-testid="thread-chip" aria-label={`${t("threadOpen")}: ${label}`} title={t("threadOpen")}
            onClick={() => onOpenThread?.(turn, slot, th.child_session)}><span aria-hidden="true">↩</span>{label}</button>
        );
      })}
      {error && <span role="alert" className="lb-caption" style={{ color: "var(--color-destructive)" }}><ErrorNote error={error} /></span>}
    </div>
  );
});
