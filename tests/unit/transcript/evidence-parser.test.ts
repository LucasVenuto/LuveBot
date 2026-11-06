// tests/unit/transcript/evidence-parser.test.ts (contract v0.10 §3.1, slice E-1)
// The evidence block a Bot may end its answer with. STRICT AND ALL-OR-NOTHING: any violation leaves the whole block as an ordinary code block; nothing partial,
// nothing guessed. Everything that comes out is plain text. A pure function: no Hermes, no backend.
import { describe, it, expect } from "vitest";
import { splitEvidence, parseEvidenceBody, ITEMS_MAX, ITEM_MAX, SOURCE_MAX, BODY_MAX_BYTES, type Evidence } from "@/lib/evidence";

const fence = (body: string, info = "luve-evidence", ticks = "```") => `${ticks}${info}\n${body}\n${ticks}`;
const FULL = [
  "facts:", "- Vendas fechou 12 propostas em setembro | source: crm/setembro.csv",
  "assumptions:", "- O CSV está completo",
  "done:", "- Gerei o resumo em pages/vendas.md",
  "awaiting:", "- Enviar o resumo ao cliente X",
  "questions:", "- O prazo de 15/11 vale para todos?",
].join("\n");
/** the card the text turns into, or null when it stays text */
const card = (text: string): Evidence | null => {
  const hit = splitEvidence(text).find((s) => s.kind === "evidence");
  return hit && hit.kind === "evidence" ? hit.evidence : null;
};
const body = (lines: string[]) => parseEvidenceBody(lines);
const chars = (n: number, c = "a") => c.repeat(n);

describe("a valid block", () => {
  it("the contract's example draws the five blocks, with the source apart from the item", () => {
    const e = card(fence(FULL))!;
    expect(e).toEqual({
      facts: [{ text: "Vendas fechou 12 propostas em setembro", source: "crm/setembro.csv" }],
      assumptions: [{ text: "O CSV está completo" }],
      done: [{ text: "Gerei o resumo em pages/vendas.md" }],
      awaiting: [{ text: "Enviar o resumo ao cliente X" }],
      questions: [{ text: "O prazo de 15/11 vale para todos?" }],
    });
  });

  it("the text around it stays text, in order; the block itself is not in any text", () => {
    const segments = splitEvidence(`Terminei.\n\n${fence(FULL)}\n\nAté já.`);
    expect(segments.map((s) => s.kind)).toEqual(["text", "evidence", "text"]);
    expect(segments[0]).toEqual({ kind: "text", text: "Terminei.\n" });
    expect(segments[2]).toEqual({ kind: "text", text: "\nAté já." });
    expect(JSON.stringify(segments.filter((s) => s.kind === "text"))).not.toContain("luve-evidence");
  });

  it("headers in any order, not all of them; a header that is absent is null (the Bot did not say)", () => {
    const e = card(fence("questions:\n- Qual o prazo?\nfacts:\n- X vale 3"))!;
    expect(e.questions).toEqual([{ text: "Qual o prazo?" }]);
    expect(e.facts).toEqual([{ text: "X vale 3" }]);
    expect(e.assumptions).toBeNull();
    expect(e.done).toBeNull();
    expect(e.awaiting).toBeNull();
  });

  it("'- none' (lowercase) is an EMPTY list: said, and different from absent", () => {
    const e = card(fence("facts:\n- none\nawaiting:\n- none"))!;
    expect(e.facts).toEqual([]);
    expect(e.awaiting).toEqual([]);
    expect(e.questions).toBeNull();
  });

  it("a longer backtick fence is the fence; CRLF is a line break; blank lines carry nothing", () => {
    expect(card(fence(FULL, "luve-evidence", "````"))).not.toBeNull();
    expect(card(fence(FULL).replace(/\n/g, "\r\n"))).not.toBeNull();
    expect(card(fence("facts:\n\n- X\n\nquestions:\n- none"))).not.toBeNull();
  });

  it("the limits are inclusive: 12 items, 300 characters, 160 characters of source, 8 KiB of body", () => {
    const twelve = Array.from({ length: ITEMS_MAX }, (_, i) => `- item ${i}`);
    expect(card(fence(["facts:", ...twelve].join("\n")))!.facts).toHaveLength(12);
    expect(card(fence(`facts:\n- ${chars(ITEM_MAX)}`))!.facts![0].text).toHaveLength(300);
    expect(card(fence(`facts:\n- x | source: ${chars(SOURCE_MAX)}`))!.facts![0].source).toHaveLength(160);
    const nearly = ["facts:", ...Array.from({ length: 12 }, () => `- ${chars(ITEM_MAX)}`)];        // ~3.7 KiB
    expect(card(fence(nearly.join("\n")))).not.toBeNull();
  });
});

