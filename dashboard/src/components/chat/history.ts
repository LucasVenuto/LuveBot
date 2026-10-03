// dashboard/src/components/chat/history.ts
// The conversation's past turns from the B1 history (contract v0.4 §B1), so a reload shows what was said instead of
// the Bot's introduction. The text reaches the transcript through the audited reducer (lib/stream), never as HTML.

import { reduce, initialTranscript } from "../../lib/stream";
import type { HistoryMessage, HistorySession } from "../../api/types";
import type { Turn } from "./useConversation";
import { deliveryView, dispatchedId, dispatchedGoal, DELEGATE_TOOL } from "../conversation/delegate";

/** The session the conversation continues: the newest conversation (or the Bot's introduction), never a channel or routine. */
export function latestConversation(sessions: readonly HistorySession[]): HistorySession | null {
  const mine = sessions.filter((s) => s.kind === "conversation" || s.kind === "introduction");
  const when = (s: HistorySession) => s.last_active ?? s.started_at ?? 0;
  return mine.reduce<HistorySession | null>((best, s) => (!best || when(s) > when(best) ? s : best), null);
}

/** One turn per person's message, with the Bot's replies after it. A reply before any message (the introduction)
 *  is a turn with no person's bubble. Tool rows are not rebuilt (only their names exist in history). */
export function turnsFromHistory(messages: readonly HistoryMessage[], firstId = -1_000_000): Turn[] {
  const turns: Turn[] = [];
  let id = firstId;
  const open = (user: string, aboutPage?: string): Turn => {
    const turn: Turn = { id: id++, user, state: initialTranscript(), stopping: false, errors: [], confirmed: "completed", ...(aboutPage ? { aboutPage } : {}) };
    turns.push(turn);
    return turn;
  };
  for (const m of messages) {
    if (m.display_kind === "hidden") continue;
    if (m.role === "tool" && m.tool_name === DELEGATE_TOOL && dispatchedId(m.text)) {
      // the only tool row rebuilt: a delegation sent to the background, so the reopened conversation still shows its helper
      const turn = turns[turns.length - 1] ?? open("");
      turn.state = { ...turn.state, items: [...turn.state.items, { kind: "tool", id: `h${m.id}`, name: DELEGATE_TOOL, status: "done",
        preview: dispatchedGoal(m.text) ?? "", result: m.text }] };
      continue;
    }
    if (m.role === "tool") continue;
    if (m.display_kind === "async_delegation_complete") {
      // a background helper's result, delivered to the session (gateway/wake.py): Hermes stores it as a "user" row, but the
      // person never said it. It is the helper's card, completed, never a person's bubble nor a new turn.
      const turn = turns[turns.length - 1] ?? open("");
      const v = deliveryView(m.text, m.display_metadata);
      // the helper's card from the dispatched call in this turn takes the result; with none, a card of its own
      const call = turn.state.items.find((i) => i.kind === "tool" && i.name === DELEGATE_TOOL && v.id && dispatchedId(i.result) === v.id);
      turn.state = { ...turn.state, items: [...turn.state.items, { kind: "subagent", id: `d${m.id}`, subagentId: v.id ?? String(m.id),
        goal: call && call.kind === "tool" ? call.preview ?? "" : "", status: v.status, summary: v.summary }] };
      continue;
    }
    if (m.role === "user") { open(m.text, m.page_ref?.slug); continue; }
    if (!m.text) continue;
    const turn = turns[turns.length - 1] ?? open("");
    const sep = turn.state.items.length ? "\n\n" : "";
    turn.state = reduce(turn.state, { event: "message.delta", data: { delta: sep + m.text } });
    if (m.display_kind === "failed_turn") turn.confirmed = "failed";
  }
  for (const turn of turns) {
    turn.state = reduce(turn.state, { event: turn.confirmed === "failed" ? "run.failed" : "run.completed", data: {} });
  }
  return turns;
}
