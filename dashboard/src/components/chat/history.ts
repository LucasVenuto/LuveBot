// dashboard/src/components/chat/history.ts
// The conversation's past turns from the B1 history (contract v0.4 §B1), so a reload shows what was said instead of
// the Bot's introduction. The text reaches the transcript through the audited reducer (lib/stream), never as HTML.

import { reduce, initialTranscript } from "../../lib/stream";
import type { HistoryMessage, HistorySession, MessageRow } from "../../api/types";
import type { Turn } from "./useConversation";
import { deliveryView, dispatchedId, dispatchedGoal, DELEGATE_TOOL } from "../conversation/delegate";
import { TERMINAL_TOOL } from "../conversation/derive";
import { maskedOfRow } from "../transcript/masked";

/** The session the conversation continues: the newest conversation (or the Bot's introduction), never a channel or routine. */
export function latestConversation(sessions: readonly HistorySession[]): HistorySession | null {
  const mine = sessions.filter((s) => s.kind === "conversation" || s.kind === "introduction");
  const when = (s: HistorySession) => s.last_active ?? s.started_at ?? 0;
  return mine.reduce<HistorySession | null>((best, s) => (!best || when(s) > when(best) ? s : best), null);
}

/** The fixed frame LuveBot starts the steer of a denial with (backend/approvals_native.py `deny_steer_text`; a test reads that function and pins this constant). A steer that reaches the transcript AFTER the run's last answer is stored as a
 *  plain `user` row with no display kind, and only this frame tells it from the person's own words (contract v0.11 section 8, A-209). */
export const STEER_FRAME = "[luvebot:deny] ";

/** The saved row of a message (its durable id and marks), or none when the id is not one (a message Hermes has not stored yet). */
const rowOf = (m: HistoryMessage): MessageRow | undefined => {
  const id = typeof m.id === "number" ? m.id : /^[0-9]{1,15}$/.test(String(m.id)) ? Number(m.id) : 0;
  return Number.isSafeInteger(id) && id > 0 ? { id, reactions: m.reactions ?? [] } : undefined;
};

/** One turn per person's message, with the Bot's replies after it. A reply before any message (the introduction)
 *  is a turn with no person's bubble. Of the tool rows, only a terminal's (its output, so the work panel's Terminal still shows what
 *  ran; the command itself is not in the history, whose calls carry names only) and a background delegation are rebuilt. */
