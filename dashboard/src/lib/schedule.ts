// dashboard/src/lib/schedule.ts
// A Hermes schedule expression in words, for a card that has not been created yet (routine suggestions, contract v0.10 §2.2). It knows only
// the forms Hermes itself writes: `every 30m|2h|1d`, a bare duration (`30m`, once), an ISO timestamp (once), and the 5-field cron it uses for
// "every day at 9", "weekdays at 8", "on these weekdays" and "on day N of the month". Anything else returns null and the caller shows the
// expression as it is: never a guess in words.

import type { TranslationKey } from "../i18n";

type T = (key: TranslationKey, params?: Record<string, string | number>) => string;
type Loc = "pt" | "en";

const UNIT = { m: "min", min: "min", h: "h", hr: "h", d: "d" } as const;
const unitOf = (u: string): "min" | "h" | "d" => UNIT[u.replace(/s$|utes?$|ours?$|ays?$/, "") as keyof typeof UNIT] ?? "min";
const tag = (l: Loc) => (l === "pt" ? "pt-BR" : "en-US");
const num = (s: string) => (/^\d{1,2}$/.test(s) ? Number(s) : NaN);

/** 09:00 in the person's own format; the date is only a carrier for the clock. */
function clock(h: number, m: number, l: Loc): string {
  return new Intl.DateTimeFormat(tag(l), { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, h, m)));
}
/** 0 = Sunday, in the person's language (2024-01-07 is a Sunday). */
const day = (d: number, l: Loc, style: "long" | "short") => new Intl.DateTimeFormat(tag(l), { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d)));

function weekdays(field: string): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    const [from, to] = range ? [Number(range[1]), Number(range[2])] : /^\d$/.test(part) ? [Number(part), Number(part)] : [NaN, NaN];
    if (!(from >= 0 && to <= 7 && from <= to)) return null;   // cron's days are 0-7, both 0 and 7 are Sunday
    for (let d = from; d <= to; d++) out.add(d % 7);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

export function describeSchedule(raw: string | undefined | null, t: T, l: Loc): string | null {
  const expr = String(raw ?? "").trim().toLowerCase();
  if (!expr) return null;

  const every = expr.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (every && Number(every[1]) > 0) {
    const n = Number(every[1]), u = unitOf(every[2]);
    return u === "min" ? t("rsgSchedEveryMin", { n }) : u === "h" ? (n === 1 ? t("rsgSchedHourly") : t("rsgSchedEveryHour", { n })) : n === 1 ? t("rsgSchedEveryDay1") : t("rsgSchedEveryDay", { n });
  }
  const once = expr.match(/^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/);
  if (once && Number(once[1]) > 0) return t("rsgSchedOnceIn", { n: once[1], unit: t(`rsgUnit_${unitOf(once[2])}` as TranslationKey) });
  if (/^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const at = new Date(raw as string);
    return Number.isNaN(at.getTime()) ? null : t("rsgSchedOnceAt", { when: at.toLocaleString(tag(l), { dateStyle: "medium", timeStyle: "short" }) });
  }

  const f = expr.split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, ho, dom, mon, dow] = f;
  const step = (s: string) => s.match(/^\*\/(\d+)$/)?.[1];
  if (mon !== "*") return null;
  if (step(mi) && ho === "*" && dom === "*" && dow === "*") return t("rsgSchedEveryMin", { n: Number(step(mi)) });
  if (mi === "0" && step(ho) && dom === "*" && dow === "*") return t("rsgSchedEveryHour", { n: Number(step(ho)) });
  const m = num(mi), h = num(ho);
  if (mi !== "*" && ho === "*" && dom === "*" && dow === "*" && m === 0) return t("rsgSchedHourly");
  if (!(m >= 0 && m <= 59 && h >= 0 && h <= 23)) return null;
  const time = clock(h, m, l);
  if (dom === "*" && dow === "*") return t("rsgSchedDaily", { time });
  if (dom === "*") {
    const days = weekdays(dow);
    if (!days) return null;
    if (days.join() === "1,2,3,4,5") return t("rsgSchedWeekdays", { time });
    return t("rsgSchedDays", { time, days: new Intl.ListFormat(tag(l), { style: "long", type: "conjunction" }).format(days.map((d) => day(d, l, "short"))) });
  }
  const dd = num(dom);
  return dow === "*" && dd >= 1 && dd <= 31 ? t("rsgSchedMonthDay", { day: dd, time }) : null;
}
