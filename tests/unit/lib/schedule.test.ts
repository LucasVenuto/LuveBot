// tests/unit/lib/schedule.test.ts
// describeSchedule (lib/schedule.ts): a Hermes schedule in words for a card that does not exist yet. Only the forms Hermes writes; anything else
// is null (the card then shows the expression as it is), never a guess.
import { describe, it, expect } from "vitest";
import { describeSchedule } from "@/lib/schedule";
import { translations } from "@/i18n";

const tr = (l: "pt" | "en") => (key: string, params: Record<string, string | number> = {}) =>
  String((translations[l] as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params[k]));
const pt = (e: string | null | undefined) => describeSchedule(e, tr("pt") as never, "pt");
const en = (e: string | null | undefined) => describeSchedule(e, tr("en") as never, "en");

describe("describeSchedule", () => {
  it("every N minutes, hours, days", () => {
    expect(pt("every 30m")).toBe("A cada 30 min");
    expect(pt("every 2h")).toBe("A cada 2 h");
    expect(pt("every 1h")).toBe("A cada hora");
    expect(pt("every 1d")).toBe("Todo dia");
    expect(pt("every 3 days")).toBe("A cada 3 dias");
    expect(en("every 90 minutes")).toBe("Every 90 min");
    expect(en("Every 1 hour")).toBe("Every hour");
  });

  it("a bare duration is once, from now", () => {
    expect(pt("30m")).toBe("Uma vez, daqui a 30 min");
    expect(en("2h")).toBe("Once, in 2 h");
  });

  it("an ISO timestamp is once, at that moment", () => {
    expect(pt("2026-11-02T09:30:00")).toMatch(/^Uma vez, em .*2026.*09:30/);
    expect(describeSchedule("2026-13-45T99:00", tr("pt") as never, "pt")).toBeNull();
  });

  it("cron: every day, weekdays, chosen weekdays, a day of the month, steps", () => {
    expect(pt("0 9 * * *")).toBe("Todo dia, às 09:00");
    expect(en("30 8 * * *")).toBe("Every day at 08:30 AM");
    expect(pt("0 8 * * 1-5")).toBe("De segunda a sexta, às 08:00");
    expect(en("0 8 * * 1-5")).toBe("Monday to Friday at 08:00 AM");
    expect(pt("15 18 * * 1,3,5")).toBe("Às 18:15, em seg., qua. e sex.");
    expect(pt("0 7 * * 0")).toBe("Às 07:00, em dom.");
    expect(pt("0 7 * * 7")).toBe("Às 07:00, em dom.");
    expect(pt("0 9 15 * *")).toBe("Todo dia 15 do mês, às 09:00");
    expect(pt("*/15 * * * *")).toBe("A cada 15 min");
    expect(pt("0 */6 * * *")).toBe("A cada 6 h");
    expect(pt("0 * * * *")).toBe("A cada hora");
  });

  it("anything it does not know is null, never a wrong sentence", () => {
    for (const odd of ["", "  ", null, undefined, "@daily", "0 9 * 6 *", "0 9 1-3 * *", "61 9 * * *", "0 25 * * *", "0 9 * * 9", "0 9 * *", "every other day", "0 9 15 * 1"]) expect(pt(odd as never), String(odd)).toBeNull();
  });
});
