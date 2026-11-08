// dashboard/src/lib/skillTeach.ts
// The pure rules of the review sheet (contract v0.11 §3.2 step 3 and §3.4): what the sheet can say about a draft's text BEFORE the server is asked, all of it about text that the person can read and EDIT.
// Nothing here changes what the Bot wrote: `removeMarked` is the one function that removes anything, and the sheet calls it ONLY on the person's tap ("Remove them"). The table of invisible characters
// is the shared one (lib/skillDraft.ts imports backend/unicode_invisible.json); nothing is typed twice. No Hermes, no DOM, no HTML.

import { isMarked, markedIn, codeOf, type Mark } from "./skillDraft";

/** The most blank lines in a row, and the longest line in code points, that the sheet accepts without a warning (3.2 step 3): padding must not push text out of sight. */
export const BLANK_RUN_MAX = 20;
export const LINE_COLUMNS_MAX = 1000;

/** The header's `name:` the way a person reads it (the first `name:` line between the opening `---` and the closing one, without its quotes), or null. It is a convenience for the form: the SERVER compares the
 *  header's real name (parsed as YAML) with the request's and refuses a mismatch (`bad_name`, A-160), so a wrong guess here is a refusal in words, never a skill under another name. */
export function headerName(text: string): string | null {
  const lines = text.split("\n");
  if (lines[0] !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) return null;                       // the header closed before any name
    const found = /^name:[ \t]*(.*?)[ \t]*$/.exec(lines[i]);
    if (!found) continue;
    const value = found[1];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    const name = quoted ? quoted[2] : value;
    return name === "" ? null : name;
  }
  return null;
}

/** How many lines the text has by LF (the sheet's own count, "N lines, it ends at line N"). */
export const lineCount = (text: string): number => text.split("\n").length;

/** The longest run of blank lines (only spaces and tabs) in a row. */
export function longestBlankRun(text: string): number {
  let best = 0, run = 0;
  for (const line of text.split("\n")) {
    run = /^[ \t\r]*$/.test(line) ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Is there a line of more than `max` columns (in code points, the unit the server's columns use)? A UTF-16 length that is already short cannot be long in code points. */
export function hasLongLine(text: string, max = LINE_COLUMNS_MAX): boolean {
  return text.split("\n").some((line) => line.length > max && Array.from(line).length > max);
}

/** The short names a panel can say for the invisible characters people meet (the rest is named by its code, `U+034F`). */
const SHORT: Readonly<Record<number, string>> = {
  0x00ad: "SHY", 0x061c: "ALM", 0x200b: "ZWSP", 0x200c: "ZWNJ", 0x200d: "ZWJ", 0x200e: "LRM", 0x200f: "RLM", 0x2060: "WJ",
  0x2066: "LRI", 0x2067: "RLI", 0x2068: "FSI", 0x2069: "PDI", 0xfeff: "BOM",
};
export const shortName = (codePoint: number): string => SHORT[codePoint] ?? codeOf(codePoint);

/** The marked characters of a text, grouped by kind (in code point order) and the lines they sit on (ascending, each once): what the panel above the text says. `count` is how many there are in all. */
export function markedSummary(text: string): { count: number; kinds: Array<{ code: string; name: string; count: number }>; lines: number[] } {
  const { count, marks } = markedIn(text);
  const by = new Map<number, number>();
  for (const m of marks) by.set(m.codePoint, (by.get(m.codePoint) ?? 0) + 1);
  const kinds = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([cp, n]) => ({ code: codeOf(cp), name: shortName(cp), count: n }));
  return { count, kinds, lines: [...new Set(marks.map((m: Mark) => m.line))].sort((a, b) => a - b) };
}

/** The text with exactly the MARKED characters taken out: what "Remove them" does, on the person's tap and nowhere else. Every other character, the refused ones included, stays. */
export function removeMarked(text: string): string {
  let out = "";
  for (const ch of text) if (!isMarked(ch.codePointAt(0) as number)) out += ch;
  return out;
}

/** The read-only preview: the text with each MARKED character shown as a visible token (`[U+200C]`), so a reader sees what the editable area cannot show. Nothing else changes. */
export function markedPreview(text: string): string {
  let out = "";
  for (const ch of text) { const c = ch.codePointAt(0) as number; out += isMarked(c) ? `[${codeOf(c)}]` : ch; }
  return out;
}

export type HiddenClass = "tags" | "variation" | "bidi" | "separator" | "control" | "noncharacter" | "other";
/** What a REFUSED character is, in a class a person can be told ("a Unicode Tag character", "a bidi override"...), from the `U+XXXX` the server and the extractor name it by (3.4: never the character itself). */
export function hiddenClass(code: string): HiddenClass {
  const found = /^U\+([0-9A-F]{4,6})$/.exec(code);
  const c = found ? parseInt(found[1], 16) : -1;
  if (c >= 0xe0000 && c <= 0xe007f) return "tags";
  if (c >= 0xe0100 && c <= 0xe01ef) return "variation";
  if (c >= 0x202a && c <= 0x202e) return "bidi";
  if (c === 0x2028 || c === 0x2029) return "separator";
  if ((c >= 0 && c <= 0x1f) || (c >= 0x7f && c <= 0x9f)) return "control";
  if ((c >= 0xfdd0 && c <= 0xfdef) || (c >= 0 && c <= 0x10ffff && (c & 0xfffe) === 0xfffe)) return "noncharacter";
  return "other";
}
