// dashboard/src/components/conversation/WorkPanel.tsx
// Work panel (spec 4.3): Atividade / Terminal / Arquivos, derived from the transcript, and Tela (D-007), the live screen. Text only: agent content
// is data, never HTML. Honest empty states where nothing was observed.

import React from "react";
import type { Item } from "../../lib/stream";
import { deriveActivity, deriveTerminal, deriveFiles, type FileTools } from "./derive";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ScreenTab } from "../screen/ScreenTab";
import { FileCard, type FileState } from "./FileCard";

type Tab = "atividade" | "terminal" | "arquivos" | "tela";
const muted: React.CSSProperties = { color: "var(--color-muted-foreground)", font: "400 13px/18px var(--lb-font)" };
const mono: React.CSSProperties = { fontFamily: "var(--lb-mono)", fontSize: 12, lineHeight: "17px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 };
const item: React.CSSProperties = { padding: "10px 12px", borderRadius: 12, background: "var(--lb-fill)", marginBottom: 8 };
const ICON = { running: "⟳", done: "✓", error: "✕" } as const;  // same marks as the steps in the conversation

const Empty = ({ children }: { children: React.ReactNode }) => <p style={{ ...muted, padding: "24px 8px", textAlign: "center", margin: 0 }}>{children}</p>;

/** One turn of the conversation, for the Atividade tab: its steps are shown here in full (the chat keeps one compact line). */
export interface WorkTurn { id: number; label: string; items: readonly Item[] }

/** A file the conversation delivered (the same as its card in the chat), with that card's download. */
export interface DeliveredFile { key: string; path: string; state?: FileState; onDownload: () => void }

export function WorkPanel({ items, fileTools, turns, focus, bot, delivered = [], onOpenPage }: {
  items: readonly Item[]; fileTools?: FileTools;
  delivered?: readonly DeliveredFile[];
  onOpenPage?: (slug: string) => void;  // a delivered .md opens (or is copied into) Páginas, like its card in the chat
  bot?: { name: string; label: string };  // D-007: the Tela tab of this Bot
  turns?: readonly WorkTurn[];
  focus?: { turnId: number; n: number } | null;  // "Ver na Atividade": open the tab and bring that turn into view
}) {
  const { t } = useLuveI18n();
  const [tab, setTab] = React.useState<Tab>("atividade");
  const s = { items };
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!focus) return;
    setTab("atividade");
    requestAnimationFrame(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(`[data-work-turn="${focus.turnId}"]`);
      el?.scrollIntoView?.({ block: "start" });
      el?.focus();
    });
  }, [focus]);

  const tabs: Array<[Tab, string]> = [
    ["atividade", t("tabActivity")],
    ["terminal", t("tabTerminal")],
    ["arquivos", t("tabFiles")],
    ...(bot ? [["tela", t("tabScreen")] as [Tab, string]] : []),  // D-007: the Bot's live screen, read from Hermes
  ];

  return (
    <div aria-label={t("workPanelBtn")} style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--color-card)", color: "var(--color-card-foreground)", fontFamily: "var(--lb-font)" }}>
      <div role="tablist" aria-label={t("workPanelTabs")} className="lb-segmented lb-segmented-fit" style={{ margin: 12 }}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="lb-segment">
            {label}
          </button>
        ))}
      </div>
      <div ref={panelRef} role="tabpanel" style={{ flex: 1, overflowY: "auto", padding: "0 12px 12px" }}>
        {tab === "atividade" && (turns ? <TurnsActivity turns={turns} t={t} /> : <Activity s={s} t={t} />)}
        {tab === "terminal" && <Terminal s={s} t={t} />}
        {tab === "arquivos" && <Files s={s} tools={fileTools} delivered={delivered} botLabel={bot?.label ?? ""} bot={bot?.name} onOpenPage={onOpenPage} t={t} />}
        {tab === "tela" && bot && <ScreenTab bot={bot.name} label={bot.label} />}
      </div>
    </div>
  );
}

