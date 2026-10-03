// tests/unit/redteam/g3-no-html-sinks.test.ts
// Red team 3, gap G3.2 (docs/redteam/2026-10-02.md): no raw-HTML or code sink anywhere in dashboard/src, so agent text can only
// ever reach the page through React's escaping. It held before this test, but nothing enforced it.
// Mutation: each sink planted in a temporary copy of dashboard/src (the real tree is never touched) must be found.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

const SRC = path.resolve(__dirname, "../../../dashboard/src");
const SINKS: [string, RegExp][] = [
  ["dangerouslySetInnerHTML", /dangerouslySetInnerHTML/],
  [".innerHTML", /\.innerHTML\b/],
  [".outerHTML", /\.outerHTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["createContextualFragment", /createContextualFragment/],
  ["eval(", /(^|[^\w.$])eval\s*\(/],
  ["new Function", /new\s+Function\s*\(/],
  ["document.write", /document\s*\.\s*write(ln)?\s*\(/],
  ["srcdoc", /srcdoc/i],
];

/** Every sink hit under `root`, as `file:line sink`. */
export function sinks(root: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) {
        fs.readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          for (const [name, re] of SINKS) if (re.test(line)) hits.push(`${path.relative(root, full)}:${i + 1} ${name}`);
        });
      }
    }
  };
  walk(root);
  return hits;
}

const copies: string[] = [];
afterEach(() => { for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("G3.2: no raw-HTML sinks in dashboard/src", () => {
  it("finds none in the real tree, and the tree is really scanned", () => {
    expect(sinks(SRC)).toEqual([]);
    expect(fs.existsSync(path.join(SRC, "components/chat/InlineApproval.tsx"))).toBe(true);
  });

  const PLANTED: [string, string][] = [
    ["dangerouslySetInnerHTML", "export const X = () => <div dangerouslySetInnerHTML={{ __html: text }} />;"],
    [".innerHTML", "el.innerHTML = text;"],
    [".outerHTML", "el.outerHTML = text;"],
    ["insertAdjacentHTML", 'el.insertAdjacentHTML("beforeend", text);'],
    ["createContextualFragment", "document.createRange().createContextualFragment(text);"],
    ["eval(", "const r = eval(text);"],
    ["new Function", 'const f = new Function("return " + text);'],
    ["document.write", "document.write(text);"],
    ["srcdoc", "export const Y = () => <iframe srcDoc={text} />;"],
  ];
  for (const [name, line] of PLANTED) {
    it(`mutation is caught: ${name} planted in a nested component`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-sinks-"));
      copies.push(dir);
      fs.cpSync(SRC, dir, { recursive: true });
      const target = path.join(dir, "components/chat/InlineApproval.tsx");
      fs.appendFileSync(target, `\n${line}\n`);
      expect(sinks(dir)).toEqual([expect.stringMatching(new RegExp(`^components/chat/InlineApproval\\.tsx:\\d+ ${name.replace(/[.(]/g, "\\$&")}$`))]);
    });
  }
  it("a word that only looks like a sink is not one (no false positive on retrieval or medieval)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-sinks-"));
    copies.push(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "const retrieval = medieval(x); obj.evaluate(y);\n");
    expect(sinks(dir)).toEqual([]);
  });
});
