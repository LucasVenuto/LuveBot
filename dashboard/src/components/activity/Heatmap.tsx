// dashboard/src/components/activity/Heatmap.tsx
// Heatmap Bots × hours (spec section 7 item 6; contract v0.8 §2): when each Bot starts work, by hour of the day, over the
// last 7, 28 or 90 days. Draws what GET /activity/heatmap returns. It is a real table (a row per Bot, a column per hour), so a
// screen reader reads each count; the square's strength is the Bot's own color, and the exact number is always in the label.

import React, { useMemo } from "react";
import type { Bot, HeatmapResponse } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { displayName } from "../../lib/botName";
import { Avatar } from "../ui/Avatar";
import { tint } from "../ui/color";
import { displayFace } from "../ui/mascots";
import { ClockIcon } from "../Icons";

export const HEATMAP_DAYS = [7, 28, 90] as const;
export type HeatmapDays = (typeof HEATMAP_DAYS)[number];

export interface HeatmapProps {
  data: HeatmapResponse;
  days: HeatmapDays;
  onDaysChange?: (days: HeatmapDays) => void;
  bots?: Bot[];
  /** The time zone the hours were counted in, shown under the title. */
  tz?: string;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/** Strength of a square: none for 0, then 16% to 88% of the Bot's color. Square root, so a few runs still show. */
export const heatPct = (count: number, max: number) => (count > 0 && max > 0 ? Math.round(16 + 72 * Math.sqrt(Math.min(1, count / max))) : 0);

export function Heatmap({ data, days, onDaysChange, bots = [], tz }: HeatmapProps) {
  const { t } = useLuveI18n();
  const byName = useMemo(() => new Map(bots.map((b) => [b.name, b])), [bots]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data.cells) m.set(`${c.bot}:${c.hour}`, (m.get(`${c.bot}:${c.hour}`) ?? 0) + c.count);
    return m;
  }, [data]);

  const picker = (
    <div className="lb-segmented lb-segmented-fit lb-hm-days" role="group" aria-label={t("hmDaysLabel")}>
      {HEATMAP_DAYS.map((d) => (
        <button key={d} type="button" className="lb-segment" aria-pressed={d === days} onClick={() => onDaysChange?.(d)} data-testid={`hm-days-${d}`}>
          {t("hmDays", { n: d })}
        </button>
      ))}
    </div>
  );

  if (!data.bots.length || data.max <= 0) {
    return (
      <div className="lb-hm">
        {picker}
        <div className="lb-group lb-empty" data-testid="heatmap-empty">
          <span className="lb-empty-icon" aria-hidden="true"><ClockIcon size={20} /></span>
          <p className="lb-headline">{t("hmEmptyTitle")}</p>
          <p className="lb-subhead">{t("hmEmptyHint", { n: days })}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="lb-hm" data-testid="heatmap">
      {picker}
      <div className="lb-group lb-hm-scroll">
        <table className="lb-hm-table">
          <caption className="lb-subhead">{tz ? t("hmCaptionTz", { n: days, tz }) : t("hmCaption", { n: days })}</caption>
          <thead>
            <tr>
              <th scope="col"><span className="lb:sr-only">{t("hmBotColumn")}</span></th>
              {HOURS.map((h) => (
                <th key={h} scope="col" className={`lb-caption${h % 6 ? " lb-hm-minor" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.bots.map((name) => {
              const b = byName.get(name), label = displayName(name, b?.display?.label), color = b?.display?.color ?? null;
              return (
                <tr key={name}>
                  <th scope="row" className="lb-hm-who">
                    <Avatar name={label} avatar={displayFace(name, b?.display?.avatar)} color={color} size={24} />
                    <span className="lb-hm-name">{label}</span>
                  </th>
                  {HOURS.map((h) => {
                    const n = counts.get(`${name}:${h}`) ?? 0, pct = heatPct(n, data.max), text = t("hmCell", { bot: label, hour: h, n });
                    return (
                      <td key={h} title={text} data-testid={`hm-${name}-${h}`} data-count={n}>
                        <span className="lb-hm-cell" style={pct ? { background: tint(color, pct) } : undefined} aria-hidden="true" />
                        <span className="lb:sr-only">{text}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="lb-hm-legend lb-caption" aria-hidden="true">
          <span>{t("hmLess")}</span>
          {[0, 0.06, 0.25, 0.56, 1].map((f) => <span key={f} className="lb-hm-cell" style={f ? { background: `color-mix(in srgb, var(--color-foreground) ${heatPct(f, 1)}%, transparent)` } : undefined} />)}
          <span>{t("hmMore")}</span>
        </div>
      </div>
    </div>
  );
}