function Activity({ s, t }: { s: { items: readonly Item[] }; t: (k: TranslationKey) => string }) {
  const rows = deriveActivity(s);
  if (!rows.length) return <Empty>{t("emptyActivity")}</Empty>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {rows.map((r) => r.kind === "commentary" ? (
        <li key={r.id} style={{ ...muted, padding: "4px 4px 10px" }}>{r.text}</li>
      ) : (
        <li key={r.id} style={item}>
          <span style={{ font: "400 14px/20px var(--lb-font)", color: r.status === "error" ? "var(--color-destructive)" : undefined }}>{ICON[r.status]} <strong style={{ fontWeight: 600 }}>{r.name}</strong></span>
          {r.durationS !== undefined && <span style={muted}> {r.durationS.toFixed(1)}s</span>}
          {r.preview && <div style={{ ...muted, overflowWrap: "anywhere" }}>{r.preview}</div>}
          {r.error && <div style={{ color: "var(--color-destructive)", fontSize: 12, overflowWrap: "anywhere" }}>{r.error}</div>}
        </li>
      ))}
    </ol>
  );
}

function TurnsActivity({ turns, t }: { turns: readonly WorkTurn[]; t: (k: TranslationKey) => string }) {
  const shown = turns.filter((x) => deriveActivity({ items: x.items }).length > 0);
  if (!shown.length) return <Empty>{t("emptyActivity")}</Empty>;
  return (
    <>
      {shown.map((x) => (
        <section key={x.id} data-work-turn={x.id} tabIndex={-1} aria-label={x.label} className="lb-work-turn">
          <h3 className="lb-caption lb-truncate" style={{ margin: "10px 4px 6px" }}>{x.label}</h3>
          <Activity s={{ items: x.items }} t={t} />
        </section>
      ))}
    </>
  );
}

function Terminal({ s, t }: { s: { items: readonly Item[] }; t: (k: TranslationKey) => string }) {
  const rows = deriveTerminal(s);
  if (!rows.length) return <Empty>{t("emptyTerminal")}</Empty>;
  return (
    <div>
      {rows.map((r) => (
        <div key={r.id} style={item}>
          <pre style={{ ...mono, color: "var(--color-primary)" }}>$ {r.command}</pre>
          {r.output !== undefined
            ? <pre style={mono}>{r.output}</pre>
            : <div style={muted}>{r.status === "running" ? t("runningStatus") : t("noOutputChannel")}</div>}
          {r.exitCode !== undefined && <div style={muted}>{t("outputExit")} {r.exitCode}{r.durationS !== undefined ? ` · ${r.durationS.toFixed(1)}s` : ""}</div>}
        </div>
      ))}
    </div>
  );
}

/** File tools Hermes reported, then the files the conversation delivered: a Bot that writes with its terminal (printf >) uses
 *  no file tool, and its file still belongs here. Empty only when there is neither. */
function Files({ s, tools, delivered, botLabel, bot, onOpenPage, t }: { s: { items: readonly Item[] }; tools?: FileTools; delivered: readonly DeliveredFile[];
  botLabel: string; bot?: string; onOpenPage?: (slug: string) => void; t: (k: TranslationKey) => string }) {
  const rows = deriveFiles(s, tools);
  if (!rows.length && !delivered.length) return <Empty>{t("emptyFiles")}</Empty>;
  return (
    <>
      {rows.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((r) => (
            <li key={r.id} style={item}>
              <span style={muted}>{r.op === "write" ? t("writtenOp") : t("readOp")}</span> <code style={{ overflowWrap: "anywhere" }}>{r.path}</code>
              {r.preview && <pre style={{ ...mono, ...muted }}>{r.preview}</pre>}
            </li>
          ))}
        </ul>
      )}
      {delivered.length > 0 && (
        <section aria-label={t("filesDelivered")}>
          <h4 className="lb-caption" style={{ margin: "8px 4px" }}>{t("filesDelivered")}</h4>
          {delivered.map((d) => <FileCard key={d.key} path={d.path} botLabel={botLabel} state={d.state} onDownload={d.onDownload} bot={bot} onOpenPage={onOpenPage} />)}
        </section>
      )}
    </>
  );
}
