// "Enviar imagem" in a real Chrome (contract v0.11 §2.3): the REAL ImageEntry/ImageStudio with the API mocked (the backend is AV-1/AV-3). The page records every body the studio
// POSTs to /avatars (the PNG it exported) so the script can check it byte for byte, and builds test images in the page (two colours, a JPEG with an EXIF orientation and a marker).
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ImageEntry } from "@repo/dashboard/src/components/ui/ImageStudio";
import { setCustomFetchJSON, setCachedCsrf } from "@repo/dashboard/src/api/client";
import { setLuveLocale } from "@repo/dashboard/src/i18n";

const q = new URLSearchParams(location.search);
setLuveLocale("pt");
setCachedCsrf("csrf");
const H: any = { sent: [] as Blob[], used: [] as string[], removed: 0 };
(window as any).H = H;
(window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async () => new Response(JSON.stringify({ error: { code: "avatar_not_found", message: "x" } }), { status: 404 }) };
setCustomFetchJSON(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/session")) return { csrf: "csrf", actor: "x", auth_mode: "gated" };
  if (url.endsWith("/avatars") && init?.method === "POST") { H.sent.push(init.body as Blob); return { id: "img_" + "0".repeat(31) + String(H.sent.length), width: 256, height: 256, bytes: (init.body as Blob).size }; }
  return {};
});

const paint = (w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")!); return c; };
const toBytes = async (c: HTMLCanvasElement, type: string) => new Uint8Array(await (await new Promise<Blob>((ok) => c.toBlob((b) => ok(b!), type, 0.92))).arrayBuffer());
H.png = async (w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, name = "foto.png") => new File([await toBytes(paint(w, h, draw), "image/png")], name, { type: "image/png" });
/** left half red, right half blue */
H.leftRight = (w: number, h: number) => (c: CanvasRenderingContext2D) => { c.fillStyle = "#ff0000"; c.fillRect(0, 0, w / 2, h); c.fillStyle = "#0000ff"; c.fillRect(w / 2, 0, w / 2, h); };
/** a JPEG carrying an EXIF APP1 with Orientation = `orientation` and a recognisable marker string (stands for GPS, camera serial...) */
H.jpegWithExif = async (w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, orientation: number, marker: string) => {
  const jpeg = await toBytes(paint(w, h, draw), "image/jpeg");
  const m = new TextEncoder().encode(marker);
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
  const payload = [...new TextEncoder().encode("Exif"), 0, 0, ...tiff, ...m];
  const len = payload.length + 2;
  const seg = new Uint8Array([0xff, 0xe1, len >> 8, len & 255, ...payload]);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.slice(0, 2), 0); out.set(seg, 2); out.set(jpeg.slice(2), 2 + seg.length);
  return new File([out], "camera.jpg", { type: "image/jpeg" });
};
H.choose = (file: File) => { const input = document.querySelector<HTMLInputElement>('[data-testid="avatar-file"]')!; const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
H.pixelsOf = async (blob: Blob, points: [number, number][]) => { const bmp = await createImageBitmap(blob); const c = paint(bmp.width, bmp.height, (x) => x.drawImage(bmp, 0, 0)); const x = c.getContext("2d")!; return { w: bmp.width, h: bmp.height, px: points.map(([a, b]) => Array.from(x.getImageData(a, b, 1, 1).data)) }; };
H.bytesOf = async (blob: Blob) => { const u = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

const scheme = q.get("scheme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <div className="lb-root" data-lb-scheme={scheme} style={{ padding: 16, minHeight: "100vh", background: "var(--color-background)", color: "var(--color-foreground)" }}>
    <div style={{ display: "flex", gap: 8 }}><ImageEntry worn useLabel="Usar em Vendas" onUse={(id) => H.used.push(id)} onRemove={() => { H.removed++; }} /></div>
  </div>,
);
