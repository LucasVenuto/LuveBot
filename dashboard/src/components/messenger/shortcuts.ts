// dashboard/src/components/messenger/shortcuts.ts
// Keyboard shortcuts of spec §8, as a pure mapping from a key press to an action (no markup).
// ⌘ on macOS, Ctrl elsewhere. Typing in a field never triggers a shortcut, except the two that are about
// fields: ⌘K (search) and ⌘I (go to the composer). In a browser tab, ⌘N and ⌘1…9 belong to the browser;
// they reach LuveBot in the installed app (PWA window).

export type ShortcutAction =
  | { type: "search" }
  | { type: "newBot" }
  | { type: "newRoom" }
  | { type: "toggleSidebar" }
  | { type: "bot"; index: number }       // ⌘1…9: the nth Bot of the contact list
  | { type: "step"; delta: -1 | 1 }      // Alt+↑/↓: previous / next Bot
  | { type: "composer" }
  | { type: "approvals" }                // G then A
  | { type: "armG" };                    // first half of "G then A"

export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  editable: boolean;   // the focus is in an input, textarea, select or contenteditable
}

export const G_WINDOW_MS = 1500;

/** The action for a key press, or null. `gArmedAt`: when "G" was pressed (for "G then A"), or null. */
export function shortcutFor(k: KeyPress, gArmedAt: number | null, now: number): ShortcutAction | null {
  const mod = k.metaKey || k.ctrlKey;
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if (mod && !k.altKey) {
    if (key === "k") return { type: "search" };
    if (key === "i") return { type: "composer" };
    if (k.editable) return null;
    if (key === "n") return k.shiftKey ? { type: "newRoom" } : { type: "newBot" };
    if (key === "b" && !k.shiftKey) return { type: "toggleSidebar" };
    if (/^[1-9]$/.test(key) && !k.shiftKey) return { type: "bot", index: Number(key) - 1 };
    return null;
  }
  if (k.editable) return null;
  if (k.altKey && !mod && !k.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) return { type: "step", delta: key === "ArrowUp" ? -1 : 1 };
  if (!mod && !k.altKey && !k.shiftKey) {
    if (key === "a" && gArmedAt !== null && now - gArmedAt <= G_WINDOW_MS) return { type: "approvals" };
    if (key === "g") return { type: "armG" };
  }
  return null;
}

/** Whether the focused element takes text, so letters and arrows stay with it. */
export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable === true;
}

/** The Bot at `index`, or the neighbour of the selected one (wrapping), in the list's order. */
export function botAt<T extends { name: string }>(list: readonly T[], selected: string | null, a: { type: "bot"; index: number } | { type: "step"; delta: -1 | 1 }): T | null {
  if (!list.length) return null;
  if (a.type === "bot") return list[a.index] ?? null;
  const i = list.findIndex((b) => b.name === selected);
  if (i < 0) return a.delta > 0 ? list[0] : list[list.length - 1];
  return list[(i + a.delta + list.length) % list.length];
}
