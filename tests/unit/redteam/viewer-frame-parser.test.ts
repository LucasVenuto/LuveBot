// tests/unit/redteam/viewer-frame-parser.test.ts
// Red team (Lume): the HTML viewer's neutralization by tag NAME checked against a real HTML parser (jsdom's parse5), over many spellings
// and parsing contexts. A regex that the parser can walk around would let a navigating/loading element reach the frame; the CSP and the
// sandbox are the other layers, this is the first one. Also pins the prefix: the page's own doctype (V3, fixed) still comes first, so the page opens in the mode its file would.
import { describe, it, expect } from "vitest";
import { frameText, FRAME_PREFIX } from "@/components/viewer/document";

const NAMES = ["meta", "link", "base", "iframe", "frame", "frameset", "object", "embed", "portal"];
const SPELL = (n: string) => [n, n.toUpperCase(), n[0].toUpperCase() + n.slice(1), n.replace(/[aeiou]/, (c) => c.toUpperCase())];
const GLUE = [" ", "\t", "\n", "\f", "\r", "/", ">", "\r\n", "  "];   // what ends a tag name for the parser, plus a few more
const WRAP: Array<(x: string) => string> = [
  (x) => x, (x) => `<head>${x}</head>`, (x) => `<body>${x}</body>`, (x) => `<table>${x}</table>`, (x) => `<table><tr>${x}</tr></table>`,
  (x) => `<svg>${x}</svg>`, (x) => `<math>${x}</math>`, (x) => `<noscript>${x}</noscript>`, (x) => `<template>${x}</template>`,
  (x) => `<select>${x}</select>`, (x) => `<p>${x}`, (x) => `<!-- --> ${x}`, (x) => `<div title=">">${x}</div>`, (x) => `<a href="x">${x}</a>`,
];
const HOSTILE_HEAD = ["", "<!DOCTYPE html>", "\ufeff", "<!--", "<![CDATA[", "<plaintext>", "<textarea>", "<title>", "<script>", "<style>"];
const names = (doc: Document) => [...doc.querySelectorAll("*")].map((e) => e.localName);
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("the neutralized page, parsed by a real HTML parser", () => {
  it("no navigating or loading element survives, whatever the spelling, the glue after the name or the context around it", () => {
    let cases = 0;
    for (const name of NAMES) for (const spelled of SPELL(name)) for (const glue of GLUE) for (const wrap of WRAP) {
      const page = wrap(`<${spelled}${glue}http-equiv=refresh content="0;url=https://x.invalid" href="https://x.invalid" src="https://x.invalid">`);
      const doc = parse(frameText(page));
      const found = names(doc).filter((n) => NAMES.includes(n));
      // only our two metas (the CSP and the referrer) may exist
      expect(found.filter((n) => n !== "meta"), `${spelled}|${JSON.stringify(glue)}|${wrap("")}`).toEqual([]);
      expect(doc.querySelectorAll("meta")).toHaveLength(2);
      cases += 1;
    }
    expect(cases).toBeGreaterThan(4000);
  }, 60_000);   // ~4,000 real parses: slow on a loaded machine (it took 13 s unmodified), so it must not depend on vitest's 5 s default

  it("the two metas are always the first things in <head>, even when the page opens with an unterminated comment, CDATA, plaintext, textarea, title, script or style", () => {
    for (const head of HOSTILE_HEAD) {
      const doc = parse(frameText(`${head}<meta http-equiv=refresh content="0;url=https://x.invalid"><p>x</p>`));
      const firstTwo = [...doc.head.children].slice(0, 2).map((e) => e.getAttribute("http-equiv") ?? e.getAttribute("name"));
      expect(firstTwo, JSON.stringify(head)).toEqual(["Content-Security-Policy", "referrer"]);
    }
  });

  it("the prefix is the first bytes of the text", () => {
    expect(frameText("<!DOCTYPE html><p>x")).toBe("<!DOCTYPE html>" + FRAME_PREFIX + "<p>x");   // V3: the doctype first, once, then the CSP
  });

  // A doctype AFTER the prefix is ignored by the parser, so every page that starts with <!DOCTYPE html> used to show in quirks mode (different
  // box model, line heights, table fonts) from how the Bot built it. Fixed: frameText puts that doctype first (docs/redteam V3).
  it("V3 (fixed): a page that opens with <!DOCTYPE html> is parsed in standards mode, as the Bot's own file; one without a doctype stays in quirks mode", () => {
    expect(parse(frameText("<!DOCTYPE html><html><body><p>x</p></body></html>")).compatMode).toBe("CSS1Compat");
    expect(parse(frameText("<html><body><p>x</p></body></html>")).compatMode).toBe("BackCompat");                          // none is made up
    expect(parse("<!DOCTYPE html><html><body><p>x</p></body></html>").compatMode).toBe("CSS1Compat");   // control: without the prefix it is standards mode
  });
});
