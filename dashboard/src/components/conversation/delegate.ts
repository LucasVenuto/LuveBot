// dashboard/src/components/conversation/delegate.ts
// A helper the Bot delegated to, read from its own `delegate_task` tool call, for when the run stream brings no subagent.*
// frames. Only what Hermes sent: the goal from the call (its args, or Hermes's preview of the call), the state from
// started/completed/failed, and the summary from the result (tool.completed preview, api_server_runs.py
// _tool_completed_preview: the JSON of delegate_tool_results, cut at 500 characters). Nothing else, no cost.
import type { Item } from "../../lib/stream";

type Tool = Extract<Item, { kind: "tool" }>;
export const DELEGATE_TOOL = "delegate_task";
// While a helper runs in the background the session's history is read every 5 s, for up to 10 minutes.
export const DELIVERY_MS = 5000;
export const DELIVERY_TRIES = 120;

const unescape = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };

/** The children's summaries in the result: whole JSON when it fits, else the "summary" fields of a cut one, else the text. */
export function delegateSummary(result: string | undefined): string | undefined {
  const text = result?.trim();
  if (!text) return undefined;
  try {
    const data = JSON.parse(text) as unknown;
    const rows = (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) ? (data as { results: unknown[] }).results : [data];
    const found = rows.map((r) => (r && typeof r === "object" ? (r as { summary?: unknown }).summary : undefined)).filter((x): x is string => typeof x === "string" && !!x.trim());
    if (found.length) return found.join("\n\n");
  } catch {
    const cut = [...text.matchAll(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/g)].map((m) => unescape(m[1])).filter((x) => x.trim());
    if (cut.length) {
      const cutShort = text.endsWith("...");  // Hermes's own cut mark (_tool_completed_preview) ends up inside the last summary
      if (cutShort) cut[cut.length - 1] = cut[cut.length - 1].replace(/\.\.\.$/, "");
      return cut.join("\n\n") + (cutShort ? "…" : "");
    }
  }
  return text;
}

/** A top-level delegation always runs in the BACKGROUND in the pinned Hermes (delegate_tool.py _model_background_value): the
 *  call answers at once {status:"dispatched", delegation_id} (async_delegation.py), so its tool.completed is NOT the helper being
 *  done. The result comes later, for an API session as a delivery row of the session's history (gateway/wake.py
 *  persist_delegation_delivery: display_kind "async_delegation_complete", display_metadata.delegation_id). */
export function dispatchedId(result: string | undefined): string | null {
  try {
    const d = JSON.parse(result ?? "") as { status?: unknown; delegation_id?: unknown };
    return d && d.status === "dispatched" && typeof d.delegation_id === "string" && d.delegation_id ? d.delegation_id : null;
  } catch {
    // the run stream cuts the result at 500 characters (_tool_completed_preview) and the real answer is ~1 KB: read the fields
    const text = result ?? "";
    const id = /"delegation_id"\s*:\s*"([^"\\]+)"/.exec(text)?.[1];
    return /^\s*\{\s*"status"\s*:\s*"dispatched"/.test(text) && id ? id : null;
  }
}

/** The goal of a dispatched delegation, from its whole answer (history keeps it whole): goals[0]. */
export function dispatchedGoal(result: string | undefined): string | undefined {
  try {
    const goals = (JSON.parse(result ?? "") as { goals?: unknown }).goals;
    return Array.isArray(goals) && typeof goals[0] === "string" ? goals[0] : undefined;
  } catch { return undefined; }
}

/** What a delivery row said, by delegation_id: its text and whether the unit failed (display_metadata counts). */
export type Delivery = { status: "completed" | "failed"; text: string };
export type Deliveries = ReadonlyMap<string, Delivery>;
export type HelperStatus = "running" | "background" | "background_late" | "completed" | "failed";

/** `late`: delegations whose result did not reach this conversation within the follow-up time: said as it is, never "done". */
export function delegateView(tool: Tool, deliveries: Deliveries = new Map(), late: ReadonlySet<string> = new Set()): { goal: string; status: HelperStatus; summary?: string; delegationId?: string } {
  const goal = typeof tool.args?.goal === "string" ? tool.args.goal : tool.preview ?? "";
  if (tool.status === "running") return { goal, status: "running" };
  if (tool.status === "error") return { goal, status: "failed", summary: delegateSummary(tool.result) };
  const id = dispatchedId(tool.result);
  if (!id) return { goal, status: "completed", summary: delegateSummary(tool.result) };   // a synchronous delegation: its result is here
  const delivered = deliveries.get(id);
  if (delivered) return { goal, status: delivered.status, summary: delivered.text, delegationId: id };
  return { goal, status: late.has(id) ? "background_late" : "background", delegationId: id };
}

