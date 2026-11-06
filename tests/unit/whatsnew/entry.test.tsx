// tests/unit/whatsnew/entry.test.tsx
// Proof 4 of docs/contracts/whats-new-v0.md section 7: the entry. It is on the rail (desktop), on the phone's bar and in ⌘K; it carries a DOT (never a number) with the accessible name "há novidades" while an unseen item
// exists; choosing it asks for the tab "novidades", the way every other entry does; every control takes the keyboard.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MessengerShell, TAB_IDS } from "@/components/messenger/MessengerShell";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";
import { setLuveLocale } from "@/i18n";

const phone = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setLuveLocale("pt"); });

describe("the rail (desktop)", () => {
  it("has the entry; it is one of the shell's tab ids; choosing it asks for that tab", () => {
    const onTabChange = vi.fn();
    render(<MessengerShell onTabChange={onTabChange} />);
    const button = within(screen.getByRole("navigation", { name: "Navegação Principal" })).getByRole("button", { name: "Novidades" });
    expect(TAB_IDS).toContain("novidades");
    fireEvent.click(button);
    expect(onTabChange).toHaveBeenCalledWith("novidades");
  });
  it("with an unseen item the dot names itself 'há novidades'; without one the entry is just 'Novidades'", () => {
    const { rerender } = render(<MessengerShell newsDot />);
    const nav = within(screen.getByRole("navigation", { name: "Navegação Principal" }));
    expect(nav.getByRole("button", { name: "Novidades, há novidades" })).toBeTruthy();
    rerender(<MessengerShell newsDot={false} />);
    expect(nav.getByRole("button", { name: "Novidades" })).toBeTruthy();
    expect(nav.queryByRole("button", { name: /há novidades/ })).toBeNull();
  });
  it("the mark is a dot and never a number: nothing readable but the name, no digit anywhere in the entry", () => {
    render(<MessengerShell newsDot />);
    const button = screen.getByRole("button", { name: /há novidades/ });
    expect(button.textContent).toBe("");
    expect(button.querySelector("[aria-hidden='true']")).not.toBeNull();   // the dot itself is not read out: the name says it
  });
  it("in English the name is 'What's new, there is news'", () => {
    setLuveLocale("en");
    render(<MessengerShell newsDot />);
    expect(screen.getByRole("button", { name: "What's new, there is news" })).toBeTruthy();
  });
  it("takes the keyboard: a real button, not taken out of the tab order", () => {
    render(<MessengerShell newsDot />);
    const button = screen.getByRole("button", { name: /há novidades/ }) as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("tabindex")).not.toBe("-1");
    expect(button.disabled).toBe(false);
  });
});

describe("the phone's bar", () => {
  it("has the entry with its label, and the dot names itself too; no number", () => {
    phone();
    render(<MessengerShell newsDot />);
    const bar = within(screen.getByRole("navigation", { name: "Navegação Principal" }));
    const button = bar.getByRole("button", { name: "Novidades, há novidades" });
    expect(button.textContent).toBe("Novidades");
    expect(button.textContent).not.toMatch(/\d/);
  });
  it("is among the first entries of the scrolling bar, so a person does not have to swipe to find it", () => {
    phone();
    render(<MessengerShell />);
    const names = within(screen.getByRole("navigation", { name: "Navegação Principal" })).getAllByRole("button").map((b) => b.textContent);
    expect(names.indexOf("Novidades")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("Novidades")).toBeLessThanOrEqual(4);
  });
  it("without a dot: just 'Novidades'", () => {
    phone();
    render(<MessengerShell />);
    expect(screen.getByRole("button", { name: "Novidades" })).toBeTruthy();
  });
});

describe("⌘K", () => {
  const palette = (props: Partial<React.ComponentProps<typeof CommandPaletteModal>> = {}) => {
    const p = { isOpen: true, onClose: vi.fn(), onNavigateTab: vi.fn(), ...props };
    render(<CommandPaletteModal {...p} />);
    return p;
  };
  it("has the command 'Novidades'; choosing it asks for the tab and closes", () => {
    const p = palette();
    fireEvent.click(screen.getByRole("option", { name: /Novidades/ }));
    expect(p.onNavigateTab).toHaveBeenCalledWith("novidades");
    expect(p.onClose).toHaveBeenCalled();
  });
  it("carries the dot with its name while an unseen item exists, and none otherwise", () => {
    palette({ newsDot: true });
    expect(within(screen.getByRole("option", { name: /Novidades/ })).getByRole("img", { name: "há novidades" })).toBeTruthy();
    cleanup();
    palette({ newsDot: false });
    expect(screen.queryByRole("img", { name: "há novidades" })).toBeNull();
  });
  it("is one of the commands the empty search lists", () => {
    palette();
    expect(screen.getAllByRole("option").map((o) => o.textContent).some((t) => /Novidades/.test(t ?? ""))).toBe(true);
  });
});
