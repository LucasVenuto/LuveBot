// dashboard/src/components/bots/ModelCard.tsx
// The "Model" card of the Bot profile (contract v0.11 1.3): the provider and model in use, and "Trocar", which reads what Hermes offers THIS Bot (only when the person opens the picker) and applies the
// choice with the body {provider, model, expected: {provider, model}} (+ `confirm_expensive` only after the person confirmed Hermes's price warning). Only what the route offered can be picked; no key and no
// address exist anywhere on this card. It applies from the next message, open LuveBot conversations included (v0.11 M-2), and says so; a channel conversation is not measured, so the card promises nothing about it. Without the route (an older LuveBot backend: 404) the card is not drawn: `fallback` (the read-only model) stays.

import React from "react";
import { ApiError, getBotModel, getModelOptions, setBotModel } from "../../api/client";
import type { BotModelInfo, ModelOptions, ModelProviderOption } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const routeMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.code === "plugin_route_missing" || e.code === "capability_missing");
const label = (p: ModelProviderOption) => p.name || p.slug;

type Picker = { state: "loading" } | { state: "ready"; options: ModelOptions } | { state: "error"; error: ErrorState };

export function ModelCard({ bot, fallback }: { bot: string; fallback?: React.ReactNode }) {
  const { t } = useLuveI18n();
  const id = `model-${bot}`;
  const [info, setInfo] = React.useState<BotModelInfo | null>(null);
  const [gone, setGone] = React.useState(false);                       // the route does not exist: the card is not drawn
  const [readError, setReadError] = React.useState<ErrorState | null>(null);
  const [picker, setPicker] = React.useState<Picker | null>(null);
  const [slow, setSlow] = React.useState(false);
  const [provider, setProvider] = React.useState("");
  const [model, setModel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [stale, setStale] = React.useState(false);
  const [warning, setWarning] = React.useState<string | null>(null);   // Hermes's price warning, shown as plain text; the second POST only after the person's click
  const [saved, setSaved] = React.useState<{ aux: string[] } | null>(null);
  const alive = React.useRef(true);
  const gen = React.useRef(0);                                     // one per Bot on screen: an answer for another Bot (or an older read) is dropped
  React.useEffect(() => () => { alive.current = false; }, []);

  const read = React.useCallback(async () => {
    setReadError(null);
    const g = gen.current;
    try {
      const v = await getBotModel(bot);
      if (!alive.current || g !== gen.current) return;
      if (!v || typeof v !== "object" || !("provider" in v) || !("model" in v)) { setGone(true); return; }   // an answer that is not the contract's: nothing is drawn
      setInfo({ provider: v.provider ?? null, model: v.model ?? null, context_length: typeof v.context_length === "number" ? v.context_length : null });
    } catch (e) {
      if (!alive.current || g !== gen.current) return;
      if (routeMissing(e)) setGone(true); else setReadError(humanError(e, t, "mdlReadFailed"));
    }
  }, [bot, t]);
  React.useEffect(() => { gen.current += 1; setInfo(null); setGone(false); setPicker(null); setSaved(null); setError(null); setStale(false); setWarning(null); void read(); }, [read]);

  const choose = (options: ModelOptions, want: { provider: string | null; model: string | null }) => {
    const p = options.providers.find((x) => x.slug === want.provider) ?? options.providers.find((x) => x.current) ?? options.providers[0];
    setProvider(p?.slug ?? "");
    setModel(p && p.models.includes(want.model ?? "") ? (want.model as string) : p?.models[0] ?? "");
  };

  async function openPicker(current: BotModelInfo | null = info) {
    setPicker({ state: "loading" }); setSlow(false); setError(null); setStale(false); setWarning(null); setSaved(null);
    const g = gen.current;
    const timer = setTimeout(() => { if (alive.current && g === gen.current) setSlow(true); }, 3000);
    try {
      const options = await getModelOptions(bot);
      if (!alive.current || g !== gen.current) return;
      const clean: ModelOptions = { providers: Array.isArray(options?.providers) ? options.providers.filter((p) => p && typeof p.slug === "string" && Array.isArray(p.models)) : [] };
      setPicker({ state: "ready", options: clean });
      choose(clean, { provider: current?.provider ?? null, model: current?.model ?? null });
    } catch (e) {
      if (alive.current && g === gen.current) setPicker({ state: "error", error: humanError(e, t, "mdlReadFailed") });
    } finally {
      clearTimeout(timer);
    }
  }

  async function apply(confirm = false) {
    if (!info || busy || !provider || !model) return;
    setBusy(true); setError(null); setStale(false);
    const g = gen.current;
    try {
      const r = await setBotModel(bot, { provider, model }, { provider: info.provider, model: info.model }, confirm);
      if (!alive.current || g !== gen.current) return;
      setInfo({ ...info, provider: r.provider, model: r.model });
      setSaved({ aux: Array.isArray(r.stale_aux) ? r.stale_aux.filter((n) => typeof n === "string").slice(0, 10) : [] });
      setPicker(null); setWarning(null);
    } catch (e) {
      if (!alive.current || g !== gen.current) return;
      if (e instanceof ApiError && e.code === "confirm_required") setWarning(typeof e.details?.warning === "string" ? e.details.warning : "");
      else if (e instanceof ApiError && e.code === "stale") { setStale(true); setWarning(null); }
      else if (e instanceof ApiError && e.code === "provider_not_supported") setError({ text: t("mdlErrNotSupported"), code: e.code });
      else if (e instanceof ApiError && e.code === "model_not_offered") { setError({ text: t("mdlErrNotOffered"), code: e.code }); setStale(true); }
      else if (e instanceof ApiError && e.code === "hermes_restart_required") setError({ text: t("mdlErrRestart"), code: e.code });
      else setError(humanError(e, t, "mdlApplyFailed"));
    } finally {
      if (alive.current && g === gen.current) setBusy(false);
    }
  }

  async function reload() {
    setStale(false); setError(null); setWarning(null); setSaved(null);
    const g = gen.current;
    try {
      const v = await getBotModel(bot);
      if (!alive.current || g !== gen.current) return;
      const next: BotModelInfo = { provider: v.provider ?? null, model: v.model ?? null, context_length: typeof v.context_length === "number" ? v.context_length : null };
      setInfo(next);
      await openPicker(next);
    } catch (e) {
      if (alive.current && g === gen.current) setError(humanError(e, t, "mdlReadFailed"));
    }
  }

  if (gone) return <>{fallback}</>;
  if (!info && !readError) return <p className="lb-subhead" role="status">{t("mdlLoading")}</p>;
  if (!info) {
    return (
      <>
        <p role="alert" className="lb-caption" style={{ color: "var(--color-destructive)" }}><ErrorNote error={readError} /></p>
        <button type="button" className="lb-btn" onClick={() => void read()}>{t("screenRetryBtn")}</button>
        {fallback}
      </>
    );
  }

  const ready = picker?.state === "ready" ? picker.options : null;
  const current = ready?.providers.find((p) => p.slug === provider);
  const unchanged = provider === info.provider && model === info.model;
  return (
    <section aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <h3 id={id} className="lb-headline" style={{ margin: 0 }}>{t("mdlTitle")}</h3>
      <p className="lb-caption" style={{ margin: 0 }}>{t("mdlIntro")}</p>
      <div className="lb-group" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <p className="lb-body" data-testid="model-current" style={{ margin: 0, overflowWrap: "anywhere" }}>
          {info.provider && info.model ? t("mdlCurrent", { provider: info.provider, model: info.model }) : t("mdlNone")}
        </p>
        {info.context_length !== null && <p className="lb-caption" style={{ margin: 0 }}>{t("mdlContext", { n: info.context_length.toLocaleString() })}</p>}
        {!picker && <div><button type="button" className="lb-btn" onClick={() => void openPicker()}>{t("mdlChange")}</button></div>}

        {picker?.state === "loading" && (
          <div role="status" className="lb-caption">{t("mdlLoadingOptions")}{slow && <> {t("mdlSlow")}</>}</div>
        )}
        {picker?.state === "error" && (
          <div>
            <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={picker.error} /></p>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" className="lb-btn" onClick={() => void openPicker()}>{t("screenRetryBtn")}</button>
              <button type="button" className="lb-btn" onClick={() => setPicker(null)}>{t("cancelBtn")}</button>
            </div>
          </div>
        )}

        {ready && !warning && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p className="lb-caption" style={{ margin: 0 }}>{t("mdlOnlyOffered")}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="lb-label" htmlFor={`${id}-provider`}>{t("mdlProvider")}</label>
              <select id={`${id}-provider`} className="lb-input" value={provider} disabled={busy}
                onChange={(e) => { const p = ready.providers.find((x) => x.slug === e.target.value); setProvider(e.target.value); setModel(p && p.models.includes(info.model ?? "") && e.target.value === info.provider ? (info.model as string) : p?.models[0] ?? ""); setError(null); setStale(false); }}>
                {ready.providers.map((p) => <option key={p.slug} value={p.slug}>{label(p)}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label className="lb-label" htmlFor={`${id}-model`}>{t("mdlModel")}</label>
              <select id={`${id}-model`} className="lb-input lb-mono" value={model} disabled={busy || !current?.models.length} onChange={(e) => { setModel(e.target.value); setError(null); setStale(false); }}>
                {(current?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              {current && current.models.length === 0 && <span className="lb-caption">{t("mdlNoModels")}</span>}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="lb-btn lb-btn-primary" disabled={busy || !provider || !model || unchanged} onClick={() => void apply()}>{busy ? t("mdlApplying") : t("mdlApply")}</button>
              <button type="button" className="lb-btn" disabled={busy} onClick={() => { setPicker(null); setError(null); setStale(false); }}>{t("cancelBtn")}</button>
            </div>
          </div>
        )}

        {warning !== null && (
          <div role="group" aria-label={t("mdlConfirmWho")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p className="lb-caption" style={{ margin: 0 }}><strong>{t("mdlConfirmWho")}</strong></p>
            {warning && <blockquote data-testid="model-warning" className="lb-caption" style={{ margin: 0, paddingLeft: 10, borderLeft: "3px solid var(--color-warning)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{warning}</blockquote>}
            <p className="lb-body" style={{ margin: 0 }}>{t("mdlConfirmQuestion")}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="lb-btn lb-btn-primary" disabled={busy} onClick={() => void apply(true)}>{busy ? t("mdlApplying") : t("mdlConfirm")}</button>
              <button type="button" className="lb-btn" disabled={busy} onClick={() => setWarning(null)}>{t("cancelBtn")}</button>
            </div>
          </div>
        )}

        {stale && (
          <div role="alert" className="lb-caption" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", color: "var(--color-destructive)" }}>
            <span>{t("mdlStale")}</span>
            <button type="button" className="lb-btn" onClick={() => void reload()}>{t("mdlReload")}</button>
          </div>
        )}
        {error && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
        {saved && (
          <div role="status" className="lb-caption" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span>{t("mdlSaved")}</span>
            {saved.aux.length > 0 && <span>{t("mdlStaleAux", { names: saved.aux.join(", ") })}</span>}
          </div>
        )}
      </div>
    </section>
  );
}
