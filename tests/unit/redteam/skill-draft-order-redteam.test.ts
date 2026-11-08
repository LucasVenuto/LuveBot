// tests/unit/redteam/skill-draft-order-redteam.test.ts (Lume, 30/10): the ONE order of refusals of contract v0.11 3.4 in the extractor (SK-1f) and the principle added after it (SK-1g: "the extractor refuses
// everything that does not need YAML"). The order: (1) the extraction problems, (2) too_large, (3) hidden_characters with its place (it wins over everything below), (4) too_many_invisible, (5) no_frontmatter,
// (6) the header and the rest (the server only), (7) emptiness, `empty_body`, no details.
// SK-1f is delivered (Vitral, `6f521049…`), so its cases are plain `it`: this file is committed AFTER it. The SK-1g ones were `it.fails`; SK-1g is delivered (Vitral, `2421b060…`), so they are plain `it` too.
// No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import { extractSkillDraft, SKILL_MAX_BYTES } from "@/lib/skillDraft";

const HEADER = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório semanal ao cliente.\n---";
const fence = (body: string) => "```luve-skill\n" + body + "\n```";
const r = (text: string) => extractSkillDraft(text) as { ok: boolean; why?: string; details?: any; draft?: any };
const cp = (...n: number[]) => String.fromCodePoint(...n);
const LONE_HIGH = String.fromCharCode(0xd83d);
const base = new TextEncoder().encode(HEADER + "\n").length;
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

describe("the cap, both sides (the scan of (3) runs inside it)", () => {
  const room = SKILL_MAX_BYTES - base;

  it("exactly at the cap a refused character is seen, one byte over it is too_large, and a clean draft is accepted at the cap and refused over it", () => {
    const fits = "x".repeat(room - 4);                                           // + the 4-byte Tag character = exactly the cap
    expect(bytesOf(HEADER + "\n" + fits + cp(0xe0041))).toBe(SKILL_MAX_BYTES);
    expect(r(fence(HEADER + "\n" + fits + cp(0xe0041)))).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+E0041", line: 5, column: room - 3 } });
    expect(r(fence(HEADER + "\n" + fits + "x" + cp(0xe0041))).why).toBe("too_large");
    expect(r(fence(HEADER + "\n" + "x".repeat(room))).ok).toBe(true);
    expect(r(fence(HEADER + "\n" + "x".repeat(room + 1))).why).toBe("too_large");
  });

  it("the cap is in BYTES and is checked before the scan: a refused character (any width) in an over-cap draft is too_large", () => {
    for (const c of [0, 0x85, 0x202e, 0xfdd0, 0xe0041]) expect(r(fence(HEADER + "\n" + "x".repeat(room + 1) + cp(c))).why, "U+" + c.toString(16)).toBe("too_large");
    expect(r(fence(HEADER + "\n" + "é".repeat(room / 2 + 1) + cp(0xe0041))).why).toBe("too_large");                // 2-byte characters: fewer characters than the cap, more bytes
    expect(r(fence(HEADER + "\n" + "x".repeat(room + 1) + cp(0x200c).repeat(60))).why).toBe("too_large");          // and the count of (4)
  });

  it("an over-cap draft with a LONE surrogate is too_large too, and the size count does not throw on it (TextEncoder turns it into 3 bytes; Python's .encode would raise)", () => {
    expect(r(fence(HEADER + "\n" + "x".repeat(room + 1) + LONE_HIGH)).why).toBe("too_large");
    expect(r(fence(HEADER + "\n" + LONE_HIGH)).why).toBe("hidden_characters");
  });
});

describe("(3) wins over everything below it", () => {
  it("a refused character on LINE 1 of a text WITHOUT a header is hidden_characters at line 1 (the cause of 'line 1 is not ---'), and it carries its column in code points", () => {
    expect(r(fence(`# Titulo ${cp(0x202e)}\n${HEADER}`))).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+202E", line: 1, column: 10 } });
    expect(r(fence(`😀 sem cabecalho ${cp(0xe0041)}\nmais texto`)).details).toEqual({ code: "U+E0041", line: 1, column: 17 });
    expect(r(fence(`---${cp(0xe0041)}\nname: a\ndescription: Use x.\n---\n1. a`)).details).toEqual({ code: "U+E0041", line: 1, column: 4 });
    expect(r(fence(`${LONE_HIGH}---\nname: a\ndescription: Use x.\n---\n1. a`)).details).toEqual({ code: "U+D83D", line: 1, column: 1 });
  });

  it("a refused character beats the count (60 marked and one refused) and an unclosed or missing header", () => {
    expect(r(fence(`${HEADER}\n1. ${cp(0x200c).repeat(60)}${cp(0xe0041)}`)).why).toBe("hidden_characters");
    expect(r(fence(`--- x\nname: a\n${cp(0xe0041)}`)).why).toBe("hidden_characters");
    expect(r(fence(`---\nname: a\ndescription: Use x.\nsem fechar ${cp(0x202e)}`)).why).toBe("hidden_characters");
  });

  it("the FIRST refused character is the one told, wherever the others are, and a refused one in the 'empty' area of a draft that looks empty is hidden_characters, not empty_body", () => {
    expect(r(fence(`${HEADER}\n${cp(0x202e)} a ${cp(0xe0041)}`)).details).toEqual({ code: "U+202E", line: 5, column: 1 });
    expect(r(fence(`${HEADER}\n${cp(0x200b).repeat(5)}${cp(0xe0041)}`))).toEqual({ ok: false, why: "hidden_characters", details: { code: "U+E0041", line: 5, column: 6 } });
    expect(r(fence(`${HEADER}\n${cp(0xe0041)}`)).why).toBe("hidden_characters");
  });
});

