// dashboard/src/components/approvals/ApprovalsInbox.tsx
// Approvals Inbox component (spec §4.8, contract v0.1 §1-§2, ADR-002).
// Invariant 6: No resolution without explicit human click.
// 'Sempre permitir' creates a draft rule and resolves once (NEVER sends 'always').
// Denying requires a mandatory reason.
// In loopback auth_mode, approvals are displayed in read-only mode with a warning banner.

import { useRuleLabels, approvalTitle } from "./humanize";
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Approval, Bot } from "../../api/types";
import {
  getApprovals,
  resolveApproval,
  batchResolveApprovals,
  getSession,
  ApiError,
} from "../../api/client";
import {
  CheckCircleIcon,
  XIcon,
  ShieldAlertIcon,
  ClockIcon,
  RefreshCwIcon,
  CheckIcon,
  FilterIcon,
} from "../Icons";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Avatar } from "../ui/Avatar";
import { approvalStateLabel, approvalDecisionLabel, approvalChoiceLabel } from "../labels";
import { onceRequest, alwaysRequest, denyRequest, mixedActionClass, batchItems, approvalErrorText, reasonState, reasonsState, reasonText, followReasons, type ReasonState } from "./decide";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

export interface ApprovalsInboxProps {
  bots?: Bot[];
  authMode?: "loopback" | "gated";
  initialApprovals?: Approval[];
  onApprovalsChanged?: (pendingCount: number) => void;
}

