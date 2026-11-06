// tests/unit/conversation/skill-draft-reload.test.tsx
// After a reload the history has no run id, so the card "Draft ready" is bound to its answer by STRUCTURE (contract v0.11 3.2 step 2, A-183; the Lume's observation 1 on SK-5): the span runs from the placeholder row
// to the NEXT `user` row of ANY kind (typed, steer, hidden, a helper's delivery, a channel contact) or the end; the card only for exactly ONE Bot message in the span that holds exactly ONE valid fence; every other
// case draws the Bot's messages as ordinary messages (none hidden) and offers "Pedir de novo", which it also offers when the span holds no message; what comes after the boundary is never part of the draft.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, configure } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { HistoryMessage } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const BODY = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the SECRET-STEP report.\n2. Send it.";
const FENCE = "```luve-skill\n" + BODY + "\n```";
const OTHER_FENCE = FENCE.replace("send-report", "other-skill").replace("SECRET-STEP", "SECOND-STEP");
let n = 0;
const row = (role: HistoryMessage["role"], text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({ id: ++n, role, text, ...extra });
const marker = () => row("user", "", { display_kind: "skill_draft" });
const bot = (text: string, extra: Partial<HistoryMessage> = {}) => row("assistant", text, extra);
const typed = (text: string) => row("user", text);
const hidden = () => row("user", "nota interna do canal", { display_kind: "hidden" });
const steer = () => row("user", "mude o rumo", { display_kind: "steer" });
const delivery = () => row("user", "[ASYNC DELEGATION deleg_abc] o ajudante terminou", { display_kind: "async_delegation_complete", display_metadata: { delegation_id: "deleg_abc" } });
const show = (rows: HistoryMessage[]) => render(<Conversation bot={BOT} initialTurns={turnsFromHistory(rows)} />);
const card = () => screen.queryByTestId("skill-draft-card");
const again = () => screen.queryAllByRole("button", { name: "Pedir de novo" });

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); n = 0; setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "basic:ceo", auth_mode: "gated" } : {})); });
afterEach(() => setCustomFetchJSON(null));

