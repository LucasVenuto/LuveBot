// tests/unit/redteam/g3-luve-blob.test.ts
// Every blob: URL the page makes (URL.createObjectURL) is on a CLOSED LIST, each with its class and its reason (the cross review's F12;
// Crie seu Luve proposal §8 Q4, condition 4). A call in any other file, or a second call in a listed one, breaks this test and asks
// for a review: what is behind the Blob, who can put script or markup in it, where the URL goes, and who revokes it.
// Two files may NAME the type image/svg+xml, and no other: ui/luve.ts (an SVG the plugin builds from shipped pieces, shown as an <img>)
// and viewer/viewable.ts (an agent's SVG, handed to viewer/document.ts, which only rasterizes it OFF the DOM). document.ts never names
// the type: it makes a blob: URL of whatever Blob it is given, so it is the sink together with viewable.ts, and it must revoke in a
// `finally` and attach nothing to the page.
// Mutations: the same patterns planted in a temporary copy of dashboard/src must be found.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

const SRC = path.resolve(__dirname, "../../../dashboard/src");

/** file → { calls: how many createObjectURL calls, kind, why }. */
const SITES: Record<string, { calls: number; kind: string; why: string }> = {
  "components/ui/luve.ts": { calls: 1, kind: "svg-avatar", why: "the Luve's SVG, built from shipped pieces and a checked hex, shown as <img src=blob:>; revoked when the last face lets go" },
  "components/ui/avatarImage.ts": { calls: 1, kind: "png-avatar", why: "a person's own image: the 256 x 256 PNG LuveBot stored, fetched with the session (authedFetch), its bytes checked (a PNG, 256 x 256) BEFORE the Blob, shown as <img src=blob:> or an SVG <image>; revoked when the last face lets go" },
  "components/viewer/image.ts": { calls: 1, kind: "decode-check", why: "a raster image whose bytes were read first, decoded once in an off-DOM <img>; revoked in a finally" },
  "components/viewer/ImageViewer.tsx": { calls: 1, kind: "raster-view", why: "a raster image already checked by its bytes, shown as <img>; revoked on cleanup" },
  "components/viewer/document.ts": { calls: 1, kind: "svg-raster", why: "an agent's SVG drawn on a canvas through an off-DOM image, never attached; revoked in a finally" },
  "components/viewer/PageViewer.tsx": { calls: 1, kind: "page-frame", why: "an HTML page in an isolated frame (no script); revoked on cleanup" },
  "voice/speak.ts": { calls: 1, kind: "audio", why: "the spoken answer, played by an <audio> element; revoked when it ends or is replaced" },
  "components/ui/luvePng.ts": { calls: 1, kind: "download", why: "the person's own Luve PNG, made in the browser and saved from a detached link; never sent to the server; revoked right after" },
  "components/conversation/FileCard.tsx": { calls: 1, kind: "download", why: "a file the person asked to download, clicked once from a detached link; revoked right after" },
};
const SVG_NAMERS = ["components/ui/luve.ts", "components/viewer/viewable.ts"];
const DOCUMENT = "components/viewer/document.ts";

const walk = (root: string): string[] => fs.readdirSync(root, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(root, e.name)).map((f) => `${e.name}/${f}`)
    : /\.(tsx?|jsx?|mjs|cjs)$/.test(e.name) ? [e.name] : []);

/** Code only: whole-line // comments and block comments do not count (a comment may talk about the type). */
const code = (file: string) => fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** file → number of createObjectURL CALLS (the feature check `typeof URL.createObjectURL` is not a call). */
function blobSites(root: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const rel of walk(root)) {
    const n = (code(path.join(root, rel)).match(/createObjectURL\s*\(/g) ?? []).length;
    if (n) found[rel] = n;
  }
  return found;
}

const svgNamers = (root: string): string[] =>
  walk(root).filter((rel) => /image\/svg\+xml/.test(code(path.join(root, rel)))).sort();

/** What document.ts must keep: the revoke in a finally, and nothing attached to the page. */
function documentProblems(root: string): string[] {
  const file = path.join(root, DOCUMENT);
  if (!fs.existsSync(file)) return ["missing"];
  const text = code(file), problems: string[] = [];
  if (!/finally\s*\{[^}]*revokeObjectURL/.test(text)) problems.push("no revokeObjectURL in a finally");
  if (/\.(append|prepend|before|after|replaceWith|replaceChildren)\s*\(|appendChild|insertAdjacent|insertBefore|document\.body|innerHTML|outerHTML|srcdoc/.test(text)) problems.push("attaches something to the page");
  return problems;
}

const copies: string[] = [];
afterEach(() => { for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const copy = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g3-luve-"));
  copies.push(dir);
  fs.cpSync(SRC, dir, { recursive: true });
  return dir;
};

describe("G3: every blob: URL is on a closed list", () => {
  it("the real tree has exactly the listed calls, each with its class and reason", () => {
    expect(blobSites(SRC)).toEqual(Object.fromEntries(Object.entries(SITES).map(([file, s]) => [file, s.calls])));
    for (const [file, s] of Object.entries(SITES)) expect(s.kind && s.why, file).toBeTruthy();
  });

  it("only ui/luve.ts and viewer/viewable.ts name image/svg+xml", () => {
    expect(svgNamers(SRC)).toEqual(SVG_NAMERS);
  });

  it("viewer/document.ts revokes in a finally and attaches nothing to the page", () => {
    expect(documentProblems(SRC)).toEqual([]);
  });

  it("a new file that only turns a Blob into a blob: URL is found (mutation: document.ts's own shape)", () => {
    const dir = copy();
    fs.writeFileSync(path.join(dir, "components/ui/Planted.ts"), "export const u = (blob: Blob) => URL.createObjectURL(blob);\n");
    const found = blobSites(dir);
    expect(Object.keys(found).filter((f) => !(f in SITES))).toEqual(["components/ui/Planted.ts"]);
  });

  it("a second call in a listed file is found (mutation)", () => {
    const dir = copy(), file = path.join(dir, "voice/speak.ts");
    fs.appendFileSync(file, "\nexport const again = (b: Blob) => URL.createObjectURL(b);\n");
    expect(blobSites(dir)["voice/speak.ts"]).toBe(2);
  });

  it("a second file that names image/svg+xml is found (mutation)", () => {
    const dir = copy();
    fs.writeFileSync(path.join(dir, "components/ui/Planted.ts"), 'export const t = "image/svg+xml";\n');
    expect(svgNamers(dir)).toEqual(["components/ui/Planted.ts", ...SVG_NAMERS].sort());
  });

  it("document.ts without the revoke in its finally, or with the image attached to the page, is found (mutations)", () => {
    const text = fs.readFileSync(path.join(SRC, DOCUMENT), "utf8");
    const noRevoke = copy();
    fs.writeFileSync(path.join(noRevoke, DOCUMENT), text.replace("  } finally {\n    URL.revokeObjectURL(url);\n  }\n  const canvas", "  } finally {\n  }\n  const canvas"));
    expect(documentProblems(noRevoke)).toEqual(["no revokeObjectURL in a finally"]);
    const attached = copy();
    fs.writeFileSync(path.join(attached, DOCUMENT), text.replace("  const img = new Image();\n", "  const img = new Image();\n  document.body.appendChild(img);\n"));
    expect(documentProblems(attached)).toEqual(["attaches something to the page"]);
  });
});
