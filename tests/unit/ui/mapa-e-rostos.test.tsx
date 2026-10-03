// tests/unit/ui/mapa-e-rostos.test.tsx
// T12.2 (the CEO): the Map is a fixed place in the rail and the phone bar (⌘K keeps it), and a mascot face is drawn whole,
// with no tinted square, no clipping and a selection ring that does not cut it; initials and emoji keep their square.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { Avatar } from "@/components/ui/Avatar";
import { AvatarStack } from "@/components/ui/AvatarStack";
import { TeamMapView } from "@/components/map/TeamMapView";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON } from "@/api/client";
import type { TeamMapResponse } from "@/api/types";

const phone = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
const face = (c: HTMLElement) => c.querySelector('span[aria-hidden="true"]') as HTMLElement;

beforeEach(() => cleanup());
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("Mapa has a fixed place", () => {
  it("is in the desktop rail and goes to the map", () => {
    const onTabChange = vi.fn();
    render(<MessengerShell onTabChange={onTabChange} />);
    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Mapa" }));
    expect(onTabChange).toHaveBeenCalledWith("mapa");
  });

  it("is in the phone bar with its visible label", () => {
    phone();
    render(<MessengerShell />);
    const bar = screen.getByRole("navigation");
    expect(within(bar).getByText("Mapa")).toBeTruthy();
  });

  it("opens the Team Map in the app, and ⌘K still offers it", async () => {
    setCustomFetchJSON(async (url: string) => (/\/bots$/.test(url) ? { bots: [] } : url.includes("/budget") ? { limits: [] } : url.includes("/map") ? { nodes: [], edges: [] } : {}));
    render(<LuveBotApp />);
    fireEvent.click(within(await screen.findByRole("navigation")).getByRole("button", { name: "Mapa" }));
    expect(await screen.findByText("Mapa do Time")).toBeTruthy();
    cleanup();
    render(<CommandPaletteModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText("Ver Mapa do Time")).toBeTruthy();
  });
});

describe("a mascot face is drawn whole", () => {
  it("the whole character, loose: no tinted square, no clipping, no square ring; selection is a contour on the drawing", () => {
    const { container } = render(<Avatar name="Vendas" avatar={{ kind: "mascot", value: "brisa" }} color="#60a5fa" ring size={72} />);
    const box = face(container);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(box.style.background).toBe("");
    expect(box.style.overflow).not.toBe("hidden");
    expect(box.style.boxShadow).toBe("");
    expect(box.style.outline).toBe("");
    expect(box.style.borderRadius).toBe("");
    expect(img.getAttribute("src")).toBe("/dashboard-plugins/luvebot/icons/mascots/brisa.svg");   // the full body, never *-rosto
    expect(img.style.objectFit).toBe("contain");
    expect(img.style.filter).toContain("drop-shadow");
    cleanup();
    const small = render(<Avatar name="Vendas" avatar={{ kind: "mascot", value: "brisa" }} color="#60a5fa" size={24} />).container;
    expect(small.querySelector("img")?.getAttribute("src")).toBe("/dashboard-plugins/luvebot/icons/mascots/brisa-mini.svg");
    expect((small.querySelector("img") as HTMLImageElement).style.filter).toBe("");   // not selected: no contour
  });

  it("initials and emoji keep the tinted square", () => {
    const { container } = render(<Avatar name="Vendas" avatar={{ kind: "initials", value: "VE" }} color="#60a5fa" ring />);
    const box = face(container);
    expect(box.style.background).not.toBe("");
    expect(box.style.overflow).toBe("hidden");
    expect(box.style.boxShadow).toContain("4px");
  });

  it("in a room's stack, a mascot face has no halo square behind it; initials keep theirs", () => {
    const { container } = render(<AvatarStack faces={[{ key: "a", name: "Atlas", avatar: { kind: "mascot", value: "luvi" } }, { key: "b", name: "Dev", avatar: { kind: "initials", value: "DE" } }]} />);
    const wrappers = Array.from(container.firstElementChild!.children) as HTMLElement[];
    expect(wrappers[0].style.boxShadow).toBe("");
    expect(wrappers[1].style.boxShadow).not.toBe("");
  });

  it("on the Team Map, a mascot node is the whole face: no circular clip and no disc behind it", () => {
    const data: TeamMapResponse = { generated_at: "", edges: [], nodes: [
      { bot: "vendas", display: { label: "Vendas", role: "", color: "#60a5fa", avatar: { kind: "mascot", value: "brisa" } }, status: "idle", rooms: [] },
      // chosen initials (not the default "DE" of the id, which would get the default mascot face, T11.4)
      { bot: "dev", display: { label: "Dev", role: "", color: "#a78bfa", avatar: { kind: "initials", value: "DV" } }, status: "idle", rooms: [] },
    ] } as TeamMapResponse;
    const { container } = render(<TeamMapView availableBots={[]} initialMapData={data} />);
    const image = container.querySelector("svg image")!;
    expect(image.getAttribute("clip-path") ?? image.getAttribute("clipPath")).toBeNull();
    expect(image.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(container.querySelector("clipPath")).toBeNull();
    expect(container.querySelectorAll('svg circle[r="22"]')).toHaveLength(1);  // only the initials node keeps its disc
  });
});

describe("the way to the Hermes dashboard does not look like a menu", () => {
  it("desktop rail: an exit icon (not ≡) with the tooltip and name 'Painel do Hermes'", () => {
    render(<MessengerShell />);
    const link = within(screen.getByRole("navigation")).getByRole("link", { name: "Painel do Hermes" });
    expect(link.getAttribute("title")).toBe("Painel do Hermes");
    expect(link.querySelector('svg[data-icon="exit"]')).not.toBeNull();
    expect(link.getAttribute("aria-haspopup")).toBeNull();
  });

  it("phone: the label 'Painel do Hermes' is written next to the exit icon", () => {
    phone();
    render(<MessengerShell />);
    const link = screen.getByRole("link", { name: "Painel do Hermes" });
    expect(link.textContent).toBe("Painel do Hermes");
    expect(link.querySelector('svg[data-icon="exit"]')).not.toBeNull();
  });
});

