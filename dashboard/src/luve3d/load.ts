// dashboard/src/luve3d/load.ts: the ONE place that puts dist/luve3d.js on the page (proposal "Crie seu Luve" §8 Q2). The URL is a
// constant of the plugin: nothing from a recipe, a Bot or the server goes into it. The file registers window.__LUVEBOT_LUVE3D__
// (luve3d/api.d.ts) and the studio reads only that object. A failure (the file, or no registration) is not cached, so the next
// opening tries again; whoever asked shows the 2D preview meanwhile and after.

import { pluginAssetUrl } from "../pwa/register";
import type { Luve3d } from "./api";

let pending: Promise<Luve3d> | null = null;

export function loadLuve3d(): Promise<Luve3d> {
  if (window.__LUVEBOT_LUVE3D__) return Promise.resolve(window.__LUVEBOT_LUVE3D__);
  pending ??= new Promise<Luve3d>((ok, fail) => {
    const script = document.createElement("script");
    script.src = pluginAssetUrl("dist/luve3d.js");
    script.async = true;
    script.onload = () => {
      pending = null;
      window.__LUVEBOT_LUVE3D__ ? ok(window.__LUVEBOT_LUVE3D__) : fail(new Error("luve3d: not registered"));
    };
    script.onerror = () => { pending = null; script.remove(); fail(new Error("luve3d: could not load")); };
    document.head.appendChild(script);
  });
  return pending;
}
