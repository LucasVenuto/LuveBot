// tests/unit/transcript/skill-draft-table.test.ts (contract v0.11 §3.4, slice SK-1c: tests (2) and (3))
// The characters nobody can see are ONE table for the server and the screen: backend/unicode_invisible.json, generated from the Unicode Character Database. The extractor imports that file; it reads no property
// of the browser's own Unicode data (a browser's version moves, the server's does not, and the two would disagree at the edge of every release). Three things keep the two honest:
//   - the extractor's classes ARE the file (the first and last code point of every range, and the neighbours just outside it);
//   - a DRIFT ALARM: this is the one place that asks the test engine what `Default_Ignorable_Code_Point` is; every such code point must be in the table (a failure means the table is OLDER than the engine:
//     regenerate it with scripts/gen_invisible_table.py; a table that knows more than an old engine is fine);
//   - the SHARED FIXTURE tests/data/invisible-fixture.json (strings with their verdict, count and positions), which the server's test reads too, so the two implementations cannot drift in behavior.
// No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import TABLE from "../../../backend/unicode_invisible.json";
import FIXTURE from "../../data/invisible-fixture.json";
import { extractSkillDraft, classifyInvisible, codeOf, MARKED_MAX, SKILL_MAX_BYTES, HEADER_MAX } from "@/lib/skillDraft";

type Case = { id: string; text: string; verdict: "ok" | "refuse" | "too_many"; count: number | null; where: [number, number][] | null; refused: { code: string; code_point: number; line: number; column: number } | null };
const { max_marked, cases } = FIXTURE as unknown as { max_marked: number; cases: Case[] };
const cp = (...n: number[]) => String.fromCodePoint(...n);
const hex = (n: number) => "U+" + n.toString(16).toUpperCase().padStart(4, "0");
const inRanges = (ranges: number[][], c: number) => ranges.some(([a, b]) => c >= a && c <= b);
/** What the table says of one code point, by the plainest possible loop (the oracle of these tests, apart from the code under test). */
const classOf = (c: number) => (inRanges(TABLE.refuse, c) ? "refuse" : inRanges(TABLE.mark, c) ? "mark" : "plain");

describe("the extractor holds no table of its own", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "dashboard/src/lib/skillDraft.ts"), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

  it("it imports the shared JSON, and neither a Unicode property escape nor a typed range of code points is in its code", () => {
    expect(source).toContain('from "../../../backend/unicode_invisible.json"');
    expect(source).not.toMatch(/\\p\{/);                                    // the engine's property is not read at run time
    expect(source).not.toMatch(/0x(?:200[b-d]|2060|e0000|e007f|feff|202[a-e])/i);   // and none of the table's well-known numbers is typed here
  });
});

describe("the extractor's classes ARE the file", () => {
  it("every range: its first and last code point are classified as the table says, in the right place of the text", () => {
    for (const [kind, ranges] of [["refuse", TABLE.refuse], ["mark", TABLE.mark]] as const) {
      for (const [lo, hi] of ranges) {
        for (const c of new Set([lo, hi])) {
          const out = classifyInvisible("a" + cp(c) + "b");
          if (kind === "refuse") expect(out, hex(c)).toMatchObject({ verdict: "refuse", refused: { codePoint: c, line: 1, column: 2 } });
          else expect(out, hex(c)).toMatchObject({ verdict: "ok", count: 1, marks: [{ codePoint: c, line: 1, column: 2 }] });
        }
      }
    }
  });

  it("the code point just outside every range is plain text unless another range takes it (an off-by-one at an edge is caught)", () => {
    for (const [lo, hi] of [...TABLE.refuse, ...TABLE.mark]) {
      for (const c of [lo - 1, hi + 1]) {
        if (c < 0 || c > 0x10ffff || classOf(c) !== "plain") continue;
        expect(classifyInvisible("a" + cp(c) + "b"), hex(c)).toMatchObject({ verdict: "ok", count: 0 });
      }
    }
  });

  it("the emoji presentation selectors U+FE0E and U+FE0F are in neither class: a text with them is plain", () => {
    expect(TABLE.mark_except).toEqual([0xfe0e, 0xfe0f]);
    for (const c of TABLE.mark_except) expect(classifyInvisible("a" + cp(c)), hex(c)).toMatchObject({ verdict: "ok", count: 0, marks: [] });
  });
});

