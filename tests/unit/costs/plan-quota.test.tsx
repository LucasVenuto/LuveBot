// tests/unit/costs/plan-quota.test.tsx
// F6.1: the "Cota do plano" in Custos. What Hermes reports per provider, as INFORMATION: neutral, never an alarm, never a gate (the cap of
// invariant 7 is what pauses a Bot). Everything shown is the backend's: names and labels are text, a pool's accounts have no name,
// `available: false` or no provider says why in one quiet line, and a failed read leaves the rest of Custos alone. Each read makes Hermes
// call the providers: at most once a minute, only with the tab visible (the Bot filter is applied here, it does not ask again).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent, act, configure } from "@testing-library/react";
import { PlanQuota, groupProviders } from "@/components/costs/PlanQuota";
import { CostsView } from "@/components/costs";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { PlanQuotaResponse, QuotaProvider } from "@/api/types";

const todayAt = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime() / 1000; };
const tomorrowAt = (h: number) => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(h, 0, 0, 0); return d.getTime() / 1000; };
const hhmm = (e: number, loc = "pt-BR") => new Date(e * 1000).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
const win = (label: string, remaining: number, resets_at: number | null = todayAt(23, 59)) => ({ label, scope: "account", used_percent: 100 - remaining, remaining_percent: remaining, resets_at });
const prov = (over: Partial<QuotaProvider> = {}): QuotaProvider => ({ slug: "anthropic", name: "Claude", usage: { windows: [win("Semanal", 17)] }, limit: null, ...over });
const quota = (bots: Array<[string, QuotaProvider[]]>, over: Partial<PlanQuotaResponse> = {}): PlanQuotaResponse =>
  ({ available: true, reason: null, fetched_at: 1, stale: false, bots: bots.map(([bot, providers]) => ({ bot, providers })), ...over });
function backend(q: PlanQuotaResponse | Error, urls: string[] = []) {
  setCustomFetchJSON(async (url: string) => {
    if (url.includes("/costs/quota")) { urls.push(url); if (q instanceof Error) throw q; return q; }
    throw new Error("unexpected " + url);
  });
}

// A test waits for a state with findBy/waitFor and moves on the moment it holds; these ceilings only matter on a loaded machine (the CEO's
// reached load 240): the default 1 s per wait and 5 s per test are about the machine, not about what the test proves.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// The last read is kept for a minute across remounts (the rule, module state), so what is on screen FIRST can be the PREVIOUS test's chip:
// on a loaded machine the new read lands after the first check. Each test therefore waits for text only ITS fixture has, never for "a chip".
const chipHas = (text: string) => waitFor(() => expect(screen.getByTestId("quota-chip").textContent).toContain(text));

// Each test starts a minute later on a faked clock.
let clock = new Date("2026-10-20T10:00:00").getTime();
beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); clock += 61_000; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.useRealTimers(); });

