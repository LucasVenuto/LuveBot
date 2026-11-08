// dashboard/src/components/viewer/document.ts
// The two text documents a Bot's workspace can show (contract v0.6 §5.1-§5.4 as amended by §15): an SVG is NEVER on screen as
// an SVG, it is rasterized off-DOM to a PNG (B1: a blob: URL has the dashboard's origin); an HTML page goes into one iframe with
// sandbox="", after every tag that can navigate or load is neutralized by its NAME and a CSP and a no-referrer meta are put at
// byte 0 (B2). The bytes decide, and the name must AGREE for these two kinds.
import { sniffImage, MAX_PIXELS } from "./image";

export const TEXT_MAX_BYTES = 10 * 1024 * 1024;   // Q11: HTML and SVG viewed up to 10 MiB
export const DISPLAY_BOX = { width: 1200, height: 900 };   // an SVG without a usable size is drawn at the viewer's box
const CANVAS_SIDE = 4096, CANVAS_AREA = 16_000_000;     // the iOS canvas limit

/** UTF-8 text, or null when the bytes do not decode (fatal: no replacement characters). */
export function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

/** An SVG by §5.1 (A-87, B4): the name ends .svg, the text decodes, nothing HTML or DTD-like, and the ROOT element is <svg after an
 *  optional BOM, whitespace, one <?xml …?>, comments and an optional <!DOCTYPE svg …> without an internal subset. */
export function isSvg(name: string, text: string | null): boolean {
  if (!/\.svg$/i.test(name) || text === null) return false;
  if (/<!DOCTYPE\s+html/i.test(text) || /<html[\s>/]/i.test(text) || /<!ENTITY/i.test(text)) return false;
  let rest = text.replace(/^\ufeff/, "");
  let xmlDecl = false;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (!xmlDecl && rest.startsWith("<?xml")) { const end = rest.indexOf("?>"); if (end < 0) return false; rest = rest.slice(end + 2); xmlDecl = true; continue; }
    if (rest.startsWith("<!--")) { const end = rest.indexOf("-->"); if (end < 0) return false; rest = rest.slice(end + 3); continue; }
    if (/^<!DOCTYPE\s+svg\b/i.test(rest)) {
      const end = rest.indexOf(">");
      if (end < 0 || rest.slice(0, end).includes("[")) return false;   // an internal subset: refused before decoding (B4)
      rest = rest.slice(end + 1);
      continue;
    }
    return /^<svg[\s>/]/.test(rest);
  }
}

const length = (raw: string | undefined): number | null => {
  const m = raw?.trim().match(/^([0-9]*\.?[0-9]+)(px)?$/);   // user units or px; a percentage or another unit is no size
  return m ? Number(m[1]) : null;
};

/** The SVG's size from its root (§5.2): width and height, else the viewBox, in user units; else the display box. */
export function svgSize(text: string): { width: number; height: number } {
  const tag = text.match(/<svg\b[^>]*>/)?.[0] ?? "";
  const attr = (name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`))?.[1];
  const w = length(attr("width")), h = length(attr("height"));
  if (w && h) return { width: w, height: h };
  const box = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  return { ...DISPLAY_BOX };
}

/** The canvas for a rasterized SVG: the header size, scaled down so the longest side is ≤ 4096 px and the area ≤ 16 MP. */
export function canvasSize(size: { width: number; height: number }): { width: number; height: number } {
  let scale = Math.min(1, CANVAS_SIDE / Math.max(size.width, size.height));
  scale = Math.min(scale, Math.sqrt(CANVAS_AREA / (size.width * size.height)));
  return { width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) };
}

/** Draws the SVG on a canvas through an off-DOM image (never attached; image mode runs no script and loads nothing) and returns
 *  the PNG. The SVG's blob: URL is revoked as soon as the image decoded. */
export async function rasterizeSvg(svg: Blob, size: { width: number; height: number }): Promise<Blob> {
  const target = canvasSize(size);
  const url = URL.createObjectURL(svg);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const canvas = document.createElement("canvas");   // off-DOM too
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(img, 0, 0, target.width, target.height);
  return new Promise<Blob>((ok, fail) => canvas.toBlob((png) => (png ? ok(png) : fail(new Error("no png"))), "image/png"));
}

/** An HTML page by §5.1: the name ends .html/.htm, the bytes are no image signature, and they decode as UTF-8. */
export function isHtml(name: string, bytes: Uint8Array, text: string | null): boolean {
  return /\.html?$/i.test(name) && sniffImage(bytes) === null && text !== null;
}

const NAVIGATING = /<(meta|link|base|iframe|frame|frameset|object|embed|portal|area)(?=[\s/>])/gi;
// A link too (red team V1): clicking one inside a sandbox="" frame still navigates the FRAME itself, so a page the Bot wrote could load a
// page from outside under LuveBot's own header. Start and end tags are renamed by NAME like the rest; the CSS in the prefix keeps its look.
const LINKS = /<(\/?)a(?=[\s/>])/gi;
export const FRAME_PREFIX =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'">` +
  `<meta name="referrer" content="no-referrer">` +
  `<style>x-luvebot-a[href]{color:#2563eb;text-decoration:underline;cursor:default}</style>`;

// A doctype only counts at byte 0 (after a BOM and ASCII whitespace). The prefix goes first for the CSP, so a doctype behind it was ignored and
// every page opened in quirks mode (red team V3). Never made up: a page with no doctype opens as the Bot's own file would (quirks).
const DOCTYPE = /^\uFEFF?[\t\n\f\r ]*(<!doctype\b[^>]*>)/i;

/** The text that becomes the frame's blob: every navigating or loading tag, and every link, renamed to an inert element FIRST (by its name,
 *  which the parser never decodes), then the CSP, referrer meta and link look before any content (§5.4 steps 2, 1, 3). The page's own doctype,
 *  when it has one at byte 0, is taken out and put first, so the parser still sees it as the document's doctype and the CSP is still the
 *  first thing that is not a doctype (a doctype loads nothing, not even with SYSTEM "http://…"). */
export function frameText(page: string): string {
  const found = DOCTYPE.exec(page);
  const doctype = found ? found[1] : "";
  const rest = found ? page.slice(found[0].length) : page;
  return doctype + FRAME_PREFIX + rest.replace(NAVIGATING, "<x-luvebot-off").replace(LINKS, "<$1x-luvebot-a");
}

export { MAX_PIXELS };
