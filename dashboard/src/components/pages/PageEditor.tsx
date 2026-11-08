// dashboard/src/components/pages/PageEditor.tsx
// Markdown source beside a live preview (v0.5 §6), with a toolbar and shortcuts that only INSERT Markdown the safe renderer understands
// (ADR-009 option C, D-029). Autosave after 3 s idle or on blur, never more than once a second, always with the sha of the version loaded
// from the server, and NEVER without an edit: opening and closing a page leaves its bytes as they were (R1; the page's own line ending is
// kept, pages/eol.ts). A 409 never saves on its own: the person compares, takes the Bot's version or writes over it, each by a click.
// Leaving with changes first shows what changed (the 21a diff, plain text). The draft lives in memory only. A visual editor, when a
// library is bundled one day, plugs in through window.__LUVEBOT_EDITOR__ (editor/api.d.ts) and changes nothing of the above.

import React from "react";
import { Markdown } from "../../lib/render/markdown";
import { getPage, savePage } from "../../api/client";
import type { Page, PageWithContent } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { useNarrow } from "../../hooks/useNarrow";
import { Dialog } from "../ui/Dialog";
import { AUTOSAVE_IDLE_MS, MIN_SAVE_GAP_MS, MAX_PAGE_BYTES, errCode, errDetails, lineDiff } from "./pages";
import { DiffView } from "./DiffView";
import { FormatBar } from "./FormatBar";
import { applyFormat, shortcutOf, type Edit, type FormatKind } from "./format";
import { eolOf, toDisk, toView, type Eol } from "./eol";
import { useEditorSeam } from "../../editor/load";
import type { PageEditorSeam, PageEditorView } from "../../editor/api";
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

/** Where a registered visual editor (editor/api.d.ts) lives. It gets the page once, at mount; the page editor asks for the Markdown only after it
 *  says the person edited (R1), and a visual editor that cannot hold this page (it throws) leaves the source editor in its place. */
function VisualHost({ seam, text, onMarkdown, onFail }: { seam: PageEditorSeam; text: string; onMarkdown: (shown: string) => void; onFail: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const initial = React.useRef(text);
  const latest = React.useRef(onMarkdown);
  latest.current = onMarkdown;
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let view: PageEditorView | null = null;
    try { view = seam.mount(el, { text: initial.current, onChange: () => { if (view) latest.current(view.getMarkdown()); } }); }
    catch { onFail(); return; }
    return () => { view?.destroy(); view = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seam]);
  return <div ref={ref} data-testid="visual-editor" style={{ flex: 1, minHeight: 320 }} />;
}
// Below this width (the side panel is 380 px) the source and the preview are one at a time (Editar | Prévia), never squeezed.
export const SIDE_BY_SIDE_MIN = 720;