describe("Cota do plano", () => {
  it("says what is left and when it renews, from the backend's numbers only; a later day carries its date", async () => {
    backend(quota([["vendas", [prov({ usage: { windows: [win("Semanal", 17, todayAt(23, 59)), win("5 horas", 62.5, tomorrowAt(8))] } })]]]));
    render(<PlanQuota />);
    await chipHas(`Semanal: 17% restante · renova às ${hhmm(todayAt(23, 59))}`);
    const chip = screen.getByTestId("quota-chip");
    expect(chip.textContent).toContain("Claude");
    expect(chip.textContent).toContain("5 horas: 62,5% restante · renova em ");           // pt-BR decimal; another day: with its date
    expect(screen.getByText("Só informação, vinda do Hermes. O que pausa um Bot é o teto de gasto.")).toBeTruthy();
  });

  it("is information, never an alarm: no alert role and no destructive color, even at 0% left or at the provider's limit", async () => {
    backend(quota([["vendas", [prov({ usage: { windows: [win("Semanal", 0)] }, limit: { scope: "account", resets_at: todayAt(23, 59) } })]]]));
    render(<PlanQuota />);
    await waitFor(() => expect(screen.getByTestId("plan-quota").textContent).toContain("Semanal: 0% restante"));
    const sec = screen.getByTestId("plan-quota");
    expect(sec.querySelector("[role=alert]")).toBeNull();
    expect(sec.innerHTML).not.toMatch(/destructive|warning/);
    expect(sec.textContent).toContain("Semanal: 0% restante");
    expect(sec.textContent).toContain(`No limite do provedor; renova às ${hhmm(todayAt(23, 59))}.`);
  });

  it("names and labels are Hermes's text: a name that looks like markup stays text", async () => {
    backend(quota([["vendas", [prov({ name: "<img src=x onerror=alert(1)>", usage: { windows: [win("<b>5h</b>", 40)] } })]]]));
    render(<PlanQuota />);
    await chipHas("<img src=x onerror=alert(1)>");
    const chip = screen.getByTestId("quota-chip");
    expect(chip.textContent).toContain("<b>5h</b>: 40% restante");
    expect(chip.querySelector("img, b")).toBeNull();
  });

  it("a pool of accounts: one unnamed row each, with its state in words", async () => {
    backend(quota([["vendas", [prov({ usage: { accounts: [
      { state: "ready", windows: [win("Semanal", 80)], resets_at: null },
      { state: "limited", windows: [], resets_at: todayAt(23, 59) }] } })]]]));
    render(<PlanQuota />);
    await chipHas("Conta 1: disponível");
    const chip = screen.getByTestId("quota-chip");
    expect(chip.textContent).toContain(`Conta 2: no limite · renova às ${hhmm(todayAt(23, 59))}`);
    expect(chip.textContent).toContain("Semanal: 80% restante");
  });

  it("models at the provider's limit: up to three, then 'e mais N'", async () => {
    const models = Object.fromEntries(["m1", "m2", "m3", "m4", "m5"].map((m) => [m, todayAt(23, 59)]));
    backend(quota([["vendas", [prov({ usage: null, limit: { scope: "models", models } })]]]));
    render(<PlanQuota />);
    await chipHas("Modelos no limite do provedor: m1 (renova às");
    const t = screen.getByTestId("quota-chip").textContent!;
    expect(t).toContain("m3 (renova");
    expect(t).not.toContain("m4");
    expect(t).toContain("e mais 2.");
  });

  it("the same account in several Bots is ONE chip; different accounts of one provider are separate chips that say whose", async () => {
    const a = prov(), b = prov({ usage: { windows: [win("Semanal", 55)] } });
    expect(groupProviders(quota([["vendas", [a]], ["dev", [a]], ["pesq", [b]]]).bots).map((g) => g.bots)).toEqual([["vendas", "dev"], ["pesq"]]);
    backend(quota([["vendas", [a]], ["dev", [a]]]));
    const r = render(<PlanQuota labelOf={(n) => n.toUpperCase()} />);
    await chipHas("Semanal: 17%");                                                        // this test's read, not the previous test's chip
    expect(screen.getAllByTestId("quota-chip")).toHaveLength(1);
    expect(screen.queryByText(/^Bots:/)).toBeNull();                                      // one account: no need to say whose
    r.unmount();
    vi.setSystemTime(clock += 61_000);                                                    // a minute later: a new read
    backend(quota([["vendas", [a]], ["dev", [b]]]));
    render(<PlanQuota labelOf={(n) => n.toUpperCase()} />);
    await waitFor(() => expect(screen.getAllByTestId("quota-chip")).toHaveLength(2));
    expect(screen.getByText("Bots: VENDAS")).toBeTruthy();
    expect(screen.getByText("Bots: DEV")).toBeTruthy();
  });

  it("not available says why, quietly; available with no provider says 'nenhum provedor informa cota' (not an error)", async () => {
    backend(quota([], { available: false, reason: "hermes_without_quota" }));
    const r = render(<PlanQuota />);
    await waitFor(() => expect(screen.getByTestId("plan-quota-why").textContent).toBe("Este Hermes não informa a cota do plano."));
    r.unmount();
    vi.setSystemTime(clock += 61_000);
    backend(quota([], { available: false, reason: "unreadable" }));
    const r2 = render(<PlanQuota />);
    await waitFor(() => expect(screen.getByTestId("plan-quota-why").textContent).toBe("Não foi possível ler a cota do plano agora."));
    r2.unmount();
    vi.setSystemTime(clock += 61_000);
    backend(quota([["vendas", []]]));
    render(<PlanQuota />);
    await waitFor(() => expect(screen.getByTestId("plan-quota-why").textContent).toBe("Nenhum provedor informa cota do plano."));
    expect(screen.queryByTestId("quota-chip")).toBeNull();
    expect(screen.getByTestId("plan-quota").querySelector("[role=alert]")).toBeNull();
  });

  it("stale values say so", async () => {
    backend(quota([["vendas", [prov()]]], { stale: true }));
    render(<PlanQuota />);
    await screen.findByText("Valores de alguns minutos atrás; o Hermes ainda está atualizando.");
  });

  it("asks Hermes at most once a minute: a remount or another Bot filter reuses the last read; a minute later it asks again", async () => {
    const urls: string[] = [];
    backend(quota([["vendas", [prov()]], ["dev", [prov({ slug: "openai", name: "OpenAI" })]]]), urls);
    const r = render(<PlanQuota />);
    await waitFor(() => expect(screen.getAllByTestId("quota-chip")).toHaveLength(2));       // this test's two providers, not the previous test's one
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/costs\/quota$/);                                       // always every Bot: the filter is applied here
    r.rerender(<PlanQuota bot="dev" />);
    await waitFor(() => expect(screen.getAllByTestId("quota-chip")).toHaveLength(1));
    expect(screen.getByTestId("quota-chip").textContent).toContain("OpenAI");
    r.unmount();
    vi.setSystemTime(clock += 30_000);
    render(<PlanQuota />);                                                               // back to Custos 30 s later
    await screen.findAllByTestId("quota-chip");
    expect(urls).toHaveLength(1);
    cleanup();
    vi.setSystemTime(clock += 31_000);                                                    // 61 s after the read
    render(<PlanQuota />);
    await waitFor(() => expect(urls).toHaveLength(2));
  });

  it("while Custos stays open and visible it reads again after a minute; with the tab hidden it does not read at all", async () => {
    const urls: string[] = [];
    backend(quota([["vendas", [prov()]]]), urls);
    vi.useRealTimers();                                                                   // from the clock-only fake to the full one
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(clock);
    render(<PlanQuota />);
    await waitFor(() => expect(urls).toHaveLength(1));                                    // its own read (a chip may be the previous test's)
    await chipHas("Semanal: 17%");
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(urls).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(32_000); });
    await waitFor(() => expect(urls).toHaveLength(2));
    cleanup();
    vi.setSystemTime(clock += 200_000);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      render(<PlanQuota />);
      await act(async () => { vi.advanceTimersByTime(130_000); });
      expect(urls).toHaveLength(2);                                                      // hidden: nothing was asked
    } finally { hidden.mockRestore(); }
  });

  it("in English", async () => {
    setLuveLocale("en");
    backend(quota([["vendas", [prov({ usage: { windows: [win("Weekly", 17)] } })]]]));
    render(<PlanQuota />);
    await chipHas("Weekly: 17% left · renews at ");
    expect(screen.getByText("Plan quota")).toBeTruthy();
  });
});

