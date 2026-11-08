// dashboard/src/lib/avatarCrop.ts
// The square crop of a person's image (contract v0.11 §2.3), as pure arithmetic: which square of the source goes into the 256 x 256 face. At zoom 1 the square is the
// image's shorter side; each step of zoom makes it smaller, down to a quarter. The centre is clamped so the square never leaves the image (no empty corner, ever).

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export interface Crop { zoom: number; cx: number; cy: number }
export interface CropRect { sx: number; sy: number; size: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The side of the square, in source pixels. */
export const squareSize = (w: number, h: number, zoom: number): number => Math.min(w, h) / clamp(zoom, MIN_ZOOM, MAX_ZOOM);

/** The crop a person starts from: the centre of the image, no zoom. */
export const initialCrop = (w: number, h: number): Crop => ({ zoom: MIN_ZOOM, cx: w / 2, cy: h / 2 });

/** The same crop, with a zoom and a centre that keep the square inside the image. A NaN or an infinity is the start (a screen glitch never reaches the canvas). */
export function clampCrop(w: number, h: number, c: Crop): Crop {
  const zoom = Number.isFinite(c.zoom) ? clamp(c.zoom, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM;
  const half = squareSize(w, h, zoom) / 2;
  const cx = Number.isFinite(c.cx) ? clamp(c.cx, half, w - half) : w / 2;
  const cy = Number.isFinite(c.cy) ? clamp(c.cy, half, h - half) : h / 2;
  return { zoom, cx, cy };
}

/** The source rectangle to draw. */
export function cropRect(w: number, h: number, c: Crop): CropRect {
  const k = clampCrop(w, h, c);
  const size = squareSize(w, h, k.zoom);
  return { sx: k.cx - size / 2, sy: k.cy - size / 2, size };
}

/** A drag of `dx`, `dy` view pixels on a viewport `view` pixels wide moves the picture with the finger: the centre goes the other way, scaled to source pixels. */
export function panCrop(w: number, h: number, c: Crop, dx: number, dy: number, view: number): Crop {
  const scale = view > 0 ? squareSize(w, h, c.zoom) / view : 0;
  return clampCrop(w, h, { ...c, cx: c.cx - dx * scale, cy: c.cy - dy * scale });
}

/** A zoom to `next`, keeping the same centre (and the square inside the image). */
export const zoomCrop = (w: number, h: number, c: Crop, next: number): Crop => clampCrop(w, h, { ...c, zoom: next });
