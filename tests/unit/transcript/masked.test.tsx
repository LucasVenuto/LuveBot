// tests/unit/transcript/masked.test.tsx
// The screen draws what a mask of the server did to a tool result. A masked frame (`masked: {kind}`, `preview` empty) and a masked history row (`masked: {kind, path?, size?}`, `text` the
// English line) are drawn as the words of the kind, never as the arguments or the result, even if some were sent along; a frame's path or size is never drawn (a frame has none); a kind this screen does not know is no mask and the
// screen draws what it was sent. The words themselves come through the extension point (the private screens): nothing of them is in this public folder.
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { reduce, initialTranscript, type Frame } from "@/lib/stream";
import { toolFromFrame } from "@/components/transcript/frames";
import { maskedOfFrame, maskedOfRow } from "@/components/transcript/masked";
import { ToolCard } from "@/components/transcript/cards";
import { turnsFromHistory } from "@/components/chat/history";
import { deriveActivity } from "@/components/conversation/derive";
import { maskWords } from "@/extra-empty";
import type { HistoryMessage } from "@/api/types";

afterEach(cleanup);
const frame = (event: string, data: Record<string, unknown>): Frame => ({ event, data } as Frame);
const tools = (s: ReturnType<typeof initialTranscript>) => s.items.filter((i) => i.kind === "tool") as Array<Extract<(typeof s.items)[number], { kind: "tool" }>>;
const SECRET = "TEXTO-DA-NOTA-QUE-NAO-PODE-APARECER";

describe("the mask of a frame is its kind and nothing else", () => {
  it("maskedOfFrame keeps only `read` or `hidden`, and never a path or a size, even if sent", () => {
    expect(maskedOfFrame({ kind: "read" })).toEqual({ kind: "read" });
    expect(maskedOfFrame({ kind: "hidden", path: "a/b.md", size: 9 })).toEqual({ kind: "hidden" });
    for (const bad of [undefined, null, "read", 3, [], {}, { kind: "other" }, { kind: "READ" }, { kind: null }, { path: "a.md" }]) expect(maskedOfFrame(bad), JSON.stringify(bad)).toBeUndefined();
  });
  it("maskedOfRow keeps the kind and, when given, the shown path (text) and the size (a whole number, zero or more); a weird path or size is dropped, a weird kind is no mask", () => {
    expect(maskedOfRow({ kind: "read", path: "projetos/plano-a.md", size: 120 })).toEqual({ kind: "read", path: "projetos/plano-a.md", size: 120 });
    expect(maskedOfRow({ kind: "read", size: 0 })).toEqual({ kind: "read", size: 0 });
    expect(maskedOfRow({ kind: "hidden", path: "", size: -1 })).toEqual({ kind: "hidden" });
    expect(maskedOfRow({ kind: "hidden", path: 5, size: 1.5 })).toEqual({ kind: "hidden" });
    expect(maskedOfRow({ kind: "hidden", size: "9" })).toEqual({ kind: "hidden" });
    for (const bad of [undefined, null, "x", {}, { kind: "other", path: "a" }]) expect(maskedOfRow(bad), JSON.stringify(bad)).toBeUndefined();
  });
  it("toolFromFrame carries the kind of a started and of a completed frame", () => {
    expect(toolFromFrame("tool.started", { tool_name: "notes_read", preview: "", masked: { kind: "hidden" } }).masked).toEqual({ kind: "hidden" });
    expect(toolFromFrame("tool.completed", { tool_name: "notes_read", preview: "", masked: { kind: "read", path: "x.md", size: 4 } }).masked).toEqual({ kind: "read" });
    expect(toolFromFrame("tool.completed", { tool: "web_search", preview: "ok" }).masked).toBeUndefined();
  });
});

describe("the reducer: a tool item carries the kind of its mask", () => {
  it("a masked start, then a completion that says `read`: the item says read (the completion has the last word), still with no text", () => {
    let s = initialTranscript();
    s = reduce(s, frame("tool.started", { tool: "notes_read", tool_call_id: "c1", preview: "", masked: { kind: "hidden" } }));
    expect(tools(s)[0].masked).toEqual({ kind: "hidden" });
    s = reduce(s, frame("tool.completed", { tool: "notes_read", tool_call_id: "c1", error: false, preview: "", masked: { kind: "read" } }));
    expect(tools(s)).toHaveLength(1);
    expect(tools(s)[0]).toMatchObject({ status: "done", masked: { kind: "read" }, preview: "", result: "" });
  });
  it("a completion with no mark keeps what the start said (a failed unwrap has no `masked` and must not unmask a call already masked)", () => {
    let s = initialTranscript();
    s = reduce(s, frame("tool.started", { tool: "notes_read", preview: "", masked: { kind: "hidden" } }));
    s = reduce(s, frame("tool.completed", { tool: "notes_read", error: true, preview: "" }));
    expect(tools(s)[0]).toMatchObject({ status: "error", masked: { kind: "hidden" } });
  });
  it("a completion with no open start (a reconnect) is still a masked item; a frame's path and size are not kept; an unknown kind is no mask", () => {
    let s = initialTranscript();
    s = reduce(s, frame("tool.completed", { tool: "notes_read", preview: "", masked: { kind: "read", path: "a.md", size: 3 } }));
    expect(tools(s)[0].masked).toEqual({ kind: "read" });
    s = reduce(initialTranscript(), frame("tool.completed", { tool: "x", preview: "fine", masked: { kind: "new-kind-of-a-future-server" } }));
    expect(tools(s)[0].masked).toBeUndefined();
    expect(tools(s)[0].preview).toBe("fine");                                                  // not a mask this screen knows: drawn as it came
  });
  it("a frame that is not masked is unchanged", () => {
    const s = reduce(reduce(initialTranscript(), frame("tool.started", { tool: "web_search", preview: "q" })), frame("tool.completed", { tool: "web_search", preview: "3 results" }));
    expect(tools(s)[0]).toMatchObject({ status: "done", preview: "q", result: "3 results" });
    expect(tools(s)[0].masked).toBeUndefined();
  });
});

