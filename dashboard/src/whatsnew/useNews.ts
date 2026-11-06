// dashboard/src/whatsnew/useNews.ts
// What the shell needs of "Novidades": the items the host shows (an item with a `feature` shows only while /health reports it), whether one is unseen (the dot), which one carries the tag,
// and the call that marks them seen when the person leaves the screen. The list and the versions are parameters so that a test runs with its own; the app passes the real ones.
import React from "react";
import { extraNews } from "@luvebot/extra";
import { NEWS_ITEMS, NEWS_VERSIONS } from "./items";
import { loadSeen, markSeen, type Seen } from "./seen";
import type { NewsItem, NewsVersionInfo } from "./types";

/** The public list and the private one together (the private is empty in the public build). */
export const ALL_NEWS: readonly NewsItem[] = [...NEWS_ITEMS, ...extraNews];

/** "1.2" style order of "v0.3", "v0.10": newest first. */
export const versionOrder = (a: string, b: string): number => {
  const n = (v: string) => v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
};

export const newestVersion = (versions: readonly NewsVersionInfo[]): NewsVersionInfo["version"] => [...versions].sort((a, b) => versionOrder(a.version, b.version))[0].version;

/** What the host shows: an item bound to a `feature` only while /health reports that key. */
export function visibleNews(items: readonly NewsItem[], features: Record<string, unknown> | null | undefined): NewsItem[] {
  return items.filter((i) => !i.feature || (!!features && Object.prototype.hasOwnProperty.call(features, i.feature)));
}

export interface News {
  items: NewsItem[];
  versions: readonly NewsVersionInfo[];
  /** an unseen item exists (and the mark works): the dot */
  hasNew: boolean;
  isNew: (id: string) => boolean;
  /** the person left the screen: what it showed is seen */
  leave: () => void;
}

export function useNews(features: Record<string, unknown> | null | undefined, all: readonly NewsItem[] = ALL_NEWS, versions: readonly NewsVersionInfo[] = NEWS_VERSIONS): News {
  const [seen, setSeen] = React.useState<Seen>(() => loadSeen(all, newestVersion(versions)));
  const items = React.useMemo(() => visibleNews(all, features), [all, features]);
  const shown = React.useRef(items); shown.current = items;
  const known = React.useMemo(() => all.map((i) => i.id), [all]);
  const isNew = React.useCallback((id: string) => !!seen && !seen.ids.has(id), [seen]);
  const leave = React.useCallback(() => setSeen((cur) => markSeen(cur, shown.current.map((i) => i.id), known)), [known]);
  return { items, versions, hasNew: !!seen && items.some((i) => !seen.ids.has(i.id)), isNew, leave };
}
