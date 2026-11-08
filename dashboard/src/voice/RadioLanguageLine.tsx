// dashboard/src/voice/RadioLanguageLine.tsx
// Under the Radio (docs/contracts/voice-language-reactions-v0.md section 2, A-281): when the Bot's RAW `stt.language` is empty, one calm line says the transcription "has no language set and may come out in English" with ONE
// button that writes the screen's language ("Usar Português" / "Use English"). It shows after the Radio was pressed once, never on `auto` and never on `other` (a language the person set in Hermes is not ours to propose over),
// and nothing is written until the click. The new settings come back from the server and the line goes away; a refusal is said in words.
import React from "react";
import { getVoice, putVoiceLanguage } from "../api/client";
import type { VoiceSettings } from "../api/types";
import { useLuveI18n } from "../i18n";
import { ErrorNote, humanError, type ErrorState } from "../components/ui/ErrorNote";
import { readVoiceSettings, sttLanguageEmpty } from "./language";

export function RadioLanguageLine({ bot, settings, pressed, onSettings }: { bot: string; settings: VoiceSettings | null; pressed: boolean; onSettings: (s: VoiceSettings) => void }) {
  const { t, locale } = useLuveI18n();
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => { setDone(false); setError(null); }, [bot]);

  async function use() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const answer = readVoiceSettings(await putVoiceLanguage(bot, locale === "en" ? "en" : "pt")) ?? readVoiceSettings(await getVoice(bot));
      if (answer && !sttLanguageEmpty(answer)) { onSettings(answer); setDone(true); }
      else setError({ text: t("voiceLangFailed"), code: null });
    } catch (e) {
      setError(humanError(e, t, "voiceLangFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p role="status" className="lb-caption" style={{ margin: "0 16px 6px" }}>{t("voiceLangSaved")}</p>;
  if (!pressed || !sttLanguageEmpty(settings)) return null;
  return (
    <div data-testid="radio-language-line" style={{ margin: "0 16px 6px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <p role="status" className="lb-caption" style={{ margin: 0, flex: "1 1 220px" }}>{t("radioNoLang")}</p>
      <button type="button" className="lb-btn lb-btn-plain" disabled={busy} onClick={() => void use()}>{t("radioUseScreenLang")}</button>
      {error && <p role="alert" className="lb-caption" style={{ margin: 0, flexBasis: "100%", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </div>
  );
}
