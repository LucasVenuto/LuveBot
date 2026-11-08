// tests/unit/redteam/clarify-hint-redteam.test.ts (Lume, K-4, 30/10): K-3 attacked (contract v0.11 4.1: the screen removes Hermes's sentence `Reply "skip" to skip this question.` from the question it SHOWS,
// only where the answer is given in LuveBot, only when it is EXACTLY the last line and appears EXACTLY ONCE, and nothing else is trimmed).
//   * `displayQuestion`: the sentence once and last, with every line break; twice, in the middle, with a look-alike, a reworded one, one after a break the function does not know (U+2028, NEL); a text that
//     would be left empty or only invisible; the identity of the string when nothing is removed; idempotence; a megabyte;
//   * `waitView`: the wait in Today shows the sentence unless the answer is in LuveBot (platform `api_server` or none): Telegram, the terminal, a channel, a look-alike platform name keep it;
//   * what is NOT done here and is pinned: no "Skip" button sends the word (the contract's 4.1): this file holds none.
// `it.fails` = open today, red the day it is fixed (F-K1 and F-K2 are fixed: plain `it`). No invisible character is written in this file: every one is built from its code point.
import { describe, it, expect } from "vitest";
import { displayQuestion } from "@/lib/clarifyText";
import { waitView } from "@/components/home/waiting";

const HINT = 'Reply "skip" to skip this question.';
const cp = (...n: number[]) => String.fromCodePoint(...n);
const t = (k: string) => k;

describe("the sentence once and last is removed, and only it", () => {
  it("with any line break before it: LF, CRLF, CR, a blank line, several blank lines", () => {
    expect(displayQuestion(`Quer continuar?\n${HINT}`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\r\n${HINT}`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\r${HINT}`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\n\n${HINT}`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\n\n\n\n${HINT}`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\r\n\r\n${HINT}`)).toBe("Quer continuar?");
  });

  it("one final line break ends the last line and is not a line of its own; two are not that", () => {
    expect(displayQuestion(`Quer continuar?\n${HINT}\n`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\n${HINT}\r\n`)).toBe("Quer continuar?");
    expect(displayQuestion(`Quer continuar?\n${HINT}\n\n`)).toBe(`Quer continuar?\n${HINT}\n\n`);          // the last line is empty: the sentence is not last
  });

  it("nothing else is trimmed: leading blank lines, indentation, trailing spaces and the lines before it stay as the Bot wrote them", () => {
    expect(displayQuestion(`\n\n  Quer continuar?  \n  Escolha com cuidado.\t\n${HINT}`)).toBe("\n\n  Quer continuar?  \n  Escolha com cuidado.\t");
    expect(displayQuestion(`1) a\n2) b\n\n${HINT}`)).toBe("1) a\n2) b");
  });

  it("a text with mixed line breaks comes out with LF between its lines (the only place the text is rewritten); a text that is left alone is the SAME string", () => {
    expect(displayQuestion(`A\r\nB\rC\n${HINT}`)).toBe("A\nB\nC");
    for (const same of ["sem frase", `${HINT}`, `${HINT}\n${HINT}`, `${HINT} `, `Q\n${HINT} `, `Q\n${HINT}\nmais`]) {
      const out = displayQuestion(same);
      expect(out).toBe(same);
    }
  });

  it("the sentence as a SUBSTRING of a line is not a line: a question that quotes it in the middle of a sentence keeps the quote and still loses the real last line", () => {
    expect(displayQuestion(`O Bot disse: ${HINT} Concorda?\n${HINT}`)).toBe(`O Bot disse: ${HINT} Concorda?`);
  });
});

