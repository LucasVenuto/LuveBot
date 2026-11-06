// tests/unit/pwa/app-icon.test.ts: the app icon, by its PIXELS. The CEO's iPhone showed the icon (v0.3 fix) with the mascot small (54% of the width: a dark tile drawn inside a margin) on a black
// background that did not match the brand. Now: the mascot is big inside the safe area, and ONE brand background (light lavender) serves both themes, because iOS does not switch a Home Screen icon by theme.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { decodePng, mascot, corners, contrast, luma } from "./png";

const ICONS = path.resolve(__dirname, "../../../dashboard/icons");
const FILES = [["apple-touch-icon.png", 180, "any"], ["icon-192.png", 192, "any"], ["icon-512.png", 512, "any"], ["icon-maskable-512.png", 512, "maskable"]] as const;
const load = (f: string) => decodePng(fs.readFileSync(path.join(ICONS, f)));

describe("the four PNGs of the app icon", () => {
  it("are opaque RGB squares of the size their names say (iOS paints a transparent corner black; the old 192 and 512 had an alpha channel)", () => {
    for (const [f, side] of FILES) { const p = load(f); expect([p.width, p.height, p.channels], f).toEqual([side, side, 3]); }
  });

  it("show the mascot BIG: about 80% of the width on an 'any' icon (it was 54%), centred, with room left for the mask", () => {
    for (const [f, , kind] of FILES.filter((x) => x[2] === "any")) {
      const m = mascot(load(f));
      expect(m.width, `${f}: the mascot is ${(m.width * 100).toFixed(1)}% of the width`).toBeGreaterThanOrEqual(0.78);
      expect(m.width, f).toBeLessThanOrEqual(0.84);
      expect(Math.abs(m.left - m.right), `${f} off centre sideways`).toBeLessThanOrEqual(0.02);
      expect(Math.abs(m.top - m.bottom), `${f} off centre vertically`).toBeLessThanOrEqual(0.02);
      expect(Math.min(m.left, m.right, m.top, m.bottom), `${f}: too close to the edge`).toBeGreaterThanOrEqual(0.08);   // the iOS corner radius is 22% and clips nothing here
      expect(kind).toBe("any");
    }
  });

  it("keep EVERY pixel of the maskable mascot inside the safe circle (radius 40% of the side), as big as that allows", () => {
    const m = mascot(load("icon-maskable-512.png"));
    expect(m.far, "a pixel of the mascot is outside the safe circle").toBeLessThanOrEqual(0.40);
    expect(m.width, "the maskable mascot is too small").toBeGreaterThanOrEqual(0.62);
    expect(m.width).toBeLessThanOrEqual(0.68);
  });

  it("share ONE brand background, and it is light: the same four corner colours on every icon, nowhere near black, so the tile has its edge on a light wallpaper and on a dark one", () => {
    const ref = corners(load("icon-512.png"));
    for (const [f] of FILES) corners(load(f)).forEach((c, i) => c.forEach((v, k) => expect(Math.abs(v - ref[i][k]), `${f} corner ${i} channel ${k}`).toBeLessThanOrEqual(3)));
    for (const c of ref) expect(luma(c), `a dark corner ${c}`).toBeGreaterThanOrEqual(200);
  });

  it("keep the mascot readable on that background: at least 2.5 : 1 between its blue and every corner (a logo has no WCAG minimum; this keeps its outline)", () => {
    for (const [f] of FILES) { const p = load(f), m = mascot(p); for (const c of corners(p)) expect(contrast(c, m.mean), `${f} against ${c}`).toBeGreaterThanOrEqual(2.5); }
  });
});
