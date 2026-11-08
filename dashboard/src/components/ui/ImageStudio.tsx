// dashboard/src/components/ui/ImageStudio.tsx
// "Enviar imagem" (contract v0.11 §2.3): a person's own image as a face, for a Bot (its Profile) or for themselves ("Meu Luve"). Two steps in one dialog: choose a file (a file chooser,
// which on a phone also offers the camera), then crop: a square, with a drag, the arrow keys and a zoom, and a preview as it will look round and square. "Usar" draws the chosen square
// on a 256 x 256 canvas, exports a NEW PNG (no EXIF, no GPS, no profile: lib/avatarPng.ts), sends it, and hands back the id the server made; nothing is worn until the screen's own
// "Salvar". The file is judged by its bytes before anything is decoded. A calm text says where the image lives and what "Remover" does. Everything here is reachable by keyboard and
// screen reader. Without the avatar routes in the backend the entry is not shown at all.

import React from "react";
import { Dialog } from "./Dialog";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "./ErrorNote";
import { useAvatarImagesAvailable } from "./avatarImage";
import { uploadAvatar } from "../../api/client";
import { AVATAR_PX, AvatarImageError, decodeImage, drawAvatar, exportAvatarPng, readImageFile, type AvatarImageProblem } from "../../lib/avatarPng";
import { clampCrop, initialCrop, MAX_ZOOM, MIN_ZOOM, panCrop, squareSize, zoomCrop, type Crop } from "../../lib/avatarCrop";

const PROBLEM: Record<AvatarImageProblem, TranslationKey> = {
  not_image: "aviErrNotImage", unsupported: "aviErrUnsupported", too_big: "aviErrTooBig", too_many_pixels: "aviErrPixels", unreadable: "aviErrUnreadable",
};
const ACCEPT = "image/png,image/jpeg,image/webp";
const STEP = 0.05;       // an arrow key moves the square by 5% of its side
const ZOOM_KEY = 0.25;

interface InnerProps { useLabel: string; onUse: (id: string) => void; onClose: () => void }

