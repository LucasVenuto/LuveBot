// dashboard/src/components/costs/PlanQuota.tsx
// "Cota do plano" in Custos (F6.1): what Hermes reports per provider ("17% left, renews at 15:00"). INFORMATION ONLY: neutral colors, no
// lock, no alarm; what pauses a Bot stays the spending cap (invariant 7). Every number, name and time is the backend's, read from
// Hermes (text, never markup); a provider with no usage and no limit is not listed. It never disturbs the rest of Custos: a failed read
// shows nothing, and `available: false` or no provider says why in one quiet line (invariant 9: say it, do not hide it).
// Each read makes Hermes call the providers with the Bot's credential, so: only with Custos open and the tab visible, never more than
// once a minute (a remount or a Bot filter reuses the last read; the filter is applied here, not by asking again).

import React from "react";
import { getCostsQuota } from "../../api/client";
import type { PlanQuotaResponse, QuotaProvider, QuotaWindow, QuotaAccountState } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";

const STATE: Record<QuotaAccountState, TranslationKey> = {
  ready: "quotaStateReady", limited: "quotaStateLimited", unknown: "quotaStateUnknown", unavailable: "quotaStateUnavailable",
};
const MORE_MODELS = 3;
const MIN_MS = 60_000;   // never read more often than this
const POLL_MS = 61_000;  // while Custos is visible: the first read often comes without usage (Hermes warms it in the background)

// ponytail: one read per minute for the whole page, kept across remounts; a per-Bot cache only if Bots ever need different freshness
let attemptAt = 0;
let last: PlanQuotaResponse | null = null;
let flight: Promise<void> | null = null;
async function readQuota(): Promise<PlanQuotaResponse | null> {
  if (Date.now() - attemptAt >= MIN_MS) {
    attemptAt = Date.now();  // a failed read counts too: no hammering a Hermes that is down
    flight ??= getCostsQuota().then(
      (q) => { if (Array.isArray(q?.bots)) last = { ...q, bots: q.bots.filter((b) => Array.isArray(b?.providers)) }; },
      () => { /* never disturbs Custos: what was known stays */ },
    ).finally(() => { flight = null; });
  }
  await flight;
  return last;
}

/** Providers with the same slug, usage and limit in several Bots are one chip (the same account): `bots` says whose. */
export function groupProviders(bots: PlanQuotaResponse["bots"]) {
  const groups = new Map<string, QuotaProvider & { bots: string[] }>();
  for (const b of bots) for (const p of b.providers) {
    const key = JSON.stringify([p.slug, p.usage, p.limit]);
    const g = groups.get(key);
    if (g) g.bots.push(b.bot); else groups.set(key, { ...p, bots: [b.bot] });
  }
  return [...groups.values()];
}

