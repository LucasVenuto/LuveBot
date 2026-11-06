// tests/unit/pwa/png.ts: a minimal PNG decoder for the tests (8-bit RGB or RGBA, not interlaced: what the icons are), so a test can look at the PIXELS of an icon.
import zlib from "node:zlib";

export interface Png { width: number; height: number; channels: 3 | 4; data: Uint8Array }

export function decodePng(file: Buffer): Png {
  if (!file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("not a PNG");
  let at = 8, width = 0, height = 0, channels: 3 | 4 = 3;
  const idat: Buffer[] = [];
  while (at < file.length) {
    const len = file.readUInt32BE(at), type = file.toString("latin1", at + 4, at + 8), body = file.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 2 && body[9] !== 6) || body[12] !== 0) throw new Error("only 8-bit RGB/RGBA, not interlaced");
      channels = body[9] === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(body);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = width * channels, out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0, b = y ? out[(y - 1) * stride + i] : 0, c = i >= channels && y ? out[(y - 1) * stride + i - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + i] = (line[i] + pred) & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** A pixel as [r, g, b]. */
export const pixel = (p: Png, x: number, y: number): [number, number, number] => { const o = (y * p.width + x) * p.channels; return [p.data[o], p.data[o + 1], p.data[o + 2]]; };
export const luma = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b;
/** WCAG relative luminance and contrast ratio. */
const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const relLum = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: [number, number, number], b: [number, number, number]) => { const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

/** The mascot: every pixel darker than the lightest brand background. Its box (as fractions of the side), the farthest pixel from the centre, and the mean colour of its body. */
export function mascot(p: Png) {
  let x0 = p.width, x1 = -1, y0 = p.height, y1 = -1, far = 0, n = 0; const sum = [0, 0, 0];
  for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
    const px = pixel(p, x, y);
    if (luma(px) >= 204) continue;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    far = Math.max(far, Math.hypot(x + 0.5 - p.width / 2, y + 0.5 - p.height / 2));
    sum[0] += px[0]; sum[1] += px[1]; sum[2] += px[2]; n++;
  }
  const s = p.width;
  return { width: (x1 - x0 + 1) / s, left: x0 / s, right: (s - 1 - x1) / s, top: y0 / s, bottom: (s - 1 - y1) / s, far: far / s, mean: sum.map((v) => Math.round(v / n)) as [number, number, number] };
}
/** The four corners (a few pixels in, away from any mask), the colours the background is made of. */
export const corners = (p: Png) => { const d = Math.max(2, Math.round(p.width * 0.02)), s = p.width - 1 - d; return [pixel(p, d, d), pixel(p, s, d), pixel(p, d, s), pixel(p, s, s)]; };