describe("one fence, closed: anything else is code", () => {
  it("a second luve-evidence fence: NONE of the two is a card", () => {
    expect(card(`${fence(FULL)}\n\ntexto\n\n${fence(FULL)}`)).toBeNull();
    expect(card(`${fence(FULL)}\n\n${fence("facts:\n- só um")}`)).toBeNull();
    expect(splitEvidence(`${fence(FULL)}\n${fence(FULL)}`)).toEqual([{ kind: "text", text: `${fence(FULL)}\n${fence(FULL)}` }]);
  });

  it("a fence not yet closed (still streaming) is code; once it closes it becomes the card", () => {
    const open = "```luve-evidence\nfacts:\n- Vendas fechou 12";
    expect(card(open)).toBeNull();
    expect(card(`${open}\n\`\`\``)).not.toBeNull();
    expect(card(`texto\n\n\`\`\`luve-evidence\n${FULL}`)).toBeNull();
  });

  it("the info string is EXACTLY luve-evidence: another word, an extra word, another case, nothing", () => {
    for (const info of ["luve-evidences", "luve-evidence x", "Luve-Evidence", "evidence", "luve", "", "luve-evidence{.a}"]) expect(card(fence(FULL, info)), info).toBeNull();
    expect(card(fence(FULL, "luve-evidence "))).not.toBeNull();                                    // trailing space: the same fence
  });

  it("inside another fence, in a quote, in a list item or indented 4 spaces it is just text", () => {
    expect(card("````md\n" + fence(FULL) + "\n````")).toBeNull();
    expect(card(fence(fence(FULL), "text"))).toBeNull();
    expect(card(fence(FULL).split("\n").map((l) => `> ${l}`).join("\n"))).toBeNull();
    expect(card(fence(FULL).split("\n").map((l, i, a) => (i === 0 ? `- ${l}` : `  ${l}`)).join("\n"))).toBeNull();
    expect(card(fence(FULL).split("\n").map((l) => `    ${l}`).join("\n"))).toBeNull();
  });

  it("a TILDE fence is not the evidence fence: the message renderer draws only backtick fences as code, so no card is made from one", () => {
    expect(card(fence(FULL, "luve-evidence", "~~~"))).toBeNull();
    expect(card(fence(FULL, "luve-evidence", "~~~~"))).toBeNull();
  });

  it("a tilde fence still hides what is inside it: an evidence block quoted in a tilde fence is text", () => {
    expect(card("~~~md\n" + fence(FULL) + "\n~~~")).toBeNull();
  });

  it("a fence that closes with another character or a shorter line does not close it", () => {
    expect(card("```luve-evidence\n" + FULL + "\n~~~")).toBeNull();
    expect(card("````luve-evidence\n" + FULL + "\n```")).toBeNull();
    expect(card("```luve-evidence\n" + FULL + "\n``` x")).toBeNull();
  });

  it("an inline span that starts a line is not a fence, so it cannot swallow the real block", () => {
    expect(card(`\`\`\`foo\`\`\` e mais\n\n${fence(FULL)}`)).not.toBeNull();
  });

  it("a message without the word costs nothing and comes back whole", () => {
    const text = "Resposta comum com `código` e\n```js\nlet x = 1\n```";
    expect(splitEvidence(text)).toEqual([{ kind: "text", text }]);
  });

  it("a body over 8 KiB is refused, whatever it holds", () => {
    const big = fence(["facts:", ...Array.from({ length: 12 }, () => `- ${chars(ITEM_MAX)}`), "assumptions:", ...Array.from({ length: 12 }, () => `- ${chars(ITEM_MAX)}`), "done:", ...Array.from({ length: 12 }, () => `- ${chars(ITEM_MAX, "é")}`)].join("\n"));
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(BODY_MAX_BYTES);
    expect(card(big)).toBeNull();
    expect(card(fence(`${FULL}\n${chars(BODY_MAX_BYTES)}`))).toBeNull();
  });
});

