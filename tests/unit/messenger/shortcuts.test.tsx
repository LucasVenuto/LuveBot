// tests/unit/messenger/shortcuts.test.tsx
// Spec §8 shortcuts (F8): ⌘K, ⌘N, ⌘⇧N, ⌘B, ⌘1…9, Alt+↑/↓, ⌘I, G then A. Typing in a field never fires one,
// except ⌘K and ⌘I; hidden Bots are not counted.
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { shortcutFor, botAt, G_WINDOW_MS, type KeyPress } from "@/components/messenger/shortcuts";
import type { Bot } from "@/api/types";

afterEach(cleanup);

const bot = (name: string, label: string, hidden = false): Bot => ({
  name, is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
  display: { label, role: "Papel", color: "#60a5fa", avatar: { kind: "initials", value: label.slice(0, 2) }, hidden },
});
const BOTS = [bot("vendas", "Vendas"), bot("arquivo", "Arquivo", true), bot("atlas", "Atlas"), bot("sophia", "Sophia")];
const k = (key: string, o: Partial<KeyPress> = {}): KeyPress => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, editable: false, ...o });

describe("shortcutFor", () => {
  it("maps the spec's combos, ⌘ or Ctrl", () => {
    expect(shortcutFor(k("k", { metaKey: true }), null, 0)).toEqual({ type: "search" });
    expect(shortcutFor(k("n", { ctrlKey: true }), null, 0)).toEqual({ type: "newBot" });
    expect(shortcutFor(k("N", { metaKey: true, shiftKey: true }), null, 0)).toEqual({ type: "newRoom" });
    expect(shortcutFor(k("b", { metaKey: true }), null, 0)).toEqual({ type: "toggleSidebar" });
    expect(shortcutFor(k("3", { metaKey: true }), null, 0)).toEqual({ type: "bot", index: 2 });
    expect(shortcutFor(k("ArrowDown", { altKey: true }), null, 0)).toEqual({ type: "step", delta: 1 });
    expect(shortcutFor(k("i", { metaKey: true }), null, 0)).toEqual({ type: "composer" });
  });

  it("G then A within the window opens Approvals; too late, or with a modifier, it does not", () => {
    expect(shortcutFor(k("g"), null, 0)).toEqual({ type: "armG" });
    expect(shortcutFor(k("a"), 1000, 1000 + G_WINDOW_MS)).toEqual({ type: "approvals" });
    expect(shortcutFor(k("a"), 1000, 1001 + G_WINDOW_MS)).toBeNull();
    expect(shortcutFor(k("a"), null, 0)).toBeNull();
  });

  it("while typing, only ⌘K and ⌘I work", () => {
    const typing = { editable: true };
    expect(shortcutFor(k("k", { metaKey: true, ...typing }), null, 0)).toEqual({ type: "search" });
    expect(shortcutFor(k("i", { metaKey: true, ...typing }), null, 0)).toEqual({ type: "composer" });
    for (const press of [k("n", { metaKey: true, ...typing }), k("b", { metaKey: true, ...typing }), k("1", { metaKey: true, ...typing }), k("ArrowUp", { altKey: true, ...typing }), k("g", typing)]) {
      expect(shortcutFor(press, null, 0)).toBeNull();
    }
    expect(shortcutFor(k("a", typing), 0, 1)).toBeNull();
  });

  it("botAt picks by position or steps with wrap", () => {
    const list = [{ name: "a" }, { name: "b" }, { name: "c" }];
    expect(botAt(list, null, { type: "bot", index: 1 })?.name).toBe("b");
    expect(botAt(list, null, { type: "bot", index: 8 })).toBeNull();
    expect(botAt(list, "c", { type: "step", delta: 1 })?.name).toBe("a");
    expect(botAt(list, "a", { type: "step", delta: -1 })?.name).toBe("c");
    expect(botAt(list, null, { type: "step", delta: 1 })?.name).toBe("a");
  });
});

describe("MessengerShell shortcuts", () => {
  it("⌘2 opens the second visible Bot (the hidden one is not counted); Alt+↓ goes to the next", () => {
    const onSelectBot = vi.fn();
    render(<MessengerShell bots={BOTS} selectedBotName="atlas" onSelectBot={onSelectBot} />);
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    expect(onSelectBot).toHaveBeenLastCalledWith(expect.objectContaining({ name: "atlas" }));
    fireEvent.keyDown(window, { key: "ArrowDown", altKey: true });
    expect(onSelectBot).toHaveBeenLastCalledWith(expect.objectContaining({ name: "sophia" }));
  });

  it("⌘B hides and shows the conversation list; ⌘N and ⌘⇧N open the creators", () => {
    const onOpenCreateBot = vi.fn(), onOpenCreateRoom = vi.fn();
    render(<MessengerShell bots={BOTS} onOpenCreateBot={onOpenCreateBot} onOpenCreateRoom={onOpenCreateRoom} />);
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(screen.queryByRole("complementary", { name: "sidebar" })).toBeNull();
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    expect(screen.getByRole("complementary", { name: "sidebar" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    fireEvent.keyDown(window, { key: "N", metaKey: true, shiftKey: true });
    expect(onOpenCreateBot).toHaveBeenCalledTimes(1);
    expect(onOpenCreateRoom).toHaveBeenCalledTimes(1);
  });

  it("G then A opens Approvals, but not while typing in a field", () => {
    const onTabChange = vi.fn();
    render(<MessengerShell bots={BOTS} onTabChange={onTabChange}><input aria-label="campo" /></MessengerShell>);
    const field = screen.getByLabelText("campo");
    field.focus();
    fireEvent.keyDown(field, { key: "g" });
    fireEvent.keyDown(field, { key: "a" });
    expect(onTabChange).not.toHaveBeenCalled();
    field.blur();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "a" });
    expect(onTabChange).toHaveBeenCalledWith("aprovacoes");
  });

  it("⌘I puts the cursor in the conversation's composer", () => {
    render(<MessengerShell bots={BOTS} selectedBotName="vendas"><form><textarea aria-label="Mensagem" /></form></MessengerShell>);
    fireEvent.keyDown(window, { key: "i", metaKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Mensagem"));
  });
});
