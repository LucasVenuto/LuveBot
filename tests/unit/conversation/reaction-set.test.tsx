// tests/unit/conversation/reaction-set.test.tsx (docs/contracts/voice-language-reactions-v0.md section 4, A-279, slice RX-2)
// The closed set of 24 and how a person reaches it: the screen's list is the contract's 24 and holds every emoji the server accepts (a test reads the server's list); written as code points, no invisible character in the source;
// a bar of six quick ones next to a hovered or focused message (a pointer's shortcut, out of the keyboard's tab order: the keyboard goes through "+"); the "+" opens the grid of 24 with the note, once; on touch a long press on the row
// opens the grid; and the page never says the Bot reacts.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { ReactionStrip } from "@/components/conversation/Reactions";
import { QUICK_REACTIONS, REACTION_SET } from "@/components/conversation/reactionSet";
import { translations, setLuveLocale } from "@/i18n";

const cps = (hex: string) => hex.split(" ").map((h) => String.fromCodePoint(...h.split("-").map((x) => parseInt(x, 16))));
/** The contract's 24, in its order (section 4), as code points: 👍 👎 ❤️ 🔥 🎉 👏 🙏 💪 ✅ ❌ ⭐ 💡 👀 🤔 🙂 😄 😂 😍 😮 😢 😡 🚀 💯 🤝 */
const CONTRACT = cps("1F44D 1F44E 2764-FE0F 1F525 1F389 1F44F 1F64F 1F4AA 2705 274C 2B50 1F4A1 1F440 1F914 1F642 1F604 1F602 1F60D 1F62E 1F622 1F621 1F680 1F4AF 1F91D");
const CONTRACT_QUICK = cps("1F44D 2764-FE0F 1F604 1F389 1F64F 1F440");

/** The server's closed list, read from backend/reactions.py (`EMOJIS = (...)`): Python's \U escapes and literal characters alike. */
function serverSet(): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, "../../../backend/reactions.py"), "utf8");
  const body = /^EMOJIS = \(([\s\S]*?)\)\s*(?:#.*)?$/m.exec(src)?.[1] ?? "";
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1].replace(/\\U([0-9A-Fa-f]{8})/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16))));
}

if (typeof (window as any).PointerEvent === "undefined" || !("pointerType" in (window as any).PointerEvent.prototype)) {
  (window as any).PointerEvent = class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
  };
}

beforeEach(() => { cleanup(); setLuveLocale("pt"); });
afterEach(() => { setLuveLocale("pt"); vi.useRealTimers(); });

