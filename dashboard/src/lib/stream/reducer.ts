// dashboard/src/lib/stream/reducer.ts
// Pure reducer: frames (both Hermes vocabularies + luvebot.*) -> transcript state (contract §6, A-4/A-5/A-6).
// Unknown events return the same state object. Text in the state is data: render it with <Markdown> or as text.

import type { Frame } from "./sse";

export type Surface = "run" | "chat";
export type Status = "idle" | "running" | "waiting_approval" | "completed" | "cancelled" | "failed";
export type SubagentStatus = "running" | "completed" | "failed" | "timeout" | "unknown";

export type SubagentItem = {
  kind: "subagent";
  id: string;
  subagentId: string;
  goal: string;
  status: SubagentStatus;
  summary?: string;
  model?: string;
  depth?: number;
  taskIndex?: number;
  taskCount?: number;
  parentId?: string;
  durationS?: number;
  costCents?: number;
  costUsd?: number;
  childSessionId?: string;
  tokens?: { input?: number; output?: number; reasoning?: number };
  filesRead?: string[];
  filesWritten?: string[];
  outputTail?: string;
};

export type Item =
  | { kind: "message"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }            // render collapsed behind "Pensamento" (A-6)
  | { kind: "commentary"; id: string; text: string }
  | {
      kind: "tool"; id: string; messageId?: string; name: string; status: "running" | "done" | "error";
      preview?: string; args?: Record<string, unknown>; durationS?: number; result?: string;
      ambiguous?: boolean; // another call of the same tool was open at once: Hermes has no call id (A-5)
    }
  | { kind: "approval"; id: string; requestId: string; frame: Record<string, any> } // read-only in v0
  | { kind: "error"; id: string; code?: string; message: string }
  | SubagentItem;

export type TranscriptState = {
  surface: Surface | null;
  status: Status;
  items: Item[];
  subagents?: Record<string, SubagentItem>;
  runId?: string;
  sessionId?: string;
  usage?: Record<string, number>;
  lastSeq: number;
  closeReason?: string; // luvebot.stream.close
  done: boolean;        // chat `done` or luvebot.stream.close seen
};

export const initialTranscript = (): TranscriptState => ({
  surface: null,
  status: "idle",
  items: [],
  subagents: {},
  lastSeq: -1,
  done: false,
});

const RUN_ONLY = new Set(["message.delta", "reasoning.available", "message.interim", "subagent.start", "subagent.complete"]);
const CHAT_ONLY = new Set(["run.started", "message.started", "assistant.delta", "assistant.commentary", "assistant.completed", "tool.progress", "done"]);
const KNOWN = new Set([...RUN_ONLY, ...CHAT_ONLY, "tool.started", "tool.completed", "tool.failed", "approval.request", "run.completed", "run.cancelled", "run.failed"]);

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const TERMINAL: Status[] = ["completed", "cancelled", "failed"];

function withItems(s: TranscriptState, items: Item[], patch: Partial<TranscriptState> = {}): TranscriptState {
  return { ...s, ...patch, items };
}

/** Appends text to the trailing item of `kind` (same message on chat), else opens a new one. */
function appendText(s: TranscriptState, kind: "message" | "reasoning", text: string, patch: Partial<TranscriptState>): TranscriptState {
  const last = s.items[s.items.length - 1];
  if (last && last.kind === kind) {
    return withItems(s, [...s.items.slice(0, -1), { ...last, text: last.text + text }], patch);
  }
  return withItems(s, [...s.items, { kind, id: `i${s.items.length}`, text }], patch);
}

function startTool(s: TranscriptState, f: Record<string, any>, patch: Partial<TranscriptState>): TranscriptState {
  const name = str(f.tool_name) ?? str(f.tool) ?? "?";
  const messageId = str(f.message_id);
  const twin = s.items.some((i) => i.kind === "tool" && i.status === "running" && i.name === name && i.messageId === messageId);
  const items = twin
    ? s.items.map((i) => (i.kind === "tool" && i.status === "running" && i.name === name && i.messageId === messageId ? { ...i, ambiguous: true } : i))
    : s.items;
  const tool: Item = {
    kind: "tool", id: `i${items.length}`, messageId, name, status: "running",
    preview: str(f.preview), args: f.args && typeof f.args === "object" ? f.args : undefined, ambiguous: twin || undefined,
  };
  return withItems(s, [...items, tool], patch);
}

