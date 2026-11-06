// tests/unit/chat/clarify-text.test.ts (contract v0.11 §4.1)
// Hermes appends the sentence `Reply "skip" to skip this question.` to every clarify question. On the run surface nothing interprets it (the word would reach the Bot as an ordinary answer, and on a question
// with choices LuveBot refuses it), so the screen does not show it: ONE exact line, the LAST one, and only when it appears nowhere else. A whole-line equality, never "contains".
import { describe, it, expect } from "vitest";
import { displayQuestion } from "@/lib/clarifyText";

const HINT = 'Reply "skip" to skip this question.';
const cp = (...n: number[]) => String.fromCodePoint(...n);

describe("the skip sentence Hermes appends is taken out of what is shown", () => {
  it("the exact last line goes, with the blank line before it: the question is what the Bot asked", () => {
    expect(displayQuestion(`Qual cliente?\n\n${HINT}`)).toBe("Qual cliente?");
    expect(displayQuestion(`Qual cliente?\n${HINT}`)).toBe("Qual cliente?");
    expect(displayQuestion(`Qual cliente?\n\n\n${HINT}`)).toBe("Qual cliente?");
  });

  it("a question of several lines keeps its own lines and blank lines exactly", () => {
    expect(displayQuestion(`Linha 1\n\nLinha 2\n  recuada\n\n${HINT}`)).toBe("Linha 1\n\nLinha 2\n  recuada");
  });

  it("one final line break ends the last line (it is not a line of its own); the CR and CRLF forms read the same", () => {
    expect(displayQuestion(`Qual?\n\n${HINT}\n`)).toBe("Qual?");
    expect(displayQuestion(`Qual?\r\n\r\n${HINT}`)).toBe("Qual?");
    expect(displayQuestion(`Qual?\r\n\r\n${HINT}\r\n`)).toBe("Qual?");
    expect(displayQuestion(`Qual?\r\r${HINT}`)).toBe("Qual?");
  });

  it("absent: the very same text comes back", () => {
    for (const q of ["Qual cliente?", "", "Qual <b>cliente</b>?\n\nEscolha uma.", "skip"]) expect(displayQuestion(q)).toBe(q);
  });

  it("reworded or not exact: shown as it is (we do not take out a sentence that is not Hermes's)", () => {
    for (const reworded of [
      'Reply "skip" to skip this question', 'Reply "skip" to skip.', 'Reply skip to skip this question.', 'reply "skip" to skip this question.', 'REPLY "SKIP" TO SKIP THIS QUESTION.',
      `Reply 'skip' to skip this question.`, ` ${HINT}`, `${HINT} `, `${HINT}\t`, `- ${HINT}`, `${HINT} Obrigado.`, `Reply  "skip" to skip this question.`,
    ]) {
      const q = `Qual cliente?\n\n${reworded}`;
      expect(displayQuestion(q), JSON.stringify(reworded)).toBe(q);
    }
  });

  it("a look-alike (another script's letters, curly quotes, a zero-width character inside) is not the sentence", () => {
    const lookalikes = [
      HINT.replace("e", cp(0x0435)),                       // Cyrillic е
      HINT.replace('"', cp(0x201c)).replace('"', cp(0x201d)),
      HINT.replace("skip", "ski" + cp(0x200b) + "p"),
      HINT.replace(" ", cp(0xa0)),
    ];
    for (const l of lookalikes) { const q = `Qual?\n\n${l}`; expect(displayQuestion(q), JSON.stringify(l)).toBe(q); }
  });

  it("in the MIDDLE of the text, or inside a longer line, it is left alone (never 'contains')", () => {
    const middle = `Antes\n${HINT}\nDepois`;
    expect(displayQuestion(middle)).toBe(middle);
    const inline = `Diga: ${HINT} agora`;
    expect(displayQuestion(inline)).toBe(inline);
    const quoted = `Ele escreveu "${HINT}" e saiu.\n\nQual cliente?`;
    expect(displayQuestion(quoted)).toBe(quoted);
  });

  it("TWICE: nothing is taken out, not even the last one (a Bot that writes the sentence itself is not Hermes appending it)", () => {
    for (const twice of [`${HINT}\n\nQual?\n\n${HINT}`, `Qual?\n${HINT}\n${HINT}`, `Qual?\n\n${HINT}\n\n${HINT}\n`]) expect(displayQuestion(twice), JSON.stringify(twice)).toBe(twice);
  });

  it("a question that is only the sentence, or nothing but blank lines and the sentence, is left as it is (an empty question would be worse)", () => {
    for (const only of [HINT, `\n${HINT}`, `\n\n${HINT}`, `   \n${HINT}`, `${HINT}\n`]) expect(displayQuestion(only), JSON.stringify(only)).toBe(only);
  });

  it("blank lines that separated the sentence go with it, whatever blank means: empty, spaces, tabs, a no-break space (F-K2)", () => {
    for (const gap of ["\n \n", "\n\t\n  \n", "\n   \n\n", "\n" + cp(0xa0) + "\n", "\r\n \r\n"]) expect(displayQuestion(`Q?${gap}${HINT}`), JSON.stringify(gap)).toBe("Q?");
    expect(displayQuestion(`Q?  \n\n${HINT}`)).toBe("Q?  ");                          // only WHOLE blank lines go: the question's own last line is not trimmed
    expect(displayQuestion(`  Q?\n\n${HINT}`)).toBe("  Q?");
  });

  it("a question that shows nothing a reader can see (only invisible characters: zero-width, Hangul filler, braille blank, word joiner, BOM, or a Tag) keeps the sentence: it is not left looking empty (F-K1)", () => {
    for (const ch of [cp(0x200b), cp(0x3164), cp(0x2800), cp(0x2060), cp(0xfeff), cp(0xe0041), cp(0x202e), cp(0x0007)]) {
      const q = `${ch.repeat(3)}\n${HINT}`;
      expect(displayQuestion(q), "U+" + ch.codePointAt(0)!.toString(16)).toBe(q);
    }
    expect(displayQuestion(`${cp(0x200b)} \t${cp(0x3164)}\n\n${HINT}`)).toBe(`${cp(0x200b)} \t${cp(0x3164)}\n\n${HINT}`);
  });

  it("the emoji presentation selectors alone draw nothing: a question of only U+FE0E and U+FE0F (with or without blanks) keeps the sentence; next to an emoji or a letter they are part of a question", () => {
    for (const sel of [cp(0xfe0f), cp(0xfe0e), cp(0xfe0f, 0xfe0e)]) {
      for (const q of [`${sel.repeat(3)}\n${HINT}`, `${sel} \t${sel}\n\n${HINT}`]) expect(displayQuestion(q), JSON.stringify(q)).toBe(q);
    }
    expect(displayQuestion(`${cp(0x2764, 0xfe0f)}\n\n${HINT}`)).toBe(cp(0x2764, 0xfe0f));         // a heart with its selector is a question
    expect(displayQuestion(`a${cp(0xfe0f)}\n\n${HINT}`)).toBe(`a${cp(0xfe0f)}`);
  });

  it("a question with ONE visible character among invisible ones is a question: the sentence goes", () => {
    expect(displayQuestion(`${cp(0x200b)}?${cp(0x200b)}\n\n${HINT}`)).toBe(`${cp(0x200b)}?${cp(0x200b)}`);
  });

  it("two final line breaks leave an empty last line, so the sentence is not the LAST line: shown as it is", () => {
    const q = `Qual?\n\n${HINT}\n\n`;
    expect(displayQuestion(q)).toBe(q);
  });

  it("it only ever REMOVES: what comes back is the original or a prefix of it, trimmed at the end", () => {
    for (const q of [`A\n\n${HINT}`, `A\nB\n${HINT}\n`, "plain", `x ${HINT}`]) {
      const out = displayQuestion(q);
      expect(q.startsWith(out) || out === q).toBe(true);
    }
  });
});
