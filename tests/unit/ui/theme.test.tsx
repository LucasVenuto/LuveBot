// tests/unit/ui/theme.test.tsx
// LuveBot's own light/dark choice (T11.8): Automático follows the system, Claro and Escuro are kept per browser, the Luve
// palette is used in both, nothing in Hermes is read or changed, and it works from the keyboard and on a phone.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { SCHEME_KEY } from "@/hooks/useHost";
import { setCustomFetchJSON } from "@/api/client";

const system = (dark: boolean, phone = false) => vi.stubGlobal("matchMedia", (q: string) => ({
  matches: q.includes("prefers-color-scheme") ? dark : phone, media: q, addEventListener() {}, removeEventListener() {},
}));
const root = () => document.querySelector(".lb-root")!;
const picker = () => screen.getByRole("button", { name: /^Tema do LuveBot/ });
const choose = (name: string) => { fireEvent.click(picker()); fireEvent.click(within(screen.getByRole("radiogroup")).getByRole("radio", { name: new RegExp(`^${name}`) })); };

beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* */ } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("LuveBot theme", () => {
  it("Automático is the default and follows the system's light or dark", () => {
    system(true);
    render(<MessengerShell />);
    expect(root().getAttribute("data-lb-scheme")).toBe("dark");
    expect(picker().getAttribute("aria-label")).toBe("Tema do LuveBot: Automático");
    cleanup();
    system(false);
    render(<MessengerShell />);
    expect(root().getAttribute("data-lb-scheme")).toBe("light");
  });

  it("Claro and Escuro win over the system and are kept in this browser", () => {
    system(true);
    const { unmount } = render(<MessengerShell />);
    choose("Claro");
    expect(root().getAttribute("data-lb-scheme")).toBe("light");
    expect(localStorage.getItem(SCHEME_KEY)).toBe("light");
    unmount();
    render(<MessengerShell />);
    expect(root().getAttribute("data-lb-scheme")).toBe("light");  // kept after a reload
    choose("Automático");
    expect(root().getAttribute("data-lb-scheme")).toBe("dark");
    expect(localStorage.getItem(SCHEME_KEY)).toBeNull();
  });

  it("a browser that blocks storage still works (Automático, and the choice applies for now)", () => {
    system(false);
    // a browser that blocks site storage throws on the very access to window.localStorage (SecurityError)
    const real = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("blocked", "SecurityError"); } });
    try {
      render(<MessengerShell />);
      expect(root().getAttribute("data-lb-scheme")).toBe("light");
      choose("Escuro");
      expect(root().getAttribute("data-lb-scheme")).toBe("dark");
    } finally { Object.defineProperty(window, "localStorage", real); }
  });

  it("is a radio group from the keyboard: arrows move the choice, Esc closes and returns focus", () => {
    system(false);
    render(<MessengerShell />);
    fireEvent.click(picker());
    const group = screen.getByRole("radiogroup", { name: "Tema do LuveBot" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(root().getAttribute("data-lb-scheme")).toBe("light");
    expect(within(group).getByRole("radio", { name: /^Claro/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(root().getAttribute("data-lb-scheme")).toBe("dark");
    fireEvent.keyDown(group, { key: "Escape" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(document.activeElement).toBe(picker());
  });

  it("never touches the Hermes theme: no request, no attribute on <html>", () => {
    system(true);
    const calls: string[] = [];
    setCustomFetchJSON(async (url: string) => { calls.push(url); return {}; });
    const before = Array.from(document.documentElement.attributes).map((a) => `${a.name}=${a.value}`).join(";");
    render(<MessengerShell />);
    choose("Claro");
    expect(calls.filter((u) => u.includes("/theme"))).toEqual([]);
    expect(Array.from(document.documentElement.attributes).map((a) => `${a.name}=${a.value}`).join(";")).toBe(before);
    setCustomFetchJSON(null);
  });

  it("is on a phone too, at the top of the contact list", () => {
    system(true, true);
    render(<MessengerShell />);
    choose("Claro");
    expect(root().getAttribute("data-lb-scheme")).toBe("light");
  });
});
