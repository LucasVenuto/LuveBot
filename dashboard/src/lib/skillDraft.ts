// dashboard/src/lib/skillDraft.ts
// The skill a Bot drafts when the person asks "Save as a skill" (contract v0.11 §3.2): ONE closed code fence whose info string is exactly `luve-skill`, holding a complete SKILL.md that starts with its
// `---` header. A skill is instructions the Bot follows LATER, so this is the one place where text from a conversation becomes persistent instructions: the extractor is STRICT and ALL-OR-NOTHING (anything
// else is "no draft": the answer stays ordinary text and the screen offers to ask again) and PURE (no Hermes, no backend, no DOM). What it returns is exactly what the Bot wrote (nothing is ever removed or
// changed), so the review sheet can show ALL of it and the person decides on what is really there.
//
// Rules, each with its test: BACKTICK fences only (a tilde fence is not one: the message renderer draws only backtick fences as code); the info string is exactly `luve-skill` with only SPACES or TABS around it
// (a no-break or ideographic space makes it another word, and a closing fence is followed by spaces or tabs only); exactly ONE such fence per message (two or more: none); it is closed by a backtick fence AT
// LEAST as long as the one that opened it (a longer opening fence lets the skill hold ``` fences of its own; a shorter line inside is content); the body starts with a `---` line (no line before it, not
// even a blank one), the header is CLOSED by a later `---` line (only spaces or tabs after the dashes) and something readable follows it: the extractor refuses what needs no YAML, so the sheet never
// opens on a draft the server must refuse (the header's CONTENT is the server's); a `luve-skill` fence inside any other fence (a quote of the answer, an outer four-backtick fence) is code, not a draft; at most 32 KiB.
//
// The characters nobody can see (contract v0.11 §3.4, the same table the server applies, to the WHOLE file, header included): some are REFUSED (`hidden_characters`: the Unicode Tags block that spells
// ASCII no screen draws, the bidi embeddings and overrides that reorder what is drawn, the line and paragraph separators, C0 and C1 controls, noncharacters, a lone surrogate), some are MARKED (allowed, counted
// in `hidden` and placed in `marks`, shown by the review: zero-width, joiners, isolates, fillers, ...), more than 50 marked is refused (`too_many_invisible`), and a draft whose body shows nothing but marked
// characters is `empty_body` (the server's word for the same text). The ORDER of the refusals is one, the server's (contract 3.4): see the end of extractSkillDraft. The table is ONE file for both sides, `backend/unicode_invisible.json`, generated from the Unicode Character Database and imported here at build time: nothing is typed in this source and
// nothing asks the browser's own Unicode data (that moves with each browser, and would disagree with the server, differently for each user). The shared fixture `tests/data/invisible-fixture.json` pins the behavior.

import TABLE from "../../../backend/unicode_invisible.json";

export const SKILL_MAX_BYTES = 32 * 1024;
export const MARKED_MAX = 50;
/** Hermes lists a skill from the first 4,000 characters of its file (`[:4000]`) and looks for the closing `---` line AND the line feed that ends it inside them: so the closing line must end at code point 3,999 or before
 *  (a closing line ending at 4,000 has its line feed outside what Hermes reads: it sees no closing line). Counted in code points (the unit of the columns; a JS length counts UTF-16 units). */
export const HEADER_MAX = 4000;
export type SkillDraftWhy = "none" | "two_fences" | "unclosed" | "no_frontmatter" | "hidden_characters" | "too_many_invisible" | "too_large" | "empty_body" | "header_too_long";
export interface SkillDraft {
  /** Exactly what the Bot wrote between the fences, line breaks normalized to \n, no final newline added, nothing removed. */
  content: string;
  bytes: number;
  /** How many MARKED characters `content` holds (the invisible ones the table allows: the review must show them). Refused ones never get here. */
  hidden: number;
  /** Where each marked character is (at most 50, which is all of them in an accepted draft): its code point, its line from 1 (by LF) and its column from 1 in CODE POINTS, the way the server counts. */
  marks: Mark[];
}
/** A character the table names, and where it is in the text. */
export interface Mark { codePoint: number; line: number; column: number }
/** Where and how much, for the two hidden-character refusals only, EQUAL to what the server answers for the same text (contract 3.4): `{code, line, column}` of the FIRST refused character, `{count}` of the marked ones.
 *  `code` is `U+` and at least four uppercase hexadecimal digits; lines count from the first line of the SKILL.md (the one that should be `---`), by LF; columns in code points. Never a character of the draft. */
