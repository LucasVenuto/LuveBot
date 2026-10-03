// tests/unit/style-motion.test.ts
// Style guide §6: every animation and transition in our stylesheet lives inside
// @media (prefers-reduced-motion: no-preference), so people who asked for less motion get none.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(process.cwd(), "dashboard/src/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of animation/transition that are NOT inside a no-preference block (keyframes don't count). */
function motionOutsideGuard(src: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of src) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") {
      const decls = buf.split(";").map((d) => d.trim()).filter(Boolean);
      const guarded = stack.some((s) => /prefers-reduced-motion:\s*no-preference/.test(s));
      const keyframes = stack.some((s) => s.startsWith("@keyframes"));
      if (!guarded && !keyframes) for (const d of decls) if (/^(animation|transition)\s*:/.test(d)) out.push(`${stack[stack.length - 1]} { ${d} }`);
      stack.pop(); buf = ""; continue;
    }
    buf += ch;
  }
  return out;
}

describe("style.css motion", () => {
  it("has no animation or transition outside prefers-reduced-motion: no-preference", () => {
    expect(motionOutsideGuard(css)).toEqual([]);
  });

  it("the check catches an unguarded transition (mutation)", () => {
    expect(motionOutsideGuard(css + "\n.lb-x { transition: opacity 1s; }")).toEqual([".lb-x { transition: opacity 1s }"]);
  });
});
