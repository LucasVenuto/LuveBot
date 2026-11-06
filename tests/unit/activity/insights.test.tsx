// tests/unit/activity/insights.test.tsx
// Linha do tempo e Horários ligadas à tela (spec 4.7 and section 7; contract v0.8 §2): Atividade ganha duas visões ao lado de Lista e
// Kanban. Each asks its own read route (the window and the zone are what the person sees), draws what comes back, hides the tabs and
// the list filters it does not use, opens the screen that holds a mark (conversation, approvals, routines, team map), says in words
// when it could not, refreshes with the screen's button and drops a late answer to an old ask.
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ActivityView } from "@/components/activity/ActivityView";
import { ApiError, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, HeatmapResponse, TimelineResponse } from "@/api/types";

const bot = (name: string, label: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } },
} as Bot);
const BOTS = [bot("vendas", "Vendas"), bot("pesquisa", "Pesquisa")];

let calls: string[], timeline: (q: URLSearchParams) => Promise<TimelineResponse>, heatmap: (q: URLSearchParams) => Promise<HeatmapResponse>;

/** A window's worth of data, inside whatever window was asked. */
const dataFor = (q: URLSearchParams): TimelineResponse => {
  const since = Number(q.get("since")), span = Number(q.get("until")) - since, at = (f: number) => since + Math.round(f * span);
  return {
    lanes: [
      { bot: "vendas", blocks: [{ id: "r1", kind: "run", title: "Proposta Acme", start: at(0.2), end: at(0.4), status: "done" }] },
      { bot: "pesquisa", blocks: [{ id: "c1", kind: "routine", title: null, start: at(0.5), end: at(0.6), status: "done" }] },
    ],
    approvals: [{ id: "a1", bot: "vendas", at: at(0.3), decided_at: null, status: "pending" }],
    handoffs: [{ id: "h1", from: "vendas", to: "pesquisa", at: at(0.7), status: "open" }],
  };
};
const HEAT: HeatmapResponse = { bots: ["vendas"], cells: [{ bot: "vendas", hour: 9, count: 5 }], max: 5 };

beforeEach(() => {
  cleanup(); setLuveLocale("pt");
  calls = [];
  timeline = async (q) => dataFor(q);
  heatmap = async () => HEAT;
  setCustomFetchJSON(async (url) => {
    calls.push(url);
    if (url.includes("/activity/timeline")) return timeline(new URL(url, "http://x").searchParams);
    if (url.includes("/activity/heatmap")) return heatmap(new URL(url, "http://x").searchParams);
    if (url.includes("/activity")) return { items: [], next_cursor: null };
    return {};
  });
});

const view = (props: Partial<React.ComponentProps<typeof ActivityView>> = {}) => render(<ActivityView bots={BOTS} initialItems={[]} {...props} />);
const reads = (what: string) => calls.filter((u) => u.includes(`/activity/${what}`));
const query = (u: string) => new URL(u, "http://x").searchParams;

