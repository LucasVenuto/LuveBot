// tests/unit/transcript/skill-draft.test.ts (contract v0.11 §3.2, slice SK-1)
// The `luve-skill` fence a Bot answers a "Save as a skill" request with. A skill is instructions the Bot follows LATER, so the extractor is STRICT AND ALL-OR-NOTHING: anything else is "no draft" and the
// answer stays ordinary text. Pure (no Hermes, no backend). What it returns is exactly what the Bot wrote, so the review can show ALL of it.
import { describe, it, expect } from "vitest";
import { extractSkillDraft, SKILL_MAX_BYTES, type SkillDraftResult } from "@/lib/skillDraft";

const HEADER = "---\nname: enviar-relatorio\ndescription: Use quando precisar enviar o relatório semanal ao cliente.\n---";
const STEPS = "1. Abra o CRM.\n2. Exporte o CSV.\n3. Envie ao cliente.";
const SKILL = `${HEADER}\n${STEPS}`;
const fence = (body: string, info = "luve-skill", ticks = "```") => `${ticks}${info}\n${body}\n${ticks}`;
const draft = (text: string) => { const r = extractSkillDraft(text); return r.ok ? r.draft : null; };
const why = (text: string) => { const r = extractSkillDraft(text); return r.ok ? "ok" : r.why; };
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("a valid draft", () => {
  it("one closed fence whose body starts with the --- header: the draft is EXACTLY what the Bot wrote between the fences", () => {
    const r = extractSkillDraft(`Aqui está o rascunho.\n\n${fence(SKILL)}\n\nQuer ajustar algo?`) as Extract<SkillDraftResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.draft.content).toBe(SKILL);
    expect(r.draft.bytes).toBe(bytes(SKILL));
    expect(r.draft.hidden).toBe(0);
  });

  it("blank lines inside the skill are kept as they were, and no final newline is added", () => {
    const body = `${HEADER}\n\n## Passos\n\n${STEPS}\n\n\nFim.`;
    expect(draft(fence(body))!.content).toBe(body);
  });

  it("the edges are kept too: a trailing blank line and trailing spaces are part of what the Bot wrote (nothing is trimmed)", () => {
    const body = `${SKILL}  \n\n`;
    expect(draft(fence(body))!.content).toBe(body);
    expect(draft(fence(body))!.bytes).toBe(bytes(body));
  });

  it("a skill that holds code fences of its own is written in a LONGER fence: the shorter ``` lines are content", () => {
    const body = `${HEADER}\n1. Rode:\n\`\`\`sh\nls -la\n\`\`\`\n2. Pronto.`;
    const r = draft(fence(body, "luve-skill", "````"))!;
    expect(r.content).toBe(body);
    expect(r.content).toContain("```sh");
  });

  it("closed by a fence at least as long as the opening one: equal or longer closes it", () => {
    expect(draft("```luve-skill\n" + SKILL + "\n```")!.content).toBe(SKILL);
    expect(draft("```luve-skill\n" + SKILL + "\n`````")!.content).toBe(SKILL);
    expect(draft("````luve-skill\n" + SKILL + "\n````")!.content).toBe(SKILL);
  });

  it("the info string may have spaces around it; CRLF is a line break and comes out as \\n", () => {
    expect(draft("```luve-skill  \n" + SKILL + "\n```")!.content).toBe(SKILL);
    expect(draft(fence(SKILL).replace(/\n/g, "\r\n"))!.content).toBe(SKILL);
  });

  it("up to 3 spaces of indentation on the fence lines is still a fence; the body is not touched", () => {
    expect(draft(["   ```luve-skill", SKILL, "   ```"].join("\n"))!.content).toBe(SKILL);
  });

  it("the size is counted in BYTES: exactly 32 KiB is accepted, one byte more is no draft", () => {
    const pad = (n: number, c = "a") => c.repeat(n);
    const exact = HEADER + "\n" + pad(SKILL_MAX_BYTES - bytes(HEADER + "\n"));
    expect(bytes(exact)).toBe(SKILL_MAX_BYTES);
    expect(draft(fence(exact))!.bytes).toBe(SKILL_MAX_BYTES);
    expect(why(fence(exact + "a"))).toBe("too_large");
    const multi = HEADER + "\n" + pad((SKILL_MAX_BYTES - bytes(HEADER + "\n")) / 2 + 1, "é");   // 2 bytes each: over the cap with fewer characters
    expect(multi.length).toBeLessThan(SKILL_MAX_BYTES);
    expect(why(fence(multi))).toBe("too_large");
  });

  it("a long message around the fence is fine: only the draft is measured", () => {
    const talk = "palavra ".repeat(20_000);
    expect(draft(`${talk}\n\n${fence(SKILL)}\n\n${talk}`)!.content).toBe(SKILL);
  });
});

