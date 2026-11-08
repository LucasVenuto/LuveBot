// dashboard/src/components/viewer/PageViewer.tsx
// An HTML page of the Bot's workspace, seen isolated (contract v0.6 §5.4 as amended by §15): ONE iframe with sandbox="" (no
// scripts, no same-origin, no forms, no popups, no navigation of the top), referrerpolicy no-referrer, allow="", on the blob: URL
// of the text checkViewable prepared (navigating tags neutralized by name, CSP and referrer metas at byte 0). The warning and the
// close button are LuveBot's, OUTSIDE the frame; the frame cannot draw over them. The URL is revoked on close.
import React from "react";
import { ApiError } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { XIcon } from "../Icons";
import { checkViewable } from "./viewable";
import { ImageLightbox } from "./ImageViewer";

type PageView =
  | { kind: "loading" }
  | { kind: "page"; url: string }
  | { kind: "image"; url: string; width: number; height: number }   // a page name whose bytes are an image: shown as that image
  | { kind: "too_large" | "unrecognized_type" | "svg_unsupported" | "redacted" | "error" };

const STATE: Record<string, TranslationKey> = {
  loading: "imgLoading", too_large: "htmlTooLarge", unrecognized_type: "htmlUnrecognized", svg_unsupported: "svgUnsupported", redacted: "imgRedacted", error: "htmlError",
};
const ON_DARK: React.CSSProperties = { color: "#fff", background: "rgba(255, 255, 255, 0.16)" };

/** The "Abrir página" button of a file card; the viewer loads the page only when it is opened. */
export function PageOpen({ id, name, load, onDownload }: { id: string; name: string; load: () => Promise<Blob>; onDownload?: () => void }) {
  const { t } = useLuveI18n();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button type="button" className="lb-btn" onClick={() => setOpen(true)} aria-label={t("htmlOpenNamed", { name })}>{t("htmlOpen")}</button>
      {open && <PageViewer key={id} name={name} load={load} onDownload={onDownload} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PageViewer({ name, load, onDownload, onClose }: { name: string; load: () => Promise<Blob>; onDownload?: () => void; onClose: () => void }) {
  const { t } = useLuveI18n();
  const [view, setView] = React.useState<PageView>({ kind: "loading" });
  const ref = useFocusTrap<HTMLDivElement>({ isOpen: true, onClose });
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    let alive = true;
    let url: string | null = null;
    (async () => {
      try {
        const checked = await checkViewable(await loadRef.current(), name);
        if (!alive) return;
        if (checked.kind === "page" || checked.kind === "image") {
          url = URL.createObjectURL(checked.blob);
          setView(checked.kind === "page" ? { kind: "page", url } : { kind: "image", url, width: checked.width, height: checked.height });
        } else setView({ kind: checked.kind });
      } catch (e) {
        if (!alive) return;
        const code = e instanceof ApiError ? e.code : "";
        setView({ kind: code === "file_redacted" ? "redacted" : code === "too_large" ? "too_large" : "error" });
      }
    })();
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [name]);

  if (view.kind === "image") return <ImageLightbox url={view.url} name={name} width={view.width} height={view.height} onClose={onClose} onDownload={onDownload} />;
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t("htmlViewerLabel", { name })} data-testid="page-viewer"
      style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", flexDirection: "column", background: "rgba(0, 0, 0, 0.92)", color: "#fff", fontFamily: "var(--lb-font)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", paddingTop: "max(10px, env(safe-area-inset-top))", flexWrap: "wrap" }}>
        <span className="lb-headline lb-truncate" style={{ flex: 1, minWidth: 0, color: "#fff" }}>{name}</span>
        {onDownload && <button type="button" className="lb-btn" style={ON_DARK} onClick={onDownload}>{t("fileDownload")}</button>}
        <button type="button" className="lb-icon-btn" onClick={onClose} aria-label={t("htmlClose")} style={{ color: "#fff" }}><XIcon size={18} /></button>
        <p role="note" className="lb-caption" style={{ flexBasis: "100%", margin: 0, color: "rgba(255, 255, 255, 0.8)" }}>{t("htmlIsolatedNote")}</p>
      </div>
      {view.kind === "page" ? (
        <iframe title={name} src={view.url} sandbox="" referrerPolicy="no-referrer" allow="" loading="lazy" data-testid="page-frame"
          style={{ flex: 1, minHeight: 0, border: "none", background: "#fff" }} />
      ) : (
        <p role={view.kind === "loading" || view.kind === "svg_unsupported" ? "status" : "alert"} className="lb-body" style={{ margin: 16, color: "#fff" }}>
          {t(STATE[view.kind])}
          {view.kind !== "loading" && onDownload && <>{" "}<button type="button" className="lb-btn" style={ON_DARK} onClick={onDownload}>{t("fileDownload")}</button></>}
        </p>
      )}
    </div>
  );
}
