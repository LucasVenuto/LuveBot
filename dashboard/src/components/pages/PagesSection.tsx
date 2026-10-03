// dashboard/src/components/pages/PagesSection.tsx
// "Páginas" in the Bot's profile panel (T9.3a §2): the three newest and "Ver todas (n)". When Pages cannot
// open here, the section stays with the honest reason, so the person learns the feature exists.

import React from "react";
import { listPages } from "../../api/client";
import type { Page } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { ChevronRightIcon } from "../Icons";
import { blockText, blockFromError, blockOf, changedSinceSeen, type PagesBlock } from "./pages";
import { WorkspaceOffer } from "./WorkspaceOffer";

type Load = { kind: "loading" } | { kind: "blocked"; block: PagesBlock } | { kind: "ready"; pages: Page[] };

export function PagesSection({ bot, label, isDefault, onOpen, onOpenAll }: { bot: string; label?: string; isDefault?: boolean; onOpen: (slug: string) => void; onOpenAll: () => void }) {
  const { t } = useLuveI18n();
  const [load, setLoad] = React.useState<Load>({ kind: "loading" });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    listPages(bot).then(
      (r) => { if (!alive) return; const b = blockOf(r.workspace?.state); setLoad(b ? { kind: "blocked", block: b } : { kind: "ready", pages: r.pages }); },
      (e) => alive && setLoad({ kind: "blocked", block: blockFromError(e) }),
    );
    return () => { alive = false; };
  }, [bot, nonce]);

  return (
    <section aria-labelledby="agent-pages-title">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "24px 4px 8px" }}>
        <h3 id="agent-pages-title" className="lb-headline" style={{ margin: 0 }}>{t("pagesTitle")}</h3>
        {load.kind === "ready" && load.pages.length > 0 && (
          <button type="button" onClick={onOpenAll} className="lb-btn lb-btn-plain">{t("pagesSeeAll", { count: load.pages.length })}</button>
        )}
      </div>
      {load.kind === "loading" ? <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{t("pageLoading")}</p>
        : load.kind === "blocked" && load.block === "no_workspace" ? (
          <div className="lb-group" style={{ padding: "14px 16px" }}><WorkspaceOffer bot={bot} label={label} isDefault={isDefault} onReady={() => setNonce((n) => n + 1)} /></div>
        )
        : load.kind === "blocked" ? <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{blockText(load.block, { name: bot, label, isDefault }, t)}</p>
        : load.pages.length === 0 ? (
          <div className="lb-group" style={{ padding: "14px 16px", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="lb-subhead" style={{ flex: 1 }}>{t("pagesEmpty")}</span>
            <button type="button" onClick={onOpenAll} className="lb-btn lb-btn-plain">{t("pagesOpenLibrary")}</button>
          </div>
        ) : (
          <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {load.pages.slice(0, 3).map((p) => (
              <li key={p.slug} className="lb-row lb-row-flat" style={{ padding: 0 }}>
                <button type="button" onClick={() => onOpen(p.slug)} className="lb-contact" style={{ borderRadius: 0, padding: "8px 16px", minHeight: 52 }}>
                  <span className="lb-row-stack">
                    <span className="lb-body lb-truncate" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {changedSinceSeen(bot, p.slug, p.sha) && <span role="img" aria-label={t("pageChangedMark")} style={{ width: 8, height: 8, borderRadius: 4, background: "var(--color-primary)", flexShrink: 0 }} />}
                      {p.title}
                    </span>
                    <span className="lb-caption">{p.author_label}</span>
                  </span>
                  <span aria-hidden="true" style={{ color: "var(--color-muted-foreground)", display: "inline-flex" }}><ChevronRightIcon size={16} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
