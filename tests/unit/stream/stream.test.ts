// tests/unit/stream/stream.test.ts
// SSE reader + transcript reducer, fed with the REAL Hermes streams (tests/harness/evidence/t08)
// and frames (tests/contract/frames), cut at arbitrary byte positions.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  SseParser, readFrames, openStream, StreamHttpError, reduce, initialTranscript,
  type Frame, type TranscriptState, type SubagentItem,
} from "@/lib/stream";

const ROOT = path.resolve(__dirname, "../../");
const evidence = (n: string) => readFileSync(path.join(ROOT, "harness/evidence/t08", n));
const contract = (rel: string) => readFileSync(path.join(ROOT, "contract/frames", rel));
const index = JSON.parse(readFileSync(path.join(ROOT, "contract/frames/index.json"), "utf8"));

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

function cut(bytes: Uint8Array, mode: "whole" | "byte" | number): Uint8Array[] {
  if (mode === "whole") return [bytes];
  if (mode === "byte") return Array.from(bytes, (b) => Uint8Array.of(b));
  const r = rng(mode), out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length;) { const n = 1 + Math.floor(r() * 40); out.push(bytes.slice(i, i + n)); i += n; }
  return out;
}

function parse(bytes: Uint8Array, mode: "whole" | "byte" | number): Frame[] {
  const p = new SseParser();
  return cut(bytes, mode).flatMap((c) => p.push(c));
}
const fold = (frames: Frame[], s: TranscriptState = initialTranscript()) => frames.reduce(reduce, s);
const kinds = (s: TranscriptState) => s.items.map((i) => i.kind);
const MODES: Array<"whole" | "byte" | number> = ["whole", "byte", 1, 2, 3, 7, 42, 1234];

