// dashboard/src/lib/evidence.ts
// The evidence block a Bot may end its answer with (contract v0.10 §3.1): ONE closed fence whose info string is exactly `luve-evidence`, with the headers
// facts / assumptions / done / awaiting / questions and `- ` items under them. It is a FORMAT and a READING, never a verification: the card that draws it says the
// Bot wrote it and LuveBot did not check it.
//
// STRICT AND ALL-OR-NOTHING: any violation leaves the whole block as an ordinary code block (never a partial card, never a guess). Pure: no Hermes, no backend, no
// HTML. Everything that comes out is PLAIN TEXT (a source is text with a copy button, never a link; HTML and Markdown inside an item stay characters).
// Rules, each with its test: exactly one such fence per message and closed (two or more: none is a card; an unclosed one, still streaming, is code); a body of at
// most 8 KiB; headers at most once, in any order, an unknown or repeated one refused; a header with no items refused (the Bot says `- none`); items `- text`
// on one line, 1 to 300 characters, at most 12 per header, no nesting, no continuation lines; ` | source: text` at the end of an item, 1 to 160 characters.
// NOTHING IS REMOVED (contract v0.10 3.1 amended, v0.11 section 8, A-195): a hidden character is drawn as the visible token `[U+XXXX]` BEFORE the lines are read, so the lengths count the text as
// drawn and a token never changes a line break. The text of an item is PROSE (the refuse class becomes tokens; the mark class, a ZWNJ of a Persian fact, stays); a source is a copyable reference, so it
// is STRICT (both classes). Whitespace is collapsed (a TAB is whitespace), except a character the table marks (U+FEFF is `\s` too: it stays). A hidden character inside a header makes it unknown: the
// block stays an ordinary code block.

import { proseTokens, visibleTokens } from "./hiddenChars";

export const SECTIONS = ["facts", "assumptions", "done", "awaiting", "questions"] as const;
export type Section = (typeof SECTIONS)[number];
export const BODY_MAX_BYTES = 8 * 1024, ITEMS_MAX = 12, ITEM_MAX = 300, SOURCE_MAX = 160;

export interface EvidenceItem { text: string; source?: string }
/** `null`: the Bot did not say (the header is absent); `[]`: the Bot said `- none`; else what it listed. Absent and none are NOT the same thing. */
export type EvidenceBlock = EvidenceItem[] | null;
export type Evidence = Record<Section, EvidenceBlock>;
export type EvidenceSegment = { kind: "text"; text: string } | { kind: "evidence"; evidence: Evidence };

const INFO = "luve-evidence";
// the fence of CommonMark: up to 3 spaces, 3+ backticks or tildes (any fence hides what is inside it); a backtick fence's info string holds no backtick. The EVIDENCE fence itself is backtick only
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADER = new RegExp(`^(${SECTIONS.join("|")}):$`);
const SOURCE_MARK = / \| source:(?= |$)/g;

/** The refuse class of the table as tokens (so a VT, a FF or a NEL is a token INSIDE the line, never a break), then the whitespace collapsed to one space and the ends trimmed. The mark class stays,
 *  U+FEFF included (it is `\s` for JavaScript: collapsing it would take it out in silence). What is left is plain text. */
const SPACES = /[^\S\ufeff]+/gu, EDGES = /^[^\S\ufeff]+|[^\S\ufeff]+$/gu;   // `\s` but U+FEFF
const edge = (s: string): string => s.replace(EDGES, "");   // not String.trim(): it would take a U+FEFF off the ends in silence
const clean = (s: string): string => edge(proseTokens(s).replace(SPACES, " "));
const length = (s: string) => Array.from(s).length;

