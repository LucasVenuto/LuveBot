// dashboard/src/components/Hoje.tsx
// Home "Hoje" (spec §4.2) with 3 columns, empty states, and onboarding templates.
// Data ONLY from backend contracts: /bots, /approvals, /activity, /costs, /routines, /rooms, /handoffs.
// Never invent data: if data is absent, show an honest empty state or omit optional blocks.

import { useRuleLabels, approvalTitle } from "./approvals/humanize";
import { activityTitle } from "./labels";
import React, { useState, useEffect, useMemo } from "react";
import type {
  Bot,
  Approval,
  ActivityItem,
  Routine,
  Handoff,
  CostsResponse,
  BudgetSnapshot,
} from "../api/types";
import {
  resolveApproval,
  getApprovals,
  getActivity,
  getRoutines,
  getHandoffs,
  getCosts,
  getBudget,
} from "../api/client";
import { formatCents } from "./costs";
import { ApprovalDecision } from "./chat/InlineApproval";
import { Avatar } from "./ui/Avatar";
import { BOT_COLORS } from "../api/templates";
import { needsYou, inProgress, completed, upcomingRoutines as nextRoutines, activeBotCount } from "./home/derive";
import { useLuveI18n, type TranslationKey } from "../i18n";
import { BotsLoading, BotsError, type ListStatus } from "./ui/ListState";
import { Markdown } from "../lib/render/markdown";
import {
  CheckCircleIcon,
  ClockIcon,
  BotIcon,
  ArrowRightIcon,
  PlusIcon,
} from "./Icons";
import { humanError, ErrorNote, type ErrorState } from "./ui/ErrorNote";

export type { NeedsYouItem } from "./home/derive";

export interface HojeProps {
  bots?: Bot[];
  approvals?: Approval[];
  handoffs?: Handoff[];
  inProgressItems?: ActivityItem[];
  completedItems?: ActivityItem[];
  routines?: Routine[];
  costs?: CostsResponse;
  budget?: BudgetSnapshot;
  onOpenCreateBot?: (templateId?: string) => void;
  onNavigateTab?: (tab: string) => void;
  onSelectBot?: (name: string) => void;
  onStopActivity?: (id: string) => void | Promise<unknown>;
  onRunRoutine?: (id: string) => void | Promise<unknown>;
  autoFetch?: boolean;
  /** Where the Bot list stands: the onboarding ("no Bot yet") only once it loaded empty (ui/ListState). */
  botsStatus?: ListStatus;
  onRetryBots?: () => void;
}