/** §6.5: a completion closes the OLDEST open start of the same tool (and message_id on chat), FIFO. */
function finishTool(s: TranscriptState, event: string, f: Record<string, any>, patch: Partial<TranscriptState>): TranscriptState {
  const name = str(f.tool_name) ?? str(f.tool) ?? "?";
  const messageId = str(f.message_id);
  const status = event === "tool.failed" || f.error === true ? "error" : "done";
  const preview = str(f.preview);
  const fields = {
    status: status as "done" | "error",
    durationS: typeof f.duration === "number" ? f.duration : undefined,
    result: preview, // run surface: JSON result; chat surface: null (A-11, card shows only "done")
  };
  const idx = s.items.findIndex((i) => i.kind === "tool" && i.status === "running" && i.name === name && i.messageId === messageId);
  if (idx < 0) { // completion with no open start (reconnect): still show it
    return withItems(s, [...s.items, { kind: "tool", id: `i${s.items.length}`, messageId, name, preview, ...fields }], patch);
  }
  const items = s.items.slice();
  const t = items[idx] as Extract<Item, { kind: "tool" }>;
  items[idx] = { ...t, ...fields, preview: t.preview ?? preview };
  return withItems(s, items, patch);
}

// Hermes run surface subagent frames:
// https://github.com/NousResearch/hermes-agent/blob/f8489405/gateway/platforms/api_server_runs.py#L79
// Keyed by subagent_id, fallback delegation_id:task_index (v0.4 B5).
function subagentKey(f: Record<string, any>): string | undefined {
  if (typeof f.subagent_id === "string" && f.subagent_id) return f.subagent_id;
  if (typeof f.delegation_id === "string" && f.delegation_id) {
    const idx = f.task_index !== undefined ? String(f.task_index) : "0";
    return `${f.delegation_id}:${idx}`;
  }
  return undefined;
}

function startSubagent(s: TranscriptState, f: Record<string, any>, patch: Partial<TranscriptState>): TranscriptState {
  const key = subagentKey(f);
  if (!key) return s;

  const goal = str(f.goal) ?? str(f.preview) ?? "";
  const model = str(f.model);
  const depth = typeof f.depth === "number" ? f.depth : undefined;
  const taskIndex = typeof f.task_index === "number" ? f.task_index : undefined;
  const taskCount = typeof f.task_count === "number" ? f.task_count : undefined;
  const parentId = str(f.parent_id);
  const childSessionId = str(f.child_session_id);

  const idx = s.items.findIndex((i) => i.kind === "subagent" && i.subagentId === key);
  if (idx >= 0) {
    // Duplicate start frame: merge fields without creating duplicate card
    const existing = s.items[idx] as SubagentItem;
    const updated: SubagentItem = {
      ...existing,
      goal: goal || existing.goal,
      model: model ?? existing.model,
      depth: depth ?? existing.depth,
      taskIndex: taskIndex ?? existing.taskIndex,
      taskCount: taskCount ?? existing.taskCount,
      parentId: parentId ?? existing.parentId,
      childSessionId: childSessionId ?? existing.childSessionId,
    };
    const items = s.items.slice();
    items[idx] = updated;
    const subagents = { ...s.subagents, [key]: updated };
    return withItems(s, items, { ...patch, subagents });
  }

  const item: SubagentItem = {
    kind: "subagent",
    id: `i${s.items.length}`,
    subagentId: key,
    goal,
    status: "running",
    model,
    depth,
    taskIndex,
    taskCount,
    parentId,
    childSessionId,
  };
  const subagents = { ...s.subagents, [key]: item };
  return withItems(s, [...s.items, item], { ...patch, subagents });
}

