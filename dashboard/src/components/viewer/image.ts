// dashboard/src/components/viewer/image.ts
// Which image a file really is, and how big, from its BYTES (contract v0.6 §5.1 and §5.2): never from the name or the server's
// type. The pixel count comes from the format's own header, read before anything is decoded, so a small file that claims a
// huge canvas (a decompression bomb) is refused without ever reaching the decoder. SVG and HTML are not images here (v0.6
// part B, after the backend): their bytes match no row and they are "tipo não reconhecido".

export type ImageKind = "png" | "jpeg" | "gif" | "webp";
export const IMAGE_TYPES: Record<ImageKind, string> = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
export const VIEW_MAX_BYTES = 25 * 1024 * 1024;  // the download route's DOWNLOAD_MAX
export const MAX_PIXELS = 50_000_000;            // A-83: 50 megapixels
export const MAX_PIXELS_TOUCH = 25_000_000;      // a phone or tablet (a coarse pointer): half. The decoded picture is 4 bytes a pixel and is made twice (the check, then the <img>);
                                                 // the WebKit limit was not measured, so the cap there is conservative (2nd cross review F11)
/** The pixel cap for THIS device: 50 megapixels, 25 on a touch screen. */
export function maxPixels(): number {
  try { return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? MAX_PIXELS_TOUCH : MAX_PIXELS; } catch { return MAX_PIXELS; }
}

const ascii = (b: Uint8Array, at: number, text: string) => text.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/** The kind by the file's signature; null when no row matches (a .png holding text, HTML or SVG included). */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 6 && (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return "gif";
  if (b.length >= 12 && ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "webp";
  return null;
}

const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const le24 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

/** GIF: the logical screen, grown to the first frame when that frame reaches past it (a browser draws the frame whole, F5:
 *  a 1x1 screen with a huge first frame is the bomb). The first image descriptor is found by walking the blocks before it. */
function gifSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 13) return null;
  let width = le16(b, 6), height = le16(b, 8);
  let i = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);   // past the global color table
  while (i < b.length) {
    if (b[i] === 0x2c) {                                                  // the first image descriptor
      if (i + 9 > b.length) break;
      width = Math.max(width, le16(b, i + 1) + le16(b, i + 5));
      height = Math.max(height, le16(b, i + 3) + le16(b, i + 7));
      break;
    }
    if (b[i] !== 0x21) break;                                             // only extensions come before it
    i += 2;
    while (i < b.length && b[i] !== 0) i += b[i] + 1;                      // its sub-blocks
    i += 1;
  }
  return { width, height };
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;               // markers only, scanned by their lengths: nothing is decoded
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }    // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }  // no length
    if (marker === 0xd9 || marker === 0xda) return null;  // end of image or scan data before any frame header
    const length = be16(b, i + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= b.length) return null;
      return { height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/** Width and height from the header (§5.2 table); null when the header cannot be read. */
export function headerSize(kind: ImageKind, b: Uint8Array): { width: number; height: number } | null {
  if (kind === "png") return b.length >= 24 && ascii(b, 12, "IHDR") ? { width: be32(b, 16), height: be32(b, 20) } : null;
  if (kind === "gif") return gifSize(b);
  if (kind === "jpeg") return jpegSize(b);
  if (b.length >= 30 && ascii(b, 12, "VP8X")) return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  if (b.length >= 25 && ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (b.length >= 30 && ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  return null;
}

export type Checked =
  | { kind: "ready"; blob: Blob; type: string; width: number; height: number }
  | { kind: "too_large" | "unrecognized_type" | "error" };

/** Everything the browser does before an <img> may show the file: size, signature, header pixels, then ONE decode as a second
 *  check. The returned Blob carries the type the bytes decided, never the server's. */
export async function checkImage(file: Blob): Promise<Checked> {
  if (file.size > VIEW_MAX_BYTES) return { kind: "too_large" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return { kind: "unrecognized_type" };
  const size = headerSize(kind, bytes);
  if (!size || size.width < 1 || size.height < 1) return { kind: "error" };  // a header that cannot be read: download only
  if (size.width * size.height > maxPixels()) return { kind: "too_large" };  // the bomb never reaches the decoder
  const blob = new Blob([bytes], { type: IMAGE_TYPES[kind] });
  try {
    await decodeOnce(blob);
  } catch {
    return { kind: "error" };
  }
  return { kind: "ready", blob, type: IMAGE_TYPES[kind], ...size };
}

/** The decoder's own check (createImageBitmap, else <img>.decode()); throws when the bytes do not decode. */
async function decodeOnce(blob: Blob): Promise<void> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    bitmap.close?.();
    return;
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    if (typeof img.decode !== "function") throw new Error("no decoder");
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
}