export function PlanQuota({ bot, labelOf }: { bot?: string; labelOf?: (name: string) => string }) {
  const { locale, t } = useLuveI18n();
  const [all, setAll] = React.useState<PlanQuotaResponse | null>(last);
  React.useEffect(() => {
    let alive = true;
    const load = () => { if (document.visibilityState !== "hidden") void readQuota().then((q) => { if (alive && q) setAll(q); }); };
    load();
    const id = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);  // back on the tab: the minute's rule still decides whether it reads
    return () => { alive = false; window.clearInterval(id); document.removeEventListener("visibilitychange", load); };
  }, []);
  if (!all) return null;
  const quota = bot ? { ...all, bots: all.bots.filter((b) => b.bot === bot) } : all;

  const loc = locale === "pt" ? "pt-BR" : "en-US";
  const when = (epoch: number | null | undefined): string | null => {
    if (epoch == null) return null;
    const d = new Date(epoch * 1000);
    const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t("quotaAt", { time }) : t("quotaOn", { date: d.toLocaleDateString(loc, { day: "numeric", month: "short" }), time });
  };
  const renews = (epoch: number | null | undefined) => { const w = when(epoch); return w ? t("quotaRenews", { when: w }) : null; };
  const pct = (n: number) => n.toLocaleString(loc, { maximumFractionDigits: 1 });
  const nameOf = (b: string) => labelOf?.(b) ?? b;

  const windowRow = (w: QuotaWindow, i: number) => (
    <div key={i} style={{ marginTop: 6 }}>
      <div className="lb-caption" style={{ color: "var(--color-foreground)" }}>
        {t("quotaLeft", { label: w.label || t("quotaTitle"), percent: pct(w.remaining_percent) })}{renews(w.resets_at) ? ` · ${renews(w.resets_at)}` : ""}
      </div>
      <div aria-hidden="true" style={{ height: 4, borderRadius: 2, marginTop: 3, background: "var(--lb-fill)", overflow: "hidden" }}>
        <div style={{ width: `${Math.max(0, Math.min(100, w.remaining_percent))}%`, height: "100%", background: "var(--color-primary)" }} />
      </div>
    </div>
  );

  const body = (p: QuotaProvider) => {
    const u = p.usage;
    return (
      <>
        {u && "windows" in u && u.windows.map(windowRow)}
        {u && "accounts" in u && u.accounts.map((a, i) => (
          <div key={i} style={{ marginTop: 6 }}>
            <div className="lb-caption" style={{ fontWeight: 600 }}>{t("quotaAccount", { n: i + 1 })}: {t(STATE[a.state] ?? "quotaStateUnknown")}{renews(a.resets_at) ? ` · ${renews(a.resets_at)}` : ""}</div>
            {a.windows.map(windowRow)}
          </div>
        ))}
        {p.limit?.scope === "account" && (
          <div className="lb-caption" style={{ marginTop: 6 }}>{t("quotaLimitAccount")}{renews(p.limit.resets_at) ? `; ${renews(p.limit.resets_at)}` : ""}.</div>
        )}
        {p.limit?.scope === "models" && (() => {
          const rows = Object.entries(p.limit.models);
          const shown = rows.slice(0, MORE_MODELS).map(([m, at]) => `${m}${renews(at) ? ` (${renews(at)})` : ""}`);
          if (rows.length > MORE_MODELS) shown.push(t("quotaMore", { n: rows.length - MORE_MODELS }));
          return <div className="lb-caption" style={{ marginTop: 6 }}>{t("quotaLimitModels", { list: shown.join(", ") })}</div>;
        })()}
      </>
    );
  };

  const chips = groupProviders(quota.bots);
  return (
    <section data-testid="plan-quota" aria-labelledby="plan-quota-title" className="lb:rounded-2xl" style={{ padding: 12, background: "var(--lb-fill)" }}>
      <h3 id="plan-quota-title" className="lb-headline" style={{ margin: 0 }}>{t("quotaTitle")}</h3>
      <p className="lb-caption" style={{ margin: "2px 0 0", color: "var(--color-muted-foreground)" }}>{t("quotaNote")}</p>
      {(!quota.available || chips.length === 0) && (
        <p data-testid="plan-quota-why" className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-muted-foreground)" }}>
          {t(!quota.available ? (quota.reason === "hermes_without_quota" ? "quotaWithout" : "quotaUnreadable") : "quotaNone")}
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8 }}>
        {chips.map((p, i) => (
          <div key={i} data-testid="quota-chip" style={{ flex: "1 1 220px", maxWidth: 360, padding: "10px 12px", borderRadius: 14, background: "var(--color-card)", border: "1px solid var(--lb-separator)" }}>
            <div className="lb-body" style={{ fontWeight: 600 }}>{p.name}</div>
            {chips.filter((x) => x.slug === p.slug).length > 1 && (
              <div className="lb-caption" style={{ color: "var(--color-muted-foreground)" }}>{t("quotaBots", { list: p.bots.map(nameOf).join(", ") })}</div>
            )}
            {body(p)}
          </div>
        ))}
      </div>
      {quota.available && quota.stale && <p className="lb-caption" style={{ margin: "8px 0 0", color: "var(--color-muted-foreground)" }}>{t("quotaStale")}</p>}
    </section>
  );
}
