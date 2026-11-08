// dashboard/src/whatsnew/seen.ts
// The "new" mark of "Novidades" (docs/contracts/whats-new-v0.md section 3): which items this device has already seen, kept in localStorage as {"v":1,"ids":[...]}.
// It is a convenience, so EVERY read and write is in a try/catch and the screen works without it. The rule that matters is "never nag a person who cannot clear the mark":
// storage that is missing, throws or holds garbage gives NO dot and NO tag (`null` here), and a first visit that cannot be recorded gives none either (else it would come back at every load).
import type { NewsItem, NewsVersion } from "./types";

export const SEEN_KEY = "luvebot.news.seen";
/** At most this many ids are kept (the list is a few dozen; the cap only stops a runaway value). */
export const MAX_SEEN = 500;

/** `null` = nothing to show: no storage, it throws, or its value is garbage. Otherwise the ids this device has seen. */
export type Seen = { ids: ReadonlySet<string> } | null;

function store(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage ?? null; } catch { return null; }
}

/** The ids as they are stored: no repeats, the newest MAX_SEEN. */
function kept(ids: Iterable<string>): string[] {
  return [...new Set(ids)].slice(-MAX_SEEN);
}

function write(s: Storage, ids: string[]): boolean {
  try { s.setItem(SEEN_KEY, JSON.stringify({ v: 1, ids })); return true; } catch { return false; }
}

function parse(raw: string): string[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const { v, ids } = value as { v?: unknown; ids?: unknown };
    if (v !== 1 || !Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return null;
    return kept(ids as string[]);
  } catch { return null; }
}

/** Reads the seen ids. A device with no key yet is on its FIRST VISIT: the items of the older versions count as seen at once (a new installation does not call all of v0.1 new), and
 *  that start is written down right away; if it cannot be written, there is no mark at all. */
export function loadSeen(items: readonly NewsItem[], newest: NewsVersion): Seen {
  const s = store();
  if (!s) return null;
  let raw: string | null;
  try { raw = s.getItem(SEEN_KEY); } catch { return null; }
  if (raw === null) {
    const start = kept(items.filter((i) => i.since !== newest).map((i) => i.id));
    return write(s, start) ? { ids: new Set(start) } : null;
  }
  const ids = parse(raw);
  return ids ? { ids: new Set(ids) } : null;
}

/** The person left the screen: what was shown (`shown`) is seen now. Only ids of items that exist (`known`) are kept, so a removed item does not stay in the value. */
export function markSeen(current: Seen, shown: readonly string[], known: readonly string[]): Seen {
  if (!current) return null;
  const all = new Set(known);
  const next = kept([...current.ids, ...shown].filter((id) => all.has(id)));
  const s = store();
  if (s) write(s, next);   // a write that fails only loses the memory across a reload; the mark is gone for this visit
  return { ids: new Set(next) };
}