describe("the drift alarm: the table is not older than the engine", () => {
  it("every code point the test engine calls Default_Ignorable is refused, marked, or one of the named exceptions", () => {
    const known = (c: number) => classOf(c) !== "plain" || (TABLE.mark_except as number[]).includes(c);
    const DI = /\p{Default_Ignorable_Code_Point}/u;
    const missing: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) if (!known(c) && DI.test(String.fromCodePoint(c))) missing.push(hex(c));
    expect(missing.slice(0, 12), `the table (Unicode ${TABLE.unicode_version}) is older than this engine: regenerate it with scripts/gen_invisible_table.py`).toEqual([]);
  }, 60_000);
});

describe("the shared fixture, through the classifier", () => {
  it("holds the cases the contract names: the 50th and the 51st marked character, and a refused one that beats the count; and its limit is the extractor's", () => {
    expect(max_marked).toBe(MARKED_MAX);
    const ids = cases.map((c) => c.id);
    for (const needed of ["fifty-one-marked-is-refused", "refuse-after-fifty-marked", "first-refused-is-reported"]) expect(ids).toContain(needed);
    expect(cases.some((c) => c.verdict === "ok" && c.count === 50)).toBe(true);
  });

  for (const c of cases) {
    it(`${c.id}: ${c.verdict}${c.count === null ? "" : ", " + c.count}`, () => {
      const out = classifyInvisible(c.text);
      expect(out.verdict).toBe(c.verdict);
      expect(out.count).toBe(c.count);
      if (c.verdict === "ok") expect(out.marks.map((m) => [m.line, m.column])).toEqual(c.where);
      if (c.verdict === "refuse") expect(out.refused && { code: codeOf(out.refused.codePoint), code_point: out.refused.codePoint, line: out.refused.line, column: out.refused.column }).toEqual(c.refused);   // the code is the server's text, not recomputed from the number
    });
  }
});

describe("the shared fixture, through the extractor (the whole path a conversation's text takes)", () => {
  const PREFIX = "---\nname: a\ndescription: Use x.\n---\nx\n";          // a header and a visible line: the fixture's text then starts at line 5, column 1
  const OFFSET = PREFIX.split("\n").length - 1;
  const wrap = (text: string) => "```luve-skill\n" + PREFIX + text + "\n```";

  for (const c of cases) {
    it(`${c.id}: ${c.verdict === "ok" ? "a draft with " + c.count + " marked" : c.verdict === "refuse" ? "hidden_characters" : "too_many_invisible"}`, () => {
      const out = extractSkillDraft(wrap(c.text));
      const at = c.refused;                                       // the first refused character: its code, and its line and column from the first line of the SKILL.md
      if (c.verdict === "refuse") return expect(out).toEqual({ ok: false, why: "hidden_characters", details: { code: at?.code, line: (at?.line as number) + OFFSET, column: at?.column } });
      if (c.verdict === "too_many") return expect(out).toEqual({ ok: false, why: "too_many_invisible", details: { count: c.count } });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.draft.hidden).toBe(c.count);
      expect(out.draft.content).toBe((PREFIX + c.text).replace(/\r\n|\r/g, "\n"));          // nothing removed, nothing added
      if (!c.text.includes("\r")) expect(out.draft.marks.map((m) => [m.line, m.column])).toEqual((c.where as [number, number][]).map(([l, col]) => [l + OFFSET, col]));
    });
  }
});

describe("what the review is given about the marked characters", () => {
  const HEADER = "---\nname: a\ndescription: Use x.\n---";
  it("each one with its code point (so the panel can say ZWNJ x5), its line and its column in code points, by LF, whatever the line breaks the Bot used", () => {
    const text = "```luve-skill\r\n" + HEADER + "\r\nPasso" + cp(0x200c) + " um\r\n😀" + cp(0x200d) + "fim" + cp(0x00ad) + "\r\n```";
    const out = extractSkillDraft(text);
    expect(out.ok && out.draft.marks).toEqual([
      { codePoint: 0x200c, line: 5, column: 6 },
      { codePoint: 0x200d, line: 6, column: 2 },      // the emoji before it is ONE column, not two
      { codePoint: 0x00ad, line: 6, column: 6 },
    ]);
  });

  it("an accepted draft lists every marked character, and exactly 50 are accepted while the 51st is refused", () => {
    const ok = extractSkillDraft("```luve-skill\n" + HEADER + "\n" + "z" + cp(0x200c).repeat(50) + "\n```");
    expect(ok.ok && ok.draft.marks.length).toBe(50);
    expect(ok.ok && ok.draft.hidden).toBe(50);
    expect(extractSkillDraft("```luve-skill\n" + HEADER + "\n" + "z" + cp(0x200c).repeat(51) + "\n```")).toEqual({ ok: false, why: "too_many_invisible", details: { count: 51 } });
  });
});

