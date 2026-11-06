// tests/unit/redteam/clarify-hint-selectors-redteam.test.ts (Lume, 30/10): the F-K1 fix attacked. "Visible" there is the table of 3.4 plus whitespace, and the table leaves U+FE0E and U+FE0F out on purpose (the emoji
// presentation selectors are text next to an emoji). Alone they draw NOTHING, so a question made only of them is as empty as one made of zero-width spaces, and the sentence must stay. No invisible character is written here.
import { describe, it, expect } from "vitest";
import { displayQuestion } from "@/lib/clarifyText";

const HINT = 'Reply "skip" to skip this question.';
const cp = (...n: number[]) => String.fromCodePoint(...n);

describe("a question that only LOOKS like something", () => {
  it("only variation selectors (FE0E, FE0F, alone or mixed with blanks) is empty to a reader: the sentence stays", () => {
    for (const text of [cp(0xfe0f).repeat(3), cp(0xfe0e).repeat(2), cp(0xfe0f, 0x20, 0xfe0e), `${cp(0xfe0f)}\n${cp(0xfe0e)}`]) {
      expect(displayQuestion(`${text}\n${HINT}`), JSON.stringify(text)).toBe(`${text}\n${HINT}`);
    }
  });

  it("a selector next to something readable is part of the question (a heart with its selector, a letter), and the sentence goes", () => {
    expect(displayQuestion(`${cp(0x2764, 0xfe0f)}\n${HINT}`)).toBe(cp(0x2764, 0xfe0f));
    expect(displayQuestion(`a${cp(0xfe0f)}\n${HINT}`)).toBe(`a${cp(0xfe0f)}`);
    expect(displayQuestion(`${cp(0xfe0f)}Q?\n${HINT}`)).toBe(`${cp(0xfe0f)}Q?`);
  });

  it("every other invisible class the table knows keeps the sentence (the fix holds): zero-width, Hangul fillers, braille blank, Tags, bidi, controls, spaces of every kind", () => {
    for (const c of [0x200b, 0x200c, 0x2060, 0x3164, 0x115f, 0x2800, 0x034f, 0xad, 0xfeff, 0xe0041, 0x202e, 0x2066, 0x0, 0x85, 0xa0, 0x3000, 0x2003, 0x2028]) {
      const text = `${cp(c).repeat(3)}\n${HINT}`;
      expect(displayQuestion(text), "U+" + c.toString(16)).toBe(text);
    }
  });

  it("one visible character among invisible ones is a question, and the sentence goes", () => {
    expect(displayQuestion(`${cp(0x200b)}?${cp(0x200b)}\n${HINT}`)).toBe(`${cp(0x200b)}?${cp(0x200b)}`);
  });

  it("the cost stays linear: a million zero-width characters and a million lines in well under a second", () => {
    const t0 = performance.now();
    displayQuestion(`${cp(0x200b).repeat(1_000_000)}\n${HINT}`);
    displayQuestion(`${"x\n".repeat(500_000)}${HINT}`);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
