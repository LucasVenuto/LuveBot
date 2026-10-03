// tests/unit/messenger/host.test.tsx
// LuveBot inside the real Hermes shell (T11.0, D-023): full screen in the overlay slot only on its route, the shell inert,
// the scheme read from what the Hermes theme paints, the way back to the Hermes pages, and the display name.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { Conversation } from "@/components/conversation";
import { LuveBotRoute, LuveBotOverlay } from "@/host/overlay";
import { displayName, withDisplayName } from "@/lib/botName";
import type { Bot } from "@/api/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.body.style.backgroundColor = ""; window.history.replaceState(null, "", "/"); });

describe("full screen through the Hermes overlay slot (D-023)", () => {
  // The Hermes root as App.tsx renders it: the shell, a banner, and the overlay slot as the last child.
  function Host({ route }: { route: boolean }) {
    return (
      <div data-testid="hermes-root">
        <aside id="app-sidebar"><a href="/sessions">Sessions</a></aside>
        <div data-testid="banner" aria-hidden="true">decor</div>
        <main data-testid="hermes-main">{route && <LuveBotRoute />}</main>
        <LuveBotOverlay><button type="button">dentro do LuveBot</button></LuveBotOverlay>
      </div>
    );
  }

  it("renders nothing outside the LuveBot route and the app full screen on it", () => {
    const { rerender, container } = render(<Host route={false} />);
    expect(container.querySelector(".lb-overlay")).toBeNull();
    rerender(<Host route />);
    expect(container.querySelector(".lb-overlay")).not.toBeNull();
    expect(screen.getByRole("button", { name: "dentro do LuveBot" })).toBeDefined();
    rerender(<Host route={false} />);
    expect(container.querySelector(".lb-overlay")).toBeNull();
  });

  it("while open the Hermes shell is inert and hidden from assistive tech; leaving restores exactly what it changed", () => {
    const { rerender } = render(<Host route />);
    const sidebar = document.getElementById("app-sidebar")!;
    const main = screen.getByTestId("hermes-main");
    for (const el of [sidebar, main]) { expect(el.hasAttribute("inert")).toBe(true); expect(el.getAttribute("aria-hidden")).toBe("true"); }
    expect(document.querySelector(".lb-overlay")!.hasAttribute("inert")).toBe(false);
    expect(screen.getByRole("button", { name: "dentro do LuveBot" })).toBeDefined();  // the overlay stays in the tree
    rerender(<Host route={false} />);
    for (const el of [sidebar, main]) { expect(el.hasAttribute("inert")).toBe(false); expect(el.hasAttribute("aria-hidden")).toBe(false); }
    expect(screen.getByTestId("banner").getAttribute("aria-hidden")).toBe("true");  // Hermes's own attribute is kept
  });

  it("a Hermes sibling mounted while LuveBot is open is made inert too, and released on close", async () => {
    const { rerender } = render(<Host route />);
    const late = document.createElement("div");
    screen.getByTestId("hermes-root").insertBefore(late, document.querySelector(".lb-overlay"));
    await new Promise((r) => setTimeout(r, 0));
    expect(late.hasAttribute("inert")).toBe(true);
    rerender(<Host route={false} />);
    expect(late.hasAttribute("inert")).toBe(false);
  });

  it("focus moves into LuveBot when it opens", () => {
    render(<Host route />);
    expect(document.querySelector(".lb-overlay")!.contains(document.activeElement)).toBe(true);
  });

  it("'Painel do Hermes' is a real link on the desktop rail and navigates inside the Hermes router", () => {
    window.history.replaceState(null, "", "/?profile=vendas");
    let popped = 0;
    const onPop = () => { popped += 1; };
    window.addEventListener("popstate", onPop);
    render(<MessengerShell />);
    const link = within(screen.getByRole("navigation")).getByRole("link", { name: "Painel do Hermes" });
    expect(link.getAttribute("href")).toBe("/sessions?profile=vendas");
    fireEvent.click(link);
    window.removeEventListener("popstate", onPop);
    expect(window.location.pathname + window.location.search).toBe("/sessions?profile=vendas");
    expect(popped).toBe(1);
  });

  it("on a phone 'Painel do Hermes' is visible on the contact list and inside a conversation", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(<MessengerShell />);
    expect(screen.getByRole("link", { name: "Painel do Hermes" })).toBeDefined();
    rerender(<MessengerShell selectedBotName="vendas"><div>conversa</div></MessengerShell>);
    expect(screen.getByText("conversa")).toBeDefined();
    expect(screen.getByRole("link", { name: "Painel do Hermes" })).toBeDefined();
  });

  it("on a phone the open conversation has ONE strip on top: back and 'Painel do Hermes' move into its header", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    const { container } = render(
      <MessengerShell selectedBotName="vendas"><Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={async () => new Response("")} /></MessengerShell>);
    const header = container.querySelector("main section header")!;
    expect(within(header as HTMLElement).getByRole("button", { name: "Voltar para as conversas" })).toBeDefined();
    expect(within(header as HTMLElement).getByRole("link", { name: "Painel do Hermes" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Voltar para as conversas" })).toHaveLength(1);
    expect(screen.getAllByRole("link", { name: "Painel do Hermes" })).toHaveLength(1);
  });

  it("the plugin CSS styles no Hermes element (the frame is covered, never restyled)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../../dashboard/src/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/#app-sidebar|header\[role|\[data-layout-variant\]|main:has|data-luvebot/);
  });
});