describe("what the refusal says (contract 3.4: where and how much, equal to the server, never the text)", () => {
  const HEADER = "---\nname: a\ndescription: Use x.\n---";
  const refuse = (body: string) => extractSkillDraft("```luve-skill\n" + body + "\n```");

  it("hidden_characters names the FIRST refused character: its code, and its line and column counted from the first line of the SKILL.md", () => {
    expect(refuse(HEADER + "\nPasso " + cp(0xe0041) + "um\n" + cp(0x0007))).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+E0041", line: 5, column: 7 } });
    expect(refuse(HEADER.replace("name: a", "name: a" + cp(0x202e)) + "\nok")).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+202E", line: 2, column: 8 } });   // in the header, line 2
    expect(refuse("---\n" + cp(0x0000) + "name: a\n---\nok")).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+0000", line: 2, column: 1 } });   // line 1 is the `---` line itself (nothing can hide in it)
  });

  it("the column counts in code points: an emoji before the refused character is ONE column", () => {
    expect(refuse(HEADER + "\n\ud83d\ude00" + cp(0xe0041))).toMatchObject({ details: { line: 5, column: 2 } });
  });

  it("a refused character wins over the count, and the first one is the one reported (a later one, or a marked one before it, changes nothing)", () => {
    expect(refuse(HEADER + "\n" + cp(0x200c).repeat(60) + cp(0x0007) + cp(0xe0041))).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+0007", line: 5, column: 61 } });
  });

  it("too_many_invisible says how many, and nothing else", () => {
    expect(refuse(HEADER + "\nz" + cp(0x200d).repeat(75))).toEqual({ ok: false, why: "too_many_invisible", details: { count: 75 } });
  });

  it("no details for any other reason, and none when a draft only LOOKS empty (there is no refused character to point at)", () => {
    for (const text of ["no fence", "```luve-skill\n" + HEADER, "```luve-skill\nnot a header\n```", "```luve-skill\n" + HEADER + "\n" + "x".repeat(40 * 1024) + "\n```", "```luve-skill\n" + HEADER + "\n" + cp(0x200b).repeat(5) + "\n```"]) {
      const out = extractSkillDraft(text);
      expect(out.ok).toBe(false);
      expect("details" in out, JSON.stringify(out).slice(0, 80)).toBe(false);
    }
  });

  it("the details hold no text of the draft: the code names the character, the character itself is never in the answer", () => {
    const out = refuse(HEADER + "\nsegredo" + cp(0xe0041) + cp(0xe0042));
    expect(JSON.stringify(out)).not.toMatch(/segredo/);
    expect(JSON.stringify(out)).not.toContain(cp(0xe0041));
  });

  it("codeOf: U+ and at least four uppercase hexadecimal digits", () => {
    expect([0x0, 0x7, 0x200c, 0xe0041, 0x1d173, 0x10ffff].map(codeOf)).toEqual(["U+0000", "U+0007", "U+200C", "U+E0041", "U+1D173", "U+10FFFF"]);
  });
});