describe("the closed set of 24", () => {
  it("is the contract's 24, in its order, with no repeat and nothing else", () => {
    expect(REACTION_SET).toHaveLength(24);
    expect(new Set(REACTION_SET).size).toBe(24);
    expect([...REACTION_SET]).toEqual(CONTRACT);
    expect([...QUICK_REACTIONS]).toEqual(CONTRACT_QUICK);
    for (const quick of QUICK_REACTIONS) expect(REACTION_SET).toContain(quick);
  });
  it("is exactly the server's list (backend/reactions.py, RX-1): the 24 of the contract, the same set on both sides, so what the grid offers the server takes and what the server takes the grid offers", () => {
    const server = serverSet();
    expect(server).toHaveLength(24);
    expect(new Set(server).size).toBe(24);
    expect([...server].sort()).toEqual([...REACTION_SET].sort());
    expect([...server].sort()).toEqual([...CONTRACT].sort());
  });
  it("is written as code points: no invisible character (the heart's variation selector) hides in the source's strings", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../../dashboard/src/components/conversation/reactionSet.ts"), "utf8");
    expect(src).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufe00-\ufe0f\ufeff]/);
    expect(src).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("the strip: a bar of six quick ones, a '+' with the grid of 24", () => {
  const strip = (props: Partial<React.ComponentProps<typeof ReactionStrip>> = {}) => {
    const onReact = vi.fn(async () => {});
    render(<ReactionStrip side="bot" marks={[]} turn={1} slot="replyRow" onReact={onReact} {...props} />);
    return onReact;
  };
  it("the six quick reactions are real buttons named 'Reação rápida: …', out of the tab order (the keyboard goes through '+'); one click reacts with it", async () => {
    const onReact = strip();
    const bar = screen.getByRole("group", { name: "Reações rápidas" });
    const buttons = within(bar).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([...QUICK_REACTIONS]);
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(QUICK_REACTIONS.map((e) => `Reação rápida: ${e}`));
    expect(buttons.every((b) => b.getAttribute("tabindex") === "-1")).toBe(true);
    expect((screen.getByRole("button", { name: "Reagir" }).getAttribute("tabindex"))).toBeNull();   // "+" stays in the tab order
    await act(async () => { fireEvent.click(buttons[2]); });
    expect(onReact).toHaveBeenCalledWith(1, "replyRow", QUICK_REACTIONS[2], false);
  });
  it("the quick one that is the current mark is pressed and takes it off (clear)", async () => {
    const onReact = strip({ marks: [{ emoji: QUICK_REACTIONS[0], author: "user" }] });
    const bar = screen.getByRole("group", { name: "Reações rápidas" });
    const mine = within(bar).getByRole("button", { name: `Tirar a reação rápida ${QUICK_REACTIONS[0]}` });
    expect(mine.getAttribute("aria-pressed")).toBe("true");
    await act(async () => { fireEvent.click(mine); });
    expect(onReact).toHaveBeenCalledWith(1, "replyRow", QUICK_REACTIONS[0], true);
  });
  it("'+' opens the grid of 24 (each one named 'Reagir com …') and the note, once; picking one reacts and closes it", async () => {
    const onReact = strip();
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reagir" }));
    const grid = screen.getByRole("group", { name: "Escolha uma reação" });
    expect(within(grid).getAllByRole("button").map((b) => b.textContent)).toEqual([...REACTION_SET]);
    expect(within(grid).getAllByRole("button")).toHaveLength(24);
    expect(grid.textContent).toContain("Uma reação sua por mensagem; escolher outra troca a anterior.");
    expect(screen.getAllByText("Uma reação sua por mensagem; escolher outra troca a anterior.")).toHaveLength(1);   // said once, in the picker
    await act(async () => { fireEvent.click(within(grid).getByRole("button", { name: `Reagir com ${REACTION_SET[8]}` })); });
    expect(onReact).toHaveBeenCalledWith(1, "replyRow", REACTION_SET[8], false);
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
  });
  it("on a Hermes that keeps no marks (off) there is neither bar nor '+' nor grid", () => {
    strip({ off: true });
    expect(screen.queryByRole("group", { name: "Reações rápidas" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reagir" })).toBeNull();
  });
  it("a Hermes that keeps no marks (off) that still has a mark to show draws it, with neither the quick bar nor '+' nor a way to change it", () => {
    strip({ off: true, marks: [{ emoji: QUICK_REACTIONS[0], author: "user" }] });
    expect(screen.getByTestId("reaction-mark").textContent).toBe(QUICK_REACTIONS[0]);
    expect((screen.getByTestId("reaction-mark") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("group", { name: "Reações rápidas" })).toBeNull();
    expect(screen.queryByTestId("reaction-quick")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reagir" })).toBeNull();
  });
  it("the bar and the grid are in English too", () => {
    setLuveLocale("en");
    strip();
    expect(within(screen.getByRole("group", { name: "Quick reactions" })).getAllByRole("button")[0].getAttribute("aria-label")).toBe(`Quick reaction: ${QUICK_REACTIONS[0]}`);
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    expect(screen.getByRole("group", { name: "Pick a reaction" }).textContent).toContain("One reaction from you per message; picking another replaces it.");
  });
  it("the stylesheet shows the bar only on hover or focus, never on touch, with a 6-column grid (44 px cells on touch)", () => {
    const css = fs.readFileSync(path.resolve(__dirname, "../../../dashboard/src/style.css"), "utf8");
    expect(css).toMatch(/\.lb-react-quick \{ display: none;/);
    expect(css).toMatch(/\.lb-turn:hover \.lb-react-quick, \.lb-react:focus-within \.lb-react-quick \{ display: inline-flex; \}/);
    expect(css).toMatch(/@media \(hover: none\) \{ \.lb-react-quick \{ display: none !important; \} \}/);
    expect(css).toMatch(/\.lb-react-grid \{ display: grid; grid-template-columns: repeat\(6, 36px\);/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.lb-react-grid \{ grid-template-columns: repeat\(6, 44px\); \}/);
  });
});

describe("on touch a long press on the row opens the grid", () => {
  const down = (el: Element, pointerType: string) => fireEvent.pointerDown(el, { pointerType, pointerId: 7 });
  const row = () => screen.getByTestId("reactions");
  const draw = (off = false) => render(<ReactionStrip side="me" marks={[]} turn={2} slot="userRow" onReact={async () => {}} off={off} />);
  it("a touch held for 500 ms opens it; a mouse press, an early release and a move do not", () => {
    vi.useFakeTimers();
    draw();
    down(row(), "mouse"); act(() => { vi.advanceTimersByTime(900); });
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
    down(row(), "touch"); act(() => { vi.advanceTimersByTime(400); }); fireEvent.pointerUp(row(), { pointerType: "touch", pointerId: 7 }); act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
    down(row(), "touch"); act(() => { vi.advanceTimersByTime(300); }); fireEvent.pointerMove(row(), { pointerType: "touch", pointerId: 7 }); act(() => { vi.advanceTimersByTime(400); });
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
    down(row(), "touch"); act(() => { vi.advanceTimersByTime(499); });
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
    act(() => { vi.advanceTimersByTime(2); });
    expect(within(screen.getByRole("group", { name: "Escolha uma reação" })).getAllByRole("button")).toHaveLength(24);
  });
  it("with no marks kept (off) the row does not even exist, so a long press has nothing to open", () => {
    vi.useFakeTimers();
    draw(true);
    expect(screen.queryByTestId("reactions")).toBeNull();
    expect(screen.queryByRole("group", { name: "Escolha uma reação" })).toBeNull();
  });
  it("the timer is dropped when the strip goes away (nothing opens later, nothing leaks)", () => {
    vi.useFakeTimers();
    const { unmount } = draw();
    down(row(), "touch");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the page never says the Bot reacts", () => {
  it("no reaction sentence, in either language, says the Bot reacts or sent a reaction; the Bot's mark keeps its own look and name", () => {
    for (const lang of ["pt", "en"] as const) {
      const table = translations[lang] as Record<string, string>;
      const mine = Object.entries(table).filter(([k]) => /^react/.test(k));
      expect(mine.length).toBeGreaterThan(15);
      for (const [key, text] of mine) { if (key !== "reactBot") expect(text, `${lang}.${key}`).not.toMatch(/\bBot (reage|reagiu|reagirá|reacts|reacted|will react)|o Bot (reage|reagiu)|the Bot (reacts|reacted)/i); }
    }
    expect((translations.pt as Record<string, string>).reactBot).toBe("Reação do Bot");   // the mark Hermes holds from its own app keeps its name
  });
});