export function ApprovalsInbox({
  bots = [],
  authMode: controlledAuthMode,
  initialApprovals,
  onApprovalsChanged,
}: ApprovalsInboxProps) {
  const { t } = useLuveI18n();
  const ruleLabel = useRuleLabels();
  const labelOf = (name: string) => bots.find((b) => b.name === name)?.display?.label || name; // the Bot's name, never the slug
  const [approvals, setApprovals] = useState<Approval[]>(initialApprovals || []);
  const [loading, setLoading] = useState<boolean>(!initialApprovals);
  const [error, setError] = useState<ErrorState | null>(null);
  const [authMode, setAuthMode] = useState<"loopback" | "gated">(
    controlledAuthMode || "gated"
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [botFilter, setBotFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"pending" | "all">("pending");

  // Dialog / Modal States
  const [alwaysModalItem, setAlwaysModalItem] = useState<Approval | null>(null);
  const [alwaysDraftLabel, setAlwaysDraftLabel] = useState<string>("");
  const [denyModalItem, setDenyModalItem] = useState<Approval | null>(null);
  const [denyReason, setDenyReason] = useState<string>("");
  const [editModalItem, setEditModalItem] = useState<Approval | null>(null);
  const [batchConfirmMode, setBatchConfirmMode] = useState<"once" | "deny" | null>(null);
  const [batchDenyReason, setBatchDenyReason] = useState<string>("");

  const alwaysModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(alwaysModalItem),
    onClose: () => setAlwaysModalItem(null),
  });

  const denyModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(denyModalItem),
    onClose: () => setDenyModalItem(null),
  });

  const editModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(editModalItem),
    onClose: () => setEditModalItem(null),
  });

  const batchModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: Boolean(batchConfirmMode),
    onClose: () => setBatchConfirmMode(null),
  });

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  /** The banner after a deny: while the reason is being sent it stays and follows it; it hides 4 s after the final word. */
  const sayDenied = (head: string, first: ReasonState, ids: string[]) => {
    const show = (s: ReasonState) => {
      setActionSuccessMsg(`${head} ${t(reasonText(s))}`);
      if (s !== "sending") setTimeout(() => { if (mounted.current) setActionSuccessMsg(null); }, 4000);
    };
    show(first);
    if (first === "sending") void followReasons(ids, show, () => mounted.current);
  };

  const isLoopback = authMode === "loopback";

  // Check session auth mode if not passed as controlled prop
  useEffect(() => {
    if (!controlledAuthMode) {
      getSession()
        .then((s) => {
          if (s?.auth_mode) {
            setAuthMode(s.auth_mode);
          }
        })
        .catch(() => {
          // ignore error; defaults to gated
        });
    } else {
      setAuthMode(controlledAuthMode);
    }
  }, [controlledAuthMode]);

  // Load approvals from backend
  const loadApprovalsList = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getApprovals();
      const list = res?.approvals || [];
      setApprovals(list);
      const pendingCount = list.filter((a) => a.status === "pending").length;
      onApprovalsChanged?.(pendingCount);
    } catch (err: unknown) {
      setError(humanError(err, t, "errorLoadingApprovals"));
    } finally {
      setLoading(false);
    }
  }, [onApprovalsChanged, t]);

  useEffect(() => {
    if (!initialApprovals) {
      loadApprovalsList();
    }
  }, [initialApprovals, loadApprovalsList]);

  // Update parent when approvals state changes
  const updateApprovalsState = useCallback(
    (updater: (prev: Approval[]) => Approval[]) => {
      setApprovals((prev) => {
        const next = updater(prev);
        const pendingCount = next.filter((a) => a.status === "pending").length;
        onApprovalsChanged?.(pendingCount);
        return next;
      });
    },
    [onApprovalsChanged]
  );

  // Filtered approvals
  const displayedApprovals = useMemo(() => {
    return approvals.filter((a) => {
      if (statusFilter === "pending" && a.status !== "pending") return false;
      if (botFilter !== "all" && a.bot !== botFilter) return false;
      return true;
    });
  }, [approvals, statusFilter, botFilter]);

  const pendingCount = useMemo(() => {
    return approvals.filter((a) => a.status === "pending").length;
  }, [approvals]);

  // Batch compatibility: all selected items must share the same action_class_hash (Contract §2)
  const selectedItems = useMemo(() => {
    return approvals.filter((a) => selectedIds.has(a.request_id));
  }, [approvals, selectedIds]);

  const hasMismatchedActionClass = useMemo(() => mixedActionClass(selectedItems), [selectedItems]);

  const toggleSelect = (requestId: string) => {
    if (isLoopback) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(requestId)) {
        next.delete(requestId);
      } else {
        next.add(requestId);
      }
      return next;
    });
  };

  const selectAllVisible = () => {
    if (isLoopback) return;
    const pendingVisible = displayedApprovals.filter((a) => a.status === "pending");
    if (selectedIds.size === pendingVisible.length && pendingVisible.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingVisible.map((a) => a.request_id)));
    }
  };

  // -------------------------------------------------------------------------
  // Handlers for Human Actions (Invariant 6)
  // -------------------------------------------------------------------------

  // Action: Permitir uma vez (choice: "once")
  const handleResolveOnce = async (item: Approval) => {
    if (isLoopback || isSubmitting) return;
    try {
      setIsSubmitting(true);
      setError(null);
      await resolveApproval(item.request_id, onceRequest(item));
      updateApprovalsState((prev) =>
        prev.map((a) =>
          a.request_id === item.request_id
            ? { ...a, status: "decided", decided_choice: "once" }
            : a
        )
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(item.request_id);
        return next;
      });
      setActionSuccessMsg(t("actionAllowedOnce", { bot: labelOf(item.bot) }));
      setTimeout(() => setActionSuccessMsg(null), 4000);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Action: Sempre permitir… (open draft modal)
  const openAlwaysModal = (item: Approval) => {
    if (isLoopback) return;
    const defaultLabel = `${t("allowOnceBtn")} ${
      item.pattern_keys?.[0] || item.command_redacted || item.description || t("defaultActionLabel")
    } ${item.bot}`;
    setAlwaysDraftLabel(defaultLabel);
    setAlwaysModalItem(item);
  };

  // Action: Confirm "Sempre permitir…" -> Sends choice: "once" + draft_rule
  // INVARIANT 6 / ADR-002: NEVER SENDS 'always'
  const handleConfirmAlways = async () => {
    if (!alwaysModalItem || isLoopback || isSubmitting) return;
    try {
      setIsSubmitting(true);
      setError(null);
      const label = alwaysDraftLabel.trim() || t("rulesTitleBot", { bot: labelOf(alwaysModalItem.bot) });
      await resolveApproval(alwaysModalItem.request_id, alwaysRequest(alwaysModalItem, label)); // once + draft, never 'always'

      updateApprovalsState((prev) =>
        prev.map((a) =>
          a.request_id === alwaysModalItem.request_id
            ? { ...a, status: "decided", decided_choice: "once" }
            : a
        )
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(alwaysModalItem.request_id);
        return next;
      });
      setAlwaysModalItem(null);
      setActionSuccessMsg(t("actionAlwaysResolved", { bot: labelOf(alwaysModalItem.bot) }));
      setTimeout(() => setActionSuccessMsg(null), 4000);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Action: Negar… (open modal with required reason)
  const openDenyModal = (item: Approval) => {
    if (isLoopback) return;
    setDenyReason("");
    setDenyModalItem(item);
  };

  // Action: Confirm Negar -> Reason is mandatory
  const handleConfirmDeny = async () => {
    if (!denyModalItem || isLoopback || isSubmitting) return;
    const denyBody = denyRequest(denyModalItem, denyReason);
    if (!denyBody) {
      setError(t("denyReasonRequired"));
      return;
    }
    try {
      setIsSubmitting(true);
      setError(null);
      const res = await resolveApproval(denyModalItem.request_id, denyBody);
      updateApprovalsState((prev) =>
        prev.map((a) =>
          a.request_id === denyModalItem.request_id
            ? { ...a, status: "decided", decided_choice: "deny" }
            : a
        )
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(denyModalItem.request_id);
        return next;
      });
      setDenyModalItem(null);
      setDenyReason("");
      sayDenied(t("actionDenied", { bot: labelOf(denyModalItem.bot) }), reasonState(res?.reason_delivered), [denyModalItem.request_id]);
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Action: Confirm Batch Resolution
  const handleConfirmBatch = async () => {
    if (selectedItems.length === 0 || isLoopback || isSubmitting || !batchConfirmMode) return;

    if (hasMismatchedActionClass) {
      setError(t("batchMismatchRefused"));
      return;
    }

    if (batchConfirmMode === "deny" && !batchDenyReason.trim()) {
      setError(t("batchDenyReasonRequired"));
      return;
    }

    const itemsPayload = batchItems(selectedItems, batchConfirmMode, batchDenyReason);
    if (!itemsPayload) return; // unreachable: both refusals are reported above

    try {
      setIsSubmitting(true);
      setError(null);
      const batch = await batchResolveApprovals({ items: itemsPayload });

      const resolvedIds = new Set(selectedItems.map((i) => i.request_id));
      updateApprovalsState((prev) =>
        prev.map((a) =>
          resolvedIds.has(a.request_id)
            ? { ...a, status: "decided", decided_choice: batchConfirmMode }
            : a
        )
      );
      setSelectedIds(new Set());
      setBatchConfirmMode(null);
      setBatchDenyReason("");
      const head = t("batchResolved", { count: selectedItems.length, choice: batchConfirmMode });
      if (batchConfirmMode === "deny") {
        // each decided row carries its own reason_delivered (b3); absent (an older backend) is "kept", never claimed delivered
        const done = batch?.approvals ?? [];
        sayDenied(head, reasonsState(done.length ? done.map((a) => a.reason_delivered) : [undefined]), done.map((a) => a.request_id));
      } else {
        setActionSuccessMsg(head);
        setTimeout(() => setActionSuccessMsg(null), 4000);
      }
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApiError = (err: unknown) => setError(approvalErrorText(err, t));

  // Helper to format timestamps
  const formatTimeAgo = (isoDate: string) => {
    try {
      const ms = Date.now() - new Date(isoDate).getTime();
      const mins = Math.max(0, Math.floor(ms / 60000));
      if (mins < 1) return t("timeNow");
      if (mins < 60) return t("timeAgoMins", { mins });
      const hrs = Math.floor(mins / 60);
      return t("timeAgoHours", { hrs });
    } catch {
      return isoDate;
    }
  };

  const formatExpiresIn = (isoDate: string) => {
    try {
      const ms = new Date(isoDate).getTime() - Date.now();
      if (ms <= 0) return t("timeExpired");
      const mins = Math.ceil(ms / 60000);
      if (mins < 60) return t("timeExpiresMins", { mins });
      const hrs = Math.floor(mins / 60);
      return t("timeExpiresHours", { hrs });
    } catch {
      return "";
    }
  };

  return (
    <div className="lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-hidden lb:bg-[var(--background)] lb:text-[var(--color-foreground)]">
      {/* Top Header / Toolbar */}
      <header className="lb:px-6 lb:pt-6 lb:pb-4 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:shrink-0">
        <div className="lb:flex lb:items-center lb:gap-2.5">
          <div className="lb:p-1.5 lb:rounded-xl lb:bg-[var(--color-primary)]/10 lb:text-[var(--color-primary)]">
            <CheckCircleIcon size={18} />
          </div>
          <div>
            <h1 className="lb-large-title">
              {t("approvalsTitle")}
            </h1>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {pendingCount === 1
                ? t("pendingActionCountOne")
                : t("pendingActionCountMany", { count: pendingCount })}
            </p>
          </div>
        </div>

        {/* Filter and Refresh Controls */}
        <div className="lb:flex lb:items-center lb:gap-2">
          {/* Bot Filter */}
          <div className="lb:flex lb:items-center lb:gap-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
            <FilterIcon size={12} />
            <select
              aria-label={t("filterByBot")}
              value={botFilter}
              onChange={(e) => setBotFilter(e.target.value)}
              className="lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]"
            >
              <option value="all">{t("filterAllBots")}</option>
              {bots.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.display?.label || b.name}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter */}
          <select
            aria-label={t("filterByStatus")}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as any)}
            className="lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]"
          >
            <option value="pending">{t("filterPending")}</option>
            <option value="all">{t("filterAll")}</option>
          </select>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={loadApprovalsList}
            disabled={loading}
            aria-label={t("refreshApprovals")}
            className="lb:p-1.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors disabled:lb:opacity-50"
          >
            <RefreshCwIcon size={14} className={loading ? "lb:motion-safe:animate-spin" : ""} />
          </button>
        </div>
      </header>

      {/* Notifications / Alerts */}
      {isLoopback && (
        <div
          role="alert"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2.5 lb:text-[13px] lb:shrink-0"
        >
          <ShieldAlertIcon size={16} className="lb:shrink-0" />
          <span>{t("loopbackWarningApprovals")}</span>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-destructive)]/15 lb:border-b lb:border-[var(--color-destructive)]/30 lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between lb:gap-2 lb:text-[13px] lb:shrink-0"
        >
          <div className="lb:flex lb:items-center lb:gap-2">
            <XIcon size={14} className="lb:shrink-0" />
            <span><ErrorNote error={error} /></span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="lb:p-1 lb:hover:opacity-80"
            aria-label={t("closeError")}
          >
            <XIcon size={12} />
          </button>
        </div>
      )}

      {actionSuccessMsg && (
        <div
          role="status"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-success)]/15 lb:border-b lb:border-[var(--color-success)]/30 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:shrink-0"
        >
          <CheckIcon size={14} className="lb:shrink-0" />
          <span>{actionSuccessMsg}</span>
        </div>
      )}

      {/* Batch Action Bar */}
      {selectedIds.size > 0 && (
        <div className="lb:px-4 lb:py-2 lb:bg-[var(--color-accent)] lb:border-b lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:gap-3 lb:shrink-0 lb:motion-safe:animate-in lb:fade-in">
          <div className="lb:flex lb:items-center lb:gap-3 lb:text-[13px]">
            <span className="lb:font-semibold lb:text-[var(--color-card-foreground)]">
              {t("selectedCount", { count: selectedIds.size })}
            </span>
            {hasMismatchedActionClass && (
              <span className="lb:text-[var(--color-destructive)] lb:text-xs lb:font-medium">
                {t("mismatchedClassWarning")}
              </span>
            )}
          </div>

          <div className="lb:flex lb:items-center lb:gap-2">
            <button
              type="button"
              disabled={isLoopback || hasMismatchedActionClass || isSubmitting}
              onClick={() => setBatchConfirmMode("once")}
              className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity disabled:lb:opacity-50 lb:rounded-full"
            >
              {t("allowSelectedOnce")}
            </button>
            <button
              type="button"
              disabled={isLoopback || hasMismatchedActionClass || isSubmitting}
              onClick={() => {
                setBatchDenyReason("");
                setBatchConfirmMode("deny");
              }}
              className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--color-destructive)] lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:motion-safe:transition-colors disabled:lb:opacity-50 lb:rounded-full"
            >
              {t("denySelected")}
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:rounded-full"
            >
              {t("clearSelection")}
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="lb:flex-1 lb:overflow-y-auto lb:p-4 lb:space-y-3 luvebot-scroll-container">
        {/* Select All Checkbox header if items exist */}
        {displayedApprovals.some((a) => a.status === "pending") && (
          <div className="lb:flex lb:items-center lb:justify-between lb:px-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
            <label className="lb:flex lb:items-center lb:gap-2 lb:cursor-pointer lb:select-none">
              <input
                type="checkbox"
                disabled={isLoopback}
                checked={
                  selectedIds.size > 0 &&
                  selectedIds.size ===
                    displayedApprovals.filter((a) => a.status === "pending").length
                }
                onChange={selectAllVisible}
                className="lb:rounded-lg lb:border-[var(--lb-separator)] lb:text-[var(--color-primary)] focus:lb:ring-[var(--color-primary)]"
              />
              <span>{t("selectAllPending")}</span>
            </label>
            <span>{t("totalCount", { count: displayedApprovals.length })}</span>
          </div>
        )}

        {/* Empty State */}
        {displayedApprovals.length === 0 && !loading && (
          <div
            data-testid="approvals-empty-state"
            className="lb:p-12 lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2 lb:border-dashed lb:border-[var(--lb-separator)] lb:rounded-2xl lb:bg-[var(--color-card)]/50"
          >
            <div className="lb:p-3 lb:rounded-full lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]">
              <CheckCircleIcon size={24} />
            </div>
            <h3 className="lb:text-[15px] lb:font-medium lb:text-[var(--color-card-foreground)]">
              {t("noPendingApprovalsTitle")}
            </h3>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm">
              {t("noPendingApprovalsDesc")}
            </p>
            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:max-w-sm lb:mt-1">
              {t("approvalsEmptyNextStep")}
            </p>
          </div>
        )}

        {/* Approval Cards List */}
        {displayedApprovals.map((item) => {
          const isSelected = selectedIds.has(item.request_id);
          const isPending = item.status === "pending";
          const botInfo = bots.find((b) => b.name === item.bot);

          return (
            <div
              key={item.request_id}
              data-testid={`approval-card-${item.request_id}`}
              className={`lb:rounded-2xl lb:bg-[var(--lb-fill)] lb:p-4 lb:flex lb:flex-col lb:gap-3 lb:motion-safe:transition-colors ${
                isSelected
                  ? "lb:border-[var(--color-primary)] lb:ring-1 lb:ring-[var(--color-primary)]"
                  : "lb:border-[var(--lb-separator)]"
              }  ${!isPending ? "lb:opacity-75" : ""}`}
            >
              {/* Card Header */}
              <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
                <div className="lb:flex lb:items-center lb:gap-2.5 lb:flex-wrap">
                  {/* Batch Selection Checkbox */}
                  {isPending && (
                    <input
                      type="checkbox"
                      disabled={isLoopback}
                      checked={isSelected}
                      onChange={() => toggleSelect(item.request_id)}
                      aria-label={t("selectApprovalAria", { id: item.request_id })}
                      className="lb:rounded-lg lb:border-[var(--lb-separator)] lb:text-[var(--color-primary)] focus:lb:ring-[var(--color-primary)] lb:cursor-pointer"
                    />
                  )}

                  {/* Bot Pill */}
                  <span className="lb:inline-flex lb:items-center lb:gap-2">
                    <Avatar name={botInfo?.display?.label || item.bot} avatar={botInfo?.display?.avatar} color={botInfo?.display?.color} size={28} />
                    <span className="lb-headline">{botInfo?.display?.label || item.bot}</span>
                  </span>

                  {/* Action / Tool Label */}
                  <span className="lb-caption">
                    {item.mechanism || item.surface || t("defaultActionLabel")}
                  </span>

                  {/* Created Relative Time */}
                  <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                    · {formatTimeAgo(item.created_at)}
                  </span>

                  {/* Expiration Tag */}
                  {isPending && item.expires_at && (
                    <span className="lb-pill lb-caption">
                      <ClockIcon size={12} />
                      {formatExpiresIn(item.expires_at)}
                    </span>
                  )}

                  {/* Status Badge if not pending */}
                  {!isPending && (
                    <span
                      className={`lb:text-xs lb:font-medium lb:px-1.5 lb:py-0.5 lb:rounded-lg ${
                        item.decided_choice === "once"
                          ? "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]"
                          : item.decided_choice === "deny"
                          ? "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]"
                          : "lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)]"
                      }`}
                    >
                      {item.decided_choice ? approvalDecisionLabel(item.decided_choice, t) : approvalStateLabel(item.status, t)}
                    </span>
                  )}
                </div>

                {/* Stored Digest (Honesty & Provenance - ADR H3) */}
                <div
                  title={t("digestVerifiedTitle", { digest: item.digest })}
                  className="lb:text-xs lb:font-mono lb:text-[var(--color-muted-foreground)] lb:select-all lb:shrink-0"
                >
                  {t("digestPrefix")} {item.digest.slice(0, 10)}...
                </div>
              </div>

              {/* Card Body: Command or Description */}
              <div className="lb:space-y-2">
                {item.command_redacted && (
                  // the same box as the conversation's approval card (InlineApproval): explicit colors, because a bare <code> took
                  // the dashboard's own code style (white on white in light, a white block in dark; guide photos 03/10)
                  <pre data-testid="approval-command" style={{ margin: 0, padding: "8px 10px", borderRadius: 10, background: "var(--color-background)",
                    color: "var(--color-foreground)", fontFamily: "var(--lb-mono)", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.command_redacted}</pre>
                )}

                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:leading-relaxed">
                  {approvalTitle(item, ruleLabel, t)}
                </p>

                {/* Pattern Keys / Match Info */}
                {item.pattern_keys && item.pattern_keys.length > 0 && (
                  <div className="lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap lb:text-xs lb:text-[var(--color-muted-foreground)]">
                    <span className="lb:font-medium">{t("patternsLabel")}</span>
                    {item.pattern_keys.map((pk) => (
                      <span
                        key={pk}
                        className="lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:font-mono lb:text-xs"
                      >
                        {pk}
                      </span>
                    ))}
                  </div>
                )}

                {/* Origin details */}
                <div className="lb:flex lb:items-center lb:gap-3 lb:text-xs lb:text-[var(--color-muted-foreground)]">
                  {item.run_id && (
                    <span>
                      {t("originRun")} <span className="lb:font-mono">{item.run_id}</span>
                    </span>
                  )}
                  {item.source === "transport" && (
                    <span>{t("originTransport")}{item.surface ? ` (${item.surface})` : ""}</span>
                  )}
                  {item.allowed_choices && item.allowed_choices.length > 0 && (
                    <span>
                      {t("nativeChoices")}{" "}
                      <span>{item.allowed_choices.map((c) => approvalChoiceLabel(c, t)).join(" · ")}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Card Footer: Action Buttons (Only when pending) */}
              {isPending && (
                <div className="lb:pt-2 lb:border-t lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:gap-2 lb:flex-wrap">
                  <div className="lb:flex lb:items-center lb:gap-2">
                    {/* Read-only parameters (D8: it said "Editar" but no route edits an approval) */}
                    <button
                      type="button"
                      onClick={() => setEditModalItem(item)}
                      className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors lb:rounded-full"
                    >
                      {t("viewParamsBtn")}
                    </button>
                  </div>

                  <div className="lb:flex lb:items-center lb:gap-2">
                    {/* Negar… Button */}
                    <button
                      type="button"
                      disabled={isLoopback || isSubmitting}
                      title={isLoopback ? t("disabledInLoopback") : undefined}
                      onClick={() => openDenyModal(item)}
                      className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--color-destructive)]/40 lb:text-[var(--color-destructive)] lb:hover:bg-[var(--color-destructive)]/10 lb:motion-safe:transition-colors disabled:lb:opacity-50 lb:rounded-full"
                    >
                      {t("denyBtn")}
                    </button>

                    {/* Sempre permitir… Button */}
                    <button
                      type="button"
                      disabled={isLoopback || isSubmitting}
                      title={isLoopback ? t("disabledInLoopback") : undefined}
                      onClick={() => openAlwaysModal(item)}
                      className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-card-foreground)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors disabled:lb:opacity-50 lb:rounded-full"
                    >
                      {t("alwaysAllowBtn")}
                    </button>

                    {/* Permitir uma vez Button */}
                    <button
                      type="button"
                      disabled={isLoopback || isSubmitting}
                      title={isLoopback ? t("disabledInLoopback") : undefined}
                      onClick={() => handleResolveOnce(item)}
                      className="lb:px-3 lb:py-1 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity disabled:lb:opacity-50 lb:rounded-full"
                    >
                      {t("allowOnceBtn")}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* -------------------------------------------------------------------- */}
      {/* Modal: "Sempre permitir…" (Draft Rule Creator)                        */}
      {/* INVARIANT 6: Explains that it only creates a draft and resolves once  */}
      {/* -------------------------------------------------------------------- */}
      {alwaysModalItem && (
        <div
          ref={alwaysModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="always-modal-title"
          className="lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4"
        >
          <div className="lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4">
            <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
              <h2
                id="always-modal-title"
                className="lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]"
              >
                {t("alwaysModalHeader")}
              </h2>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setAlwaysModalItem(null)}
                className="lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none"
              >
                <XIcon size={16} />
              </button>
            </div>

            <div className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:space-y-2">
              <p>{t("alwaysModalExplanationP1")}</p>
              <p className="lb:p-2.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)]">
                {t("alwaysModalExplanationP2", { bot: labelOf(alwaysModalItem.bot) })}
              </p>
            </div>

            <div>
              <label
                htmlFor="draft-rule-label"
                className="lb:block lb:text-[13px] lb:font-medium lb:text-[var(--color-card-foreground)] lb:mb-1"
              >
                {t("alwaysModalDraftLabel")}
              </label>
              <input
                id="draft-rule-label"
                type="text"
                value={alwaysDraftLabel}
                onChange={(e) => setAlwaysDraftLabel(e.target.value)}
                className="lb:w-full lb:px-3 lb:py-1.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)]"
              />
            </div>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setAlwaysModalItem(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("alwaysModalCancel")}
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleConfirmAlways}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("alwaysModalConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Modal: "Negar…" (Mandatory Reason Required)                          */}
      {/* Spec §4.8: "Negar…: motivo obrigatório; volta ao Bot"                */}
      {/* -------------------------------------------------------------------- */}
      {denyModalItem && (
        <div
          ref={denyModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="deny-modal-title"
          className="lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4"
        >
          <div className="lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4">
            <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
              <h2
                id="deny-modal-title"
                className="lb:text-[15px] lb:font-bold lb:text-[var(--color-destructive)]"
              >
                {t("denyModalTitleWithBot", { bot: labelOf(denyModalItem.bot) })}
              </h2>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setDenyModalItem(null)}
                className="lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("denyModalExplanation")}
            </p>

            <div>
              <label
                htmlFor="deny-reason-input"
                className="lb:block lb:text-[13px] lb:font-medium lb:text-[var(--color-card-foreground)] lb:mb-1"
              >
                {t("denyModalReasonLabel")}
              </label>
              <textarea
                id="deny-reason-input"
                rows={3}
                required
                value={denyReason}
                onChange={(e) => setDenyReason(e.target.value)}
                placeholder={t("denyModalPlaceholder")}
                className="lb:w-full lb:px-3 lb:py-2 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-destructive)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)]"
              />
              {!denyReason.trim() && (
                <span className="lb:text-xs lb:text-[var(--color-destructive)]">
                  {t("denyReasonEmpty")}
                </span>
              )}
            </div>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setDenyModalItem(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("alwaysModalCancel")}
              </button>
              <button
                type="button"
                disabled={!denyReason.trim() || isSubmitting}
                onClick={handleConfirmDeny}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground)] lb:hover:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("denyModalConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Modal: read-only parameters of the request                          */}
      {/* -------------------------------------------------------------------- */}
      {editModalItem && (
        <div
          ref={editModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-modal-title"
          className="lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4"
        >
          <div className="lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4">
            <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
              <h2
                id="edit-modal-title"
                className="lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]"
              >
                {t("editModalParametersTitle")}
              </h2>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setEditModalItem(null)}
                className="lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("editModalWarning")}
            </p>

            <div className="lb:rounded-xl lb:bg-[var(--background)] lb:p-3 lb:border-[var(--lb-separator)] lb:font-mono lb:text-[13px] lb:overflow-x-auto">
              <div>
                <strong>{t("editModalActionLabel")}</strong> {editModalItem.mechanism}
              </div>
              {editModalItem.command_redacted && (
                <div className="lb:mt-1">
                  <strong>{t("editModalCommandLabel")}</strong> {editModalItem.command_redacted}
                </div>
              )}
              {editModalItem.description && (
                <div className="lb:mt-1">
                  <strong>{t("editModalDetailsLabel")}</strong> {editModalItem.description}
                </div>
              )}
            </div>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setEditModalItem(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("editModalClose")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Modal: Batch Confirmation Dialog                                     */}
      {/* Invariant 6: Batch requires explicit confirmation                    */}
      {/* -------------------------------------------------------------------- */}
      {batchConfirmMode && (
        <div
          ref={batchModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="batch-confirm-title"
          className="lb:fixed lb:inset-0 lb:z-50 lb:bg-black/60 lb:backdrop-blur-xs lb:flex lb:items-center lb:justify-center lb:p-4"
        >
          <div className="lb:w-full lb:max-w-md lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)] lb:text-[var(--color-card-foreground)] lb:p-5 lb:shadow-xl lb:space-y-4">
            <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
              <h2
                id="batch-confirm-title"
                className="lb:text-[15px] lb:font-bold lb:text-[var(--color-card-foreground)]"
              >
                {batchConfirmMode === "once"
                  ? t("batchConfirmOnceTitle", { count: selectedItems.length })
                  : t("batchConfirmDenyTitle", { count: selectedItems.length })}
              </h2>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setBatchConfirmMode(null)}
                className="lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none"
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("batchConfirmExplanation", { count: selectedItems.length })}
            </p>

            {batchConfirmMode === "deny" && (
              <div>
                <label
                  htmlFor="batch-deny-reason"
                  className="lb:block lb:text-[13px] lb:font-medium lb:text-[var(--color-card-foreground)] lb:mb-1"
                >
                  {t("batchDenyReasonLabel")}
                </label>
                <textarea
                  id="batch-deny-reason"
                  rows={2}
                  required
                  value={batchDenyReason}
                  onChange={(e) => setBatchDenyReason(e.target.value)}
                  placeholder={t("batchDenyPlaceholder")}
                  className="lb:w-full lb:px-3 lb:py-2 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-destructive)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-destructive)]"
                />
              </div>
            )}

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setBatchConfirmMode(null)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("alwaysModalCancel")}
              </button>
              <button
                type="button"
                disabled={
                  isSubmitting || (batchConfirmMode === "deny" && !batchDenyReason.trim())
                }
                onClick={handleConfirmBatch}
                className={`lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:outline-none lb:rounded-full ${
                  batchConfirmMode === "once"
                    ? "lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 focus-visible:lb:ring-[var(--color-primary)]"
                    : "lb:bg-[var(--color-destructive)] lb:text-[var(--color-destructive-foreground)] lb:hover:opacity-90 focus-visible:lb:ring-[var(--color-destructive)]"
                }`}
              >
                {t("batchConfirmBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ApprovalsInbox;
