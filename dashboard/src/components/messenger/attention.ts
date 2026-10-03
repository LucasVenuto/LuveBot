// dashboard/src/components/messenger/attention.ts
// One attention state per Bot for the contact list (spec 4.1/6, Grok Bot §1.4), from real fields only.
// Priority: what needs a human first, then what is broken, then live work, then news.
// Unread never hides an error or a pause (the old badge let it).

import type { Bot } from "../../api/types";

export type Attention = "needs_you" | "error" | "offline" | "paused" | "working" | "unread" | "idle";

/** Contract v0 sends `unread` as a boolean; v0.4 (B2) as `{count, …}`. An empty count is not unread. */
export function hasUnread(unread: unknown): boolean {
  if (unread && typeof unread === "object") return Number((unread as { count?: unknown }).count) > 0;
  return unread === true;
}

/** `pendingApprovals`: this Bot's pending approvals, which can exist while its status is not waiting_approval. */
export function attention(bot: { status: Bot["status"]; unread?: unknown }, pendingApprovals = 0): Attention {
  if (bot.status === "waiting_approval" || pendingApprovals > 0) return "needs_you";
  if (bot.status === "error") return "error";
  if (bot.status === "offline") return "offline";
  if (bot.status === "paused") return "paused";
  if (bot.status === "working") return "working";
  if (hasUnread(bot.unread)) return "unread";
  return "idle";
}
