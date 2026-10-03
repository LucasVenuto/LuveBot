// dashboard/src/components/activity/ActivityView.tsx
// Activity View (spec §4.7, contract v0.2 §2): List and Kanban views for runs, routines, and tasks.
// Data ONLY from backend. Kanban reflects the 8 Hermes Kanban columns.
// Parar and Redirecionar with CSRF via client and human confirmation.
// Parar continues visible until terminal status is confirmed (same rule as Conversation).
// Content from tasks and sessions is data: rendered safely via Markdown / text, never raw HTML.
// All visible text uses the i18n dictionary.

import { activityTitle } from "../labels";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import type {
  Bot,
  ActivityItem,
  ActivityTab,
  ActivityOrigin,
  ActivityStatus,
  ActivityFilterParams,
  HermesKanbanColumn,
} from "../../api/types";
import { HERMES_KANBAN_COLUMNS } from "../../api/types";
import {
  getActivity,
  addActivityContext,
  redirectActivity,
  stopActivity,
} from "../../api/client";
import { formatCents } from "../costs";
import { Markdown } from "../../lib/render/markdown";
import {
  ClockIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
  ShieldAlertIcon,
  CheckCircleIcon,
  FilterIcon,
} from "../Icons";
import { Avatar } from "../ui/Avatar";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface ActivityViewProps {
  bots?: Bot[];
  initialItems?: ActivityItem[];
  onRefresh?: () => void;
  onOpenConversation?: (bot: string) => void;
  initialView?: "list" | "kanban";  // a handoff's "Ver tarefa no Kanban" opens the board
}

export function mapActivityItemToKanbanColumn(item: ActivityItem): HermesKanbanColumn {
  if (item.column && (HERMES_KANBAN_COLUMNS as readonly string[]).includes(item.column)) {
    return item.column as HermesKanbanColumn;
  }
  switch (item.status) {
    case "running":
      return "running";
    case "waiting_approval":
      return "review";
    case "scheduled":
      return item.kind === "routine_due" ? "scheduled" : "ready";
    case "done":
      return "done";
    case "stopped":
      return "done";
    case "error":
    case "blocked":
      return "blocked";
    default:
      return "todo";
  }
}

