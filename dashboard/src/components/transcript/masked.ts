// dashboard/src/components/transcript/masked.ts
// What a tool result was replaced by (the panel boundary: a mask that the server registers replaces the text of a result that must not reach a person, and says only WHAT happened). The server cannot know the viewer's
// language, so it sends the kind and this screen draws the words: `read` (a note was read) or `hidden` (anything else), and, only in a history row for a reader of that context, the shown path and the size. A frame never
// carries a path or a size, and this screen never draws one it was given in a frame. A kind this screen does not know is no mask at all: the screen draws what it was sent, as before. The words of a mask are not in
// this public folder: they come through the extension point (`@luvebot/extra`), and the public build has none.
import { maskWords } from "@luvebot/extra";
import { visibleTokens } from "../../lib/hiddenChars";

export interface Masked { kind: "read" | "hidden"; path?: string; size?: number }
const KINDS: ReadonlySet<unknown> = new Set(["read", "hidden"]);

/** The mask of a history row: its kind and, when the server gave them, the shown path (text) and the size (a whole number, zero or more). Anything else is no mask. */
export function maskedOfRow(raw: unknown): Masked | undefined {
  const m = raw as { kind?: unknown; path?: unknown; size?: unknown } | null;
  if (!m || typeof m !== "object" || !KINDS.has(m.kind)) return undefined;
  return {
    kind: m.kind as Masked["kind"],
    ...(typeof m.path === "string" && m.path ? { path: m.path } : {}),
    ...(typeof m.size === "number" && Number.isInteger(m.size) && m.size >= 0 ? { size: m.size } : {}),
  };
}
/** The mask of a stream frame: ONLY its kind (a frame has no path and no size to draw). */
export function maskedOfFrame(raw: unknown): Masked | undefined {
  const m = maskedOfRow(raw);
  return m ? { kind: m.kind } : undefined;
}

/** The line a masked result is drawn as, in the person's language, or `null` when this build has no words for it (then the screen draws what it was sent). The path goes through the strict helper. */
export function maskedLine(m: Masked, locale: "pt" | "en"): string | null {
  const words = maskWords(m.kind, locale);
  if (!words) return null;
  return [words.text, m.path ? visibleTokens(m.path) : "", typeof m.size === "number" ? words.size(m.size) : ""].filter(Boolean).join(" · ");
}
