// dashboard/src/components/agent/AgentPanel.tsx
// The Bot's profile beside the conversation (Dots §2.3/2.4, brief §2.4): who it is, what it is doing, what is
// scheduled, what it finished, its budget, and the controls. Everything shown comes from a backend read; an empty
// list says so. Pausing is the real contract v0.4 B3 route; a pause LuveBot did not set is explained, never lifted.
// Rules, routines and identity open as full screens (their forms must not sit next to the composer).

import { ApprovalSurfaceCard } from "./ApprovalSurfaceCard";
import { activityTitle } from "../labels";
import React from "react";
import type { ActivityItem, Bot, BudgetLimit, Routine } from "../../api/types";
import { ApiError, getActivity, getBudget, getRoutines, pauseBot, resumeBot, stopActivity } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { Avatar } from "../ui/Avatar";
import { PagesSection } from "../pages/PagesSection";
import { AttentionBadge } from "../ui/AttentionBadge";
import { attention, type Attention } from "../messenger/attention";
import { formatCents } from "../costs";
import { ChevronRightIcon } from "../Icons";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export type AgentPage = "profile" | "rules" | "routines" | "costs" | "pages";

export interface AgentPanelProps {
  bot: Bot;
  pendingApprovals?: number;
  onOpenPage: (page: AgentPage) => void;
  onChanged?: () => void;  // the Bot's state changed (pause/resume): reload it
  onOpenPageSlug?: (slug: string) => void;  // one page beside the conversation (contract v0.5)
}

type Tab = "running" | "scheduled" | "done";
type Load<T> = { state: "loading" } | { state: "error"; message: ErrorState } | { state: "ready"; data: T };

function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const { t } = useLuveI18n();
  const [load, setLoad] = React.useState<Load<T>>({ state: "loading" });
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    setLoad({ state: "loading" });
    fn().then((data) => alive && setLoad({ state: "ready", data }), (e) => alive && setLoad({ state: "error", message: humanError(e, t, "unexpectedError") }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return [load, () => setNonce((n) => n + 1)];
}

const PAUSE_ERRORS: Record<string, TranslationKey> = {
  paused_all: "agentErrPausedAll", budget_held: "agentErrBudgetHeld", not_ours: "agentErrNotOurs", loopback_not_human: "agentErrLoopback",
};
const STATE_LABEL: Record<Exclude<Attention, "idle">, TranslationKey> = {
  needs_you: "statusNeedsYouLabel", error: "statusErrorLabel", offline: "statusOfflineLabel", paused: "statusPausedLabel", working: "statusWorkingLabel", unread: "statusUnreadLabel",
};
const PAUSED_REASON: Record<string, TranslationKey> = {
  user: "agentPausedUser", budget: "agentPausedBudget", estop: "agentPausedEstop", all: "agentPausedAll",
};

const sectionTitle: React.CSSProperties = { margin: "24px 4px 8px" };
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="lb-group lb-subhead" style={{ padding: "14px 16px" }}>{children}</p>;
}

function Rows<T>({ load, empty, render }: { load: Load<T[]>; empty: string; render: (x: T, i: number) => React.ReactNode }) {
  const { t } = useLuveI18n();
  if (load.state === "loading") return <Empty>{t("agentLoading")}</Empty>;
  if (load.state === "error") return <p role="alert" className="lb-group lb-subhead" style={{ padding: "14px 16px", color: "var(--color-destructive)" }}><ErrorNote error={load.message} /></p>;
  if (!load.data.length) return <Empty>{empty}</Empty>;
  return <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>{load.data.map((x, i) => <li key={i} className="lb-row lb-row-flat">{render(x, i)}</li>)}</ul>;
}

