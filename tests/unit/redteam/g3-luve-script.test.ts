// tests/unit/redteam/g3-luve-script.test.ts
// Crie seu Luve U3 (proposal §8 Q2) and ADR-009 §6: the page gets a <script> element only from the two loaders (luve3d/load.ts and editor/load.ts),
// each with a constant URL of the plugin: nothing stored, typed or sent by the server can pick what runs. Any other file that creates a
// script element is refused; a loader with another source for its script is refused.
// Mutations: the same patterns planted in a temporary copy of dashboard/src must be found.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

const SRC = path.resolve(__dirname, "../../../dashboard/src");
// the loaders: each is the ONLY place of its file and takes a constant URL of the plugin (the Luve's 3D, and the page editor's seam, ADR-009 §6)
const LOADERS: Record<string, string> = {
  "luve3d/load.ts": 'pluginAssetUrl("dist/luve3d.js")',
  "editor/load.ts": 'pluginAssetUrl("dist/editor.js")',
};

const walk = (root: string): string[] => fs.readdirSync(root, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(root, e.name)).map((f) => `${e.name}/${f}`) : /\.(tsx?|jsx?|mjs|cjs)$/.test(e.name) ? [e.name] : []);
const code = (file: string) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Files that make a script element (createElement("script"), also from a variable-free template or backticks). */
const scriptMakers = (root: string): string[] =>
  walk(root).filter((rel) => /createElement\(\s*(["'`])script\1/.test(code(path.join(root, rel)))).sort();

/** How a loader sets the script's source: every `.src =` in it, which must be the one constant call. */
const loaderSources = (root: string, loader: string): string[] =>
  [...code(path.join(root, loader)).matchAll(/\.src\s*=\s*([^;]+);/g)].map((m) => m[1].trim());

const copies: string[] = [];
afterEach(() => { for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const copy = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-script-"));
  copies.push(dir);
  fs.cpSync(SRC, dir, { recursive: true });
  return dir;
};

describe("G3: a script element is made only by the 3D loader, from a constant URL", () => {
  it("the real tree: only the two loaders, each with its own constant src", () => {
    expect(scriptMakers(SRC)).toEqual(Object.keys(LOADERS).sort());
    for (const [loader, src] of Object.entries(LOADERS)) expect(loaderSources(SRC, loader), loader).toEqual([src]);
  });

  it("a second file that makes a script element is found (mutation)", () => {
    const dir = copy();
    fs.writeFileSync(path.join(dir, "components/ui/Planted.ts"), "export const s = () => document.createElement('script');\n");
    expect(scriptMakers(dir)).toEqual(["components/ui/Planted.ts", ...Object.keys(LOADERS)].sort());
  });

  it.each(Object.entries(LOADERS))("the loader %s with a source that is not the constant is found (mutation)", (loader, src) => {
    const dir = copy(), file = path.join(dir, loader);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(src, "location.hash.slice(1)"));
    expect(loaderSources(dir, loader)).toEqual(["location.hash.slice(1)"]);
  });
});