export function PageEditor({ bot, botLabel, page, onSaved, onDone }: PageEditorProps) {
  const { t, locale } = useLuveI18n();
  const narrow = useNarrow();
  const [text, setText] = React.useState(page.content);
  const [status, setStatus] = React.useState<Status>({ kind: "saved" });
  const [view, setView] = React.useState<"source" | "preview">("source");
  const [dialog, setDialog] = React.useState<null | "review" | "changes" | "take" | { compare: string }>(null);
  const seam = useEditorSeam();
  const [seamFailed, setSeamFailed] = React.useState(false);
  const [seamKey, setSeamKey] = React.useState(0);   // a new key mounts the visual editor again, with the text taken from the Bot
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
  const eol = React.useRef<Eol>(eolOf(page.content));   // the page's own line ending: the editor shows "\n" and writes this one back
  const opened = React.useRef(page.content);            // the text when the editor opened (or when the Bot's version was taken): "what I changed" is against it
  const area = React.useRef<HTMLTextAreaElement>(null);
  const selectAfter = React.useRef<{ start: number; end: number } | null>(null);
  const lastSave = React.useRef(0);
  const inflight = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  textRef.current = text;

  const dirty = text !== saved.current;
  const changed = text !== opened.current;

  const schedule = (ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), ms);
  };

  /** Saves the text now when it differs from what is on disk. -> true when what is on disk IS the text after this call. */
  async function save(): Promise<boolean> {
    const s = statusRef.current.kind;
    if (inflight.current || s === "conflict" || s === "blocked") return false;
    const content = textRef.current;
    if (content === saved.current) return true;
    const wait = MIN_SAVE_GAP_MS - (Date.now() - lastSave.current);
    if (wait > 0) { schedule(wait); return false; }
    if (bytes(content) > MAX_PAGE_BYTES) { setStatus({ kind: "blocked", reason: "too_large" }); return false; }
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
      return textRef.current === content;     // typed more while it was in flight: that part is still unsaved
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
      return false;
    } finally {
      inflight.current = false;
      lastSave.current = Date.now(); // any attempt counts toward the one-per-second pace
    }
  }

  // Leaving the screen with something typed and not saved (another Bot clicked, a tab changed) saves it NOW: a save asked within a second of the last
  // one was only a timer, and the timer dies with the screen (red team E1). Not when the person chose "Sair sem salvar", and never in a conflict.
  const saveRef = React.useRef(save);
  saveRef.current = save;
  const discarded = React.useRef(false);
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (discarded.current || textRef.current === saved.current) return;
    void (async () => {
      for (let i = 0; i < 100 && inflight.current; i++) await new Promise((r) => setTimeout(r, 50));
      lastSave.current = 0;                      // the pace is for typing, not for leaving
      await saveRef.current();
    })();
  }, []);

  // Leaving the browser tab with an unsaved draft asks first (the draft is never written to storage).
  React.useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** The page text changed by the person (the textarea, a toolbar button or a visual editor). Back to what is on disk: nothing to save. */
  const edit = (disk: string) => {
    textRef.current = disk;                       // a save that fires before the next render (a blur right after a keystroke) sees it
    setText(disk);
    if (statusRef.current.kind === "conflict" || statusRef.current.kind === "blocked") return;
    if (disk === saved.current) {
      if (timer.current) clearTimeout(timer.current);
      if (statusRef.current.kind === "dirty" || statusRef.current.kind === "failed") { statusRef.current = { kind: "saved" }; setStatus({ kind: "saved" }); }
      return;
    }
    statusRef.current = { kind: "dirty" };
    setStatus({ kind: "dirty" });
    schedule(AUTOSAVE_IDLE_MS);
  };
  const onChange = (shown: string) => edit(toDisk(shown, eol.current));

  // After a toolbar change made through React state (no execCommand), the selection goes back where the format put it.
  React.useLayoutEffect(() => {
    const sel = selectAfter.current, el = area.current;
    if (!sel || !el) return;
    selectAfter.current = null;
    el.focus();
    el.setSelectionRange(sel.start, sel.end);
  });

  /** Puts a toolbar or shortcut result in the textarea. Through the browser's own insertText when it has one, so Ctrl+Z undoes it; else through state. */
  function format(kind: FormatKind) {
    const el = area.current;
    if (!el) return;
    const before = el.value;
    const next: Edit | null = applyFormat(kind, before, el.selectionStart, el.selectionEnd, t("fmtLinkText"));
    if (!next || next.value === before) return;
    let p = 0;
    while (p < before.length && p < next.value.length && before[p] === next.value[p]) p++;
    let q = 0;
    while (q < before.length - p && q < next.value.length - p && before[before.length - 1 - q] === next.value[next.value.length - 1 - q]) q++;
    const insert = next.value.slice(p, next.value.length - q);
    el.focus();
    el.setSelectionRange(p, before.length - q);
    let done = false;
    try { done = typeof document.execCommand === "function" && (insert ? document.execCommand("insertText", false, insert) : document.execCommand("delete")); } catch { done = false; }
    if (done && el.value === next.value) { el.setSelectionRange(next.start, next.end); return; }
    selectAfter.current = { start: next.start, end: next.end };
    onChange(next.value);
  }

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
      eol.current = eolOf(fresh.content); opened.current = fresh.content;
      setSeamKey((k) => k + 1);
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

  // Leaving with changes (this session's, saved or not) first shows what changed; with none, the page closes with its bytes untouched.
  const finish = () => (dirty || changed || status.kind === "conflict" ? setDialog("review") : onDone(current.current, saved.current));

  /** "Salvar e sair": the save the idle timer would do, now, and out only when the server took it. */
  async function saveAndLeave() {
    if (timer.current) clearTimeout(timer.current);
    for (let i = 0; i < 100 && inflight.current; i++) await new Promise((r) => setTimeout(r, 50));
    lastSave.current = 0;
    const ok = await save();
    setDialog(null);
    if (ok) onDone(current.current, saved.current);
  }
  /** "Sair sem salvar": what was typed is dropped, so the autosave that was waiting for it must not fire. */
  const discard = () => {
    discarded.current = true;
    if (timer.current) clearTimeout(timer.current);
    setDialog(null);
    onDone(current.current, saved.current);
  };
  const canSave = dirty && status.kind !== "conflict" && status.kind !== "blocked";

  const statusText =
    status.kind === "saving" ? t("pageSaving")
    : status.kind === "dirty" ? t("pageUnsaved")
    : status.kind === "failed" ? t("pageSaveFailed")
    : status.kind === "conflict" ? t("pageConflictShort")
    : status.kind === "blocked" ? t(status.reason === "redacted" ? "pageRedactedShort" : status.reason === "too_large" ? "pageTooLarge" : "pagesReadOnly")
    : status.at ? t("pageSavedAt", { time: status.at.toLocaleTimeString(locale === "pt" ? "pt-BR" : "en-US", { hour: "2-digit", minute: "2-digit" }) })
    : t("pageNoChanges");
  const dotColor = status.kind === "saved" ? "var(--color-success)" : status.kind === "conflict" || status.kind === "blocked" ? "var(--color-warning)" : status.kind === "failed" ? "var(--color-destructive)" : "var(--color-muted-foreground)";

  const visual = seam && !seamFailed ? seam : null;
  const source = visual ? (
    <VisualHost key={seamKey} seam={visual} text={toView(text)} onMarkdown={onChange} onFail={() => setSeamFailed(true)} />
  ) : (
    <>
      <FormatBar onFormat={format} />
      <textarea aria-label={t("pageSourceLabel")} ref={area} value={toView(text)} onChange={(e) => onChange(e.target.value)} onBlur={() => void save()}
      onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; const kind = shortcutOf(e); if (kind) { e.preventDefault(); e.stopPropagation(); format(kind); } }}
      spellCheck className="lb-mono" style={{ flex: 1, minHeight: narrow ? 320 : "60vh", width: "100%", resize: "none", border: "none", borderRadius: 16, padding: 16, background: "var(--lb-fill)", color: "var(--color-foreground)", fontSize: 13, lineHeight: "21px" }} />
    </>
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
        {changed && <button type="button" data-testid="btn-page-changes" onClick={() => setDialog("changes")} className="lb-btn">{t("pageShowChanges")}</button>}
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

      <Dialog open={dialog === "review"} onClose={() => setDialog(null)} title={t("pageLeaveReviewTitle")} titleId="page-leave-title" width={760}>
        <div className="lb-dialog-body">
          <p className="lb-body" data-testid="page-review-state">{dirty || status.kind === "conflict" ? t("pageLeaveBody") : t("pageReviewSaved")}</p>
          <DiffView lines={lineDiff(opened.current, text)} beforeLabel={t("pageReviewBefore")} afterLabel={t("pageReviewAfter")} />
          <div className="lb-dialog-footer">
            <button type="button" onClick={() => setDialog(null)} className="lb-btn">{t("pageKeepEditing")}</button>
            {dirty || status.kind === "conflict"
              ? <button type="button" data-testid="btn-page-discard" onClick={discard} className="lb-btn lb-btn-destructive">{t("pageLeaveDiscard")}</button>
              : <button type="button" data-testid="btn-page-leave" onClick={() => { setDialog(null); onDone(current.current, saved.current); }} className="lb-btn lb-btn-primary">{t("pageDone")}</button>}
            {canSave && <button type="button" data-testid="btn-page-save-leave" onClick={() => void saveAndLeave()} className="lb-btn lb-btn-primary">{t("pageSaveAndLeave")}</button>}
          </div>
        </div>
      </Dialog>
      <Dialog open={dialog === "changes"} onClose={() => setDialog(null)} title={t("pageMineTitle")} titleId="page-changes-title" width={760}>
        <div className="lb-dialog-body">
          <DiffView lines={lineDiff(opened.current, text)} beforeLabel={t("pageReviewBefore")} afterLabel={t("pageReviewAfter")} />
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
