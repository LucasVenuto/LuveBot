// dashboard/src/components/viewer/viewable.ts
// One decision for every file the viewer opens (contract v0.6 §5.1): a raster image by its signature, whatever its name; else an
// SVG or an HTML page only when the name AGREES with the bytes; else "tipo não reconhecido". An SVG comes back as the PNG it was
// rasterized to, never as SVG; a page comes back as the text its frame will load, already neutralized and prefixed.
import { checkImage, maxPixels, VIEW_MAX_BYTES, sniffImage } from "./image";
import { TEXT_MAX_BYTES, utf8, isSvg, svgSize, canvasSize, rasterizeSvg, isHtml, frameText } from "./document";

export type Viewable =
  | { kind: "image"; blob: Blob; width: number; height: number }
  | { kind: "page"; blob: Blob }
  | { kind: "too_large" | "unrecognized_type" | "svg_unsupported" | "error" };   // svg_unsupported: the browser would not turn it into a PNG (red team V2)

export async function checkViewable(file: Blob, name: string): Promise<Viewable> {
  if (file.size > VIEW_MAX_BYTES) return { kind: "too_large" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (sniffImage(bytes)) {
    const raster = await checkImage(new Blob([bytes]));
    return raster.kind === "ready" ? { kind: "image", blob: raster.blob, width: raster.width, height: raster.height } : raster;
  }
  if (bytes.length > TEXT_MAX_BYTES) return /\.(svg|html?)$/i.test(name) ? { kind: "too_large" } : { kind: "unrecognized_type" };
  const text = utf8(bytes);
  if (isSvg(name, text)) {
    const size = svgSize(text!);
    if (size.width * size.height > maxPixels()) return { kind: "too_large" };   // the pixel cap, read from the root before drawing
    try {
      const png = await rasterizeSvg(new Blob([bytes], { type: "image/svg+xml" }), size);
      return { kind: "image", blob: png, ...canvasSize(size) };
    } catch (e) {
      // The browser's own answer decides, never a guess at the markup: an SVG with <foreignObject> taints the canvas and toBlob throws a
      // SecurityError. It is NOT shown any other way (no <img src=blob:>, no frame): a second SVG sink is what rasterizing is there to prevent.
      return { kind: (e as { name?: string } | null)?.name === "SecurityError" ? "svg_unsupported" : "error" };
    }
  }
  if (isHtml(name, bytes, text)) return { kind: "page", blob: new Blob([frameText(text!)], { type: "text/html;charset=utf-8" }) };
  return { kind: "unrecognized_type" };
}