export function AgentPanel({ bot, pendingApprovals = 0, onOpenPage, onChanged, onOpenPageSlug }: AgentPanelProps) {
  const { t, locale } = useLuveI18n();
  const name = bot.display?.label || bot.name;
  const [tab, setTab] = React.useState<Tab>("running");
  const [running, reloadRunning] = useLoad(() => getActivity({ tab: "running", bot: bot.name }).then((r) => r.items ?? []), [bot.name]);
  const [done] = useLoad(() => getActivity({ tab: "done", bot: bot.name }).then((r) => r.items ?? []), [bot.name]);
  const [routines] = useLoad(() => getRoutines({ bot: bot.name }).then((r) => r.routines ?? []), [bot.name]);
  const [budget] = useLoad(() => getBudget().then((b) => b.limits.filter((l) => l.scope === "bot" && l.ref === bot.name)), [bot.name]);

  const [confirmStop, setConfirmStop] = React.useState<string | null>(null);
  const [stopping, setStopping] = React.useState<Set<string>>(new Set());
  const [pausing, setPausing] = React.useState(false);   // the confirmation is open
  const [stopActive, setStopActive] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);

  const state = attention(bot, pendingApprovals);
  const paused = bot.status === "paused";
  const reason = paused ? PAUSED_REASON[bot.status_reason ?? ""] : undefined;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await fn(); setPausing(false); onChanged?.(); }
    catch (e) { setError(e instanceof ApiError && PAUSE_ERRORS[e.code] ? t(PAUSE_ERRORS[e.code]) : humanError(e, t, "unexpectedError")); }
    finally { setBusy(false); }
  }

  async function stop(id: string) {
    setConfirmStop(null); setError(null);
    setStopping((s) => new Set(s).add(id));
    try { await stopActivity(id, {}); reloadRunning(); }
    catch (e) {
      setStopping((s) => { const n = new Set(s); n.delete(id); return n; });
      setError(humanError(e, t, "unexpectedError"));
    }
  }

  const tabs: Array<[Tab, TranslationKey]> = [["running", "tabRunning"], ["scheduled", "tabScheduled"], ["done", "tabDone"]];
  const when = (iso?: string | number | null) => (iso ? new Date(typeof iso === "number" ? iso * 1000 : iso).toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" }) : null);

  return (
    <div style={{ fontFamily: "var(--lb-font)" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", paddingTop: 8 }}>
        <Avatar name={name} avatar={bot.display?.avatar} color={bot.display?.color} size={80} />
        <h2 className="lb-title" style={{ marginTop: 12 }}>{name}</h2>
        {bot.display?.role && <div className="lb-subhead">{bot.display.role}</div>}
        <div className="lb-caption" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
          <AttentionBadge state={state} />
          {reason ? t(reason) : state !== "idle" ? t(STATE_LABEL[state]) : null}
        </div>
        {bot.display?.call_me && <div className="lb-caption" style={{ marginTop: 4 }}>{t("agentCallsYou", { name: bot.display.call_me })}</div>}
        {bot.model?.name && <div className="lb-pill" style={{ marginTop: 10 }}>{t("agentModel", { model: bot.model.name })}</div>}
      </div>

      <div role="tablist" aria-label={t("agentActivityTabs")} className="lb-segmented" style={{ marginTop: 24 }}>
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="lb-segment">
            {t(label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" style={{ marginTop: 12 }}>
        {tab === "running" && <Rows<ActivityItem> load={running} empty={t("agentEmptyRunning")} render={(it) => (
          <>
            <span className="lb-body lb-clamp-2" style={{ flex: 1, minWidth: 0 }}>{activityTitle(it, t)}</span>
            {stopping.has(it.id) ? <span className="lb-caption">{t("statusStopping")}</span>
              : confirmStop === it.id ? <button type="button" onClick={() => void stop(it.id)} className="lb-btn lb-btn-destructive">{t("agentConfirmStop")}</button>
              : <button type="button" onClick={() => setConfirmStop(it.id)} className="lb-btn lb-btn-destructive">{t("stopBtn")}</button>}
          </>
        )} />}
        {tab === "scheduled" && <Rows<Routine> load={routines} empty={t("agentEmptyScheduled")} render={(r) => (
          <span className="lb-row-stack">
            <span className="lb-body lb-truncate">{r.name}</span>
            <span className="lb-caption">
              <span className="lb-mono">{r.schedule.expr}</span>
              {" · "}
              {r.state === "paused" || !r.enabled ? t("statusPausedLabel") : when(r.next_run_at) ? t("nextRunLabel", { time: when(r.next_run_at)! }) : null}
            </span>
          </span>
        )} />}
        {tab === "done" && <Rows<ActivityItem> load={done} empty={t("agentEmptyDone")} render={(it) => (
          <span className="lb-row-stack">
            <span className="lb-body lb-clamp-2">{activityTitle(it, t)}</span>
            <span className="lb-caption">{[when(it.ended_at), it.cost_cents != null ? formatCents(it.cost_cents, locale) : null].filter(Boolean).join(" · ")}</span>
          </span>
        )} />}
      </div>

      <h3 className="lb-headline" style={sectionTitle}>{t("agentBudgetTitle")}</h3>
      <Rows<BudgetLimit> load={budget} empty={t("agentBudgetNone")} render={(l) => (
        <span style={{ flex: 1 }}>
          <span className="lb-body" style={{ display: "block", fontVariantNumeric: "tabular-nums" }}>{t("agentBudgetLine", { period: t(l.period === "day" ? "agentPeriodDay" : "agentPeriodMonth"), spent: formatCents(l.spent_cents, locale), cap: formatCents(l.cents, locale) })}</span>
          <span role="progressbar" aria-label={t("agentBudgetTitle")} aria-valuenow={Math.min(100, Math.round(l.percent))} aria-valuemin={0} aria-valuemax={100}
            style={{ display: "block", height: 6, marginTop: 8, borderRadius: 3, background: "var(--lb-fill-2)" }}>
            <span style={{ display: "block", height: "100%", borderRadius: 3, width: `${Math.min(100, l.percent)}%`, background: l.percent >= 100 ? "var(--color-destructive)" : l.percent >= 80 ? "var(--color-warning)" : "var(--color-success)" }} />
          </span>
        </span>
      )} />
      <button type="button" onClick={() => onOpenPage("costs")} className="lb-btn lb-btn-plain" style={{ marginTop: 6 }}>{t("agentManageCosts")}</button>

      <PagesSection bot={bot.name} label={bot.display?.label} isDefault={bot.is_default} onOpen={(slug) => (onOpenPageSlug ? onOpenPageSlug(slug) : onOpenPage("pages"))} onOpenAll={() => onOpenPage("pages")} />

      <ApprovalSurfaceCard bot={bot.name} />

      <h3 className="lb-headline" style={sectionTitle}>{t("agentCustomize")}</h3>
      <ul className="lb-group" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {([["profile", "agentIdentity"], ["rules", "agentRules"], ["routines", "agentRoutines"]] as Array<[AgentPage, TranslationKey]>).map(([page, label]) => (
          <li key={page} className="lb-row lb-row-flat" style={{ padding: 0 }}>
            <button type="button" onClick={() => onOpenPage(page)} className="lb-contact" style={{ borderRadius: 0, padding: "0 16px", minHeight: 52 }}>
              <span className="lb-body" style={{ flex: 1 }}>{t(label)}</span>
              <span aria-hidden="true" style={{ color: "var(--color-muted-foreground)", display: "inline-flex" }}><ChevronRightIcon size={16} /></span>
            </button>
          </li>
        ))}
      </ul>

      <div style={{ marginTop: 20 }}>
        {paused && bot.status_reason === "user" && <button type="button" disabled={busy} onClick={() => void act(() => resumeBot(bot.name))} className="lb-btn lb-btn-primary">{t("agentResume")}</button>}
        {!paused && bot.status !== "offline" && !pausing && <button type="button" onClick={() => { setStopActive(false); setPausing(true); }} className="lb-btn lb-btn-destructive">{t("agentPause")}</button>}
        {!paused && pausing && (
          <div className="lb-group" style={{ padding: 16 }}>
            <p className="lb-body" style={{ margin: 0 }}>{t("agentPauseExplain")}</p>
            {bot.is_default && <p className="lb-subhead" style={{ marginTop: 6 }}>{t("agentPauseDefaultScope")}</p>}
            <label className="lb-body" style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, minHeight: 44 }}>
              <input type="checkbox" checked={stopActive} onChange={(e) => setStopActive(e.target.checked)} />
              {t("agentPauseStopActive")}
            </label>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" disabled={busy} onClick={() => void act(() => pauseBot(bot.name, { stop_active: stopActive }))} className="lb-btn lb-btn-destructive">{t("agentPauseConfirm")}</button>
              <button type="button" onClick={() => setPausing(false)} className="lb-btn">{t("cancelBtn")}</button>
            </div>
          </div>
        )}
        {error && <p role="alert" className="lb-subhead" style={{ color: "var(--color-destructive)", marginTop: 8 }}><ErrorNote error={error} /></p>}
      </div>
    </div>
  );
}