function completeSubagent(s: TranscriptState, f: Record<string, any>, patch: Partial<TranscriptState>): TranscriptState {
  const key = subagentKey(f);
  if (!key) return s;

  const rawStatus = str(f.status);
  const status: SubagentStatus = rawStatus === "failed" ? "failed" : rawStatus === "timeout" ? "timeout" : "completed";
  const summary = str(f.summary) ?? str(f.preview);
  const durationS = typeof f.duration_seconds === "number" ? f.duration_seconds : typeof f.duration === "number" ? f.duration : undefined;
  const costCents = typeof f.cost_cents === "number" ? f.cost_cents : undefined;
  const costUsd = typeof f.cost_usd === "number" ? f.cost_usd : typeof f.cost_cents === "number" ? f.cost_cents / 100 : undefined;
  const childSessionId = str(f.child_session_id);
  const outputTail = str(f.output_tail);
  const filesRead = Array.isArray(f.files_read) ? f.files_read.filter((x): x is string => typeof x === "string") : undefined;
  const filesWritten = Array.isArray(f.files_written) ? f.files_written.filter((x): x is string => typeof x === "string") : undefined;
  const tokens =
    typeof f.input_tokens === "number" || typeof f.output_tokens === "number" || typeof f.reasoning_tokens === "number"
      ? { input: f.input_tokens, output: f.output_tokens, reasoning: f.reasoning_tokens }
      : undefined;

  const idx = s.items.findIndex((i) => i.kind === "subagent" && i.subagentId === key);
  if (idx < 0) {
    // Complete without prior start frame (A-48 / B5): creates the card directly
    const goal = str(f.goal) ?? str(f.preview) ?? summary ?? "";
    const item: SubagentItem = {
      kind: "subagent",
      id: `i${s.items.length}`,
      subagentId: key,
      goal,
      status,
      summary,
      model: str(f.model),
      depth: typeof f.depth === "number" ? f.depth : undefined,
      taskIndex: typeof f.task_index === "number" ? f.task_index : undefined,
      taskCount: typeof f.task_count === "number" ? f.task_count : undefined,
      parentId: str(f.parent_id),
      durationS,
      costCents,
      costUsd,
      childSessionId,
      tokens,
      filesRead,
      filesWritten,
      outputTail,
    };
    const subagents = { ...s.subagents, [key]: item };
    return withItems(s, [...s.items, item], { ...patch, subagents });
  }

  const existing = s.items[idx] as SubagentItem;
  const updated: SubagentItem = {
    ...existing,
    status,
    summary: summary ?? existing.summary,
    durationS: durationS ?? existing.durationS,
    costCents: costCents ?? existing.costCents,
    costUsd: costUsd ?? existing.costUsd,
    childSessionId: childSessionId ?? existing.childSessionId,
    tokens: tokens ?? existing.tokens,
    filesRead: filesRead ?? existing.filesRead,
    filesWritten: filesWritten ?? existing.filesWritten,
    outputTail: outputTail ?? existing.outputTail,
  };
  const items = s.items.slice();
  items[idx] = updated;
  const subagents = { ...s.subagents, [key]: updated };
  return withItems(s, items, { ...patch, subagents });
}

function terminate(s: TranscriptState, status: Status, f: Record<string, any>, patch: Partial<TranscriptState>): TranscriptState {
  if (TERMINAL.includes(s.status)) return s;
  let items = s.items.map((i) => {
    if (i.kind === "tool" && i.status === "running") {
      return { ...i, status: status === "completed" ? ("done" as const) : ("error" as const) };
    }
    if (i.kind === "subagent" && i.status === "running") {
      return { ...i, status: "unknown" as const };
    }
    return i;
  });
  let subagents = s.subagents;
  if (subagents) {
    let changed = false;
    const nextSub = { ...subagents };
    for (const [k, v] of Object.entries(nextSub)) {
      if (v.status === "running") {
        nextSub[k] = { ...v, status: "unknown" };
        changed = true;
      }
    }
    if (changed) subagents = nextSub;
  }
  // run.completed `output` is Hermes's final answer (api_server_runs.py _execute_run, final_response), like assistant.completed on
  // chat: it replaces the text streamed for the final message, or is added when that message never streamed (a provider that does
  // not stream, deltas cut short, only whitespace, or text that arrived only before a tool). Earlier messages are kept as they are.
  const output = str(f.output);
  if (status === "completed" && output && output.trim()) {
    const lastWork = items.map((i) => i.kind !== "message" && i.kind !== "reasoning").lastIndexOf(true);
    const lastMsg = items.map((i) => i.kind).lastIndexOf("message");
    if (lastMsg > lastWork) {
      items = items.slice();
      items[lastMsg] = { ...(items[lastMsg] as Extract<Item, { kind: "message" }>), text: output };
    } else {
      items = [...items, { kind: "message", id: `i${items.length}`, text: output }];
    }
  }
  const usage = f.usage && typeof f.usage === "object" ? f.usage : s.usage;
  return withItems(s, items, { ...patch, status, usage, subagents });
}

