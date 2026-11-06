// tests/unit/conversation/cramped-layout.test.tsx
// Live finding (the Forja, 900x800): with the sidebar on the left and the 320 px work panel on the right, the conversation column was ~215 px and the message field collapsed to width 0. The conversation now measures
// itself: when it cannot keep 420 px beside the panel, the panel is the sheet a phone has (the same button opens it); and the field can never be narrower than 120 px (its buttons wrap instead).
// jsdom has no layout: the root's width comes from a stub of getBoundingClientRect and a ResizeObserver the test drives; the field's own guarantee is its style (the contract).
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { Conversation, MIN_COLUMN, WORK_PANEL_WIDTH } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
let rootWidth = 0;
let observers: Array<(w: number) => void> = [];
const realRect = Element.prototype.getBoundingClientRect;
const realRO = (globalThis as any).ResizeObserver;

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); observers = [];
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "basic:ceo", auth_mode: "gated" } : {}));
  // the Conversation's root is the one flex box that is 100% high
  Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const root = this.style?.display === "flex" && this.style?.height === "100%";
    return { width: root ? rootWidth : 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() { return {}; } } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { constructor(cb: (e: any[]) => void) { observers.push((w) => cb([{ contentRect: { width: w } }])); } observe() {} disconnect() {} };
});
afterEach(() => { setCustomFetchJSON(null); Element.prototype.getBoundingClientRect = realRect; (globalThis as any).ResizeObserver = realRO; });

const inline = () => document.getElementById("lb-work-panel");
const sheetButton = () => screen.queryByRole("button", { name: translations.pt.workPanelBtn });

describe("the work panel is a column only where the conversation keeps its room", () => {
  it("a wide window: the panel is the column it always was, and there is no sheet button", () => {
    rootWidth = 1376;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    expect(inline()).not.toBeNull();
    expect(sheetButton()).toBeNull();
  });

  it("900x800 (the conversation's box is ~536 px wide): no column; the panel button opens the SHEET, and 'Voltar para a conversa' closes it", () => {
    rootWidth = 536;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    expect(inline()).toBeNull();
    fireEvent.click(sheetButton()!);
    const sheet = screen.getByRole("dialog", { name: translations.pt.workPanelBtn });
    expect(sheet).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: /Voltar para a conversa/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the boundary is exactly the panel plus the minimum column", () => {
    expect(WORK_PANEL_WIDTH + MIN_COLUMN).toBe(740);
    rootWidth = 740;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    expect(inline()).not.toBeNull();                                                         // 740 - 320 = 420: it fits
    cleanup();
    rootWidth = 739;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    expect(inline()).toBeNull();                                                             // one pixel less: it does not
  });

  it("an unknown width (no layout) is NOT 'narrow': the column stays as before", () => {
    rootWidth = 0;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    expect(inline()).not.toBeNull();
    expect(sheetButton()).toBeNull();
  });

  it("it follows the window: shrinking turns the column into the sheet, growing turns it back", () => {
    rootWidth = 1376;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    expect(inline()).not.toBeNull();
    act(() => observers.forEach((o) => o(536)));
    expect(inline()).toBeNull();
    expect(sheetButton()).not.toBeNull();
    act(() => observers.forEach((o) => o(1200)));
    expect(inline()).not.toBeNull();
    expect(sheetButton()).toBeNull();
  });
});

describe("the message field can never collapse", () => {
  it("it has a minimum width and a basis, and the row wraps its buttons instead of squeezing it to nothing", () => {
    rootWidth = 1376;
    render(<Conversation bot={BOT} initialTurns={[]} />);
    const field = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    expect(field.style.minWidth).toBe("120px");
    expect(field.style.flex).toBe("1 1 140px");
    expect((field.closest("form") as HTMLFormElement).style.flexWrap).toBe("wrap");
  });
});