describe("one fence, closed: anything else is no draft", () => {
  it("two fences, in any order and spacing: NONE is a draft", () => {
    expect(why(`${fence(SKILL)}\n\n${fence(SKILL)}`)).toBe("two_fences");
    expect(why(`${fence(SKILL)}\ntexto\n${fence(`${HEADER}\nOutra.`)}`)).toBe("two_fences");
    expect(why(`${fence(SKILL)}\n${fence(SKILL, "luve-skill", "````")}`)).toBe("two_fences");
  });

  it("one closed and one still open (streaming a second): two fences, no draft", () => {
    expect(why(`${fence(SKILL)}\n\n\`\`\`luve-skill\n${HEADER}`)).toBe("two_fences");
  });

  it("an UNCLOSED fence (the answer is still streaming, or was cut): no draft; the moment it closes: the draft", () => {
    const open = "Quase:\n\n```luve-skill\n" + SKILL;
    expect(why(open)).toBe("unclosed");
    expect(draft(open + "\n```")!.content).toBe(SKILL);
  });

  it("a closing fence SHORTER than the opening one does not close it", () => {
    expect(why("````luve-skill\n" + SKILL + "\n```")).toBe("unclosed");
    expect(why("`````luve-skill\n" + SKILL + "\n````")).toBe("unclosed");
  });

  it("a closing line with anything after the backticks, or another character, does not close it", () => {
    expect(why("```luve-skill\n" + SKILL + "\n``` fim")).toBe("unclosed");
    expect(why("```luve-skill\n" + SKILL + "\n~~~")).toBe("unclosed");
    expect(why("```luve-skill\n" + SKILL + "\n``")).toBe("unclosed");
  });

  it("the body must START with a --- line: a blank line, a title, text, or a different dash line is no draft", () => {
    for (const body of [`\n${SKILL}`, `# Skill\n${SKILL}`, `Aqui está:\n${SKILL}`, SKILL.replace(/^---/, "----"), SKILL.replace(/^---/, "--- "), SKILL.replace(/^---/, "—--"), `name: x\n${SKILL}`, "", "\n\n", STEPS])
      expect(why(fence(body)), JSON.stringify(body.slice(0, 20))).toBe("no_frontmatter");
  });

  it("an indented --- is not the start of a header either", () => {
    expect(why(fence(" " + SKILL))).toBe("no_frontmatter");
  });

  it("a TILDE fence is not a skill fence (the renderer draws only backtick fences as code), and it does not cancel a real one", () => {
    expect(why(fence(SKILL, "luve-skill", "~~~"))).toBe("none");
    expect(why(fence(SKILL, "luve-skill", "~~~~"))).toBe("none");
    expect(draft(`${fence(SKILL, "luve-skill", "~~~")}\n\n${fence(SKILL)}`)!.content).toBe(SKILL);
  });

  it("the info string is EXACTLY luve-skill: another word, an extra word, another case, an attribute, nothing", () => {
    for (const info of ["luve-skills", "luve-skill x", "Luve-Skill", "LUVE-SKILL", "skill", "luve", "luve-evidence", "", "luve-skill{.a}", "markdown luve-skill"]) expect(why(fence(SKILL, info)), info).toBe("none");
  });

  it("the case is part of the word even when the lowercase word is also in the text around it (the quick check cannot hide it)", () => {
    expect(why(`Peça o luve-skill assim:\n\n${fence(SKILL, "Luve-Skill")}`)).toBe("none");
    expect(why(`Peça o luve-skill assim:\n\n${fence(SKILL, "LUVE-SKILL")}`)).toBe("none");
    expect(draft(`Peça o luve-skill assim:\n\n${fence(SKILL)}`)!.content).toBe(SKILL);
  });

  it("the same fence quoted, in a list item, indented 4 spaces or inside any OTHER fence is just text", () => {
    expect(why(fence(SKILL).split("\n").map((l) => `> ${l}`).join("\n"))).toBe("none");
    expect(why(fence(SKILL).split("\n").map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`)).join("\n"))).toBe("none");
    expect(why(fence(SKILL).split("\n").map((l) => `    ${l}`).join("\n"))).toBe("none");
    expect(why(fence(fence(SKILL), "markdown", "````"))).toBe("none");                         // a four-backtick fence QUOTING an answer: code
    expect(why(fence(fence(SKILL), "text"))).toBe("none");
  });

  it("a quoted draft inside another fence does not count as a SECOND fence, and does not hide the real one after it", () => {
    const quote = fence(fence(SKILL), "markdown", "````");
    expect(draft(`${quote}\n\n${fence(SKILL)}`)!.content).toBe(SKILL);
  });

  it("an inline span that starts a line is not a fence, so it cannot swallow the real draft", () => {
    expect(draft(`\`\`\`luve-skill\`\`\` e mais\n\n${fence(SKILL)}`)!.content).toBe(SKILL);
  });

  it("a message without the word costs nothing and is no draft", () => {
    expect(why("Resposta comum com `código` e\n```js\nlet x = 1\n```")).toBe("none");
    expect(why("")).toBe("none");
  });

  it("when several rules are broken the first of the one order of 3.4 is said: none, two fences, unclosed, too large, then (in the table tests) hidden characters, too many, no header, a draft that looks empty", () => {
    expect(why(`${fence("sem cabecalho")}\n${fence("outro")}`)).toBe("two_fences");
    expect(why("```luve-skill\nsem cabecalho")).toBe("unclosed");
    expect(why(fence("sem cabecalho"))).toBe("no_frontmatter");
    expect(why(fence("x".repeat(SKILL_MAX_BYTES + 10)))).toBe("too_large");                                  // too large comes BEFORE the header check
    expect(why(fence(HEADER + "\n" + "x".repeat(SKILL_MAX_BYTES + 10)))).toBe("too_large");
  });
});

