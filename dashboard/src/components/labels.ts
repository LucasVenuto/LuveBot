// dashboard/src/components/labels.ts
// Spoken names for states that arrive from the backend as codes (never shown raw: they are English data).
// An unknown code is shown as it came, so a new backend state is visible rather than hidden.

import type { TranslationKey } from "../i18n";

const HANDOFF: Record<string, TranslationKey> = {
  triage: "handoffStateTriage", ready: "handoffStateReady", running: "handoffStateRunning", blocked: "handoffStateBlocked",
  review: "handoffStateReview", done: "handoffStateDone", cancelled: "handoffStateCancelled",
  // the handoff's own states (backend/handoffs.py task_state), next to the Kanban columns some room events carry
  open: "handoffStateOpen", needs_review: "handoffStateTriage", completed: "handoffStateDone",
};
const SIM_REASON: Record<string, TranslationKey> = {  // backend/rules.py ReasonCode
  default_allow: "simReasonDefaultAllow", single_rule: "simReasonSingleRule", ask_beats_allow: "simReasonAskBeatsAllow",
  stricter_wins: "simReasonStricterWins", noncanonical_action: "simReasonNoncanonical",
};
const BOT: Record<string, TranslationKey> = {
  idle: "statusIdleLabel", working: "statusWorkingLabel", waiting_approval: "statusNeedsYouLabel",
  paused: "statusPausedLabel", error: "statusErrorLabel", offline: "statusOfflineLabel",
};
const SUBAGENT: Record<string, TranslationKey> = { running: "statusWorking", completed: "statusCompleted", failed: "statusFailed", timeout: "subagentTimeout", unknown: "subagentUnknown", background: "subagentBackground", background_late: "subagentBackgroundLate" };
const APPROVAL: Record<string, TranslationKey> = {
  pending: "approvalStatePending", decided: "approvalStateDecided", consumed: "approvalStateConsumed", expired: "approvalStateExpired", stale: "approvalStateStale",
};
const DECISION: Record<string, TranslationKey> = { once: "approvalDecidedOnce", deny: "approvalDecidedDeny" };
const CHOICE: Record<string, TranslationKey> = { once: "approvalChoiceOnce", session: "approvalChoiceSession", always: "approvalChoiceAlways", deny: "approvalChoiceDeny" };
const ROUTINE_RUN: Record<string, TranslationKey> = { success: "statusSuccess", error: "statusError", running: "routineRunRunning" };

const pick = (table: Record<string, TranslationKey>) => (code: string | undefined | null, t: (k: TranslationKey) => string) =>
  code && Object.prototype.hasOwnProperty.call(table, code) ? t(table[code]) : code ?? "";

export const handoffStateLabel = pick(HANDOFF);
export const botStatusLabel = pick(BOT);
export const subagentStatusLabel = pick(SUBAGENT);
export const approvalStateLabel = pick(APPROVAL);
export const approvalDecisionLabel = pick(DECISION);
export const routineRunStatusLabel = pick(ROUTINE_RUN);
export const approvalChoiceLabel = pick(CHOICE);
export const simReasonLabel = pick(SIM_REASON);

/** A time from the backend: a number is epoch SECONDS (Hermes's SessionDB, as AgentPanel reads it); a string is ISO. */
export function epochDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A duration in seconds as a person reads it ("6,5 s", "2 min 5 s", "1 h 3 min"); null when there is none. */
export function durationText(seconds: number | null | undefined, locale: string, t: (k: TranslationKey, v?: Record<string, string | number>) => string): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return t("durationSeconds", { n: seconds.toLocaleString(locale === "pt" ? "pt-BR" : "en-US", { maximumFractionDigits: 1 }) });
  const whole = Math.round(seconds);
  if (whole < 3600) return t("durationMinutes", { m: Math.floor(whole / 60), s: whole % 60 });
  return t("durationHours", { h: Math.floor(whole / 3600), m: Math.floor((whole % 3600) / 60) });
}

/** An activity's title as a person reads it. Without a human title the backend sends null (older backends sent English
 *  placeholders from backend/activity.py: "Conversation run", "Routine", "Routine <job id>", "Task"); each reads by its kind. */
const UNTITLED: Record<string, TranslationKey> = {
  run: "activityRunTitle", routine_run: "activityRoutineRunTitle", routine_due: "activityRoutineDueTitle", task: "activityTaskTitle",
};
export function activityTitle(item: { kind: string; title?: string | null; links?: { job_id?: string } }, t: (key: TranslationKey) => string): string {
  const key = UNTITLED[item.kind];
  const legacy = item.title === "Conversation run" || item.title === "Routine" || item.title === "Task"
    || (item.kind === "routine_run" && !!item.links?.job_id && item.title === `Routine ${item.links.job_id}`);
  if (key && (!item.title || legacy)) return t(key);
  return item.title ?? "";
}