describe("headers", () => {
  it("an unknown header refuses the WHOLE block (never a card without it)", () => {
    expect(card(fence(`${FULL}\nnotes:\n- algo`))).toBeNull();
    expect(card(fence("facts:\n- X\nFacts:\n- Y"))).toBeNull();                                    // the case is part of the word
    expect(card(fence("fatos:\n- X"))).toBeNull();                                                  // no PT aliases (A-137)
  });

  it("a repeated header refuses the whole block", () => {
    expect(card(fence("facts:\n- X\nfacts:\n- Y"))).toBeNull();
    expect(card(fence(`${FULL}\ndone:\n- outra`))).toBeNull();
  });

  it("a header with no items is refused: the Bot must say '- none'", () => {
    expect(card(fence("facts:\nassumptions:\n- A"))).toBeNull();
    expect(card(fence("facts:\n- X\nquestions:"))).toBeNull();
    expect(card(fence("facts:\n\n"))).toBeNull();
  });

  it("a header with something after the colon, or an item before any header, is refused", () => {
    expect(card(fence("facts: - X"))).toBeNull();
    expect(card(fence("facts: nada"))).toBeNull();
    expect(card(fence("facts: nada\n- X"))).toBeNull();                                          // the words after the colon are not a header's: refused, never ignored
    expect(card(fence("facts: nada\n- X\nquestions:\n- none"))).toBeNull();
    expect(card(fence("- X\nfacts:\n- Y"))).toBeNull();
  });

  it("an empty block, or one with no header at all, is not a card", () => {
    expect(card(fence(""))).toBeNull();
    expect(card(fence("\n\n"))).toBeNull();
    expect(body([])).toBeNull();
  });
});

describe("items", () => {
  it("a 13th item refuses the block; 12 is fine", () => {
    const items = (n: number) => ["facts:", ...Array.from({ length: n }, (_, i) => `- i${i}`)].join("\n");
    expect(card(fence(items(13)))).toBeNull();
    expect(card(fence(items(12)))).not.toBeNull();
  });

  it("a 301-character item refuses the block (code points: an emoji is ONE)", () => {
    expect(card(fence(`facts:\n- ${chars(ITEM_MAX + 1)}`))).toBeNull();
    expect(card(fence(`facts:\n- ${chars(ITEM_MAX, "🙂")}`))).not.toBeNull();
    expect(card(fence(`facts:\n- ${chars(ITEM_MAX + 1, "🙂")}`))).toBeNull();
  });

  it("an empty item, a bare dash, no space after the dash, another bullet or a numbered one: refused", () => {
    for (const bad of ["- ", "-", "-x", "* x", "• x", "1. x", "+ x", "– x"]) expect(card(fence(`facts:\n${bad}`)), JSON.stringify(bad)).toBeNull();
  });

  it("no nesting and no continuation lines", () => {
    expect(card(fence("facts:\n- X\n  - filho"))).toBeNull();
    expect(card(fence("facts:\n- X\n  continua aqui"))).toBeNull();
    expect(card(fence("facts:\n- X\ncontinua aqui"))).toBeNull();
    expect(card(fence("facts:\n\t- X"))).toBeNull();
    expect(card(fence(" facts:\n- X"))).toBeNull();
  });

  it("'- none' is the lowercase literal only; '- None' is an ordinary item with that word", () => {
    expect(card(fence("facts:\n- none"))!.facts).toEqual([]);
    expect(card(fence("facts:\n- None"))!.facts).toEqual([{ text: "None" }]);
    expect(card(fence("facts:\n- NONE"))!.facts).toEqual([{ text: "NONE" }]);
    expect(card(fence("facts:\n- none."))!.facts).toEqual([{ text: "none." }]);
  });

  it("'- none' beside other items, twice, or after an item, is a contradiction: refused", () => {
    expect(card(fence("facts:\n- none\n- X"))).toBeNull();
    expect(card(fence("facts:\n- X\n- none"))).toBeNull();
    expect(card(fence("facts:\n- none\n- none"))).toBeNull();
  });

  it("absent is not none: the two read differently, so the card can say 'the Bot did not say'", () => {
    const e = card(fence("facts:\n- none"))!;
    expect(e.facts).toEqual([]);
    expect(e.assumptions).toBeNull();
    expect(e.facts).not.toEqual(e.assumptions);
  });
});