describe("a huge answer is cut by size before its marked characters are listed", () => {
  const H = "---\nname: a\ndescription: Use x.\n---\n";
  /** The fastest of five runs of the extraction and, taken in turn with each of them so the two see the same load, of the work nobody can avoid: the UTF-8 encode of the same body (the size cap needs the byte count; a marked character is
   *  3 bytes, a plain one 1, so the encode itself costs 8 times more for marked text). An answer of 8 Mi of `ch` (a long stream of them is what a Bot can send), asked whether it is a draft. */
  const best = (ch: string) => {
    const body = "---\nname: a\ndescription: Use x.\n---\n" + ch.repeat(8 << 20), text = "```luve-skill\n" + body + "\n```", encoder = new TextEncoder();
    let fastest = Infinity, floor = Infinity, out: unknown = null;
    for (let i = 0; i < 5; i++) {
      let start = performance.now(); out = extractSkillDraft(text); fastest = Math.min(fastest, performance.now() - start);
      start = performance.now(); encoder.encode(body).length; floor = Math.min(floor, performance.now() - start);
    }
    return { fastest, floor, out };
  };

  it("8 Mi marked characters cost about what the unavoidable encode of them costs (too_large either way): they are not listed one by one first, which a stream of pieces would repeat", () => {
    const plain = best("a"), marked = best(cp(0x200c));
    expect(plain.out).toEqual({ ok: false, why: "too_large" });
    expect(marked.out).toEqual({ ok: false, why: "too_large" });
    // The limit follows the machine: 12 times the encode measured in turn with the extraction, never under 150 ms. Quiet: 24 ms for 13; at 4 times the load, 95 for 52. Listing the 8 Mi characters one by one first (the defect) costs
    // seconds and is about 100 times the encode at any load. Before, the limit was 4 times the PLAIN run plus 40 ms: the plain run only counts bytes of ASCII (5 ms), so the limit was 60 ms, under the unavoidable cost of the marked one (72 against 62, 120 against 83 under load).
    expect(marked.fastest).toBeLessThan(Math.max(150, 12 * marked.floor));
    expect(plain.fastest).toBeLessThan(Math.max(150, 12 * plain.floor));
  }, 60_000);
});

describe("ONE order of refusals, the same as the server's (3.4): extraction, too_large, hidden_characters, too_many_invisible, no_frontmatter, empty_body", () => {
  const HEADER = "---\nname: a\ndescription: Use x.\n---";
  const run = (body: string) => extractSkillDraft("```luve-skill\n" + body + "\n```");
  const why = (body: string) => { const r = run(body); return r.ok ? "ok" : r.why; };

  it("a refused character ON LINE 1 is hidden_characters with line 1, not no_frontmatter: the invisible character is why line 1 is not ---, and the person is told", () => {
    expect(run("---" + cp(0x0000) + "\nname: a\n---\nok")).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+0000", line: 1, column: 4 } });
    expect(run("Aqui esta" + cp(0xe0041) + "\n---\nname: a\n---")).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+E0041", line: 1, column: 10 } });   // no header at all, and a Tag on line 1
  });

  it("hidden_characters wins over the header check wherever the character is, and over the count", () => {
    expect(why("sem cabecalho\nsegunda" + cp(0xe0041))).toBe("hidden_characters");
    expect(why("sem cabecalho " + cp(0x200c).repeat(60) + cp(0x0007))).toBe("hidden_characters");
  });

  it("too_many_invisible comes before no_frontmatter, and a MARKED character on line 1 alone is only no_frontmatter (nothing refused, nothing over the limit)", () => {
    expect(run("sem cabecalho " + cp(0x200c).repeat(60))).toEqual({ ok: false, why: "too_many_invisible", details: { count: 60 } });
    expect(why(cp(0xfeff) + HEADER)).toBe("no_frontmatter");                       // a BOM before the --- (marked, allowed) still means line 1 is not ---
  });

  it("too_large comes before everything that needs a scan: the hidden characters, the count, the header", () => {
    const big = "x".repeat(SKILL_MAX_BYTES);
    expect(why(HEADER + "\n" + big + cp(0xe0041))).toBe("too_large");
    expect(why(HEADER + "\n" + big + cp(0x200c).repeat(60))).toBe("too_large");
    expect(why("sem cabecalho\n" + big)).toBe("too_large");
  });

  it("no_frontmatter comes before 'looks empty': a body of nothing but marked characters and no header is no_frontmatter", () => {
    expect(why(cp(0x200b).repeat(5))).toBe("no_frontmatter");
  });

  it("a draft that only LOOKS empty (the header, then only marked characters and blanks) is empty_body with NO details: the server's word for the same text, and hidden_characters is kept for a text that holds a refused character", () => {
    expect(run(HEADER + "\n" + cp(0x200b).repeat(40))).toEqual({ ok: false, why: "empty_body" });
    expect(run(HEADER + "\n  " + cp(0x2800) + "\n")).toEqual({ ok: false, why: "empty_body" });
    expect(run(HEADER + "\n" + cp(0x200b) + ".")).toMatchObject({ ok: true });         // something to read after the marked character: a draft
  });

  it("every hidden_characters answer carries its place, whatever the text: no hidden_characters without details", () => {
    for (const c of cases.filter((k) => k.verdict === "refuse")) {
      const out = extractSkillDraft("```luve-skill\n" + c.text + "\n```");          // the fixture's text as the whole body: line 1 may be anything
      expect(out.ok).toBe(false);
      if (!out.ok) { expect(out.why, c.id).toBe("hidden_characters"); expect(out.details, c.id).toMatchObject({ code: c.refused?.code, line: c.refused?.line, column: c.refused?.column }); }
    }
  });
});