describe("(4) too_many_invisible before (5) no_frontmatter, and (5) when nothing above applies", () => {
  it("51 marked characters under a line 1 that is not --- are too_many_invisible with the count; exactly 50 reach (5)", () => {
    expect(r(fence(`--- x\nname: a\n${cp(0x200c).repeat(51)}`))).toEqual({ ok: false, why: "too_many_invisible", details: { count: 51 } });
    expect(r(fence(`# Titulo\n${cp(0x200c).repeat(51)}`)).why).toBe("too_many_invisible");
    expect(r(fence(`# Titulo\n${cp(0x200c).repeat(50)}`)).why).toBe("no_frontmatter");
  });

  it("no header is no_frontmatter and says nothing about where", () => {
    for (const body of ["# Titulo\n" + HEADER, "--- x\nname: a", " ---\nname: a\n---\n1. a", "", "texto"]) {
      const out = r(fence(body));
      expect(out.ok).toBe(false);
      expect(out.why, JSON.stringify(body)).toBe("no_frontmatter");
      expect(out.details).toBeUndefined();
    }
  });
});

describe("(7) a draft that only LOOKS empty is empty_body, with no details", () => {
  it("the header and then only marked characters (and blanks): empty_body, the server's word for the same text", () => {
    for (const filler of [cp(0x200b), cp(0x3164), cp(0x2800), cp(0x034f), `${cp(0x200b)} \t${cp(0x180b)}`, `${cp(0x200b)}\n${cp(0x200c)}\n`]) {
      expect(r(fence(`${HEADER}\n${filler.repeat(5)}`)), JSON.stringify(filler)).toEqual({ ok: false, why: "empty_body" });
    }
  });

  it("a body that shows something is accepted, marked characters or not (the order never refuses what 3.4 allows)", () => {
    expect(r(fence(`${HEADER}\n${cp(0x200b)}.`)).ok).toBe(true);
    expect(r(fence(`${HEADER}\n${cp(0x200b).repeat(50)}x`)).ok).toBe(true);
    expect(r(fence(`${HEADER}\n${cp(0xfe0f)}`)).ok).toBe(true);                    // an emoji selector is not marked: it is a character a reader can see the effect of
  });
});

describe("(1) the extraction problems come first", () => {
  it("two fences (one with a Tag in it) is two_fences; an unclosed fence with a refused character is unclosed; no word, none", () => {
    expect(r(`${fence(HEADER + "\n1. a" + cp(0xe0041))}\n${fence(HEADER + "\n1. b")}`).why).toBe("two_fences");
    expect(r("```luve-skill\n" + HEADER + "\n1. a" + cp(0xe0041)).why).toBe("unclosed");
    expect(r("sem a palavra " + cp(0xe0041)).why).toBe("none");
  });
});

describe("SK-1g: the extractor refuses everything that does not need YAML (the principle Prumo added to 3.4)", () => {
  it("a header that is never closed is no_frontmatter in the extractor (today the server is the only one that says so)", () => {
    expect(r(fence("---\nname: a\ndescription: Use x.\nsem fechar")).why).toBe("no_frontmatter");
    expect(r(fence("---\nname: a\n1. passo")).why).toBe("no_frontmatter");
    expect(r(fence("---")).why).toBe("no_frontmatter");
  });

  it("a body that is REALLY empty (nothing, blanks, non-breaking spaces: what Hermes's strip() takes out), with or without marked characters, is empty_body in the extractor", () => {
    for (const body of [HEADER, `${HEADER}\n`, `${HEADER}\n   \n\t\n`, `${HEADER}\n${cp(0xa0)}${cp(0x3000)}${cp(0x2003)}`, `${HEADER}\n${cp(0x200b)}`]) {
      expect(r(fence(body)), JSON.stringify(body)).toEqual({ ok: false, why: "empty_body" });
    }
  });

  it("a refusal still goes by the order: an unclosed header with a refused character is hidden_characters, with 51 marked too_many_invisible, never the header's word", () => {
    expect(r(fence(`---\nname: a\n${cp(0xe0041)}`)).why).toBe("hidden_characters");
    expect(r(fence(`---\nname: a\n${cp(0x200c).repeat(51)}`)).why).toBe("too_many_invisible");
  });
});
