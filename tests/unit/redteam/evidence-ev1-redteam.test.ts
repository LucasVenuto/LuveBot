// tests/unit/redteam/evidence-ev1-redteam.test.ts
// Red team (Lume, 31/10) of EV-1 (b78f54a, A-195): the evidence reader removes NOTHING any more (the refuse class is tokens, the mark class stays in an item, a source is strict, whitespace is collapsed except a BOM).
// A battery of 10 defects planted in `lib/evidence.ts` against the Vitral's tests and mine: 9 died; 1 SURVIVED because nothing asserted it: the header is read from the CLEANED line, so blanks around it do not
// matter (a header with trailing spaces, a tab or a no-break space is a header) and a hidden character in it, of either class, makes it unknown (the block stays an ordinary code block). Read from the raw line the first
// would refuse the card for a trailing blank. Closed here, as plain tests (the code is right; the test was missing). They also pin two consequences of "nothing is removed" so nobody turns them back into a
// silent removal: a line that holds only a mark-class character is NOT blank (the card is refused, the block stays code), and a hidden character at the start of a line is not a leading blank.
// The characters are built with String.fromCharCode, never written raw.
import { describe, it, expect } from "vitest";
import { parseEvidenceBody } from "@/lib/evidence";

const ZWSP = String.fromCharCode(0x200b), ZWNJ = String.fromCharCode(0x200c), RLO = String.fromCharCode(0x202e), TAG = String.fromCodePoint(0xe0041), BOM = String.fromCharCode(0xfeff), NBSP = String.fromCharCode(0xa0);
const body = (...lines: string[]) => parseEvidenceBody(lines);

describe("a header is read from the cleaned line", () => {
  it("blanks around it do not matter: trailing spaces, a tab and a no-break space still make a header", () => {
    for (const blank of [" ", "  ", "\t", NBSP, " \t" + NBSP]) {
      const card = body(`facts:${blank}`, "- um fato");
      expect(card && card.facts && card.facts[0].text, JSON.stringify(blank)).toBe("um fato");
    }
  });

  it("a hidden character in a header, of either class and anywhere in it, makes it unknown: no card (the block stays code)", () => {
    for (const ch of [ZWSP, ZWNJ, RLO, TAG, BOM]) {
      expect(body(`facts:${ch}`, "- x"), "after " + ch.codePointAt(0)!.toString(16)).toBeNull();
      expect(body(`${ch}facts:`, "- x"), "before " + ch.codePointAt(0)!.toString(16)).toBeNull();
      expect(body(`fa${ch}cts:`, "- x"), "inside " + ch.codePointAt(0)!.toString(16)).toBeNull();
    }
  });
});

describe("nothing is removed, so a hidden character is never a blank", () => {
  it("a line that holds only a mark-class character is not blank: the card is refused, not silently skipped", () => {
    expect(body("facts:", "- um fato", ZWSP, "- outro")).toBeNull();
    expect(body("facts:", "- um fato", ZWNJ)).toBeNull();
  });

  it("a line that holds only a refuse-class character is a line of tokens, not a blank: the card is refused too", () => {
    expect(body("facts:", "- um fato", RLO)).toBeNull();
    expect(body("facts:", "- um fato", TAG)).toBeNull();
  });

  it("a hidden character at the start of an item line is not a leading blank: the line is no item (no card), and the same character INSIDE the text is kept or tokenized", () => {
    expect(body("facts:", `${ZWSP}- um fato`)).toBeNull();
    const card = body("facts:", `- um${ZWSP}fato`, `- dois${RLO}fatos`);
    expect(card && card.facts && card.facts.map((f) => f.text)).toEqual([`um${ZWSP}fato`, "dois[U+202E]fatos"]);
  });
});
