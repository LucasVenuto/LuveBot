// dashboard/src/components/agent/ApprovalTimeoutCard.tsx
// "Tempo para responder aprovações" (contract v0.6 Part D): how long a Bot waits for a person's answer, one of 5 min, 15 min,
// 30 min, 1 h or 4 h. Hermes keeps the value (its own config writer, in the Bot's profile) and re-reads it; silence still
// denies, and the same wait applies in Telegram and the Bot's other channels. A longer wait is not loosening, so it is offered in
// loopback too (A-92). In the Bot's profile (one Bot) and in Configurações (every Bot, each written and audited on its own).

import React from "react";
import { ApiError, getBot, setApprovalTimeout, setApprovalTimeoutAll } from "../../api/client";
import { APPROVAL_TIMEOUTS, type ApprovalTimeout, type Bot } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

const LABEL: Record<number, TranslationKey> = { 300: "timeout5m", 900: "timeout15m", 1800: "timeout30m", 3600: "timeout1h", 14400: "timeout4h" };
const ERRORS: Record<string, TranslationKey> = { invalid_field: "timeoutErrInvalid", hermes_error: "timeoutErrHermes", audit_unavailable: "timeoutErrAudit" };

/** A wait in words: one of the 5 options, else minutes or hours as Hermes holds it (a value set outside LuveBot). */
export function timeoutLabel(seconds: number, t: (k: TranslationKey, p?: Record<string, string | number>) => string): string {
  if (LABEL[seconds]) return t(LABEL[seconds]);
  return seconds % 3600 === 0 ? t("timeoutHours", { n: seconds / 3600 }) : t("timeoutMinutes", { n: Math.round(seconds / 60) });
}

function errorOf(e: unknown, t: (k: TranslationKey) => string): ErrorState {
  return e instanceof ApiError && ERRORS[e.code] ? t(ERRORS[e.code]) : humanError(e, t, "timeoutErrGeneric");
}

function Choice({ id, value, busy, onPick }: { id: string; value: number | null; busy: boolean; onPick: (s: number) => void }) {
  const { t } = useLuveI18n();
  return (
    <div role="radiogroup" aria-labelledby={id} className="lb-segmented" style={{ margin: "12px 16px 4px" }}>
      {APPROVAL_TIMEOUTS.map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} disabled={busy} className="lb-segment" onClick={() => onPick(s)}>
          {t(LABEL[s])}
        </button>
      ))}
    </div>
  );
}

