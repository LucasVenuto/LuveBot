// tests/unit/costs/plan-quota-down.test.tsx
// F6.1: a quota that cannot be read never disturbs Custos. In its own file because the last read is kept for a minute per page: here
// the very first read fails, so there is nothing to show (a later failure keeps what was known).
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CostsView } from "@/components/costs";
import { setCustomFetchJSON } from "@/api/client";

describe("quota down", () => {
  it("the first read fails: no quota section, Custos is whole, no alert, and it does not hammer (one ask)", async () => {
    let asks = 0;
    setCustomFetchJSON(async (url: string) => { if (url.includes("/costs/quota")) { asks++; throw new Error("down"); } throw new Error("unexpected " + url); });
    try {
      render(<CostsView authMode="gated" bots={[]} initialCosts={{ period: "day", currency: "USD", totals: { spend_cents: 100, unpriced_sessions: 0 }, groups: [], ledger: { lag_s: 1, watcher_stale: false } } as any}
        initialBudget={{ limits: [], paused: [], watcher: { last_at: null }, alerts: [] } as any} />);
      expect(screen.getByTestId("costs-view")).toBeTruthy();
      await new Promise((r) => setTimeout(r, 60));
      expect(screen.queryByTestId("plan-quota")).toBeNull();
      expect(within(screen.getByTestId("costs-view")).queryByRole("alert")).toBeNull();
      expect(asks).toBe(1);
    } finally { setCustomFetchJSON(null); }
  });
});
