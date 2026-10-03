// dashboard/src/components/pages/PageEditor.tsx
// Markdown source beside a live preview (v0.5 §6). Autosave after 3 s idle or on blur, never more than once a
// second, always with the sha of the version loaded from the server. A 409 never saves on its own: the person
// compares, takes the Bot's version or writes over it, each by a click. The draft lives in memory only.

import React from "react";
import { Markdown } from "../../lib/render/markdown";
import { getPage, savePage } from "../../api/client";
import type { Page, PageWithContent } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { useNarrow } from "../../hooks/useNarrow";
import { Dialog } from "../ui/Dialog";
import { AUTOSAVE_IDLE_MS, MIN_SAVE_GAP_MS, MAX_PAGE_BYTES, errCode, errDetails, lineDiff } from "./pages";
import { DiffView } from "./DiffView";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

type Status =
  | { kind: "saved"; at?: Date }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "failed"; message: ErrorState }
  | { kind: "conflict"; who: string }
  | { kind: "blocked"; reason: "redacted" | "too_large" | "read_only" };

export interface PageEditorProps {
  bot: string;
  botLabel: string;
  page: PageWithContent;
  onSaved?: (page: Page, content: string) => void;
  onDone: (page: Page, content: string) => void;  // back to the reader with what is on disk now
}

const bytes = (s: string) => new TextEncoder().encode(s).length;
// Below this width (the side panel is 380 px) the source and the preview are one at a time (Editar | Prévia), never squeezed.
export const SIDE_BY_SIDE_MIN = 720;

