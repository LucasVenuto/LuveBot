// dashboard/src/components/conversation/FileCard.tsx
// A file the Bot cites in its answer ("salvei em relatorio.md"), as a card with "Baixar" (T12 download contract). The path
// is read from the answer's text and is only a candidate: the server decides what may leave (backend/pages.py
// read_workspace_file) and its refusals are said here in plain words. Nothing is rendered from the file; it is saved
// through <a download> with the name the server gave. The glyph is CSS, not an svg (the turn keeps no svg, test_sanitize).

import React from "react";
import { ApiError, downloadBotFile, createPage } from "../../api/client";
import { errCode, errDetails } from "../pages/pages";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

// The types and path shape the server accepts (pages.py DOWNLOAD_TYPES and _download_parts); anything else gets no card.
const EXT = /\.(?:md|txt|html?|csv|json|pdf|png|jpe?g|gif|webp|zip|docx|xlsx|pptx)$/i;
const TOKEN = /[\p{L}\p{N}_\-./~]+\.(?:md|txt|html?|csv|json|pdf|png|jpe?g|gif|webp|zip|docx|xlsx|pptx)(?![\p{L}\p{N}_])/giu;
const MAX = 3;

/** The workspace-relative path for what the Bot wrote, or null. An absolute path counts only inside a `workspace` folder,
 *  the one Hermes makes in every profile (ADR-004 addendum). */
export function workspacePath(raw: string): string | null {
  let p = raw.trim().replace(/^\.\//, "");
  if (p.startsWith("/")) {
    const m = p.match(/\/workspace\/(.+)$/);  // ponytail: a cwd outside <profile>/workspace given absolute gets no card; ask the server for the root if that shows up
    if (!m) return null;
    p = m[1];
  }
  if (p.length > 1024 || p.includes("\\") || p.startsWith("~")) return null;
  const parts = p.split("/");
  if (parts.length > 16 || parts.some((x) => !x || x.startsWith("."))) return null;
  return EXT.test(p) ? p : null;
}

/** Files cited in an answer, in order, without repeats: whole `code spans` (names with spaces) and bare path-like words.
 *  Links (scheme://…) are not files of the Bot. */
export function citedFiles(text: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => { const p = workspacePath(raw); if (p && !out.includes(p)) out.push(p); };
  const plain = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ");
  for (const m of plain.matchAll(/`([^`\n]{1,1024})`/g)) add(m[1]);
  for (const m of plain.replace(/`[^`\n]*`/g, " ").matchAll(TOKEN)) add(m[0]);
  return out.slice(0, MAX);
}

// A 404 (file_not_found, or a Bot that is gone) is always "not available"; the rest by code.
const ERRORS: Record<string, TranslationKey> = { file_redacted: "fileErrRedacted", workspace_unavailable: "fileErrNoWorkspace", too_large: "fileErrTooLarge" };

export type FileState = { busy?: boolean; error?: ErrorState };

/** One download at a time per file; the state is keyed by the caller (turn + path), shared by the card and the "…" menu. */
export function useFileDownloads(bot: string) {
  const { t } = useLuveI18n();
  const [state, setState] = React.useState<Record<string, FileState>>({});
  const download = React.useCallback(async (key: string, path: string) => {
    setState((s) => ({ ...s, [key]: { busy: true } }));
    try {
      const { name, blob } = await downloadBotFile(bot, path);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState((s) => ({ ...s, [key]: {} }));
    } catch (e) {
      const error = !(e instanceof ApiError) ? t("fileErrNetwork")
        : e.status === 404 && e.code !== "plugin_route_missing" ? t("fileErrNotFound") : ERRORS[e.code] ? t(ERRORS[e.code]) : humanError(e, t, "fileErrGeneric");
      setState((s) => ({ ...s, [key]: { error } }));
    }
  }, [bot, t]);
  return { state, download };
}

