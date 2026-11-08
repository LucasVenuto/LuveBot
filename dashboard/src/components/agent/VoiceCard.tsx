// dashboard/src/components/agent/VoiceCard.tsx
// The Voice card in the Bot's profile (docs/contracts/voice-language-reactions-v0.md section 2, VL-2): the language of the Radio's transcription (three choices: Automático, Português, English), the transcription provider and the
// voice (read only: they are chosen in Hermes), and what Hermes holds when the person set a language outside our two ("Definido no Hermes: fr", A-281: no choice is marked and the three still work). A tap saves at once through
// PUT /bots/{bot}/voice/language (audited, login and CSRF); the card reads GET /bots/{bot}/voice and shows ONLY what the server says: a server older than VL-1 (no `settings`) shows no card. The screen's language is never written
// here; it is proposed under the Radio, one click, and in Settings for every Bot.
import React from "react";
import { getVoice, putVoiceLanguage } from "../../api/client";
import type { VoiceLanguage, VoiceSettings } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { visibleTokens } from "../../lib/hiddenChars";
import { readVoiceSettings } from "../../voice/language";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const CHOICES: Array<[VoiceLanguage, TranslationKey]> = [["auto", "voiceLangAuto"], ["pt", "langPortuguese"], ["en", "langEnglish"]];
const cut = (s: string, n = 60) => { const a = [...s]; return a.length > n ? `${a.slice(0, n - 1).join("")}…` : s; };

export function VoiceCard({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const id = `voice-lang-${bot}`;
  const [settings, setSettings] = React.useState<VoiceSettings | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => {
    let alive = true;
    setSettings(null); setSaved(false); setError(null);
    getVoice(bot).then((v) => { if (alive) setSettings(readVoiceSettings(v)); }, () => { /* no word without the answer */ });
    return () => { alive = false; };
  }, [bot]);

  async function pick(language: VoiceLanguage) {
    if (busy || !settings || settings.language === language) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const answer = readVoiceSettings(await putVoiceLanguage(bot, language)) ?? readVoiceSettings(await getVoice(bot));   // the new settings, else read them again: never assume what was written
      if (answer) { setSettings(answer); setSaved(answer.language === language); }
      if (!answer || answer.language !== language) setError({ text: t("voiceLangFailed"), code: null });
    } catch (e) {
      setError(humanError(e, t, "voiceLangFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return null;
  const voice = [settings.tts.provider, settings.tts.voice].filter(Boolean).join(" · ");
  return (
    <section aria-labelledby={id} style={{ margin: "24px 0 0" }}>
      <h3 id={id} className="lb-headline" style={{ margin: "0 4px 4px" }}>{t("voiceLangTitle")}</h3>
      <div className="lb-group" style={{ padding: "12px 16px" }}>
        <p className="lb-body" style={{ margin: 0 }}>{t("voiceLangLabel")}</p>
        {settings.language === "other" && (
          <p className="lb-caption" style={{ margin: "4px 0 0", overflowWrap: "anywhere" }}>{t("voiceLangOther", { value: cut(visibleTokens(settings.stt.language ?? "")) })}</p>
        )}
        <div role="radiogroup" aria-label={t("voiceLangLabel")} className="lb-segmented" style={{ margin: "8px 0 4px" }}>
          {CHOICES.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.language === value} disabled={busy} className="lb-segment" onClick={() => void pick(value)}>{t(label)}</button>
          ))}
        </div>
        <p className="lb-caption" style={{ margin: "8px 0 0" }}>{t("voiceLangHelp")}</p>
        <p className="lb-caption" style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}>{t("voiceSttRow", { provider: settings.stt.provider ? cut(visibleTokens(settings.stt.provider)) : t("voiceNotSet") })}</p>
        <p className="lb-caption" style={{ margin: "2px 0 0", overflowWrap: "anywhere" }}>{t("voiceTtsRow", { voice: voice ? cut(visibleTokens(voice)) : t("voiceNotSet") })}</p>
        <p className="lb-caption" style={{ margin: "2px 0 0" }}>{t("voiceReadOnly")}</p>
        {busy && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{t("voiceLangSaving")}</p>}
        {saved && !busy && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{t("voiceLangSaved")}</p>}
        {error && <p role="alert" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      </div>
    </section>
  );
}