/** The delegation ids of these items still running in the background (no delivery yet). */
export function backgroundIds(items: readonly Item[], deliveries: Deliveries): string[] {
  return items.flatMap((i) => (i.kind === "tool" && i.name === DELEGATE_TOOL && i.status === "done" ? [dispatchedId(i.result)] : []))
    .filter((id): id is string => !!id && !deliveries.has(id));
}

type Sub = Extract<Item, { kind: "subagent" }>;
/** Hermes's card (subagent.start) with no subagent.complete takes its state from the same turn's delegate_task call: "background"
 *  while that call only dispatched it, then the delivery's text. Hermes's own complete, when it comes, wins. One card. */
export function fillFromDelegate(sub: Sub, items: readonly Item[], deliveries: Deliveries = new Map(), late: ReadonlySet<string> = new Set()): { status: HelperStatus; summary?: string } | null {
  if (sub.summary || (sub.status !== "unknown" && sub.status !== "running")) return null;
  const done = items.filter((i): i is Tool => i.kind === "tool" && i.name === DELEGATE_TOOL && i.status !== "running");
  const call = done.find((t) => delegateView(t).goal === sub.goal) ?? (done.length === 1 ? done[0] : undefined);
  if (!call) return null;
  const v = delegateView(call, deliveries, late);
  return { status: v.status, summary: v.summary };
}

/** A delivery row's text is written for the MODEL (Hermes f8489405, seen in the harness): "[ASYNC DELEGATION BATCH COMPLETE —
 *  deleg_…]", instructions, the context, then per task "--- ✓ TASK i/n: <goal>  (status=…) ---" and the child's summary, then a
 *  log path. The card shows each task's summary; when that shape is not found, the text as it came. */
const TASK = /^---\s*(\S+)\s*TASK\s+\d+\/\d+:\s*(.*?)\s*\(status=([a-z_]+)[^)]*\)\s*---\s*$/;
export function deliveryView(text: string, meta?: DeliveryMeta): { id?: string; status: "completed" | "failed"; summary: string } {
  const id = meta?.delegation_id || /^\[ASYNC DELEGATION[^\]]*?(deleg_[A-Za-z0-9_-]+)\]/.exec(text.trim())?.[1];
  const tasks: { goal: string; status: string; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const head = TASK.exec(line.trim());
    if (head) { tasks.push({ goal: head[2], status: head[3], lines: [] }); continue; }
    const cur = tasks[tasks.length - 1];
    if (!cur || /^Full live transcript/.test(line) || /^---/.test(line.trim())) continue;
    cur.lines.push(line);
  }
  const parts = tasks.map((x) => ({ ...x, body: x.lines.join("\n").trim() })).filter((x) => x.body);
  const summary = !parts.length ? text : parts.length === 1 ? parts[0].body : parts.map((x) => `**${x.goal}**\n\n${x.body}`).join("\n\n");
  const failedOnly = tasks.length > 0 && tasks.every((x) => x.status === "failed" || x.status === "error");
  const status = meta && (meta.failed_count !== undefined || meta.completed_count !== undefined) ? deliveryStatus(meta) : failedOnly ? "failed" : "completed";
  return { id, status, summary };
}

/** Delivery rows of a session's history, by delegation_id. */
export function deliveriesOf(rows: readonly { display_kind?: string; text: string; display_metadata?: DeliveryMeta }[]): Map<string, Delivery> {
  const out = new Map<string, Delivery>();
  for (const r of rows) {
    if (r.display_kind !== "async_delegation_complete") continue;
    const v = deliveryView(r.text, r.display_metadata);
    if (v.id) out.set(v.id, { status: v.status, text: v.summary });
  }
  return out;
}
export type DeliveryMeta = { delegation_id?: string; task_count?: number; completed_count?: number; failed_count?: number; duration_seconds?: number };
/** Failed only when no task of the unit completed and at least one failed (wake.py _delegation_display_metadata). */
export const deliveryStatus = (m: DeliveryMeta | undefined): "completed" | "failed" =>
  (m?.failed_count ?? 0) > 0 && !(m?.completed_count ?? 0) ? "failed" : "completed";
