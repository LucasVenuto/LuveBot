// tests/unit/transcript/cards.test.tsx
// One test per card, fed by the real Hermes frames in tests/contract/frames.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  MessageCard, ToolCard, SubagentCard, CommentaryCard, CheckpointCard, ErrorCard,
  parseSse, toolFromFrame, commentaryFromFrame, messageFromFrame,
} from "@/components/transcript";

const frame = (rel: string) =>
  parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames", rel), "utf8"));

describe("transcript cards (real frames)", () => {
  it("MessageCard: assistant.completed content", () => {
    const f = frame("chat/assistant.completed.sse");
    render(<MessageCard who="Bot" text={messageFromFrame(f)} />);
    expect(screen.getByText("Harness model response")).toBeTruthy();
  });

  it("ToolCard: tool.started (chat and run streams) shows name and preview, expands to args", () => {
    for (const rel of ["chat/tool.started.sse", "run/tool.started.sse"]) {
      const { unmount } = render(<ToolCard {...toolFromFrame("tool.started", frame(rel))} />);
      expect(screen.getByText("terminal")).toBeTruthy();
      expect(screen.getByText("printf luvebot-real-tool-frame")).toBeTruthy();
      unmount();
    }
    render(<ToolCard {...toolFromFrame("tool.started", frame("chat/tool.started.sse"))} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector("pre")!.textContent).toContain('"command": "printf luvebot-real-tool-frame"');
  });

  it("ToolCard: tool.completed is done, tool.failed is error", () => {
    expect(toolFromFrame("tool.completed", frame("chat/tool.completed.sse")).status).toBe("done");
    const failed = toolFromFrame("tool.failed", frame("chat/tool.failed.sse"));
    expect(failed.status).toBe("error");
    render(<ToolCard {...failed} />);
    expect(screen.getByText("✕")).toBeTruthy();
  });

  it("SubagentCard: goal, summary and open-session callback", () => {
    const open = vi.fn();
    render(<SubagentCard goal="Pesquisar" status="completed" summary="**feito**" costUsd={0.0123} childSessionId="s1" onOpenSession={open} />);
    expect(screen.getByText("Pesquisar")).toBeTruthy();
    expect(screen.getByText("feito").tagName).toBe("STRONG");
    expect(screen.getByText(/0\.0123/)).toBeTruthy();
    fireEvent.click(screen.getByText("ver sessão"));
    expect(open).toHaveBeenCalledWith("s1");
  });

  it("CommentaryCard: assistant.commentary text", () => {
    const f = frame("chat/assistant.commentary.sse");
    render(<CommentaryCard text={commentaryFromFrame(f)} />);
    expect(screen.getByText("Testing the local tool.")).toBeTruthy();
  });

  it("CheckpointCard: progress", () => {
    render(<CheckpointCard done={3} total={4} review={1} />);
    expect(screen.getByText(/3 de 4 · 1 para revisar/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("75");
  });

  // ApprovalCard (visual only) was replaced by chat/InlineApproval (real decision): tests/unit/chat/inline-approval.test.tsx

  it("ErrorCard: alert with message and copy-id", () => {
    render(<ErrorCard message="falhou" id="run_1" />);
    expect(screen.getByRole("alert").textContent).toContain("falhou");
    expect(screen.getByText("copiar ID")).toBeTruthy();
  });
});
