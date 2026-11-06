// tests/unit/lib/avatar-crop.test.ts
// The square crop of a person's image (lib/avatarCrop.ts): which square of the source goes into the 256 x 256 face. Pure arithmetic: the square is never outside the image,
// zoom 1 is the shorter side, a drag moves the picture with the finger, and a glitch (NaN, infinity) is the start, never a bad drawImage.
import { describe, it, expect } from "vitest";
import { clampCrop, cropRect, initialCrop, MAX_ZOOM, MIN_ZOOM, panCrop, squareSize, zoomCrop } from "@/lib/avatarCrop";

describe("the crop", () => {
  it("starts on the centre, at the shorter side, whatever the shape", () => {
    expect(cropRect(1000, 600, initialCrop(1000, 600))).toEqual({ sx: 200, sy: 0, size: 600 });
    expect(cropRect(600, 1000, initialCrop(600, 1000))).toEqual({ sx: 0, sy: 200, size: 600 });
    expect(cropRect(500, 500, initialCrop(500, 500))).toEqual({ sx: 0, sy: 0, size: 500 });
  });

  it("zoom shrinks the square down to a quarter and never past it", () => {
    expect(squareSize(800, 800, 2)).toBe(400);
    expect(squareSize(800, 800, MAX_ZOOM)).toBe(200);
    expect(squareSize(800, 800, 99)).toBe(200);
    expect(squareSize(800, 800, 0.1)).toBe(800);
    expect(squareSize(800, 800, -3)).toBe(800);
  });

  it("the square never leaves the image, at any zoom and any centre (the whole grid)", () => {
    for (const [w, h] of [[1000, 600], [600, 1000], [256, 256], [4000, 3000], [33, 4000]] as const)
      for (const zoom of [1, 1.5, 2, 3.7, 4, 50, 0, -2])
        for (const cx of [-1e9, -5, 0, w / 2, w, w + 7, 1e9])
          for (const cy of [-1e9, 0, h / 2, h, 1e9]) {
            const r = cropRect(w, h, { zoom, cx, cy });
            expect(r.sx, `${w}x${h} z${zoom} ${cx},${cy}`).toBeGreaterThanOrEqual(-1e-9);
            expect(r.sy).toBeGreaterThanOrEqual(-1e-9);
            expect(r.sx + r.size).toBeLessThanOrEqual(w + 1e-9);
            expect(r.sy + r.size).toBeLessThanOrEqual(h + 1e-9);
            expect(r.size).toBeGreaterThan(0);
          }
  });

  it("a NaN or an infinity is the start, never a bad rectangle", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = cropRect(1000, 600, { zoom: bad, cx: bad, cy: bad });
      expect(r).toEqual({ sx: 200, sy: 0, size: 600 });
    }
    const c = clampCrop(1000, 600, { zoom: 2, cx: Number.NaN, cy: 300 });
    expect(c.cx).toBe(500);
  });

  it("a drag moves the picture with the finger: the centre goes the other way, in source pixels (viewport 300 px for a 300 px square)", () => {
    const start = zoomCrop(1000, 600, initialCrop(1000, 600), 2);   // a 300 px square, centred
    const moved = panCrop(1000, 600, start, 30, 0, 300);            // 30 view px of a 300 px viewport showing 300 source px
    expect(moved.cx).toBeCloseTo(500 - 30, 6);
    expect(moved.cy).toBe(300);
    const up = panCrop(1000, 600, start, 0, -60, 300);
    expect(up.cy).toBeCloseTo(300 + 60, 6);
  });

  it("a drag past the edge stops at the edge", () => {
    const start = zoomCrop(1000, 600, initialCrop(1000, 600), 2);
    const far = panCrop(1000, 600, start, -1e6, 1e6, 300);
    const r = cropRect(1000, 600, far);
    expect(r.sx + r.size).toBeCloseTo(1000, 6);
    expect(r.sy).toBeCloseTo(0, 6);
  });

  it("a drag on a viewport of no width moves nothing", () => {
    const c = initialCrop(1000, 600);
    expect(panCrop(1000, 600, c, 50, 50, 0)).toEqual(c);
  });

  it("zooming keeps the centre when it can, and pulls it in when the new square would not fit", () => {
    const off = { zoom: 1, cx: 500, cy: 300 };
    expect(zoomCrop(1000, 600, off, 2).cx).toBe(500);
    const edge = zoomCrop(1000, 600, { zoom: 2, cx: 850, cy: 300 }, 1);   // at zoom 1 the 600 px square must keep cx between 300 and 700
    expect(edge.cx).toBe(700);
    expect(zoomCrop(1000, 600, off, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomCrop(1000, 600, off, 0).zoom).toBe(MIN_ZOOM);
  });
});
