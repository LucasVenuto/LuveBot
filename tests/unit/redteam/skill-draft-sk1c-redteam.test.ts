// tests/unit/redteam/skill-draft-sk1c-redteam.test.ts (Lume, 30/10): SK-1c (the extractor reads the ONE table, backend/unicode_invisible.json) and the refusal `details` Prumo decided (contract v0.11 3.4).
//   * where a marked character is: line by LF in the LF-normalized content, column in CODE POINTS (an emoji and a ZWJ sequence before it count as they are);
//   * `details` of a refusal: `hidden_characters` -> {code: "U+E0041", line, column} of the FIRST refused character, `too_many_invisible` -> {count}, nothing else, and NEVER text of the draft;
//   * the JSON itself: sorted, merged, disjoint, in range, and held to the Unicode 17 Default_Ignorable fixture in both directions;
//   * the accepted gap of 3.4 ("the Lume's to widen"): the astral noncharacters U+1FFFE, U+1FFFF ... U+10FFFE, U+10FFFF, and two invisible format families the table does not name (U+FFF9..U+FFFB, U+13430..U+1343F).
// `it.fails` = open today, red the day it is fixed (then the owner turns it into `it`); the table widening (astral noncharacters refused, the two format families marked) is delivered, so those are plain `it` now. The `details` ones were `it.fails` until Vitral's SK-1e made them true. No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import TABLE from "../../../backend/unicode_invisible.json";
import fixture from "./fixtures/default-ignorable-unicode17.json";
import { extractSkillDraft } from "@/lib/skillDraft";

const HEADER = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório semanal ao cliente.\n---";
const fence = (body: string) => "```luve-skill\n" + body + "\n```";
const run = (text: string) => extractSkillDraft(text) as any;
const cp = (...n: number[]) => String.fromCodePoint(...n);
const SECRET = "SEGREDO-DO-RASCUNHO-7f3a";
const draft = (...lines: string[]) => fence([HEADER, ...lines].join("\n"));
// no invisible character of any kind may appear in what a refusal says
const NO_INVISIBLE = new RegExp("[" + [[0, 8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xd800, 0xdfff], [0xe0000, 0xe0fff]]
  .map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]", "u");

describe("where a marked character is (the review panel says 'at lines 4, 9 and 12')", () => {
  it("the line counts LF of the normalized content and the column counts CODE POINTS: an emoji before it is one column, a ZWJ sequence is its five", () => {
    const out = run(draft("1. a", `2. 😀${cp(0x200c)}x`, `3. 👨${cp(0x200d)}👩${cp(0x200d)}👧 fim`));
    const marks = out.draft.marks.map((m: any) => [m.codePoint, m.line, m.column]);
    // HEADER is 4 lines: "1. a" is line 5, so the second is line 6 and the third line 7
    expect(marks).toEqual([[0x200c, 6, 5], [0x200d, 7, 5], [0x200d, 7, 7]]);       // "2. " is 3 columns, the emoji the 4th, the ZWNJ the 5th; "3. " + man: ZWJ at 5, woman at 6, ZWJ at 7
  });

  it("a CRLF or a lone CR draft is normalized BEFORE counting: the lines are the same as for LF, and no CR is left to count as a column", () => {
    const lf = run(draft("1. a", `2. b${cp(0x200b)}`));
    const crlf = run(draft("1. a", `2. b${cp(0x200b)}`).replace(/\n/g, "\r\n"));
    const cr = run(draft("1. a", `2. b${cp(0x200b)}`).replace(/\n/g, "\r"));
    expect(crlf.draft.marks).toEqual(lf.draft.marks);
    expect(cr.draft.marks).toEqual(lf.draft.marks);
    expect(crlf.draft.content).toBe(lf.draft.content);
  });

  it("marks are in order of appearance, at most 50 and all of them in an accepted draft; the 50th is where it is", () => {
    const body = Array.from({ length: 50 }, (_, i) => `${i}${cp(0x200c)}`).join("\n");
    const out = run(draft(body));
    expect(out.draft.marks).toHaveLength(50);
    expect(out.draft.marks.map((m: any) => m.line)).toEqual(Array.from({ length: 50 }, (_, i) => 5 + i));
    expect(out.draft.marks.every((m: any, i: number) => m.column === String(i).length + 1)).toBe(true);
  });

  it("a lone half of a surrogate pair is refused, a valid pair is not", () => {
    expect(run(draft("1. \ud83d fim")).ok).toBe(false);
    expect(run(draft("1. 😀 fim")).ok).toBe(true);
  });
});