function item(rest: string): EvidenceItem | "none" | null {
  const spaced = ` ${rest}`;                                         // the dash's own space: "- | source: x" is a source with no item, not an item that starts with a bar
  const marks = [...spaced.matchAll(SOURCE_MARK)];
  if (marks.length > 1) return null;
  const at = marks[0]?.index;
  const text = at === undefined ? rest : edge(spaced.slice(1, at));
  const source = at === undefined ? undefined : visibleTokens(edge(spaced.slice(at + marks[0][0].length)));   // a source is strict: the mark class too (the refuse class is already tokens)
  if (!text || length(text) > ITEM_MAX) return null;
  if (source !== undefined && (!source || length(source) > SOURCE_MAX)) return null;
  if (text === "none" && source === undefined) return "none";   // the literal, lowercase: "- None" is an ordinary item
  return source === undefined ? { text } : { text, source };
}

/** The lines of one fence's body as the five blocks, or null when anything breaks a rule. */
export function parseEvidenceBody(lines: readonly string[]): Evidence | null {
  const out: Evidence = { facts: null, assumptions: null, done: null, awaiting: null, questions: null };
  let current: Section | null = null, none = false;
  const filled = () => !current || out[current]!.length > 0 || none;   // the header before this point listed something, or said `- none`
  for (const raw of lines) {
    const line = clean(raw);
    if (!line) continue;                                            // a blank line carries nothing
    if (/^\s/u.test(raw)) return null;                              // nesting or a continuation line
    const header = HEADER.exec(line);
    if (header) {
      if (!filled()) return null;                                   // the header before it listed nothing and did not say `- none`
      const name = header[1] as Section;
      if (out[name] !== null) return null;                          // a repeated header
      out[name] = []; current = name; none = false;
      continue;
    }
    if (!current || !line.startsWith("- ")) return null;            // an unknown header, a line before any header, a line that is not an item
    const found = item(line.slice(2));
    if (!found) return null;
    const list = out[current]!;
    if (found === "none") { if (none || list.length) return null; none = true; continue; }
    if (none || list.length >= ITEMS_MAX) return null;              // `- none` beside other items, or a 13th item
    list.push(found);
  }
  if (!filled()) return null;
  return SECTIONS.some((s) => out[s] !== null) ? out : null;        // not one header: nothing to draw
}

/** A message as text and at most ONE evidence card. A message with no `luve-evidence` comes back whole (the usual case costs one `includes`). */
export function splitEvidence(text: string): EvidenceSegment[] {
  const whole: EvidenceSegment[] = [{ kind: "text", text }];
  if (!text.includes(INFO)) return whole;
  const lines = text.split(/\r\n|\n|\r/);
  let fence: { ch: string; len: number; at: number; evidence: boolean } | null = null;
  let first: { at: number; close: number } | null = null, count = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) {                                                    // inside a fence (any): only its own closing line matters, a marker in it is code
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) {
        if (fence.evidence && first && first.at === fence.at) first.close = i;
        fence = null;
      }
      continue;
    }
    if (!f || (f[1][0] === "`" && f[2].includes("`"))) continue;    // not a fence at all (an inline span that starts a line)
    const evidence = f[1][0] === "`" && f[2].trim() === INFO;      // only a BACKTICK fence: it is the one the message renderer draws as code (a tilde one would give a card the renderer shows otherwise)
    fence = { ch: f[1][0], len: f[1].length, at: i, evidence };
    if (evidence && ++count === 1) first = { at: i, close: -1 };
  }
  if (count !== 1 || !first || first.close < 0) return whole;       // none, two or more, or one still open (streaming): code
  const opened = first as { at: number; close: number }, closedAt = opened.close;   // (TS loses what the loop assigned)
  const body = lines.slice(opened.at + 1, closedAt);
  if (new TextEncoder().encode(body.join("\n")).length > BODY_MAX_BYTES) return whole;
  const evidence = parseEvidenceBody(body);
  if (!evidence) return whole;
  const before = lines.slice(0, opened.at).join("\n"), after = lines.slice(closedAt + 1).join("\n");
  return [...(before.trim() ? [{ kind: "text" as const, text: before }] : []), { kind: "evidence", evidence }, ...(after.trim() ? [{ kind: "text" as const, text: after }] : [])];
}
