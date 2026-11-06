// dashboard/src/components/costs/Projection.tsx
// The month's spend projected to its end (contract v0.8 §7). A number and a sentence, NEVER an alarm: the cap stays the only thing that
// pauses (invariant 7), so nothing here is red, nothing says "paused", and the note under it says so. Drawn from what GET /costs returns:
// `projection` (global) and `projection_by_bot`. With too little data the backend sends null and the card says so in words.

import React from "react";
import type { CostsProjection } from "../../api/types";
import { useLuveI18n } from "../../i18n";

const lang = (locale: string) => (locale === "pt" ? "pt-BR" : "en-US");

/** "2026-10" → "outubro de 2026"; "2026-10-23" → "23 de outubro". Built from the parts, so the viewer's time zone never moves the day. */
export function monthName(month: string, locale: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(lang(locale), { month: "long", year: "numeric" });
}
export function dayName(day: string, locale: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang(locale), { day: "numeric", month: "long" });
}

export function ProjectionCard({ projection, format }: { projection: CostsProjection; format: (cents: number) => string }) {
  const { t, locale } = useLuveI18n();
  const p = projection;
  return (
    <div data-testid="projection-card" className="lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:flex-col lb:gap-1.5">
      <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">{t("projTitle")}</span>
      {p.projected_cents === null ? (
        <>
          <span data-testid="projection-none" className="lb:text-[15px] lb:font-semibold lb:text-[var(--color-foreground)]">{t("projNoData")}</span>
          <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">{t("projNoDataHint")}</span>
        </>
      ) : (
        <>
          <span data-testid="projection-amount" className="lb:text-2xl lb:tabular-nums lb:font-bold lb:text-[var(--color-foreground)]">{format(p.projected_cents)}</span>
          <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">{t("projLead", { month: monthName(p.month, locale) })}</span>
        </>
      )}
      <span className="lb:text-[13px] lb:tabular-nums lb:text-[var(--color-foreground)]">{t("projSoFar", { amount: format(p.spent_cents) })}</span>
      {p.cap_cents !== null && p.projected_cents !== null && (
        <span data-testid="projection-cap" className="lb:text-[13px] lb:text-[var(--color-foreground)]">
          {p.crosses_cap_on
            ? t("projCrosses", { cap: format(p.cap_cents), date: dayName(p.crosses_cap_on, locale) })
            : t("projWithin", { cap: format(p.cap_cents) })}
        </span>
      )}
      {p.projected_cents !== null && <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">{t("projBasis", { n: p.basis_days })}</span>}
      <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">{t("projNote")}</span>
    </div>
  );
}

/** The per-Bot cell of the table: the number, or a dash that says why in its title. */
export function ProjectionCell({ projection, format }: { projection: CostsProjection | undefined; format: (cents: number) => string }) {
  const { t } = useLuveI18n();
  if (!projection) return <>–</>;
  if (projection.projected_cents === null) return <span title={t("projNoData")}>–<span className="lb:sr-only">{t("projNoData")}</span></span>;
  return <>{format(projection.projected_cents)}</>;
}