describe("SseParser: both Hermes framings, any chunking", () => {
  const STREAMS = ["run-stream.sse", "run-approval-stream.sse", "chat-stream.sse", "chat-approval-stream.sse"];

  it.each(STREAMS)("%s parses identically whole, byte by byte and in random chunks", (name) => {
    const bytes = evidence(name);
    const ref = parse(bytes, "whole");
    expect(ref.length).toBeGreaterThan(5);
    for (const m of MODES) expect(parse(bytes, m)).toEqual(ref);
  });

  it("event sequences match tests/contract/frames/index.json", () => {
    const names = (n: string) => parse(evidence(n), "byte").map((f) => f.event);
    expect(names("run-stream.sse")).toEqual(index.run_events);
    expect(names("chat-stream.sse")).toEqual(index.chat_events);
    expect(names("run-approval-stream.sse")).toEqual(index.approval_events.run);
    expect(names("chat-approval-stream.sse")).toEqual(index.approval_events.chat);
  });

  it("run framing: id + JSON event, seq from 0; chat framing: event line, no id, seq from 1, done last", () => {
    const run = parse(evidence("run-stream.sse"), "whole");
    expect(run[0].id).toBe("0");
    expect(run.map((f) => f.data.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const chat = parse(evidence("chat-stream.sse"), "whole");
    expect(chat.every((f) => f.id === undefined)).toBe(true);
    expect(chat[0].data.seq).toBe(1);
    expect(chat.at(-1)!.event).toBe("done");
  });

  it("every real contract frame parses to one frame, with and without chunking", () => {
    for (const dir of ["run", "chat"]) {
      for (const f of readdirSync(path.join(ROOT, "contract/frames", dir))) {
        const bytes = contract(`${dir}/${f}`);
        const one = parse(bytes, "whole");
        expect(one, `${dir}/${f}`).toHaveLength(1);
        expect(parse(bytes, "byte")).toEqual(one);
        expect(one[0].event).toBe(f.replace(/\.sse$/, ""));
      }
    }
  });

  it("cuts inside a multi-byte UTF-8 character lose nothing", () => {
    const text = "ação 😀 日本語";
    const raw = new TextEncoder().encode(`id: 0\ndata: ${JSON.stringify({ event: "message.delta", delta: text, seq: 0 })}\n\n`);
    for (const m of MODES) expect(parse(raw, m)[0].data.delta).toBe(text);
  });

  it("CRLF, lone CR (even split across chunks), comments and unknown fields", () => {
    const wire = ": open\r\nretry: 5\r\nid: 9\revent: x.y\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n: stream closed\r\n\r\n";
    const want = [{ event: "x.y", id: "9", data: { a: 1 } }];
    expect(parse(new TextEncoder().encode(wire), "whole")).toEqual(want);
    expect(parse(new TextEncoder().encode(wire), "byte")).toEqual(want);
  });

  it("drops non-JSON, non-object and nameless frames; an event cut off by EOF is discarded", () => {
    const p = new SseParser();
    const out = p.push("data: not json\n\ndata: [1]\n\ndata: {\"no\":\"event\"}\n\nevent: ok\ndata: {}\n\ndata: {\"event\":\"cut\"}");
    p.end();
    expect(out).toEqual([{ event: "ok", id: undefined, data: {} }]);
  });

  it("refuses an unbounded event", () => {
    expect(() => new SseParser().push("data: " + "x".repeat(1_100_000))).toThrow(/too large/);
  });
});

describe("reducer: final state from the real streams", () => {
  it("run, normal turn", () => {
    const s = fold(parse(evidence("run-stream.sse"), 77));
    expect(s.surface).toBe("run");
    expect(s.status).toBe("completed");
    expect(kinds(s)).toEqual(["message", "reasoning", "tool", "message", "reasoning"]);
    const tool = s.items[2] as any;
    expect(tool).toMatchObject({ name: "terminal", status: "done", durationS: 0.091 });
    expect(tool.preview).toBe("printf luvebot-real-tool-frame");
    expect(tool.result).toContain("luvebot-real-tool-frame");
    expect((s.items[3] as any).text).toBe("Harness model response"); // run.completed output is the final answer, as on chat
    expect(s.usage?.total_tokens).toBe(4);
    expect(s.runId).toMatch(/^run_/);
    expect(s.lastSeq).toBe(7);
    expect(s.items.some((i) => i.kind === "commentary")).toBe(false); // message.interim already_streamed: skipped
  });

  it("run, stopped at an approval", () => {
    const s = fold(parse(evidence("run-approval-stream.sse"), 5));
    expect(s.status).toBe("cancelled");
    const tool = s.items.find((i) => i.kind === "tool") as any;
    expect(tool).toMatchObject({ status: "error", durationS: 1.155 });
    expect(tool.result).toContain("BLOCKED");
    const ap = s.items.find((i) => i.kind === "approval") as any;
    expect(ap.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(ap.frame.command).toBe("rm -rf /tmp/luvebot-approval-canary");
    expect(ap.frame.choices).toEqual(["once", "session", "always", "deny"]);
  });

  it("run: status waits at the approval, then the run ends", () => {
    const frames = parse(evidence("run-approval-stream.sse"), "whole");
    const at = frames.findIndex((f) => f.event === "approval.request");
    expect(fold(frames.slice(0, at + 1)).status).toBe("waiting_approval");
    expect(fold(frames).status).toBe("cancelled");
  });

  it("chat, normal turn: assistant.completed replaces the last message, done closes", () => {
    const s = fold(parse(evidence("chat-stream.sse"), 99));
    expect(s.surface).toBe("chat");
    expect(s.status).toBe("completed");
    expect(s.done).toBe(true);
    expect(kinds(s)).toEqual(["message", "reasoning", "tool", "message", "reasoning"]);
    expect((s.items[0] as any).text).toBe("Testing the local tool.");
    expect((s.items[3] as any).text).toBe("Harness model response");
    expect(s.items[2]).toMatchObject({ name: "terminal", status: "done" }); // chat completion has no duration/result (A-11)
    expect((s.items[2] as any).durationS).toBeUndefined();
    expect((s.items[2] as any).args).toEqual({ command: "printf luvebot-real-tool-frame" });
    expect(s.sessionId).toMatch(/^api_/);
  });

  it("chat, stopped at an approval: tool.failed, null content ignored, run.cancelled then done", () => {
    const s = fold(parse(evidence("chat-approval-stream.sse"), 11));
    expect(s.status).toBe("cancelled");
    expect(s.done).toBe(true);
    expect(s.items.find((i) => i.kind === "tool")).toMatchObject({ status: "error" });
    expect(s.items.some((i) => i.kind === "approval")).toBe(true);
    expect(s.items.filter((i) => i.kind === "message")).toHaveLength(1);
  });

  it("any chunking gives the same final state", () => {
    for (const n of ["run-stream.sse", "chat-stream.sse", "run-approval-stream.sse", "chat-approval-stream.sse"]) {
      const ref = fold(parse(evidence(n), "whole"));
      for (const m of MODES) expect(fold(parse(evidence(n), m))).toEqual(ref);
    }
  });

  it("frames after a terminal frame do not reopen the run", () => {
    const frames = parse(evidence("run-stream.sse"), "whole");
    const end = fold(frames);
    const late = reduce(end, { event: "message.delta", data: { delta: "tarde", seq: 99 } });
    expect(late.items).toEqual(end.items);
    expect(late.status).toBe("completed");
  });
});

describe("reducer: tool pairing (§6.5, A-5)", () => {
  const ev = (event: string, data: Record<string, any>): Frame => ({ event, data });
  const tools = (s: TranscriptState) => s.items.filter((i) => i.kind === "tool") as any[];

  it("FIFO: a completion closes the OLDEST open start of the same tool", () => {
    const s = fold([
      ev("tool.started", { tool: "terminal", preview: "a", seq: 0 }),
      ev("tool.started", { tool: "terminal", preview: "b", seq: 1 }),
      ev("tool.completed", { tool: "terminal", duration: 1, error: false, preview: "ra", seq: 2 }),
    ]);
    const [a, b] = tools(s);
    expect(a).toMatchObject({ preview: "a", status: "done", result: "ra", ambiguous: true });
    expect(b).toMatchObject({ preview: "b", status: "running", ambiguous: true });
  });

  it("different tools do not cross-pair", () => {
    const s = fold([
      ev("tool.started", { tool: "terminal", seq: 0 }),
      ev("tool.started", { tool: "web", seq: 1 }),
      ev("tool.completed", { tool: "web", error: false, seq: 2 }),
    ]);
    expect(tools(s).map((t) => [t.name, t.status])).toEqual([["terminal", "running"], ["web", "done"]]);
    expect(tools(s)[0].ambiguous).toBeUndefined();
  });

  it("chat surface also pairs by message_id", () => {
    const s = fold([
      ev("tool.started", { tool_name: "terminal", message_id: "m1", seq: 1 }),
      ev("tool.started", { tool_name: "terminal", message_id: "m2", seq: 2 }),
      ev("tool.completed", { tool_name: "terminal", message_id: "m2", seq: 3 }),
    ]);
    expect(tools(s).map((t) => t.status)).toEqual(["running", "done"]);
    expect(tools(s)[0].ambiguous).toBeUndefined();
  });

  it("error: true on a run completion and tool.failed on chat both end as error", () => {
    expect(tools(fold([ev("tool.started", { tool: "t", seq: 0 }), ev("tool.completed", { tool: "t", error: true, seq: 1 })]))[0].status).toBe("error");
    expect(tools(fold([ev("tool.started", { tool_name: "t", seq: 1 }), ev("tool.failed", { tool_name: "t", seq: 2 })]))[0].status).toBe("error");
  });

  it("a completion with no open start still shows; a dangling start is closed when the run ends", () => {
    expect(tools(fold([ev("tool.completed", { tool: "t", error: false, seq: 0 })]))[0].status).toBe("done");
    const s = fold([ev("tool.started", { tool: "t", seq: 0 }), ev("run.cancelled", { seq: 1 })]);
    expect(tools(s)[0].status).toBe("error");
    expect(s.status).toBe("cancelled");
  });
});

describe("reducer: robustness and luvebot.* events", () => {
  const ev = (event: string, data: Record<string, any> = {}): Frame => ({ event, data });

  it("unknown frames (subagent.*, future names) keep the very same state object", () => {
    const s = fold(parse(evidence("run-stream.sse"), "whole").slice(0, 3));
    for (const n of ["subagent.start", "subagent.complete", "something.new", "luvebot.future"]) expect(reduce(s, ev(n, { x: 1, seq: 50 }))).toBe(s);
  });

  it("duplicate or older seq is dropped", () => {
    const s = fold([ev("message.delta", { delta: "a", seq: 0 }), ev("message.delta", { delta: "a", seq: 0 }), ev("message.delta", { delta: "b", seq: 1 })]);
    expect((s.items[0] as any).text).toBe("ab");
  });

  it("run.failed ends the run as failed", () => {
    expect(fold([ev("message.delta", { delta: "x", seq: 0 }), ev("run.failed", { seq: 1 })]).status).toBe("failed");
  });

  it("commentary shows only when it was not already streamed", () => {
    expect(kinds(fold([ev("assistant.commentary", { text: "t", already_streamed: true, seq: 1 })]))).toEqual([]);
    expect(kinds(fold([ev("assistant.commentary", { text: "t", already_streamed: false, seq: 1 })]))).toEqual(["commentary"]);
  });

  it("reasoning: chat _thinking deltas append; other tool.progress is ignored", () => {
    const s = fold([
      ev("tool.progress", { tool_name: "_thinking", delta: "a", seq: 1 }),
      ev("tool.progress", { tool_name: "_thinking", delta: "b", seq: 2 }),
      ev("tool.progress", { tool_name: "terminal", delta: "zzz", seq: 3 }),
    ]);
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as any).text).toBe("ab");
  });

  it("luvebot.stream.open / error / close", () => {
    let s = reduce(initialTranscript(), ev("luvebot.stream.open", { bot: "v", surface: "chat", session_id: "s1", api: "0" }));
    expect(s).toMatchObject({ surface: "chat", sessionId: "s1", status: "running" });
    s = reduce(s, ev("luvebot.error", { code: "hermes_timeout", message: "Tempo esgotado." }));
    expect(s.status).toBe("failed");
    expect(s.items[0]).toMatchObject({ kind: "error", code: "hermes_timeout", message: "Tempo esgotado." });
    s = reduce(s, ev("luvebot.stream.close", { reason: "timeout" }));
    expect(s).toMatchObject({ done: true, closeReason: "timeout", status: "failed" });
  });

  it("closing with upstream_closed does not claim the run ended", () => {
    const s = reduce(fold([ev("message.delta", { delta: "x", seq: 0 })]), ev("luvebot.stream.close", { reason: "upstream_closed" }));
    expect(s).toMatchObject({ done: true, status: "running" });
  });

  it("hostile text stays in state as a plain string (rendering is the cards' job)", () => {
    const s = fold([ev("message.delta", { delta: "<script>x</script>", seq: 0 })]);
    expect((s.items[0] as any).text).toBe("<script>x</script>");
  });
});

describe("readFrames / openStream", () => {
  const sse = (chunks: Uint8Array[], status = 200) =>
    new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(x)); c.close(); } }), { status });

  it("reads a Response body cut mid-line and mid-character", async () => {
    const got: Frame[] = [];
    await readFrames(sse(cut(evidence("chat-stream.sse"), 5)), (f) => got.push(f));
    expect(got).toEqual(parse(evidence("chat-stream.sse"), "whole"));
  });

  it("sends Accept and the signal through the injected fetcher; the token is never put in the URL", async () => {
    let seen: any;
    const fetcher = async (u: string, init?: RequestInit) => { seen = { u, init }; return sse([evidence("run-stream.sse")]); };
    const ac = new AbortController();
    const got: Frame[] = [];
    await openStream("/api/plugins/luvebot/bots/v/runs/r1/events", (f) => got.push(f), { fetcher, signal: ac.signal });
    expect((seen.init.headers as any).Accept).toBe("text/event-stream");
    expect(seen.init.signal).toBe(ac.signal);
    expect(got).toHaveLength(8);
    await expect(openStream("/x?token=abc", () => {}, { fetcher })).rejects.toThrow(/header/);
  });

  it("a non-2xx answer throws the status and nothing else (401 handled by the caller)", async () => {
    const fetcher = async () => new Response('{"error":"unauthenticated","secret":"s"}', { status: 401 });
    const e = await openStream("/x", () => {}, { fetcher }).catch((x) => x);
    expect(e).toBeInstanceOf(StreamHttpError);
    expect(e.status).toBe(401);
    expect(e.message).not.toContain("secret");
  });

  it("abort ends the read quietly", async () => {
    const ac = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(": open\n\n")); }, cancel() {} });
    const p = readFrames(new Response(body), () => {}, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).resolves.toBeUndefined();
  });

  it("source never uses EventSource", () => {
    for (const f of ["sse.ts", "reducer.ts", "index.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "../../../dashboard/src/lib/stream", f), "utf8");
      expect(src).not.toMatch(/new\s+EventSource|EventSource\s*\(/);
    }
  });
});

