// dashboard/src/lib/avatarPng.ts
// A person's image, from a file chooser to the PNG LuveBot stores (contract v0.11 §2.1 and §2.3). The file is read as BYTES and judged by them (never by its name or type): a PNG, a JPEG
// or a WebP, at most 25 MB and at most the device's pixel cap, BEFORE the browser decodes anything (a small file that claims a huge canvas is a decompression bomb). It is decoded
// honouring its orientation, a square of it is drawn on a 256 x 256 canvas and exported as a NEW PNG: the canvas carries no EXIF, no GPS, no colour profile, none of the file's chunks.
// If that PNG is larger than the server's cap (a noisy image), it is drawn again on an opaque white background (RGB). The server trusts none of this and validates every byte again.

import { headerSize, maxPixels, sniffImage, VIEW_MAX_BYTES, type ImageKind } from "../components/viewer/image";
import { AVATAR_MAX_BYTES } from "../api/client";
import { cropRect, type Crop } from "./avatarCrop";

export const AVATAR_PX = 256;
export type AvatarImageProblem = "not_image" | "unsupported" | "too_big" | "too_many_pixels" | "unreadable";
export class AvatarImageError extends Error {
  constructor(readonly problem: AvatarImageProblem) { super(problem); }
}

const ALLOWED: readonly ImageKind[] = ["png", "jpeg", "webp"];

/** The file's bytes, judged. Throws AvatarImageError; nothing has been decoded when it does. */
export async function readImageFile(file: Blob): Promise<{ bytes: Uint8Array; kind: ImageKind }> {
  if (file.size > VIEW_MAX_BYTES) throw new AvatarImageError("too_big");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw new AvatarImageError("not_image");
  if (!ALLOWED.includes(kind)) throw new AvatarImageError("unsupported");   // a GIF is an image, but not one this takes
  const size = headerSize(kind, bytes);
  if (!size || size.width < 1 || size.height < 1) throw new AvatarImageError("unreadable");
  if (size.width * size.height > maxPixels()) throw new AvatarImageError("too_many_pixels");
  return { bytes, kind };
}

/** Decodes it the way the person's camera meant it (rotated by its orientation). */
export async function decodeImage(bytes: Uint8Array<ArrayBuffer>, kind: ImageKind): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(new Blob([bytes], { type: kind === "jpeg" ? "image/jpeg" : kind === "webp" ? "image/webp" : "image/png" }), { imageOrientation: "from-image" });
  } catch { throw new AvatarImageError("unreadable"); }
}

type Canvas = HTMLCanvasElement;
const canvasOf = (): Canvas => {
  const c = document.createElement("canvas");
  c.width = c.height = AVATAR_PX;
  return c;
};

/** Draws the chosen square of `source` on a 256 x 256 canvas (the same drawing the preview shows). `opaque` paints it on white first and asks for a canvas with no alpha. */
export function drawAvatar(source: CanvasImageSource & { width: number; height: number }, crop: Crop, canvas: Canvas = canvasOf(), opaque = false): Canvas {
  const ctx = canvas.getContext("2d", opaque ? { alpha: false } : undefined)!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (opaque) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX); } else ctx.clearRect(0, 0, AVATAR_PX, AVATAR_PX);
  const r = cropRect(source.width, source.height, crop);
  ctx.drawImage(source, r.sx, r.sy, r.size, r.size, 0, 0, AVATAR_PX, AVATAR_PX);
  return canvas;
}

const toPng = (canvas: Canvas): Promise<Blob> => new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new AvatarImageError("unreadable"))), "image/png"));

/** The PNG to send: transparent-capable first; over the cap, drawn again opaque (RGB). null when even that is over the cap (the caller says so). */
export async function exportAvatarPng(source: CanvasImageSource & { width: number; height: number }, crop: Crop): Promise<Blob | null> {
  const first = await toPng(drawAvatar(source, crop));
  if (first.size <= AVATAR_MAX_BYTES) return first;
  const second = await toPng(drawAvatar(source, crop, canvasOf(), true));
  return second.size <= AVATAR_MAX_BYTES ? second : null;
}
