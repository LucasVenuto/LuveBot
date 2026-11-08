// tests/unit/map/map.test.tsx
// Unit tests for Team Map Screen (spec §4.12, contract v0.3 §5, Portão 5 requirement).
// Covers:
// 1. Bots rendered with real statuses (idle, working, paused, offline).
// 2. Handoff appears on the map (connections, counts, live indicators).
// 3. Handoff detail inspection with link to Kanban task.
// 4. View mode toggle (visual graph vs accessible keyboard list).
// 5. Accessible view navigation for screen readers and keyboard users.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { TeamMapView } from "@/components/map/TeamMapView";
import type { TeamMapResponse, Bot } from "@/api/types";
import { setCustomFetchJSON } from "@/api/client";

const mockBots: Bot[] = [
  {
    name: "vendas",
    is_default: false,
    display: {
      label: "Vendas",
      role: "Prospecção B2B",
      color: "#38bdf8",
      avatar: { kind: "emoji", value: "💼" },
    },
    description: "Prospecção",
    model: { provider: "openrouter", name: "claude-sonnet-5-5" },
    status: "working",
  },
  {
    name: "dev",
    is_default: false,
    display: {
      label: "Dev",
      role: "Engenharia",
      color: "#a78bfa",
      avatar: { kind: "emoji", value: "💻" },
    },
    description: "Automação e bugs",
    model: { provider: "anthropic", name: "claude-3-opus" },
    status: "idle",
  },
  {
    name: "suporte",
    is_default: false,
    display: {
      label: "Suporte",
      role: "Atendimento",
      color: "#34d399",
      avatar: { kind: "emoji", value: "🎧" },
    },
    description: "Help desk",
    model: { provider: "anthropic", name: "claude-3-haiku" },
    status: "paused",
  },
];

const mockMapData: TeamMapResponse = {
  nodes: [
    {
      bot: "vendas",
      display: mockBots[0].display,
      status: "working",
      // the object GET /map sends (plugin_api.py /map: bot['current_task'], the same as GET /bots), not a string
      current_task: { kind: "run", id: "run_abc123", title: "Follow-up de leads", since: "2026-10-03T00:00:00Z" },
      rooms: ["room-1"],
      week_cost_cents: 450,
    },
    {
      bot: "dev",
      display: mockBots[1].display,
      status: "idle",
      current_task: null,
      rooms: ["room-1"],
      week_cost_cents: 120,
    },
    {
      bot: "suporte",
      display: mockBots[2].display,
      status: "paused",
      current_task: null,
      rooms: [],
      week_cost_cents: 80,
    },
  ],
  edges: [
    {
      from: "dev",
      to: "vendas",
      count: 7,
      live: true,
      last_at: "2026-10-01T04:00:00Z",
      handoff_ids: ["task-k-101", "task-k-102"],
    },
  ],
  generated_at: "2026-10-01T05:00:00Z",
};

