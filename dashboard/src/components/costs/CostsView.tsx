// dashboard/src/components/costs/CostsView.tsx
// Costs and Budget management view (spec §4.13, contract v0.2 §4).
// Invariant 7: Honest UI - only display spend and ceilings from backend (never estimated or hardcoded).
// Loopback enforcement (D-014 / A-29): lowering ceilings allowed; raising/removing ceilings and resuming bots are blocked (loopback_not_human).
// Resuming a paused bot requires explicit human click and confirmation.
// Values in integer cents formatted according to locale.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type {
  Bot,
  CostsResponse,
  BudgetSnapshot,
  CostPeriod,
  CostGroupKey,
  BudgetLimit,
  PausedBot,
  BudgetScope,
  BudgetPeriod,
} from "../../api/types";
import {
  getCosts,
  getBudget,
  setBudgetLimit,
  resumeBotBudget,
  getSession,
  ApiError,
} from "../../api/client";
import {
  DollarSignIcon,
  ShieldAlertIcon,
  CheckCircleIcon,
  XIcon,
  RefreshCwIcon,
  PlusIcon,
  PlayIcon,
  CheckIcon,
  FilterIcon,
} from "../Icons";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface CostsViewProps {
  bots?: Bot[];
  authMode?: "loopback" | "gated";
  initialCosts?: CostsResponse;
  initialBudget?: BudgetSnapshot;
  onRefresh?: () => void;
}

