// dashboard/src/lib/hiddenChars.ts
// What a person reads is what is there (contract v0.11 §8, A-188): a character of the shared table (backend/unicode_invisible.json, the one §3.4 uses) is DRAWN as the visible token `[U+XXXX]`, never removed and never
// drawn raw. Two strengths, because the table has two classes: STRICT (refuse and mark) for what a person decides on or copies (the command and the text of an approval, a rule's text, the name of a skill, code in
// a message): a command has no business holding a zero-width character; and PROSE (the refuse class only: bidi embeddings and overrides, Tags, controls, noncharacters, line and paragraph separators) for a message,
// a thread, a room: the mark class (ZWNJ and ZWJ of Persian, Hindi and emoji, the soft hyphen, the variation selectors, the bidi isolates) is legitimate there and stays as it is. Pure: no DOM, no Hermes.
// One native regex per strength (a scan of megabytes costs milliseconds; a per-character pass costs seconds). Tokens are applied to the LEAVES of what is drawn, after any parsing: a token put in before a
// markdown parser could make a link of `[U+202E](…)`.

import TABLE from "../../../backend/unicode_invisible.json";
import { codeOf } from "./skillDraft";

const classOf = (r: number[][]): string => "[" + r.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]";
const PROSE_RE = new RegExp(classOf(TABLE.refuse), "gu");                       // `replace` starts a global regex at 0 every time: no lastIndex leaks between calls
const STRICT_RE = new RegExp(classOf([...TABLE.refuse, ...TABLE.mark]), "gu");
const token = (ch: string): string => `[${codeOf(ch.codePointAt(0) as number)}]`;

/** STRICT: every character of the table (both classes) as a visible token. For what a person decides on, edits or copies. */
export const visibleTokens = (text: string): string => text.replace(STRICT_RE, token);
/** PROSE: the refuse class only as tokens; the mark class stays. For a message, a thread, a room. */
export const proseTokens = (text: string): string => text.replace(PROSE_RE, token);