describe("in Custos", () => {
  const costs = { period: "day", currency: "USD", totals: { spend_cents: 100, unpriced_sessions: 0 }, groups: [], ledger: { lag_s: 1, watcher_stale: false } } as any;
  const budget = { limits: [], paused: [], watcher: { last_at: null }, alerts: [] } as any;
  const bots = [{ name: "vendas", display: { label: "Vendas" } }, { name: "dev", display: { label: "Dev" } }] as any[];

  it("shows under the filters, applies the chosen Bot without asking again, and a Custos with no quota still works", async () => {
    const urls: string[] = [];
    backend(quota([["vendas", [prov()]], ["dev", [prov({ slug: "openai", name: "OpenAI" })]]]), urls);
    render(<CostsView authMode="gated" bots={bots} initialCosts={costs} initialBudget={budget} />);
    await waitFor(() => expect(screen.getAllByTestId("quota-chip")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText(/Bot/i, { selector: "select" }), { target: { value: "dev" } });
    await waitFor(() => expect(screen.getAllByTestId("quota-chip")).toHaveLength(1));
    expect(screen.getByTestId("quota-chip").textContent).toContain("OpenAI");
    expect(urls).toHaveLength(1);                                                        // the filter never asks Hermes again
    expect(within(screen.getByTestId("costs-view")).queryByRole("alert")).toBeNull();
  });
});