describe("the refusal `details` (decided in 3.4): where and how many, never what", () => {
  const refusal = (text: string) => run(text) as { ok: false; why: string; details?: any };

  it("hidden_characters carries {code, line, column} of the FIRST refused character: the code is `U+` and at least four uppercase hex digits, the column counts code points", () => {
    const r = refusal(draft("1. a", `2. 😀 ${cp(0xe0041)} depois ${cp(0x202e)}`));
    expect(r.why).toBe("hidden_characters");
    expect(r.details).toEqual({ code: "U+E0041", line: 6, column: 6 });
    expect(refusal(draft(`1. ${cp(0)}`)).details).toEqual({ code: "U+0000", line: 5, column: 4 });
    expect(refusal(draft(`1. ${cp(0x85)}`)).details).toEqual({ code: "U+0085", line: 5, column: 4 });
  });

  it("too_many_invisible carries {count} and nothing else; a refused character still wins over the count", () => {
    expect(refusal(draft(`1. ${cp(0x200c).repeat(51)}`))).toEqual({ ok: false, why: "too_many_invisible", details: { count: 51 } });
    expect(refusal(draft(`1. ${cp(0x200c).repeat(60)}${cp(0xe0041)}`)).why).toBe("hidden_characters");
  });

  it("whatever is in `details`, it is only a code, a line, a column or a count: never the character, never one word of the draft", () => {
    const hostile = [
      draft(`1. ${SECRET} ${cp(0xe0041)} ${SECRET}`), draft(`${SECRET}`, `2. ${cp(0x202e)}${SECRET}`), draft(`1. ${SECRET}${cp(0x200c).repeat(51)}${SECRET}`),
      draft(`1. ${SECRET} \ud83d ${SECRET}`), draft(`${SECRET}${cp(0)}${SECRET}`), fence(`${HEADER}\n${SECRET}${cp(0x1ffff)}`),
    ];
    for (const text of hostile) {
      const r = refusal(text);
      if (r.ok !== false || r.details === undefined) continue;                                    // no details yet: nothing to leak
      const shown = JSON.stringify(r);
      expect(shown, "the draft's text travelled in the refusal").not.toContain(SECRET);
      expect(shown).not.toMatch(NO_INVISIBLE);
      expect(Object.keys(r.details).every((k) => ["code", "line", "column", "count"].includes(k))).toBe(true);
      for (const [k, v] of Object.entries(r.details)) {
        if (k === "code") expect(v).toMatch(/^U\+[0-9A-F]{4,6}$/);
        else expect(Number.isInteger(v) && (v as number) >= 0).toBe(true);
      }
      expect(Object.keys(r).sort()).toEqual(["details", "ok", "why"]);
    }
  });

  it("the other refusals carry no details at all (nothing to say about where)", () => {
    for (const text of ["", "oi", fence("sem cabecalho"), "```luve-skill\n" + HEADER, `${fence(HEADER + "\n1. a")}\n${fence(HEADER + "\n1. b")}`, fence(HEADER + "\n" + "x".repeat(40_000))]) {
      const r = refusal(text);
      expect(r.ok).toBe(false);
      expect(r.details, JSON.stringify(r.why)).toBeUndefined();
    }
  });
});