/** In the Bot's profile: the current wait (from GET /bots/{bot}) and the 5 choices; a tap saves at once. */
export function ApprovalTimeoutCard({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const id = `timeout-title-${bot}`;
  const [current, setCurrent] = React.useState<ApprovalTimeout | null>(null);
  const [loadError, setLoadError] = React.useState<ErrorState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [saved, setSaved] = React.useState<number | null>(null);
  React.useEffect(() => {
    let alive = true;
    setCurrent(null); setLoadError(null);
    getBot(bot).then((d) => { if (alive) d.approval_timeout ? setCurrent(d.approval_timeout) : setLoadError(t("timeoutUnknown")); },
      (e) => { if (alive) setLoadError(humanError(e, t, "timeoutErrGeneric")); });
    return () => { alive = false; };
  }, [bot, t]);

  async function pick(seconds: number) {
    if (busy || seconds === current?.seconds) return;
    setBusy(true); setError(null); setSaved(null);
    try {
      const r = await setApprovalTimeout(bot, seconds);
      setCurrent({ seconds: r.effective, source: "profile" });
      setSaved(r.effective);
    } catch (e) {
      setError(errorOf(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="lb-headline" style={{ margin: "24px 4px 4px" }}>{t("timeoutTitle")}</h3>
      <p className="lb-subhead" style={{ margin: "0 4px 8px" }}>{t("timeoutIntro")}</p>
      {!current && !loadError && <p className="lb-subhead" style={{ margin: "0 4px" }}>{t("agentLoading")}</p>}
      {loadError && <p role="alert" className="lb-caption" style={{ margin: "0 4px", color: "var(--color-destructive)" }}><ErrorNote error={loadError} /></p>}
      {current && (
        <div className="lb-group" style={{ paddingBottom: 12 }}>
          <Choice id={id} value={current.seconds} busy={busy} onPick={(s) => void pick(s)} />
          <p className="lb-caption" style={{ margin: "6px 16px 0" }}>
            {t(current.source === "profile" ? "timeoutNow" : "timeoutNowDefault", { value: timeoutLabel(current.seconds, t) })}
          </p>
          <p className="lb-caption" style={{ margin: "4px 16px 0" }}>{t("timeoutPendingKeep")}</p>
        </div>
      )}
      {busy && <p role="status" className="lb-caption" style={{ margin: "6px 4px 0" }}>{t("timeoutSaving")}</p>}
      {saved !== null && <p role="status" className="lb-caption" style={{ margin: "6px 4px 0" }}>{t("timeoutSaved", { value: timeoutLabel(saved, t) })}</p>}
      {error && <p role="alert" className="lb-caption" style={{ margin: "6px 4px 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </section>
  );
}

/** In Configurações: one choice applied to every Bot (PUT /approval-timeout), with each Bot's wait today and each result. */
export function ApprovalTimeoutAll({ bots }: { bots: readonly Bot[] }) {
  const { t } = useLuveI18n();
  const id = "timeout-title-all";
  const [chosen, setChosen] = React.useState<number | null>(null);
  const [now, setNow] = React.useState<Record<string, number | "unknown">>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [results, setResults] = React.useState<Array<{ bot: string; seconds?: number; error?: string }> | null>(null);
  const names = bots.map((b) => b.name).join("|");
  const labelOf = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;

  React.useEffect(() => {
    let alive = true;
    for (const b of bots) {
      // a Bot whose wait cannot be read says so, never "…" for ever
      getBot(b.name).then((d) => { if (alive) setNow((m) => ({ ...m, [b.name]: d.approval_timeout ? d.approval_timeout.seconds : "unknown" })); },
        () => { if (alive) setNow((m) => ({ ...m, [b.name]: "unknown" })); });
    }
    return () => { alive = false; };
  }, [names]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function apply() {
    if (chosen === null || busy) return;
    setBusy(true); setError(null); setResults(null);
    try {
      const r = await setApprovalTimeoutAll(chosen);
      setResults(r.results);
      setNow((m) => ({ ...m, ...Object.fromEntries(r.results.filter((x) => typeof x.seconds === "number").map((x) => [x.bot, x.seconds as number])) }));
    } catch (e) {
      setError(errorOf(e, t));
    } finally {
      setBusy(false);
    }
  }

  const ok = results?.filter((r) => typeof r.seconds === "number") ?? [];
  // what was saved, Bot by Bot (the server's answer), never the choice on screen now (F7)
  const savedValues = [...new Set(ok.map((r) => r.seconds as number))];
  const failed = results?.filter((r) => r.error) ?? [];
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="lb-headline" style={{ margin: "24px 4px 4px" }}>{t("timeoutTitle")}</h2>
      <p className="lb-subhead" style={{ margin: "0 4px 8px" }}>{t("timeoutIntro")}</p>
      <div className="lb-group" style={{ paddingBottom: 12 }}>
        <Choice id={id} value={chosen} busy={busy} onPick={setChosen} />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "10px 16px 0" }}>
          <button type="button" className="lb-btn lb-btn-primary" disabled={chosen === null || busy || bots.length === 0} onClick={() => void apply()}>
            {busy ? t("timeoutSaving") : t("timeoutApplyAll")}
          </button>
          <span className="lb-caption">{t("timeoutAllNote")}</span>
        </div>
        {bots.length > 0 && (
          <ul aria-label={t("timeoutNowList")} style={{ listStyle: "none", margin: "10px 16px 0", padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {bots.map((b) => (
              <li key={b.name} className="lb-pill">{labelOf(b.name)}: {now[b.name] === "unknown" ? t("timeoutUnknownShort") : typeof now[b.name] === "number" ? timeoutLabel(now[b.name] as number, t) : "…"}</li>
            ))}
          </ul>
        )}
      </div>
      {ok.length > 0 && <p role="status" className="lb-caption" style={{ margin: "6px 4px 0" }}>{t("timeoutAppliedTo", { n: ok.length, value: savedValues.map((s) => timeoutLabel(s, t)).join(", ") })}</p>}
      {failed.length > 0 && (
        <div role="alert" className="lb-caption" style={{ margin: "6px 4px 0", color: "var(--color-destructive)" }}>
          {t("timeoutFailedFor")}
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {failed.map((r) => <li key={r.bot}>{labelOf(r.bot)}: {t(ERRORS[r.error ?? ""] ?? "timeoutErrGeneric")}</li>)}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="lb-caption" style={{ margin: "6px 4px 0", color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </section>
  );
}
