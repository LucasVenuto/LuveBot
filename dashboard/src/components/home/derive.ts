// dashboard/src/components/home/derive.ts
// Pure derivations for the home feed (spec 4.2). Only reshapes backend data; never fills a gap with invented values.

import type { ActivityItem, Approval, Bot, Handoff, Routine } from "../../api/types";

export interface NeedsYouItem {
  id: string;
  kind: "approval" | "handoff";
  bot: string;
  title: string;
  detail?: string;
  rawApproval?: Approval;
  rawHandoff?: Handoff;
}

/** Pending approvals, then handoffs waiting for a human (needs_review, triage or review). */
export function needsYou(approvals: readonly Approval[] = [], handoffs: readonly Handoff[] = []): NeedsYouItem[] {
  return [
    ...approvals.filter((a) => a.status === "pending").map((a): NeedsYouItem => ({
      id: a.request_id, kind: "approval", bot: a.bot,
      // never the digest: it is a hash the human cannot read
      title: a.description || a.command_redacted || a.request_id,
      detail: a.description && a.command_redacted ? a.command_redacted : undefined, rawApproval: a,
    })),
    ...handoffs.filter((h) => h.needs_review || h.state === "triage" || h.state === "review").map((h): NeedsYouItem => ({
      id: h.id, kind: "handoff", bot: h.from,
      title: `${h.from} → ${h.to}: ${h.title}`,
      detail: h.body, rawHandoff: h,
    })),
  ];
}

export const inProgress = (items: readonly ActivityItem[] = []) =>
  items.filter((i) => i.status === "running" || i.status === "waiting_approval");

export const completed = (items: readonly ActivityItem[] = []) => items.filter((i) => i.status === "done");

export const upcomingRoutines = (routines: readonly Routine[] = [], max = 5) =>
  routines.filter((r) => r.enabled && r.state !== "paused").slice(0, max);

export const activeBotCount = (bots: readonly Bot[]) =>
  bots.filter((b) => b.status !== "offline" && b.status !== "paused").length;
