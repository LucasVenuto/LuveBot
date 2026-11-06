// tests/unit/skills/skill-teach-lib.test.ts
// The pure rules of the skill review sheet (contract v0.11 3.2 step 3 and 3.4): the header's name, the line count, the padding warnings, the invisible characters by kind, "Remove them", the marked preview and the
// class of a refused character in words. Invisible characters are built from code points (String.fromCodePoint), never typed, so no source line holds one raw.
import { describe, it, expect } from "vitest";
import { BLANK_RUN_MAX, LINE_COLUMNS_MAX, hasLongLine, headerName, hiddenClass, lineCount, longestBlankRun, markedPreview, markedSummary, removeMarked, shortName } from "@/lib/skillTeach";
import { visibleTokens } from "@/lib/hiddenChars";

const c = (...cp: number[]) => String.fromCodePoint(...cp);
const ZWNJ = c(0x200c), ZWSP = c(0x200b), LRM = c(0x200e), TAG_A = c(0xe0041), RLO = c(0x202e);
const HEAD = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the report.\n";

describe("headerName: the name a person reads in the header (the server compares the real one)", () => {
  it("reads the first name line of the header, with or without quotes, and nothing else", () => {
    expect(headerName(HEAD)).toBe("send-report");
    expect(headerName("---\nname: 'a.b_c-1'\ndescription: x.\n---\nbody")).toBe("a.b_c-1");
    expect(headerName('---\nname: "quoted"   \n---\nbody')).toBe("quoted");
    expect(headerName("---\ndescription: x.\nname:   spaced   \n---\nbody")).toBe("spaced");
  });
  it("none when there is no header, no name, an empty name, or the name sits after the header closed", () => {
    expect(headerName("no header\nname: x")).toBeNull();
    expect(headerName("---\ndescription: x.\n---\nbody")).toBeNull();
    expect(headerName("---\nname:\ndescription: x.\n---\nbody")).toBeNull();
    expect(headerName("---\nname: ''\n---\nbody")).toBeNull();
    expect(headerName("---\ndescription: x.\n---\nname: late")).toBeNull();
    expect(headerName("\n---\nname: x\n---\n")).toBeNull();                      // line 1 must be the opening ---
  });
  it("an indented or nested name is not the header's name (a mapping value, not the key)", () => {
    expect(headerName("---\nmeta:\n  name: nested\ndescription: x.\n---\nbody")).toBeNull();
  });
});

describe("the text's shape", () => {
  it("lineCount counts by LF: N lines, the last is line N", () => {
    expect(lineCount("a")).toBe(1);
    expect(lineCount("a\nb\nc")).toBe(3);
    expect(lineCount("a\n")).toBe(2);
  });
  it("longestBlankRun: lines of only spaces and tabs, in a row", () => {
    expect(longestBlankRun("a\nb")).toBe(0);
    expect(longestBlankRun("a\n\n \t\nb\n\nc")).toBe(2);
    expect(longestBlankRun("a" + "\n".repeat(21) + "b")).toBe(20);               // 21 line feeds make 20 blank lines between a and b
    expect(longestBlankRun("a" + "\n".repeat(22) + "b")).toBe(21);
    expect(BLANK_RUN_MAX).toBe(20);
  });
  it("hasLongLine counts CODE POINTS: 1,000 are fine, 1,001 are not, and an emoji is one column", () => {
    expect(LINE_COLUMNS_MAX).toBe(1000);
    expect(hasLongLine("x".repeat(1000))).toBe(false);
    expect(hasLongLine("x".repeat(1001))).toBe(true);
    expect(hasLongLine("a\n" + "x".repeat(1001) + "\nb")).toBe(true);
    expect(hasLongLine(c(0x1f600).repeat(600))).toBe(false);                       // 1,200 UTF-16 units but 600 columns
    expect(hasLongLine(c(0x1f600).repeat(1001))).toBe(true);
  });
});

