// dashboard/src/components/Hoje.tsx
// Home "Hoje" (spec §4.2) with 3 columns, empty states, and onboarding templates.
// Data ONLY from backend contracts: /bots, /approvals, /activity, /costs, /routines, /rooms, /handoffs.
// Never invent data: if data is absent, show an honest empty state or omit optional blocks.

import { useRuleLabels, approvalTitle } from "./approvals/humanize";
import { activityTitle } from "./labels";
import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import type {
  Bot,
  Approval,
  ActivityItem,
  Routine,
  Handoff,
  CostsResponse,
  BudgetSnapshot,
  WaitingItem,
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
import { useWaiting, waitView, sinceText } from "./home/waiting";
import { useLiveRefresh, LIVE_REFRESH_MS } from "../hooks/useLiveRefresh";
import { needsYou, inProgress, completed, upcomingRoutines as nextRoutines, activeBotCount, type NeedsYouItem } from "./home/derive";
import { useLuveI18n, type TranslationKey } from "../i18n";
import { BotsLoading, BotsError, type ListStatus } from "./ui/ListState";
import { Markdown } from "../lib/render/markdown";
import { visibleTokens } from "../lib/hiddenChars";
import {
  CheckCircleIcon,
  ClockIcon,
  BotIcon,
  ArrowRightIcon,
  PlusIcon,
} from "./Icons";
import { humanError, ErrorNote, type ErrorState } from "./ui/ErrorNote";
import { InactivityBanner } from "./settings/Inactivity";
import { RoutineSuggestions } from "./routines/RoutineSuggestions";

export type { NeedsYouItem } from "./home/derive";

type Source = "approvals" | "handoffs" | "running" | "done" | "routines";
const SLOW_MS = 60_000;
// What Hoje last read, for the life of the page (never written anywhere): coming back to it draws at once, then reads again underneath.
const seen: { approvals?: Approval[]; handoffs?: Handoff[]; running?: ActivityItem[]; done?: ActivityItem[]; routines?: Routine[]; costs?: CostsResponse; budget?: BudgetSnapshot } = {};

export interface HojeProps {
  bots?: Bot[];
  approvals?: Approval[];
  handoffs?: Handoff[];
  inProgressItems?: ActivityItem[];
  completedItems?: ActivityItem[];
  routines?: Routine[];
  costs?: CostsResponse;
  budget?: BudgetSnapshot;
  /** what the Bots wait for outside LuveBot's inbox (v0.9 §7); read by itself (every 30 s at most) when not given and `autoFetch` is on */
  waiting?: WaitingItem[];
  onOpenCreateBot?: (templateId?: string) => void;
  onNavigateTab?: (tab: string) => void;
  onSelectBot?: (name: string, session?: string | null) => void;
  /** a decision was taken here: the app reads the Bots and the "!" of the sidebar again at once, instead of at its next 15 s turn */
  onChanged?: () => void;
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
  waiting: initialWaiting,
  onOpenCreateBot,
  onNavigateTab,
  onSelectBot,
  onChanged,
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

  // What Hoje shows: the props when given; otherwise what it last read (kept for the life of the page, so coming back draws at once) and then
  // what it reads now, underneath. A column says "loading" (or that the read failed) until it has an answer: an empty list is only drawn once a
  // read really came back empty (perf-tela.md item 2: it used to say "nothing needs you" while the first reads were still on their way).
  const mine = autoFetch ? seen : {};
  const [approvalsData, setApprovalsData] = useState<Approval[]>(initialApprovals ?? mine.approvals ?? []);
  const [handoffsData, setHandoffsData] = useState<Handoff[]>(initialHandoffs ?? mine.handoffs ?? []);
  const [inProgressData, setInProgressData] = useState<ActivityItem[]>(initialInProgress ?? mine.running ?? []);
  const [completedData, setCompletedData] = useState<ActivityItem[]>(initialCompleted ?? mine.done ?? []);
  const [routinesData, setRoutinesData] = useState<Routine[]>(initialRoutines ?? mine.routines ?? []);
  const [costsData, setCostsData] = useState<CostsResponse | undefined>(initialCosts ?? mine.costs);
  const [budgetData, setBudgetData] = useState<BudgetSnapshot | undefined>(initialBudget ?? mine.budget);
  const [answered, setAnswered] = useState<Record<Source, boolean>>(() => ({
    approvals: !autoFetch || initialApprovals !== undefined || !!mine.approvals, handoffs: !autoFetch || initialHandoffs !== undefined || !!mine.handoffs,
    running: !autoFetch || initialInProgress !== undefined || !!mine.running, done: !autoFetch || initialCompleted !== undefined || !!mine.done,
    routines: !autoFetch || initialRoutines !== undefined || !!mine.routines,
  }));
  const [failed, setFailed] = useState<Partial<Record<Source, boolean>>>({});
  const alive = useRef(true);
  const slowAt = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Sync state if props change
  useEffect(() => { if (initialApprovals !== undefined) setApprovalsData(initialApprovals); }, [initialApprovals]);
  useEffect(() => { if (initialHandoffs !== undefined) setHandoffsData(initialHandoffs); }, [initialHandoffs]);
  useEffect(() => { if (initialInProgress !== undefined) setInProgressData(initialInProgress); }, [initialInProgress]);
  useEffect(() => { if (initialCompleted !== undefined) setCompletedData(initialCompleted); }, [initialCompleted]);
  useEffect(() => { if (initialRoutines !== undefined) setRoutinesData(initialRoutines); }, [initialRoutines]);
  useEffect(() => { if (initialCosts !== undefined) setCostsData(initialCosts); }, [initialCosts]);
  useEffect(() => { if (initialBudget !== undefined) setBudgetData(initialBudget); }, [initialBudget]);

  // Reads whatever the props did not give, all at once. What needs the person (approvals, handoffs, what runs) is asked every time; what changes
  // slowly (the day's finished work, routines, spending, the budget) at most once a minute.
  const loadAll = useCallback((force = false) => {
    if (!autoFetch) return;
    const take = <T,>(key: Source, ask: () => Promise<T>, put: (v: T) => void) => {
      ask().then((v) => { if (!alive.current) return; put(v); setAnswered((a) => (a[key] ? a : { ...a, [key]: true })); setFailed((f) => (f[key] ? { ...f, [key]: false } : f)); },
        () => { if (alive.current) setFailed((f) => (f[key] ? f : { ...f, [key]: true })); });   // a failed read keeps what was there
    };
    if (initialApprovals === undefined) take("approvals", getApprovals, (res) => { if (res?.approvals) { seen.approvals = res.approvals; setApprovalsData(res.approvals); } });
    if (initialHandoffs === undefined) take("handoffs", getHandoffs, (res) => { if (res?.handoffs) { seen.handoffs = res.handoffs; setHandoffsData(res.handoffs); } });
    if (initialInProgress === undefined) take("running", () => getActivity({ tab: "running" }), (res) => { if (res?.items) { seen.running = res.items; setInProgressData(res.items); } });
    if (!force && Date.now() - slowAt.current < SLOW_MS) return;
    slowAt.current = Date.now();
    if (initialCompleted === undefined) take("done", () => getActivity({ tab: "done" }), (res) => { if (res?.items) { seen.done = res.items; setCompletedData(res.items); } });
    if (initialRoutines === undefined) take("routines", getRoutines, (res) => { if (res?.routines) { seen.routines = res.routines; setRoutinesData(res.routines); } });
    if (initialCosts === undefined) getCosts({ period: "day" }).then((res) => { if (alive.current && res) { seen.costs = res; setCostsData(res); } }, () => {});
    if (initialBudget === undefined) getBudget().then((res) => { if (alive.current && res) { seen.budget = res; setBudgetData(res); } }, () => {});
  }, [autoFetch, initialApprovals, initialHandoffs, initialInProgress, initialCompleted, initialRoutines, initialCosts, initialBudget]);
  useEffect(() => { loadAll(true); }, [loadAll]);
  useLiveRefresh(() => loadAll(), LIVE_REFRESH_MS);   // the sidebar already follows the Bots every 15 s: so does this screen, while visible

  const feed = useWaiting(autoFetch && initialWaiting === undefined);
  const waits = initialWaiting ?? feed?.waiting ?? [];

  // Derived: Active Bots Count
  const activeCount = activeBotCount(bots);

  const activeBotsLabel =
    activeCount === 0
      ? t("activeBotsCount")
      : activeCount === 1
      ? t("activeBotCountParamSingle", { count: activeCount })
      : t("activeBotsCountParam", { count: activeCount });

  // Columns and footer (home/derive.ts)
  const needsYouItems = useMemo(() => needsYou(approvalsData, handoffsData, waits), [approvalsData, handoffsData, waits]);
  // A request this person decided HERE stays in its place as its confirmation line until they leave the screen: the next read stops listing it, and without this the row (the confirmation, and the
  // focus on it) lived one round trip. The count and the empty state still go by what is pending. Requests that left without this person's click are not kept.
  const [decidedHere, setDecidedHere] = useState<Array<{ item: NeedsYouItem; at: number }>>([]);
  const shownItems = useMemo(() => {
    const out = needsYouItems.slice();
    for (const d of [...decidedHere].sort((a, b) => a.at - b.at)) if (!out.some((i) => i.id === d.item.id)) out.splice(Math.min(d.at, out.length), 0, d.item);
    return out;
  }, [needsYouItems, decidedHere]);
  const inProgressList = useMemo(() => inProgress(inProgressData), [inProgressData]);
  const completedList = useMemo(() => completed(completedData), [completedData]);
  const upcomingRoutines = useMemo(() => nextRoutines(routinesData), [routinesData]);

  // Subheader financial summary (honest: only rendered when real cost data is available)
  const todaySpendCents = costsData?.totals?.spend_cents;
  const globalDayLimit = budgetData?.limits?.find(
    (l) => l.scope === "global" && l.period === "day"
  );

  const freeBots = bots.filter((b) => b.approval_mode === "free");
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
  // until a read answered: "loading", or that the read failed (never an empty list that nobody has seen)
  const pending = (testid: string, bad?: boolean) => (
    <div data-testid={testid} role="status" aria-busy={!bad} className="lb-group" style={{ padding: "12px 16px", display: "grid", gap: 10 }}>
      {!bad && [0, 1].map((i) => <span key={i} aria-hidden="true" style={{ height: 14, width: i ? "55%" : "80%", borderRadius: 7, background: "var(--lb-fill)" }} />)}
      <span className="lb-subhead">{bad ? t("hojeReadFailed") : t("agentLoading")}</span>
    </div>
  );
  const needsReady = answered.approvals && answered.handoffs, count = (ready: boolean, n: number) => (ready ? n : "…");
  const face = (name: string) => {
    const w = who(name);
    return <Avatar name={w.label} avatar={w.avatar} color={w.color} size={36} />;
  };

  return (
    <div className="lb-appear" style={{ display: "flex", flexDirection: "column", gap: 32, padding: "28px 24px 40px", width: "100%", maxWidth: 1180, margin: "0 auto", boxSizing: "border-box", fontFamily: "var(--lb-font)" }}>
      {actionError && <div role="alert" className="lb-group lb-subhead" style={{ padding: "12px 16px", color: "var(--color-destructive)" }}><ErrorNote error={actionError} /></div>}

      <InactivityBanner />

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
          {botsStatus === "ready" && freeBots.length > 0 && (
            <span data-testid="hoje-free-pill" className="lb-pill" title={t("freeChipTitle")}
              style={{ background: "color-mix(in srgb, var(--color-warning) 22%, transparent)", color: "var(--color-foreground)" }}>
              {t("hojeFreePill", { bots: freeBots.map((b) => b.display?.label || b.name).join(", ") })}
            </span>
          )}
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
          {sectionHead(t("needsYouTitle"), count(needsReady, needsYouItems.length), "needs-you-count")}
          {!needsReady ? pending("needs-you-loading", failed.approvals || failed.handoffs) : shownItems.length === 0
            ? empty("needs-you-empty", <CheckCircleIcon size={20} />, t("needsYouEmpty"), t("needsYouEmptyNextStep"))
            : (
              <div className="lb-group">
                {shownItems.map((item, at) => (
                  <div key={item.id} data-testid={`needs-you-item-${item.id}`} className="lb-row" style={{ alignItems: "flex-start" }}>
                    {face(item.bot)}
                    <div className="lb-row-stack">
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span className="lb-headline lb-truncate">{who(item.bot).label}</span>
                        <span className="lb-caption">{item.kind === "approval" ? t("needsYouKindApproval") : item.kind === "waiting" ? t("needsYouKindWaiting") : t("needsYouKindHandoff")}</span>
                      </div>
                      {item.kind === "waiting" && item.rawWaiting ? (() => {
                        const v = waitView(item.rawWaiting, t);
                        return (
                          <>
                            <div className="lb-body lb-clamp-2" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v.title}</div>
                            <div className="lb-subhead">{v.where} <span className="lb-caption">{sinceText(item.rawWaiting.since, locale, t)}</span></div>
                            {v.inLuveBot && onSelectBot && (
                              <div style={{ marginTop: 6 }}>
                                <button type="button" className="lb-btn" onClick={() => onSelectBot(item.bot, item.rawWaiting?.session_id)}><span>{t("waitOpenChat")}</span><ArrowRightIcon size={14} /></button>
                              </div>
                            )}
                          </>
                        );
                      })()
                      : item.kind === "approval" && item.rawApproval
                        ? <div className="lb-body lb-clamp-2">{approvalTitle(item.rawApproval, ruleLabel, t)}</div>
                        : <div className="lb-body lb-clamp-2"><Markdown text={item.title} /></div>}
                      {item.detail && <div className="lb-subhead lb-mono" style={{ overflowWrap: "anywhere" }}>{item.kind === "approval" ? <span style={{ whiteSpace: "pre-wrap" }}>{visibleTokens(item.detail)}</span> : <Markdown text={item.detail} />}</div>}
                      {item.kind !== "waiting" && <div style={{ marginTop: 6 }}>
                        {item.kind === "approval" && item.rawApproval ? (
                          <ApprovalDecision bare bot={item.bot} pending={item.rawApproval.status === "pending"} onDecided={() => { setDecidedHere((all) => (all.some((d) => d.item.id === item.id) ? all : [...all, { item, at }])); loadAll(true); onChanged?.(); }}
                            request={{ requestId: item.rawApproval.request_id, digest: item.rawApproval.digest || null, choices: item.rawApproval.allowed_choices,
                              command: item.rawApproval.command_redacted, description: item.rawApproval.description, patternKey: item.rawApproval.pattern_keys?.[0],
                              detailsUnavailable: item.rawApproval.details_unavailable === true,
                              pageReview: item.rawApproval.review ? { page: item.rawApproval.page, proposal: item.rawApproval.proposal, review: item.rawApproval.review, diff: item.rawApproval.diff } : undefined }}
                            resolve={(body) => resolveApproval(item.rawApproval!.request_id, body)} />
                        ) : (
                          <button type="button" className="lb-btn" onClick={() => onNavigateTab?.("atividade")}>
                            <span>{t("reviewHandoffBtn")}</span><ArrowRightIcon size={14} />
                          </button>
                        )}
                      </div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          {(feed?.partial.length ?? 0) > 0 && initialWaiting === undefined && <p data-testid="waiting-partial" className="lb-caption" style={{ margin: "8px 4px 0" }}>{t("waitPartial")}</p>}
        </section>

        <section aria-label={t("inProgressTitle")}>
          {sectionHead(t("inProgressTitle"), count(answered.running, inProgressList.length), "in-progress-count")}
          {!answered.running ? pending("in-progress-loading", failed.running) : inProgressList.length === 0
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
          {sectionHead(t("completedTodayTitle"), count(answered.done, completedList.length), "completed-today-count")}
          {!answered.done ? pending("completed-loading", failed.done) : completedList.length === 0
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
        {sectionHead(t("nextRoutinesTitle"), !answered.routines ? "…" : upcomingRoutines.length === 0 ? t("zeroScheduled") : t("scheduledCount", { count: upcomingRoutines.length }), "routines-count")}
        {!answered.routines ? pending("routines-loading", failed.routines) : upcomingRoutines.length === 0
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

      {/* What Hermes proposes (contract v0.10 §2): only when there is something to decide */}
      <RoutineSuggestions bots={bots} variant="today" />
    </div>
  );
}
