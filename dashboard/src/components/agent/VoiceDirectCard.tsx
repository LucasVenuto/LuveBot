// dashboard/src/components/agent/VoiceDirectCard.tsx
// V6 (contract v0.10 4.1): while Hermes's `voice.client_direct` is true (its default), the voice configuration route of the Hermes dashboard hands the voice providers' KEYS to the browser of
// anyone who opens the Hermes dashboard. LuveBot never shows them, but Hermes does. One plain card in the Bot's profile, ONLY when the Bot's voice status says
// `client_direct: true`, with one button that turns it off (PUT, audited, re-read by the server). False or absent: nothing. There is no "turn it on" anywhere: that would
// loosen a control, and the server refuses it. The card is read from GET /bots/{bot}/voice, the data the voice screens already use.

import React from "react";
import { ApiError, getVoice, turnOffVoiceClientDirect } from "../../api/client";
import { useLuveI18n } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

export function VoiceDirectCard({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const id = `voice-direct-${bot}`;
  const [on, setOn] = React.useState(false);        // only an answer that says `true` shows the card; unreadable, false or absent is nothing
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => {
    let alive = true;
    setOn(false); setError(null);
    getVoice(bot).then((v) => { if (alive) setOn(v?.client_direct === true); }, () => { /* no word without the answer */ });
    return () => { alive = false; };
  }, [bot]);

  async function turnOff() {
    setBusy(true); setError(null);
    try {
      const r = await turnOffVoiceClientDirect(bot);
      if (r?.client_direct === false) setOn(false);                  // the server re-read it with Hermes's own reader: the card goes away
      else setError({ text: t("voiceDirectFailed"), code: null });
    } catch (e) {
      // a 502 is "it did not stick" (Hermes could not write it or did not keep it); anything else is the general sentence of its code
      setError(e instanceof ApiError && e.status === 502 ? { text: t("voiceDirectFailed"), code: e.code || null } : humanError(e, t, "voiceDirectFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!on) return null;
  return (
    <section aria-labelledby={id} style={{ margin: "24px 0 0" }}>
      <h3 id={id} className="lb-headline" style={{ margin: "0 4px 4px" }}>{t("voiceDirectTitle")}</h3>
      <div className="lb-group" style={{ padding: "12px 16px" }}>
        <p className="lb-body" style={{ margin: 0 }}>{t("voiceDirectWhy")}</p>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="lb-btn lb-btn-primary" disabled={busy} onClick={() => void turnOff()}>{busy ? t("voiceDirectTurningOff") : t("voiceDirectTurnOff")}</button>
        </div>
        <p className="lb-caption" style={{ margin: "8px 0 0" }}>{t("voiceDirectSide")}</p>
        {error && <p role="alert" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      </div>
    </section>
  );
}