export function turnsFromHistory(messages: readonly HistoryMessage[], firstId = -1_000_000): Turn[] {
  const turns: Turn[] = [];
  let id = firstId;
  let sealed = false;   // the span of a skill draft ended at a row of a person or an event (A-183): what follows is another turn, never part of the draft
  const open = (user: string, aboutPage?: string): Turn => {
    sealed = false;
    const turn: Turn = { id: id++, user, state: initialTranscript(), stopping: false, errors: [], confirmed: "completed", ...(aboutPage ? { aboutPage } : {}) };
    turns.push(turn);
    return turn;
  };
  /** Where a row that belongs to "the turn so far" goes: the last turn, or a NEW one when the last turn is a skill draft whose span a `user` row closed. */
  const tail = (): Turn => (sealed || !turns.length ? open("") : turns[turns.length - 1]);
  for (const m of messages) {
    // The span of a skill draft runs from its placeholder row to the NEXT `user` row of ANY kind (typed, steer, hidden, a helper's delivery, a channel contact) or the end: such a row closes it, even the ones
    // that never open a turn of their own (a hidden row, a delivery), so a reply that comes after them is not the draft's.
    if (m.role === "user" && m.display_kind !== "skill_draft" && turns[turns.length - 1]?.skillDraft) sealed = true;
    if (m.display_kind === "hidden") continue;
    // A steer (a message sent INTO a run: a denial's reason, a worker's note, a parent model's guidance) is stored as a `user` row, but nobody typed it: never a person's bubble and never a turn of its own (its place in the
    // history is between a message and the answer to it, so a turn opened here would take that answer away from the message). It is NOT hidden either: the model reads it as the user's words, so the person sees it, as a
    // note INSIDE the turn (contract v0.11 section 8, A-209). The other shape of the same send, a `user` row with no kind that starts with the frame, is the same note. It still closed a skill draft's span, above.
    if (m.role === "user" && (m.display_kind === "steer" || (!m.display_kind && (m.text ?? "").startsWith(STEER_FRAME)))) {
      const turn = tail();
      turn.steers = [...(turn.steers ?? []), m.text ?? ""];
      continue;
    }
    const masked = m.role === "tool" ? maskedOfRow(m.masked) : undefined;
    if (masked) {
      // a result that a mask of the server replaced (BA-7, A-287): a card that draws the words of its KIND in the person's language (and the shown path and size for a reader); `text` is only the fallback of a build with no words for it
      const turn = tail();
      turn.state = { ...turn.state, items: [...turn.state.items, { kind: "tool", id: `h${m.id}`, name: m.tool_name || "?", status: "done", preview: m.text, masked }] };
      continue;
    }
    if (m.role === "tool" && m.tool_name === DELEGATE_TOOL && dispatchedId(m.text)) {
      // the only tool row rebuilt: a delegation sent to the background, so the reopened conversation still shows its helper
      const turn = tail();
      turn.state = { ...turn.state, items: [...turn.state.items, { kind: "tool", id: `h${m.id}`, name: DELEGATE_TOOL, status: "done",
        preview: dispatchedGoal(m.text) ?? "", result: m.text }] };
      continue;
    }
    if (m.role === "tool" && m.tool_name === TERMINAL_TOOL) {
      const turn = tail();
      turn.state = { ...turn.state, items: [...turn.state.items, { kind: "tool", id: `h${m.id}`, name: TERMINAL_TOOL, status: "done", preview: "", result: m.text }] };
      continue;
    }
    if (m.role === "tool") continue;
    if (m.display_kind === "async_delegation_complete") {
      // a background helper's result, delivered to the session (gateway/wake.py): Hermes stores it as a "user" row, but the
      // person never said it. It is the helper's card, completed, never a person's bubble nor a new turn.
      const turn = tail();
      const v = deliveryView(m.text, m.display_metadata);
      // the helper's card from the dispatched call in this turn takes the result; with none, a card of its own
      const call = turn.state.items.find((i) => i.kind === "tool" && i.name === DELEGATE_TOOL && v.id && dispatchedId(i.result) === v.id);
      turn.state = { ...turn.state, items: [...turn.state.items, { kind: "subagent", id: `d${m.id}`, subagentId: v.id ?? String(m.id),
        goal: call && call.kind === "tool" ? call.preview ?? "" : "", status: v.status, summary: v.summary }] };
      continue;
    }
    if (m.display_kind === "skill_draft") { const draft = open(""); draft.skillDraft = true; draft.botMessages = 0; continue; }   // the hidden draft turn (A-175): a row with no text, never a person's bubble; the Bot's answer that follows is the draft
    if (m.role === "user") { const turn = open(m.text, m.page_ref?.slug); turn.userRow = rowOf(m); continue; }
    if (!m.text) continue;
    const turn = tail();
    if (turn.skillDraft) turn.botMessages = (turn.botMessages ?? 0) + 1;   // the card needs to know it was ONE message: the reducer below merges them into one
    turn.replyRow = rowOf(m);   // the last of the Bot's rows answers the turn: the one a reaction or a thread is hung on
    const sep = turn.state.items.length ? "\n\n" : "";
    turn.state = reduce(turn.state, { event: "message.delta", data: { delta: sep + m.text } });
    if (m.display_kind === "failed_turn") turn.confirmed = "failed";
  }
  for (const turn of turns) {
    turn.state = reduce(turn.state, { event: turn.confirmed === "failed" ? "run.failed" : "run.completed", data: {} });
  }
  return turns;
}

/** The rows of the turns drawn live (they have no id yet): the history read once more, its turns matched from the END by what the person
 *  said. A turn whose words do not match, or that Hermes has not stored, gets nothing: no reaction is offered over a guess. */
export function rowsOfLive(live: readonly Turn[], messages: readonly HistoryMessage[]): Map<number, { userRow?: MessageRow; replyRow?: MessageRow }> {
  const past = turnsFromHistory(messages);
  const found = new Map<number, { userRow?: MessageRow; replyRow?: MessageRow }>();
  let j = past.length - 1;
  for (let i = live.length - 1; i >= 0 && j >= 0; i--) {
    const mine = live[i];
    if (mine.userRow || mine.replyRow) break;                              // the older turns came from the history already
    if (mine.user.trim() === past[j].user.trim()) {
      const theirs = past[j--];
      if (mine.confirmed === "completed" && (theirs.userRow || theirs.replyRow)) found.set(mine.id, { userRow: theirs.userRow, replyRow: theirs.replyRow });
    } else if (mine.confirmed === "completed") break;                      // a finished turn the history does not show the same way: stop, never guess
    // a turn still running (or not stored yet) is not in the history: the ones before it are matched past it
  }
  return found;
}
