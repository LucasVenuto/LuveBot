// dashboard/src/components/pages/PageView.tsx
// One page of a Bot (v0.5): read it (safe Markdown only, never HTML), edit it, see its history and restore.
// Opens beside the conversation (Dots) or in the Pages screen. Nothing changes under the reader on its own:
// a newer version shows as a strip, and the person decides to see it.

import React from "react";
import { Markdown } from "../../lib/render/markdown";
import { getPage, getPageRevision, listPageRevisions, restorePageRevision } from "../../api/client";
import type { Page, PageRevision, PageWithContent } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { Dialog } from "../ui/Dialog";
import { Avatar } from "../ui/Avatar";
import type { BotAvatar } from "../../api/types";
import { PageEditor } from "./PageEditor";
import { DiffView } from "./DiffView";
import { blockText, blockFromError, errCode, lastSeenSha, lineDiff, markSeen } from "./pages";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface PageViewProps {
  bot: { name: string; label?: string; avatar?: BotAvatar | null; color?: string | null };
  slug: string;
  /** The newest revision the conversation saw the Bot write (luvebot.page.updated). */
  liveRev?: number | null;
  /** "Perguntar ao Bot sobre esta página" (run and chat surfaces, A-64). Absent: the button is not shown. */
  onAsk?: (page: Page) => void;
  onClose?: () => void;
}

type Mode = { kind: "read" } | { kind: "edit" } | { kind: "history" } | { kind: "revision"; rev: PageRevision };

