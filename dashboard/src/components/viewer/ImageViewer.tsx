// dashboard/src/components/viewer/ImageViewer.tsx
// An image of the Bot's workspace (or a file about to be sent) seen without downloading it (contract v0.6 §5.3): the ONLY
// element is an <img> whose src is the blob: URL of a Blob typed by its bytes (image.ts). Never the Markdown renderer (it stays
// image-free), never raw HTML, a frame or a data: URL. A tap opens it full screen, with zoom (pinch on a phone) and
// "Baixar"; the blob: URL is revoked when the preview unmounts.

import React from "react";
import { ApiError } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { checkViewable } from "./viewable";
import { maxPixels } from "./image";
import { XIcon } from "../Icons";

export type ImageView =
  | { kind: "loading" }
  | { kind: "ready"; url: string; width: number; height: number }
  | { kind: "too_large" | "unrecognized_type" | "svg_unsupported" | "redacted" | "error" };

/** Loads once per `id`, checks the bytes (an SVG comes back rasterized to a PNG; a page is no image here), and owns the blob: URL:
 *  revoked on unmount or when the file changes. */
export function useImageView(id: string, name: string, load: () => Promise<Blob>): ImageView {
  const [view, setView] = React.useState<ImageView>({ kind: "loading" });
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setView({ kind: "loading" });
    (async () => {
      try {
        const checked = await checkViewable(await loadRef.current(), name);
        if (!alive) return;
        if (checked.kind === "page") { setView({ kind: "unrecognized_type" }); return; }
        if (checked.kind !== "image") { setView({ kind: checked.kind }); return; }
        url = URL.createObjectURL(checked.blob);
        setView({ kind: "ready", url, width: checked.width, height: checked.height });
      } catch (e) {
        if (!alive) return;
        const code = e instanceof ApiError ? e.code : "";
        setView({ kind: code === "file_redacted" ? "redacted" : code === "too_large" ? "too_large" : "error" });
      }
    })();
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return view;
}

const STATE: Record<Exclude<ImageView["kind"], "ready">, TranslationKey> = {
  loading: "imgLoading", too_large: "imgTooLarge", unrecognized_type: "imgUnrecognized", svg_unsupported: "svgUnsupported", redacted: "imgRedacted", error: "imgError",
};

/** The preview: a thumbnail that opens full screen, or the state in words (a refusal offers the download, when there is one). */
export function ImagePreview({ id, name, load, onDownload, size = "card", fallback = null }: {
  id: string; name: string; load: () => Promise<Blob>; onDownload?: () => void; size?: "card" | "chip"; fallback?: React.ReactNode }) {
  const { t } = useLuveI18n();
  const view = useImageView(id, name, load);
  const [open, setOpen] = React.useState(false);
  const box = size === "chip" ? { width: 32, height: 32 } : { maxWidth: 240, maxHeight: 180 };
  if (view.kind !== "ready") {
    if (size === "chip") return <>{fallback}</>;  // a chip keeps its usual glyph, name and size until (unless) the image is ready
    return (
      <p data-testid="image-state" data-state={view.kind} role={view.kind === "loading" ? "status" : undefined} className="lb-caption" style={{ margin: "4px 4px 8px" }}>
        {t(STATE[view.kind], { mp: maxPixels() / 1_000_000 })}
        {view.kind !== "loading" && onDownload && <>{" "}<button type="button" className="lb-btn lb-btn-plain" onClick={onDownload}>{t("fileDownload")}</button></>}
      </p>
    );
  }
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={t("imgOpenNamed", { name })} data-testid="image-thumb"
        style={{ padding: 0, border: "none", background: "none", cursor: "zoom-in", borderRadius: size === "chip" ? 6 : 12, overflow: "hidden", display: "inline-flex", flexShrink: 0, margin: size === "chip" ? 0 : "4px 4px 8px" }}>
        <img src={view.url} alt={name} style={{ ...box, objectFit: size === "chip" ? "cover" : "contain", display: "block" }} />
      </button>
      {open && <ImageLightbox url={view.url} name={name} width={view.width} height={view.height} onClose={() => setOpen(false)} onDownload={onDownload} />}
    </>
  );
}

// The viewer is dark in both themes, so its header carries its own colors: the theme's text color (dark in light mode) left the
// name and the buttons invisible on it (installed-app photos, 03/10).
const ON_DARK: React.CSSProperties = { color: "#fff", background: "rgba(255, 255, 255, 0.16)" };

/** Full screen: fit to the screen, or 100% with scroll; a phone can also pinch. Escape and "Fechar" close it. */
export function ImageLightbox({ url, name, width, height, onClose, onDownload }: {
  url: string; name: string; width: number; height: number; onClose: () => void; onDownload?: () => void }) {
  const { t } = useLuveI18n();
  const [actual, setActual] = React.useState(false);
  const ref = useFocusTrap<HTMLDivElement>({ isOpen: true, onClose });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t("imgViewerLabel", { name })} data-testid="image-lightbox"
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", flexDirection: "column", background: "rgba(0, 0, 0, 0.92)", color: "#fff", fontFamily: "var(--lb-font)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", paddingTop: "max(10px, env(safe-area-inset-top))" }}>
        <span className="lb-headline lb-truncate" style={{ flex: 1, minWidth: 0, color: ON_DARK.color }}>{name}</span>
        <span className="lb-caption" style={{ color: "rgba(255, 255, 255, 0.7)", whiteSpace: "nowrap" }}>{t("imgDimensions", { w: width, h: height })}</span>
        <button type="button" className="lb-btn" style={ON_DARK} onClick={() => setActual(!actual)} aria-pressed={actual}>{actual ? t("imgZoomFit") : t("imgZoomActual")}</button>
        {onDownload && <button type="button" className="lb-btn" style={ON_DARK} onClick={onDownload}>{t("fileDownload")}</button>}
        <button type="button" className="lb-icon-btn" onClick={onClose} aria-label={t("imgClose")} style={{ color: "#fff" }}><XIcon size={18} /></button>
      </div>
      <div data-testid="image-stage" style={{ flex: 1, minHeight: 0, overflow: "auto", touchAction: "pan-x pan-y pinch-zoom", display: "flex",
        alignItems: actual ? "flex-start" : "center", justifyContent: actual ? "flex-start" : "center", padding: actual ? 0 : 12 }}>
        <img src={url} alt={name} onClick={() => setActual(!actual)}
          style={actual ? { width, height, maxWidth: "none", cursor: "zoom-out" } : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: "zoom-in" }} />
      </div>
    </div>
  );
}
