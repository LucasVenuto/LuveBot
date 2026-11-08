// tests/unit/redteam/skill-draft-reload-redteam.test.tsx
// Red team (Lume, 31/10) of SK-5b (49e6a3a) and A-185 (900f344): the card "Rascunho pronto" bound to its answer by STRUCTURE after a reload (contract v0.11 3.2 step 2, A-183).
// A battery of 15 defects planted in `turnsFromHistory` (the seal, the count, where each kind of row goes) against the Vitral's five test files: 7 died at once, 3 are EQUIVALENT
// (a placeholder, a `steer` row and a typed row each open a turn of their own, which clears the seal, so the seal is redundant for them), 1 is equivalent in effect (the count of a span
// with no message is never read) and 4 SURVIVED because nothing asserted them. They are closed here, as plain tests (the code is right; the tests were missing):
//   - an assistant row with tool calls and NO text, and the rows of other tools, between the placeholder and the fence (what a Bot that looked something up before answering leaves in
//     Hermes's history) are not Bot messages: still ONE message, still the card; an empty row counted as a message would deny the card to every draft that was preceded by a tool;
//   - after a boundary, a terminal row, a delegation row and a helper's delivery go to a turn of THEIR OWN, never into the draft's (the Terminal and the helper's card of the later turn
//     are not the draft's, and the draft's turn keeps exactly its one message).
// CLOSED by R-1 of A-188 (the acceptance of the renderer on the surface A-185 opened; the two tests below were `it.fails`): a draft REFUSED for a hidden character is drawn as an ordinary message,
// and the renderer used to draw that character raw. Measured in Chrome 156 (evidence/r3): a bidi isolate or override in what a Bot writes reorders what the person reads. The message now shows each
// hidden character as `[U+XXXX]` (inside code both classes, in prose the refuse class: A-188).
// NOT claimed: the prose a Bot writes AROUND a valid fence is not drawn when the card is (the card is the whole message; `extractSkillDraft` reads only the fence): the person never sees a
// warning the Bot put beside the draft, and a hostile text beside it never shows either. Info.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, configure } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { DELEGATE_TOOL } from "@/components/conversation/delegate";
import { TERMINAL_TOOL } from "@/components/conversation/derive";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { HistoryMessage } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const BODY = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the report.\n2. Send it.";
const FENCE = "```luve-skill\n" + BODY + "\n```";
let n = 0;
const row = (role: HistoryMessage["role"], text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({ id: ++n, role, text, ...extra });
const marker = () => row("user", "", { display_kind: "skill_draft" });
const bot = (text: string, extra: Partial<HistoryMessage> = {}) => row("assistant", text, extra);
const hidden = () => row("user", "nota interna do canal", { display_kind: "hidden" });
const delivery = () => row("user", "[ASYNC DELEGATION deleg_abc] o ajudante terminou", { display_kind: "async_delegation_complete", display_metadata: { delegation_id: "deleg_abc" } });
const terminal = () => row("tool", JSON.stringify({ output: "ok", exit_code: 0 }), { tool_name: TERMINAL_TOOL });
const delegation = () => row("tool", JSON.stringify({ status: "dispatched", delegation_id: "deleg_abc", goal: "resumir" }), { tool_name: DELEGATE_TOOL });
const show = (rows: HistoryMessage[]) => render(<Conversation bot={BOT} initialTurns={turnsFromHistory(rows)} />);
const kinds = (turn: { state: { items: readonly { kind: string }[] } }) => turn.state.items.map((i) => i.kind);

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); n = 0; setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "basic:ceo", auth_mode: "gated" } : {})); });
afterEach(() => setCustomFetchJSON(null));

