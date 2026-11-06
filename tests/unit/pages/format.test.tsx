// tests/unit/pages/format.test.tsx
// The page editor's toolbar and shortcuts (ADR-009 option C, D-029): they only INSERT Markdown the safe renderer understands, and the
// renderer is the judge here: every result is drawn by lib/render/markdown and must show what the button promised. Applying a format twice
// undoes it, an empty selection gets an empty pair, a request that would be drawn wrong changes nothing, and a code block is left alone.
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "@/lib/render/markdown";
import { applyFormat, shortcutOf, type FormatKind } from "@/components/pages/format";

afterEach(() => cleanup());

/** before + [selected] + after, formatted; the new text and the selected part of it. */
function run(kind: FormatKind, before: string, sel: string, after = "") {
  const value = before + sel + after;
  const e = applyFormat(kind, value, before.length, before.length + sel.length);
  return e && { ...e, selected: e.value.slice(e.start, e.end) };
}
const drawn = (text: string) => render(<Markdown text={text} />).container;

describe("negrito e itálico", () => {
  it("wrap a selection in the renderer's own markers, and the renderer draws them", () => {
    expect(run("bold", "uma ", "palavra", " só")!.value).toBe("uma **palavra** só");
    expect(drawn("uma **palavra** só").querySelector("strong")!.textContent).toBe("palavra");
    expect(run("italic", "uma ", "palavra")!.value).toBe("uma *palavra*");
    expect(drawn("uma *palavra*").querySelector("em")!.textContent).toBe("palavra");
  });

  it("keep the selection on the formatted text, so the same button undoes it", () => {
    for (const kind of ["bold", "italic"] as const) {
      const first = run(kind, "a ", "b c", " d")!;
      expect(first.selected).toBe(kind === "bold" ? "**b c**" : "*b c*");
      const back = applyFormat(kind, first.value, first.start, first.end)!;
      expect(back.value).toBe("a b c d");
      expect(back.value.slice(back.start, back.end)).toBe("b c");
    }
  });

  it("take the markers off when they are just around the selection", () => {
    expect(run("bold", "**", "x", "**")!.value).toBe("x");
    expect(run("italic", "*", "x", "*")!.value).toBe("x");
  });

  it("an empty selection gets an empty pair with the caret between", () => {
    const e = run("bold", "ab", "", "cd")!;
    expect(e.value).toBe("ab****cd");
    expect([e.start, e.end]).toEqual([4, 4]);
    expect(run("italic", "", "")!.value).toBe("**");
  });

  it("whitespace stays outside the markers, each line is wrapped on its own, blank lines are left", () => {
    expect(run("bold", "", " a b ")!.value).toBe(" **a b** ");
    const e = run("bold", "", "um\n\ndois")!;
    expect(e.value).toBe("**um**\n\n**dois**");
    expect(drawn(e.value).querySelectorAll("strong")).toHaveLength(2);
  });

  it("do nothing when the renderer would draw it wrong: a star in the text or next to the markers", () => {
    expect(run("bold", "", "a*b")).toBeNull();
    expect(run("italic", "", "a*b")).toBeNull();
    expect(run("italic", "**", "b", "**")).toBeNull();      // *b* inside **b** would be "***b***"
    expect(run("bold", "*", "b", "*")).toBeNull();
    expect(run("italic", "", "**b**")).toBeNull();
  });

  it("never reads a $ in the text as a replacement pattern", () => {
    expect(run("bold", "", "$& e $1")!.value).toBe("**$& e $1**");
  });
});

describe("código", () => {
  it("inline: one line without a backtick is `wrapped`, and undone by the same button", () => {
    const e = run("code", "use ", "npm test", " aqui")!;
    expect(e.value).toBe("use `npm test` aqui");
    expect(drawn(e.value).querySelector("code")!.textContent).toBe("npm test");
    expect(applyFormat("code", e.value, e.start, e.end)!.value).toBe("use npm test aqui");
    expect(run("code", "", "")!.value).toBe("``");
  });

  it("several lines, or a backtick in the text, make a fenced block the renderer draws as one", () => {
    const e = run("code", "antes\n", "a = 1\nb = 2", "\ndepois")!;
    expect(e.value).toBe("antes\n```\na = 1\nb = 2\n```\ndepois");
    expect(e.selected).toBe("a = 1\nb = 2");
    const c = drawn(e.value);
    expect(c.querySelector("pre code")!.textContent).toBe("a = 1\nb = 2");
    expect(run("code", "", "uma `x` aqui")!.value).toBe("```\numa `x` aqui\n```");
  });

  it("the same button takes a fence off when the selected lines are the fence", () => {
    const fenced = "```\na\nb\n```";
    expect(applyFormat("code", fenced, 0, fenced.length)!.value).toBe("a\nb");
  });

  it("no other format touches the inside of a code block, and a fence is never opened inside another", () => {
    const value = "```\ntexto\n```";
    for (const kind of ["bold", "italic", "list", "quote", "heading", "link"] as const) expect(applyFormat(kind, value, 4, 9), kind).toBeNull();
    expect(run("code", "```\n", "x\n```\ny", "")).toBeNull();
  });
});