export function formatCents(cents: number, locale: string): string {
  const dollars = cents / 100;
  return dollars.toLocaleString(locale === "pt" ? "pt-BR" : "en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function CostsView({
  bots = [],
  authMode: controlledAuthMode,
  initialCosts,
  initialBudget,
  onRefresh,
}: CostsViewProps) {
  const { locale, t } = useLuveI18n();

  const [authMode, setAuthMode] = useState<"loopback" | "gated">(
    controlledAuthMode || "gated"
  );
  const [activeTab, setActiveTab] = useState<"overview" | "limits" | "paused">(
    "overview"
  );

  // Filter state for GET /costs
  const [period, setPeriod] = useState<CostPeriod>("day");
  const [group, setGroup] = useState<CostGroupKey>("bot");
  const botLabel = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;
  const [selectedBotFilter, setSelectedBotFilter] = useState<string>("");

  // Data states
  const [costsData, setCostsData] = useState<CostsResponse | null>(
    initialCosts || null
  );
  const [budgetData, setBudgetData] = useState<BudgetSnapshot | null>(
    initialBudget || null
  );
  const [loadingCosts, setLoadingCosts] = useState<boolean>(!initialCosts);
  const [loadingBudget, setLoadingBudget] = useState<boolean>(!initialBudget);
  const [costsError, setCostsError] = useState<ErrorState | null>(null);
  const [budgetError, setBudgetError] = useState<ErrorState | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorState | null>(null);

  // Limit Adjustment Modal state
  const [limitModalOpen, setLimitModalOpen] = useState<boolean>(false);
  const [editingLimit, setEditingLimit] = useState<BudgetLimit | null>(null);
  const [limitScope, setLimitScope] = useState<BudgetScope>("global");
  const [limitPeriod, setLimitPeriod] = useState<BudgetPeriod>("day");
  const [limitRef, setLimitRef] = useState<string>("");
  const [limitDollarsInput, setLimitDollarsInput] = useState<string>("");
  const [isSavingLimit, setIsSavingLimit] = useState<boolean>(false);

  // Resume Bot Modal state
  const [resumeModalOpen, setResumeModalOpen] = useState<boolean>(false);
  const [botToResume, setBotToResume] = useState<string | null>(null);
  const [isResuming, setIsResuming] = useState<boolean>(false);

  const limitModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: limitModalOpen,
    onClose: () => setLimitModalOpen(false),
  });

  const resumeModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: resumeModalOpen && Boolean(botToResume),
    onClose: () => setResumeModalOpen(false),
  });

  const isLoopback = authMode === "loopback";

  // Check authMode via session if not passed
  useEffect(() => {
    if (!controlledAuthMode) {
      getSession()
        .then((s) => {
          if (s?.auth_mode) setAuthMode(s.auth_mode);
        })
        .catch(() => {});
    }
  }, [controlledAuthMode]);

  // Load costs
  const loadCosts = useCallback(async () => {
    try {
      setLoadingCosts(true);
      setCostsError(null);
      const res = await getCosts({
        period,
        group,
        bot: selectedBotFilter || undefined,
      });
      setCostsData(res);
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorLoadingCosts");
      setCostsError(msg);
    } finally {
      setLoadingCosts(false);
    }
  }, [period, group, selectedBotFilter, t]);

  // Load budget
  const loadBudget = useCallback(async () => {
    try {
      setLoadingBudget(true);
      setBudgetError(null);
      const res = await getBudget();
      setBudgetData(res);
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorLoadingBudget");
      setBudgetError(msg);
    } finally {
      setLoadingBudget(false);
    }
  }, [t]);

  useEffect(() => {
    if (!initialCosts) {
      loadCosts();
    }
  }, [loadCosts, initialCosts]);

  useEffect(() => {
    if (!initialBudget) {
      loadBudget();
    }
  }, [loadBudget, initialBudget]);

  const handleRefreshAll = () => {
    loadCosts();
    loadBudget();
    if (onRefresh) onRefresh();
  };

  // Open modal to create or edit limit
  const openEditLimitModal = (existing?: BudgetLimit) => {
    setActionError(null);
    setActionSuccess(null);
    if (existing) {
      setEditingLimit(existing);
      setLimitScope(existing.scope);
      setLimitPeriod(existing.period);
      setLimitRef(existing.ref || "");
      setLimitDollarsInput((existing.cents / 100).toFixed(2));
    } else {
      setEditingLimit(null);
      setLimitScope("global");
      setLimitPeriod("day");
      setLimitRef("");
      setLimitDollarsInput("10.00");
    }
    setLimitModalOpen(true);
  };

  // Calculate parsed cents from user input
  const parsedCents = useMemo(() => {
    const val = parseFloat(limitDollarsInput.replace(",", "."));
    if (isNaN(val) || val < 0) return null;
    return Math.round(val * 100);
  }, [limitDollarsInput]);

  // Loopback check for saving limit (D-014 / A-29):
  // Lowering is allowed. Raising or setting new limit in loopback is BLOCKED.
  const isRaiseInLoopback = useMemo(() => {
    if (!isLoopback) return false;
    if (!editingLimit) return true; // new limit in loopback is blocked
    if (parsedCents === null) return true;
    return parsedCents >= editingLimit.cents;
  }, [isLoopback, editingLimit, parsedCents]);

  const handleSaveLimit = async () => {
    if (parsedCents === null) return;
    if (isRaiseInLoopback) {
      setActionError(t("errorLoopbackBudgetRaiseBlocked"));
      return;
    }

    try {
      setIsSavingLimit(true);
      setActionError(null);
      await setBudgetLimit({
        scope: limitScope,
        ref: limitScope === "global" ? null : limitRef || null,
        period: limitPeriod,
        cents: parsedCents,
      });
      setLimitModalOpen(false);
      await loadBudget();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorSavingLimit");
      setActionError(msg);
    } finally {
      setIsSavingLimit(false);
    }
  };

  const handleRemoveLimit = async () => {
    if (!editingLimit) return;
    if (isLoopback) {
      setActionError(t("errorLoopbackBudgetRaiseBlocked"));
      return;
    }

    try {
      setIsSavingLimit(true);
      setActionError(null);
      await setBudgetLimit({
        scope: editingLimit.scope,
        ref: editingLimit.ref || null,
        period: editingLimit.period,
        cents: null,
      });
      setLimitModalOpen(false);
      await loadBudget();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorSavingLimit");
      setActionError(msg);
    } finally {
      setIsSavingLimit(false);
    }
  };

  // Open modal to confirm bot resume
  const openResumeModal = (botName: string) => {
    if (isLoopback) {
      setActionError(t("errorLoopbackBudgetResumeBlocked"));
      return;
    }
    setBotToResume(botName);
    setResumeModalOpen(true);
  };

  // Confirm resume bot execution
  const handleConfirmResumeBot = async () => {
    if (!botToResume) return;
    if (isLoopback) {
      setActionError(t("errorLoopbackBudgetResumeBlocked"));
      setResumeModalOpen(false);
      return;
    }

    try {
      setIsResuming(true);
      setActionError(null);
      await resumeBotBudget(botToResume);
      setResumeModalOpen(false);
      setBotToResume(null);
      setActionSuccess(t("botResumedSuccess"));
      await loadBudget();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorResumingBot");
      setActionError(msg);
    } finally {
      setIsResuming(false);
    }
  };

  // Resolve period label for display
  const getPeriodKeyLabel = (p: CostPeriod): string => {
    switch (p) {
      case "day":
        return t("periodDay");
      case "7d":
        return t("period7d");
      case "month":
        return t("periodMonth");
      case "30d":
        return t("period30d");
    }
  };

  const pausedCount = budgetData?.paused?.length || 0;

  return (
    <div
      data-testid="costs-view"
      className="lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-y-auto lb:bg-[var(--background)] lb:text-[var(--color-foreground)]"
    >
      {/* Top Header */}
      <div className="lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3 lb:px-6 lb:pt-6 lb:pb-2">
        <div className="lb:flex lb:items-center lb:gap-3">
          <div className="lb:p-2 lb:rounded-2xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)]">
            <DollarSignIcon size={20} />
          </div>
          <div>
            <h1 className="lb-title">
              {t("costsTitle")}
            </h1>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("costsSubtitle")}
            </p>
          </div>
        </div>

        <div className="lb:flex lb:items-center lb:gap-2">
          <button
            type="button"
            aria-label={t("refreshCostsAriaLabel")}
            onClick={handleRefreshAll}
            className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full"
          >
            <RefreshCwIcon size={13} />
            <span>{t("retry")}</span>
          </button>
        </div>
      </div>

      {/* Loopback Security Banner (D-014 / A-29) */}
      {isLoopback && (
        <div
          role="alert"
          className="lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3.5 lb:rounded-2xl lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-warning)]/10 lb:text-[var(--color-foreground)] lb:flex lb:items-start lb:gap-3"
        >
          <div className="lb:text-[var(--color-warning)] lb:mt-0.5">
            <ShieldAlertIcon size={16} />
          </div>
          <div className="lb:flex-1">
            <div className="lb:flex lb:items-center lb:gap-2">
              <span className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-warning)]">
                {t("loopbackBudgetWarningTitle")}
              </span>
              <span
                data-testid="badge-loopback"
                className="lb:px-1.5 lb:py-0.2 lb:rounded-lg lb:text-xs lb:tabular-nums lb:bg-[var(--color-warning)]/20 lb:text-[var(--color-warning)]"
              >
                {t("loopbackBadge")}
              </span>
            </div>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
              {t("loopbackBudgetWarningDetail")}
            </p>
          </div>
        </div>
      )}

      {/* Global Alerts & Feedback */}
      {actionError && (
        <div
          role="alert"
          className="lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between"
        >
          <span><ErrorNote error={actionError} /></span>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setActionError(null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      {actionSuccess && (
        <div className="lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-success)]/10 lb:border-[var(--color-success)]/30 lb:text-[13px] lb:text-[var(--color-success)] lb:flex lb:items-center lb:justify-between">
          <span>{actionSuccess}</span>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setActionSuccess(null)}
          >
            <XIcon size={14} />
          </button>
        </div>
      )}

      {/* Budget Watcher Alert if Stale */}
      {budgetData?.watcher?.stale && (
        <div
          role="alert"
          className="lb:mx-4 lb:mt-4 lb:md:mx-6 lb:p-3 lb:rounded-xl lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[13px] lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2"
        >
          <ShieldAlertIcon size={14} />
          <span>{t("ledgerStaleWarning")}</span>
        </div>
      )}

      {/* Active Alerts from Budget Snapshot */}
      {budgetData?.alerts && budgetData.alerts.length > 0 && (
        <div className="lb:mx-4 lb:mt-4 lb:md:mx-6 lb:space-y-2">
          {budgetData.alerts.map((alert, idx) => (
            <div
              key={idx}
              role="alert"
              className={`lb:p-2.5 lb:rounded-xl lb:text-[13px] lb:flex lb:items-center lb:gap-2 ${
                alert.percent >= 100
                  ? "lb:bg-[var(--color-destructive)]/15 lb:border-[var(--color-destructive)]/40 lb:text-[var(--color-destructive)]"
                  : "lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[var(--color-warning)]"
              }`}
            >
              <ShieldAlertIcon size={13} />
              <span>
                {alert.percent >= 100
                  ? t("budgetAlertExceeded", {
                      percent: alert.percent,
                      scope: alert.scope === "global" ? t("ruleScopeGlobal") : alert.scope === "bot" ? botLabel(alert.ref || "") : alert.ref || "",
                    })
                  : t("budgetAlertWarning", {
                      percent: alert.percent,
                      scope: alert.scope === "global" ? t("ruleScopeGlobal") : alert.scope === "bot" ? botLabel(alert.ref || "") : alert.ref || "",
                    })}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="lb-segmented lb:mx-4 lb:md:mx-6 lb:mt-4 lb:shrink-0" style={{ maxWidth: 520 }}>
        <button
          type="button"
          onClick={() => setActiveTab("overview")}
          aria-pressed={activeTab === "overview"}
          className="lb-segment"
        >
          {t("tabOverview")}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("limits")}
          aria-pressed={activeTab === "limits"}
          className="lb-segment"
        >
          {t("tabBudgetLimits")}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("paused")}
          aria-pressed={activeTab === "paused"}
          className="lb-segment lb:inline-flex lb:items-center lb:justify-center lb:gap-1.5"
        >
          <span>{t("tabPausedBots")}</span>
          {pausedCount > 0 && (
            <span
              data-testid="paused-count-badge"
              className="lb:px-1.5 lb:py-0.2 lb:rounded-full lb:text-xs lb:font-bold lb:bg-[var(--color-destructive)] lb:text-white"
            >
              {pausedCount}
            </span>
          )}
        </button>
      </div>

      {/* Main Tab Content */}
      <div className="lb:p-4 lb:md:p-6 lb:space-y-6">
        {/* ================================================================= */}
        {/* TAB 1: Overview (Spend analytics)                                 */}
        {/* ================================================================= */}
        {activeTab === "overview" && (
          <div className="lb:space-y-5">
            {/* Filter controls */}
            <div className="lb:flex lb:flex-wrap lb:items-center lb:gap-3 lb:p-3 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]">
              {/* Period selector */}
              <div className="lb:flex lb:items-center lb:gap-1.5">
                <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                  {t("periodLabel")}
                </span>
                <select
                  aria-label={t("filterPeriodAriaLabel")}
                  value={period}
                  onChange={(e) => setPeriod(e.target.value as CostPeriod)}
                  className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]"
                >
                  <option value="day">{t("periodDay")}</option>
                  <option value="7d">{t("period7d")}</option>
                  <option value="month">{t("periodMonth")}</option>
                  <option value="30d">{t("period30d")}</option>
                </select>
              </div>

              {/* Grouping selector */}
              <div className="lb:flex lb:items-center lb:gap-1.5">
                <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                  {t("groupLabel")}
                </span>
                <select
                  aria-label={t("filterGroupAriaLabel")}
                  value={group}
                  onChange={(e) => setGroup(e.target.value as CostGroupKey)}
                  className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]"
                >
                  <option value="bot">{t("groupBot")}</option>
                  <option value="model">{t("groupModel")}</option>
                  <option value="routine">{t("groupRoutine")}</option>
                  <option value="day">{t("groupDay")}</option>
                </select>
              </div>

              {/* Bot filter (optional) */}
              {bots.length > 0 && (
                <div className="lb:flex lb:items-center lb:gap-1.5">
                  <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                    {t("filterBotLabel")}
                  </span>
                  <select
                    aria-label={t("filterBotAriaLabel")}
                    value={selectedBotFilter}
                    onChange={(e) => setSelectedBotFilter(e.target.value)}
                    className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]"
                  >
                    <option value="">{t("allBotsOption")}</option>
                    {bots.map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.display?.label || b.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Loading / Error state */}
            {loadingCosts && !costsData && (
              <div className="lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                {t("loadingBots")}
              </div>
            )}

            {costsError && (
              <div
                role="alert"
                className="lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]"
              >
                <ErrorNote error={costsError} />
              </div>
            )}

            {/* Invariant 7: Honest UI - Totals rendered strictly from backend */}
            {costsData && (
              <>
                <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:lg:grid-cols-3 lb:gap-3">
                  {/* Total Spend Card */}
                  <div
                    data-testid="total-spend-card"
                    className="lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:flex-col lb:justify-between"
                  >
                    <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                      {t("totalSpendLabel", {
                        period: getPeriodKeyLabel(costsData.period),
                      })}
                    </span>
                    <div className="lb:mt-2 lb:flex lb:items-baseline lb:gap-2">
                      <span
                        data-testid="total-spend-amount"
                        className="lb:text-2xl lb:tabular-nums lb:font-bold lb:text-[var(--color-foreground)]"
                      >
                        {formatCents(costsData.totals.spend_cents, locale)}
                      </span>
                    </div>

                    {/* Unpriced sessions notice if present */}
                    {costsData.totals.unpriced_sessions > 0 && (
                      <div className="lb:mt-2 lb:text-xs lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-1">
                        <ShieldAlertIcon size={12} />
                        <span>
                          {t("unpricedSessionsNotice", {
                            count: costsData.totals.unpriced_sessions,
                          })}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Ledger Lag Status Card */}
                  <div
                    data-testid="ledger-status-card"
                    className="lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:flex-col lb:justify-between"
                  >
                    <div className="lb:flex lb:items-center lb:justify-between">
                      <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                        {t("ledgerLagLabel")}
                      </span>
                      <span
                        data-testid="badge-ledger"
                        className="lb:px-1.5 lb:py-0.2 lb:rounded-lg lb:text-xs lb:tabular-nums lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
                      >
                        {t("ledgerBadge")}
                      </span>
                    </div>
                    <div className="lb:mt-2">
                      <span
                        data-testid="ledger-lag-seconds"
                        className="lb:text-xl lb:tabular-nums lb:font-semibold lb:text-[var(--color-foreground)]"
                      >
                        {t("ledgerLagSeconds", {
                          seconds: costsData.ledger.lag_s,
                        })}
                      </span>
                    </div>
                    {costsData.ledger.watcher_stale ? (
                      <div className="lb:mt-2 lb:text-xs lb:text-[var(--color-destructive)]">
                        {t("ledgerStaleWarning")}
                      </div>
                    ) : (
                      <div className="lb:mt-2 lb:text-xs lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-1">
                        <CheckIcon size={12} />
                        <span>{t("activeBotsCount")}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Groups Breakdown Table */}
                <div className="lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:overflow-hidden">
                  <div className="lb:overflow-x-auto">
                    <table className="lb:w-full lb:text-left lb:border-collapse">
                      <thead>
                        <tr className="lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-muted)]/40 lb:text-xs lb:font-semibold lb:text-[var(--color-muted-foreground)]">
                          <th className="lb:py-2.5 lb:px-4">
                            {t("tableHeaderKey")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4 lb:text-right">
                            {t("tableHeaderSpend")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4 lb:text-right">
                            {t("tableHeaderTokens")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4 lb:text-right">
                            {t("tableHeaderSessions")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="lb:divide-y lb:divide-[var(--lb-separator)] lb:text-[13px]">
                        {costsData.groups.length === 0 ? (
                          <tr>
                            <td
                              colSpan={4}
                              data-testid="costs-empty-state"
                              className="lb:py-12 lb:px-4 lb:text-center"
                            >
                              <div className="lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2">
                                <span className="lb:text-[15px] lb:font-medium lb:text-[var(--color-foreground)]">
                                  {t("noCostsData")}
                                </span>
                                <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-md">
                                  {t("costsEmptyNextStep")}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setActiveTab("limits")}
                                  className="lb:mt-2 lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:bg-[var(--lb-fill)] lb:text-[var(--color-secondary-foreground)] lb:text-[13px] lb:font-medium lb:hover:bg-[var(--lb-fill-2)] lb:border-[var(--lb-separator)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
                                >
                                  {t("btnSetLimit")}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          costsData.groups.map((item, idx) => (
                            <tr
                              key={idx}
                              data-testid={`cost-group-row-${item.key}`}
                              className="lb:hover:bg-[var(--color-muted)]/20 lb:motion-safe:transition-colors"
                            >
                              <td className="lb:py-2.5 lb:px-4 lb:font-medium">
                                {group === "bot" ? botLabel(item.key) : item.key}
                              </td>
                              <td
                                data-testid={`cost-group-spend-${item.key}`}
                                className="lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums lb:font-semibold"
                              >
                                {formatCents(item.spend_cents, locale)}
                              </td>
                              <td className="lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums lb:text-[var(--color-muted-foreground)]">
                                {item.tokens !== undefined
                                  ? item.tokens.toLocaleString()
                                  : "-"}
                              </td>
                              <td className="lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums lb:text-[var(--color-muted-foreground)]">
                                {item.sessions !== undefined
                                  ? item.sessions
                                  : "-"}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 2: Budget Ceilings & Limits                                   */}
        {/* ================================================================= */}
        {activeTab === "limits" && (
          <div className="lb:space-y-4">
            <div className="lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3">
              <div>
                <h2 className="lb-title">
                  {t("limitsTitle")}
                </h2>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                  {t("limitsSubtitle")}
                </p>
              </div>

              {/* Set Limit Button */}
              <button
                type="button"
                data-testid="btn-new-limit"
                onClick={() => openEditLimitModal()}
                disabled={isLoopback}
                title={
                  isLoopback
                    ? t("errorLoopbackBudgetRaiseBlocked")
                    : t("btnSetLimit")
                }
                className={`lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                  isLoopback
                    ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                    : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"
                }`}
              >
                <PlusIcon size={13} />
                <span>{t("btnSetLimit")}</span>
              </button>
            </div>

            {loadingBudget && !budgetData && (
              <div className="lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                {t("loadingBots")}
              </div>
            )}

            {budgetError && (
              <div
                role="alert"
                className="lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]"
              >
                <ErrorNote error={budgetError} />
              </div>
            )}

            {/* Invariant 7: Honest UI - Active ceilings list strictly from backend */}
            {budgetData && (
              <div className="lb:space-y-3">
                {budgetData.limits.length === 0 ? (
                  <div className="lb:p-8 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                    {t("noLimitsConfigured")}
                  </div>
                ) : (
                  budgetData.limits.map((limit, idx) => {
                    const isZeroCap = limit.cents === 0;
                    const percent = Math.min(100, Math.max(0, limit.percent));
                    const isBreached = limit.percent >= 100;
                    const isHigh = limit.percent >= 80;

                    return (
                      <div
                        key={idx}
                        data-testid={`budget-limit-card-${limit.scope}-${limit.ref || "all"}-${limit.period}`}
                        className="lb:p-4 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-3"
                      >
                        <div className="lb:flex lb:items-center lb:justify-between lb:gap-2">
                          <div className="lb:flex lb:items-center lb:gap-2">
                            <span className="lb:font-semibold lb:text-[13px]">
                              {limit.scope === "global"
                                ? t("scopeGlobalLabel")
                                : limit.scope === "bot"
                                ? t("scopeBotLabel", {
                                    name: botLabel(limit.ref || ""),
                                  })
                                : t("scopeRoutineLabel", {
                                    name: limit.ref || "",
                                  })}
                            </span>

                            <span className="lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]">
                              {limit.period === "day"
                                ? t("limitPeriodDay")
                                : t("limitPeriodMonth")}
                            </span>

                            <span
                              data-testid="badge-ledger"
                              className="lb:px-1.5 lb:py-0.2 lb:rounded-lg lb:text-xs lb:tabular-nums lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
                            >
                              {t("ledgerBadge")}
                            </span>
                          </div>

                          <div className="lb:flex lb:items-center lb:gap-2">
                            <button
                              type="button"
                              data-testid={`btn-edit-limit-${limit.scope}-${limit.ref || "all"}`}
                              onClick={() => openEditLimitModal(limit)}
                              className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full"
                            >
                              {t("btnEditLimit")}
                            </button>
                          </div>
                        </div>

                        {/* Progress Bar & Values */}
                        {isZeroCap ? (
                          <div className="lb:p-2 lb:rounded-lg lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]">
                            {t("limitZeroBlocked")}
                          </div>
                        ) : (
                          <div className="lb:space-y-1.5">
                            <div className="lb:flex lb:items-center lb:justify-between lb:text-[13px] lb:tabular-nums">
                              <span data-testid="limit-spent-of">
                                {t("limitSpentOf", {
                                  spent: formatCents(
                                    limit.spent_cents,
                                    locale
                                  ),
                                  limit: formatCents(limit.cents, locale),
                                  percent: limit.percent,
                                })}
                              </span>
                              {limit.reserved_cents ? (
                                <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                                  {t("limitReserved", {
                                    reserved: formatCents(
                                      limit.reserved_cents,
                                      locale
                                    ),
                                  })}
                                </span>
                              ) : null}
                            </div>

                            {/* Progress bar line */}
                            <div className="lb:w-full lb:h-2 lb:rounded-full lb:bg-[var(--lb-fill)] lb:overflow-hidden">
                              <div
                                style={{ width: `${percent}%` }}
                                className={`lb:h-full lb:motion-safe:transition-all ${
                                  isBreached
                                    ? "lb:bg-[var(--color-destructive)]"
                                    : isHigh
                                    ? "lb:bg-[var(--color-warning)]"
                                    : "lb:bg-[var(--color-foreground)]"
                                }`}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 3: Paused Bots                                                */}
        {/* ================================================================= */}
        {activeTab === "paused" && (
          <div className="lb:space-y-4">
            <div>
              <h2 className="lb-title">
                {t("pausedBotsTitle")}
              </h2>
              <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                {t("limitsSubtitle")}
              </p>
            </div>

            {loadingBudget && !budgetData && (
              <div className="lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                {t("loadingBots")}
              </div>
            )}

            {/* Invariant 7: Honest UI - Paused bots strictly from backend */}
            {budgetData && (
              <div className="lb:space-y-3">
                {budgetData.paused.length === 0 ? (
                  <div className="lb:p-8 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                    {t("pausedBotsEmpty")}
                  </div>
                ) : (
                  budgetData.paused.map((paused) => (
                    <div
                      key={paused.bot}
                      data-testid={`paused-bot-${paused.bot}`}
                      className="lb:p-4 lb:rounded-2xl lb:border-[var(--color-destructive)]/40 lb:bg-[var(--color-destructive)]/5 lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3"
                    >
                      <div className="lb:space-y-1">
                        <div className="lb:flex lb:items-center lb:gap-2">
                          <span className="lb-headline">
                            {botLabel(paused.bot)}
                          </span>
                          <span
                            data-testid="badge-paused"
                            className="lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/20 lb:text-[var(--color-destructive)]"
                          >
                            {t("statusPausedLabel")}
                          </span>
                        </div>
                        <p className="lb:text-[13px] lb:text-[var(--color-destructive)]">
                          {t("pausedBotReason", {
                            reason: paused.plan_status || t("pausedReasonCapReached"),
                          })}
                        </p>
                        <p className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                          {t("pausedSince", {
                            time: new Date(paused.since).toLocaleString(
                              locale === "pt" ? "pt-BR" : "en-US"
                            ),
                          })}
                        </p>
                      </div>

                      {/* Resume Bot Button: Human-only confirmation required */}
                      <button
                        type="button"
                        data-testid={`btn-resume-bot-${paused.bot}`}
                        disabled={isLoopback}
                        onClick={() => openResumeModal(paused.bot)}
                        title={
                          isLoopback
                            ? t("errorLoopbackBudgetResumeBlocked")
                            : t("btnResumeBot")
                        }
                        className={`lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                          isLoopback
                            ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                            : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"
                        }`}
                      >
                        <PlayIcon size={12} />
                        <span>{t("btnResumeBot")}</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* =================================================================== */}
      {/* Modal: Adjust or Create Budget Limit                                */}
      {/* =================================================================== */}
      {limitModalOpen && (
        <div
          ref={limitModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-limit-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-limit-config"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-limit-title" className="lb-title">
                {t("modalLimitTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setLimitModalOpen(false)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            {/* Scope selection */}
            <div className="lb:space-y-1">
              <label className="lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]">
                {t("limitScopeInput")}
              </label>
              <select
                disabled={Boolean(editingLimit)}
                value={limitScope}
                onChange={(e) =>
                  setLimitScope(e.target.value as BudgetScope)
                }
                className="lb-input"
              >
                <option value="global">{t("scopeGlobalLabel")}</option>
                <option value="bot">{t("groupBot")}</option>
                <option value="routine">{t("groupRoutine")}</option>
              </select>
            </div>

            {/* Target identifier if bot or routine */}
            {limitScope !== "global" && (
              <div className="lb:space-y-1">
                <label className="lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]">
                  {t("limitTargetInput")}
                </label>
                <input
                  type="text"
                  disabled={Boolean(editingLimit)}
                  value={limitRef}
                  onChange={(e) => setLimitRef(e.target.value)}
                  placeholder={t("limitTargetPlaceholder")}
                  className="lb-input"
                />
              </div>
            )}

            {/* Period selection */}
            <div className="lb:space-y-1">
              <label className="lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]">
                {t("limitPeriodInput")}
              </label>
              <select
                disabled={Boolean(editingLimit)}
                value={limitPeriod}
                onChange={(e) =>
                  setLimitPeriod(e.target.value as BudgetPeriod)
                }
                className="lb-input"
              >
                <option value="day">{t("limitPeriodDay")}</option>
                <option value="month">{t("limitPeriodMonth")}</option>
              </select>
            </div>

            {/* Amount input */}
            <div className="lb:space-y-1">
              <div className="lb:flex lb:items-center lb:justify-between">
                <label className="lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]">
                  {t("limitAmountLabel")}
                </label>
                {editingLimit && (
                  <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                    {t("limitCurrentValue", {
                      amount: formatCents(editingLimit.cents, locale),
                    })}
                  </span>
                )}
              </div>
              <input
                type="text"
                data-testid="input-limit-amount"
                aria-label={t("limitAmountInputAriaLabel")}
                placeholder={t("limitAmountPlaceholder")}
                value={limitDollarsInput}
                onChange={(e) => setLimitDollarsInput(e.target.value)}
                className="lb-input lb-mono"
              />
              <p className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                {t("limitAmountCentsHint")}
              </p>
            </div>

            {/* Loopback block notice if trying to raise or add new limit */}
            {isRaiseInLoopback && (
              <div
                role="alert"
                className="lb:p-2.5 lb:rounded-lg lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/30 lb:text-[13px] lb:text-[var(--color-warning)]"
              >
                {t("errorLoopbackBudgetRaiseBlocked")}
              </div>
            )}

            {/* Modal Actions */}
            <div className="lb:flex lb:items-center lb:justify-between lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              {editingLimit ? (
                <button
                  type="button"
                  data-testid="btn-remove-limit"
                  disabled={isLoopback || isSavingLimit}
                  onClick={handleRemoveLimit}
                  className={`lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                    isLoopback
                      ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                      : "lb:bg-[var(--color-destructive)]/10 lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/20"
                  }`}
                >
                  {t("btnRemoveLimit")}
                </button>
              ) : (
                <div />
              )}

              <div className="lb:flex lb:items-center lb:gap-2">
                <button
                  type="button"
                  onClick={() => setLimitModalOpen(false)}
                  className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full"
                >
                  {t("cancelBtn")}
                </button>
                <button
                  type="button"
                  data-testid="btn-save-limit"
                  disabled={isRaiseInLoopback || isSavingLimit || parsedCents === null}
                  onClick={handleSaveLimit}
                  className={`lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                    isRaiseInLoopback || parsedCents === null
                      ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                      : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"
                  }`}
                >
                  {isSavingLimit ? t("loadingBots") : t("btnSaveLimit")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* Modal: Confirm Bot Resume (Human Click Requirement)                 */}
      {/* =================================================================== */}
      {resumeModalOpen && botToResume && (
        <div
          ref={resumeModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-resume-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-resume-confirmation"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-resume-title" className="lb-title">
                {t("resumeBotConfirmationTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setResumeModalOpen(false)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("resumeBotConfirmationBody", { bot: botToResume })}
            </p>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              <button
                type="button"
                onClick={() => setResumeModalOpen(false)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-resume"
                disabled={isResuming || isLoopback}
                onClick={handleConfirmResumeBot}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {isResuming ? t("resumingBot") : t("btnConfirmResume")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