// A page's own file (backend/pages.py SLUG): editing it is opening that page.
const PAGE_FILE = /^pages\/([a-z0-9][a-z0-9-]{0,63})\.md$/;
const COPY_ERRORS: Record<string, TranslationKey> = { too_large: "pageTooLarge", capability_missing: "pagesReadOnly", pages_unavailable: "fileCopyNoPages" };

type CopyState = { busy?: boolean; error?: ErrorState; existing?: string };

/** `bot` + `onOpenPage`: a Markdown file can be edited. A page's file opens its page; any other .md is COPIED into Páginas by the
 *  Pages writer (POST /pages: audited, 1 MiB) and the copy opens. The card says it is a copy and that the Bot keeps the original. */
export function FileCard({ path, botLabel, state, onDownload, bot, onOpenPage }: {
  path: string; botLabel: string; state?: FileState; onDownload: () => void; bot?: string; onOpenPage?: (slug: string) => void }) {
  const { t } = useLuveI18n();
  const name = path.split("/").pop() ?? path;
  const pageSlug = PAGE_FILE.exec(path)?.[1];
  const editable = !!bot && !!onOpenPage && /\.md$/i.test(path);
  const [copy, setCopy] = React.useState<CopyState>({});
  async function openInEditor() {
    if (!bot || !onOpenPage || copy.busy) return;
    setCopy({ busy: true });
    try {
      const { blob } = await downloadBotFile(bot, path);
      const { page } = await createPage(bot, { title: name.replace(/\.md$/i, ""), content: await blob.text() });
      setCopy({});
      onOpenPage(page.slug);
    } catch (e) {
      const code = errCode(e) ?? "";
      if (code === "page_exists") { setCopy({ existing: String(errDetails(e).slug ?? "") }); return; }  // never overwritten
      setCopy({ error: COPY_ERRORS[code] ? t(COPY_ERRORS[code])
        : e instanceof ApiError && e.status === 404 && code !== "plugin_route_missing" ? t("fileErrNotFound")
        : ERRORS[code] ? t(ERRORS[code]) : humanError(e, t, "fileErrGeneric") });
    }
  }
  return (
    <div>
      <div className="lb-page-card">
        <span aria-hidden="true" className="lb-page-glyph"><i /><i /><i /></span>
        <span className="lb-row-stack">
          <span className="lb-headline lb-truncate">{name}</span>
          <span className="lb-caption lb-truncate">{t("fileCardMeta", { name: botLabel, path })}</span>
        </span>
        <button type="button" onClick={onDownload} disabled={state?.busy} className="lb-btn" aria-label={t("fileDownloadNamed", { file: name })}>
          {state?.busy ? t("fileDownloading") : t("fileDownload")}
        </button>
        {editable && pageSlug && (
          <button type="button" onClick={() => onOpenPage!(pageSlug)} className="lb-btn" aria-label={t("fileEditNamed", { file: name })}>{t("fileEdit")}</button>
        )}
        {editable && !pageSlug && (
          <button type="button" onClick={() => void openInEditor()} disabled={copy.busy} className="lb-btn" aria-label={t("fileOpenInEditorNamed", { file: name })}>
            {copy.busy ? t("fileOpening") : t("fileOpenInEditor")}
          </button>
        )}
      </div>
      {editable && !pageSlug && !copy.existing && <p className="lb-caption" style={{ margin: "0 4px 8px" }}>{t("fileCopyNote")}</p>}
      {copy.existing && (
        <p role="status" className="lb-caption" style={{ margin: "0 4px 8px" }}>
          {t("fileCopyExists", { slug: copy.existing })}{" "}
          <button type="button" onClick={() => onOpenPage!(copy.existing!)} className="lb-btn lb-btn-plain">{t("fileOpenExisting")}</button>
        </p>
      )}
      {state?.error && <p role="alert" className="lb-caption" style={{ margin: "0 4px 8px", color: "var(--color-destructive)" }}><ErrorNote error={state.error} /></p>}
      {copy.error && <p role="alert" className="lb-caption" style={{ margin: "0 4px 8px", color: "var(--color-destructive)" }}><ErrorNote error={copy.error} /></p>}
    </div>
  );
}