describe("sources: plain text, never a link", () => {
  it("a source that is a URL, a file name or a phrase comes out as the same plain text", () => {
    const e = card(fence("facts:\n- A | source: https://example.com/x?a=1&b=2\n- B | source: crm/setembro.csv\n- C | source: a conversa de ontem"))!;
    expect(e.facts!.map((i) => i.source)).toEqual(["https://example.com/x?a=1&b=2", "crm/setembro.csv", "a conversa de ontem"]);
  });

  it("a Markdown or HTML link as a source stays characters (the card draws text with a copy button, never an <a>)", () => {
    const e = card(fence("facts:\n- A | source: [aqui](https://evil.example)\n- B | source: <a href=\"https://evil.example\">x</a>"))!;
    expect(e.facts![0].source).toBe("[aqui](https://evil.example)");
    expect(e.facts![1].source).toBe("<a href=\"https://evil.example\">x</a>");
  });

  it("an empty source, two sources, or one over 160 characters refuse the block; a source with no item text too", () => {
    expect(card(fence("facts:\n- A | source:"))).toBeNull();
    expect(card(fence("facts:\n- A | source: "))).toBeNull();
    expect(card(fence("facts:\n- A | source: x | source: y"))).toBeNull();
    expect(card(fence(`facts:\n- A | source: ${chars(SOURCE_MAX + 1)}`))).toBeNull();
    expect(card(fence("facts:\n-  | source: x"))).toBeNull();
  });

  it("'source:' with no space before the bar, or inside the sentence, is just words", () => {
    expect(card(fence("facts:\n- A|source: x"))!.facts).toEqual([{ text: "A|source: x" }]);
    expect(card(fence("facts:\n- o campo source: vale 3"))!.facts).toEqual([{ text: "o campo source: vale 3" }]);
  });

  it("the 300-character limit is the item's text, the 160 the source's: each its own", () => {
    expect(card(fence(`facts:\n- ${chars(ITEM_MAX)} | source: ${chars(SOURCE_MAX)}`))).not.toBeNull();
  });
});

