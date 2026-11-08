// tests/unit/viewer/image-touch-cap.test.tsx
// 2nd cross review F11: the 50-megapixel cap with two decodes (the check, then the <img>) is high for an iPhone or iPad, where WebKit can kill the
// tab; the limit was not measured, so on a touch screen (coarse pointer) the cap is 25 megapixels, read from the header before any decode. Desktop keeps
// 50. The refusal says the number that applies on THIS device.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { checkImage, maxPixels, MAX_PIXELS, MAX_PIXELS_TOUCH } from "@/components/viewer/image";
import { checkViewable } from "@/components/viewer/viewable";
import { ImagePreview } from "@/components/viewer/ImageViewer";

const u8 = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((p) => typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number) => u8([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = () => fail(r.error); r.readAsArrayBuffer(this); });
  };
}
const touch = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("pointer: coarse"), media: q, addEventListener() {}, removeEventListener() {} }));
const mouse = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
let decodes: number;

beforeEach(() => { cleanup(); decodes = 0; (globalThis as any).createImageBitmap = vi.fn(async () => { decodes++; return { close() {} }; }); });
afterEach(() => { vi.unstubAllGlobals(); delete (globalThis as any).createImageBitmap; });

describe("the pixel cap of this device", () => {
  it("a mouse keeps 50 megapixels (a 40 MP picture opens); a touch screen has 25", async () => {
    expect([MAX_PIXELS, MAX_PIXELS_TOUCH]).toEqual([50_000_000, 25_000_000]);
    mouse();
    expect(maxPixels()).toBe(50_000_000);
    expect((await checkImage(new Blob([png(8000, 5000)]))).kind).toBe("ready");
    expect(decodes).toBe(1);
    touch();
    expect(maxPixels()).toBe(25_000_000);
  });

  it("on a touch screen a 40 MP picture is refused from its header, the decoder never reached; a 24 MP one still opens", async () => {
    touch();
    expect((await checkImage(new Blob([png(8000, 5000)]))).kind).toBe("too_large");
    expect(decodes).toBe(0);
    expect((await checkImage(new Blob([png(6000, 4000)]))).kind).toBe("ready");
    expect(decodes).toBe(1);
  });

  it("the same cap holds for an SVG about to be rasterized (its root's width and height, before drawing)", async () => {
    touch();
    const svg = new File([`<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="5000"></svg>`], "grande.svg");
    expect((await checkViewable(svg, "grande.svg")).kind).toBe("too_large");
  });

  it("the refusal names the number that applies here: 25 on a touch screen, 50 on a desktop", async () => {
    const refused = async () => new Blob([png(8000, 5000)]);
    touch();
    const phone = render(<ImagePreview id="t1" name="x.png" load={refused} onDownload={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("image-state").textContent).toContain("mais de 25 MB ou de 25 megapixels"));
    phone.unmount();
    mouse();
    const wide = render(<ImagePreview id="t2" name="x.png" load={async () => new Blob([png(10_000, 6_000)])} onDownload={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("image-state").textContent).toContain("mais de 25 MB ou de 50 megapixels"));
    wide.unmount();
  });
});