export function Hoje({
  bots = [],
  approvals: initialApprovals,
  handoffs: initialHandoffs,
  inProgressItems: initialInProgress,
  completedItems: initialCompleted,
  routines: initialRoutines,
  costs: initialCosts,
  budget: initialBudget,
  onOpenCreateBot,
  onNavigateTab,
  onSelectBot,
  onStopActivity,
  onRunRoutine,
  autoFetch = false,
  botsStatus = "ready",
  onRetryBots,
}: HojeProps = {}) {
  const { t, locale } = useLuveI18n();
  const ruleLabel = useRuleLabels();
  const [confirming, setConfirming] = useState<string | null>(null);  // "stop:<id>" or "test:<id>": the second click acts
  const [actionError, setActionError] = useState<ErrorState | null>(null);
  const act = (fn: () => void | Promise<unknown>) => {
    setConfirming(null); setActionError(null);
    const fail = (e: unknown) => setActionError(humanError(e, t, "unexpectedError"));
    try { Promise.resolve(fn()).catch(fail); } catch (e) { fail(e); }
  };

  // Internal state for preloaded props or auto-fetched data
  const [approvalsData, setApprovalsData] = useState<Approval[]>(initialApprovals || []);
  const [handoffsData, setHandoffsData] = useState<Handoff[]>(initialHandoffs || []);
  const [inProgressData, setInProgressData] = useState<ActivityItem[]>(initialInProgress || []);
  const [completedData, setCompletedData] = useState<ActivityItem[]>(initialCompleted || []);
  const [routinesData, setRoutinesData] = useState<Routine[]>(initialRoutines || []);
  const [costsData, setCostsData] = useState<CostsResponse | undefined>(initialCosts);
  const [budgetData, setBudgetData] = useState<BudgetSnapshot | undefined>(initialBudget);

  // Sync state if props change
  useEffect(() => {
    if (initialApprovals !== undefined) setApprovalsData(initialApprovals);
  }, [initialApprovals]);

  useEffect(() => {
    if (initialHandoffs !== undefined) setHandoffsData(initialHandoffs);
  }, [initialHandoffs]);

  useEffect(() => {
    if (initialInProgress !== undefined) setInProgressData(initialInProgress);
  }, [initialInProgress]);

  useEffect(() => {
    if (initialCompleted !== undefined) setCompletedData(initialCompleted);
  }, [initialCompleted]);

  useEffect(() => {
    if (initialRoutines !== undefined) setRoutinesData(initialRoutines);
  }, [initialRoutines]);

  useEffect(() => {
    if (initialCosts !== undefined) setCostsData(initialCosts);
  }, [initialCosts]);

  useEffect(() => {
    if (initialBudget !== undefined) setBudgetData(initialBudget);
  }, [initialBudget]);

  // Optional auto-fetch when props are not provided (e.g. running in production shell)
  useEffect(() => {
    if (!autoFetch) return;

    let mounted = true;

    // Load approvals
    if (initialApprovals === undefined) {
      getApprovals()
        .then((res) => {
          if (mounted && res?.approvals) setApprovalsData(res.approvals);
        })
        .catch(() => {});
    }

    // Load handoffs
    if (initialHandoffs === undefined) {
      getHandoffs()
        .then((res) => {
          if (mounted && res?.handoffs) setHandoffsData(res.handoffs);
        })
        .catch(() => {});
    }

    // Load in-progress activities
    if (initialInProgress === undefined) {
      getActivity({ tab: "running" })
        .then((res) => {
          if (mounted && res?.items) setInProgressData(res.items);
        })
        .catch(() => {});
    }

    // Load completed activities
    if (initialCompleted === undefined) {
      getActivity({ tab: "done" })
        .then((res) => {
          if (mounted && res?.items) setCompletedData(res.items);
        })
        .catch(() => {});
    }

    // Load routines
    if (initialRoutines === undefined) {
      getRoutines()
        .then((res) => {
          if (mounted && res?.routines) setRoutinesData(res.routines);
        })
        .catch(() => {});
    }

    // Load costs & budget
    if (initialCosts === undefined) {
      getCosts({ period: "day" })
        .then((res) => {
          if (mounted && res) setCostsData(res);
        })
        .catch(() => {});
    }
    if (initialBudget === undefined) {
      getBudget()
        .then((res) => {
          if (mounted && res) setBudgetData(res);
        })
        .catch(() => {});
    }

    return () => {
      mounted = false;
    };
  }, [
    autoFetch,
    initialApprovals,
    initialHandoffs,
    initialInProgress,
    initialCompleted,
    initialRoutines,
    initialCosts,
    initialBudget,
  ]);

  // Derived: Active Bots Count
  const activeCount = activeBotCount(bots);

  const activeBotsLabel =
    activeCount === 0
      ? t("activeBotsCount")
      : activeCount === 1
      ? t("activeBotCountParamSingle", { count: activeCount })
      : t("activeBotsCountParam", { count: activeCount });

  // Columns and footer (home/derive.ts)
  const needsYouItems = useMemo(() => needsYou(approvalsData, handoffsData), [approvalsData, handoffsData]);
  const inProgressList = useMemo(() => inProgress(inProgressData), [inProgressData]);
  const completedList = useMemo(() => completed(completedData), [completedData]);
  const upcomingRoutines = useMemo(() => nextRoutines(routinesData), [routinesData]);

  // Subheader financial summary (honest: only rendered when real cost data is available)
  const todaySpendCents = costsData?.totals?.spend_cents;
  const globalDayLimit = budgetData?.limits?.find(
    (l) => l.scope === "global" && l.period === "day"
  );

  const botOf = (name: string) => bots.find((b) => b.name === name);
  const who = (name: string) => {
    const b = botOf(name);
    return { label: b?.display?.label || name, avatar: b?.display?.avatar, color: b?.display?.color };
  };
  const templates: Array<[string, TranslationKey, TranslationKey, string]> = [
    ["gabinete", "templateGabineteTitle", "templateGabineteDesc", BOT_COLORS[6].hex],
    ["vendas", "templateVendasTitle", "templateVendasDesc", BOT_COLORS[0].hex],
    ["dev", "templateDevTitle", "templateDevDesc", BOT_COLORS[2].hex],
  ];
  const sectionHead = (title: string, count: React.ReactNode, countId: string) => (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, padding: "0 4px 8px" }}>
      <h2 className="lb-headline">{title}</h2>
      <span data-testid={countId} className="lb-caption">{count}</span>
    </div>
  );
  const empty = (testid: string, icon: React.ReactNode, title: string, next: string, action?: React.ReactNode) => (
    <div data-testid={testid} className="lb-group lb-empty">
      <span className="lb-empty-icon" aria-hidden="true">{icon}</span>
      <h3 className="lb-headline">{title}</h3>
      <p className="lb-subhead" style={{ maxWidth: 320 }}>{next}</p>
      {action}
    </div>
  );
  const face = (name: string) => {
    const w = who(name);
    return <Avatar name={w.label} avatar={w.avatar} color={w.color} size={36} />;
  };

  return (
    <div className="lb-appear" style={{ display: "flex", flexDirection: "column", gap: 32, padding: "28px 24px 40px", width: "100%", maxWidth: 1180, margin: "0 auto", boxSizing: "border-box", fontFamily: "var(--lb-font)" }}>
      {actionError && <div role="alert" className="lb-group lb-subhead" style={{ padding: "12px 16px", color: "var(--color-destructive)" }}><ErrorNote error={actionError} /></div>}

      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 className="lb-large-title">{t("hojeTitle")}</h1>
          <p className="lb-subhead" style={{ fontSize: 15, marginTop: 2 }}>
            {new Date().toLocaleDateString(locale === "pt" ? "pt-BR" : "en-US", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {todaySpendCents !== undefined && todaySpendCents !== null && (
            <span data-testid="hoje-spend-badge" className="lb-pill" style={{ fontVariantNumeric: "tabular-nums" }}>
              {globalDayLimit && globalDayLimit.cents > 0
                ? t("todaySpendVsBudget", { spend: formatCents(todaySpendCents, locale), budget: formatCents(globalDayLimit.cents, locale) })
                : t("todaySpendOnly", { spend: formatCents(todaySpendCents, locale) })}
            </span>
          )}
          {botsStatus === "ready" && <span className="lb-pill"><span data-testid="active-bots-count">{activeBotsLabel}</span></span>}
        </div>
      </header>

      {botsStatus === "loading" && <BotsLoading />}
      {botsStatus === "error" && <BotsError onRetry={onRetryBots} />}
      {botsStatus === "ready" && bots.length === 0 && (
        <section aria-label="onboarding">
          <div style={{ padding: "0 4px 12px" }}>
            <h2 className="lb-title">{t("onboardingTitle")}</h2>
            <p className="lb-subhead" style={{ marginTop: 4 }}>{t("onboardingSubtitle")}</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            {templates.map(([id, title, desc, color]) => (
              <div key={id} className="lb-group" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16 }}>
                <Avatar name={t(title)} color={color} size={40} />
                <h3 className="lb-headline">{t(title)}</h3>
                <p className="lb-subhead" style={{ flex: 1 }}>{t(desc)}</p>
                <button type="button" className="lb-btn lb-btn-primary" style={{ alignSelf: "flex-start" }} onClick={() => onOpenCreateBot?.(id)}>
                  {t("createTemplateBtn")}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="lb-sections"><div className="lb-section-grid">
        <section aria-label={t("needsYouTitle")}>
          {sectionHead(t("needsYouTitle"), needsYouItems.length, "needs-you-count")}
          {needsYouItems.length === 0
            ? empty("needs-you-empty", <CheckCircleIcon size={20} />, t("needsYouEmpty"), t("needsYouEmptyNextStep"))
            : (
              <div className="lb-group">
                {needsYouItems.map((item) => (
                  <div key={item.id} data-testid={`needs-you-item-${item.id}`} className="lb-row" style={{ alignItems: "flex-start" }}>
                    {face(item.bot)}
                    <div className="lb-row-stack">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span className="lb-headline lb-truncate">{who(item.bot).label}</span>
                        <span className="lb-caption">{item.kind === "approval" ? t("needsYouKindApproval") : t("needsYouKindHandoff")}</span>
                      </div>
                      {item.kind === "approval" && item.rawApproval
                        ? <div className="lb-body lb-clamp-2">{approvalTitle(item.rawApproval, ruleLabel, t)}</div>
                        : <div className="lb-body lb-clamp-2"><Markdown text={item.title} /></div>}
                      {item.detail && <div className="lb-subhead lb-mono" style={{ overflowWrap: "anywhere" }}><Markdown text={item.detail} /></div>}
                      <div style={{ marginTop: 6 }}>
                        {item.kind === "approval" && item.rawApproval ? (
                          <ApprovalDecision bare bot={item.bot} pending={item.rawApproval.status === "pending"}
                            request={{ requestId: item.rawApproval.request_id, digest: item.rawApproval.digest || null, choices: item.rawApproval.allowed_choices,
                              command: item.rawApproval.command_redacted, description: item.rawApproval.description, patternKey: item.rawApproval.pattern_keys?.[0] }}
                            resolve={(body) => resolveApproval(item.rawApproval!.request_id, body)} />
                        ) : (
                          <button type="button" className="lb-btn" onClick={() => onNavigateTab?.("atividade")}>
                            <span>{t("reviewHandoffBtn")}</span><ArrowRightIcon size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>

        <section aria-label={t("inProgressTitle")}>
          {sectionHead(t("inProgressTitle"), inProgressList.length, "in-progress-count")}
          {inProgressList.length === 0
            ? empty("in-progress-empty", <ClockIcon size={20} />, t("inProgressEmpty"), t("inProgressEmptyNextStep"))
            : (
              <div className="lb-group">
                {inProgressList.map((item) => (
                  <div key={item.id} data-testid={`in-progress-item-${item.id}`} className="lb-row">
                    {face(item.bot)}
                    <div className="lb-row-stack">
                      <div className="lb-body lb-clamp-2"><Markdown text={activityTitle(item, t)} /></div>
                      <span className="lb-caption">
                        {who(item.bot).label}
                        {item.checkpoint && <> · <span>{t("checkpointDoneParam", { done: item.checkpoint.done, total: item.checkpoint.total })}</span></>}
                      </span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                      <span className="lb-caption">
                        {item.duration_s !== null && item.duration_s !== undefined && <span>{item.duration_s}s</span>}
                        {item.cost_cents !== null && item.cost_cents !== undefined && <span> · {formatCents(item.cost_cents, locale)}</span>}
                      </span>
                      {onStopActivity && (
                        <button type="button" className="lb-btn lb-btn-destructive"
                          onClick={() => { if (confirming === `stop:${item.id}`) act(() => onStopActivity(item.id)); else setConfirming(`stop:${item.id}`); }}>
                          {confirming === `stop:${item.id}` ? t("agentConfirmStop") : t("stopBtn")}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>

        <section aria-label={t("completedTodayTitle")}>
          {sectionHead(t("completedTodayTitle"), completedList.length, "completed-today-count")}
          {completedList.length === 0
            ? empty("completed-today-empty", <BotIcon size={20} />, t("completedTodayEmpty"), t("completedTodayEmptyNextStep"))
            : (
              <div className="lb-group">
                {completedList.map((item) => (
                  <div key={item.id} data-testid={`completed-today-item-${item.id}`} className="lb-row">
                    {face(item.bot)}
                    <div className="lb-row-stack">
                      <div className="lb-body lb-clamp-2"><Markdown text={activityTitle(item, t)} /></div>
                      <span className="lb-caption">
                        {who(item.bot).label}
                        {item.cost_cents !== null && item.cost_cents !== undefined && <> · {formatCents(item.cost_cents, locale)}</>}
                      </span>
                    </div>
                    <button type="button" className="lb-btn lb-btn-plain" onClick={() => onSelectBot?.(item.bot)}>
                      <span>{t("viewConversationBtn")}</span><ArrowRightIcon size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
        </section>
      </div></div>

      <section aria-label={t("nextRoutinesTitle")}>
        {sectionHead(t("nextRoutinesTitle"), upcomingRoutines.length === 0 ? t("zeroScheduled") : t("scheduledCount", { count: upcomingRoutines.length }), "routines-count")}
        {upcomingRoutines.length === 0
          ? empty("hoje-routines-empty", <ClockIcon size={20} />, t("noRoutinesScheduled"), t("hojeRoutinesNext"),
              onNavigateTab && (
                <button type="button" className="lb-btn" style={{ marginTop: 6 }} onClick={() => onNavigateTab("rotinas")}>
                  <PlusIcon size={14} /><span>{t("createFirstRoutine")}</span>
                </button>
              ))
          : (
            <div className="lb-group">
              {upcomingRoutines.map((routine) => {
                const scheduleLabel = typeof routine.schedule === "object" ? routine.schedule.expr || routine.schedule.kind || "cron" : String(routine.schedule);
                return (
                  <div key={routine.id} data-testid={`routine-item-${routine.id}`} className="lb-row">
                    {face(routine.bot)}
                    <div className="lb-row-stack">
                      <span className="lb-body lb-truncate">{routine.name}</span>
                      <span className="lb-caption">{who(routine.bot).label} · <span className="lb-mono">{scheduleLabel}</span></span>
                    </div>
                    {onRunRoutine && (
                      <button type="button" className="lb-btn" title={t("hojeTestRealWork")}
                        onClick={() => { if (confirming === `test:${routine.id}`) act(() => onRunRoutine(routine.id)); else setConfirming(`test:${routine.id}`); }}>
                        {confirming === `test:${routine.id}` ? t("hojeConfirmTest") : t("btnTestRoutine")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
      </section>
    </div>
  );
}