describe("characters", () => {
  it("nothing is removed (A-195): the refuse class is a token, the mark class stays (a ZWNJ of a Persian fact), whitespace is collapsed and a tab is a space", () => {
    const dirty = "a\u200bb\u202ec\u2066d\u2069e\u0007f\ufeffg\u200dh   i\t\tj";
    expect(card(fence(`facts:\n- ${dirty}`))!.facts![0].text).toBe("a\u200bb[U+202E]c\u2066d\u2069e[U+0007]f\ufeffg\u200dh i j");
  });

  it("an RTL override cannot reverse an item or a source (it is a token); in a header it makes the header unknown and the block stays code (A-195: the old rule normalized it and accepted it)", () => {
    const e = card(fence("facts:\n- \u202etxet\u202c | source: \u202esrc"))!;
    expect(e.facts![0]).toEqual({ text: "[U+202E]txet[U+202C]", source: "[U+202E]src" });
    expect(JSON.stringify(e)).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/);
    expect(card(fence("fa\u202ects:\n- x"))).toBeNull();              // a character of the refuse class in a header
    expect(card(fence("fa\u200bcts:\n- x"))).toBeNull();              // one of the mark class
    expect(card(fence("facts:\u200b\n- x"))).toBeNull();              // after the colon
  });

  it("a line made only of invisible characters is NOT blank: it is a line that is no item, so the block stays code and nothing is dropped in silence (A-195); a truly blank line still carries nothing", () => {
    expect(card(fence("facts:\n\u200b\u200b\n- X"))).toBeNull();
    expect(card(fence("facts:\n\u0007\n- X"))).toBeNull();
    expect(card(fence("facts:\n\n- X"))).not.toBeNull();
  });

  it("HTML and Markdown inside an item are CHARACTERS: nothing is stripped, escaped or interpreted", () => {
    const text = "<img src=x onerror=alert(1)> **negrito** `código` [link](javascript:alert(1)) # título &amp;";
    expect(card(fence(`facts:\n- ${text}`))!.facts![0].text).toBe(text);
  });

  it("a non-breaking space and a tab are whitespace, so words stay apart; a line separator is a token INSIDE the item (the table refuses it)", () => {
    expect(card(fence("facts:\n- a b c\td"))!.facts![0].text).toBe("a b c d");
    expect(card(fence("facts:\n- a\u2028b"))!.facts![0].text).toBe("a[U+2028]b");
  });

  it("a Persian fact keeps its ZWNJ, an emoji its ZWJ and a word its soft hyphen; the source is strict, so the same characters there are tokens (A-195)", () => {
    const e = card(fence("facts:\n- می\u200cخواهم 👨\u200d👩 inter\u00adnational | source: می\u200cخ\u00ad"))!;
    expect(e.facts![0].text).toBe("می\u200cخواهم 👨\u200d👩 inter\u00adnational");
    expect(e.facts![0].source).toBe("می[U+200C]خ[U+00AD]");
  });

  it("a VT, a FF and a NEL are tokens inside the item: one item, one line, never a break; a U+FEFF at the ends of the text and of the source is not trimmed away", () => {
    const e = card(fence("facts:\n- a\u000bb\u000cc\u0085d\n- \ufeffe\ufeff | source: \ufefff\ufeff"))!;
    expect(e.facts!.map((i) => i.text)).toEqual(["a[U+000B]b[U+000C]c[U+0085]d", "\ufeffe\ufeff"]);
    expect(e.facts![1].source).toBe("[U+FEFF]f[U+FEFF]");
  });

  it("the limits count the text as drawn, tokens included: a token only lengthens, so it can only refuse (300 for the text, 160 for the source)", () => {
    const text = (n: number) => card(fence(`facts:\n- ${"x".repeat(n)}\u202e`));
    expect(text(292)).not.toBeNull();                                 // 292 + the 8 characters of [U+202E] = 300
    expect(text(293)).toBeNull();                                     // 301
    const source = (n: number) => card(fence(`facts:\n- t | source: ${"y".repeat(n)}\u200b`));
    expect(source(152)).not.toBeNull();                               // 152 + 8 = 160
    expect(source(153)).toBeNull();
  });
});

describe("it never throws and never leaks", () => {
  it("1 MiB of anything is fine (and is not a card)", () => {
    const huge = "x".repeat(1024 * 1024);
    expect(splitEvidence(huge)).toEqual([{ kind: "text", text: huge }]);
    expect(card(fence(huge))).toBeNull();
    expect(card(fence("facts:\n- X") + "\n" + huge)).not.toBeNull();
  });

  it("the card carries only the five blocks: no key a Bot could add", () => {
    const e = card(fence(FULL))!;
    expect(Object.keys(e).sort()).toEqual(["assumptions", "awaiting", "done", "facts", "questions"]);
    expect(Object.keys(card(fence("facts:\n- A | source: s"))!.facts![0]).sort()).toEqual(["source", "text"]);
  });

  it("the keys of a Bot-chosen header cannot reach a prototype", () => {
    expect(card(fence("__proto__:\n- X"))).toBeNull();
    expect(card(fence("constructor:\n- X"))).toBeNull();
  });
});
