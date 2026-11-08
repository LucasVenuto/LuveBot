// dashboard/src/components/settings/VoiceLanguageAll.tsx
// "Aplicar o idioma da tela a todos os Bots" (docs/contracts/voice-language-reactions-v0.md section 2, A-281): the screen's OWN loop of the single PUT /bots/{bot}/voice/language, one Bot at a time, one audit row each (there is
// no bulk route). It READS every Bot first and says, before the first write, how many will change and how many stay (A-282); a Bot already in the language is not written, one whose language the person set in Hermes outside
// pt/en is left as it is, one it cannot read is a failure and is never written blind. A Bot that fails does not stop the others and nothing already written is undone; the screen says "N de M aplicados" and WHICH Bots failed,
// stayed or were already there. Nothing runs until the click. The section shows ONLY when at least one Bot's status carries `settings` (VL-1): on a server without them there is no button that could only fail.
import React from "react";
import { getVoice } from "../../api/client";
import type { Bot } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { applyLanguageToAll, readVoiceSettings, type ApplyAllResult } from "../../voice/language";

export function VoiceLanguageAll({ bots }: { bots: readonly Bot[] }) {
  const { t, locale } = useLuveI18n();
  const id = "settings-voice-language";
  const [busy, setBusy] = React.useState<{ phase: "reading" | "writing"; done: number; total: number } | null>(null);
  const [plan, setPlan] = React.useState<{ change: number; stay: number } | null>(null);
  const [result, setResult] = React.useState<ApplyAllResult | null>(null);
  const [ready, setReady] = React.useState(false);   // some Bot's status has settings: only then is there something this button can do
  const names = bots.map((b) => b.name).join("|");
  React.useEffect(() => {
    let alive = true;
    setReady(false);
    Promise.all(bots.map((b) => getVoice(b.name).then(readVoiceSettings, () => null))).then((all) => { if (alive) setReady(all.some(Boolean)); });
    return () => { alive = false; };
  }, [names]);  // eslint-disable-line react-hooks/exhaustive-deps
  const labelOf = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;
  const list = (names: string[]) => names.map(labelOf).join(", ");

  async function apply() {
    if (busy || bots.length === 0) return;
    setBusy({ phase: "reading", done: 0, total: bots.length }); setResult(null); setPlan(null);
    try {
      setResult(await applyLanguageToAll(bots, locale === "en" ? "en" : "pt", {
        onRead: (done, total) => setBusy({ phase: "reading", done, total }),
        onPlan: (p) => { setPlan(p); setBusy({ phase: "writing", done: 0, total: p.change }); },
        onStep: (done, total) => setBusy({ phase: "writing", done, total }),
      }));
    } finally {
      setBusy(null);
    }
  }

  if (!ready) return null;
  return (
    <section aria-labelledby={id} style={{ margin: "24px 0 0" }}>
      <h2 id={id} className="lb-headline" style={{ margin: "0 4px 8px" }}>{t("voiceLangTitle")}</h2>
      <div className="lb-group" style={{ padding: "12px 16px" }}>
        <p className="lb-caption" style={{ margin: 0 }}>{t("voiceAllNote", { lang: t(locale === "en" ? "langEnglish" : "langPortuguese") })}</p>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="lb-btn" disabled={!!busy || bots.length === 0} onClick={() => void apply()}>{t("voiceAllApply")}</button>
        </div>
        {busy?.phase === "reading" && <p role="status" className="lb-caption" style={{ margin: "8px 0 0" }}>{t("voiceAllReading", { done: busy.done, total: busy.total })}</p>}
        {plan && <p role="status" data-testid="voice-all-plan" className="lb-caption" style={{ margin: "8px 0 0" }}>{t("voiceAllPlan", { lang: t(locale === "en" ? "langEnglish" : "langPortuguese"), n: plan.change, m: plan.stay })}</p>}
        {busy?.phase === "writing" && <p role="status" className="lb-caption" style={{ margin: "4px 0 0" }}>{t("voiceAllRunning", { done: busy.done, total: busy.total })}</p>}
        {result && !busy && (
          <div role="status" className="lb-caption" style={{ margin: "8px 0 0", display: "grid", gap: 2 }}>
            <p style={{ margin: 0 }}>{t("voiceAllResult", { n: result.applied.length, m: result.total })}</p>
            {result.already.length > 0 && <p style={{ margin: 0, overflowWrap: "anywhere" }}>{t("voiceAllAlready", { lang: t(locale === "en" ? "langEnglish" : "langPortuguese"), bots: list(result.already) })}</p>}
            {result.kept.length > 0 && <p style={{ margin: 0, overflowWrap: "anywhere" }}>{t("voiceAllKept", { bots: list(result.kept) })}</p>}
            {result.failed.length > 0 && <p role="alert" style={{ margin: 0, overflowWrap: "anywhere", color: "var(--color-destructive)" }}>{t("voiceAllFailed", { bots: list(result.failed) })}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
