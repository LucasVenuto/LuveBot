// dashboard/src/components/pages/format.ts
// The toolbar and the shortcuts of the page editor (ADR-009 option C): they INSERT Markdown, and only Markdown the safe renderer
// (lib/render/markdown.tsx) understands: `# ` to `### ` titles, `- ` lists, `> ` quotes, fenced code, `code`, **bold**, *italic* and
// [text](https://…) links. Nothing here is a model of the document: a function from (text, selection) to (text, selection), over the
// editor's text with "\n" line breaks. When a request would make something the renderer would show wrong (a "*" next to a bold marker,
// a "]" inside a link text, a backtick inside inline code) it returns null and the text is left alone. Applying a format twice undoes it.

import { safeHref } from "../../lib/render/markdown";

export type FormatKind = "heading" | "bold" | "italic" | "list" | "quote" | "code" | "link";
export interface Edit { value: string; start: number; end: number }

// The renderer's own patterns for what this module toggles (markdown.tsx: HEADING, LIST, blockquote)
const HEADING = /^( {0,3})(#{1,3})[ \t]+(\S.*)$/;
const BULLET = /^(\s*)[-*+]\s+/;
const QUOTE = /^(\s*)>\s?/;
const FENCE = /^\s*```/;

/** The whole lines a selection touches: [from, to) in `value`. A selection that ends right after a "\n" does not take the next line. */
function lineRange(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const anchor = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nl = value.indexOf("\n", anchor);
  return [from, nl === -1 ? value.length : nl];
}

function replaceLines(value: string, from: number, to: number, lines: string[], start: number, end: number, firstDelta: number): Edit {
  const block = lines.join("\n");
  const out = value.slice(0, from) + block + value.slice(to);
  if (start === end) { const caret = Math.max(from, start + firstDelta); return { value: out, start: caret, end: caret }; }
  return { value: out, start: from, end: from + block.length };
}

function heading(value: string, start: number, end: number): Edit {
  const [from, to] = lineRange(value, start, start);   // a title is one line: the caret's (or the selection's first)
  const line = value.slice(from, to);
  const m = HEADING.exec(line);
  const next = m ? (m[2].length === 3 ? m[3] : `${m[1]}${"#".repeat(m[2].length + 1)} ${m[3]}`) : `## ${line}`;
  const out = value.slice(0, from) + next + value.slice(to);
  if (start !== end) return { value: out, start: from, end: from + next.length };
  const caret = Math.max(from, start + next.length - line.length);
  return { value: out, start: caret, end: caret };
}

function prefixed(kind: "list" | "quote", value: string, start: number, end: number): Edit {
  const [from, to] = lineRange(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const has = kind === "list" ? (l: string) => BULLET.test(l) : (l: string) => QUOTE.test(l);
  const used = lines.filter((l) => l.trim());
  const remove = used.length > 0 && used.every(has);
  const marker = kind === "list" ? "- " : "> ";
  let firstDelta = 0, first = true;
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    const next = remove ? l.replace(kind === "list" ? BULLET : QUOTE, "$1") : `${marker}${l}`;
    if (first) { firstDelta = next.length - l.length; first = false; }
    return next;
  });
  return replaceLines(value, from, to, out, start, end, firstDelta);
}

/** Wraps (or unwraps) `mark` around the text of each line of the selection, whitespace left outside; an empty selection gets an empty pair. */
function inlineWrap(mark: "**" | "*" | "`", value: string, start: number, end: number): Edit | null {
  const m = mark.length, forbidden = mark === "`" ? "`" : "*";
  if (start === end) {
    const out = value.slice(0, start) + mark + mark + value.slice(end);
    return { value: out, start: start + m, end: start + m };
  }
  const text = value.slice(start, end);
  // The markers right around the selection: take them off. For "*" a third star beside them is another marker ("***"): not touched.
  const around = !text.includes("\n") && value.slice(start - m, start) === mark && value.slice(end, end + m) === mark;
  const lone = mark === "`" || (mark === "**" ? value[start - m - 1] !== "*" && value[end + m] !== "*" : value[start - 2] !== "*" && value[end + 1] !== "*");
  if (around && lone && !text.includes(forbidden)) {
    return { value: value.slice(0, start - m) + text + value.slice(end + m), start: start - m, end: end - m };
  }
  const segments = text.split("\n"), core = (seg: string) => seg.trim();
  const wrapped = (seg: string) => seg.length > 2 * m && seg.startsWith(mark) && seg.endsWith(mark) && !seg.slice(m, -m).includes(forbidden);
  const live = segments.filter((seg) => core(seg));
  const edit = (f: (seg: string) => string): Edit => {
    const out = segments.map((seg) => (core(seg) ? seg.replace(core(seg), () => f(core(seg))) : seg)).join("\n");
    return { value: value.slice(0, start) + out + value.slice(end), start, end: start + out.length };
  };
  if (live.length && live.every((seg) => wrapped(core(seg)))) return edit((c) => c.slice(m, -m));
  if (live.some((seg) => !wrapped(core(seg)) && core(seg).includes(forbidden))) return null;
  if (mark !== "`") {   // a star just outside the selection would join the marker
    const first = segments[0], last = segments[segments.length - 1];
    if (value[start + first.length - first.trimStart().length - 1] === "*" || value[end - (last.length - last.trimEnd().length)] === "*") return null;
  }
  return edit((c) => (wrapped(c) ? c : `${mark}${c}${mark}`));
}

