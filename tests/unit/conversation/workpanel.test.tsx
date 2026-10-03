// tests/unit/conversation/workpanel.test.tsx
// Work panel derivations fed by REAL frames (tests/harness/evidence/t08 streams) through the T2.3 reducer.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { SseParser, reduce, initialTranscript, type Frame } from "@/lib/stream";
import { WorkPanel, Conversation, deriveActivity, deriveTerminal, deriveFiles } from "@/components/conversation";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

const ROOT = path.resolve(__dirname, "../../");
const state = (n: string) => {
  const p = new SseParser();
  const frames: Frame[] = p.push(readFileSync(path.join(ROOT, "harness/evidence/t08", n)));
  return frames.reduce(reduce, initialTranscript());
};
const RUN = () => state("run-stream.sse");
const CHAT = () => state("chat-stream.sse");
const RUN_APPROVAL = () => state("run-approval-stream.sse");

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("deriveActivity", () => {
  it("run: tool with duration and preview; reasoning is not an activity row", () => {
    const a = deriveActivity(RUN());
    expect(a).toEqual([{ kind: "tool", id: expect.any(String), name: "terminal", status: "done", preview: "printf luvebot-real-tool-frame", durationS: 0.091, error: undefined }]);
  });
  it("run stopped at an approval: the tool row carries the error text", () => {
    const [t] = deriveActivity(RUN_APPROVAL()) as any[];
    expect(t).toMatchObject({ status: "error", durationS: 1.155 });
    expect(t.error).toContain("BLOCKED");
  });
  it("chat: the tool is done with no duration (A-11); commentary shows only when not already streamed", () => {
    expect(deriveActivity(CHAT())).toMatchObject([{ name: "terminal", status: "done", durationS: undefined }]);
    const s = reduce(initialTranscript(), { event: "message.interim", data: { text: "vou olhar", already_streamed: false, seq: 0 } });
    expect(deriveActivity(s)).toEqual([{ kind: "commentary", id: expect.any(String), text: "vou olhar" }]);
  });
});

describe("deriveTerminal", () => {
  it("run: command from the preview, output and exit code from the JSON result", () => {
    expect(deriveTerminal(RUN())).toEqual([{ id: expect.any(String), command: "printf luvebot-real-tool-frame", status: "done", durationS: 0.091, output: "luvebot-real-tool-frame", exitCode: 0 }]);
  });
  it("run blocked at an approval: Hermes cut the preview (not valid JSON), so it shows as plain text", () => {
    const [t] = deriveTerminal(RUN_APPROVAL());
    expect(t).toMatchObject({ command: "rm -rf /tmp/luvebot-approval-canary", status: "error" });
    expect(t.exitCode).toBeUndefined(); // truncated by Hermes ("..."): no guessing
    expect(t.output).toContain("BLOCKED");
  });
  it("chat: command from args, no output (the chat completion carries none)", () => {
    const [t] = deriveTerminal(CHAT());
    expect(t.command).toBe("printf luvebot-real-tool-frame");
    expect(t.output).toBeUndefined();
  });
  it("a non-JSON result is plain text; other tools are not terminal", () => {
    let s = initialTranscript();
    s = reduce(s, { event: "tool.started", data: { tool: "terminal", preview: "ls", seq: 0 } });
    s = reduce(s, { event: "tool.completed", data: { tool: "terminal", preview: "a.txt\nb.txt", error: false, seq: 1 } });
    s = reduce(s, { event: "tool.started", data: { tool: "web_search", preview: "x", seq: 2 } });
    expect(deriveTerminal(s)).toMatchObject([{ command: "ls", output: "a.txt\nb.txt" }]);
  });
});