describe("the invisible characters the table ALLOWS", () => {
  const text = "---\nname: a\ndescription: x" + ZWNJ + ".\n---\nstep" + ZWNJ + " one" + LRM + "\n" + ZWNJ;
  it("markedSummary: how many, which (by code point, with the short name) and on which lines", () => {
    expect(markedSummary(text)).toEqual({ count: 4, kinds: [{ code: "U+200C", name: "ZWNJ", count: 3 }, { code: "U+200E", name: "LRM", count: 1 }], lines: [3, 5, 6] });
    expect(markedSummary("plain text")).toEqual({ count: 0, kinds: [], lines: [] });
  });
  it("shortName: the common ones by name, the rest by code", () => {
    expect([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x00ad].map(shortName)).toEqual(["ZWSP", "ZWNJ", "ZWJ", "LRM", "RLM", "WJ", "BOM", "SHY"]);
    expect(shortName(0x034f)).toBe("U+034F");
  });
  it("removeMarked takes out EXACTLY the marked characters and nothing else (refused ones, spaces, emoji, ZWJ-free text stay)", () => {
    expect(removeMarked("a" + ZWNJ + "b" + ZWSP + LRM + "c")).toBe("abc");
    expect(removeMarked("a b\tc\n" + c(0x1f600))).toBe("a b\tc\n" + c(0x1f600));
    expect(removeMarked("a" + TAG_A + "b" + RLO)).toBe("a" + TAG_A + "b" + RLO);       // a refused character is not "removed" by a tap: the text stays refused
    expect(removeMarked("")).toBe("");
  });
  it("markedPreview shows each marked character as a visible token and changes nothing else", () => {
    expect(markedPreview("a" + ZWNJ + "b" + LRM + " c")).toBe("a[U+200C]b[U+200E] c");
    expect(markedPreview("plain\n\ttext")).toBe("plain\n\ttext");
    expect(markedPreview("x" + c(0x1d173) + "y")).toBe("x[U+1D173]y");                 // five hexadecimal digits when the code point needs them
  });
});

describe("hiddenClass: what a REFUSED character is, from its code (never the character)", () => {
  it.each([
    ["U+E0041", "tags"], ["U+E0000", "tags"], ["U+E007F", "tags"],
    ["U+E0100", "variation"], ["U+E01EF", "variation"],
    ["U+202A", "bidi"], ["U+202E", "bidi"],
    ["U+2028", "separator"], ["U+2029", "separator"],
    ["U+0000", "control"], ["U+001B", "control"], ["U+007F", "control"], ["U+0085", "control"], ["U+009F", "control"],
    ["U+FDD0", "noncharacter"], ["U+FDEF", "noncharacter"], ["U+FFFE", "noncharacter"], ["U+FFFF", "noncharacter"], ["U+1FFFE", "noncharacter"], ["U+10FFFF", "noncharacter"],
    ["U+D800", "other"], ["U+0041", "other"], ["nonsense", "other"], ["", "other"],
  ] as const)("%s is %s", (code, kind) => { expect(hiddenClass(code)).toBe(kind); });
});

describe("visibleTokens: a line the sheet draws shows EVERY character of the table as a token (F-SK5-1)", () => {
  it("refused and marked characters become [U+XXXX]; ordinary text, spaces, accents and emoji stay", () => {
    expect(visibleTokens("Use when asked." + TAG_A + ZWNJ + RLO + "ok")).toBe("Use when asked.[U+E0041][U+200C][U+202E]ok");
    expect(visibleTokens("Use quando pedirem: relatório, ação " + c(0x1f600))).toBe("Use quando pedirem: relatório, ação " + c(0x1f600));
    expect(visibleTokens(c(0x85) + c(0x3164) + c(0xe0100) + c(0x2060))).toBe("[U+0085][U+3164][U+E0100][U+2060]");
    expect(visibleTokens("")).toBe("");
  });
  it("what the plain-text area's preview marks and this line marks agree on the marked ones, and this one also takes the refused", () => {
    const marked = "a" + ZWNJ + "b" + LRM;
    expect(visibleTokens(marked)).toBe(markedPreview(marked));
    expect(markedPreview("a" + TAG_A)).toBe("a" + TAG_A);                     // the area's preview leaves a refused character alone (such a text never reaches the sheet's area)
    expect(visibleTokens("a" + TAG_A)).toBe("a[U+E0041]");
  });
});