function codeBlock(value: string, start: number, end: number): Edit | null {
  const [from, to] = lineRange(value, start, end);
  const lines = value.slice(from, to).split("\n");
  if (lines.length >= 2 && FENCE.test(lines[0]) && FENCE.test(lines[lines.length - 1])) {   // the selected lines ARE the fence: take it off
    const inner = lines.slice(1, -1).join("\n");
    return { value: value.slice(0, from) + inner + value.slice(to), start: from, end: from + inner.length };
  }
  if (lines.some((l) => FENCE.test(l))) return null;                                        // a fence in the middle would close the block early
  const body = lines.join("\n");
  return { value: value.slice(0, from) + "```\n" + body + "\n```" + value.slice(to), start: from + 4, end: from + 4 + body.length };
}

function code(value: string, start: number, end: number): Edit | null {
  const text = value.slice(start, end);
  const inline = start === end || (!text.includes("\n") && (!text.includes("`") || /^`[^`\n]+`$/.test(text)));
  return inline ? inlineWrap("`", value, start, end) : codeBlock(value, start, end);
}

function link(value: string, start: number, end: number, placeholder: string): Edit | null {
  const text = value.slice(start, end);
  const whole = /^\[([^\]\n]+)\]\(([^)\n]*)\)$/.exec(text);
  if (whole) return { value: value.slice(0, start) + whole[1] + value.slice(end), start, end: start + whole[1].length };
  if (text.includes("\n") || text.includes("]")) return null;               // the renderer's link text is one line and has no "]"
  const make = (label: string, url: string, select: "label" | "url"): Edit => {
    const piece = `[${label}](${url})`;
    const s = select === "label" ? start + 1 : start + label.length + 3;
    const len = select === "label" ? label.length : url.length;
    return { value: value.slice(0, start) + piece + value.slice(end), start: s, end: s + len };
  };
  if (start === end) return make(placeholder, "https://", "label");
  return safeHref(text) ? make(placeholder, text, "label") : make(text, "https://", "url");
}

/** Is the line of `at` inside a fenced block (an odd number of fence lines above it)? */
function insideFence(value: string, at: number): boolean {
  const from = value.lastIndexOf("\n", at - 1) + 1;
  return value.slice(0, from).split("\n").filter((l) => FENCE.test(l)).length % 2 === 1;
}

/** Applies a format to the selection [start, end) of `value` (line breaks "\n"); null when it would make Markdown the renderer shows wrong. */
export function applyFormat(kind: FormatKind, value: string, start: number, end: number, linkText = "texto"): Edit | null {
  if (kind !== "code" && insideFence(value, start)) return null;   // in a code block the renderer shows every character as it is
  switch (kind) {
    case "heading": return heading(value, start, end);
    case "list": case "quote": return prefixed(kind, value, start, end);
    case "bold": return inlineWrap("**", value, start, end);
    case "italic": return inlineWrap("*", value, start, end);
    case "code": return code(value, start, end);
    case "link": return link(value, start, end, linkText);
  }
}

/** The shortcut of a key press, or null: Mod+B bold, Mod+I italic, Mod+E code, Mod+Shift+K link, Mod+Shift+7 list, Mod+Shift+. quote.
 *  Mod+K stays the app's search palette: pressing it by habit must never write into the page. */
export function shortcutOf(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): FormatKind | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.shiftKey) return e.code === "KeyK" ? "link" : e.code === "Digit7" ? "list" : e.code === "Period" ? "quote" : null;
  const key = e.key.toLowerCase();
  return key === "b" || e.code === "KeyB" ? "bold" : key === "i" || e.code === "KeyI" ? "italic" : key === "e" || e.code === "KeyE" ? "code" : null;
}
