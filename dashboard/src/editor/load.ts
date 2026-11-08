// dashboard/src/editor/load.ts: the ONE place that would put dist/editor.js on the page (ADR-009 §6), the pattern of luve3d/load.ts. The URL is a
// constant of the plugin: nothing from a page, a Bot or the server goes into it. The file registers window.__LUVEBOT_EDITOR__ (editor/api.d.ts)
// and the page editor reads only that object. A failure (the file, or no registration) is not cached and is never an error screen: whoever
// asked stays in the Markdown source.
//
// There is NO such file today (D-029, option C), so the page editor does not ask for it: VISUAL_EDITOR_FILE flips to true in the same change
// that adds the library to scripts/build.js, and until then the only editor an opened page can get is one that is already registered.

import React from "react";
import { pluginAssetUrl } from "../pwa/register";
import type { PageEditorSeam } from "./api";

/** True only when dist/editor.js is part of the build. */
export const VISUAL_EDITOR_FILE = false;

let pending: Promise<PageEditorSeam> | null = null;

export function loadEditor(): Promise<PageEditorSeam> {
  if (window.__LUVEBOT_EDITOR__) return Promise.resolve(window.__LUVEBOT_EDITOR__);
  pending ??= new Promise<PageEditorSeam>((ok, fail) => {
    const script = document.createElement("script");
    script.src = pluginAssetUrl("dist/editor.js");
    script.async = true;
    script.onload = () => {
      pending = null;
      window.__LUVEBOT_EDITOR__ ? ok(window.__LUVEBOT_EDITOR__) : fail(new Error("editor: not registered"));
    };
    script.onerror = () => { pending = null; script.remove(); fail(new Error("editor: could not load")); };
    document.head.appendChild(script);
  });
  return pending;
}

/** The visual editor when there is one (already registered, or loadable and the build has the file); null otherwise, and the source editor is used. */
export function useEditorSeam(): PageEditorSeam | null {
  const [seam, setSeam] = React.useState<PageEditorSeam | null>(() => (typeof window !== "undefined" ? window.__LUVEBOT_EDITOR__ ?? null : null));
  React.useEffect(() => {
    if (seam || !VISUAL_EDITOR_FILE) return;
    let alive = true;
    loadEditor().then((s) => { if (alive) setSeam(s); }, () => { /* stays in the source */ });
    return () => { alive = false; };
  }, [seam]);
  return seam;
}
