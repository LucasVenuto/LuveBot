// tests/unit/pages/eol.test.ts
// ADR-009 R1, "ida e volta byte a byte": a page goes into the editor and comes back with the SAME BYTES, whatever its line ending, so that
// opening and closing it never changes what the Bot reads, what the 21a diff shows or the `base_sha`. Compared as UTF-8 bytes, not as strings.
import { describe, it, expect } from "vitest";
import { eolOf, roundTrips, toDisk, toView } from "@/components/pages/eol";

const bytes = (s: string) => Buffer.from(s, "utf8").toString("hex");
const there = (s: string) => toDisk(toView(s), eolOf(s));

const PAGES: Record<string, string> = {
  "LF": "# Título\n\ntexto\n\n- a\n- b\n",
  "CRLF": "# Título\r\n\r\ntexto\r\n\r\n- a\r\n- b\r\n",
  "no final break": "# Título\n\ntexto",
  "no final break (CRLF)": "# Título\r\n\r\ntexto",
  "several final breaks": "texto\n\n\n",
  "several final breaks (CRLF)": "texto\r\n\r\n\r\n",
  "BOM": "\ufeff# Título\n",
  "BOM (CRLF)": "\ufeff# Título\r\n",
  "tabs and trailing spaces": "a\t \n\tb  \r".slice(0, -1) + "\n",
  "accents, emoji, CJK, NBSP, zero-width": "ação ✓ 😀 日本語 a b a\u200bb\n",
  "a fenced block": "```\r\ncódigo\r\n```\r\n",
  "empty": "",
  "only a break": "\n",
  "only a CRLF": "\r\n",
  "a single line": "uma linha",
};

describe("a page goes through the editor and back with the same bytes", () => {
  for (const [name, page] of Object.entries(PAGES)) {
    it(name, () => {
      expect(bytes(there(page))).toBe(bytes(page));
      expect(roundTrips(page)).toBe(true);
    });
  }

  it("the editor's text never has a \\r, and a CRLF page is written back with CRLF in every break", () => {
    const view = toView(PAGES["CRLF"]);
    expect(view).not.toContain("\r");
    expect(toDisk(view, "\r\n").split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r"))).toBe(true);
  });

  it("holds for any page that uses ONE line ending (2000 random pages)", () => {
    let seed = 20261029;
    const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const alphabet = ["a", "Z", "é", "😀", " ", "\t", "#", "*", "`", "[", "日", "\u200b"];
    for (let i = 0; i < 2000; i++) {
      const eol = rand(2) ? "\r\n" : "\n";
      let s = rand(4) === 0 ? "\ufeff" : "";
      for (let n = rand(60); n > 0; n--) s += rand(7) === 0 ? eol : alphabet[rand(alphabet.length)];
      expect(bytes(there(s)), JSON.stringify(s)).toBe(bytes(s));
    }
  });
});

describe("what does not go back unchanged is only what the textarea cannot hold", () => {
  it("a page that mixes line endings is made uniform (the dominant one), and says it does not round-trip", () => {
    const mixed = "a\r\nb\r\nc\nd\r\n";
    expect(roundTrips(mixed)).toBe(false);
    expect(eolOf(mixed)).toBe("\r\n");
    expect(there(mixed)).toBe("a\r\nb\r\nc\r\nd\r\n");
    expect(eolOf("a\nb\nc\r\nd\n")).toBe("\n");
  });

  it("a lone \\r is a line break to the textarea: it does not round-trip", () => {
    expect(roundTrips("a\rb")).toBe(false);
    expect(toView("a\rb")).toBe("a\nb");
  });

  it("a page with no break at all is LF", () => {
    expect(eolOf("sem quebra")).toBe("\n");
  });
});
