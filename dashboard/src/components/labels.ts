// dashboard/src/components/labels.ts
// Spoken names for states that arrive from the backend as codes (never shown raw: they are English data).
// An unknown code is shown as it came, so a new backend state is visible rather than hidden.

import type { TranslationKey } from "../i18n";

const HANDOFF: Record<string, TranslationKey> = {
  triage: "handoffStateTriage", ready: "handoffStateReady", running: "handoffStateRunning", blocked: "handoffStateBlocked",
  review: "handoffStateReview", done: "handoffStateDone", cancelled: "handoffStateCancelled",
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