describe("Linha do tempo na Atividade", () => {
  it("asks the last 24 h by default, draws the lanes, and drops the tabs and list filters it does not use", async () => {
    view();
    expect(screen.getByTestId("tab-running")).toBeDefined();
    fireEvent.click(screen.getByTestId("toggle-view-timeline"));
    await screen.findByTestId("timeline");
    expect(reads("timeline")).toHaveLength(1);
    const q = query(reads("timeline")[0]);
    expect(Number(q.get("until")) - Number(q.get("since"))).toBe(86400);
    expect(Math.abs(Number(q.get("until")) - Date.now() / 1000)).toBeLessThan(5);       // the window ends when it was asked
    expect([...document.querySelectorAll(".lb-tl-name")].map((n) => n.textContent)).toEqual(["Vendas", "Pesquisa"]);
    expect(screen.queryByTestId("tab-running")).toBeNull();
    expect(screen.queryByTestId("filter-bot")).toBeNull();
    expect(screen.queryByTestId("input-search-activity")).toBeNull();
    fireEvent.click(screen.getByTestId("toggle-view-list"));                              // back to the list: tabs and filters are there again
    expect(screen.getByTestId("tab-running")).toBeDefined();
    expect(screen.getByTestId("filter-bot")).toBeDefined();
    expect(screen.queryByTestId("activity-timeline")).toBeNull();
  });

  it("the window picker asks 3 and 7 days, marking the chosen one", async () => {
    view({ initialView: "timeline" });
    await screen.findByTestId("timeline");
    expect(screen.getByTestId("tl-window-24").getAttribute("aria-pressed")).toBe("true");
    for (const [hours, seconds] of [[72, 259200], [168, 604800]] as const) {
      fireEvent.click(screen.getByTestId(`tl-window-${hours}`));
      await waitFor(() => expect(reads("timeline").length).toBeGreaterThan(hours === 72 ? 1 : 2));
      const q = query(reads("timeline").at(-1)!);
      expect(Number(q.get("until")) - Number(q.get("since"))).toBe(seconds);
      expect(screen.getByTestId(`tl-window-${hours}`).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("a mark opens the screen that holds it: a run, the Bot's conversation; a routine, Rotinas; an approval, Aprovações; a handoff, the map", async () => {
    const onOpenConversation = vi.fn(), onNavigateTab = vi.fn();
    view({ initialView: "timeline", onOpenConversation, onNavigateTab });
    await screen.findByTestId("timeline");
    fireEvent.click(screen.getByTestId("tl-block-r1"));
    expect(onOpenConversation).toHaveBeenCalledExactlyOnceWith("vendas");
    fireEvent.click(screen.getByTestId("tl-block-c1"));
    fireEvent.click(screen.getByTestId("tl-approval-a1"));
    fireEvent.click(screen.getByTestId("tl-handoff-h1"));
    expect(onNavigateTab.mock.calls.map((c) => c[0])).toEqual(["rotinas", "aprovacoes", "mapa"]);
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
  });

  it("'Atualizar' asks the timeline again, not the list", async () => {
    view({ initialView: "timeline" });
    await screen.findByTestId("timeline");
    const listCalls = calls.filter((u) => /\/activity\?/.test(u) && !u.includes("timeline")).length;
    fireEvent.click(screen.getByTestId("btn-refresh-activity"));
    await waitFor(() => expect(reads("timeline")).toHaveLength(2));
    expect(calls.filter((u) => /\/activity\?/.test(u) && !u.includes("timeline")).length).toBe(listCalls);
  });

  it("says in words when it could not load, and 'Tentar de novo' asks again", async () => {
    let fail = true;
    timeline = async (q) => { if (fail) throw new ApiError({ code: "upstream_error", message: "x", status: 502 } as never); return dataFor(q); };
    view({ initialView: "timeline" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Não deu para carregar a linha do tempo.");
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Tentar novamente" }));
    await screen.findByTestId("timeline");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an answer that arrives late for an old window never replaces the newer one", async () => {
    const gates: Array<(v: TimelineResponse) => void> = [];
    const asked: URLSearchParams[] = [];
    timeline = (q) => new Promise((ok) => { asked.push(q); gates.push(ok); });
    view({ initialView: "timeline" });
    await waitFor(() => expect(gates).toHaveLength(1));
    fireEvent.click(screen.getByTestId("tl-window-168"));
    await waitFor(() => expect(gates).toHaveLength(2));
    gates[1](dataFor(asked[1]));
    await screen.findByTestId("timeline");
    const names = () => [...document.querySelectorAll(".lb-tl-name")].map((n) => n.textContent);
    expect(names()).toEqual(["Vendas", "Pesquisa"]);
    await act(async () => {
      gates[0]({ lanes: [{ bot: "vendas", blocks: [{ id: "old", kind: "run", title: "velha", start: Number(asked[0].get("since")) + 10, end: null, status: "done" }] }], approvals: [], handoffs: [] });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByTestId("tl-block-old")).toBeNull();
    expect(screen.getByTestId("tl-block-r1")).toBeDefined();
  });
});

describe("Horários (heatmap) na Atividade", () => {
  it("asks 28 days in the browser's own zone, draws the table, and the period picker asks again", async () => {
    view();
    fireEvent.click(screen.getByTestId("toggle-view-heatmap"));
    await screen.findByRole("table");
    const q = query(reads("heatmap")[0]);
    expect(q.get("days")).toBe("28");
    expect(q.get("tz")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(screen.getByTestId("hm-vendas-9").getAttribute("title")).toBe("Vendas, 9 h: 5 execuções");
    expect(screen.queryByTestId("tab-running")).toBeNull();
    fireEvent.click(screen.getByTestId("hm-days-7"));
    await waitFor(() => expect(reads("heatmap")).toHaveLength(2));
    expect(query(reads("heatmap")[1]).get("days")).toBe("7");
    expect(screen.getByTestId("hm-days-7").getAttribute("aria-pressed")).toBe("true");
  });

  it("an unreadable heatmap says so in words and 'Atualizar' asks it again", async () => {
    heatmap = async () => { throw new ApiError({ code: "upstream_error", message: "x", status: 502 } as never); };
    view({ initialView: "heatmap" });
    expect((await screen.findByRole("alert")).textContent).toContain("Não deu para carregar os horários.");
    heatmap = async () => HEAT;
    fireEvent.click(screen.getByTestId("btn-refresh-activity"));
    await screen.findByRole("table");
    expect(reads("heatmap")).toHaveLength(2);
  });
});
