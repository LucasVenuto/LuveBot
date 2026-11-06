// tests/unit/redteam/skill-draft-header-limit-redteam.test.ts (Lume, 30/10): SK-1h attacked (Prumo's decision, 3.4: the header must close inside the first 4000 CODE POINTS of the file, else header_too_long).
// The limit exists because Hermes lists a skill from `read_text()[:4000]`; so the boundary is the one Hermes has, measured, and not a number that looks right:
//   with the file cut at 4000 code points, Hermes's `\n---\s*\n` (over `content[3:]`) still finds the closing line when the header text, up to the end of the closing `---` and its trailing blanks,
//   is at most 3999 code points long (the line feed that ends it is index 3999), and does not find it at 4000. (Python: re.search on file[:4000]: True for 3990..3999, False for 4000 and 4001.)
//   * the boundary 3999 / 4000 / 4001; the closing line with trailing blanks; emoji (two UTF-16 units, one code point) on both sides of it;
//   * a header of lines of only invisible or blank characters: NBSP-only is empty to the extractor (no_frontmatter), ZWSP-only is not (the server's YAML decides: not a mapping);
//   * the fuzz corpus never lands in header_too_long.
// No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import fuzz from "./fixtures/empty-body-fuzz.json";
import { extractSkillDraft } from "@/lib/skillDraft";

const fence = (body: string) => "```luve-skill\n" + body + "\n```";
const r = (text: string) => extractSkillDraft(text) as { ok: boolean; why?: string; details?: any; draft?: any };
const cp = (...n: number[]) => String.fromCodePoint(...n);
const units = (s: string) => Array.from(s).length;                                  // code points
const HEAD = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório.\n";

/** A header whose text (the opening line to the end of the closing line, trailing blanks included) is EXACTLY `length` code points, then a body. */
function header(length: number, trailing = "", filler = "x"): string {
  const close = "---" + trailing;
  const pad = length - units(HEAD) - units(close);
  if (pad < 2) throw new Error("too short for the filler");
  const comment = "#" + filler.repeat(pad - 2) + "\n";                                // a YAML comment line: harmless to the header, `pad` code points with its line feed
  const text = HEAD + comment + close;
  expect(units(text)).toBe(length);
  return text;
}

describe("the boundary is Hermes's: 3999 sees the closing line, 4000 does not", () => {
  it("3999 and everything under it is accepted; 4001 and everything over it is header_too_long", () => {
    for (const n of [200, 3000, 3990, 3996, 3998, 3999]) expect(r(fence(header(n) + "\n1. a")).ok, String(n)).toBe(true);
    for (const n of [4001, 4002, 4100, 9000]) expect(r(fence(header(n) + "\n1. a")), String(n)).toEqual({ ok: false, why: "header_too_long" });
  });

  it("EXACTLY 4000 is header_too_long: the line feed that ends the closing line is code point 4000 of the file, outside the 4000 that Hermes reads, so Hermes sees no closing line (off by one at `> 4000`)", () => {
    expect(r(fence(header(4000) + "\n1. a"))).toEqual({ ok: false, why: "header_too_long" });
  });

  it("trailing blanks on the closing line count: 3999 code points with them is accepted, one more is not (the Hermes regex takes them as `\\s*`, and the line feed still has to be inside)", () => {
    expect(r(fence(header(3999, "     ") + "\n1. a")).ok).toBe(true);
    expect(r(fence(header(4001, "     ") + "\n1. a")).why).toBe("header_too_long");
    expect(r(fence(header(3999, " \t \t") + "\n1. a")).ok).toBe(true);
  });

  it("the unit is the code point: a header of 3999 code points made of emoji and ASCII (about 7,000 UTF-16 units) is accepted, and 4001 of them is not", () => {
    const emoji = (length: number) => header(length, "", cp(0x1f600));
    const ok = emoji(3999);
    expect(ok.length).toBeGreaterThan(5000);                                              // UTF-16 units: well over 4000
    expect(r(fence(ok + "\n1. a")).ok).toBe(true);
    expect(r(fence(emoji(4001) + "\n1. a")).why).toBe("header_too_long");
  });

  it("the unit is the code point for combining sequences too: 1400 `e` with two combining marks are 4200 code points, over the limit (a ZWJ sequence would hit the count of marked characters first, by the order of 3.4)", () => {
    const seq = cp(0x65, 0x301, 0x302);
    const text = HEAD + "# " + seq.repeat(1400) + "\n---";
    expect(units(text)).toBeGreaterThan(4000);
    expect(r(fence(text + "\n1. a")).why).toBe("header_too_long");
    const zwj = cp(0x1f469, 0x200d, 0x1f4bb);
    expect(r(fence(HEAD + "# " + zwj.repeat(2000) + "\n---\n1. a")).why).toBe("too_many_invisible");        // 2000 joiners: refused for the count first
  });

  it("the body does not count: a body of 20,000 code points after a short header is accepted, and the closing line is what is measured (not the file)", () => {
    expect(r(fence(header(300) + "\n" + "1. passo\n".repeat(4000))).why).toBe("too_large");     // 36,000 bytes: over the 32 KiB cap, a different rule
    expect(r(fence(header(300) + "\n" + "1. passo\n".repeat(1000))).ok).toBe(true);
  });

  it("an unclosed header is no_frontmatter however long, and a header_too_long never carries details", () => {
    expect(r(fence(HEAD + "# " + "x".repeat(6000))).why).toBe("no_frontmatter");
    expect(r(fence(header(4500) + "\n1. a")).details).toBeUndefined();
  });
});