describe("what must be left as it is (the screen cannot tell whose words they are)", () => {
  it("twice, in any arrangement: the Bot may have written one", () => {
    for (const text of [`Q\n${HINT}\n${HINT}`, `Q\n${HINT}\n\n${HINT}`, `${HINT}\nQ\n${HINT}`, `${HINT}\n${HINT}`, `Q\n${HINT}\nQ2\n${HINT}\n`, `${HINT}\r\n${HINT}\r\n`]) expect(displayQuestion(text), JSON.stringify(text)).toBe(text);
  });

  it("once but not last: first, in the middle, or followed by anything, even a blank-looking line", () => {
    for (const text of [`${HINT}\nQ`, `Q\n${HINT}\nmais`, `Q\n${HINT}\n.`, `Q\n${HINT}\n\n\n.`, `Q\n${HINT}\n${cp(0xa0)}`]) expect(displayQuestion(text), JSON.stringify(text)).toBe(text);
  });

  it("a text that would be left empty is shown as it is: only the sentence, or the sentence after blank lines", () => {
    for (const text of [HINT, `${HINT}\n`, `\n${HINT}`, `\n\n\n${HINT}`, `   \n${HINT}`, `\t\n \n${HINT}`, `${cp(0xa0)}\n${HINT}`, `${cp(0x3000)}\n${HINT}`]) expect(displayQuestion(text), JSON.stringify(text)).toBe(text);
  });

  it("a look-alike is not the sentence: another quote, a Cyrillic or fullwidth letter, a no-break space, a zero-width character inside, another case, another full stop, extra spaces", () => {
    const variants = [
      'Reply “skip” to skip this question.', 'Reply "skip" to skip this question', 'Reply "skip" to skip this question!', 'reply "skip" to skip this question.', 'REPLY "SKIP" TO SKIP THIS QUESTION.',
      'Reply  "skip" to skip this question.', 'Reply "skip" to  skip this question.', ' Reply "skip" to skip this question.', 'Reply "skip" to skip this question.' + cp(0xa0),
      'R' + cp(0x435) + 'ply "skip" to skip this question.', 'Reply "skip" t' + cp(0x43e) + ' skip this question.', 'Reply "s' + cp(0x43a) + 'ip" to skip this question.',
      cp(0xff32) + 'eply "skip" to skip this question.', 'Reply "skip"' + cp(0xa0) + 'to skip this question.', 'Reply "sk' + cp(0x200b) + 'ip" to skip this question.',
      'Reply "skip" to skip this question.' + cp(0x200b), 'Reply \'skip\' to skip this question.', 'Reply "skip" to skip this question․', 'Reply `skip` to skip this question.',
    ];
    for (const v of variants) expect(displayQuestion(`Q\n${v}`), JSON.stringify(v)).toBe(`Q\n${v}`);
  });

  it("a reworded sentence, as a newer Hermes might send it, is shown as it is (the contract: if Hermes rewords it, the line is shown as it is)", () => {
    for (const v of ['Reply "skip" to skip.', 'Type skip to skip this question.', 'Reply "skip" to skip this question. (optional)', 'Reply "skip" to skip this question.\nThanks.']) expect(displayQuestion(`Q\n${v}`)).toBe(`Q\n${v}`);
  });

  it("a break the function does not know (LS, PS, NEL, VT, FF) before the sentence does not make it the last LINE: nothing is removed and nothing is rewritten", () => {
    for (const brk of [cp(0x2028), cp(0x2029), cp(0x85), cp(0x0b), cp(0x0c)]) {
      const text = `Q${brk}${HINT}`;
      expect(displayQuestion(text), "U+" + brk.codePointAt(0)!.toString(16)).toBe(text);
    }
  });

  it("a hostile question that ENDS with an imitation of the sentence (homoglyphs) keeps the imitation when the real one after it is removed: the screen never promises more than Hermes did, it shows what the Bot wrote", () => {
    const fake = 'R' + cp(0x435) + 'ply "skip" to skip this question.';
    expect(displayQuestion(`Escolha:\n${fake}\n${HINT}`)).toBe(`Escolha:\n${fake}`);
  });
});