describe("exactly one Bot message holding exactly one valid fence: the card", () => {
  it("draws the card and offers no 'ask again'; the draft text is nowhere", () => {
    show([typed("faça o relatório"), bot("Feito."), marker(), bot(FENCE)]);
    expect(card()!.textContent).toContain("Rascunho pronto, 6 linhas");
    expect(again()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SECRET-STEP");
    expect(screen.getByText("Você pediu ao seu Bot um rascunho de skill")).toBeTruthy();
  });
  it("a typed message after it is the boundary: the card stays, and what comes after is an ordinary turn", () => {
    show([marker(), bot(FENCE), typed("obrigado"), bot("De nada.")]);
    expect(card()).not.toBeNull();
    expect(screen.getByText("obrigado")).toBeTruthy();
    expect(screen.getByText("De nada.")).toBeTruthy();
  });
});

describe("the Lume's four measured cases (every message is drawn, none disappears, and the card is not drawn)", () => {
  it("1. a message without a fence and then one with a fence: two messages, no card, both drawn, ask again", () => {
    show([marker(), bot("Vou escrever agora, um instante."), bot(FENCE)]);
    expect(card()).toBeNull();
    expect(screen.getByText(/Vou escrever agora, um instante\./)).toBeTruthy();
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("O Bot respondeu com mais de uma mensagem");
    expect(again()).toHaveLength(1);
  });

  it("2. a `hidden` user row between them closes the span: the first message has no fence (no card, ask again) and the fenced one AFTER the boundary is an ordinary message, never a draft", () => {
    show([marker(), bot("Já volto com o texto."), hidden(), bot(FENCE)]);
    expect(card()).toBeNull();
    expect(screen.getByText("Já volto com o texto.")).toBeTruthy();
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("A resposta do Bot não é um rascunho de skill.");
    expect(again()).toHaveLength(1);                                                           // only the draft's own span offers it
    expect(screen.getAllByTestId("skill-draft-refused")).toHaveLength(1);
  });

  it("3. a fence and then an ordinary message that must NOT disappear: two messages, no card, both visible", () => {
    show([marker(), bot(FENCE), bot("Qualquer dúvida é só falar. Mensagem comum 7731.")]);
    expect(card()).toBeNull();
    expect(screen.getByText(/Mensagem comum 7731\./)).toBeTruthy();
    expect(document.body.textContent).toContain("send-report");                                // the fenced message is drawn too (as ordinary text)
    expect(again()).toHaveLength(1);
  });

  it("4. a fence and then another fence: two messages, no card, both drawn, ask again", () => {
    show([marker(), bot(FENCE), bot(OTHER_FENCE)]);
    expect(card()).toBeNull();
    expect(document.body.textContent).toContain("SECOND-STEP");
    expect(document.body.textContent).toContain("SECRET-STEP");
    expect(again()).toHaveLength(1);
  });
});

describe("the boundary is a `user` row of ANY kind", () => {
  it("D. a fence, a `hidden` row, then an ordinary Bot message: the card for the first; the later message is its own ordinary turn and is not merged into the draft", () => {
    show([marker(), bot(FENCE), hidden(), bot("Mensagem depois da fronteira 5512.")]);
    expect(card()).not.toBeNull();
    expect(screen.getByText(/Mensagem depois da fronteira 5512\./)).toBeTruthy();
    expect(again()).toHaveLength(0);
    const turns = turnsFromHistory([marker(), bot(FENCE), hidden(), bot("depois")]);
    expect(turns.map((t) => [!!t.skillDraft, t.botMessages])).toEqual([[true, 1], [false, undefined]]);
  });

  it("a helper's delivery closes the span: the span is empty (ask again), and the reply with a fence that comes after it is an ordinary turn (no card)", () => {
    show([marker(), delivery(), bot(FENCE)]);
    expect(card()).toBeNull();
    expect(screen.getByTestId("skill-draft-noanswer").textContent).toContain("O Bot terminou sem escrever um rascunho.");
    expect(again()).toHaveLength(1);
    expect(document.body.textContent).toContain("send-report");                                // the fenced reply is drawn, as an ordinary message
  });

  it("a `steer` row closes it too", () => {
    show([marker(), steer(), bot(FENCE)]);
    expect(card()).toBeNull();
    expect(screen.getByTestId("skill-draft-noanswer")).toBeTruthy();
  });

  it("the helper's result AFTER a drawn draft is not part of it: the card stays and the reply it causes is an ordinary turn", () => {
    show([marker(), bot(FENCE), delivery(), bot("O ajudante terminou; resumo 9941.")]);
    expect(card()).not.toBeNull();
    expect(screen.getByText(/resumo 9941\./)).toBeTruthy();
  });
});

describe("a span with no message", () => {
  it("a run that only used tools: nothing to review, 'Pedir de novo' is offered", () => {
    show([marker(), row("tool", JSON.stringify({ output: "ok", exit_code: 0 }), { tool_name: "terminal" })]);
    expect(card()).toBeNull();
    expect(screen.getByTestId("skill-draft-noanswer")).toBeTruthy();
    expect(again()).toHaveLength(1);
  });
  it("a placeholder with nothing after it (the Bot has not answered yet)", () => {
    show([marker()]);
    expect(card()).toBeNull();
    expect(again()).toHaveLength(1);
  });
  it("two placeholders in a row: the first has no answer, the second takes the fenced one", () => {
    show([marker(), marker(), bot(FENCE)]);
    expect(card()).not.toBeNull();
    expect(screen.getAllByTestId("skill-draft-noanswer")).toHaveLength(1);
  });
});

describe("a single message that is not a valid draft", () => {
  it("no fence: ordinary, with the reason and ask again", () => {
    show([marker(), bot("Não consegui montar a skill.")]);
    expect(card()).toBeNull();
    expect(screen.getByText("Não consegui montar a skill.")).toBeTruthy();
    expect(again()).toHaveLength(1);
  });
  it("two fences in ONE message: ordinary, with the reason and ask again", () => {
    show([marker(), bot(FENCE + "\n" + OTHER_FENCE)]);
    expect(card()).toBeNull();
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("mais de um rascunho");
    expect(again()).toHaveLength(1);
  });
  it("a fence with a refused character: NONE is hidden (the message is drawn), the reason names the class, and it offers to ask again; the same as live (A-185)", () => {
    const tag = String.fromCodePoint(0xe0041);
    show([marker(), bot(FENCE.replace("Send it.", "Send it." + tag + "now"))]);
    expect(card()).toBeNull();
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("um caractere de etiqueta Unicode");
    expect(document.body.textContent).toContain("SECRET-STEP");                                // drawn as an ordinary message
    expect(again()).toHaveLength(1);
  });
  it("'Pedir de novo' opens the request dialog", () => {
    show([marker(), bot("Não deu.")]);
    fireEvent.click(again()[0]);
    expect(within(screen.getByRole("dialog")).getByText("Isto gasta uma vez do seu Bot, dentro do teto de gasto dele.")).toBeTruthy();
  });
});

describe("the history's own turns are untouched by the new boundary", () => {
  it("an ordinary conversation: hidden rows still do not open a turn, a delivery still joins the turn before it, a reply still merges", () => {
    const turns = turnsFromHistory([typed("oi"), bot("Olá."), hidden(), bot("Tudo bem?"), delivery(), typed("segue")]);
    expect(turns.map((t) => t.user)).toEqual(["oi", "segue"]);
    expect(turns.every((t) => !t.skillDraft && t.botMessages === undefined)).toBe(true);
    expect(turns[0].state.items.map((i) => i.kind)).toEqual(["message", "subagent"]);
  });
});
