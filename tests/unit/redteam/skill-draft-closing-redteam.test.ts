// tests/unit/redteam/skill-draft-closing-redteam.test.ts (Lume, 30/10): SK-1g attacked (the extractor refuses what needs no YAML) and the fuzz between the two classifiers Prumo asked for.
//   * the CLOSING line of the header (`---` and only spaces or tabs): its boundaries, and what the extractor says that the server, or Hermes, says differently;
//   * a header with nothing in it, and a header longer than what Hermes's lister reads (its first 4000 characters): both detectable without YAML;
//   * `\s` of this engine against the ECMAScript list, and the extractor against 2,281 bodies the SERVER's classifier (backend/unicode_invisible.py and str.strip()) gave a verdict
//     (fixtures/empty-body-fuzz.json, made by fixtures/gen_empty_body_fuzz.py: the Python test regenerates it and compares).
// `it.fails` = open today, red the day it is fixed. No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import fuzz from "./fixtures/empty-body-fuzz.json";
import { extractSkillDraft } from "@/lib/skillDraft";

const HEADER = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório semanal ao cliente.\n---";
const fence = (body: string, ticks = "```") => `${ticks}luve-skill\n${body}\n${ticks}`;
const r = (text: string) => extractSkillDraft(text) as { ok: boolean; why?: string; details?: any; draft?: any };
const cp = (...n: number[]) => String.fromCodePoint(...n);
const draft = (closing: string, body = "1. Abra o CRM.") => fence(`---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório.\n${closing}\n${body}`);

describe("the closing line of the header", () => {
  it("`---` followed by spaces or tabs closes it, whatever the mix (Hermes's `\\s*` and the server's `[ \\t]*` both do)", () => {
    for (const tail of ["", " ", "  ", "\t", " \t", "\t ", " \t \t  "]) expect(r(draft("---" + tail)).ok, JSON.stringify(tail)).toBe(true);
  });

  it("a CR, CRLF or LF ending is the same line end after the normalization, so `---\\r` closes it too", () => {
    expect(r(draft("---").replace(/\n/g, "\r\n")).ok).toBe(true);
    expect(r(draft("---").replace(/\n/g, "\r")).ok).toBe(true);
  });

  it("what is not a closing line: indented, four dashes, text after it, an em dash, a space inside, the dashes of another script", () => {
    for (const closing of [" ---", "  ---", "\t---", "----", "-----", "---x", "--- x", "-- -", "--", "-", "—-", cp(0x2014, 0x2014, 0x2014), cp(0x2212, 0x2212, 0x2212), cp(0xff0d, 0xff0d, 0xff0d), "***", "___", "...", "=="]) {
      const out = r(draft(closing));
      expect(out.ok, JSON.stringify(closing)).toBe(false);
      expect(out.why, JSON.stringify(closing)).toBe("no_frontmatter");
    }
  });

  it("`---` followed by a no-break, ideographic or other Unicode space is NOT a closing line here: stricter than Hermes (its `\\s*` takes them), never more lenient, so the sheet never opens on a header the server reads differently", () => {
    for (const space of [0xa0, 0x1680, 0x2000, 0x2003, 0x200a, 0x202f, 0x205f, 0x3000]) {
      const out = r(draft("---" + cp(space)));
      expect(out.ok, "U+" + space.toString(16)).toBe(false);
      expect(out.why).toBe("no_frontmatter");
    }
  });

  it("with such a line AND a real closing line after it, the first real one wins here, and the header then holds the odd line: the server's YAML refuses it (a second document), so nothing reaches Hermes", () => {
    const out = r(fence(`---\nname: enviar-relatorio\ndescription: Use x.\n---${cp(0xa0)}\nname: outro\n---\n1. a`));
    expect(out.ok).toBe(true);
    expect(out.draft.content).toContain("name: outro");                                  // the extractor does not read YAML: the server is the one that says bad_yaml
  });

  it("the opening line is exactly `---`: a trailing space, a tab or any text makes it another line", () => {
    for (const open of ["--- ", "---\t", "----", "---x", "--- x", "---a: b", " ---", "—-"]) {
      const out = r(fence(`${open}\nname: enviar-relatorio\ndescription: Use x.\n---\n1. a`));
      expect(out.ok, JSON.stringify(open)).toBe(false);
      expect(out.why).toBe("no_frontmatter");
    }
  });

  it("the header may close after blank lines, and the first `---` after the opening is the one (a rule in the body does not matter: it is after it)", () => {
    expect(r(fence("---\nname: a\ndescription: Use x.\n\n   \n---\n1. a\n---\n2. b")).ok).toBe(true);
    expect(r(fence("---\nname: a\ndescription: Use x.\n---\n---\n---\n")).ok).toBe(true);              // a body that is a rule is something to read
  });

  it("a closing line inside a code block of the skill is still a closing line: the extractor reads lines, like Hermes (no Markdown in either)", () => {
    const text = "````luve-skill\n---\nname: a\ndescription: Use x.\n```\n---\n```\n1. passo\n````";
    expect(r(text).ok).toBe(true);
  });

  it("an opening with no closing, a closing with nothing after it, and a header that is the whole draft are refused with the right word", () => {
    expect(r(fence("---\nname: a\ndescription: Use x.")).why).toBe("no_frontmatter");
    expect(r(fence("---\nname: a\ndescription: Use x.\n---")).why).toBe("empty_body");
    expect(r(fence("---\nname: a\ndescription: Use x.\n---\n \n\t\n")).why).toBe("empty_body");
    expect(r(fence("---")).why).toBe("no_frontmatter");
  });
});