describe("the table, as a file both sides read", () => {
  type R = [number, number];
  const refuse = TABLE.refuse as R[], mark = TABLE.mark as R[], except = TABLE.mark_except as number[];
  const sortedDisjoint = (rs: R[]) => rs.every(([a, b], i) => a <= b && a >= 0 && b <= 0x10ffff && (i === 0 || rs[i - 1][1] + 1 < a));    // sorted, in range, and merged (no touching ranges)
  const inR = (c: number, rs: R[]) => rs.some(([a, b]) => c >= a && c <= b);

  it("each class is sorted, in range and merged (the classifier bisects: an unsorted file would misclassify silently), and the two classes never overlap", () => {
    expect(sortedDisjoint(refuse)).toBe(true);
    expect(sortedDisjoint(mark)).toBe(true);
    for (const [a, b] of mark) for (const c of [a, b, (a + b) >> 1]) expect(inR(c, refuse), `U+${c.toString(16)} is both refused and marked`).toBe(false);
    for (const c of except) expect(inR(c, mark) || inR(c, refuse), `U+${c.toString(16)} is an exception and still in a class`).toBe(false);
    expect(TABLE.unicode_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("held to the Unicode 17 Default_Ignorable fixture BOTH ways: nothing default-ignorable is missing (but the two emoji selectors), and nothing is marked that is not default-ignorable, U+2800 or one of the two widened format families", () => {
    const di = (fixture as unknown as { ranges: R[] }).ranges;
    for (const [a, b] of di) for (let c = a; c <= b; c++) {
      if (except.includes(c)) { expect(inR(c, mark) || inR(c, refuse)).toBe(false); continue; }
      expect(inR(c, mark) || inR(c, refuse), `U+${c.toString(16)} is default-ignorable and in no class`).toBe(true);
    }
    const widened: R[] = [[0xfff9, 0xfffb], [0x13430, 0x1343f]];                       // interlinear annotation and Egyptian hieroglyph format controls: not default-ignorable, drawn as nothing (the Brasa widened the table, below)
    for (const [a, b] of mark) for (let c = a; c <= b; c++) expect(c === 0x2800 || inR(c, di) || inR(c, widened), `U+${c.toString(16)} is marked and not default-ignorable`).toBe(true);
  });

  it("the refused class is the contract's list and nothing more (a hand-widening here would refuse real text): its code points, by name", () => {
    const named = (c: number) => inR(c, refuse);
    for (const c of [0, 8, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f, 0x80, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0xd800, 0xdfff, 0xfdd0, 0xfdef, 0xfffe, 0xffff, 0xe0000, 0xe007f, 0xe0100, 0xe01ef]) expect(named(c), `U+${c.toString(16)}`).toBe(true);
    for (const c of [0x09, 0x0a, 0x0d, 0x20, 0x41, 0xa0, 0x200b, 0x200e, 0x2066, 0xfeff, 0xfdcf, 0xfdf0, 0xe0080, 0xe01f0, 0xf0000, 0x1f600]) expect(named(c), `U+${c.toString(16)}`).toBe(false);
  });
});

describe("the accepted gap, widened (3.4 says it is mine to widen)", () => {
  const ASTRAL_NONCHARACTERS = Array.from({ length: 16 }, (_, i) => i + 1).flatMap((plane) => [plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff]);

  it("every astral noncharacter (U+1FFFE, U+1FFFF ... U+10FFFE, U+10FFFF: 32 code points) refuses the draft like the first plane's: the Unicode standard reserves all 66 for internal use, a renderer draws them as nothing or a box, and the table refuses 34 of them", () => {
    const missed = ASTRAL_NONCHARACTERS.filter((c) => run(draft(`1. a${cp(c)}b`)).ok);
    expect(missed.map((c) => "U+" + c.toString(16).toUpperCase())).toEqual([]);
  });

  it("the first plane's noncharacters ARE refused today (the 34), so the widening is only the other 32", () => {
    for (const c of [0xfdd0, 0xfdef, 0xfffe, 0xffff]) expect(run(draft(`1. a${cp(c)}b`)).why, `U+${c.toString(16)}`).toBe("hidden_characters");
  });

  it("U+FFF9..U+FFFB (interlinear annotation anchor, separator, terminator) and U+13430..U+1343F (Egyptian hieroglyph format controls) are format characters a screen draws as nothing, default-ignorable or not: at least marked", () => {
    for (const c of [0xfff9, 0xfffa, 0xfffb, 0x13430, 0x1343f]) {
      const r = run(draft(`1. a${cp(c)}b`));
      expect(!r.ok || r.draft.hidden === 1, `U+${c.toString(16)} went through unmarked`).toBe(true);
    }
  });
});
