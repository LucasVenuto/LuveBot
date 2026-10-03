// dashboard/src/components/routines/RoutinesView.tsx
// Routines management and full execution history view (spec §4.9, contract v0.2 §3).
// Complete execution history paged by offset until the end (no 20 or 100 limit, A-25).
// Routines paused by budget show reason and only resume via human click.
// Test action disabled for paused routines with clear explanation (A-27 / contract v0.2 §3).
// Mutations require human confirmation.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import type {
  Bot,
  Routine,
  RoutineDetail,
  RoutineRun,
  RoutineState,
} from "../../api/types";
import {
  getRoutines,
  getRoutine,
  fetchAllRoutineRuns,
  createRoutine,
  updateRoutine,
  duplicateRoutine,
  pauseRoutine,
  resumeRoutine,
  testRoutine,
  deleteRoutine,
} from "../../api/client";
import { formatCents } from "../costs";
import {
  RefreshCwIcon,
  PlusIcon,
  PlayIcon,
  PauseIcon,
  CheckCircleIcon,
  ShieldAlertIcon,
  XIcon,
  ClockIcon,
} from "../Icons";
import { Avatar } from "../ui/Avatar";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { routineRunStatusLabel, epochDate, durationText } from "../labels";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface RoutinesViewProps {
  bots?: Bot[];
  initialRoutines?: Routine[];
  onRefresh?: () => void;
  botName?: string; // opened from a Bot's profile: start filtered on that Bot
}