describe("Team Map Screen (TeamMapView - T5.2)", () => {
  beforeEach(() => {
    setCustomFetchJSON(null);
  });

  it("1. Loads and renders team map with real bot statuses and spend", async () => {
    setCustomFetchJSON(async (url) => {
      if (url.includes("/api/plugins/luvebot/map")) {
        return mockMapData;
      }
      return {};
    });

    render(<TeamMapView availableBots={mockBots} />);

    await waitFor(() => {
      expect(screen.getByText("Mapa do Time")).toBeDefined();
    });

    // Switch to accessible list view to inspect exact text contents
    const accessibleTab = screen.getByRole("tab", { name: /lista acessível/i });
    fireEvent.click(accessibleTab);

    // Assert Bots and real statuses
    expect(screen.getByText("Vendas")).toBeDefined();
    expect(screen.getByText("Dev")).toBeDefined();
    expect(screen.getByText("Suporte")).toBeDefined();

    // Working, idle, paused statuses rendered with role="status"
    const statuses = screen.getAllByRole("status");
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    expect(statuses.some((s) => s.textContent?.includes("Trabalhando"))).toBe(true);
    expect(statuses.some((s) => s.textContent?.includes("Inativo"))).toBe(true);
    expect(statuses.some((s) => s.textContent?.includes("Pausado"))).toBe(true);
    expect(statuses.some((s) => /\b(working|idle|paused)\b/.test(s.textContent ?? ""))).toBe(false); // never the raw English code

    // Current task
    expect(screen.getByText("Tarefa atual: Follow-up de leads")).toBeDefined();
    expect(screen.queryByText(/object Object/)).toBeNull();
  });

  it("2. Portão 5: Handoff appears on the team map with count and live indicator", async () => {
    render(<TeamMapView availableBots={mockBots} initialMapData={mockMapData} />);

    // Switch to accessible view to verify connection details
    const accessibleTab = screen.getByRole("tab", { name: /lista acessível/i });
    fireEvent.click(accessibleTab);

    // Handoff item appears
    const handoffItem = screen.getByTestId("map-handoff-item");
    expect(handoffItem).toBeDefined();

    // Origin and destination bots
    expect(handoffItem.textContent).toContain("@dev");
    expect(handoffItem.textContent).toContain("@vendas");

    // Count is 7 handoffs
    expect(handoffItem.textContent).toContain("7 handoffs");

    // Live indicator is displayed
    expect(handoffItem.textContent).toContain("Handoff ao vivo");
  });

  it("3. Clicking a handoff opens detail drawer with link to Kanban task", async () => {
    const handleNavigateKanban = vi.fn();

    render(
      <TeamMapView
        availableBots={mockBots}
        initialMapData={mockMapData}
        onNavigateToKanban={handleNavigateKanban}
      />
    );

    // Switch to accessible view
    fireEvent.click(screen.getByRole("tab", { name: /lista acessível/i }));

    // Click detail button on the handoff edge
    const detailBtn = screen.getByTestId("map-edge-detail-btn");
    fireEvent.click(detailBtn);

    // Handoff drawer opens
    const drawer = await screen.findByRole("dialog");
    expect(drawer).toBeDefined();
    expect(within(drawer).getByRole("heading", { name: /Handoffs entre Bots/i })).toBeDefined();
    expect(screen.getByText(/task-k-101/i)).toBeDefined();

    // Click Kanban link
    const kanbanLinks = screen.getAllByTestId("map-handoff-kanban-link");
    expect(kanbanLinks.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(kanbanLinks[0]);

    expect(handleNavigateKanban).toHaveBeenCalledWith("task-k-101");
  });

  it("4. Accessible keyboard navigation between visual graph and list modes", async () => {
    render(<TeamMapView availableBots={mockBots} initialMapData={mockMapData} />);

    const tablist = screen.getByRole("tablist", { name: "Mapa do Time" });
    expect(tablist).toBeDefined();

    const visualTab = screen.getByRole("tab", { name: /grafo/i });
    const accessibleTab = screen.getByRole("tab", { name: /lista acessível/i });

    expect(visualTab.getAttribute("aria-selected")).toBe("true");
    expect(accessibleTab.getAttribute("aria-selected")).toBe("false");

    // Click accessible tab
    fireEvent.click(accessibleTab);
    expect(visualTab.getAttribute("aria-selected")).toBe("false");
    expect(accessibleTab.getAttribute("aria-selected")).toBe("true");

    // Tabpanel is accessible
    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe("panel-map-accessible");
  });

  it("5. Time window toggle triggers fetch with selected parameter", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/plugins/luvebot/map")) {
        return mockMapData;
      }
      return {};
    });
    setCustomFetchJSON(fetchSpy);

    render(<TeamMapView availableBots={mockBots} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/plugins/luvebot/map?window=7d"),
        expect.anything()
      );
    });

    // Click 30d
    const btn30d = screen.getByRole("button", { name: /últimos 30 dias/i });
    fireEvent.click(btn30d);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/plugins/luvebot/map?window=30d"),
        expect.anything()
      );
    });
  });

  it("6. A face is a shipped mascot or initials: an image URL never becomes <image> or text (A-54)", () => {
    const face = (avatar: any): TeamMapResponse => ({ ...mockMapData, nodes: [{ ...mockMapData.nodes[0], display: { ...mockMapData.nodes[0].display, avatar } } as any], edges: [] });
    for (const value of ["https://example.com/rosto.svg", "javascript:alert(1)"]) {
      const r = render(<TeamMapView availableBots={mockBots} initialMapData={face({ kind: "image", value })} />);
      expect(r.container.querySelector("svg image")).toBeNull();
      expect(screen.queryByText(/example\.com|javascript/)).toBeNull();
      r.unmount();
    }
    // the node is working, so the face carries the working fragment (§14.3)
    const m = render(<TeamMapView availableBots={mockBots} initialMapData={face({ kind: "mascot", value: "zuca" })} />);
    expect(m.container.querySelector("svg image")?.getAttribute("href")).toBe("/dashboard-plugins/luvebot/icons/mascots/zuca-mini.svg#lb-working");
    // no ring around the node (the dashed spinning circle is gone): the state is a small dot of color
    expect(m.container.querySelector("circle[stroke-dasharray]")).toBeNull();
    expect(m.container.querySelector(".lb\\:motion-safe\\:animate-spin")).toBeNull();
    expect(m.container.querySelector('[data-testid="map-state-dot"]')?.getAttribute("fill")).toBe("var(--color-success)");
    m.unmount();
    const unknown = render(<TeamMapView availableBots={mockBots} initialMapData={face({ kind: "mascot", value: "luvi.svg" })} />);
    expect(unknown.container.querySelector("svg image")).toBeNull();
  });

  it("7. A Bot without its own label shows its id in Title Case on the graph and in the list, never the raw id (T11.0)", () => {
    const data: TeamMapResponse = { ...mockMapData, edges: [], nodes: [
      { ...mockMapData.nodes[0], bot: "juridico", display: { ...mockMapData.nodes[0].display!, label: "juridico" } },
      { ...mockMapData.nodes[1], bot: "trafego-pago", display: undefined },
    ] };
    render(<TeamMapView availableBots={mockBots} initialMapData={data} />);
    expect(screen.getAllByText("Juridico").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Trafego Pago").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: /lista acessível/i }));
    expect(screen.getAllByText("Juridico").length).toBeGreaterThan(0);
    expect(screen.queryByText("juridico")).toBeNull();
    expect(screen.queryByText("trafego-pago")).toBeNull();
  });
});