describe("título, lista e citação", () => {
  it("a title goes ## → ### → none, starts from # at ##, and the renderer draws the levels it knows", () => {
    const t1 = applyFormat("heading", "Resumo", 3, 3)!;
    expect(t1.value).toBe("## Resumo");
    expect(drawn(t1.value).querySelector("h3")!.textContent).toBe("Resumo");
    const t2 = applyFormat("heading", t1.value, t1.start, t1.end)!;
    expect(t2.value).toBe("### Resumo");
    expect(drawn(t2.value).querySelector("h4")).not.toBeNull();
    expect(applyFormat("heading", t2.value, t2.start, t2.end)!.value).toBe("Resumo");
    expect(applyFormat("heading", "# Resumo", 0, 0)!.value).toBe("## Resumo");
    expect(applyFormat("heading", "#### x", 0, 0)!.value).toBe("## #### x");       // the renderer draws "####" as text: it is not a title
  });

  it("a title touches only the caret's line", () => {
    expect(applyFormat("heading", "a\nb\nc", 2, 2)!.value).toBe("a\n## b\nc");
    expect(applyFormat("heading", "a\nb\nc", 0, 5)!.value).toBe("## a\nb\nc");
  });

  it("a list prefixes every non-blank line of the selection with '- ', and the same button takes it off", () => {
    const e = run("list", "", "um\ndois\n\ntrês")!;
    expect(e.value).toBe("- um\n- dois\n\n- três");
    const c = drawn("- um\n- dois");
    expect(c.querySelectorAll("ul li")).toHaveLength(2);
    expect(applyFormat("list", e.value, e.start, e.end)!.value).toBe("um\ndois\n\ntrês");
  });

  it("a list works on whole lines even when the selection starts or ends inside them, and leaves the next line when it ends after a break", () => {
    expect(applyFormat("list", "um\ndois\ntrês", 5, 9)!.value).toBe("um\n- dois\n- três");
    expect(applyFormat("list", "um\ndois\ntrês", 0, 3)!.value).toBe("- um\ndois\ntrês");        // ends at the break: the next line is not taken
    expect(applyFormat("list", "um\ndois\ntrês", 0, 4)!.value).toBe("- um\n- dois\ntrês");        // one character into it: it is
  });

  it("a quote prefixes with '> ' and is drawn as a blockquote; toggling restores the text", () => {
    const e = run("quote", "", "frase um\nfrase dois")!;
    expect(e.value).toBe("> frase um\n> frase dois");
    expect(drawn(e.value).querySelector("blockquote")).not.toBeNull();
    expect(applyFormat("quote", e.value, e.start, e.end)!.value).toBe("frase um\nfrase dois");
  });

  it("a caret alone keeps its place in the text it was in", () => {
    expect(applyFormat("list", "abc", 2, 2)).toMatchObject({ value: "- abc", start: 4, end: 4 });
    expect(applyFormat("quote", "> abc", 4, 4)).toMatchObject({ value: "abc", start: 2, end: 2 });
  });
});

describe("link", () => {
  it("an empty selection makes [texto](https://) with the word selected; the localized word comes from the caller", () => {
    const e = applyFormat("link", "ver ", 4, 4, "text")!;
    expect(e.value).toBe("ver [text](https://)");
    expect(e.value.slice(e.start, e.end)).toBe("text");
  });

  it("a selected word becomes the text, with the address selected to be typed", () => {
    const e = run("link", "ver ", "o painel", " hoje")!;
    expect(e.value).toBe("ver [o painel](https://) hoje");
    expect(e.selected).toBe("https://");
  });

  it("a selected address becomes the target, and the renderer draws a link only for http, https and mailto", () => {
    const e = run("link", "", "https://example.com/p")!;
    expect(e.value).toBe("[texto](https://example.com/p)");
    expect(e.selected).toBe("texto");
    const a = drawn(e.value).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/p");
    expect(run("link", "", "mailto:a@b.co")!.value).toBe("[texto](mailto:a@b.co)");
    expect(drawn("[x](https://)").querySelector("a")).toBeNull();            // the template shows as text until the address is typed
  });

  it("a whole link selected goes back to its text; a text the renderer could not draw is refused", () => {
    expect(run("link", "", "[o painel](https://x.co)")!.value).toBe("o painel");
    expect(run("link", "", "a]b")).toBeNull();
    expect(run("link", "", "duas\nlinhas")).toBeNull();
  });
});

describe("os atalhos", () => {
  const key = (init: Partial<Parameters<typeof shortcutOf>[0]>) => shortcutOf({ key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
  it("Mod+B, I, E and Mod+Shift+K, 7 and . , with Cmd or Ctrl", () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      expect(key({ ...mod, key: "b" })).toBe("bold");
      expect(key({ ...mod, key: "I" })).toBe("italic");
      expect(key({ ...mod, key: "e" })).toBe("code");
      expect(key({ ...mod, shiftKey: true, code: "KeyK", key: "K" })).toBe("link");
      expect(key({ ...mod, shiftKey: true, code: "Digit7", key: "&" })).toBe("list");
      expect(key({ ...mod, shiftKey: true, code: "Period", key: ">" })).toBe("quote");
    }
  });
  it("Mod+K is not one: it stays the app's search, and a stray press never writes into the page", () => {
    expect(key({ metaKey: true, key: "k", code: "KeyK" })).toBeNull();
    expect(key({ ctrlKey: true, key: "K", code: "KeyK" })).toBeNull();
  });
  it("by the physical key on a layout where the letter is not Latin, never with Alt, never without Cmd or Ctrl", () => {
    expect(key({ ctrlKey: true, key: "и", code: "KeyB" })).toBe("bold");
    expect(key({ ctrlKey: true, altKey: true, key: "b" })).toBeNull();
    expect(key({ key: "b" })).toBeNull();
    expect(key({ ctrlKey: true, key: "z" })).toBeNull();
    expect(key({ ctrlKey: true, shiftKey: true, key: "b", code: "KeyB" })).toBeNull();
  });
});