export function RoutinesView({
  bots = [],
  initialRoutines,
  onRefresh,
  botName,
}: RoutinesViewProps) {
  const { locale, t } = useLuveI18n();

  // Routines list state
  const [routines, setRoutines] = useState<Routine[]>(initialRoutines || []);
  const [loading, setLoading] = useState<boolean>(!initialRoutines);
  const [error, setError] = useState<ErrorState | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ErrorState | null>(null);

  // Filters
  const [filterBot, setFilterBot] = useState<string>(botName ?? "");
  const [filterState, setFilterState] = useState<string>("all");

  // Selected routine detail & history view
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [routineDetail, setRoutineDetail] = useState<RoutineDetail | null>(null);
  const [historyRuns, setHistoryRuns] = useState<RoutineRun[]>([]);
  const [isHistoryTruncated, setIsHistoryTruncated] = useState<boolean>(false);
  const [loadingHistory, setLoadingHistory] = useState<boolean>(false);

  // Modals state
  const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
  const [editRoutine, setEditRoutine] = useState<Routine | null>(null);
  const [newBot, setNewBot] = useState<string>(botName || bots[0]?.name || "vendas");
  const [newName, setNewName] = useState<string>("");
  const [newScheduleExpr, setNewScheduleExpr] = useState<string>("0 8 * * 1-5");
  const [newPrompt, setNewPrompt] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Confirmations
  const [confirmTestRoutine, setConfirmTestRoutine] = useState<Routine | null>(null);
  const [confirmPauseRoutine, setConfirmPauseRoutine] = useState<Routine | null>(null);
  const [confirmResumeRoutine, setConfirmResumeRoutine] = useState<Routine | null>(null);
  const [confirmDeleteRoutine, setConfirmDeleteRoutine] = useState<Routine | null>(null);
  const [deleteTypedName, setDeleteTypedName] = useState<string>("");

  const formModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: createModalOpen,
    onClose: () => setCreateModalOpen(false),
  });

  const testModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(confirmTestRoutine),
    onClose: () => setConfirmTestRoutine(null),
  });

  const pauseModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(confirmPauseRoutine),
    onClose: () => setConfirmPauseRoutine(null),
  });

  const resumeModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(confirmResumeRoutine),
    onClose: () => setConfirmResumeRoutine(null),
  });

  const deleteModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(confirmDeleteRoutine),
    onClose: () => setConfirmDeleteRoutine(null),
  });

  // Load routines list
  const loadRoutinesList = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getRoutines({
        bot: filterBot || undefined,
        state: filterState !== "all" ? filterState : undefined,
      });
      setRoutines(res.routines || []);
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorLoadingRoutines");
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [filterBot, filterState, t]);

  useEffect(() => {
    if (!initialRoutines) {
      loadRoutinesList();
    }
  }, [loadRoutinesList, initialRoutines]);

  // Load full history for selected routine
  const loadRoutineDetailAndHistory = useCallback(
    async (id: string) => {
      setSelectedRoutineId(id);
      setLoadingHistory(true);
      setActionError(null);
      try {
        const detailRes = await getRoutine(id);
        setRoutineDetail(detailRes);

        // Fetch full history across all pages (A-25: unlimited pagination)
        const full = await fetchAllRoutineRuns(id, 100);
        setHistoryRuns(full.runs);
        setIsHistoryTruncated(full.truncated);
      } catch (err: unknown) {
        const msg =
          humanError(err, t, "errorLoadingRoutineRuns");
        setActionError(msg);
      } finally {
        setLoadingHistory(false);
      }
    },
    [t]
  );

  const handleRefresh = () => {
    loadRoutinesList();
    if (selectedRoutineId) {
      loadRoutineDetailAndHistory(selectedRoutineId);
    }
    if (onRefresh) onRefresh();
  };

  // Actions
  const handleOpenCreateModal = () => {
    setEditRoutine(null);
    setNewBot(bots[0]?.name || "vendas");
    setNewName("");
    setNewScheduleExpr("0 8 * * 1-5");
    setNewPrompt("");
    setCreateModalOpen(true);
  };

  const handleOpenEditModal = (r: Routine) => {
    setEditRoutine(r);
    setNewBot(r.bot);
    setNewName(r.name);
    setNewScheduleExpr(r.schedule.expr);
    setNewPrompt("");
    setCreateModalOpen(true);
  };

  const handleSaveRoutine = async () => {
    if (!newName.trim() || !newScheduleExpr.trim()) return;

    try {
      setIsSubmitting(true);
      setActionError(null);
      if (editRoutine) {
        await updateRoutine(editRoutine.id, {
          name: newName.trim(),
          schedule: { expr: newScheduleExpr.trim() },
          prompt: newPrompt.trim() || undefined,
        });
      } else {
        await createRoutine({
          bot: newBot,
          name: newName.trim(),
          schedule: { expr: newScheduleExpr.trim() },
          prompt: newPrompt.trim() || undefined,
        });
      }
      setCreateModalOpen(false);
      await loadRoutinesList();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorSavingRoutine");
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecuteTest = async () => {
    if (!confirmTestRoutine) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await testRoutine(confirmTestRoutine.id);
      setConfirmTestRoutine(null);
      setActionSuccess(t("routineTestedSuccess"));
      await loadRoutinesList();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorTestingRoutine");
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecutePause = async () => {
    if (!confirmPauseRoutine) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await pauseRoutine(confirmPauseRoutine.id);
      setConfirmPauseRoutine(null);
      setActionSuccess(t("routinePausedSuccess"));
      await loadRoutinesList();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorPausingRoutine");
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecuteResume = async () => {
    if (!confirmResumeRoutine) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      await resumeRoutine(confirmResumeRoutine.id);
      setConfirmResumeRoutine(null);
      setActionSuccess(t("routineResumedSuccess"));
      await loadRoutinesList();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorResumingRoutine");
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecuteDuplicate = async (r: Routine) => {
    try {
      setIsSubmitting(true);
      setActionError(null);
      await duplicateRoutine(r.id);
      await loadRoutinesList();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorSavingRoutine");
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExecuteDelete = async () => {
    if (!confirmDeleteRoutine) return;
    if (deleteTypedName.trim() !== confirmDeleteRoutine.name) {
      setActionError(t("errorDeletingNameMismatch"));
      return;
    }

    try {
      setIsSubmitting(true);
      setActionError(null);
      await deleteRoutine(confirmDeleteRoutine.id, deleteTypedName.trim());
      setConfirmDeleteRoutine(null);
      setDeleteTypedName("");
      setActionSuccess(t("routineDeletedSuccess"));
      if (selectedRoutineId === confirmDeleteRoutine.id) {
        setSelectedRoutineId(null);
        setRoutineDetail(null);
      }
      await loadRoutinesList();
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorDeletingRoutine");
      setActionError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredRoutines = useMemo(() => {
    return routines.filter((r) => {
      if (filterBot && r.bot !== filterBot) return false;
      if (filterState === "scheduled" && (r.state === "paused" || !r.enabled))
        return false;
      if (filterState === "paused" && r.state !== "paused" && r.enabled)
        return false;
      return true;
    });
  }, [routines, filterBot, filterState]);

  const botInfo = (name: string) => bots.find((b) => b.name === name);
  const botLabel = (name: string) => botInfo(name)?.display?.label || name;

  return (
    <div
      data-testid="routines-view"
      className="lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-y-auto lb:bg-[var(--background)] lb:text-[var(--color-foreground)]"
    >
      {/* Header */}
      <div className="lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-3 lb:px-6 lb:pt-6 lb:pb-2">
        <div className="lb:flex lb:items-center lb:gap-3">
          <div className="lb:p-2 lb:rounded-2xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)]">
            <ClockIcon size={20} />
          </div>
          <div>
            <h1 className="lb-large-title">
              {t("routinesTitle")}
            </h1>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("routinesSubtitle")}
            </p>
          </div>
        </div>

        <div className="lb:flex lb:items-center lb:gap-2">
          <button
            type="button"
            aria-label={t("refreshRoutinesAriaLabel")}
            onClick={handleRefresh}
            className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors lb:rounded-full"
          >
            <RefreshCwIcon size={13} />
            <span>{t("retry")}</span>
          </button>

          <button
            type="button"
            data-testid="btn-new-routine"
            onClick={handleOpenCreateModal}
            className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-colors lb:rounded-full"
          >
            <PlusIcon size={13} />
            <span>{t("newRoutineBtn")}</span>
          </button>
        </div>
      </div>

      {/* Global Alerts */}
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

      {/* Detail & Full History View */}
      {selectedRoutineId ? (
        <div className="lb:p-4 lb:md:p-6 lb:space-y-6">
          <div className="lb:flex lb:items-center lb:justify-between lb:border-b lb:border-[var(--lb-separator)] lb:pb-4">
            <div className="lb:flex lb:items-center lb:gap-3">
              <button
                type="button"
                data-testid="btn-back-to-list"
                onClick={() => setSelectedRoutineId(null)}
                className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full"
              >
                {t("btnCloseDetail")}
              </button>
              <h2 className="lb-title">
                {t("routineDetailTitle", {
                  name: routineDetail?.routine?.name || selectedRoutineId,
                })}
              </h2>
            </div>
          </div>

          {loadingHistory && (
            <div className="lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("loadingBots")}
            </div>
          )}

          {routineDetail && !loadingHistory && (
            <div className="lb:space-y-5">
              {/* Detail instruction card */}
              <div className="lb:p-4 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:space-y-2">
                <div className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-muted-foreground)]">
                  {t("instructionLabel")}
                </div>
                <div className="lb-body lb:bg-[var(--background)] lb:p-3 lb:rounded-xl lb:whitespace-pre-wrap">
                  {routineDetail.detail?.instruction || "-"}
                </div>
              </div>

              {/* History Truncated Warning if script runs hit 100 limit */}
              {isHistoryTruncated && (
                <div
                  role="alert"
                  className="lb:p-3 lb:rounded-xl lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[13px] lb:text-[var(--color-warning)]"
                >
                  {t("historyTruncatedWarning")}
                </div>
              )}

              {/* Full History Section */}
              <div className="lb:space-y-3">
                <h3
                  data-testid="history-title"
                  className="lb:text-[13px] lb:font-bold lb:text-[var(--color-foreground)]"
                >
                  {t("historyTitle", { count: historyRuns.length })}
                </h3>

                <div className="lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:overflow-hidden">
                  <div className="lb:overflow-x-auto">
                    <table className="lb:w-full lb:text-left lb:border-collapse">
                      <thead>
                        <tr className="lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-muted)]/40 lb:text-xs lb:font-semibold lb:text-[var(--color-muted-foreground)]">
                          <th className="lb:py-2.5 lb:px-4">
                            {t("tableHeaderSession")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4">
                            {t("tableHeaderStarted")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4">
                            {t("tableHeaderDuration")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4">
                            {t("tableHeaderStatus")}
                          </th>
                          <th className="lb:py-2.5 lb:px-4 lb:text-right">
                            {t("tableHeaderCost")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="lb:divide-y lb:divide-[var(--lb-separator)] lb:text-[13px]">
                        {historyRuns.length === 0 ? (
                          <tr>
                            <td
                              colSpan={5}
                              className="lb:py-8 lb:px-4 lb:text-center lb:text-[var(--color-muted-foreground)]"
                            >
                              {t("noRunsRecorded")}
                            </td>
                          </tr>
                        ) : (
                          historyRuns.map((run, idx) => (
                            <tr
                              key={idx}
                              data-testid={`routine-run-row-${idx}`}
                              className="lb:hover:bg-[var(--color-muted)]/20 lb:motion-safe:transition-colors"
                            >
                              <td className="lb:py-2.5 lb:px-4 lb:font-mono lb:text-xs">
                                {run.session_id}
                              </td>
                              <td className="lb:py-2.5 lb:px-4 lb:text-xs">
                                {epochDate(run.started_at)?.toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { dateStyle: "short", timeStyle: "short" }) ?? "-"}
                              </td>
                              <td className="lb:py-2.5 lb:px-4 lb:tabular-nums">
                                {durationText(run.duration_s, locale, t) ?? "-"}
                              </td>
                              <td className="lb:py-2.5 lb:px-4">
                                <span
                                  className={`lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold ${
                                    run.status === "success"
                                      ? "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]"
                                      : run.status === "error"
                                      ? "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]"
                                      : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
                                  }`}
                                >
                                  {routineRunStatusLabel(run.status, t)}
                                </span>
                              </td>
                              <td className="lb:py-2.5 lb:px-4 lb:text-right lb:tabular-nums">
                                {formatCents(run.cost_cents || 0, locale)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Routines List View */
        <div className="lb:p-4 lb:md:p-6 lb:space-y-4">
          {/* Filter Bar */}
          <div className="lb:flex lb:flex-wrap lb:items-center lb:gap-3 lb:p-3 lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]">
            {bots.length > 0 && (
              <div className="lb:flex lb:items-center lb:gap-1.5">
                <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                  {t("filterRoutinesBotLabel")}
                </span>
                <select
                  value={filterBot}
                  onChange={(e) => setFilterBot(e.target.value)}
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

            <div className="lb:flex lb:items-center lb:gap-1.5">
              <span className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                {t("filterRoutinesStateLabel")}
              </span>
              <select
                value={filterState}
                onChange={(e) => setFilterState(e.target.value)}
                className="lb:bg-[var(--background)] lb:border-[var(--lb-separator)] lb:rounded-lg lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-foreground)]"
              >
                <option value="all">{t("stateAll")}</option>
                <option value="scheduled">{t("stateScheduled")}</option>
                <option value="paused">{t("statePaused")}</option>
              </select>
            </div>
          </div>

          {loading && !routines.length && (
            <div className="lb:p-8 lb:text-center lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("loadingBots")}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="lb:p-4 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:text-[13px] lb:text-[var(--color-destructive)]"
            >
              <ErrorNote error={error} />
            </div>
          )}

          {/* Routine Cards List */}
          <div className="lb:space-y-3">
            {filteredRoutines.length === 0 ? (
              <div
                data-testid="routines-empty-state"
                className="lb:p-8 lb:rounded-2xl lb:border-dashed lb:border-[var(--lb-separator)] lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2 lb:bg-[var(--color-card)]/50"
              >
                <ClockIcon size={24} className="lb:text-[var(--color-muted-foreground)]" />
                <h3 className="lb-headline">
                  {t("noRoutinesFound")}
                </h3>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm">
                  {t("routinesSubtitle")}
                </p>
                <button
                  type="button"
                  onClick={handleOpenCreateModal}
                  className="lb:mt-2 lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-medium lb:hover:opacity-90 lb:motion-safe:transition-opacity lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
                >
                  <PlusIcon size={14} />
                  <span>{t("createFirstRoutine")}</span>
                </button>
              </div>
            ) : (
              filteredRoutines.map((routine) => {
                const isPaused =
                  routine.state === "paused" || !routine.enabled;
                const isPausedByBudget = routine.paused_reason === "budget";
                const isPausedByUser = routine.paused_reason === "user";

                return (
                  <div
                    key={routine.id}
                    data-testid={`routine-card-${routine.id}`}
                    className="lb:p-4 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-3"
                  >
                    <div className="lb:flex lb:flex-col lb:sm:flex-row lb:sm:items-center lb:justify-between lb:gap-2">
                      <div className="lb:space-y-1">
                        <div className="lb:flex lb:items-center lb:gap-2">
                          <span className="lb-headline">
                            {routine.name}
                          </span>
                          <span className="lb:inline-flex lb:items-center lb:gap-1.5 lb-caption lb:text-[var(--color-muted-foreground)]">
                            <Avatar name={botLabel(routine.bot)} avatar={botInfo(routine.bot)?.display?.avatar} color={botInfo(routine.bot)?.display?.color} size={20} />
                            {botLabel(routine.bot)}
                          </span>

                          {/* State badge */}
                          {isPausedByBudget ? (
                            <span
                              data-testid={`badge-paused-budget-${routine.id}`}
                              className="lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-destructive)]/20 lb:text-[var(--color-destructive)]"
                            >
                              {t("pausedReasonBudget")}
                            </span>
                          ) : isPausedByUser ? (
                            <span
                              data-testid={`badge-paused-user-${routine.id}`}
                              className="lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-warning)]/20 lb:text-[var(--color-warning)]"
                            >
                              {t("pausedReasonUser")}
                            </span>
                          ) : (
                            <span
                              data-testid={`badge-scheduled-${routine.id}`}
                              className="lb:px-2 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]"
                            >
                              {t("stateScheduled")}
                            </span>
                          )}
                        </div>

                        {/* Schedule and timing */}
                        <div className="lb:flex lb:flex-wrap lb:items-center lb:gap-3 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                          <span>
                            {t("scheduleLabel", { expr: routine.schedule.expr })}
                          </span>
                          <span>•</span>
                          <span>
                            {t("nextRunLabel", {
                              time: routine.next_run_at
                                ? new Date(routine.next_run_at).toLocaleString(
                                    locale === "pt" ? "pt-BR" : "en-US"
                                  )
                                : t("noRunYet"),
                            })}
                          </span>
                          {routine.last_run_at && (
                            <>
                              <span>•</span>
                              <span>
                                {t("lastRunLabel", {
                                  time: new Date(
                                    routine.last_run_at
                                  ).toLocaleString(
                                    locale === "pt" ? "pt-BR" : "en-US"
                                  ),
                                })}
                              </span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Cap / Spend Info */}
                      {(routine.cap || routine.spend_cents) && (
                        <div className="lb:text-[13px] lb:tabular-nums lb:text-[var(--color-muted-foreground)] lb:text-right">
                          {routine.cap && (
                            <div>
                              {t("routineCapLabel", {
                                cap: formatCents(routine.cap.cents, locale),
                              })}
                            </div>
                          )}
                          {routine.spend_cents !== undefined &&
                            routine.spend_cents !== null && (
                              <div>
                                {t("routineSpendLabel", {
                                  spend: formatCents(
                                    routine.spend_cents,
                                    locale
                                  ),
                                })}
                              </div>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Actions bar */}
                    <div className="lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
                      <div className="lb:flex lb:items-center lb:gap-2">
                        {/* Rodar Teste: DISABLED on paused routine with clear explanation */}
                        <button
                          type="button"
                          data-testid={`btn-test-routine-${routine.id}`}
                          disabled={isPaused}
                          onClick={() => setConfirmTestRoutine(routine)}
                          title={
                            isPaused
                              ? t("testDisabledPausedRoutine")
                              : t("btnTestRoutine")
                          }
                          className={`lb:inline-flex lb:items-center lb:gap-1 lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:motion-safe:transition-colors lb:rounded-full ${
                            isPaused
                              ? "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                              : "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90"
                          }`}
                        >
                          <PlayIcon size={11} />
                          <span>{t("btnTestRoutine")}</span>
                        </button>

                        {/* Pause / Resume button */}
                        {isPaused ? (
                          <button
                            type="button"
                            data-testid={`btn-resume-routine-${routine.id}`}
                            onClick={() => setConfirmResumeRoutine(routine)}
                            className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full"
                          >
                            <PlayIcon size={11} />
                            <span>{t("btnResumeRoutine")}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            data-testid={`btn-pause-routine-${routine.id}`}
                            onClick={() => setConfirmPauseRoutine(routine)}
                            className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full"
                          >
                            <PauseIcon size={11} />
                            <span>{t("btnPauseRoutine")}</span>
                          </button>
                        )}

                        {/* View History & Details button */}
                        <button
                          type="button"
                          data-testid={`btn-history-routine-${routine.id}`}
                          onClick={() =>
                            loadRoutineDetailAndHistory(routine.id)
                          }
                          className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full"
                        >
                          {t("btnViewHistory")}
                        </button>
                      </div>

                      <div className="lb:flex lb:items-center lb:gap-2">
                        {/* Edit button */}
                        <button
                          type="button"
                          data-testid={`btn-edit-routine-${routine.id}`}
                          onClick={() => handleOpenEditModal(routine)}
                          className="lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:rounded-full"
                        >
                          {t("btnEditRoutine")}
                        </button>

                        {/* Duplicate button */}
                        <button
                          type="button"
                          data-testid={`btn-duplicate-routine-${routine.id}`}
                          onClick={() => handleExecuteDuplicate(routine)}
                          className="lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:rounded-full"
                        >
                          {t("btnDuplicateRoutine")}
                        </button>

                        {/* Delete button */}
                        <button
                          type="button"
                          data-testid={`btn-delete-routine-${routine.id}`}
                          onClick={() => {
                            setConfirmDeleteRoutine(routine);
                            setDeleteTypedName("");
                          }}
                          className="lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:rounded-full"
                        >
                          {t("btnDeleteRoutine")}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* Modal: Create or Edit Routine                                       */}
      {/* =================================================================== */}
      {createModalOpen && (
        <div
          ref={formModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-routine-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-routine-form"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-routine-title" className="lb-title">
                {editRoutine
                  ? t("modalEditRoutineTitle")
                  : t("modalCreateRoutineTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setCreateModalOpen(false)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            {/* Bot select (only if new) */}
            {!editRoutine && (
              <div className="lb:space-y-1">
                <label className="lb:text-[13px] lb:font-medium">
                  {t("routineBotInput")}
                </label>
                <select
                  value={newBot}
                  onChange={(e) => setNewBot(e.target.value)}
                  className="lb-input"
                >
                  {bots.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.display?.label || b.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Routine Name */}
            <div className="lb:space-y-1">
              <label className="lb:text-[13px] lb:font-medium">
                {t("routineNameInput")}
              </label>
              <input
                type="text"
                data-testid="input-routine-name"
                placeholder={t("routineNamePlaceholder")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="lb-input"
              />
            </div>

            {/* Schedule Expression */}
            <div className="lb:space-y-1">
              <label className="lb:text-[13px] lb:font-medium">
                {t("routineScheduleExprInput")}
              </label>
              <input
                type="text"
                data-testid="input-routine-schedule"
                placeholder={t("routineScheduleExprPlaceholder")}
                value={newScheduleExpr}
                onChange={(e) => setNewScheduleExpr(e.target.value)}
                className="lb-input lb-mono"
              />
            </div>

            {/* Instruction / Prompt */}
            <div className="lb:space-y-1">
              <label className="lb:text-[13px] lb:font-medium">
                {t("routinePromptInput")}
              </label>
              <textarea
                rows={3}
                data-testid="input-routine-prompt"
                placeholder={t("routinePromptPlaceholder")}
                value={newPrompt}
                onChange={(e) => setNewPrompt(e.target.value)}
                className="lb-input"
              />
            </div>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-save-routine"
                disabled={isSubmitting || !newName.trim()}
                onClick={handleSaveRoutine}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full"
              >
                {isSubmitting ? t("loadingBots") : t("btnSaveRoutine")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* Modal: Confirm Test Routine                                         */}
      {/* =================================================================== */}
      {confirmTestRoutine && (
        <div
          ref={testModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-test-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-confirm-test"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-test-title" className="lb-title">
                {t("modalConfirmTestTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setConfirmTestRoutine(null)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("modalConfirmTestBody", { name: confirmTestRoutine.name })}
            </p>

            <div className="lb:p-2.5 lb:rounded-lg lb:bg-[var(--color-warning)]/15 lb:border-[var(--color-warning)]/40 lb:text-[13px] lb:text-[var(--color-warning)]">
              {t("testWarningRealWork")}
            </div>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              <button
                type="button"
                onClick={() => setConfirmTestRoutine(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-test"
                disabled={isSubmitting}
                onClick={handleExecuteTest}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {isSubmitting ? t("loadingBots") : t("btnConfirmTest")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* Modal: Confirm Pause Routine                                        */}
      {/* =================================================================== */}
      {confirmPauseRoutine && (
        <div
          ref={pauseModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-pause-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-confirm-pause"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-pause-title" className="lb-title">
                {t("modalConfirmPauseTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setConfirmPauseRoutine(null)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("modalConfirmPauseBody", { name: confirmPauseRoutine.name })}
            </p>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              <button
                type="button"
                onClick={() => setConfirmPauseRoutine(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-pause"
                disabled={isSubmitting}
                onClick={handleExecutePause}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-warning)] lb:text-[var(--color-foreground)] lb:hover:opacity-90 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-warning)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {isSubmitting ? t("loadingBots") : t("btnConfirmPause")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* Modal: Confirm Resume Routine                                       */}
      {/* =================================================================== */}
      {confirmResumeRoutine && (
        <div
          ref={resumeModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-resume-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-confirm-resume"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-resume-title" className="lb-title">
                {t("modalConfirmResumeTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setConfirmResumeRoutine(null)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("modalConfirmResumeBody", { name: confirmResumeRoutine.name })}
            </p>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              <button
                type="button"
                onClick={() => setConfirmResumeRoutine(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-resume-routine"
                disabled={isSubmitting}
                onClick={handleExecuteResume}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {isSubmitting ? t("loadingBots") : t("btnConfirmResumeRoutine")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* Modal: Confirm Delete Routine                                       */}
      {/* =================================================================== */}
      {confirmDeleteRoutine && (
        <div
          ref={deleteModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-delete-title"
          className="lb-dialog-overlay"
        >
          <div
            data-testid="modal-confirm-delete"
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-center lb:justify-between">
              <h3 id="modal-delete-title" className="lb-title">
                {t("modalConfirmDeleteTitle")}
              </h3>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setConfirmDeleteRoutine(null)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("modalConfirmDeleteBody", { name: confirmDeleteRoutine.name })}
            </p>

            <input
              type="text"
              data-testid="input-delete-confirm-name"
              placeholder={t("deleteRoutineInputPlaceholder")}
              value={deleteTypedName}
              onChange={(e) => setDeleteTypedName(e.target.value)}
              className="lb-input"
            />

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2 lb:border-t lb:border-[var(--lb-separator)]">
              <button
                type="button"
                onClick={() => setConfirmDeleteRoutine(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:border-[var(--lb-separator)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="button"
                data-testid="btn-confirm-delete"
                disabled={
                  isSubmitting ||
                  deleteTypedName.trim() !== confirmDeleteRoutine.name
                }
                onClick={handleExecuteDelete}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-destructive)] lb:text-white hover:lb:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {isSubmitting ? t("loadingBots") : t("btnConfirmDelete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
