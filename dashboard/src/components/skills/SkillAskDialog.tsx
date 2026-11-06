// dashboard/src/components/skills/SkillAskDialog.tsx
// "Save as a skill" (contract v0.11 §3.2 step 1): the cost line, the person's optional note, one request. The Bot then writes the draft as ONE ordinary turn in this same conversation. The request has no human gate
// (A-174: a typed-turn equivalent that persists nothing), so it works with no login; creating and turning on need one, and the review sheet says so. No <form> here: the conversation keeps exactly one (its composer).

import React from "react";
import { ApiError, requestSkillDraft, type RunInfo } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { Dialog } from "../ui/Dialog";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

export const NOTE_MAX = 300;   // characters (code points), as the server counts the note

export interface SkillAskDialogProps {
  open: boolean;
  bot: string;
  /** The conversation's session (null before its first message: there is nothing to save yet). */
  session: string | null;
  /** A turn of this conversation is still running: the draft turn would have to wait for it. */
  busyTurn: boolean;
  onClose: () => void;
  /** The run the draft request started: the conversation follows it as a turn. */
  onAsked: (run: RunInfo) => void;
}

export function SkillAskDialog({ open, bot, session, busyTurn, onClose, onAsked }: SkillAskDialogProps) {
  const { t } = useLuveI18n();
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [queued, setQueued] = React.useState(false);
  React.useEffect(() => { if (open) { setNote(""); setError(null); setQueued(false); } }, [open]);

  async function ask() {
    if (!session || busy || busyTurn) return;
    setBusy(true);
    setError(null);
    try {
      const sent = note.trim();
      const made = await requestSkillDraft(bot, { session_id: session, ...(sent ? { note: sent } : {}) });
      if (made.run) onAsked(made.run);
      else setQueued(true);                                     // Hermes keeps it for the Bot's next turn (v0.9 1.6): nothing to follow, nothing to resend
    } catch (e) {
      setError(e instanceof ApiError && e.code === "skill_invalid" ? t("skillNoteRefused") : humanError(e, t, "unexpectedError"));
    } finally {
      setBusy(false);
    }
  }

  const count = Array.from(note).length;
  return (
    <Dialog open={open} onClose={onClose} title={t("skillAskTitle")} titleId="skill-ask-title">
      <div className="lb-dialog-body">
        <p className="lb-body" style={{ margin: 0 }}>{t("skillAskIntro")}</p>
        <p className="lb-caption" style={{ margin: 0, color: "var(--color-muted-foreground)" }}>{t("skillAskCost")}</p>
        <label className="lb-field">
          <span className="lb-label">{t("skillAskNoteLabel")}</span>
          <textarea className="lb-input" rows={3} value={note} disabled={busy || queued} onChange={(e) => setNote(Array.from(e.target.value).slice(0, NOTE_MAX).join(""))} />
        </label>
        <p className="lb-caption" style={{ margin: 0, color: "var(--color-muted-foreground)" }}>{t("skillAskNoteCount", { n: count })}</p>
        {busyTurn && !queued && <p role="status" className="lb-caption" style={{ margin: 0 }}>{t("skillAskBusyTurn")}</p>}
        {queued && <p role="status" className="lb-caption" style={{ margin: 0 }}>{t("skillAskQueued")}</p>}
        {error && <p role="alert" className="lb-alert" style={{ margin: 0 }}><ErrorNote error={error} /></p>}
        <div className="lb-dialog-footer">
          <button type="button" onClick={onClose} className="lb-btn">{t(queued ? "close" : "cancelBtn")}</button>
          {!queued && <button type="button" onClick={() => void ask()} disabled={!session || busy || busyTurn} className="lb-btn lb-btn-primary">{busy ? t("skillAskAsking") : t("skillAskGo")}</button>}
        </div>
      </div>
    </Dialog>
  );
}