export function reduce(state: TranscriptState, frame: Frame): TranscriptState {
  const { event, data: f } = frame;

  if (event === "luvebot.stream.open") {
    const surface = f.surface === "run" || f.surface === "chat" ? f.surface : state.surface;
    return { ...state, surface, runId: str(f.run_id) ?? state.runId, sessionId: str(f.session_id) ?? state.sessionId, status: state.status === "idle" ? "running" : state.status };
  }
  if (event === "luvebot.stream.close") {
    const reason = str(f.reason);
    // Closing without a terminal frame (timeout, upstream_closed, client_abort) does not end the run: leave status, flag done.
    const status: Status = TERMINAL.includes(state.status) ? state.status : reason === "completed" ? "completed" : reason === "cancelled" ? "cancelled" : state.status;
    return { ...state, status, closeReason: reason, done: true };
  }
  if (event === "luvebot.error") {
    const it: Item = { kind: "error", id: `i${state.items.length}`, code: str(f.code), message: str(f.message) ?? "Erro no stream." };
    return withItems(state, [...state.items, it], { status: TERMINAL.includes(state.status) ? state.status : "failed" });
  }
  if (!KNOWN.has(event)) return state; // unknown / unobserved: ignored without breaking

  // Surface comes from the event vocabulary when luvebot.stream.open was not seen.
  const surface: Surface | null = state.surface ?? (RUN_ONLY.has(event) ? "run" : CHAT_ONLY.has(event) ? "chat" : null);
  const seq = typeof f.seq === "number" ? f.seq : undefined;
  if (seq !== undefined && seq <= state.lastSeq) return state; // duplicate after a reconnect
  const live: Status = state.status === "idle" || state.status === "waiting_approval" ? "running" : state.status;
  const patch: Partial<TranscriptState> = {
    surface, status: live, lastSeq: seq ?? state.lastSeq,
    runId: str(f.run_id) ?? state.runId, sessionId: str(f.session_id) ?? state.sessionId,
  };
  const finished = TERMINAL.includes(state.status);

  switch (event) {
    case "message.delta": case "assistant.delta":
      return finished ? state : appendText(state, "message", str(f.delta) ?? "", patch);
    case "reasoning.available":
      return finished ? state : appendText(state, "reasoning", str(f.text) ?? "", patch);
    case "tool.progress": // only `_thinking` carries text we know (§6.4); other progress is not shown
      return finished || f.tool_name !== "_thinking" ? { ...state, ...patch } : appendText(state, "reasoning", str(f.delta) ?? "", patch);
    case "message.interim": case "assistant.commentary": {
      const text = str(f.text);
      if (finished || !text || f.already_streamed === true) return { ...state, ...patch }; // §6.1: already shown as delta
      return withItems(state, [...state.items, { kind: "commentary", id: `i${state.items.length}`, text }], patch);
    }
    case "tool.started":
      return finished ? state : startTool(state, f, patch);
    case "tool.completed": case "tool.failed":
      return finished ? state : finishTool(state, event, f, patch);
    case "approval.request":
      return finished ? state : withItems(state, [...state.items, { kind: "approval", id: `i${state.items.length}`, requestId: String(f.request_id ?? ""), frame: f }], { ...patch, status: "waiting_approval" });
    case "subagent.start":
      if (state.surface === "chat" || finished) return state;
      return startSubagent(state, f, patch);
    case "subagent.complete":
      if (state.surface === "chat" || finished) return state;
      return completeSubagent(state, f, patch);
    case "assistant.completed": { // chat: full final text of the message; replaces the deltas of that message
      const content = str(f.content);
      if (finished || content === undefined) return { ...state, ...patch };
      const idx = state.items.map((i) => i.kind).lastIndexOf("message");
      if (idx < 0) return withItems(state, [...state.items, { kind: "message", id: `i${state.items.length}`, text: content }], patch);
      const items = state.items.slice();
      items[idx] = { ...(items[idx] as Extract<Item, { kind: "message" }>), text: content };
      return withItems(state, items, patch);
    }
    case "run.completed": return terminate(state, "completed", f, patch);
    case "run.cancelled": return terminate(state, "cancelled", f, patch);
    case "run.failed": return terminate(state, "failed", f, patch);
    case "done": return { ...state, ...patch, done: true };
    default: // run.started, message.started: bookkeeping only (`user_message` is already dropped by the proxy)
      return { ...state, ...patch };
  }
}