export type SkillDraftDetails = { code: string; line: number; column: number } | { count: number };
export type SkillDraftResult = { ok: true; draft: SkillDraft } | { ok: false; why: SkillDraftWhy; details?: SkillDraftDetails };

const INFO = "luve-skill";
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;                          // the fence of CommonMark: up to 3 spaces, 3+ backticks or tildes (any fence hides what is inside it)
const edges = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");    // CommonMark's info string and closing fence: spaces and tabs only (String.trim() would also take NBSP, U+3000, BOM...)

// The table: ranges of code points from the shared JSON, as classes of one native regex each (a scan of megabytes costs milliseconds; a per-character pass costs a second and a half for 8 MiB).
type Range = readonly [number, number];
const ranges = (r: number[][]): Range[] => r.map(([a, b]) => [a, b] as const);
const REFUSED = ranges(TABLE.refuse);    // the draft is not a draft (TAB, LF and CR are the C0 controls that stay; a lone surrogate is refused, a valid pair is one character)
const MARKED = ranges(TABLE.mark);       // allowed, counted, shown (U+FE0E and U+FE0F, the emoji presentation selectors, are in neither class)
const classOf = (r: readonly Range[], flags: string) => new RegExp("[" + r.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]", flags);
const REFUSED_RE = classOf(REFUSED, "u");
const MARKED_RE = classOf(MARKED, "gu");     // only ever used through matchAll, which works on a copy: no lastIndex to leak between calls
export const isMarked = (c: number): boolean => MARKED.some(([a, b]) => c >= a && c <= b);
export const isRefused = (c: number): boolean => REFUSED.some(([a, b]) => c >= a && c <= b);

/** Where a UTF-16 index of `text` is: the line from 1 by LF, the column from 1 in code points (not UTF-16 units: an emoji is ONE column), as the server and the shared fixture count. */
function placeOf(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  return { line: before.split("\n").length, column: Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1 };
}
/** `U+` and the code point in at least four uppercase hexadecimal digits: how the server names a character (U+200C, U+E0041, U+1D173). */
export const codeOf = (c: number): string => "U+" + c.toString(16).toUpperCase().padStart(4, "0");
const markAt = (text: string, found: RegExpMatchArray): Mark => ({ codePoint: found[0].codePointAt(0) as number, ...placeOf(text, found.index as number) });

/** The first REFUSED character of the text with its place, or null. */
export function firstRefused(text: string): Mark | null {
  const found = REFUSED_RE.exec(text);
  return found ? markAt(text, found) : null;
}
/** Every MARKED character: how many, and where the first 50 are (more than that is a refusal anyway: no list of them is built). */
export function markedIn(text: string): { count: number; marks: Mark[] } {
  const marks: Mark[] = []; let count = 0;
  for (const found of text.matchAll(MARKED_RE)) if (++count <= MARKED_MAX) marks.push(markAt(text, found));
  return { count, marks };
}
export type InvisibleVerdict = "ok" | "refuse" | "too_many";
/** What the table says of a whole text, the same as the server's classifier (the shared fixture checks both): a REFUSED character wins over the count wherever it is; more than 50 marked is `too_many`. */
export function classifyInvisible(text: string): { verdict: InvisibleVerdict; count: number | null; marks: Mark[]; refused: Mark | null } {
  const refused = firstRefused(text);
  if (refused) return { verdict: "refuse", count: null, marks: [], refused };
  const { count, marks } = markedIn(text);
  return count > MARKED_MAX ? { verdict: "too_many", count, marks: [], refused: null } : { verdict: "ok", count, marks, refused: null };
}
/** Is there anything a reader can SEE: a character that is neither marked nor blank? (What the server's `.strip()` leaves after the marked characters are taken out.) */
function readable(s: string): boolean {
  for (const ch of s) if (!isMarked(ch.codePointAt(0) as number) && !/\s/.test(ch)) return true;
  return false;
}

