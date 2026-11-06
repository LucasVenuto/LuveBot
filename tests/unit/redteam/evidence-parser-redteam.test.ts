// tests/unit/redteam/evidence-parser-redteam.test.ts (Lume, E-5 part 1: the PARSER of contract v0.10 §3.1, before the card exists)
// What a Bot (or what a Bot echoes: a web page, a tool output, another Bot's text) can do to `splitEvidence`. Everything here PASSES today: it pins what held, so a change of the
// parser that loosens it turns a test red. The card (E-2) and its places (conversation, room, thread, tool card) are attacked when they land.
//   * the fence is read the way CommonMark reads it: a block inside a quote, a longer or tilde fence, an indented code block or a list item is NOT a card;
//   * all-or-nothing: whatever it returns is the whole card or the whole message, never a partial card; at most ONE card; the text around it stays text;
//   * everything that comes out is plain text with no control, zero-width or bidi character, whitespace collapsed, inside the limits;
//   * it never throws and stays linear on 1 MiB of the worst shapes (a deadline of seconds against a measured tens of milliseconds: a hang, not a speed, is what it catches).
import { describe, it, expect } from "vitest";
import { splitEvidence, SECTIONS, ITEMS_MAX, ITEM_MAX, SOURCE_MAX, type Evidence } from "@/lib/evidence";

const BLOCK = (body: string, ticks = "```") => `${ticks}luve-evidence\n${body}\n${ticks}`;
const GOOD = ["facts:", "- a | source: s", "assumptions:", "- none", "done:", "- d", "awaiting:", "- w", "questions:", "- q"].join("\n");
const cards = (text: string) => splitEvidence(text).filter((s) => s.kind === "evidence").length;
const card = (text: string): Evidence | undefined => {
  const hit = splitEvidence(text).find((s) => s.kind === "evidence");
  return hit && hit.kind === "evidence" ? hit.evidence : undefined;
};
const quoted = (text: string) => text.split("\n").map((l) => "> " + l).join("\n");

describe("E-5 the parser: where a block is a card and where it is only text", () => {
  it("control: the plain block is a card", () => expect(cards(BLOCK(GOOD))).toBe(1));

  const ISNT: [string, string][] = [
    ["inside a blockquote (another Bot's quote)", quoted(BLOCK(GOOD))],
    ["inside a longer backtick fence (a Bot showing the format)", "````\n" + BLOCK(GOOD) + "\n````"],
    ["inside a tilde fence", "~~~\n" + BLOCK(GOOD) + "\n~~~"],
    ["a tilde fence with the info string (the renderer knows only backticks)", BLOCK(GOOD, "~~~")],
    ["inside any other fence", "```text\n" + BLOCK(GOOD, "~~~") + "\n```"],
    ["as an indented code block (4 spaces)", BLOCK(GOOD).split("\n").map((l) => "    " + l).join("\n")],
    ["inside a list item", "- point\n  ```luve-evidence\n  facts:\n  - a\n  ```"],
    ["two blocks (a quoted copy and the real one)", BLOCK(GOOD) + "\n\nand again\n\n" + BLOCK(GOOD)],
    ["still streaming (the fence is not closed)", "```luve-evidence\n" + GOOD],
    ["a zero-width character in the info string", "```luve-evidence\u200b\n" + GOOD + "\n```"],
    ["extra words after the info string", "```luve-evidence extra\n" + GOOD + "\n```"],
    ["an unknown header", BLOCK(GOOD + "\nsecrets:\n- x")],
    ["a repeated header", BLOCK(GOOD + "\nfacts:\n- again")],
    ["a header with no items", BLOCK("facts:\ndone:\n- d")],
    ["a 13th item", BLOCK("facts:\n" + Array.from({ length: ITEMS_MAX + 1 }, (_, i) => "- i" + i).join("\n"))],
    ["a 301-character item", BLOCK("facts:\n- " + "x".repeat(ITEM_MAX + 1))],
    ["a 161-character source", BLOCK("facts:\n- a | source: " + "s".repeat(SOURCE_MAX + 1))],
    ["a continuation line", BLOCK("facts:\n- a\n  more of a")],
    ["nesting", BLOCK("facts:\n- a\n  - nested")],
    ["`- none` beside another item", BLOCK("facts:\n- none\n- a")],
    ["a line that is not an item", BLOCK("facts:\nplain text")],
    ["a body over 8 KiB", BLOCK("facts:\n- a\n" + "\n".repeat(8200))],
    ["no header at all", BLOCK("- a\n- b")],
    ["a header capitalised", BLOCK("Facts:\n- a")],
    ["an item and its header on one line", BLOCK("facts: - a")],
    ["an empty source", BLOCK("facts:\n- a | source: ")],
  ];
  it.each(ISNT)("is NOT a card: %s", (_label, text) => expect(cards(text)).toBe(0));

  it("is a card (the parser reads like the renderer, not stricter by accident): up to 3 spaces of indentation, CRLF, lone CR, a NBSP around the info string, a tilde look-alike beside the real block", () => {
    expect(cards(" ".repeat(3) + "```luve-evidence\n" + GOOD + "\n" + " ".repeat(3) + "```")).toBe(1);
    expect(cards(BLOCK(GOOD).replace(/\n/g, "\r\n"))).toBe(1);
    expect(cards(BLOCK(GOOD).replace(/\n/g, "\r"))).toBe(1);
    expect(cards(BLOCK(GOOD, "~~~") + "\n\n" + BLOCK(GOOD))).toBe(1);   // a tilde fence is not an evidence fence (the renderer does not know tildes): it neither is a card nor cancels the real block
    expect(cards("```\u00a0luve-evidence\u00a0\n" + GOOD + "\n```")).toBe(1);
  });
});