describe("the card of a masked result never draws its arguments or its result", () => {
  it("even when some are sent along, collapsed or opened", () => {
    render(<ToolCard name="notes_read" status="done" preview="" args={{ path: SECRET, q: SECRET }} result={SECRET} masked={{ kind: "read" }} />);
    expect(document.body.textContent).not.toContain(SECRET);
    fireEvent.click(screen.getByRole("button"));
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain("path");
  });
  it("a card with no mask is as it was: the arguments and the result in its details", () => {
    render(<ToolCard name="web_search" status="done" preview="q" args={{ q: "gatos" }} result="3 resultados" />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.body.textContent).toContain("gatos"); expect(document.body.textContent).toContain("3 resultados");
  });
  it("a build with no words for a mask (the public one) says nothing of the text: it draws the preview it was sent, never args or result", () => {
    expect(maskWords("read", "pt")).toBeNull();                                               // the public extension point holds no word of any mask
    render(<ToolCard name="x" status="done" preview="" result={SECRET} masked={{ kind: "hidden" }} />);
    expect(document.body.textContent).not.toContain(SECRET);
  });
});

describe("a masked history row is a card of its kind", () => {
  const row = (over: Partial<HistoryMessage>): HistoryMessage => ({ id: 1, role: "tool", text: "A note was read", tool_name: "notes_read", ...over } as HistoryMessage);
  const items = (rows: HistoryMessage[]) => turnsFromHistory(rows).flatMap((t) => t.state.items).filter((i) => i.kind === "tool") as Array<Extract<ReturnType<typeof initialTranscript>["items"][number], { kind: "tool" }>>;
  it("a reader's row: kind, shown path and size; the English line is only the fallback; no result is drawn", () => {
    const got = items([{ id: 9, role: "user", text: "oi" } as HistoryMessage, row({ id: 10, text: "(projetos/plano-a.md, 120 characters)", masked: { kind: "read", path: "projetos/plano-a.md", size: 120 } })]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: "notes_read", status: "done", masked: { kind: "read", path: "projetos/plano-a.md", size: 120 }, preview: "(projetos/plano-a.md, 120 characters)" });
    expect(got[0].result).toBeUndefined();
  });
  it("a stranger's row is exactly the kind: no path, no size", () => {
    const got = items([row({ id: 3, masked: { kind: "read" } })]);
    expect(got[0].masked).toEqual({ kind: "read" });
  });
  it("a hidden row with no tool name still becomes a card, named by a mark and never by text", () => {
    const got = items([row({ id: 4, text: "result hidden", tool_name: undefined, masked: { kind: "hidden" } })]);
    expect(got[0]).toMatchObject({ name: "?", masked: { kind: "hidden" } });
  });
  it("a row with a mask this screen does not know, and a tool row with no mask, stay as they were: not drawn (only a terminal's and a delegation's are)", () => {
    expect(items([row({ id: 5, masked: { kind: "from-the-future" } as never }), row({ id: 6, masked: undefined }), row({ id: 7, tool_name: "web_search", text: "x" })])).toEqual([]);
  });
  it("the terminal's row and the order of the turn are unchanged around it", () => {
    const got = turnsFromHistory([{ id: 1, role: "user", text: "oi" }, row({ id: 2, masked: { kind: "hidden" } }), { id: 3, role: "tool", text: "ls", tool_name: "terminal" }, { id: 4, role: "assistant", text: "pronto" }] as HistoryMessage[]);
    expect(got).toHaveLength(1);
    expect(got[0].state.items.map((i) => (i.kind === "tool" ? `${i.name}${i.masked ? ":masked" : ""}` : i.kind))).toEqual(["notes_read:masked", "terminal", "message"]);
  });
});

describe("the work panel's activity says nothing of the text of a masked result", () => {
  it("the row has no preview and no error text, only the mask", () => {
    const s = reduce(initialTranscript(), frame("tool.completed", { tool: "notes_read", error: true, preview: SECRET, masked: { kind: "hidden" } }));
    const rows = deriveActivity({ items: s.items });
    expect(rows[0]).toMatchObject({ kind: "tool", masked: { kind: "hidden" } });
    expect((rows[0] as { preview?: string }).preview).toBeUndefined();
    expect((rows[0] as { error?: string }).error).toBeUndefined();
  });
});