export function extractSkillDraft(text: string): SkillDraftResult {
  if (typeof text !== "string" || !text.includes(INFO)) return { ok: false, why: "none" };
  const lines = text.split(/\r\n|\n|\r/);
  let fence: { ch: string; len: number; at: number; draft: boolean } | null = null;
  let first: { at: number; len: number; close: number } | null = null, count = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (fence) {                                                    // inside a fence (any): only its own closing line matters
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !edges(f[2])) {
        if (fence.draft && first && first.at === fence.at) first.close = i;
        fence = null;
      }
      continue;
    }
    if (!f || (f[1][0] === "`" && f[2].includes("`"))) continue;    // not a fence at all (an inline span that starts a line)
    const draft = f[1][0] === "`" && edges(f[2]) === INFO;          // backticks only, and the info string is exactly `luve-skill`
    fence = { ch: f[1][0], len: f[1].length, at: i, draft };
    if (draft && ++count === 1) first = { at: i, len: f[1].length, close: -1 };
  }
  if (count === 0) return { ok: false, why: "none" };
  if (count > 1) return { ok: false, why: "two_fences" };
  const opened = first as { at: number; len: number; close: number };
  if (opened.close < 0) return { ok: false, why: "unclosed" };
  const body = lines.slice(opened.at + 1, opened.close);
  const content = body.join("\n");
  // ONE order of refusals, the same as the server's (contract 3.4): the extraction above, then too_large, then hidden_characters (it wins over everything below, the header check included: a refused character on
  // line 1 is the cause of "line 1 is not ---", and the person is told so), then too_many_invisible, then no_frontmatter (line 1, no closing line, or an empty header), then header_too_long, then a body with nothing to read.
  const bytes = new TextEncoder().encode(content).length;
  if (bytes > SKILL_MAX_BYTES) return { ok: false, why: "too_large" };                  // the size cap comes BEFORE any scan: an 8 MiB answer is not read character by character
  const refused = firstRefused(content);
  if (refused) return { ok: false, why: "hidden_characters", details: { code: codeOf(refused.codePoint), line: refused.line, column: refused.column } };
  const seen = markedIn(content);
  if (seen.count > MARKED_MAX) return { ok: false, why: "too_many_invisible", details: { count: seen.count } };
  // what needs no YAML is refused here, so the sheet never opens on a draft the server must refuse: line 1 exactly `---`, a CLOSING `---` line (a later line that is `---` and only spaces or tabs: an opening without one is
  // no_frontmatter, the server's word), and a body that is not empty after it (nothing, or only marked characters and blanks: empty_body, the server's word, with nothing to point at). The header's CONTENT is the server's.
  if (body[0] !== "---") return { ok: false, why: "no_frontmatter" };
  const end = body.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (end < 0) return { ok: false, why: "no_frontmatter" };
  if (body.slice(1, end).every((l) => /^[ \t]*$/.test(l))) return { ok: false, why: "no_frontmatter" };                 // a header with nothing in it is no header (YAML reads it as null); what its lines MEAN is the server's
  if (Array.from(body.slice(0, end + 1).join("\n")).length + 1 > HEADER_MAX) return { ok: false, why: "header_too_long" };    // Hermes would list this skill by its directory's name, not by the header's
  if (!readable(body.slice(end + 1).join("\n"))) return { ok: false, why: "empty_body" };
  return { ok: true, draft: { content, bytes, hidden: seen.count, marks: seen.marks } };
}