export function PageView({ bot, slug, liveRev, onAsk, onClose }: PageViewProps) {
  const { t, locale } = useLuveI18n();
  const botLabel = bot.label || bot.name;
  const [page, setPage] = React.useState<PageWithContent | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [mode, setMode] = React.useState<Mode>({ kind: "read" });
  const [diff, setDiff] = React.useState<{ before: string; label: string } | null | "missing">(null);
  const seenBefore = React.useRef<string | null>(null);   // the sha this browser had read before this visit
  const shown = React.useRef<string | null>(null);        // content on screen, for "Ver mudanças" after a live update

  const fmt = (iso: string) => new Date(iso).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" });

  const load = React.useCallback(async () => {
    try {
      const p = await getPage(bot.name, slug);
      setPage(p);
      setError(null);
      markSeen(bot.name, slug, p.sha);
      return p;
    } catch (e) {
      const code = errCode(e);
      setError(code === "page_not_found" ? t("pageNotFound") : blockText(blockFromError(e), { name: bot.name, label: bot.label }, t));
      return null;
    }
  }, [bot.name, slug, t]);

  React.useEffect(() => {
    seenBefore.current = lastSeenSha(bot.name, slug);
    setPage(null); setMode({ kind: "read" });
    void load();
  }, [bot.name, slug, load]);

  React.useEffect(() => { if (page && mode.kind === "read") shown.current = page.content; }, [page, mode.kind]);

  const changedSince = !!page && seenBefore.current !== null && seenBefore.current !== page.sha;
  const liveNewer = !!page && liveRev != null && (page.rev == null || liveRev > page.rev);

  /** Diff the version on screen (or the one last read here) against the newest. */
  async function showChanges() {
    const before = liveNewer ? shown.current : null;
    const fresh = liveNewer ? await load() : page;
    if (!fresh) return;
    if (before != null) { setDiff({ before, label: t("pageVersionYouHad") }); return; }
    try {
      const { revisions } = await listPageRevisions(bot.name, slug);
      const old = revisions.find((r) => r.sha === seenBefore.current);
      if (!old) { setDiff("missing"); return; }
      const r = await getPageRevision(bot.name, slug, old.rev);
      setDiff({ before: r.content, label: t("pageVersionYouHad") });
    } catch { setDiff("missing"); }
    seenBefore.current = fresh.sha;
  }

  if (error) return <Shell onClose={onClose} title={t("pageOfBot", { name: botLabel })}><p role="alert" className="lb-group lb-subhead" style={{ padding: "14px 16px" }}><ErrorNote error={error} /></p></Shell>;
  if (!page) return <Shell onClose={onClose} title={t("pageOfBot", { name: botLabel })}><p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("pageLoading")}</p></Shell>;

  if (mode.kind === "edit") {
    return <PageEditor bot={bot.name} botLabel={botLabel} page={page}
      onSaved={(p, content) => { markSeen(bot.name, slug, p.sha); seenBefore.current = p.sha; setPage({ ...page, ...p, content }); }}
      onDone={(p, content) => { setPage({ ...page, ...p, content }); setMode({ kind: "read" }); }} />;
  }
  if (mode.kind === "history") return <History bot={bot.name} botLabel={botLabel} page={page} fmt={fmt} onBack={() => setMode({ kind: "read" })} onOpen={(rev) => setMode({ kind: "revision", rev })} />;
  if (mode.kind === "revision") {
    return <Revision bot={bot.name} botLabel={botLabel} page={page} rev={mode.rev} fmt={fmt} onBack={() => setMode({ kind: "history" })}
      onRestored={async () => { await load(); setMode({ kind: "read" }); }} />;
  }

  const readOnly = !page.editable;
  return (
    <Shell onClose={onClose} title={t("pageOfBot", { name: botLabel })}
      actions={<button type="button" onClick={() => setMode({ kind: "edit" })} disabled={readOnly} className="lb-btn">{t("pageEdit")}</button>}>
      {(liveNewer || changedSince) && (
        <div role="status" className="lb-group" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", marginBottom: 12, background: "color-mix(in srgb, var(--color-primary) 10%, transparent)" }}>
          <Avatar name={botLabel} avatar={bot.avatar} color={bot.color} size={24} />
          <span className="lb-subhead" style={{ flex: 1 }}>{liveNewer ? t("pageUpdatedWhileReading", { name: botLabel }) : t("pageChangedSinceRead")}</span>
          <button type="button" onClick={() => void showChanges()} className="lb-btn lb-btn-plain">{t("pageSeeChanges")}</button>
        </div>
      )}
      {readOnly && (
        <p role="status" className="lb-alert" style={{ marginBottom: 12, background: "var(--lb-fill)", color: "var(--color-foreground)" }}>
          {t(page.readonly_reason === "redacted" ? "pageRedactedBody" : "pagesReadOnly")}
        </p>
      )}
      <section aria-label={t("pageRegionLabel", { title: page.title })}>
        <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "0 0 12px" }}>
          {t("pageMeta", { who: page.author_label, when: fmt(page.mtime) })}
          {page.rev != null ? ` · ${t("pageRevision", { rev: page.rev })}` : ""}
        </p>
        <div className="lb-body"><Markdown text={page.content} /></div>
      </section>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 20, paddingTop: 12, borderTop: "1px solid var(--lb-separator)" }}>
        {onAsk && <button type="button" onClick={() => onAsk(page)} className="lb-btn" style={{ flex: "1 1 auto" }}>{t("pageAskBot", { name: botLabel })}</button>}
        <button type="button" onClick={() => setMode({ kind: "history" })} className="lb-btn">{t("pageHistory")}</button>
      </div>

      <Dialog open={diff !== null} onClose={() => setDiff(null)} title={t("pageChangesTitle")} titleId="page-changes-title" width={760}>
        <div className="lb-dialog-body">
          {diff === "missing" ? <p className="lb-subhead">{t("pageOldVersionGone")}</p>
            : diff && <DiffView lines={lineDiff(diff.before, page.content)} beforeLabel={diff.label} afterLabel={t("pageVersionNow")} />}
        </div>
      </Dialog>
    </Shell>
  );
}

function Shell({ title, actions, onClose, children }: { title: string; actions?: React.ReactNode; onClose?: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 40px 12px 0", minHeight: 32 }}>
        <span className="lb-caption" style={{ flex: 1, color: "var(--color-muted-foreground)" }}>{title}</span>
        {actions}
        {onClose && null}
      </div>
      {children}
    </div>
  );
}

