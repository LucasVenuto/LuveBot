// dashboard/src/components/bots/SoulEditor.tsx
// The Bot's permanent instructions (SOUL.md) in the profile's Instructions tab (contract v0.4 B6): edited here, saved only on a click (PUT /bots/{bot}/soul with the digest the GET gave,
// CSRF, audited as `bot.soul.update`), a file that changed meanwhile is a 409 said in words, and the managed LuveBot rules block never shows and is never touched (the server keeps it).
// One button inserts LuveBot's own fixed text that asks the Bot for the evidence block (contract v0.10 3.3): at the end of the text, never saved by itself, never built from Bot output.

import React from "react";
import { ApiError, getSoul, putSoul } from "../../api/client";
import type { SoulView } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function SoulEditor({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const [view, setView] = React.useState<SoulView | null>(null);
  const [text, setText] = React.useState("");
  const [loadError, setLoadError] = React.useState<ErrorState | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [stale, setStale] = React.useState(false);
  const [reloadable, setReloadable] = React.useState(false);   // the server refused a save because the file is not fully shown NOW: the person's text stays, and reloading shows why
  const [note, setNote] = React.useState<TranslationKey | null>(null);   // "saved", "inserted", "already there": one calm line
  const box = React.useRef<HTMLTextAreaElement>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  const load = React.useCallback(async () => {
    setLoadError(null); setError(null); setStale(false); setReloadable(false); setNote(null);
    try {
      const v = await getSoul(bot);
      if (!alive.current) return;
      setView(v); setText(v.content);
    } catch (e) {
      if (alive.current) setLoadError(humanError(e, t, "soulLoadFailed"));
    }
  }, [bot, t]);
  React.useEffect(() => { setView(null); void load(); }, [load]);

  const dirty = view !== null && text !== view.content;
  // Fully shown = what is in the box is what the file holds: not cut at 64 KiB AND not hidden/replaced (a key, an inline image). Only then may it be edited: saving anything else writes the
  // hiding over the real text. A flag the server did not send counts as not shown fully (never assumed fine).
  const editable = view !== null && view.redacted === false && !view.truncated;

  async function save() {
    if (!view || !dirty || saving || !editable) return;
    setSaving(true); setError(null); setStale(false); setReloadable(false); setNote(null);
    try {
      const v = await putSoul(bot, text, view.expected_digest);
      if (!alive.current) return;
      setView(v); setText(v.content); setNote("soulSaved");
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.code === "stale") setStale(true);
      else if (e instanceof ApiError && e.code === "too_large") setError({ text: t("soulErrTooLarge"), code: e.code });
      else if (e instanceof ApiError && e.code === "invalid_field") setError({ text: t("soulErrMarkers"), code: e.code });
      else if (e instanceof ApiError && (e.code === "soul_redacted" || e.code === "soul_truncated")) { setError({ text: t(e.code === "soul_redacted" ? "soulErrRedacted" : "soulErrTruncated"), code: e.code }); setReloadable(true); }
      else setError(humanError(e, t, "soulSaveFailed"));
    } finally {
      if (alive.current) setSaving(false);
    }
  }

  /** Puts LuveBot's fixed text at the END of what is in the box (not saved), once: pressing it again says it is already there. */
  function askForEvidence() {
    const fixed = t("soulEvidenceText");
    if (norm(text).includes(norm(fixed))) { setNote("soulEvidenceAlready"); return; }
    const head = text.replace(/\s+$/, "");
    setText(head ? `${head}\n\n${fixed}\n` : `${fixed}\n`);
    setNote("soulEvidenceDone");
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); el.scrollTop = el.scrollHeight; } });
  }

  if (loadError) {
    return (
      <div>
        <p role="alert" className="lb-caption" style={{ color: "var(--color-destructive)" }}><ErrorNote error={loadError} /></p>
        <button type="button" className="lb-btn" style={{ marginTop: 8 }} onClick={() => void load()}>{t("screenRetryBtn")}</button>
      </div>
    );
  }
  if (!view) return <p className="lb-subhead" role="status">{t("soulLoading")}</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p className="lb-caption" style={{ margin: 0 }}>{t("soulEditNotice")}</p>
      {!editable && <p className="lb-caption" data-testid="soul-not-full" style={{ margin: 0 }}>{t("soulNotFull")}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="lb-btn" disabled={!editable} onClick={askForEvidence}>{t("soulEvidenceBtn")}</button>
          <span className="lb-caption lb-mono">{text.length} {t("charactersCount")}</span>
        </div>
        <p className="lb-caption" style={{ margin: 0 }}>{t("soulEvidenceNote")}</p>
      </div>

      <label className="lb-label" htmlFor={`soul-${bot}`}>{t("soulContentTitle")}</label>
      <textarea id={`soul-${bot}`} ref={box} value={text} readOnly={!editable} rows={14} className="lb-input lb-mono" style={{ resize: "vertical", lineHeight: 1.5 }}
        placeholder={t("soulPlaceholder")} onChange={(e) => { setText(e.target.value); setNote(null); }} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="lb-btn lb-btn-primary" disabled={!dirty || saving || !editable} onClick={() => void save()}>{saving ? t("soulSaving") : t("soulSave")}</button>
        {note && <span role="status" className="lb-caption">{t(note)}</span>}
      </div>

      {stale && (
        <div role="alert" className="lb-caption" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", color: "var(--color-destructive)" }}>
          <span>{t("soulStale")}</span>
          <button type="button" className="lb-btn" onClick={() => void load()}>{t("soulReload")}</button>
        </div>
      )}
      {error && (
        <div role="alert" className="lb-caption" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", color: "var(--color-destructive)" }}>
          <span><ErrorNote error={error} /></span>
          {reloadable && <button type="button" className="lb-btn" onClick={() => void load()}>{t("soulReload")}</button>}
        </div>
      )}
    </div>
  );
}
