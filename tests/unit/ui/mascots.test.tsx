// tests/unit/ui/mascots.test.tsx
// Mascots (T8.3, contract §14): the UI list = the shipped files, the files are safe as images, and the URL is only ever
// built for an id on the list (fails closed), with the state on the fragment. What ships is the WHOLE character
// (viewBox 0 0 256 256, never the cropped *-rosto face) and a mini copy that differs only by the art's own lb-face class.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MASCOTS, mascotUrl, isMascot } from "@/components/ui/mascots";

const root = process.cwd();
const faces = fs.readdirSync(path.resolve(root, "assets/mascots")).filter((f) => f.endsWith("-rosto.svg")).map((f) => f.replace("-rosto.svg", "")).sort();

describe("mascots", () => {
  it("the UI list is exactly the 15 faces in assets/mascots and the manifest", () => {
    const ids = MASCOTS.map((m) => m.id);
    expect(ids).toHaveLength(15);
    expect([...ids].sort()).toEqual(faces);
    const manifest = JSON.parse(fs.readFileSync(path.resolve(root, "assets/mascots/manifest.json"), "utf8")) as Array<{ id: string }>;
    expect(manifest.map((m) => m.id).sort()).toEqual(faces);
  });

  it("ships the whole character and its mini copy, nothing cropped, and every shipped file is safe to draw as an image (§14.2 scan)", () => {
    const shipped = path.resolve(root, "dashboard/icons/mascots");
    expect(fs.readdirSync(shipped).sort()).toEqual(faces.flatMap((id) => [`${id}-mini.svg`, `${id}.svg`]).sort());
    for (const id of faces) {
      const whole = fs.readFileSync(path.resolve(shipped, `${id}.svg`), "utf8");
      const mini = fs.readFileSync(path.resolve(shipped, `${id}-mini.svg`), "utf8");
      expect(whole, id).toBe(fs.readFileSync(path.resolve(root, `assets/mascots/${id}.svg`), "utf8"));   // the art, untouched
      expect(whole, id).toMatch(/^<svg [^>]*viewBox="0 0 256 256"/);
      expect(mini, id).toBe(whole.replace('class="lb-mascot ', 'class="lb-face lb-mascot '));            // only the class
      expect(whole, id).toMatch(/\.lb-face \.m-orbit,\.lb-face \.m-shadow\{display:none\}/);            // the art's own rule hides them
      for (const svg of [whole, mini]) expect(svg, id).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=|(?:xlink:)?href\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i);
    }
  });

  it("builds the plugin path only for a listed id, with the state fragment (§14.3)", () => {
    expect(mascotUrl("luvi")).toBe("/dashboard-plugins/luvebot/icons/mascots/luvi-mini.svg");
    expect(mascotUrl("luvi", "working")).toBe("/dashboard-plugins/luvebot/icons/mascots/luvi-mini.svg#lb-working");
    expect(mascotUrl("luvi", "needs_you", 24)).toBe("/dashboard-plugins/luvebot/icons/mascots/luvi-mini.svg#lb-needs-you");
    expect(mascotUrl("luvi", "paused")).toBe("/dashboard-plugins/luvebot/icons/mascots/luvi-mini.svg");
    expect(mascotUrl("luvi", undefined, 55)).toBe("/dashboard-plugins/luvebot/icons/mascots/luvi-mini.svg");
    expect(mascotUrl("luvi", "working", 56)).toBe("/dashboard-plugins/luvebot/icons/mascots/luvi.svg#lb-working");  // big: with the orbit
    for (const bad of ["Luvi", "luvi.svg", "luvi-rosto", "../luvi", "", "https://x/y.svg", null, undefined]) {
      expect(mascotUrl(bad as any), String(bad)).toBeNull();
      expect(isMascot(bad as any)).toBe(false);
    }
  });
});
