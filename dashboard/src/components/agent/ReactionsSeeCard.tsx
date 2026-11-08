// dashboard/src/components/agent/ReactionsSeeCard.tsx
// "O Bot vê as minhas reações" (docs/contracts/voice-language-reactions-v0.md section 4 and A-282): ONE switch in the Bot's profile, off by default as Hermes's own `display.message_reactions` is. Read from GET /bots/{bot}
// (`reactions: {bot_sees}`); changed by PUT /bots/{bot}/reactions/bot-sees with exactly {enabled} (login and CSRF, audited, written through Hermes's own configuration write). When the server cannot tell (the object is absent, a
// Hermes without the announcement, an unreadable answer) the switch is drawn OFF and says it is unavailable: it is never drawn on without the server saying so. The page never says the Bot reacts (that is v0.4): it says only
// that the Bot is told, with the next message, about the reactions the person made.
import React from "react";
import { getBot, putReactionsBotSees } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

/** The `bot_sees` of an answer ({reactions: {bot_sees}} from the PUT, or the Bot's detail), or null when it is not a boolean. */
export const botSees = (raw: unknown): boolean | null => {
  const v = (raw as { reactions?: { bot_sees?: unknown } } | null)?.reactions?.bot_sees;
  return typeof v === "boolean" ? v : null;
};

export function ReactionsSeeCard({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const id = `reactions-see-${bot}`;
  const [state, setState] = React.useState<boolean | "unavailable" | null>(null);   // null: the answer has not come yet
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState<boolean | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => {
    let alive = true;
    setState(null); setSaved(null); setError(null);
    getBot(bot).then((d) => { if (alive) setState(botSees(d) ?? "unavailable"); }, () => { if (alive) setState("unavailable"); });
    return () => { alive = false; };
  }, [bot]);

  async function toggle() {
    if (busy || typeof state !== "boolean") return;
    setBusy(true); setError(null); setSaved(null);
    try {
      const answer = botSees(await putReactionsBotSees(bot, !state));
      if (answer === null || answer !== !state) setError({ text: t("reactSeesFailed"), code: null });   // the server's word is the truth: never assume what was written
      if (answer !== null) { setState(answer); if (answer === !state) setSaved(answer); }
    } catch (e) {
      setError(humanError(e, t, "reactSeesFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;
  const on = state === true, off = state === "unavailable";
  return (
    <section aria-labelledby={id} style={{ margin: "24px 0 0" }}>
      <h3 id={id} className="lb-headline" style={{ margin: "0 4px 4px" }}>{t("reactSeesTitle")}</h3>
      <div className="lb-group" style={{ padding: "12px 16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span id={`${id}-label`} className="lb-body" style={{ flex: 1, minWidth: 0 }}>{t("reactSeesLabel")}</span>
          <button type="button" role="switch" aria-checked={on} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} disabled={busy || off} onClick={() => void toggle()} className="lb-switch"
            style={{ width: 44, height: 26, borderRadius: 13, border: "none", flexShrink: 0, cursor: busy || off ? "not-allowed" : "pointer", position: "relative", background: on ? "var(--color-success)" : "var(--lb-fill-2)", opacity: busy || off ? 0.55 : 1 }}>
            <span aria-hidden="true" style={{ position: "absolute", top: 3, left: on ? 21 : 3, width: 20, height: 20, borderRadius: 10, background: "#fff" }} />
          </button>
        </div>
        <p id={`${id}-help`} className="lb-caption" style={{ margin: "8px 0 0" }}>{off ? t("reactSeesUnavailable") : t("reactSeesHelp")}</p>
        {busy && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{t("reactSeesSaving")}</p>}
        {saved !== null && !busy && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{t(saved ? "reactSeesSavedOn" : "reactSeesSavedOff")}</p>}
        {error && <p role="alert" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      </div>
    </section>
  );
}