describe("what a reader cannot see (contract 3.4): refused, or marked and counted, never removed", () => {
  const cp = (...n: number[]) => String.fromCodePoint(...n);
  const body = (s: string) => fence(`${SKILL}\n4. Pronto${s}.`);

  it("a MARKED character (zero-width, joiner, isolate, filler...) is accepted, counted EXACTLY in `hidden`, and left in the text: nothing is stripped", () => {
    const sneaky = `${HEADER}\n1. Abra${cp(0x200b)} o CRM${cp(0x200d)}.\n2. Pronto${cp(0x3164)}${cp(0x2066)}.`;
    const r = draft(fence(sneaky))!;
    expect(r.content).toBe(sneaky);
    expect(r.hidden).toBe(4);
  });

  it("a REFUSED character makes the whole thing no draft (hidden_characters): the Tags block, a bidi override, a control, a separator", () => {
    for (const c of [0xe0041, 0x202e, 0x0007, 0x001b, 0x2028, 0x0085, 0xfdd0, 0xfffe]) expect(why(body(cp(c))), c.toString(16)).toBe("hidden_characters");
  });

  it("tabs, newlines, accents, symbols and emoji are not marked, and neither are the emoji presentation selectors FE0E and FE0F", () => {
    expect(draft(fence(`${HEADER}\n1.\tPasso com tabulação, acentuação: ção é ü — “aspas” → ✓ 🙂 ❤${cp(0xfe0f)} ✔${cp(0xfe0e)}`))!.hidden).toBe(0);
  });

  it("the Mark class is DERIVED from Default_Ignorable_Code_Point (+ U+2800, - FE0E/FE0F): the ones a hand list missed are marked too", () => {
    const missed = [0x034f, 0x17b4, 0x17b5, 0x180b, 0x180c, 0x180d, 0x180f, 0x206a, 0x206f, 0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0080, 0xe00ff, 0xe01f0, 0xe0fff, 0xfff0, 0xfff8, 0x2065, 0x2800];
    for (const c of missed) expect(draft(body(cp(c, c)))?.hidden, c.toString(16)).toBe(2);
  });

  it("every character the table names is MARKED, none refused", () => {
    const named = [0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2064, 0x00ad, 0x200e, 0x200f, 0x061c, 0x2066, 0x2069, 0xfeff, 0x115f, 0x1160, 0x3164, 0xffa0, 0x180e, 0xfe00, 0xfe0d];
    for (const c of named) expect(draft(body(cp(c)))?.hidden, c.toString(16)).toBe(1);
  });

  it("a ZWJ emoji sequence counts its joiners (they are marked characters)", () => {
    expect(draft(fence(`${HEADER}\n1. Família: 👨${cp(0x200d)}👩${cp(0x200d)}👧`))!.hidden).toBe(2);
  });

  it("exactly 50 marked characters are accepted, the 51st refuses the draft (too_many_invisible), wherever they sit, header included", () => {
    expect(draft(body(cp(0x200c).repeat(50)))!.hidden).toBe(50);
    expect(why(body(cp(0x200c).repeat(51)))).toBe("too_many_invisible");
    expect(why(fence(`---\nname: x${cp(0x200b).repeat(26)}\ndescription: Use x.${cp(0x200d).repeat(25)}\n---\n1. a`))).toBe("too_many_invisible");
  });

  it("a refused character wins over the count: 50 marked and one refused is hidden_characters", () => {
    expect(why(body(cp(0x200c).repeat(50) + cp(0xe0041)))).toBe("hidden_characters");
  });

  it("a lone surrogate is refused, a valid pair (an emoji) is not", () => {
    for (const bad of ["\ud800", "\udc00", "\ud800\ud800", "a\udbffb"]) expect(why(body(bad)), JSON.stringify(bad)).toBe("hidden_characters");
    expect(draft(body("😀"))!.hidden).toBe(0);
  });

  it("a body that is EMPTY after the header (nothing, blanks, or only marked characters) is empty_body: the extractor refuses what needs no YAML, and hidden_characters is for a text that HOLDS a refused character", () => {
    expect(why(fence(`${HEADER}\n${cp(0x200b).repeat(40)}`))).toBe("empty_body");                    // the server's word for the same text; hidden_characters is for a text that HOLDS a refused character
    expect(why(fence(`${HEADER}\n  ${cp(0x2800)}\n`))).toBe("empty_body");
    expect(why(fence(HEADER))).toBe("empty_body");                                            // the header and nothing else
    expect(why(fence(`${HEADER}\n\n  \n`))).toBe("empty_body");
  });

  it("the header and a key are inside the rule: a refused or marked character there counts like anywhere", () => {
    expect(why(fence(`---\nname: enviar${cp(0xe0041)}-relatorio\ndescription: Use x.\n---\n1. a`))).toBe("hidden_characters");
    expect(draft(fence(`---\ndescr${cp(0x200b)}iption: Use x.\nname: a\n---\n1. a`))!.hidden).toBe(1);
  });

  it("the info string and a closing fence are separated by spaces or tabs only: an NBSP, an ideographic space, a ZWSP or a BOM is another word", () => {
    for (const trail of [cp(0xa0), cp(0x3000), cp(0x200b), cp(0xfeff)]) {
      expect(why("```luve-skill" + trail + "\n" + SKILL + "\n```")).toBe("none");
      expect(why("```luve-skill\n" + SKILL + "\n```" + trail + "\n5. mais\n```")).not.toBe("two_fences");
    }
    expect(draft("```luve-skill \t \n" + SKILL + "\n```  \t")!.content).toBe(SKILL);
  });

  it("anything that is not a string is no draft, never an exception", () => {
    for (const bad of [null, undefined, 42, {}, [], { toString: () => "```luve-skill" }]) expect(extractSkillDraft(bad as any)).toEqual({ ok: false, why: "none" });
  });
});

describe("it never throws and holds up", () => {
  it("1 MiB of anything is fine and is no draft; a draft after a megabyte of text is still found", () => {
    const huge = "x".repeat(1024 * 1024);
    expect(why(huge)).toBe("none");
    expect(why(fence(huge))).toBe("too_large");
    expect(draft(`${huge}\n${fence(SKILL)}`)!.content).toBe(SKILL);
  });

  it("HTML and Markdown inside the skill are characters: nothing is stripped, escaped or interpreted", () => {
    const body = `${HEADER}\n1. <img src=x onerror="alert(1)"> **negrito** [link](javascript:alert(1)) \`código\` &amp;`;
    expect(draft(fence(body))!.content).toBe(body);
  });

  it("the draft carries only content, bytes, hidden and marks: no key a Bot could add", () => {
    expect(Object.keys(draft(fence(SKILL))!).sort()).toEqual(["bytes", "content", "hidden", "marks"]);
  });
});
