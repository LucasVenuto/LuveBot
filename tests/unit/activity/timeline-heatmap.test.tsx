// tests/unit/activity/timeline-heatmap.test.tsx
// Timeline in lanes and Heatmap Bots × hours (spec 4.7 and section 7; contract v0.8 §2): the two components draw exactly what
// the read routes return. Timeline: a lane per Bot (also a Bot that only appears in a handoff), each block at its share of the
// window, a running task reaching "now", a run without an end as a point, a diamond per approval and a line per handoff, every
// mark a button that opens the existing card, states spoken by name, the agent's title only as text. Heatmap: a real table, 24
// hours × Bots, the count in every label, the strength growing with the count, the period picker.
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Timeline } from "@/components/activity/Timeline";
import { Heatmap, heatPct } from "@/components/activity/Heatmap";
import type { Bot, HeatmapResponse, TimelineResponse } from "@/api/types";
import { setLuveLocale } from "@/i18n";

const bot = (name: string, label: string, color: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color, avatar: { kind: "mascot", value: "luvi" } },
} as Bot);
const BOTS = [bot("vendas", "Vendas", "#3b82f6"), bot("pesquisa", "Pesquisa", "#34d399"), bot("ops", "Ops", "#fb923c")];

const SINCE = 1_759_000_000, UNTIL = SINCE + 86_400, NOW = SINCE + 72_000;   // a 24 h window, "now" at 20 h in
const at = (fraction: number) => SINCE + Math.round(fraction * 86_400);

const DATA: TimelineResponse = {
  lanes: [
    { bot: "vendas", blocks: [
      { id: "r1", kind: "run", title: "Proposta Acme", start: at(0.25), end: at(0.5), status: "done" },
      { id: "r2", kind: "run", title: '<img src=x onerror="alert(1)">', start: at(0.3), end: at(0.4), status: "error" },   // overlaps r1
      { id: "r3", kind: "run", title: null, start: at(0.8), end: null, status: "running" },
    ] },
    { bot: "pesquisa", blocks: [
      { id: "c1", kind: "routine", title: null, start: SINCE - 3600, end: at(0.1), status: "done" },   // started before the window
      { id: "old", kind: "run", title: "Antiga", start: at(0.6), end: null, status: "done" },           // no end recorded: a point
    ] },
  ],
  approvals: [
    { id: "a1", bot: "vendas", at: at(0.45), decided_at: null, status: "pending" },
    { id: "a2", bot: "pesquisa", at: at(0.05), decided_at: at(0.06), status: "decided" },
  ],
  handoffs: [{ id: "h1", from: "pesquisa", to: "ops", at: at(0.7), status: "open" }],
};

const left = (el: HTMLElement) => parseFloat(el.style.left);
const width = (el: HTMLElement) => parseFloat(el.style.width);