describe("what needs no YAML is refused by the extractor (3.4, SK-1g): the sheet never opens on a draft the server must refuse", () => {
  const run = (body: string) => extractSkillDraft("```luve-skill\n" + body + "\n```");
  const why = (body: string) => { const r = run(body); return r.ok ? "ok" : r.why; };
  const FIELDS = "name: a\ndescription: Use x.";

  it("a header that is opened and never closed is no_frontmatter, the server's word", () => {
    expect(run("---\n" + FIELDS + "\n1. Passo.")).toEqual({ ok: false, why: "no_frontmatter" });
    expect(why("---")).toBe("no_frontmatter");                                   // line 1 alone is not a closing line: the closing one is a LATER line
    expect(why("---\n")).toBe("no_frontmatter");
  });

  it("the closing line is `---` and only spaces or tabs after it: anything else around the dashes is not the end of the header", () => {
    for (const closing of ["---", "--- ", "---\t", "---  \t "]) expect(why("---\n" + FIELDS + "\n" + closing + "\nPasso."), JSON.stringify(closing)).toBe("ok");
    for (const notClosing of [" ---", "----", "---x", "-- -", "---" + cp(0xa0), "---" + cp(0x3000), "---" + cp(0x200b), "***", "..."]) {
      expect(why("---\n" + FIELDS + "\n" + notClosing + "\nPasso."), JSON.stringify(notClosing)).toBe("no_frontmatter");
    }
  });

  it("the text after the CLOSING line is what must be readable: a visible header with nothing after it is empty_body, not a draft", () => {
    expect(run("---\n" + FIELDS + "\n---")).toEqual({ ok: false, why: "empty_body" });
    expect(why("---\n" + FIELDS + "\n---\n")).toBe("empty_body");
    expect(why("---\n" + FIELDS + "\n---\n\n  \t\n")).toBe("empty_body");
    expect(why("---\n" + FIELDS + "\n---\n" + cp(0xa0) + cp(0x3000))).toBe("empty_body");                   // blank is blank
    expect(why("---\n" + FIELDS + "\n---\n" + cp(0x200b) + cp(0x2800) + cp(0x034f))).toBe("empty_body");     // marked characters show nothing either
    expect(why("---\n" + FIELDS + "\n---\n" + cp(0x200b) + "x")).toBe("ok");                                // one character to read is enough: the rest is the server's
  });

  it("what the header's lines MEAN is not the extractor's business: no name, a number as a name, an alias, a comment, a line that is only a no-break space, broken YAML all pass here (the server says bad_yaml, bad_name, no_description...)", () => {
    for (const header of ["---\nname: 42\n---", "---\nno: keys\n---", "---\nname: &a x\ndescription: *a\n---", "---\n[[[[\n---", "---\n# only a comment\n---", "---\n" + cp(0xa0) + "\n---"]) expect(why(header + "\nPasso."), header).toBe("ok");
  });

  it("no_frontmatter comes before empty_body: an unclosed header with nothing readable after it is no_frontmatter", () => {
    expect(why("---\n" + FIELDS)).toBe("no_frontmatter");
    expect(why("---\n" + FIELDS + "\n" + cp(0x200b).repeat(5))).toBe("no_frontmatter");
  });
});

describe("the shared fixture's EMPTINESS cases, through the extractor (3.4: what counts as nothing to read)", () => {
  type Empty = { id: string; header: string; body: string; text: string; verdict: "empty_body" | "hidden_characters" | "ok" };
  const { emptiness } = FIXTURE as unknown as { emptiness: Empty[] };
  const run = (text: string) => extractSkillDraft("```luve-skill\n" + text + "\n```");

  it("holds the families the contract names: only spaces, only marked characters, a refused one among spaces, and something to read", () => {
    expect(emptiness.length).toBeGreaterThanOrEqual(10);
    for (const v of ["empty_body", "hidden_characters", "ok"]) expect(emptiness.some((c) => c.verdict === v), v).toBe(true);
    for (const c of emptiness) expect(c.text, c.id).toBe(c.header + c.body);
  });

  for (const c of emptiness) {
    it(`${c.id}: ${c.verdict}`, () => {
      const out = run(c.text);
      if (c.verdict === "ok") return expect(out.ok).toBe(true);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.why).toBe(c.verdict);
        if (c.verdict === "empty_body") expect("details" in out).toBe(false);          // nothing refused to point at
        else expect(out.details).toMatchObject({ line: expect.any(Number), column: expect.any(Number) });   // a refused character: its place
      }
    });
  }
});