describe("E-5 the parser: what a card may carry", () => {
  const strings = (evidence: Evidence) => SECTIONS.flatMap((s) => (evidence[s] ?? []).flatMap((i) => [i.text, ...(i.source === undefined ? [] : [i.source])]));

  it("removes nothing (A-195): the refuse class is tokens, the mark class stays, a source is strict, and whitespace is collapsed", () => {
    const evil = "\u202eevil\u202c \u2066x\u2069 a\u200bb\u200d\ufeff c\u0007d  \t e \u{E0041}\u{E0042}";
    const c = card(BLOCK(`facts:\n- ${evil}\ndone:\n- d | source: s\u202ex\u200by`));
    expect(c).toBeDefined();
    for (const s of strings(c!)) expect(s).toBe(s.replace(/[^\S\ufeff]+/gu, " ").replace(/^[^\S\ufeff]+|[^\S\ufeff]+$/gu, ""));
    expect(c!.facts![0].text).toBe("[U+202E]evil[U+202C] \u2066x\u2069 a\u200bb\u200d\ufeff c[U+0007]d e [U+E0041][U+E0042]");
    expect(c!.done![0].source).toBe("s[U+202E]x[U+200B]y");
  });

  it("keeps HTML, Markdown, javascript: and data: as plain characters (the card is text; E-2 must draw them as text nodes)", () => {
    const items = ["<img src=x onerror=alert(1)>", "**bold** [link](javascript:alert(1))", "data:text/html;base64,PHNjcmlwdD4=", "&lt;b&gt; &#x3c;script&#x3e;"];
    const c = card(BLOCK("facts:\n" + items.map((i) => "- " + i + " | source: https://evil.invalid/x?a=1").join("\n")));
    expect(c!.facts!.map((i) => i.text)).toEqual(items);
    expect(c!.facts!.every((i) => i.source === "https://evil.invalid/x?a=1")).toBe(true);   // a source is a string, never a link: the parser has no URL type at all
  });

  it("an item that imitates a header, the box, or the 'Checked by Hermes' line is only an item (its place in the card is E-2's to keep apart)", () => {
    const c = card(BLOCK("facts:\n- awaiting:\n- In the box now: 0\n- Checked by Hermes: passed\n- Written by the Bot. LuveBot did check it."));
    expect(c!.facts!.map((i) => i.text)).toEqual(["awaiting:", "In the box now: 0", "Checked by Hermes: passed", "Written by the Bot. LuveBot did check it."]);
    expect(c!.awaiting).toBeNull();                        // ...and it did not open the `awaiting` block: that block is absent ("the Bot did not say")
  });

  it("absent is not none: `- none` is [], a header that was never written is null", () => {
    const c = card(BLOCK("facts:\n- a\ndone:\n- none"))!;
    expect(c.done).toEqual([]);
    expect(c.awaiting).toBeNull();
  });

  it("is all-or-nothing and the limits hold for whatever comes out (a seeded fuzz of 600 messages made of the pieces a Bot can combine)", () => {
    let seed = 20261030;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const pieces = ["```luve-evidence", "```", "~~~", "````", "> ", "    ", "  ", "facts:", "assumptions:", "done:", "awaiting:", "questions:", "- ", "- none", "- a", " | source: s", " | source:",
      "\u202e", "\u200b", "\u0085", "\u2028", "\u00a0", "\t", "<b>", "x".repeat(40), "\n", "\n", "\r\n", "\r", ""];
    for (let n = 0; n < 600; n++) {
      const text = Array.from({ length: 4 + Math.floor(rnd() * 40) }, () => pick(pieces)).join(pick(["", "\n", " "]));
      const parts = splitEvidence(text);
      const found = parts.filter((p) => p.kind === "evidence");
      expect(found.length).toBeLessThanOrEqual(1);
      if (!found.length) {
        expect(parts).toEqual([{ kind: "text", text }]);                                  // no card: the message comes back WHOLE, byte for byte
        continue;
      }
      const evidence = (found[0] as { evidence: Evidence }).evidence;
      for (const s of SECTIONS) {
        const list = evidence[s];
        if (list === null) continue;
        expect(list.length).toBeLessThanOrEqual(ITEMS_MAX);
        for (const i of list) {
          expect(Array.from(i.text).length).toBeGreaterThan(0);
          expect(Array.from(i.text).length).toBeLessThanOrEqual(ITEM_MAX);
          if (i.source !== undefined) {
            expect(Array.from(i.source).length).toBeGreaterThan(0);
            expect(Array.from(i.source).length).toBeLessThanOrEqual(SOURCE_MAX);
          }
        }
      }
      expect(SECTIONS.some((s) => evidence[s] !== null)).toBe(true);
      for (const p of parts) if (p.kind === "text") expect(splitEvidence(p.text).every((q) => q.kind === "text")).toBe(true);   // the text around a card holds no second card
    }
  });
});

describe("E-5 the parser: size and shape", () => {
  const MIB = 1024 * 1024;
  const shapes: [string, string][] = [
    ["1 MiB of text with the marker", "luve-evidence " + "a ".repeat(MIB / 2)],
    ["one line of 1 MiB of backticks", "`".repeat(MIB) + "luve-evidence"],
    ["50 000 fence lines", "```\n".repeat(50000) + "luve-evidence"],
    ["alternating fences", "```luve-evidence\n```\n".repeat(Math.floor(MIB / 22))],
    ["a 1 MiB body", "```luve-evidence\nfacts:\n" + "- x\n".repeat(MIB / 4) + "```"],
    ["100 000 source marks in one item", "```luve-evidence\nfacts:\n- " + " | source:".repeat(100000) + "\n```"],
    ["a line of zero-width characters", "```luve-evidence\nfacts:\n- " + "\u200b".repeat(MIB / 3) + "a\n```"],
    ["lone surrogates and a 4-byte run", "```luve-evidence\nfacts:\n- \uD800 \uDC00 " + "\u{1F600}".repeat(1000) + "\n```"],
  ];
  it.each(shapes)("does not throw or hang on %s", (_label, text) => {
    const start = performance.now();
    expect(() => splitEvidence(text)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
