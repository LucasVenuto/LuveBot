// tests/unit/pages/line-diff.test.ts
// lineDiff caps the table (n·m) AND each side: a page of a million empty lines against one line is only 1M cells but a million rows (red team E2).
import { describe, it, expect } from "vitest";
import { lineDiff, MAX_DIFF_LINES } from "@/components/pages/pages";

describe("lineDiff", () => {
  it("compares ordinary pages", () => {
    expect(lineDiff("a\nb", "a\nc")!.map((l) => l.kind)).toEqual(["same", "del", "add"]);
  });
  it("refuses a side with more lines than the cap, however small the other one is", () => {
    expect(lineDiff("\n".repeat(MAX_DIFF_LINES), "x")).toBeNull();
    expect(lineDiff("x", "\n".repeat(MAX_DIFF_LINES))).toBeNull();
    expect(lineDiff("\n".repeat(1_000_000), "x")).toBeNull();
  });
  it("still compares at the cap itself, and is quick about it", () => {
    const t0 = performance.now();
    const d = lineDiff("\n".repeat(MAX_DIFF_LINES - 1), "x");
    expect(d).not.toBeNull();
    expect(d!.length).toBeLessThanOrEqual(MAX_DIFF_LINES + 1);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it("keeps the n·m cap", () => {
    expect(lineDiff("a\n".repeat(3000), "b\n".repeat(3000))).toBeNull();
  });
});
