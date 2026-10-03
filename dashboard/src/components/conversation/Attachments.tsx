// dashboard/src/components/conversation/Attachments.tsx
// Attachments in the composer (T14, ADR-005): the clip, drag and drop, and a pasted image add a chip (name, size, remove);
// nothing leaves until "Enviar". Then each file goes to POST /bots/{bot}/attachments and its `reference` line joins the
// message: the agent reads the file itself, through its tools and the rules hook. The server decides by the BYTES; the
// checks here (type by extension, size caps) only answer at once instead of after the upload.

import React from "react";
import { ApiError, uploadAttachment, setBotWorkspace } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { XIcon } from "../Icons";

// backend/pages.py: IMAGE_MAX, DOC_MAX and the accepted kinds (no SVG, HTML, BMP or executables)
export const IMAGE_MAX = 10 * 1024 * 1024;
export const DOC_MAX = 20 * 1024 * 1024;
export const MAX_FILES = 5;
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const DOC_EXT = new Set(["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json"]);
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const ACCEPT = [...IMAGE_EXT, ...DOC_EXT].map((e) => `.${e}`).join(",") + "," + [...IMAGE_MIME].join(",");

export type Pending = { id: string; file: File; reference?: string };

/** null when the file may be tried; else why not, said at once. */
export function precheck(file: File): "type" | "size" | null {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const image = IMAGE_EXT.has(ext) || (!ext && IMAGE_MIME.has(file.type));
  if (!image && !DOC_EXT.has(ext)) return "type";
  return file.size > (image ? IMAGE_MAX : DOC_MAX) ? "size" : null;
}

/** The size as the server writes it in the reference (pages.py save_attachment). */
export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const WORKSPACE: Record<string, TranslationKey> = {
  no_workspace: "attachWsNone", not_local: "attachWsNotLocal", inside_hermes: "attachWsInside", unsafe: "attachWsUnsafe",
};

/** A refusal of the upload in words, with the code kept for the detail; `workspace` tells whether the folder can be made. */
export function attachError(e: unknown, t: (k: TranslationKey, p?: Record<string, string | number>) => string): { error: ErrorState; canCreateWorkspace: boolean } {
  if (e instanceof ApiError) {
    const reason = typeof e.details?.reason === "string" ? e.details.reason : "";
    if (e.code === "too_large") return { error: { text: t("attachErrTooLarge"), code: e.code }, canCreateWorkspace: false };
    if (e.code === "attachment_refused") return { error: { text: t(reason === "sensitive_name" ? "attachErrSensitive" : "attachErrType"), code: `${e.code}:${reason || "?"}` }, canCreateWorkspace: false };
    if (e.code === "workspace_unavailable") return { error: { text: t(WORKSPACE[reason] ?? "attachWsOther"), code: `${e.code}:${reason || "?"}` }, canCreateWorkspace: reason === "no_workspace" };
  }
  return { error: humanError(e, t, "attachErrGeneric"), canCreateWorkspace: false };
}

let seq = 0;

export function useAttachments(bot: string) {
  const { t } = useLuveI18n();
  const [items, setItems] = React.useState<Pending[]>([]);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [canCreate, setCanCreate] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const add = (files: FileList | File[] | null | undefined) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    const next = [...items];
    let refusal: string | null = null;
    for (const file of list) {
      const why = precheck(file);
      if (why) { refusal = t(why === "type" ? "attachTypeRefused" : "attachTooLarge", { name: file.name }); continue; }
      if (next.length >= MAX_FILES) { refusal = t("attachTooMany", { n: MAX_FILES }); break; }
      next.push({ id: `a${++seq}`, file });
    }
    setItems(next); setError(refusal); setCanCreate(false); setNotice(null);
  };

  const remove = (id: string) => { setItems((cur) => cur.filter((x) => x.id !== id)); setError(null); setCanCreate(false); setNotice(null); };
  const clear = () => { setItems([]); setError(null); setCanCreate(false); setNotice(null); };

  /** Uploads what was not uploaded yet, in order; the references, or null when one was refused (the chips stay). */
  const upload = async (): Promise<string[] | null> => {
    setBusy(true); setError(null); setCanCreate(false); setNotice(null);
    try {
      const refs: string[] = [];
      for (const item of items) {
        if (item.reference) { refs.push(item.reference); continue; }
        try {
          const { attachment } = await uploadAttachment(bot, item.file);
          refs.push(attachment.reference);
          // kept on the chip: a retry after a later refusal never stores the same file twice
          setItems((cur) => cur.map((x) => (x.id === item.id ? { ...x, reference: attachment.reference } : x)));
        } catch (e) {
          const why = attachError(e, t);
          setError(why.error); setCanCreate(why.canCreateWorkspace);
          return null;
        }
      }
      return refs;
    } finally {
      setBusy(false);
    }
  };

  const createWorkspace = async () => {
    setBusy(true);
    try {
      const { workspace } = await setBotWorkspace(bot);
      if (workspace.state === "ready" || workspace.state === "empty") { setCanCreate(false); setError(null); setNotice(t("attachWsCreated")); }
      else { setCanCreate(false); setError({ text: t(WORKSPACE[workspace.state] ?? "attachWsOther"), code: `workspace:${workspace.state}` }); }
    } catch (e) {
      setCanCreate(false); setError(humanError(e, t, "attachWsCreateFailed"));
    } finally {
      setBusy(false);
    }
  };

  return { items, error, notice, canCreate, busy, add, remove, clear, upload, createWorkspace };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

