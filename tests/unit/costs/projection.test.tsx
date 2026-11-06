// tests/unit/costs/projection.test.tsx
// Projeção do mês em Custos (contract v0.8 §7): `projection` and `projection_by_bot` of GET /costs, drawn as a number and a sentence,
// NEVER as an alarm (the cap is the only thing that pauses: invariant 7). Too little data says so in words, the cap sentence says
// whether the pace reaches it and when, the per-Bot column follows the "by Bot" grouping, and a backend without the field shows nothing.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CostsView, formatCents } from "@/components/costs";
import { dayName, monthName } from "@/components/costs/Projection";
import { setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { CostsProjection, CostsResponse } from "@/api/types";

const P = (over: Partial<CostsProjection> = {}): CostsProjection => ({
  month: "2026-10", spent_cents: 1000, projected_cents: 3000, cap_cents: 3000, crosses_cap_on: "2026-10-30", basis_days: 7, ...over,
});
const costs = (over: Partial<CostsResponse> = {}): CostsResponse => ({
  period: "day", currency: "USD", totals: { spend_cents: 4520, unpriced_sessions: 0 },
  groups: [{ key: "vendas", spend_cents: 2500, tokens: 45000, sessions: 12 }, { key: "dev", spend_cents: 2020, tokens: 32000, sessions: 8 }],
  ledger: { lag_s: 15, watcher_stale: false },
  projection: P(), projection_by_bot: { vendas: P({ projected_cents: 2000 }), dev: P({ projected_cents: null }) },
  ...over,
});
const view = (c: CostsResponse) => render(<CostsView authMode="gated" initialCosts={c} initialBudget={{ limits: [], paused: [], watcher: { last_at: 1, stale: false }, alerts: [] } as never} />);
const card = () => screen.getByTestId("projection-card");

beforeEach(() => { cleanup(); setLuveLocale("pt"); setCustomFetchJSON(async () => ({})); });
afterEach(() => { cleanup(); });

describe("o cartão da projeção", () => {
  it("shows the month's projected spend, what was spent, the cap and the day the pace reaches it", () => {
    view(costs());
    expect(within(card()).getByTestId("projection-amount").textContent).toBe(formatCents(3000, "pt"));
    expect(card().textContent).toContain("até o fim de outubro de 2026");
    expect(card().textContent).toContain(`Gasto até agora: ${formatCents(1000, "pt")}`);
    expect(within(card()).getByTestId("projection-cap").textContent).toBe(`No ritmo atual, chega ao teto de ${formatCents(3000, "pt")} em 30 de outubro.`);
    expect(card().textContent).toContain("Média dos últimos 7 dias deste mês.");
  });

  it("says the pace stays under the cap when it does not reach it, and says nothing about a cap when there is none", () => {
    view(costs({ projection: P({ projected_cents: 1800, crosses_cap_on: null }) }));
    expect(within(card()).getByTestId("projection-cap").textContent).toBe(`No ritmo atual, fica abaixo do teto de ${formatCents(3000, "pt")}.`);
    cleanup();
    view(costs({ projection: P({ cap_cents: null, crosses_cap_on: null }) }));
    expect(screen.queryByTestId("projection-cap")).toBeNull();
    expect(within(card()).getByTestId("projection-amount")).toBeDefined();
  });

  it("with too little data it says so in words and shows no number to project", () => {
    view(costs({ projection: P({ projected_cents: null, crosses_cap_on: null, basis_days: 2 }) }));
    expect(within(card()).getByTestId("projection-none").textContent).toBe("Poucos dados para projetar");
    expect(card().textContent).toContain("Precisa de gasto em pelo menos 3 dias neste mês.");
    expect(screen.queryByTestId("projection-amount")).toBeNull();
    expect(screen.queryByTestId("projection-cap")).toBeNull();
    expect(card().textContent).toContain(`Gasto até agora: ${formatCents(1000, "pt")}`);
  });

  it("is information, never an alarm: no alert role, no warning or destructive color, and it says only the cap pauses", () => {
    view(costs({ projection: P({ spent_cents: 2900, projected_cents: 6000, crosses_cap_on: "2026-10-12" }) }));
    expect(within(card()).queryByRole("alert")).toBeNull();
    expect(card().innerHTML).not.toMatch(/destructive|warning|danger/);
    expect(card().textContent).not.toMatch(/pausad|pausar|pausou|pausará/i);
    expect(card().textContent).toContain("É uma estimativa: só o teto pausa Bots.");
  });

  it("speaks English", () => {
    setLuveLocale("en");
    view(costs());
    expect(card().textContent).toContain("Month projection");
    expect(card().textContent).toContain("by the end of October 2026");
    expect(within(card()).getByTestId("projection-cap").textContent).toBe(`At the current pace it reaches the ${formatCents(3000, "en")} cap on October 30.`);
    expect(card().textContent).toContain("It is an estimate: only the cap pauses Bots.");
  });

  it("a day is read from its parts: the viewer's time zone never moves it", () => {
    const keep = process.env.TZ;
    try {
      for (const tz of ["America/Sao_Paulo", "Pacific/Auckland"]) {
        process.env.TZ = tz;
        expect(dayName("2026-10-01", "pt")).toBe("1 de outubro");
        expect(monthName("2026-10", "pt")).toBe("outubro de 2026");
      }
    } finally { if (keep === undefined) delete process.env.TZ; else process.env.TZ = keep; }
  });
});

describe("a coluna por Bot", () => {
  it("each Bot's projection beside its spend; a Bot with too little data gets a dash that says why", () => {
    view(costs());
    expect(screen.getByRole("columnheader", { name: "Projeção do mês" })).toBeDefined();
    expect(screen.getByTestId("cost-group-projection-vendas").textContent).toBe(formatCents(2000, "pt"));
    const none = screen.getByTestId("cost-group-projection-dev");
    expect(none.textContent).toContain("–");
    expect(none.textContent).toContain("Poucos dados para projetar");
  });

  it("belongs to the 'by Bot' grouping: grouped by model there is no column", () => {
    view(costs());
    fireEvent.change(screen.getAllByRole("combobox").find((s) => [...(s as HTMLSelectElement).options].some((o) => o.value === "model"))!, { target: { value: "model" } });
    expect(screen.queryByRole("columnheader", { name: "Projeção do mês" })).toBeNull();
    expect(screen.queryByTestId("cost-group-projection-vendas")).toBeNull();
    expect(screen.getByTestId("projection-card")).toBeDefined();       // the month's card stays
  });

  it("a backend before v0.8 (no projection fields) shows no card and no column", () => {
    const old = costs(); delete old.projection; delete old.projection_by_bot;
    view(old);
    expect(screen.queryByTestId("projection-card")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Projeção do mês" })).toBeNull();
    expect(screen.getByTestId("total-spend-card")).toBeDefined();
  });
});
