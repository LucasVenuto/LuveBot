// dashboard/src/components/ui/luve.ts
// "Crie seu Luve" in the page (proposal docs/propostas/v02-crie-seu-luve.md §4 and §8 Q4): a Luve is a RECIPE, checked by
// parseLuve against the fixed lists of the kit, and drawn by buildLuveSvg from pieces shipped in the plugin plus the checked hex.
// This is the ONE place that turns an SVG into a blob: URL for the page (tests/unit/redteam/g3-luve-blob.test.ts): one URL per
// (recipe, state, mini), shared by every face that shows it, revoked when the last one lets go. The state rides on the class
// of the root (is-working / needs-you), never on a fragment of the blob: URL.

import React from "react";
import { buildLuveSvg, parseLuve } from "../../../../assets/mascots/luve.mjs";
import { rasterizeSvg } from "../viewer/document";

export { parseLuve, formatLuve, isRecipe, luvePalette, KIT, SHAPES, MATERIAL_IDS, ACCESSORY_IDS } from "../../../../assets/mascots/luve.mjs";
export type { LuveRecipe } from "../../../../assets/mascots/luve.mjs";

export type LuveState = "working" | "needs_you" | undefined;

const cache = new Map<string, { url: string; uses: number }>();
const keyOf = (value: string, state: LuveState, mini: boolean) => `${value}|${state ?? ""}|${mini ? "mini" : "whole"}`;

/** The blob: URL of a Luve, held until releaseLuve with the same arguments; null when the recipe does not check (the caller shows
 *  the default face) or the browser cannot make one. */
export function acquireLuve(value: string, state: LuveState, mini: boolean): string | null {
  const key = keyOf(value, state, mini), hit = cache.get(key);
  if (hit) { hit.uses++; return hit.url; }
  const svg = buildLuveSvg(parseLuve(value), state, mini);
  if (!svg || typeof URL.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  cache.set(key, { url, uses: 1 });
  return url;
}

export function releaseLuve(value: string, state: LuveState, mini: boolean): void {
  const key = keyOf(value, state, mini), hit = cache.get(key);
  if (!hit || --hit.uses > 0) return;
  URL.revokeObjectURL(hit.url);
  cache.delete(key);
}

/** For tests: how many Luve URLs are alive now. */
export const liveLuveUrls = () => cache.size;

/** A face's Luve URL for as long as the face is on screen (null until it is made, and for anything that is not a recipe). */
export function useLuveSrc(value: string | null | undefined, state: LuveState, mini: boolean): string | null {
  const [src, setSrc] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!value) { setSrc(null); return; }
    const url = acquireLuve(value, state, mini);
    setSrc(url);
    return () => { if (url) releaseLuve(value, state, mini); };
  }, [value, state, mini]);
  return src;
}

export const isLuve = (value: unknown): boolean => parseLuve(value) !== null;

/** The Luve as a square PNG with a transparent background, drawn from the 2D art (the plan B of the studio's PNG when the 3D is not
 *  there). The SVG is built here, from shipped pieces, and only handed to the off-DOM rasterizer. */
export async function luvePng2d(value: string, size = 1024): Promise<Blob> {
  const svg = buildLuveSvg(parseLuve(value), undefined, false);
  if (!svg) throw new Error("luve: recipe does not check");
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);   // Safari draws a viewBox-only SVG at 0 px
  return rasterizeSvg(new Blob([sized], { type: "image/svg+xml" }), { width: size, height: size });
}