describe("Timeline in lanes", () => {
  beforeEach(() => setLuveLocale("pt"));

  it("a lane per Bot, in the route's order, plus a Bot that only appears in a handoff", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    const names = [...document.querySelectorAll(".lb-tl-name")].map((n) => n.textContent);
    expect(names).toEqual(["Vendas", "Pesquisa", "Ops"]);
  });

  it("each block sits at its share of the window; a task begun before the window starts at the edge", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    const r1 = screen.getByTestId("tl-block-r1");
    expect(left(r1)).toBeCloseTo(25, 5);
    expect(width(r1)).toBeCloseTo(25, 5);
    expect(left(screen.getByTestId("tl-block-c1"))).toBe(0);
    expect(width(screen.getByTestId("tl-block-c1"))).toBeCloseTo(10, 5);
  });

  it("a running task reaches now; a run with no end recorded is a point, not a bar", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    const r3 = screen.getByTestId("tl-block-r3");
    expect(left(r3) + width(r3)).toBeCloseTo((72_000 / 86_400) * 100, 5);
    const old = screen.getByTestId("tl-block-old");
    expect(old.className).toContain("is-point");
    expect(old.style.width).toBe("");
  });

  it("overlapping tasks of one Bot go on separate rows (never on top of each other)", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    expect(screen.getByTestId("tl-block-r1").style.top).not.toBe(screen.getByTestId("tl-block-r2").style.top);
  });

  it("every mark is a button that opens the existing card, with its state spoken by name (never the raw code)", () => {
    const onOpenBlock = vi.fn(), onOpenApproval = vi.fn(), onOpenHandoff = vi.fn();
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS}
      onOpenBlock={onOpenBlock} onOpenApproval={onOpenApproval} onOpenHandoff={onOpenHandoff} />);
    fireEvent.click(screen.getByTestId("tl-block-r1"));
    expect(onOpenBlock).toHaveBeenCalledWith(DATA.lanes[0].blocks[0], "vendas");
    const a1 = screen.getByTestId("tl-approval-a1");
    fireEvent.click(a1);
    expect(onOpenApproval).toHaveBeenCalledWith("a1");
    expect(a1.className).toContain("is-pending");
    expect(a1.getAttribute("aria-label")).toMatch(/^Aprovação de Vendas, pendente, às /);
    fireEvent.click(screen.getByTestId("tl-handoff-h1"));
    expect(onOpenHandoff).toHaveBeenCalledWith("h1");
    expect(screen.getByTestId("tl-handoff-h1").getAttribute("aria-label")).toMatch(/^Pesquisa passou uma tarefa para Ops, /);
    const r2 = screen.getByTestId("tl-block-r2").getAttribute("aria-label")!;
    expect(r2).toContain("Erro");
    expect(r2).not.toMatch(/\berror\b/);
    for (const b of screen.getAllByRole("button")) expect(b.getAttribute("aria-label"), b.outerHTML).toBeTruthy();
  });

  it("the handoff line goes from the giver's lane to the receiver's lane", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    const lanes = [...document.querySelectorAll<HTMLElement>(".lb-tl-lane")];
    const mid = (el: HTMLElement) => parseFloat(el.style.top) + parseFloat(el.style.height) / 2;
    const line = document.querySelector<HTMLElement>(".lb-tl-link")!;
    expect(parseFloat(line.style.top)).toBeCloseTo(mid(lanes[1]), 5);
    expect(parseFloat(line.style.top) + parseFloat(line.style.height)).toBeCloseTo(mid(lanes[2]), 5);
    expect(left(line)).toBeCloseTo(70, 5);
  });

  it("a title from the agent is only text: markup never becomes an element", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    // the only images are the Bots' mascot faces shipped in the plugin; the agent's markup is shown as its own characters
    for (const img of document.querySelectorAll("img")) expect(img.getAttribute("src")).toMatch(/^\/dashboard-plugins\/luvebot\/icons\/mascots\/[a-z]+(-mini)?\.svg$/);
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
  });

  it("an untitled run and routine are named by kind; the axis says 'agora'", () => {
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    expect(screen.getByTestId("tl-block-c1").getAttribute("aria-label")).toMatch(/^Pesquisa: Rotina/);
    expect(screen.getByText("agora")).toBeTruthy();
  });

  it("nothing in the window: the empty state, not an empty chart", () => {
    render(<Timeline data={{ lanes: [], approvals: [], handoffs: [] }} since={SINCE} until={UNTIL} now={NOW} />);
    expect(screen.getByTestId("timeline-empty")).toBeTruthy();
    expect(screen.queryByTestId("timeline")).toBeNull();
  });

  it("speaks English too", () => {
    setLuveLocale("en");
    render(<Timeline data={DATA} since={SINCE} until={UNTIL} now={NOW} bots={BOTS} />);
    expect(screen.getByTestId("tl-approval-a1").getAttribute("aria-label")).toMatch(/^Approval for Vendas, /);
    expect(screen.getByText("now")).toBeTruthy();
  });
});

const HEAT: HeatmapResponse = {
  bots: ["vendas", "ops"],
  cells: [{ bot: "vendas", hour: 9, count: 12 }, { bot: "vendas", hour: 14, count: 3 }, { bot: "ops", hour: 2, count: 1 }],
  max: 12,
};

describe("Heatmap Bots × hours", () => {
  beforeEach(() => setLuveLocale("pt"));

  it("a real table: a row per Bot, 24 hour columns, the count in every cell's label", () => {
    render(<Heatmap data={HEAT} days={28} bots={BOTS} tz="America/Sao_Paulo" />);
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(25);
    expect(within(table).getAllByRole("rowheader").map((h) => h.textContent)).toEqual(["Vendas", "Ops"]);
    expect(screen.getByTestId("hm-vendas-9").getAttribute("title")).toBe("Vendas, 9 h: 12 execuções");
    expect(screen.getByTestId("hm-ops-23").getAttribute("title")).toBe("Ops, 23 h: 0 execuções");
    expect(table.querySelector("caption")!.textContent).toContain("America/Sao_Paulo");
  });

  it("the square grows with the count: none at 0, a little for 1, the most at the max", () => {
    expect(heatPct(0, 12)).toBe(0);
    expect(heatPct(1, 12)).toBeGreaterThan(16);
    expect(heatPct(3, 12)).toBeLessThan(heatPct(12, 12));
    expect(heatPct(12, 12)).toBe(88);
    render(<Heatmap data={HEAT} days={28} bots={BOTS} />);
    const cell = (id: string) => screen.getByTestId(id).querySelector<HTMLElement>(".lb-hm-cell")!.style.background;
    expect(cell("hm-vendas-9")).toContain("88%");
    expect(cell("hm-vendas-0")).toBe("");
  });

  it("the period picker marks the current period and asks for another", () => {
    const onDaysChange = vi.fn();
    render(<Heatmap data={HEAT} days={28} bots={BOTS} onDaysChange={onDaysChange} />);
    expect(screen.getByTestId("hm-days-28").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("hm-days-7").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("hm-days-90"));
    expect(onDaysChange).toHaveBeenCalledWith(90);
  });

  it("nothing started in the period: the empty state, and the picker stays to try another period", () => {
    render(<Heatmap data={{ bots: ["vendas"], cells: [], max: 0 }} days={7} bots={BOTS} />);
    expect(screen.getByTestId("heatmap-empty")).toBeTruthy();
    expect(screen.getByTestId("hm-days-90")).toBeTruthy();
  });
});