describe("reducer: subagent lifecycle on run surface (v0.4 B5, H-B5 documented format)", () => {
  // Format reference and links:
  // Hermes api_server_runs.py line 79: https://github.com/NousResearch/hermes-agent/blob/f8489405/gateway/platforms/api_server_runs.py#L79
  // Hermes documentation: https://github.com/NousResearch/hermes-agent/blob/f8489405/website/docs/user-guide/features/api-server.md#L512
  // Contract: docs/contracts/plugin-api-v0.4.md B5
  const ev = (event: string, data: Record<string, any> = {}): Frame => ({ event, data });

  it("subagent.start creates running subagent item with goal, model, hierarchy and maps to state.subagents", () => {
    const s0 = fold([
      ev("luvebot.stream.open", { surface: "run", run_id: "r-parent", session_id: "s-main" }),
      ev("subagent.start", {
        subagent_id: "sub-101",
        goal: "Pesquisar documentação e código do Hermes",
        model: "hermes-3-llama-3.1-8b",
        depth: 1,
        task_index: 0,
        task_count: 2,
        parent_id: "parent-001",
        child_session_id: "sess-child-101",
        seq: 1,
      }),
    ]);

    expect(s0.surface).toBe("run");
    expect(s0.items).toHaveLength(1);
    const item = s0.items[0] as SubagentItem;
    expect(item).toMatchObject({
      kind: "subagent",
      subagentId: "sub-101",
      goal: "Pesquisar documentação e código do Hermes",
      status: "running",
      model: "hermes-3-llama-3.1-8b",
      depth: 1,
      taskIndex: 0,
      taskCount: 2,
      parentId: "parent-001",
      childSessionId: "sess-child-101",
    });
    expect(s0.subagents?.["sub-101"]).toEqual(item);

    // Missing complete leaves running until run ends, transitioning to unknown
    const s1 = reduce(s0, ev("run.completed", { seq: 2 }));
    expect(s1.status).toBe("completed");
    expect((s1.items[0] as SubagentItem).status).toBe("unknown");
    expect(s1.subagents?.["sub-101"]?.status).toBe("unknown");
  });

  it("subagent.complete updates existing subagent with summary, tokens, duration and costs", () => {
    const s0 = fold([
      ev("luvebot.stream.open", { surface: "run", run_id: "r-parent" }),
      ev("subagent.start", {
        subagent_id: "sub-202",
        goal: "Executar varredura de testes",
        seq: 1,
      }),
      ev("subagent.complete", {
        subagent_id: "sub-202",
        status: "completed",
        summary: "36 testes executados com sucesso.",
        duration_seconds: 12.4,
        input_tokens: 1500,
        output_tokens: 320,
        reasoning_tokens: 45,
        cost_cents: 8,
        cost_usd: 0.08,
        child_session_id: "sess-child-202",
        files_read: ["package.json"],
        files_written: ["report.txt"],
        output_tail: "Done with 0 errors.",
        seq: 2,
      }),
    ]);

    expect(s0.items).toHaveLength(1); // Merged into 1 item, no duplicate
    const item = s0.items[0] as SubagentItem;
    expect(item).toMatchObject({
      kind: "subagent",
      subagentId: "sub-202",
      goal: "Executar varredura de testes",
      status: "completed",
      summary: "36 testes executados com sucesso.",
      durationS: 12.4,
      tokens: { input: 1500, output: 320, reasoning: 45 },
      costCents: 8,
      costUsd: 0.08,
      childSessionId: "sess-child-202",
      filesRead: ["package.json"],
      filesWritten: ["report.txt"],
      outputTail: "Done with 0 errors.",
    });
    expect(s0.subagents?.["sub-202"]).toEqual(item);
  });

  it("subagent.complete without prior subagent.start creates card directly with fallback delegation_id:task_index", () => {
    const s0 = fold([
      ev("luvebot.stream.open", { surface: "run", run_id: "r-parent" }),
      ev("subagent.complete", {
        delegation_id: "del-777",
        task_index: 3,
        status: "failed",
        summary: "Timeout aguardando subprocesso",
        duration_seconds: 5.5,
        cost_cents: 2,
        seq: 1,
      }),
    ]);

    expect(s0.items).toHaveLength(1);
    const item = s0.items[0] as SubagentItem;
    expect(item).toMatchObject({
      kind: "subagent",
      subagentId: "del-777:3",
      status: "failed",
      summary: "Timeout aguardando subprocesso",
      durationS: 5.5,
      costCents: 2,
      costUsd: 0.02,
    });
    expect(s0.subagents?.["del-777:3"]).toEqual(item);
  });

  it("subagent events are ignored on chat surface", () => {
    const s0 = fold([
      ev("luvebot.stream.open", { surface: "chat", session_id: "s-chat" }),
      ev("subagent.start", { subagent_id: "sub-chat", goal: "Não deve aparecer", seq: 1 }),
      ev("subagent.complete", { subagent_id: "sub-chat", status: "completed", seq: 2 }),
    ]);

    expect(s0.surface).toBe("chat");
    expect(s0.items).toHaveLength(0);
    expect(s0.subagents).toEqual({});
  });

  it("duplicate subagent.start frames merge without duplicating items", () => {
    const s0 = fold([
      ev("luvebot.stream.open", { surface: "run", run_id: "r-dup" }),
      ev("subagent.start", { subagent_id: "sub-dup", goal: "Meta inicial", seq: 1 }),
      ev("subagent.start", { subagent_id: "sub-dup", goal: "Meta atualizada", model: "claude-3-5-sonnet", seq: 2 }),
    ]);

    expect(s0.items).toHaveLength(1);
    expect((s0.items[0] as SubagentItem).goal).toBe("Meta atualizada");
    expect((s0.items[0] as SubagentItem).model).toBe("claude-3-5-sonnet");
  });
});

