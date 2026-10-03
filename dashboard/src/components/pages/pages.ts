// dashboard/src/components/pages/pages.ts
// Page logic with no markup (contract v0.5): the slug rule, the "changed since you last read it" mark, how an
// API error maps to an honest screen state, and a line diff for "Ver mudanças".
// The page text never goes to browser storage: only the sha of the version this browser last opened.

import { ApiError } from "../../api/client";
import type { TranslationKey } from "../../i18n";

/** v0.5 §2: a slug is never a path. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isSlug = (s: unknown): s is string => typeof s === "string" && SLUG_RE.test(s);

// --- "changed since your last read": sha only, per browser (decision T9.3a §11.2) ---
const SHA_RE = /^[0-9a-f]{64}$/;
const seenKey = (bot: string, slug: string) => `luvebot:pages:seen:${bot}:${slug}`;

export function lastSeenSha(bot: string, slug: string): string | null {
  try {
    const v = window.localStorage.getItem(seenKey(bot, slug));
    return v && SHA_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function markSeen(bot: string, slug: string, sha: string): void {
  if (!SHA_RE.test(sha)) return; // only a sha is ever stored, never page text
  try { window.localStorage.setItem(seenKey(bot, slug), sha); } catch { /* storage off: the mark just does not show */ }
}

/** A page this browser opened before and that changed since. Never-opened pages are not marked. */
export function changedSinceSeen(bot: string, slug: string, sha: string): boolean {
  const seen = lastSeenSha(bot, slug);
  return seen !== null && seen !== sha;
}

// --- screen states (v0.5 §6, T9.3b) ---
/** Why the Pages screen shows no pages. The copy for each is the contract's table. */
export type PagesBlock =
  | "unsupported"      // this LuveBot backend has no Pages routes
  | "unavailable"      // this Hermes lacks what Pages needs
  | "no_workspace" | "not_local" | "inside_hermes" | "unsafe"
  | "restart"         // the dashboard runs an older LuveBot backend: restart it (a 404 without our envelope)
  | "error";           // the list failed for now (502/503/504)

export const BLOCK_COPY: Record<PagesBlock, TranslationKey> = {
  unsupported: "pagesStateUnsupported",
  unavailable: "pagesStateUnavailable",
  no_workspace: "pagesStateNoWorkspace",
  not_local: "pagesStateNotLocal",
  inside_hermes: "pagesStateInsideHermes",
  unsafe: "pagesStateUnsafe",
  restart: "errRouteMissing",
  error: "pagesStateError",
};

/** The copy for a block. "no_workspace" says where to fix it: terminal.cwd in the profile's config.yaml
 *  (the LuveBot profile screen has no such field). `isDefault` unknown: the path is described, not guessed. */
export function blockText(block: PagesBlock, bot: { name: string; label?: string | null; isDefault?: boolean }, t: (k: TranslationKey, p?: Record<string, string | number>) => string): string {
  if (block !== "no_workspace") return t(BLOCK_COPY[block]);
  const path = bot.isDefault === true ? "~/.hermes/config.yaml"
    : bot.isDefault === false ? `~/.hermes/profiles/${bot.name}/config.yaml`
    : t("pagesProfileConfigFile");
  return t("pagesStateNoWorkspace", { name: bot.label || bot.name, path });
}

const WORKSPACE_BLOCKS: ReadonlySet<string> = new Set(["no_workspace", "not_local", "inside_hermes", "unsafe"]);

/** health.features.pages, before any page route is called. Absent means an older backend (fail closed). */
export function featureState(pages: string | undefined): "ok" | "read_only" | PagesBlock {
  if (pages === "ok" || pages === "read_only") return pages;
  if (pages === "unavailable") return "unavailable";
  return "unsupported";
}

/** The list's workspace state: only ready and empty show pages; an unknown state fails closed. */
export function blockOf(state: string | undefined): PagesBlock | null {
  if (state === "ready" || state === "empty") return null;
  return state && WORKSPACE_BLOCKS.has(state) ? (state as PagesBlock) : "error";
}

const PAGE_404 = new Set(["page_not_found", "revision_not_found"]);

/** An error on a Pages route, as a screen state. A 404 without our envelope means the route does not exist. */
export function blockFromError(e: unknown): PagesBlock {
  if (e instanceof ApiError) {
    if (e.code === "pages_unavailable") {
      const reason = e.details?.reason;
      if (typeof reason === "string" && WORKSPACE_BLOCKS.has(reason)) return reason as PagesBlock;
    }
    if (e.code === "plugin_route_missing") return "restart";
    if (e.status === 404 && !PAGE_404.has(e.code)) return "unsupported";
    if (e.code === "capability_missing") return "unavailable";
  }
  return "error";
}

export const errCode = (e: unknown): string | null => (e instanceof ApiError ? e.code : null);
export const errDetails = (e: unknown): Record<string, unknown> => (e instanceof ApiError && e.details ? e.details : {});

// --- line diff for "Comparar" and "Ver mudanças" ---
export type DiffLine = { kind: "same" | "add" | "del"; text: string };

// ponytail: LCS table is O(n·m); past ~4M cells we say "too big to compare" instead of freezing the tab.
const MAX_CELLS = 4_000_000;

/** Lines of `before` and `after`, marked. Null when the pages are too big to compare here. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_CELLS) return null;
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Title for "Salvar resposta como página": the first Markdown heading or the first words, capped at 120. */
export function titleFrom(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^#+\s*/, "").replace(/[*_`]/g, "").slice(0, 120).trim();
}

/** Autosave pacing (v0.5 §6): 3 s idle or blur, never more than one save per second. */
export const AUTOSAVE_IDLE_MS = 3000;
export const MIN_SAVE_GAP_MS = 1000;
export const MAX_PAGE_BYTES = 1024 * 1024;