function History({ bot, botLabel, page, fmt, onBack, onOpen }: { bot: string; botLabel: string; page: Page; fmt: (iso: string) => string; onBack: () => void; onOpen: (r: PageRevision) => void }) {
  const { t } = useLuveI18n();
  const [revs, setRevs] = React.useState<PageRevision[] | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  React.useEffect(() => {
    listPageRevisions(bot, page.slug).then((r) => setRevs(r.revisions), (e) => setError(blockText(blockFromError(e), { name: bot }, t)));
  }, [bot, page.slug, t]);
  return (
    <div>
      <button type="button" onClick={onBack} className="lb-btn lb-btn-plain" style={{ marginBottom: 8 }}>‹ {page.title}</button>
      <h2 className="lb-title" style={{ margin: "0 0 12px" }}>{t("pageHistory")}</h2>
      {error ? <p role="alert" className="lb-group lb-subhead" style={{ padding: "14px 16px" }}><ErrorNote error={error} /></p>
        : !revs ? <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("pageLoading")}</p>
        : !revs.length ? <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("pageHistoryEmpty")}</p>
        : (
          <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {revs.map((r) => (
              <li key={r.rev} className="lb-row lb-row-flat" style={{ padding: 0 }}>
                <button type="button" onClick={() => onOpen(r)} className="lb-contact" style={{ borderRadius: 0, padding: "8px 16px", minHeight: 52 }}>
                  <span className="lb-row-stack">
                    <span className="lb-headline">{t("pageRevision", { rev: r.rev })}{r.sha === page.sha ? ` · ${t("pageCurrentVersion")}` : ""}</span>
                    <span className="lb-caption">{r.author_label} · {fmt(r.at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", marginTop: 8 }}>{t("pageHistoryLimit")}</p>
    </div>
  );
}

function Revision({ bot, botLabel, page, rev, fmt, onBack, onRestored }: { bot: string; botLabel: string; page: Page; rev: PageRevision; fmt: (iso: string) => string; onBack: () => void; onRestored: () => void }) {
  const { t } = useLuveI18n();
  const [content, setContent] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    getPageRevision(bot, page.slug, rev.rev).then((r) => setContent(r.content), (e) => setError(humanError(e, t, "unexpectedError")));
  }, [bot, page.slug, rev.rev, t]);

  /** Restoring writes a new revision after the person confirms; the content never crosses the browser (§4.3). */
  async function restore() {
    setBusy(true);
    try { await restorePageRevision(bot, page.slug, rev.rev, { base_sha: page.sha }); setConfirm(false); onRestored(); }
    catch (e) { setError(errCode(e) === "page_conflict" ? t("pageRestoreConflict") : humanError(e, t, "unexpectedError")); setConfirm(false); }
    finally { setBusy(false); }
  }

  const current = rev.sha === page.sha;
  return (
    <div>
      <button type="button" onClick={onBack} className="lb-btn lb-btn-plain" style={{ marginBottom: 8 }}>‹ {t("pageHistory")}</button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <h2 className="lb-title" style={{ margin: 0 }}>{t("pageRevision", { rev: rev.rev })}</h2>
          <span className="lb-caption" style={{ color: "var(--color-muted-foreground)" }}>{rev.author_label} · {fmt(rev.at)}</span>
        </div>
        {!current && page.editable && <button type="button" onClick={() => setConfirm(true)} className="lb-btn">{t("pageRestore")}</button>}
      </div>
      {error && <p role="alert" className="lb-alert" style={{ marginBottom: 12 }}><ErrorNote error={error} /></p>}
      {content === null ? <p className="lb-subhead">{t("pageLoading")}</p> : <div className="lb-body"><Markdown text={content} /></div>}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={t("pageRestoreTitle", { rev: rev.rev })} titleId="page-restore-title">
        <div className="lb-dialog-body">
          <p className="lb-body">{t("pageRestoreBody")}</p>
          <div className="lb-dialog-footer">
            <button type="button" onClick={() => setConfirm(false)} className="lb-btn">{t("cancelBtn")}</button>
            <button type="button" onClick={() => void restore()} disabled={busy} className="lb-btn lb-btn-primary">{t("pageRestore")}</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