function Studio({ useLabel, onUse, onClose }: InnerProps) {
  const { t } = useLuveI18n();
  const [bitmap, setBitmap] = React.useState<ImageBitmap | null>(null);
  const [crop, setCrop] = React.useState<Crop>({ zoom: MIN_ZOOM, cx: 0, cy: 0 });
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [busy, setBusy] = React.useState<"reading" | "sending" | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const main = React.useRef<HTMLCanvasElement>(null), round = React.useRef<HTMLCanvasElement>(null), square = React.useRef<HTMLCanvasElement>(null);
  const drag = React.useRef<{ x: number; y: number } | null>(null);
  const helpId = React.useId();

  // the picture the person is looking at is the one that will be sent: the same drawing, on the same 256 x 256
  React.useEffect(() => {
    if (!bitmap || !main.current) return;
    drawAvatar(bitmap, crop, main.current);
    for (const small of [round.current, square.current]) {
      const ctx = small?.getContext("2d");
      if (!small || !ctx) continue;
      ctx.clearRect(0, 0, small.width, small.height);
      ctx.drawImage(main.current, 0, 0, AVATAR_PX, AVATAR_PX, 0, 0, small.width, small.height);
    }
  }, [bitmap, crop]);
  React.useEffect(() => () => { bitmap?.close?.(); }, [bitmap]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setBusy("reading");
    try {
      const { bytes, kind } = await readImageFile(file);
      const next = await decodeImage(bytes as Uint8Array<ArrayBuffer>, kind);
      setBitmap(next);
      setCrop(initialCrop(next.width, next.height));
    } catch (e) {
      setError(e instanceof AvatarImageError ? t(PROBLEM[e.problem]) : t("aviErrUnreadable"));
    } finally { setBusy(null); if (input.current) input.current.value = ""; }
  };

  const send = async () => {
    if (!bitmap || busy) return;
    setError(null); setBusy("sending");
    try {
      const png = await exportAvatarPng(bitmap, crop);
      if (!png) { setError(t("aviErrTooLarge")); return; }
      const sent = await uploadAvatar(png);
      onUse(sent.id);
    } catch (e) { setError(humanError(e, t, "aviErrFailed")); }
    finally { setBusy(null); }
  };

  const move = (c: Crop, dx: number, dy: number): Crop => {
    if (!bitmap) return c;
    const k = squareSize(bitmap.width, bitmap.height, c.zoom) * STEP;
    return clampCrop(bitmap.width, bitmap.height, { ...c, cx: c.cx + dx * k, cy: c.cy + dy * k });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!bitmap) return;
    const w = bitmap.width, h = bitmap.height;
    const act: Record<string, (c: Crop) => Crop> = {
      ArrowLeft: (c) => move(c, -1, 0), ArrowRight: (c) => move(c, 1, 0), ArrowUp: (c) => move(c, 0, -1), ArrowDown: (c) => move(c, 0, 1),
      "+": (c) => zoomCrop(w, h, c, c.zoom + ZOOM_KEY), "=": (c) => zoomCrop(w, h, c, c.zoom + ZOOM_KEY), "-": (c) => zoomCrop(w, h, c, c.zoom - ZOOM_KEY), _: (c) => zoomCrop(w, h, c, c.zoom - ZOOM_KEY),
      Home: () => initialCrop(w, h),
    };
    const f = act[e.key];
    if (!f) return;
    e.preventDefault();
    setCrop(f);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => { drag.current = { x: e.clientX, y: e.clientY }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !bitmap) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    const view = e.currentTarget.getBoundingClientRect().width;
    setCrop((c) => panCrop(bitmap.width, bitmap.height, c, dx, dy, view));
  };
  const onPointerEnd = () => { drag.current = null; };

  return (
    <div className="lb-dialog-body">
      <input ref={input} type="file" accept={ACCEPT} hidden data-testid="avatar-file" onChange={(e) => void choose(e.target.files?.[0])} />
      {!bitmap ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "12px 0" }}>
          <button type="button" className="lb-btn lb-btn-primary" disabled={busy !== null} aria-busy={busy === "reading"} onClick={() => input.current?.click()}>{t("aviPick")}</button>
          <p className="lb-caption" style={{ margin: 0, textAlign: "center" }}>{t("aviPickHint")}</p>
        </div>
      ) : (
        <>
          <div role="group" tabIndex={0} aria-label={t("aviCropLabel")} aria-describedby={helpId} data-testid="avatar-crop" onKeyDown={onKey}
            style={{ display: "flex", justifyContent: "center", outlineOffset: 4, borderRadius: 16 }}>
            <canvas ref={main} width={AVATAR_PX} height={AVATAR_PX} data-testid="avatar-canvas" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
              style={{ width: "min(100%, 280px)", aspectRatio: "1 / 1", borderRadius: 16, background: "var(--lb-fill)", touchAction: "none", cursor: "grab", display: "block" }} />
          </div>
          <p id={helpId} className="lb-caption" style={{ margin: 0, textAlign: "center" }}>{t("aviCropHelp")}</p>
          <label style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="lb-label">{t("aviZoom")}</span>
            <input type="range" min={MIN_ZOOM} max={MAX_ZOOM} step={0.05} value={crop.zoom} data-testid="avatar-zoom" aria-label={t("aviZoom")} style={{ flex: 1, minHeight: 44 }}
              onChange={(e) => setCrop((c) => zoomCrop(bitmap.width, bitmap.height, c, Number(e.target.value)))} />
            <button type="button" className="lb-btn" onClick={() => setCrop(initialCrop(bitmap.width, bitmap.height))}>{t("aviCenter")}</button>
          </label>
          <div style={{ display: "flex", justifyContent: "center", gap: 24 }} aria-hidden="true">
            <figure style={{ margin: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <canvas ref={round} width={64} height={64} data-testid="avatar-preview-round" style={{ width: 64, height: 64, borderRadius: "50%" }} />
              <figcaption className="lb-caption">{t("aviPreviewRound")}</figcaption>
            </figure>
            <figure style={{ margin: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <canvas ref={square} width={64} height={64} data-testid="avatar-preview-square" style={{ width: 64, height: 64, borderRadius: "36%" }} />
              <figcaption className="lb-caption">{t("aviPreviewSquare")}</figcaption>
            </figure>
          </div>
        </>
      )}
      <p className="lb-caption" data-testid="avatar-privacy" style={{ margin: 0 }}>{t("aviPrivacy")}</p>
      {error && <p role="alert" data-testid="avatar-error" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
      <div className="lb-luve-dock">
        <div className="lb-dialog-footer">
          {bitmap && <button type="button" className="lb-btn" disabled={busy !== null} onClick={() => { setBitmap(null); setError(null); }}>{t("aviBack")}</button>}
          <button type="button" className="lb-btn" disabled={busy === "sending"} onClick={onClose}>{t("close")}</button>
          {bitmap && <button type="button" data-testid="avatar-use" className="lb-btn lb-btn-primary" disabled={busy !== null} aria-busy={busy === "sending"} onClick={() => void send()}>{busy === "sending" ? t("aviSending") : useLabel}</button>}
        </div>
      </div>
    </div>
  );
}

export interface ImageStudioProps { open: boolean; onClose: () => void; onUse: (id: string) => void; useLabel: string }

/** The studio as a dialog. It mounts its state only while open, so each opening starts at "choose a file". */
export function ImageStudio({ open, onClose, onUse, useLabel }: ImageStudioProps) {
  const { t } = useLuveI18n();
  return (
    <Dialog open={open} onClose={onClose} title={t("aviTitle")} titleId="lb-avi-title" width={460}>
      <Studio useLabel={useLabel} onUse={onUse} onClose={onClose} />
    </Dialog>
  );
}

/** The buttons next to "Criar seu Luve": "Enviar imagem" (only when the backend has the avatar routes) and, while the face is an image, "Remover imagem". */
export function ImageEntry({ worn, useLabel, onUse, onRemove }: { worn?: boolean; useLabel: string; onUse: (id: string) => void; onRemove?: () => void }) {
  const { t } = useLuveI18n();
  const available = useAvatarImagesAvailable();
  const [open, setOpen] = React.useState(false);
  if (!available) return null;
  return (
    <>
      <button type="button" data-testid="btn-avatar-send" className="lb-btn" onClick={() => setOpen(true)}>{t("aviEnter")}</button>
      {worn && onRemove && <button type="button" data-testid="btn-avatar-remove" className="lb-btn" onClick={onRemove}>{t("aviRemove")}</button>}
      <ImageStudio open={open} onClose={() => setOpen(false)} useLabel={useLabel} onUse={(id) => { onUse(id); setOpen(false); }} />
    </>
  );
}
