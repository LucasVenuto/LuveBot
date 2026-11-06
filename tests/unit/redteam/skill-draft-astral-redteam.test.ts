// tests/unit/redteam/skill-draft-astral-redteam.test.ts (Lume, 30/10): the table widened by Brasa (the 32 astral noncharacters refused, U+FFF9..U+FFFB and U+13430..U+1343F marked), attacked from the extractor.
//   * an astral noncharacter spelled as a valid surrogate PAIR is the code point, refused as itself (U+1FFFE, not "two lone surrogates"); split by a line break it IS two lone surrogates; its neighbours are not refused;
//   * the two new families inside an emoji sequence mark THEMSELVES and never the emoji: the counts, the columns (in code points) and the ZWJ of the sequence are exact;
//   * the edges of each new range (one before, one after) are not marked.
// No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import { extractSkillDraft } from "@/lib/skillDraft";

const HEADER = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório semanal ao cliente.\n---";
const fence = (body: string) => "```luve-skill\n" + body + "\n```";
const draft = (...lines: string[]) => fence([HEADER, ...lines].join("\n"));
const r = (text: string) => extractSkillDraft(text) as { ok: boolean; why?: string; details?: any; draft?: any };
const cp = (...n: number[]) => String.fromCodePoint(...n);
const pair = (c: number) => String.fromCharCode(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff));      // a valid surrogate pair written as two UTF-16 units
const ASTRAL = Array.from({ length: 16 }, (_, i) => i + 1).flatMap((plane) => [plane * 0x10000 + 0xfffe, plane * 0x10000 + 0xffff]);
const code = (c: number) => "U+" + c.toString(16).toUpperCase();

describe("an astral noncharacter and the surrogate pair that spells it", () => {
  it("the pair IS the code point: refused as U+1FFFE with its place, the same as the character written whole, for all 32 and for the 4-, 5- and 6-digit codes", () => {
    for (const c of ASTRAL) {
      expect(pair(c)).toBe(cp(c));                                                    // the same string: there is no 'inside a pair' for an engine that reads code points
      expect(r(draft(`1. a${pair(c)}b`)), code(c)).toEqual({ ok: false, why: "hidden_characters", details: { code: code(c), line: 5, column: 5 } });
    }
    expect(code(0x10ffff)).toBe("U+10FFFF");
  });

  it("the place is in code points: an emoji and a ZWJ before it count once each", () => {
    const out = r(draft(`1. ${cp(0x1f468, 0x200d, 0x1f469)}${pair(0x1fffe)}`));
    expect(out.details).toEqual({ code: "U+1FFFE", line: 5, column: 7 });
  });

  it("split by a line break, or with only one of its halves, it is lone surrogates, refused as a lone surrogate (the first half is what is reported)", () => {
    const [hi, lo] = [pair(0x1fffe)[0], pair(0x1fffe)[1]];
    expect(r(draft(`1. a${hi}\n${lo}b`)).details).toEqual({ code: "U+D83F", line: 5, column: 5 });
    expect(r(draft(`1. a${hi}b`)).details?.code).toBe("U+D83F");
    expect(r(draft(`1. a${lo}b`)).details?.code).toBe("U+DFFE");
  });

  it("the high half of a noncharacter followed by the low half of ANOTHER character is that other character, valid and not refused (U+1FC00 is not a noncharacter)", () => {
    const hi = pair(0x1fffe)[0], lo = pair(0x1fc00)[1];
    expect(hi + lo).toBe(cp(0x1fc00));
    expect(r(draft(`1. a${hi}${lo}b`)).ok).toBe(true);
  });

  it("the neighbours are not refused: the code point before and after each noncharacter (U+1FFFD, U+10FFFD, the last private-use ones) and the first of each plane", () => {
    for (const plane of Array.from({ length: 16 }, (_, i) => i + 1)) {
      for (const c of [plane * 0x10000 + 0xfffd, plane * 0x10000]) {
        if (plane === 14 && c === 0xe0000) continue;                              // the Tags block: refused as it always was
        const out = r(draft(`1. a${cp(c)}b`));
        expect(out.why, code(c)).not.toBe("hidden_characters");
      }
    }
  });

  it("an astral noncharacter anywhere is refused first: in the header, in the closing line's neighbourhood, with 60 marked ones around, and over an unclosed header", () => {
    const nc = pair(0x2ffff);
    expect(r(fence(`---\nname: a\ndescription: Use${nc} x.\n---\n1. a`)).why).toBe("hidden_characters");
    expect(r(draft(`1. ${cp(0x200c).repeat(60)}${nc}`)).why).toBe("hidden_characters");
    expect(r(fence(`---\nname: a${nc}`)).why).toBe("hidden_characters");
    expect(r(fence(`# sem cabecalho ${nc}`)).details).toEqual({ code: "U+2FFFF", line: 1, column: 17 });
  });
});