export function ActivityView({
  bots = [],
  initialItems,
  onRefresh,
  onOpenConversation,
  initialView = "list",
}: ActivityViewProps) {
  const { locale, t } = useLuveI18n();
  const botInfo = (name: string) => bots.find((b) => b.name === name);
  const botLabel = (name: string) => botInfo(name)?.display?.label || name;

  // Navigation & View Mode
  const [tab, setTab] = useState<ActivityTab>("running");
  const [viewMode, setViewMode] = useState<"list" | "kanban">(initialView);

  // Filters (preserved across list/kanban toggle)
  const [selectedBot, setSelectedBot] = useState<string>("all");
  const [selectedOrigin, setSelectedOrigin] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [minCost, setMinCost] = useState<string>("");

  // Data state
  const [items, setItems] = useState<ActivityItem[]>(initialItems || []);
  const [loading, setLoading] = useState<boolean>(!initialItems);
  const [error, setError] = useState<ErrorState | null>(null);
  const [partialSources, setPartialSources] = useState<string[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  // In-flight stop tracking (button remains visible until terminal status is confirmed)
  const [stoppingIds, setStoppingIds] = useState<Record<string, boolean>>({});

  // Modals state
  const [stopModalItem, setStopModalItem] = useState<ActivityItem | null>(null);
  const [stopReason, setStopReason] = useState<string>("");
  const [submittingStop, setSubmittingStop] = useState<boolean>(false);

  const [redirectModalItem, setRedirectModalItem] = useState<ActivityItem | null>(null);
  const [redirectBot, setRedirectBot] = useState<string>(bots[0]?.name || "");
  const [redirectReason, setRedirectReason] = useState<string>("");
  const [submittingRedirect, setSubmittingRedirect] = useState<boolean>(false);

  const [contextModalItem, setContextModalItem] = useState<ActivityItem | null>(null);
  const [contextKind, setContextKind] = useState<"context" | "correction">("context");
  const [contextText, setContextText] = useState<string>("");
  const [submittingContext, setSubmittingContext] = useState<boolean>(false);

  const stopModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: !!stopModalItem,
    onClose: () => setStopModalItem(null),
  });

  const redirectModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: !!redirectModalItem,
    onClose: () => setRedirectModalItem(null),
  });

  const contextModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: !!contextModalItem,
    onClose: () => setContextModalItem(null),
  });

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  }, []);

  const loadActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: ActivityFilterParams = {
        tab,
        bot: selectedBot !== "all" ? selectedBot : undefined,
        origin: selectedOrigin !== "all" ? (selectedOrigin as ActivityOrigin) : undefined,
        status: selectedStatus !== "all" ? (selectedStatus as ActivityStatus) : undefined,
        min_cost_cents: minCost ? parseInt(minCost, 10) : undefined,
      };
      const res = await getActivity(params);
      setItems(res.items || []);
      setNextCursor(res.next_cursor || null);
      setPartialSources(res.partial && res.partial.length > 0 ? res.partial : null);
    } catch (err: unknown) {
      setError(humanError(err, t, "errorLoadingActivity"));
    } finally {
      setLoading(false);
    }
  }, [tab, selectedBot, selectedOrigin, selectedStatus, minCost, t]);

  useEffect(() => {
    if (initialItems) {
      setItems(initialItems);
    } else {
      void loadActivity();
    }
  }, [loadActivity, initialItems]);

  const handleRefresh = useCallback(() => {
    void loadActivity();
    if (onRefresh) onRefresh();
  }, [loadActivity, onRefresh]);

  // Client-side filtering for fast instant search
  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (selectedBot !== "all" && item.bot !== selectedBot) return false;
      if (selectedOrigin !== "all" && item.origin !== selectedOrigin) return false;
      if (selectedStatus !== "all" && item.status !== selectedStatus) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = activityTitle(item, t).toLowerCase().includes(q);
        const matchId = item.id.toLowerCase().includes(q);
        const matchBot = item.bot.toLowerCase().includes(q);
        if (!matchTitle && !matchId && !matchBot) return false;
      }
      return true;
    });
  }, [items, selectedBot, selectedOrigin, selectedStatus, searchQuery]);

  // Actions
  const handleConfirmStop = async () => {
    if (!stopModalItem) return;
    setSubmittingStop(true);
    try {
      await stopActivity(stopModalItem.id, {
        reason: stopReason.trim() || undefined,
      });
      // Mark as stopping. The button CONTINUES VISIBLE until terminal status is confirmed!
      setStoppingIds((prev) => ({ ...prev, [stopModalItem.id]: true }));
      showToast(t("activityStopSuccess"));
      setStopModalItem(null);
      setStopReason("");
    } catch (err: unknown) {
      showToast(humanError(err, t, "errorStoppingActivity").text);
    } finally {
      setSubmittingStop(false);
    }
  };

  const handleConfirmRedirect = async () => {
    if (!redirectModalItem || !redirectBot) return;
    setSubmittingRedirect(true);
    try {
      await redirectActivity(redirectModalItem.id, {
        bot: redirectBot,
        reason: redirectReason.trim() || undefined,
      });
      showToast(t("activityRedirectSuccess"));
      setRedirectModalItem(null);
      setRedirectReason("");
      void loadActivity();
    } catch (err: unknown) {
      showToast(humanError(err, t, "errorRedirectingActivity").text);
    } finally {
      setSubmittingRedirect(false);
    }
  };

  const handleConfirmContext = async () => {
    if (!contextModalItem || !contextText.trim()) return;
    setSubmittingContext(true);
    try {
      await addActivityContext(contextModalItem.id, {
        text: contextText.trim(),
        kind: contextKind,
      });
      showToast(t("activityContextSuccess"));
      setContextModalItem(null);
      setContextText("");
      void loadActivity();
    } catch (err: unknown) {
      showToast(humanError(err, t, "errorAddingContext").text);
    } finally {
      setSubmittingContext(false);
    }
  };

  const getOriginLabel = (origin: ActivityOrigin): string => {
    switch (origin) {
      case "message":
        return t("filterOriginMessage");
      case "routine":
        return t("filterOriginRoutine");
      case "webhook":
        return t("filterOriginWebhook");
      case "handoff":
        return t("filterOriginHandoff");
      default:
        return origin;
    }
  };

  const getStatusLabel = (status: ActivityStatus): string => {
    switch (status) {
      case "running":
        return t("filterStatusRunning");
      case "waiting_approval":
        return t("filterStatusWaitingApproval");
      case "scheduled":
        return t("filterStatusScheduled");
      case "done":
        return t("filterStatusDone");
      case "error":
        return t("filterStatusError");
      case "stopped":
        return t("filterStatusStopped");
      case "blocked":
        return t("filterStatusBlocked");
      default:
        return status;
    }
  };

  const getKanbanColumnTitle = (col: HermesKanbanColumn): string => {
    switch (col) {
      case "triage":
        return t("kanbanColTriage");
      case "todo":
        return t("kanbanColTodo");
      case "scheduled":
        return t("kanbanColScheduled");
      case "ready":
        return t("kanbanColReady");
      case "running":
        return t("kanbanColRunning");
      case "blocked":
        return t("kanbanColBlocked");
      case "review":
        return t("kanbanColReview");
      case "done":
        return t("kanbanColDone");
    }
  };

  // Group items by Hermes Kanban Column
  const kanbanColumnsData = useMemo(() => {
    const cols: Record<HermesKanbanColumn, ActivityItem[]> = {
      triage: [],
      todo: [],
      scheduled: [],
      ready: [],
      running: [],
      blocked: [],
      review: [],
      done: [],
    };
    for (const item of filteredItems) {
      const col = mapActivityItemToKanbanColumn(item);
      cols[col].push(item);
    }
    return cols;
  }, [filteredItems]);

  return (
    <div className="lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-hidden lb:bg-[var(--background)] lb:text-[var(--color-foreground)]">
      {/* Top Header & View Controls */}
      <div className="lb:border-b lb:border-[var(--lb-separator)] lb:p-3 lb:md:p-4 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:shrink-0">
        <div className="lb:flex lb:items-center lb:gap-3">
          <ClockIcon size={18} className="lb:text-[var(--color-primary)]" />
          <h1 className="lb-large-title">
            {t("activityHeaderTitle")}
          </h1>
          {/* Query Tab Selector (running, scheduled, done) */}
          <div className="lb:flex lb:items-center lb:gap-1 lb:bg-[var(--color-muted)]/50 lb:p-0.5 lb:rounded-xl lb:border-[var(--lb-separator)]">
            <button
              type="button"
              data-testid="tab-running"
              onClick={() => setTab("running")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                tab === "running"
                  ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("tabRunning")}
            </button>
            <button
              type="button"
              data-testid="tab-scheduled"
              onClick={() => setTab("scheduled")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                tab === "scheduled"
                  ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("tabScheduled")}
            </button>
            <button
              type="button"
              data-testid="tab-done"
              onClick={() => setTab("done")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                tab === "done"
                  ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("tabDone")}
            </button>
          </div>
        </div>

        {/* View Mode Toggle & Refresh */}
        <div className="lb:flex lb:items-center lb:gap-2">
          <div className="lb:flex lb:items-center lb:bg-[var(--color-muted)]/50 lb:p-0.5 lb:rounded-xl lb:border-[var(--lb-separator)]">
            <button
              type="button"
              data-testid="toggle-view-list"
              onClick={() => setViewMode("list")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                viewMode === "list"
                  ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("viewList")}
            </button>
            <button
              type="button"
              data-testid="toggle-view-kanban"
              onClick={() => setViewMode("kanban")}
              className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                viewMode === "kanban"
                  ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)]"
                  : "lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)]"
              }`}
            >
              {t("viewKanban")}
            </button>
          </div>

          <button
            type="button"
            data-testid="btn-refresh-activity"
            onClick={handleRefresh}
            aria-label={t("activityRefreshBtn")}
            className="lb:flex lb:items-center lb:gap-1.5 lb:px-2.5 lb:py-1 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:hover:bg-[var(--color-muted)]/50 lb:motion-safe:transition-colors lb:rounded-full"
          >
            <RefreshCwIcon size={13} />
            <span>{t("activityRefreshBtn")}</span>
          </button>
        </div>
      </div>

      {/* Filter Toolbar (preserves state when toggling list/kanban) */}
      <div className="lb:border-b lb:border-[var(--lb-separator)] lb:px-3 lb:py-2 lb:md:px-4 lb:flex lb:flex-wrap lb:items-center lb:gap-2 lb:bg-[var(--color-muted)]/20 lb:text-[13px] lb:shrink-0">
        <FilterIcon size={13} className="lb:text-[var(--color-muted-foreground)]" />

        {/* Bot filter */}
        <select
          data-testid="filter-bot"
          aria-label={t("filterAllBots")}
          value={selectedBot}
          onChange={(e) => setSelectedBot(e.target.value)}
          className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)]"
        >
          <option value="all">{t("filterAllBots")}</option>
          {bots.map((b) => (
            <option key={b.name} value={b.name}>
              {b.display?.label || b.name}
            </option>
          ))}
        </select>

        {/* Origin filter */}
        <select
          data-testid="filter-origin"
          aria-label={t("filterAllOrigins")}
          value={selectedOrigin}
          onChange={(e) => setSelectedOrigin(e.target.value)}
          className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)]"
        >
          <option value="all">{t("filterAllOrigins")}</option>
          <option value="message">{t("filterOriginMessage")}</option>
          <option value="routine">{t("filterOriginRoutine")}</option>
          <option value="webhook">{t("filterOriginWebhook")}</option>
          <option value="handoff">{t("filterOriginHandoff")}</option>
        </select>

        {/* Status filter */}
        <select
          data-testid="filter-status"
          aria-label={t("filterAllStatuses")}
          value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value)}
          className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)]"
        >
          <option value="all">{t("filterAllStatuses")}</option>
          <option value="running">{t("filterStatusRunning")}</option>
          <option value="waiting_approval">{t("filterStatusWaitingApproval")}</option>
          <option value="scheduled">{t("filterStatusScheduled")}</option>
          <option value="done">{t("filterStatusDone")}</option>
          <option value="error">{t("filterStatusError")}</option>
          <option value="stopped">{t("filterStatusStopped")}</option>
          <option value="blocked">{t("filterStatusBlocked")}</option>
        </select>

        {/* Search input */}
        <div className="lb:flex lb:items-center lb:gap-1 lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-0.5 lb:grow lb:max-w-xs">
          <SearchIcon size={12} className="lb:text-[var(--color-muted-foreground)]" />
          <input
            type="text"
            data-testid="input-search-activity"
            aria-label={t("activitySearchPlaceholder")}
            placeholder={t("activitySearchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="lb:bg-transparent lb:w-full lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label={t("closePanelBtn")}
              onClick={() => setSearchQuery("")}
              className="lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)]"
            >
              <XIcon size={12} />
            </button>
          )}
        </div>

        {/* Min cost input */}
        <input
          type="number"
          data-testid="input-min-cost"
          aria-label={t("activityMinCostPlaceholder")}
          placeholder={t("activityMinCostPlaceholder")}
          value={minCost}
          onChange={(e) => setMinCost(e.target.value)}
          className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:w-44 lb:text-[var(--color-foreground)] focus:lb:outline-none"
        />
      </div>

      {/* Partial sources warning banner (Contract §2) */}
      {partialSources && partialSources.length > 0 && (
        <div
          role="alert"
          className="lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:px-4 lb:py-2 lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:text-[var(--color-warning)] lb:shrink-0"
        >
          <ShieldAlertIcon size={14} />
          <span>{t("activityPartialWarning", { sources: partialSources.join(", ") })}</span>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div
          role="status"
          className="lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:px-3 lb:py-1.5 lb:rounded-xl lb:text-[13px] lb:shadow-lg lb:fixed lb:bottom-4 lb:right-4 lb:z-50 lb:motion-safe:animate-in lb:fade-in"
        >
          {toastMessage}
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="lb:p-4 lb:bg-[var(--color-destructive)]/15 lb:border-b lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between">
          <span><ErrorNote error={error} /></span>
          <button
            type="button"
            onClick={handleRefresh}
            className="lb:underline lb:font-medium hover:lb:opacity-80"
          >
            {t("retry")}
          </button>
        </div>
      )}

      {/* Main Content Area */}
      <div className="lb:flex-1 lb:overflow-hidden lb:relative">
        {loading && (
          <div className="lb:absolute lb:inset-0 lb:bg-[var(--background)]/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:z-10">
            <div className="lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              <RefreshCwIcon size={14} className="lb:motion-safe:animate-spin" />
              <span>{t("loadingBots")}</span>
            </div>
          </div>
        )}

        {filteredItems.length === 0 && !loading ? (
          <div
            data-testid="activity-empty-state"
            className="lb:h-full lb:flex lb:flex-col lb:items-center lb:justify-center lb:p-8 lb:text-center"
          >
            <ClockIcon size={32} className="lb:text-[var(--color-muted-foreground)] lb:mb-2 lb:opacity-40" />
            <h3 className="lb:text-[15px] lb:font-medium lb:text-[var(--color-card-foreground)]">
              {t("noActivityFound")}
            </h3>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-md lb:mt-1">
              {t("inProgressEmptyNextStep")}
            </p>
            {(selectedBot !== "all" || selectedOrigin !== "all" || selectedStatus !== "all" || searchQuery || minCost) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedBot("all");
                  setSelectedOrigin("all");
                  setSelectedStatus("all");
                  setSearchQuery("");
                  setMinCost("");
                }}
                className="lb:mt-3 lb:px-3 lb:py-1.5 lb:bg-[var(--lb-fill)] lb:text-[var(--color-secondary-foreground)] lb:text-[13px] lb:font-medium lb:hover:bg-[var(--lb-fill-2)] lb:border-[var(--lb-separator)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("clearSearch")}
              </button>
            )}
          </div>
        ) : viewMode === "list" ? (
          /* List View */
          <div className="lb:h-full lb:overflow-y-auto lb:p-3 lb:md:p-4 lb:space-y-2">
            {filteredItems.map((item) => {
              // Crucial Invariant: Parar is stoppable if status is running or waiting_approval.
              // It CONTINUES VISIBLE until terminal status is confirmed!
              const isStoppable = item.status === "running" || item.status === "waiting_approval";
              const isStopping = Boolean(stoppingIds[item.id]);

              return (
                <div
                  key={item.id}
                  data-testid={`activity-item-${item.id}`}
                  className="lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:rounded-2xl lb:p-3 lb:hover:border-[var(--color-primary)]/40 lb:motion-safe:transition-colors lb:flex lb:flex-col lb:gap-2"
                >
                  <div className="lb:flex lb:items-start lb:justify-between lb:gap-3">
                    <div className="lb:flex lb:items-center lb:gap-2 lb:flex-wrap">
                      {/* Bot tag */}
                      <span className="lb:inline-flex lb:items-center lb:gap-2">
                        <Avatar name={botLabel(item.bot)} avatar={botInfo(item.bot)?.display?.avatar} color={botInfo(item.bot)?.display?.color} size={24} />
                        <span className="lb-headline">{botLabel(item.bot)}</span>
                      </span>

                      {/* Origin tag */}
                      <span className="lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--color-muted)]/70 lb:text-[var(--color-muted-foreground)]">
                        {getOriginLabel(item.origin)}
                      </span>

                      {/* Status tag */}
                      <span
                        className={`lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-medium ${
                          item.status === "running"
                            ? "lb:bg-[var(--color-primary)]/20 lb:text-[var(--color-primary)]"
                            : item.status === "waiting_approval"
                            ? "lb:bg-[var(--color-warning)]/20 lb:text-[var(--color-warning)]"
                            : item.status === "done"
                            ? "lb:bg-[var(--color-success,var(--color-primary))]/20 lb:text-[var(--color-foreground)]"
                            : item.status === "error" || item.status === "blocked"
                            ? "lb:bg-[var(--color-destructive)]/20 lb:text-[var(--color-destructive)]"
                            : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
                        }`}
                      >
                        {getStatusLabel(item.status)}
                      </span>

                      {/* Checkpoint */}
                      {item.checkpoint && (
                        <span className="lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]">
                          {t("activityCheckpointBadge", {
                            done: item.checkpoint.done,
                            total: item.checkpoint.total,
                            review: item.checkpoint.to_review,
                          })}
                        </span>
                      )}
                    </div>

                    {/* Metadata: Duration & Cost */}
                    <div className="lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:shrink-0">
                      {item.duration_s !== null && item.duration_s !== undefined && (
                        <span>{t("activityDurationLabel", { seconds: item.duration_s })}</span>
                      )}
                      {item.cost_cents !== null && item.cost_cents !== undefined && (
                        <span className="lb:text-[var(--color-foreground)]" style={{ fontVariantNumeric: "tabular-nums" }}>
                          {t("activityCostLabel", { cost: formatCents(item.cost_cents, locale) })}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Title / Content: Never raw HTML, safely rendered via Markdown / text */}
                  <div
                    data-testid={`activity-title-${item.id}`}
                    className="lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)] lb:break-words"
                  >
                    <Markdown text={activityTitle(item, t)} />
                  </div>

                  {/* Action Bar */}
                  <div className="lb:flex lb:items-center lb:justify-between lb:gap-2 lb:pt-1 lb:border-t lb:border-[var(--color-border)]/40 lb:mt-1">
                    <div className="lb:flex lb:items-center lb:gap-2">
                      {/* Context / Correct: only a task has a thread the Bot reads (a Kanban comment); the backend refuses the rest */}
                      {item.kind === "task" && <button
                        type="button"
                        data-testid={`btn-context-${item.id}`}
                        onClick={() => {
                          setContextModalItem(item);
                          setContextKind("context");
                          setContextText("");
                        }}
                        className="lb:text-[13px] lb:px-2 lb:py-0.5 lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:hover:bg-[var(--color-muted)]/50 lb:motion-safe:transition-colors lb:rounded-full"
                      >
                        {t("activityBtnContext")}
                      </button>}

                      {/* Redirect */}
                      <button
                        type="button"
                        data-testid={`btn-redirect-${item.id}`}
                        onClick={() => {
                          setRedirectModalItem(item);
                          setRedirectBot(bots[0]?.name || "");
                          setRedirectReason("");
                        }}
                        className="lb:text-[13px] lb:px-2 lb:py-0.5 lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:hover:bg-[var(--color-muted)]/50 lb:motion-safe:transition-colors lb:rounded-full"
                      >
                        {t("activityBtnRedirect")}
                      </button>

                      {/* Stop Button: Continues visible until confirmed terminal state */}
                      {isStoppable ? (
                        <button
                          type="button"
                          data-testid={`btn-stop-${item.id}`}
                          disabled={isStopping}
                          onClick={() => {
                            setStopModalItem(item);
                            setStopReason("");
                          }}
                          className="lb:text-[13px] lb:px-2 lb:py-0.5 lb:border-[var(--color-destructive)] lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:disabled:opacity-50 lb:motion-safe:transition-colors lb:rounded-full"
                        >
                          {isStopping ? t("activityBtnStopping") : t("activityBtnStop")}
                        </button>
                      ) : null}
                    </div>

                    {/* D7: these were spans that looked like links. "Conversa" opens the Bot's conversation for real;
                        "Eventos" left: there is no events screen to open. */}
                    {onOpenConversation && (
                      <button type="button" onClick={() => onOpenConversation(item.bot)}
                        className="lb:text-[13px] lb:text-[var(--color-primary)] lb:underline lb:hover:no-underline lb:min-h-11 lb:md:min-h-6 lb:flex lb:items-center focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none">
                        {t("activityBtnConversation")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          /* Kanban View: Exactly the 8 Hermes Kanban columns */
          <div
            data-testid="kanban-board"
            className="lb:h-full lb:overflow-x-auto lb:flex lb:gap-3 lb:p-3 lb:md:p-4"
          >
            {HERMES_KANBAN_COLUMNS.map((colKey) => {
              const colItems = kanbanColumnsData[colKey];
              return (
                <div
                  key={colKey}
                  data-testid={`kanban-col-${colKey}`}
                  className="lb:w-72 lb:shrink-0 lb:flex lb:flex-col lb:bg-[var(--color-muted)]/30 lb:border-[var(--lb-separator)] lb:rounded-2xl lb:overflow-hidden"
                >
                  {/* Column Header */}
                  <div className="lb:p-2.5 lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-muted)]/50 lb:flex lb:items-center lb:justify-between">
                    <span className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-foreground)]">
                      {getKanbanColumnTitle(colKey)}
                    </span>
                    <span className="lb:text-xs lb:font-mono lb:px-1.5 lb:py-0.2 lb:rounded-full lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]">
                      {colItems.length}
                    </span>
                  </div>

                  {/* Cards container */}
                  <div className="lb:flex-1 lb:overflow-y-auto lb:p-2 lb:space-y-2">
                    {colItems.map((item) => {
                      const isStoppable = item.status === "running" || item.status === "waiting_approval";
                      const isStopping = Boolean(stoppingIds[item.id]);

                      return (
                        <div
                          key={item.id}
                          data-testid={`kanban-card-${item.id}`}
                          className="lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2.5 lb:space-y-1.5 lb:hover:border-[var(--color-primary)]/40 lb:motion-safe:transition-colors"
                        >
                          <div className="lb:flex lb:items-center lb:justify-between lb:gap-1.5">
                            <span className="lb:inline-flex lb:items-center lb:gap-1.5 lb:text-xs lb:font-semibold">
                              <Avatar name={botLabel(item.bot)} avatar={botInfo(item.bot)?.display?.avatar} color={botInfo(item.bot)?.display?.color} size={20} />
                              {botLabel(item.bot)}
                            </span>
                            <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                              {getOriginLabel(item.origin)}
                            </span>
                          </div>

                          {/* Safe title rendering */}
                          <div
                            data-testid={`kanban-card-title-${item.id}`}
                            className="lb:text-[13px] lb:text-[var(--color-foreground)] lb:break-words"
                          >
                            <Markdown text={activityTitle(item, t)} />
                          </div>

                          {/* Card actions */}
                          <div className="lb:flex lb:items-center lb:justify-between lb:pt-1 lb:border-t lb:border-[var(--color-border)]/40 lb:text-xs">
                            {item.kind === "task" ? <button
                              type="button"
                              data-testid={`kanban-btn-context-${item.id}`}
                              onClick={() => {
                                setContextModalItem(item);
                                setContextKind("context");
                                setContextText("");
                              }}
                              className="lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)]"
                            >
                              {t("activityBtnContext")}
                            </button> : <span />}

                            <button
                              type="button"
                              onClick={() => {
                                setRedirectModalItem(item);
                                setRedirectBot(bots[0]?.name || "");
                                setRedirectReason("");
                              }}
                              className="lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)]"
                            >
                              {t("activityBtnRedirect")}
                            </button>

                            {/* Stop button in Kanban: continues visible until terminal confirmed */}
                            {isStoppable ? (
                              <button
                                type="button"
                                data-testid={`kanban-btn-stop-${item.id}`}
                                disabled={isStopping}
                                onClick={() => {
                                  setStopModalItem(item);
                                  setStopReason("");
                                }}
                                className="lb:text-[var(--color-destructive)] hover:lb:underline lb:disabled:opacity-50"
                              >
                                {isStopping ? t("activityBtnStopping") : t("activityBtnStop")}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Stop Confirmation Modal */}
      {stopModalItem && (
        <div
          ref={stopModalRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("activityStopModalTitle")}
          className="lb:fixed lb:inset-0 lb:bg-black/50 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4 lb:z-50"
        >
          <div className="lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:max-w-md lb:w-full lb:p-5 lb:shadow-xl lb:space-y-4">
            <div className="lb:flex lb:items-center lb:gap-2 lb:text-[var(--color-destructive)]">
              <ShieldAlertIcon size={18} />
              <h2 className="lb:text-[15px] lb:font-bold">{t("activityStopModalTitle")}</h2>
            </div>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("activityStopModalDesc")}
            </p>
            <div className="lb:text-[13px] lb:font-mono lb:bg-[var(--color-muted)]/50 lb:p-2 lb:rounded-lg lb:break-words">
              {activityTitle(stopModalItem, t)}
            </div>
            <input
              type="text"
              data-testid="input-stop-reason"
              aria-label={t("activityStopReasonPlaceholder")}
              placeholder={t("activityStopReasonPlaceholder")}
              value={stopReason}
              onChange={(e) => setStopReason(e.target.value)}
              className="lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-destructive)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)]"
            />
            <div className="lb:flex lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setStopModalItem(null)}
                className="lb:px-3 lb:py-1.5 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-stop"
                disabled={submittingStop}
                onClick={handleConfirmStop}
                className="lb:px-3 lb:py-1.5 lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground,white)] lb:text-[13px] lb:font-medium hover:lb:opacity-90 lb:disabled:opacity-50 lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("activityStopConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Redirect Confirmation Modal */}
      {redirectModalItem && (
        <div
          ref={redirectModalRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("activityRedirectModalTitle")}
          className="lb:fixed lb:inset-0 lb:bg-black/50 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4 lb:z-50"
        >
          <div className="lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:max-w-md lb:w-full lb:p-5 lb:shadow-xl lb:space-y-4">
            <h2 className="lb:text-[15px] lb:font-bold">{t("activityRedirectModalTitle")}</h2>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("activityRedirectModalDesc")}
            </p>
            <div className="lb:space-y-2">
              <label className="lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]">
                {t("activityRedirectSelectBotLabel")}
              </label>
              <select
                data-testid="select-redirect-bot"
                aria-label={t("activityRedirectSelectBotLabel")}
                value={redirectBot}
                onChange={(e) => setRedirectBot(e.target.value)}
                className="lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
              >
                {bots.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.display?.label || b.name}
                  </option>
                ))}
              </select>
            </div>
            <input
              type="text"
              data-testid="input-redirect-reason"
              aria-label={t("activityRedirectReasonPlaceholder")}
              placeholder={t("activityRedirectReasonPlaceholder")}
              value={redirectReason}
              onChange={(e) => setRedirectReason(e.target.value)}
              className="lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
            />
            <div className="lb:flex lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setRedirectModalItem(null)}
                className="lb:px-3 lb:py-1.5 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-redirect"
                disabled={submittingRedirect || !redirectBot}
                onClick={handleConfirmRedirect}
                className="lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-medium hover:lb:opacity-90 lb:disabled:opacity-50 lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("activityRedirectConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context / Correction Modal */}
      {contextModalItem && (
        <div
          ref={contextModalRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("activityContextModalTitle")}
          className="lb:fixed lb:inset-0 lb:bg-black/50 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4 lb:z-50"
        >
          <div className="lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:max-w-md lb:w-full lb:p-5 lb:shadow-xl lb:space-y-4">
            <h2 className="lb:text-[15px] lb:font-bold">{t("activityContextModalTitle")}</h2>
            {/* Kind selector */}
            <div className="lb:flex lb:items-center lb:gap-2">
              <button
                type="button"
                data-testid="btn-kind-context"
                onClick={() => setContextKind("context")}
                className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                  contextKind === "context"
                    ? "lb:border-[var(--color-primary)] lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)] lb:font-medium"
                    : "lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]"
                }`}
              >
                {t("activityContextKindContext")}
              </button>
              <button
                type="button"
                data-testid="btn-kind-correction"
                onClick={() => setContextKind("correction")}
                className={`lb:px-2.5 lb:py-1 lb:text-[13px] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full ${
                  contextKind === "correction"
                    ? "lb:border-[var(--color-primary)] lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)] lb:font-medium"
                    : "lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)]"
                }`}
              >
                {t("activityContextKindCorrection")}
              </button>
            </div>

            <textarea
              rows={3}
              data-testid="textarea-context"
              aria-label={t("activityContextTextPlaceholder")}
              placeholder={t("activityContextTextPlaceholder")}
              value={contextText}
              onChange={(e) => setContextText(e.target.value)}
              className="lb:w-full lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-xl lb:p-2 lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:ring-1 focus:lb:ring-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
            />

            <p className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:bg-[var(--color-muted)]/30 lb:p-2 lb:rounded-lg">
              {t("activityContextNotice")}
            </p>

            <div className="lb:flex lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setContextModalItem(null)}
                className="lb:px-3 lb:py-1.5 lb:border-[var(--lb-separator)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] hover:lb:text-[var(--color-foreground)] lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-context"
                disabled={submittingContext || !contextText.trim()}
                onClick={handleConfirmContext}
                className="lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-medium hover:lb:opacity-90 lb:disabled:opacity-50 lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("activityContextConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
