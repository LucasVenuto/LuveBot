// dashboard/src/components/screen/novnc.ts
// noVNC 1.7.0 is vendored UNMODIFIED in dashboard/vendor/novnc (D-007 §3) and loaded at run time by import() of its URL,
// never bundled: Hermes serves the plugin's .js files (dashboard_ui.py), the bundle stays small, and the vendored files
// remain the exact upstream source the MPL-2.0 asks for.

import { getPluginBasePath } from "../../pwa/register";

/** The part of noVNC's RFB this tab uses (core/rfb.js). */
export interface RFBLike extends EventTarget {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  disconnect(): void;
  focus(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}
export type RFBCtor = new (target: HTMLElement, channel: WebSocket, options?: Record<string, unknown>) => RFBLike;

export const novncUrl = () => `${getPluginBasePath()}/dashboard-plugins/luvebot/vendor/novnc/core/rfb.js`;

let loading: Promise<RFBCtor> | null = null;
export function loadRFB(): Promise<RFBCtor> {
  const url = novncUrl();  // a runtime string: esbuild leaves this import() alone, so noVNC never enters the bundle
  loading ??= (import(/* @vite-ignore */ url) as Promise<{ default: RFBCtor }>).then((m) => m.default).catch((e) => { loading = null; throw e; });
  return loading;
}

/** The Hermes display socket (hermes_cli/web_routers/display.py): same host, the single-use ticket in the query. */
export function screenSocketUrl(path: string, ticket: string): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${getPluginBasePath()}${path}?display_ticket=${encodeURIComponent(ticket)}`;
}

/** A typed character as an X keysym (Latin-1 is the code point; anything else is 0x01000000 + code point). */
export const keysymOf = (ch: string): number => { const c = ch.codePointAt(0) ?? 0; return c < 0x100 ? c : 0x01000000 + c; };
export const XK_RETURN = 0xff0d;
export const XK_BACKSPACE = 0xff08;

/** What noVNC's canvas shows, as a small sample (64x40), or "blank" before anything was drawn; null when it cannot be read.
 *  Only compared with the previous sample, never kept or sent. ponytail: a change smaller than one sample cell can be
 *  missed, which at worst shows the warning with "Reconectar"; sample finer if that shows up. */
const SAMPLE_W = 64, SAMPLE_H = 40;
let sampler: CanvasRenderingContext2D | null = null;
export function canvasSignature(canvas: HTMLCanvasElement | null): string | null {
  if (!canvas || !canvas.width || !canvas.height) return "blank";
  try {
    if (!sampler) { const c = document.createElement("canvas"); c.width = SAMPLE_W; c.height = SAMPLE_H; sampler = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null; }
    if (!sampler) return null;
    sampler.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
    sampler.drawImage(canvas, 0, 0, SAMPLE_W, SAMPLE_H);
    const d = sampler.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let alpha = 0, h = 0x811c9dc5;
    for (let i = 0; i < d.length; i++) { if ((i & 3) === 3) alpha += d[i]; h = Math.imul(h ^ d[i], 0x01000193) >>> 0; }
    return alpha === 0 ? "blank" : h.toString(36);
  } catch { return null; }
}