describe("what the function must not do to a text that is not a normal one", () => {
  it("the question that is only invisible characters (zero-width, Hangul filler, braille blank) plus the sentence is not left looking empty: the sentence stays, as for any text that would be left empty", () => {
    for (const ch of [cp(0x200b), cp(0x3164), cp(0x2800), cp(0x2060), cp(0xfeff)]) {
      const text = `${ch.repeat(3)}\n${HINT}`;
      expect(displayQuestion(text), "U+" + ch.codePointAt(0)!.toString(16)).toBe(text);
    }
  });

  it("a line of spaces between the question and the sentence is a blank line and goes with it (the contract: the blank lines that separated the sentence go with it); today `Q?\\n ` is left", () => {
    expect(displayQuestion(`Q?\n \n${HINT}`)).toBe("Q?");
    expect(displayQuestion(`Q?\n\t\n  \n${HINT}`)).toBe("Q?");
  });

  it("is idempotent and total: any text, once through, is a fixed point; the strings of an engine's own surprises (lone surrogates, NUL, very long lines) do not throw", () => {
    const texts = ["", "\n", "\r\n", HINT, `Q\n${HINT}`, `Q\n${HINT}\n${HINT}`, "\ud83d", `a\ud83d\n${HINT}`, "\u0000", `x\u0000\n${HINT}`, "x".repeat(200_000), `${"x".repeat(100_000)}\n${HINT}`, `${cp(0x1f600)}\n${HINT}`];
    for (const text of texts) {
      const once = displayQuestion(text);
      expect(displayQuestion(once), JSON.stringify(text.slice(0, 20))).toBe(once);
    }
  });

  it("a megabyte of lines is read in well under a second (a hostile Bot sends 2,000 characters at most, but the function is the last line of defence of the card)", () => {
    const text = `${"linha\n".repeat(200_000)}${HINT}`;
    const start = performance.now();
    const out = displayQuestion(text);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out.endsWith("linha")).toBe(true);
  });
});

describe("where it is applied: only where the answer is given in LuveBot", () => {
  const wait = (over: Record<string, unknown>) => ({ kind: "clarify", platform: "api_server", prompt: `Quer continuar?\n${HINT}`, request_id: "r1", session_id: "s1", since: 1, ...over }) as any;

  it("platform `api_server` or none: the question card of LuveBot shows the question without the sentence", () => {
    expect(waitView(wait({}), t as any).title).toBe("Quer continuar?");
    expect(waitView(wait({ platform: null }), t as any).title).toBe("Quer continuar?");
    expect(waitView(wait({}), t as any).inLuveBot).toBe(true);
  });

  it("Telegram, the terminal, a channel, an unknown platform: the text stays as Hermes sent it, because there `skip` is recognised and the sentence is true", () => {
    for (const platform of ["telegram", "cli", "discord", "slack", "whatsapp", "email", "webhook", "cron", "desktop"]) {
      const view = waitView(wait({ platform }), t as any);
      expect(view.title, platform).toBe(`Quer continuar?\n${HINT}`);
      expect(view.inLuveBot, platform).toBe(false);
    }
  });

  it("a platform name that merely looks like api_server is NOT it (case, spaces, a separator, a twin letter, the empty string, a missing field): the sentence stays", () => {
    for (const platform of ["API_SERVER", "Api_Server", "api_server ", " api_server", "api-server", "apiserver", "api_server\n", "api_s" + cp(0x435) + "rver", "", undefined, 0, false]) {
      const view = waitView(wait({ platform }), t as any);
      expect(view.inLuveBot, JSON.stringify(platform)).toBe(false);
      expect(view.title, JSON.stringify(platform)).toContain(HINT);
    }
  });

  it("another kind of wait is never touched: an approval, a sudo password or an unknown kind with the sentence in its text keeps the title the table gives it, and a clarify with no prompt has its default title", () => {
    for (const kind of ["approval", "sudo", "other", "clarifyx"]) expect(waitView(wait({ kind }), t as any).title).not.toContain(HINT);
    expect(waitView(wait({ prompt: "" }), t as any).title).toBe("waitClarify");
    expect(waitView(wait({ prompt: null }), t as any).title).toBe("waitClarify");
  });

  it("a wait whose question is only the sentence shows it (nothing is left to show otherwise)", () => {
    expect(waitView(wait({ prompt: HINT }), t as any).title).toBe(HINT);
  });
});