// The VPS turn that showed only "Concluído" (2026-10-02): every way a run can end with its answer only in run.completed.output.
describe("reducer: run.completed output is the final answer", () => {
  const ev = (event: string, data: Record<string, any>): Frame => ({ event, data });
  const messages = (s: TranscriptState) => s.items.filter((i) => i.kind === "message").map((i) => (i as any).text);
  const open = ev("luvebot.stream.open", { surface: "run", run_id: "run_x" });

  it("no delta at all (a provider that does not stream): the output becomes the message", () => {
    expect(messages(fold([open, ev("run.completed", { output: "Oi, sou o Bot.", seq: 0 })]))).toEqual(["Oi, sou o Bot."]);
  });
  it("a whitespace-only delta does not hide the answer", () => {
    const s = fold([open, ev("message.delta", { delta: " ", seq: 0 }), ev("run.completed", { output: "Oi, sou o Bot.", seq: 1 })]);
    expect(messages(s)).toEqual(["Oi, sou o Bot."]);
  });
  it("a delta with no text field does not hide the answer", () => {
    const s = fold([open, ev("message.delta", { seq: 0 }), ev("run.completed", { output: "Oi, sou o Bot.", seq: 1 })]);
    expect(messages(s)).toEqual(["Oi, sou o Bot."]);
  });
  it("text only before a tool: the final answer that was not streamed is added after it", () => {
    const s = fold([open, ev("message.delta", { delta: "Vou olhar.", seq: 0 }), ev("tool.started", { tool: "terminal", seq: 1 }),
      ev("tool.completed", { tool: "terminal", seq: 2 }), ev("run.completed", { output: "Pronto: 3 arquivos.", seq: 3 })]);
    expect(messages(s)).toEqual(["Vou olhar.", "Pronto: 3 arquivos."]);
    expect(kinds(s)).toEqual(["message", "tool", "message"]);
  });
  it("deltas cut short: the full answer replaces them", () => {
    const s = fold([open, ev("message.delta", { delta: "Oi, so", seq: 0 }), ev("run.completed", { output: "Oi, sou o Bot.", seq: 1 })]);
    expect(messages(s)).toEqual(["Oi, sou o Bot."]);
  });
  it("an empty output keeps what streamed", () => {
    const s = fold([open, ev("message.delta", { delta: "Oi", seq: 0 }), ev("run.completed", { output: "", seq: 1 })]);
    expect(messages(s)).toEqual(["Oi"]);
  });
});
