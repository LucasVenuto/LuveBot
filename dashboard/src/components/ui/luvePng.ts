// dashboard/src/components/ui/luvePng.ts: the person's own Luve PNG, made in the browser (the 3D's canvas, else the 2D art) and saved
// from a detached link, like a file the person asked to download. It never goes to the server. The blob: URL is revoked right after.

import type { Luve3dView } from "../../luve3d/api";
import { luvePng2d, parseLuve } from "./luve";

export const PNG_SIZE = 1024;

/** The PNG of a Luve: from the 3D view when there is one (front, transparent), else from the 2D art. */
export async function luvePng(value: string, view: Luve3dView | null): Promise<Blob> {
  if (view) try { return await view.toPNG(PNG_SIZE); } catch { /* a lost WebGL context: the 2D art does it */ }
  return luvePng2d(value, PNG_SIZE);
}

export const pngName = (value: string): string => `luve-${parseLuve(value)?.shape ?? "luve"}.png`;

export function savePng(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