describe("deriveFiles", () => {
  const start = (tool_name: string, args: Record<string, unknown> | undefined, seq: number) =>
    ({ event: "tool.started", data: { tool_name, args, message_id: "m", seq } }) as Frame;

  it("real frames only have the terminal tool: no file rows", () => {
    for (const s of [RUN(), CHAT(), RUN_APPROVAL()]) expect(deriveFiles(s)).toEqual([]);
  });

  it("read_file, write_file and patch give path and operation from args.path (chat surface)", () => {
    const s = [
      start("read_file", { path: "/a/b.txt" }, 1),
      start("write_file", { path: "/c.md", content: "x" }, 2),
      start("patch", { path: "/d.py", old_string: "a", new_string: "b" }, 3),
    ].reduce(reduce, initialTranscript());
    expect(deriveFiles(s).map((f) => [f.op, f.path])).toEqual([["read", "/a/b.txt"], ["write", "/c.md"], ["write", "/d.py"]]);
  });

  it("search_files (directory), terminal and unknown names do not become file rows", () => {
    const s = [start("search_files", { path: "/src" }, 1), start("terminal", { path: "/x" }, 2), start("constructor", { path: "/y" }, 3)]
      .reduce(reduce, initialTranscript());
    expect(deriveFiles(s)).toEqual([]);
  });

  it("run surface (no args, only a preview): the path is NOT guessed from the preview", () => {
    let s = initialTranscript();
    s = reduce(s, { event: "tool.started", data: { tool: "read_file", preview: "/etc/hosts", seq: 0 } });
    s = reduce(s, { event: "tool.completed", data: { tool: "read_file", preview: "127.0.0.1 localhost", error: false, seq: 1 } });
    expect(deriveFiles(s)).toEqual([]);
  });

  it("the tool result becomes a text preview when there is one", () => {
    let s = reduce(initialTranscript(), start("read_file", { path: "/a.txt" }, 1));
    s = reduce(s, { event: "tool.completed", data: { tool_name: "read_file", preview: "<b>oi</b>", message_id: "m", seq: 2 } });
    expect(deriveFiles(s)).toMatchObject([{ path: "/a.txt", preview: "<b>oi</b>", status: "done" }]);
  });

  it("the Arquivos tab lists them as text", () => {
    const s = [start("read_file", { path: "/a/<b>.txt" }, 1)].reduce(reduce, initialTranscript());
    const { container } = render(<WorkPanel items={s.items} />);
    fireEvent.click(screen.getByRole("tab", { name: "Arquivos" }));
    expect(screen.getByText("/a/<b>.txt")).toBeTruthy();
    expect(screen.getByText("lido")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("WorkPanel", () => {
  it("empty: honest message on each tab", () => {
    render(<WorkPanel items={[]} />);
    expect(screen.getByText(/Nada aconteceu ainda/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByText(/Nenhum comando de terminal/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Arquivos" }));
    expect(screen.getByText(/Nenhuma ferramenta de arquivo/)).toBeTruthy();
  });

  it("run: Atividade, Terminal as mono text, Arquivos stays honestly empty", () => {
    const { container } = render(<WorkPanel items={RUN().items} />);
    expect(screen.getByText("terminal")).toBeTruthy();
    expect(screen.getByText("0.1s")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(container.querySelector("pre")!.textContent).toBe("$ printf luvebot-real-tool-frame");
    expect(screen.getByText("luvebot-real-tool-frame")).toBeTruthy();
    expect(screen.getByText(/saída 0 · 0\.1s/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Arquivos" }));
    expect(screen.getByText(/Nenhuma ferramenta de arquivo/)).toBeTruthy();
  });

  it("chat: Terminal says there is no output on this channel", () => {
    render(<WorkPanel items={CHAT().items} />);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(screen.getByText("sem saída registrada neste canal")).toBeTruthy();
  });

  it("hostile agent text stays text in every tab", () => {
    let s = initialTranscript();
    s = reduce(s, { event: "tool.started", data: { tool: "terminal", preview: "<img src=x onerror=1>", seq: 0 } });
    s = reduce(s, { event: "tool.completed", data: { tool: "terminal", preview: '{"output":"<script>1</script>","exit_code":1}', error: true, seq: 1 } });
    const { container } = render(<WorkPanel items={s.items} />);
    for (const name of ["Atividade", "Terminal", "Arquivos"]) {
      fireEvent.click(screen.getByRole("tab", { name }));
      expect(container.querySelector("img,script,a")).toBeNull();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    expect(container.textContent).toContain("<script>1</script>");
  });
});

describe("Conversation layout", () => {
  const stream = () => new Response(new ReadableStream({ start(c) { c.enqueue(readFileSync(path.join(ROOT, "harness/evidence/t08/run-stream.sse"))); c.close(); } }));
  const wire = () => setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "d", auth_mode: "gated" };
    if (url.endsWith("/sessions")) return { session: { id: "s" } };
    if (init?.method === "POST") return { run: { id: "run_1", status: "started" } };
    return { run: { id: "run_1", status: "completed" } };
  });
  const original = window.matchMedia;
  afterEach(() => { window.matchMedia = original; });

  it("wide: the panel sits beside the conversation and fills from the stream", async () => {
    wire();
    render(<Conversation bot={{ name: "v" }} fetcher={async () => stream()} />);
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "oi" } });
    fireEvent.click(screen.getByText("Enviar"));
    await screen.findByText("Concluído");
    const panel = screen.getByLabelText("Painel de trabalho");
    expect(within(panel).getByText("0.1s")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("tab", { name: "Terminal" }));
    expect(within(panel).getByText("luvebot-real-tool-frame")).toBeTruthy();
    expect(screen.queryByText("Painel de trabalho", { selector: "button" })).toBeNull();
  });

  it("phone: no column; a button opens the panel as a drawer", async () => {
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as any;
    wire();
    render(<Conversation bot={{ name: "v" }} fetcher={async () => stream()} />);
    expect(screen.queryByRole("tablist")).toBeNull();
    const open = screen.getByRole("button", { name: "Painel de trabalho" });
    expect(open.textContent).toBe("Painel"); // short on a phone, so the Bot's status fits beside it
    fireEvent.click(open);
    const drawer = screen.getByRole("dialog", { name: "Painel de trabalho" });
    expect(within(drawer).getByRole("tablist")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: /Voltar para a conversa/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