describe("what needs no YAML and the extractor still accepts", () => {
  it("a header with NOTHING in it (blank lines only) is no_frontmatter: the server's YAML reads it as null, which is not a mapping", () => {
    for (const header of ["---\n---", "---\n\n---", "---\n \n\t\n---", "---\n   ---"]) {
      expect(r(fence(`${header}\n1. a`)).ok, JSON.stringify(header)).toBe(false);
    }
  });

  it("a header longer than the 4000 characters Hermes's lister reads is header_too_long (3.4, SK-1h): Hermes would not see its name, and the server refuses it the same way", () => {
    const long = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório.\n" + Array.from({ length: 120 }, (_, i) => `chave${i}: ${"v".repeat(30)}`).join("\n") + "\n---\n1. a";
    expect(long.indexOf("\n---\n", 3)).toBeGreaterThan(4000);
    const out = r(fence(long));
    expect(out).toEqual({ ok: false, why: "header_too_long" });
  });

  it("a header just under that, and one comfortably inside it, are accepted", () => {
    const sized = (n: number) => "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório.\n" + `nota: ${"x".repeat(n)}` + "\n---\n1. a";
    expect(r(fence(sized(1000))).ok).toBe(true);
    expect(r(fence(sized(3500))).ok).toBe(true);
  });
});

describe("the two classifiers agree on whitespace and on the body (Prumo: a fuzz between `\\s` and `.strip()`)", () => {
  // ECMAScript's WhiteSpace and LineTerminator (the spec, not this engine): what `\s` and `trim()` take out.
  const SPEC_WHITESPACE = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];

  it("this engine's `\\s` is the spec's list over every code point (an engine that drifts is seen here, the Python side holds the same list to str.isspace())", () => {
    const found: number[] = [];
    for (let c = 0; c <= 0x10ffff; c++) if ((c < 0xd800 || c > 0xdfff) && /\s/.test(String.fromCodePoint(c))) found.push(c);
    expect(found).toEqual(SPEC_WHITESPACE);
  });

  it(`the extractor gives every one of the ${fuzz.cases.length} bodies the verdict the server's classifier gave: ok with the count and the places of the marked characters, hidden_characters with where, too_many_invisible with how many, empty_body`, () => {
    const wrong: string[] = [];
    for (const c of fuzz.cases as any[]) {
      const out = r(fence(`${fuzz.header}\n${c.body}`));
      const e = c.expect;
      const got = out.ok
        ? { ok: true, hidden: out.draft.hidden, marks: out.draft.marks.map((m: any) => [m.codePoint, m.line, m.column]) }
        : out.details === undefined ? { ok: false, why: out.why } : { ok: false, why: out.why, details: out.details };
      if (JSON.stringify(got) !== JSON.stringify(e)) wrong.push(JSON.stringify(c.body) + " -> " + JSON.stringify(got) + " (the server: " + JSON.stringify(e) + ")");
    }
    expect(wrong.slice(0, 5), `${wrong.length} bodies differ`).toEqual([]);
  });

  it("the corpus holds all four verdicts and every kind of character it is meant to exercise (a fixture that says one word proves nothing)", () => {
    const words = new Set((fuzz.cases as any[]).map((c) => (c.expect.ok ? "ok" : c.expect.why)));
    expect([...words].sort()).toEqual(["empty_body", "hidden_characters", "ok", "too_many_invisible"]);
    const all = (fuzz.cases as any[]).map((c) => c.body).join("");
    for (const c of [0x0b, 0x85, 0xa0, 0x200b, 0x2028, 0x2800, 0x3000, 0xfeff, 0xfe0f, 0x1f600, 0xe0041]) expect(all.includes(cp(c)), "U+" + c.toString(16)).toBe(true);
  });
});