describe("what is checked without YAML about the header itself (3.4, SK-1h): empty, and too long for Hermes's lister", () => {
  const run = (body: string) => extractSkillDraft("```luve-skill\n" + body + "\n```");
  const why = (body: string) => { const r = run(body); return r.ok ? "ok" : r.why; };
  /** A file whose closing `---` line ENDS at code point `n` (counted from the first character of the file), with ASCII only unless `fill` says otherwise. */
  const headerEndingAt = (n: number, closing = "---", fill = "x") => {
    const base = "---\nname: a\nk: ", tail = "\n" + closing;
    return base + fill.repeat(n - Array.from(base + tail).length) + tail;
  };

  it("the limit is the one Hermes reads: the first 4000 characters of the file", () => {
    expect(HEADER_MAX).toBe(4000);
  });

  it("a header with nothing in it (only blank lines between the two ---) is no_frontmatter, with no details: no header at all", () => {
    for (const header of ["---\n---", "---\n\n---", "---\n \t \n---", "---\n\n\n\n---", "---\n" + " ".repeat(300) + "\n---"]) {
      expect(run(header + "\nPasso."), JSON.stringify(header)).toEqual({ ok: false, why: "no_frontmatter" });
    }
  });

  it("one non-blank line is enough for the extractor, whatever it says", () => {
    expect(why("---\nx\n---\nPasso.")).toBe("ok");
  });

  it("Hermes reads [:4000] and needs the closing line AND its line feed in it: a closing line that ENDS at code point 3999 is accepted, one that ends at 4000 is header_too_long, with no details", () => {
    expect(why(headerEndingAt(3998) + "\nPasso.")).toBe("ok");
    expect(why(headerEndingAt(3999) + "\nPasso.")).toBe("ok");
    expect(run(headerEndingAt(4000) + "\nPasso.")).toEqual({ ok: false, why: "header_too_long" });
    expect(why(headerEndingAt(4001) + "\nPasso.")).toBe("header_too_long");
    expect(why(headerEndingAt(6000) + "\nPasso.")).toBe("header_too_long");
  });

  it("the blanks after the dashes of the closing line are inside the count (the line must END within the limit)", () => {
    expect(why(headerEndingAt(3999, "---") + "\nPasso.")).toBe("ok");
    expect(why(headerEndingAt(3999, "--- ") + "\nPasso.")).toBe("ok");
    expect(why(headerEndingAt(4000, "---  ") + "\nPasso.")).toBe("header_too_long");
    expect(why(headerEndingAt(3999, "---").replace(/---$/, "--- ") + "\nPasso.")).toBe("header_too_long");     // the same text with one blank more: ends at 4000
  });

  it("the count is in CODE POINTS, not in UTF-16 units: a header of 3999 emoji-and-letter code points (more than 4000 units) is accepted, one more is not", () => {
    const emoji = "\ud83d\ude00";
    const ok = headerEndingAt(3999, "---", emoji);
    expect(ok.length).toBeGreaterThan(4000);
    expect(Array.from(ok).length).toBe(3999);
    expect(why(ok + "\nPasso.")).toBe("ok");
    expect(why(headerEndingAt(4000, "---", emoji) + "\nPasso.")).toBe("header_too_long");
  });

  it("only the HEADER counts: a long body, up to the 32 KiB cap, is not header_too_long", () => {
    expect(why(headerEndingAt(300) + "\n" + "Passo longo. ".repeat(2000))).toBe("ok");
  });

  it("the order: no_frontmatter before header_too_long, and hidden_characters and too_large before both", () => {
    expect(why("---\nname: a\n" + "k: x\n".repeat(900))).toBe("no_frontmatter");                       // long and never closed
    expect(why("---\n" + "\n".repeat(4100) + "---\nPasso.")).toBe("no_frontmatter");                    // long and empty: blank lines only
    expect(why(headerEndingAt(4200).replace("name: a", "name: a" + cp(0xe0041)) + "\nPasso.")).toBe("hidden_characters");
    expect(why(headerEndingAt(4200) + "\n" + "x".repeat(SKILL_MAX_BYTES))).toBe("too_large");
  });
});