describe("what a Bot that looked something up leaves in the history is not a second message", () => {
  it("an assistant row with tool calls and no text, and a row of another tool, before the fence: ONE message, the card, no 'ask again'", () => {
    show([marker(), bot("", { tool_calls: [{ name: "memory", args_summary: null }] }), row("tool", JSON.stringify({ ok: true }), { tool_name: "memory" }), bot(FENCE)]);
    expect(screen.queryByTestId("skill-draft-card")!.textContent).toContain("Rascunho pronto, 6 linhas");
    expect(screen.queryAllByRole("button", { name: "Pedir de novo" })).toHaveLength(0);
  });

  it("several of them in a row (a Bot that used three tools), then the fence: still the card", () => {
    show([marker(), bot("", { tool_calls: [{ name: "a", args_summary: null }] }), row("tool", "{}", { tool_name: "a" }), bot("", { tool_calls: [{ name: "b", args_summary: null }] }), row("tool", "{}", { tool_name: "b" }), bot(FENCE)]);
    expect(screen.queryByTestId("skill-draft-card")).not.toBeNull();
  });

  it("an empty row AFTER the fence does not make it two messages either", () => {
    show([marker(), bot(FENCE), bot("")]);
    expect(screen.queryByTestId("skill-draft-card")).not.toBeNull();
  });
});

describe("after a boundary, the rows that are not messages go to a turn of their own", () => {
  it("a terminal row after a `hidden` row is not in the draft's turn", () => {
    const [draft, after, ...rest] = turnsFromHistory([marker(), bot(FENCE), hidden(), terminal()]);
    expect(rest).toHaveLength(0);
    expect(kinds(draft)).toEqual(["message"]);
    expect(kinds(after)).toEqual(["tool"]);
  });

  it("a delegation row after a `hidden` row is not in the draft's turn", () => {
    const [draft, after, ...rest] = turnsFromHistory([marker(), bot(FENCE), hidden(), delegation()]);
    expect(rest).toHaveLength(0);
    expect(kinds(draft)).toEqual(["message"]);
    expect(kinds(after)).toEqual(["tool"]);
  });

  it("a helper's delivery right after the fence is the helper's card in a turn of its own, and the draft's turn keeps its one message", () => {
    const [draft, after, ...rest] = turnsFromHistory([marker(), bot(FENCE), delivery()]);
    expect(rest).toHaveLength(0);
    expect(kinds(draft)).toEqual(["message"]);
    expect(kinds(after)).toEqual(["subagent"]);
  });

  it("the same three BEFORE the answer: the span is empty, and the fenced reply that follows is not the draft's", () => {
    for (const between of [hidden(), delivery()]) {
      const turns = turnsFromHistory([marker(), between, bot(FENCE)]);
      expect(turns[0].skillDraft).toBe(true);
      expect(kinds(turns[0]).includes("message")).toBe(false);                                // nothing of the answer is bound to the draft
      expect(turns.slice(1).some((t) => t.skillDraft)).toBe(false);
    }
  });
});

// ---- R-1 (A-188) acceptance on the refused draft, strict: the characters are built with String.fromCharCode, never written raw ----
const RLO = String.fromCharCode(0x202e), RLI = String.fromCharCode(0x2067), ZWSP = String.fromCharCode(0x200b);
const refusedDraft = (inside: string) => "```luve-skill\n---\nname: send-report\ndescription: Use when a report must go out" + inside + ".\n---\n1. Open the report.\n```";

describe("a refused draft drawn as an ordinary message shows what is hidden in it (A-188, R-1)", () => {
  it("inside the code block both classes are drawn as [U+XXXX], and none of the characters is in the page raw (F-R3-1)", () => {
    show([marker(), bot(refusedDraft(RLO + RLI + ZWSP))]);
    const code = document.querySelector("pre")!.textContent ?? "";
    for (const token of ["[U+202E]", "[U+2067]", "[U+200B]"]) expect(code).toContain(token);
    for (const raw of [RLO, RLI, ZWSP]) expect(document.body.textContent).not.toContain(raw);
  });

  it("in the prose around it the refuse class is drawn as [U+202E] and never raw (F-R3-1)", () => {
    show([marker(), bot("Segue o rascunho" + RLO + " revisado:\n\n" + refusedDraft(RLO))]);          // the fence is refused too, so the message is drawn whole (with a valid fence the card replaces it)
    expect(document.body.textContent).toContain("Segue o rascunho[U+202E] revisado:");
    expect(document.body.textContent).not.toContain(RLO);
  });
});
