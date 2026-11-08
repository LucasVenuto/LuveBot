// dashboard/src/lib/clarifyText.ts
// The Bot's question as the screen SHOWS it (contract v0.11 §4.1). Hermes appends to every clarify question the sentence `Reply "skip" to skip this question.`, and on the run surface (the one LuveBot uses)
// nothing interprets it: the word would reach the Bot as an ordinary answer, and on a question with choices LuveBot refuses it. A screen must not show an instruction it cannot honour, so that ONE line is
// taken out of what is drawn. Pure (no Hermes, no DOM); the text itself is never changed anywhere else.

import TABLE from "../../../backend/unicode_invisible.json";
import { isMarked, firstRefused } from "./skillDraft";

const HINT = 'Reply "skip" to skip this question.';

/** The emoji presentation selectors (U+FE0E, U+FE0F): the shared table keeps them out of its invisible classes so that no emoji is flagged, but ALONE they draw nothing. */
const SELECTORS = new Set<number>(TABLE.mark_except);

/** Is there anything a reader can SEE: a character that is not blank, not one of the table's invisible ones (the shared table of contract v0.11 3.4), not a refused one and not a lone presentation selector? */
const visible = (s: string): boolean => Array.from(s).some((ch) => !/\s/.test(ch) && !isMarked(ch.codePointAt(0) as number) && !SELECTORS.has(ch.codePointAt(0) as number) && !firstRefused(ch));

/** The question without Hermes's skip sentence: only when that sentence is EXACTLY the last line of the text and appears NOWHERE else (a whole-line equality, never "contains": a reworded sentence, one in the
 *  middle, one that appears twice or a look-alike is left as it is, and so is a text that would be left with nothing to SEE: empty, blank, or only invisible characters). The blank lines that separated the sentence go with it.
 *  One final line break ends the last line; it is not a line of its own. */
export function displayQuestion(question: string): string {
  const body = question.replace(/(?:\r\n|\n|\r)$/, "");
  const lines = body.split(/\r\n|\n|\r/);
  if (lines.length < 2 || lines[lines.length - 1] !== HINT || lines.filter((l) => l === HINT).length !== 1) return question;
  const kept = lines.slice(0, -1);
  while (kept.length && /^\s*$/.test(kept[kept.length - 1])) kept.pop();       // a blank line is empty or only spaces and tabs (and the like): it goes with the sentence
  const rest = kept.join("\n");
  return visible(rest) ? rest : question;
}

const RECOMMENDED = " (Recommended)";

/** How a choice is SHOWN. Hermes suffixes the FIRST choice of a question with the English `(Recommended)` (tools/clarify_tool.py `mark_recommended`: the schema says best-first, and a lone choice is left alone), so
 *  a Portuguese screen says that ONE decoration in its own words. Only the exact suffix (case and space as Hermes writes it), only on the first of two or more choices, and never when nothing would be left of the label.
 *  What is ANSWERED is always the original label: Hermes matches it with or without the suffix (clarify_gateway `_match_label`), and a different string here would be a different answer. */
export function displayChoice(choice: string, isFirst: boolean, count: number): { text: string; recommended: boolean } {
  if (!isFirst || count < 2 || !choice.endsWith(RECOMMENDED)) return { text: choice, recommended: false };
  const text = choice.slice(0, -RECOMMENDED.length);
  return text.trim() ? { text, recommended: true } : { text: choice, recommended: false };
}