describe("display name", () => {
  const bot = (name: string, label: string): Bot => ({
    name, is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
    display: { label, role: "", color: "#60a5fa", avatar: { kind: "initials", value: name.slice(0, 2).toUpperCase() } },
  });

  it("a Bot without its own label shows its id in Title Case; a real label is kept", () => {
    expect(displayName("juridico")).toBe("Juridico");
    expect(displayName("trafego-pago", "trafego-pago")).toBe("Trafego Pago");
    expect(displayName("lucais_dev")).toBe("Lucais Dev");
    expect(displayName("juridico", "Jurídico")).toBe("Jurídico");
    expect(withDisplayName(bot("juridico", "juridico")).display.label).toBe("Juridico");
    const own = bot("vendas", "Vendas B2B");
    expect(withDisplayName(own)).toBe(own);
  });

  it("the contact list shows the Title Case name, never the raw id", () => {
    render(<MessengerShell bots={[withDisplayName(bot("juridico", "juridico"))]} />);
    expect(screen.getByText("Juridico")).toBeDefined();
    expect(screen.queryByText("juridico")).toBeNull();
  });
});

describe("LuveBot root palette", () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const css = fs.readFileSync(path.resolve(__dirname, "../../../dashboard/src/style.css"), "utf8");

  for (const scheme of ["dark", "light"]) {
    it(`${scheme}: text, accent and states reach WCAG AA (4.5:1) on the surfaces they sit on`, () => {
      const block = css.match(new RegExp(`\\.lb-root\\[data-lb-scheme="${scheme}"\\]\\s*\\{([^}]*)\\}`))![1];
      const v = Object.fromEntries([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
      const pairs: [string, string][] = [
        ["foreground", "background"], ["foreground", "card"], ["card-foreground", "card"], ["popover-foreground", "popover"],
        ["muted-foreground", "background"], ["muted-foreground", "card"], ["primary", "background"], ["primary-foreground", "primary"],
        ["destructive", "background"], ["destructive-foreground", "destructive"], ["success", "background"], ["warning", "background"],
      ];
      for (const [fg, bg] of pairs) expect(ratio(v[fg], v[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      // screens that read the raw Hermes --background get the same surface, not the Hermes theme's
      expect(block).toMatch(new RegExp(`--background:\\s*${v.background}`));
    });
  }
});