/** The chips above the composer, the provider notice, and the refusal (with "Criar a pasta do Bot" when that is the fix). */
export function AttachmentTray({ a }: { a: AttachmentsState }) {
  const { t } = useLuveI18n();
  if (!a.items.length && !a.error && !a.notice) return null;
  return (
    <div style={{ margin: "0 16px 6px", display: "flex", flexDirection: "column", gap: 6 }}>
      {a.items.length > 0 && (
        <ul aria-label={t("attachListLabel")} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {a.items.map((x) => (
            <li key={x.id} className="lb-pill" style={{ fontSize: 13, padding: "4px 6px 4px 12px", maxWidth: "100%" }}>
              <span className="lb-truncate" style={{ maxWidth: 220 }}>{x.file.name}</span>
              <span className="lb-caption" style={{ whiteSpace: "nowrap" }}>{formatSize(x.file.size)}</span>
              <button type="button" onClick={() => a.remove(x.id)} disabled={a.busy} aria-label={t("attachRemove", { name: x.file.name })} className="lb-icon-btn" style={{ width: 28, height: 28 }}>
                <XIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {a.items.length > 0 && <p className="lb-caption" style={{ margin: 0 }}>{t("attachNotice")}</p>}
      {a.notice && <p role="status" className="lb-caption" style={{ margin: 0 }}>{a.notice}</p>}
      {a.error && (
        <div role="alert" className="lb-caption" style={{ color: "var(--color-destructive)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span><ErrorNote error={a.error} /></span>
          {a.canCreate && <button type="button" className="lb-btn" disabled={a.busy} onClick={() => void a.createWorkspace()}>{t("attachWsCreate")}</button>}
        </div>
      )}
    </div>
  );
}

// ---- what was sent: the reference lines of a user message become compact chips (t142) ----
// The message keeps the raw "[Anexo: attachments/<uuid>-<name>, <type>, <size>]" lines for the Bot (they go in the run as
// typed); only the bubble shows them as chips: the name without the folder and the server's uuid prefix, a short format
// name and the size. Lines in any other shape stay text.
export type SentRef = { name: string; type: string; size: string };
const REF = /^\[Anexo: attachments\/([^,\]\n]+), ([^,\]\n]+), ([^,\]\n]+)\]$/;
// format names, not words: they stay out of the dictionary (like the keys of the shortcuts)
const FORMAT: Record<string, string> = {
  "application/pdf": "PDF", "image/png": "PNG", "image/jpeg": "JPG", "image/gif": "GIF", "image/webp": "WebP",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "PowerPoint",
  "text/plain": "TXT", "text/markdown": "Markdown", "text/csv": "CSV", "application/json": "JSON",
};

export function splitReferences(text: string): { text: string; refs: SentRef[] } {
  const refs: SentRef[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(REF);
    if (m) refs.push({ name: m[1].replace(/^[0-9a-f]{32}-/, ""), type: FORMAT[m[2]] ?? m[2], size: m[3] });
    else rest.push(line);
  }
  return { text: rest.join("\n").trim(), refs };
}

/** A long name is cut in the MIDDLE, keeping its end and extension ("proposta-al…der.pdf"): the start shrinks with an ellipsis
 *  (CSS, so it cuts only when it does not fit) and the last letters + extension never shrink. */
export function nameParts(name: string): { head: string; tail: string } {
  const dot = name.lastIndexOf(".");
  // only a real extension (1 to 8 characters) stays whole: anything longer after the last dot would never shrink and would
  // burst the bubble, so it is cut in the middle like any name
  const ext = dot > 0 && name.length - dot - 1 >= 1 && name.length - dot - 1 <= 8 ? name.slice(dot) : "";
  const stem = ext ? name.slice(0, dot) : name;
  const keep = Math.min(3, Math.max(0, stem.length - 1));
  return { head: stem.slice(0, stem.length - keep), tail: stem.slice(stem.length - keep) + ext };
}

/** The chips under the text of a sent message (inside the user's bubble, on the Bot's accent). */
export function SentAttachments({ refs, spaced }: { refs: SentRef[]; spaced: boolean }) {
  const { t } = useLuveI18n();
  return (
    <ul aria-label={t("attachSentLabel")} style={{ listStyle: "none", margin: spaced ? "8px 0 0" : 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
      {refs.map((r, i) => (
        <li key={i} aria-label={t("attachSentItem", { name: r.name, type: r.type, size: r.size })} title={r.name}
          style={{ display: "inline-flex", alignItems: "center", gap: 8, maxWidth: "min(100%, 420px)", minWidth: 0, padding: "6px 10px", borderRadius: 12,
            background: "color-mix(in srgb, currentColor 14%, transparent)", whiteSpace: "nowrap" }}>
          <span aria-hidden="true" className="lb-page-glyph" style={{ width: 18, height: 22, padding: 3, gap: 2, borderRadius: 4 }}><i /><i /><i /></span>
          <span data-testid="sent-name" style={{ display: "inline-flex", minWidth: 0, fontWeight: 600 }}>
            <span className="lb-truncate" style={{ minWidth: 0 }}>{nameParts(r.name).head}</span>
            <span style={{ flexShrink: 0 }}>{nameParts(r.name).tail}</span>
          </span>
          <span style={{ opacity: 0.8, fontSize: 13, flexShrink: 0 }}>{r.type} · {r.size}</span>
        </li>
      ))}
    </ul>
  );
}
