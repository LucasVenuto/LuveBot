// dashboard/src/components/pages/PagesLibrary.tsx
// A Bot's pages (v0.5, T9.3a): search, grid or list, newest first, "changed since you last read it".
// The screen asks health (whether Pages exists here) and the list (the workspace state) at once: the list shows as soon
// as it comes, and anything that depends on health ("Nova página", the read-only note) waits for it (health can take
// up to 5 s). A block from either shows the contract's honest copy, never simulated pages. Excerpts are plain text.

import React from "react";
import { getHealth, listPages } from "../../api/client";
import type { Bot, Page } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { Avatar } from "../ui/Avatar";
import { SearchIcon, PlusIcon } from "../Icons";
import { NewPageDialog } from "./NewPageDialog";
import { blockText, blockFromError, blockOf, changedSinceSeen, featureState, type PagesBlock } from "./pages";
import { WorkspaceOffer } from "./WorkspaceOffer";

type Load = { kind: "loading" } | { kind: "blocked"; block: PagesBlock } | { kind: "ready"; pages: Page[] };
const VIEW_KEY = "luvebot:pages:view";

function savedView(): "grid" | "list" {
  try { return window.localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { return "grid"; }
}

export interface PagesLibraryProps {
  bot: Bot;
  onOpen: (slug: string) => void;
}

export function PagesLibrary({ bot, onOpen }: PagesLibraryProps) {
  const { t, locale } = useLuveI18n();
  const botLabel = bot.display?.label || bot.name;
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [feature, setFeature] = React.useState<"pending" | "ok" | "read_only">("pending");  // from health
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<"grid" | "list">(savedView);
  const [creating, setCreating] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setLoad({ kind: "loading" });
    setFeature("pending");
    const blocked = (block: PagesBlock) => { if (alive) setLoad({ kind: "blocked", block }); };
    // health's verdict wins over the list's: a list already shown goes away if health says Pages is not here
    getHealth().then((health) => {
      const f = featureState(health.features?.pages as string | undefined);
      if (f === "ok" || f === "read_only") { if (alive) setFeature(f); } else blocked(f);
    }, (e) => blocked(blockFromError(e)));
    listPages(bot.name).then((r) => {
      const block = blockOf(r.workspace?.state);
      if (alive) setLoad((prev) => (prev.kind === "blocked" ? prev : block ? { kind: "blocked", block } : { kind: "ready", pages: r.pages }));
    }, (e) => { if (alive) setLoad((prev) => (prev.kind === "blocked" ? prev : { kind: "blocked", block: blockFromError(e) })); });
    return () => { alive = false; };
  }, [bot.name, nonce]);

  const pick = (v: "grid" | "list") => {
    setView(v);
    try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer convenience only */ }
  };

  const q = query.trim().toLowerCase();
  const pages = load.kind === "ready" ? load.pages.filter((p) => !q || p.title.toLowerCase().includes(q) || p.slug.includes(q) || p.excerpt.toLowerCase().includes(q)) : [];
  const canCreate = load.kind === "ready" && feature === "ok";
  const when = (iso: string) => new Date(iso).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" });
  const meta = (p: Page) => `${p.author_label} · ${when(p.mtime)}`;
  const mark = (p: Page) => changedSinceSeen(bot.name, p.slug, p.sha)
    ? <span role="img" aria-label={t("pageChangedMark")} title={t("pageChangedMark")} style={{ width: 8, height: 8, borderRadius: 4, background: "var(--color-primary)", flexShrink: 0 }} />
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--color-background)" }}>
      <header style={{ display: "flex", alignItems: "flex-end", gap: 12, padding: "24px 24px 8px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="lb-caption" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--color-muted-foreground)" }}>
            <Avatar name={botLabel} avatar={bot.display?.avatar} color={bot.display?.color} size={20} />{botLabel}
          </div>
          <h1 className="lb-large-title" style={{ margin: "4px 0 0" }}>{t("pagesTitle")}</h1>
        </div>
        {canCreate && <button type="button" onClick={() => setCreating(true)} className="lb-btn lb-btn-primary"><PlusIcon size={16} />{t("pageNewBtn")}</button>}
      </header>

      {load.kind === "ready" && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "8px 24px 16px", flexWrap: "wrap" }}>
          <label className="lb-input" style={{ display: "flex", alignItems: "center", gap: 8, maxWidth: 420, flex: "1 1 240px" }}>
            <span aria-hidden="true" style={{ color: "var(--color-muted-foreground)", display: "inline-flex" }}><SearchIcon size={16} /></span>
            <input type="search" aria-label={t("pagesSearchLabel", { name: botLabel })} placeholder={t("pagesSearchLabel", { name: botLabel })} value={query}
              onChange={(e) => setQuery(e.target.value)} style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", font: "inherit", color: "inherit" }} />
          </label>
          <div style={{ flex: 1 }} />
          <div role="group" aria-label={t("pagesViewLabel")} className="lb-segmented" style={{ width: "auto" }}>
            <button type="button" aria-pressed={view === "grid"} onClick={() => pick("grid")} className="lb-segment" style={{ padding: "0 12px", flex: "none" }}>{t("pagesViewGrid")}</button>
            <button type="button" aria-pressed={view === "list"} onClick={() => pick("list")} className="lb-segment" style={{ padding: "0 12px", flex: "none" }}>{t("pagesViewList")}</button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 24px 24px" }}>
        {load.kind === "loading" && <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("pageLoading")}</p>}
        {load.kind === "blocked" && (
          <div role="status" className="lb-group lb-empty" style={{ padding: "24px 20px", display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
            {load.block === "no_workspace"
              ? <WorkspaceOffer bot={bot.name} label={botLabel} isDefault={bot.is_default} onReady={() => setNonce((n) => n + 1)} />
              : <p className="lb-body" style={{ margin: 0 }}>{blockText(load.block, { name: bot.name, label: botLabel, isDefault: bot.is_default }, t)}</p>}
            {load.block === "error" && <button type="button" onClick={() => setNonce((n) => n + 1)} className="lb-btn">{t("retry")}</button>}
          </div>
        )}
        {load.kind === "ready" && feature === "read_only" && (
          <p role="status" className="lb-group lb-subhead" style={{ padding: "12px 16px", marginTop: 0 }}>{t("pagesReadOnly")}</p>
        )}
        {load.kind === "ready" && load.pages.length === 0 && (
          <p className="lb-group lb-subhead" style={{ padding: "24px 20px" }}>{t("pagesEmpty")}</p>
        )}
        {load.kind === "ready" && load.pages.length > 0 && pages.length === 0 && (
          <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("pagesNoMatch")}</p>
        )}
        {pages.length > 0 && view === "grid" && (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {pages.map((p) => (
              <li key={p.slug}>
                <button type="button" onClick={() => onOpen(p.slug)} className="lb-group" style={{ width: "100%", minHeight: 160, display: "flex", flexDirection: "column", gap: 8, padding: 16, border: "none", textAlign: "left", cursor: "pointer", color: "inherit" }}>
                  <span className="lb-headline" style={{ display: "flex", alignItems: "center", gap: 8 }}>{mark(p)}<span className="lb-clamp-2">{p.title}</span></span>
                  <span className="lb-caption" style={{ flex: 1, color: "var(--color-muted-foreground)", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.excerpt}</span>
                  <span className="lb-caption" style={{ color: "var(--color-muted-foreground)" }}>{meta(p)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {pages.length > 0 && view === "list" && (
          <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {pages.map((p) => (
              <li key={p.slug} className="lb-row lb-row-flat" style={{ padding: 0 }}>
                <button type="button" onClick={() => onOpen(p.slug)} className="lb-contact" style={{ borderRadius: 0, padding: "10px 16px", minHeight: 56 }}>
                  <span className="lb-row-stack">
                    <span className="lb-headline" style={{ display: "flex", alignItems: "center", gap: 8 }}>{mark(p)}<span className="lb-truncate">{p.title}</span></span>
                    {p.excerpt && <span className="lb-subhead lb-truncate">{p.excerpt}</span>}
                  </span>
                  <span className="lb-caption" style={{ whiteSpace: "nowrap", color: "var(--color-muted-foreground)" }}>{meta(p)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <NewPageDialog open={creating} bot={bot.name} botLabel={botLabel} onClose={() => setCreating(false)}
        onCreated={(page) => { setCreating(false); onOpen(page.slug); }} />
    </div>
  );
}