describe("a header made only of blank or invisible lines", () => {
  const draftWith = (lines: string[]) => fence(["---", ...lines, "---", "1. a"].join("\n"));

  it("blank lines and lines of spaces and tabs are an empty header (no_frontmatter, nothing to point at)", () => {
    for (const lines of [[""], ["", "  "], ["\t"], ["", " \t ", "\t\t"]]) {
      expect(r(draftWith(lines)), JSON.stringify(lines)).toEqual({ ok: false, why: "no_frontmatter" });
    }
  });

  it("a line of only no-break, ideographic or other Unicode spaces is NOT empty to the extractor (only spaces and tabs are blank here, as in the closing line): it goes on and the server's YAML refuses it (not a mapping)", () => {
    for (const lines of [[cp(0xa0)], [cp(0x3000), cp(0x2003)], ["", cp(0xa0), "\t"]]) expect(r(draftWith(lines)).ok, JSON.stringify(lines)).toBe(true);
  });

  it("a line of only zero-width or other MARKED characters is not blank to the extractor (it is not whitespace), so the draft goes on: the server's YAML says it is not a mapping", () => {
    for (const ch of [cp(0x200b), cp(0x200c), cp(0x2060), cp(0x3164), cp(0x2800)]) {
      const out = r(draftWith([ch]));
      expect(out.ok, "U+" + ch.codePointAt(0)!.toString(16)).toBe(true);                // not the extractor's business: no YAML here
      expect(out.draft.hidden).toBe(1);
    }
  });

  it("a header that holds one real line among blank ones is a header", () => {
    expect(r(draftWith(["", "name: enviar-relatorio", "", "description: Use x."])).ok).toBe(true);
  });
});

describe("the fuzz corpus and the new word", () => {
  it("none of the 2,281 bodies lands in header_too_long (the header is fixed and short): the new rule did not move a verdict", () => {
    const words = new Set<string>();
    for (const c of fuzz.cases as any[]) {
      const out = r(fence(`${fuzz.header}\n${c.body}`));
      words.add(out.ok ? "ok" : (out.why as string));
    }
    expect(words.has("header_too_long")).toBe(false);
    expect([...words].sort()).toEqual(["empty_body", "hidden_characters", "ok", "too_many_invisible"]);
  });
});