export function PageEditor({ bot, botLabel, page, onSaved, onDone }: PageEditorProps) {
  const { t, locale } = useLuveI18n();
  const narrow = useNarrow();
  const [text, setText] = React.useState(page.content);
  const [status, setStatus] = React.useState<Status>({ kind: "saved" });
  const [view, setView] = React.useState<"source" | "preview">("source");
  const [dialog, setDialog] = React.useState<null | "leave" | "take" | { compare: string }>(null);
  const [copied, setCopied] = React.useState(false);
  // "Expandir": the editor covers the main area, source and preview wide side by side; "Recolher" or Esc brings it back.
  const [expanded, setExpanded] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(Infinity);  // the editor's own width, not the window's
  React.useEffect(() => {
    const el = rootRef.current;
    const RO = typeof window !== "undefined" ? window.ResizeObserver : undefined;
    if (!el || !RO) return;
    const ro = new RO((entries) => setWidth(entries[0]?.contentRect.width ?? Infinity));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const oneAtATime = narrow || (!expanded && width < SIDE_BY_SIDE_MIN);

  const textRef = React.useRef(text);
  const base = React.useRef(page.sha);            // sha of the version loaded from the server
  const saved = React.useRef(page.content);       // what that version holds
  const current = React.useRef<Page>(page);
  const lastSave = React.useRef(0);
  const inflight = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  textRef.current = text;

  const dirty = text !== saved.current;

  const schedule = (ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), ms);
  };

  async function save() {
    const s = statusRef.current.kind;
    if (inflight.current || s === "conflict" || s === "blocked") return;
    const content = textRef.current;
    if (content === saved.current) return;
    const wait = MIN_SAVE_GAP_MS - (Date.now() - lastSave.current);
    if (wait > 0) { schedule(wait); return; }
    if (bytes(content) > MAX_PAGE_BYTES) { setStatus({ kind: "blocked", reason: "too_large" }); return; }
    inflight.current = true;
    setStatus({ kind: "saving" });
    try {
      const r = await savePage(bot, page.slug, { content, base_sha: base.current });
      base.current = r.page.sha;
      saved.current = content;
      current.current = r.page;
      lastSave.current = Date.now();
      setStatus({ kind: "saved", at: new Date() });
      onSaved?.(r.page, content);
    } catch (e) {
      const code = errCode(e);
      if (code === "page_conflict") {
        const label = errDetails(e).changed_by_label;
        setStatus({ kind: "conflict", who: typeof label === "string" && label ? label : botLabel });
      }
      else if (code === "page_redacted") setStatus({ kind: "blocked", reason: "redacted" });
      else if (code === "too_large") setStatus({ kind: "blocked", reason: "too_large" });
      else if (code === "capability_missing") setStatus({ kind: "blocked", reason: "read_only" });
      else if (code === "rate_limited") { setStatus({ kind: "dirty" }); schedule(MIN_SAVE_GAP_MS); }
      else setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") });
    } finally {
      inflight.current = false;
      lastSave.current = Date.now(); // any attempt counts toward the one-per-second pace
    }
  }

  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Leaving the browser tab with an unsaved draft asks first (the draft is never written to storage).
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const onChange = (v: string) => {
    setText(v);
    if (statusRef.current.kind === "conflict" || statusRef.current.kind === "blocked") return;
    setStatus({ kind: "dirty" });
    schedule(AUTOSAVE_IDLE_MS);
  };

  async function compare() {
    try {
      const fresh = await getPage(bot, page.slug);
      setDialog({ compare: fresh.content });
    } catch (e) { setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") }); }
  }

  /** Take the Bot's version: the draft is dropped only after the person confirmed. */
  async function takeTheirs() {
    setDialog(null);
    try {
      const fresh = await getPage(bot, page.slug);
      base.current = fresh.sha; saved.current = fresh.content; current.current = fresh;
      setText(fresh.content);
      setStatus({ kind: "saved" });
    } catch (e) { setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") }); }
  }

  /** Write mine over theirs: only on this click, with the sha just read; the Bot's version stays in the history. */
  async function writeOver() {
    try {
      const fresh = await getPage(bot, page.slug);
      base.current = fresh.sha;
      setStatus({ kind: "dirty" });
      statusRef.current = { kind: "dirty" };
      lastSave.current = 0;
      await save();
    } catch (e) { setStatus({ kind: "failed", message: humanError(e, t, "unexpectedError") }); }
  }

  async function copyDraft() {
    try { await navigator.clipboard.writeText(textRef.current); setCopied(true); } catch { setCopied(false); }
  }

  const finish = () => (dirty || status.kind === "conflict" ? setDialog("leave") : onDone(current.current, saved.current));

  const statusText =
    status.kind === "saving" ? t("pageSaving")
    : status.kind === "dirty" ? t("pageUnsaved")
    : status.kind === "failed" ? t("pageSaveFailed")
    : status.kind === "conflict" ? t("pageConflictShort")
    : status.kind === "blocked" ? t(status.reason === "redacted" ? "pageRedactedShort" : status.reason === "too_large" ? "pageTooLarge" : "pagesReadOnly")
    : status.at ? t("pageSavedAt", { time: status.at.toLocaleTimeString(locale === "pt" ? "pt-BR" : "en-US", { hour: "2-digit", minute: "2-digit" }) })
    : t("pageNoChanges");
  const dotColor = status.kind === "saved" ? "var(--color-success)" : status.kind === "conflict" || status.kind === "blocked" ? "var(--color-warning)" : status.kind === "failed" ? "var(--color-destructive)" : "var(--color-muted-foreground)";

  const source = (
    <textarea aria-label={t("pageSourceLabel")} value={text} onChange={(e) => onChange(e.target.value)} onBlur={() => void save()}
      spellCheck className="lb-mono" style={{ flex: 1, minHeight: narrow ? 320 : "60vh", width: "100%", resize: "none", border: "none", borderRadius: 16, padding: 16, background: "var(--lb-fill)", color: "var(--color-foreground)", fontSize: 13, lineHeight: "21px" }} />
  );
  const preview = (
    <div aria-label={t("pagePreviewLabel")} role="region" className="lb-group" style={{ flex: 1, minHeight: narrow ? 320 : "60vh", padding: 20, overflowY: "auto" }}>
      <Markdown text={text} />
    </div>
  );

  return (
    <div ref={rootRef} data-expanded={expanded || undefined}
      onKeyDown={(e) => { if (expanded && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setExpanded(false); } }}  // Esc collapses; it does not close the panel
      style={expanded
        ? { position: "fixed", inset: 0, zIndex: 45, display: "flex", flexDirection: "column", minHeight: 0, background: "var(--color-background)", color: "var(--color-foreground)" }
        : { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 12px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div className="lb-title lb-truncate">{page.title}</div>
          <span role="status" className="lb-caption" style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--color-muted-foreground)" }}>
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: dotColor }} />
            {statusText}
          </span>
        </div>
        {status.kind === "failed" && <button type="button" onClick={() => { setStatus({ kind: "dirty" }); statusRef.current = { kind: "dirty" }; void save(); }} className="lb-btn">{t("retry")}</button>}
        {!narrow && (
          <button type="button" onClick={() => setExpanded(!expanded)} aria-pressed={expanded} className="lb-btn">
            {expanded ? t("pageCollapse") : t("pageExpand")}
          </button>
        )}
        <button type="button" onClick={finish} className="lb-btn lb-btn-primary">{t("pageDone")}</button>
      </header>

      {status.kind === "conflict" && (
        <div role="status" className="lb-group" style={{ margin: "0 20px 12px", padding: "12px 16px", background: "color-mix(in srgb, var(--color-warning) 14%, transparent)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span className="lb-subhead" style={{ flex: "1 1 260px" }}>
            {t("pageConflictBody", { who: status.who })}
          </span>
          <button type="button" onClick={() => void compare()} className="lb-btn lb-btn-primary">{t("pageCompare")}</button>
          <button type="button" onClick={() => setDialog("take")} className="lb-btn">{t("pageUseTheirs")}</button>
          <button type="button" onClick={() => void copyDraft()} className="lb-btn">{copied ? t("pageDraftCopied") : t("pageCopyDraft")}</button>
          <button type="button" onClick={() => void writeOver()} className="lb-btn lb-btn-plain" style={{ color: "var(--color-destructive)" }}>{t("pageWriteOver")}</button>
        </div>
      )}
      {status.kind === "blocked" && status.reason === "redacted" && (
        <p role="status" className="lb-alert" style={{ margin: "0 20px 12px" }}>{t("pageRedactedBody")}</p>
      )}

      {oneAtATime ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0, padding: "0 16px 16px" }}>
          <div role="tablist" aria-label={t("pageEditorViews")} className="lb-segmented">
            <button type="button" role="tab" aria-selected={view === "source"} onClick={() => setView("source")} className="lb-segment">{t("pageSourceTab")}</button>
            <button type="button" role="tab" aria-selected={view === "preview"} onClick={() => setView("preview")} className="lb-segment">{t("pagePreviewTab")}</button>
          </div>
          {view === "source" ? source : preview}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: "0 20px 20px" }}>
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>{source}</div>
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>{preview}</div>
        </div>
      )}

      <Dialog open={dialog === "leave"} onClose={() => setDialog(null)} title={t("pageLeaveTitle")} titleId="page-leave-title">
        <div className="lb-dialog-body">
          <p className="lb-body">{t("pageLeaveBody")}</p>
          <div className="lb-dialog-footer">
            <button type="button" onClick={() => setDialog(null)} className="lb-btn">{t("pageKeepEditing")}</button>
            <button type="button" onClick={() => { setDialog(null); onDone(current.current, saved.current); }} className="lb-btn lb-btn-destructive">{t("pageLeaveDiscard")}</button>
          </div>
        </div>
      </Dialog>
      <Dialog open={dialog === "take"} onClose={() => setDialog(null)} title={t("pageUseTheirsTitle", { who: botLabel })} titleId="page-take-title">
        <div className="lb-dialog-body">
          <p className="lb-body">{t("pageUseTheirsBody")}</p>
          <div className="lb-dialog-footer">
            <button type="button" onClick={() => setDialog(null)} className="lb-btn">{t("cancelBtn")}</button>
            <button type="button" onClick={() => void takeTheirs()} className="lb-btn lb-btn-destructive">{t("pageUseTheirs")}</button>
          </div>
        </div>
      </Dialog>
      <Dialog open={!!dialog && typeof dialog === "object"} onClose={() => setDialog(null)} title={t("pageCompareTitle")} titleId="page-compare-title" width={760}>
        <div className="lb-dialog-body">
          {dialog && typeof dialog === "object" && <DiffView lines={lineDiff(dialog.compare, text)} beforeLabel={status.kind === "conflict" ? status.who : botLabel} afterLabel={t("pageYourDraft")} />}
        </div>
      </Dialog>
    </div>
  );
}