describe("the two new families, alone and inside emoji sequences", () => {
  const FAMILY = [cp(0xfff9), cp(0xfffa), cp(0xfffb), cp(0x13430), cp(0x13431), cp(0x1343f)];

  it("each one is marked: one count, its place, and the draft is accepted when something readable is around it", () => {
    for (const ch of FAMILY) {
      const out = r(draft(`1. a${ch}b`));
      expect(out.ok, code(ch.codePointAt(0)!)).toBe(true);
      expect(out.draft.hidden).toBe(1);
      expect(out.draft.marks).toEqual([{ codePoint: ch.codePointAt(0), line: 5, column: 5 }]);
    }
  });

  it("the edges are not marked: U+FFEF and U+FFFC (the object replacement character, drawn) and U+1342F and U+13440 stay plain; U+FFFE and U+FFFF stay refused", () => {
    for (const c of [0xffef, 0xfffc, 0xfffd, 0x1342f, 0x13440]) {
      const out = r(draft(`1. a${cp(c)}b`));
      expect(out.ok, code(c)).toBe(true);
      expect(out.draft.hidden, code(c)).toBe(0);
    }
    for (const c of [0xfffe, 0xffff]) expect(r(draft(`1. a${cp(c)}b`)).why).toBe("hidden_characters");
  });

  it("inside a ZWJ family emoji the new character is counted, the emoji and the joiners are counted as before, and the places are in code points", () => {
    const man = cp(0x1f468), woman = cp(0x1f469), girl = cp(0x1f467), zwj = cp(0x200d);
    const text = `1. ${man}${zwj}${cp(0x13430)}${woman}${zwj}${girl}${cp(0xfff9)}`;                    // man ZWJ [hieroglyph] woman ZWJ girl [annotation anchor]
    const out = r(draft(text));
    expect(out.ok).toBe(true);
    expect(out.draft.hidden).toBe(4);                                                                // two joiners and the two new characters: the three emoji are not marked
    expect(out.draft.marks.map((m: any) => [m.codePoint, m.column])).toEqual([[0x200d, 5], [0x13430, 6], [0x200d, 8], [0xfff9, 10]]);
    expect(out.draft.marks.every((m: any) => ![0x1f468, 0x1f469, 0x1f467].includes(m.codePoint))).toBe(true);
    expect(out.draft.content).toBe([HEADER, text].join("\n"));                                        // and nothing is removed
  });

  it("inside a keycap, a flag, a skin-tone and a variation-selector sequence: only the new characters are counted, the selectors and the regional indicators are not", () => {
    const sequences = [
      `1${cp(0xfe0f, 0x20e3)}`, `${cp(0x1f1e7, 0x1f1f7)}`, `${cp(0x1f44d, 0x1f3fd)}`, `${cp(0x2764, 0xfe0f)}`, `${cp(0x2764, 0xfe0e)}`,
    ];
    for (const seq of sequences) {
      for (const ch of [cp(0xfffa), cp(0x13431)]) {
        const split = [...seq];
        const inside = split[0] + ch + split.slice(1).join("");
        const out = r(draft(`1. ${inside}`));
        expect(out.ok, JSON.stringify(inside)).toBe(true);
        expect(out.draft.hidden, JSON.stringify(inside)).toBe(1);
        expect(out.draft.marks[0].codePoint).toBe(ch.codePointAt(0));
      }
    }
  });

  it("a subdivision-flag emoji (a black flag and Tag characters) is still refused whole, the known false positive of 3.4, and the new marks do not rescue it", () => {
    const england = cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
    expect(r(draft(`1. ${england}`)).why).toBe("hidden_characters");
    expect(r(draft(`1. ${england}${cp(0xfff9)}`)).why).toBe("hidden_characters");
  });

  it("fifty of the new characters are fifty marks: the 50th is accepted, the 51st is too_many_invisible, whatever mix of the two families and the old marks", () => {
    expect(r(draft(`1. a${cp(0x13430).repeat(25)}${cp(0xfffb).repeat(25)}b`)).draft.hidden).toBe(50);
    expect(r(draft(`1. a${cp(0x13430).repeat(25)}${cp(0xfffb).repeat(25)}${cp(0x200c)}b`))).toEqual({ ok: false, why: "too_many_invisible", details: { count: 51 } });
  });

  it("a body of only the new characters looks empty: empty_body, with nothing to point at", () => {
    for (const ch of FAMILY) expect(r(draft(ch.repeat(5)))).toEqual({ ok: false, why: "empty_body" });
  });
});
