// tests/unit/conversation/history-steer.test.tsx
// A steer is a message sent INTO a run (a denial's reason, a worker's note, a parent model's guidance). Hermes stores it as a `user` row, but nobody typed it (contract v0.11 section 8, A-209, R-14): it never opens a turn and is never
// a person's bubble (its place in the history is between a message and the answer to it: a turn opened there took the answer away from the message), and it is NOT hidden (the model reads it as the user's words, so the person sees
// it): a note inside the turn, "Orientação enviada ao Bot", its text through the prose renderer. The other shape of the same send, a `user` row with no kind that starts with the fixed frame `[luvebot:deny] `, is the same note.
// It still closes a skill draft's span (A-183). No invisible character is written in this file: every one is built from its code point.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, within, configure } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { STEER_FRAME, rowsOfLive, turnsFromHistory } from "@/components/chat/history";
import type { Turn } from "@/components/chat/useConversation";
import { initialTranscript } from "@/lib/stream";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { HistoryMessage } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const DENY = STEER_FRAME + "A pessoa negou a ação que você acabou de pedir e disse: não apague essa pasta\n[luvebot:ref 0123456789abcdef]";
let n = 0;
const row = (role: HistoryMessage["role"], text: string, extra: Partial<HistoryMessage> = {}): HistoryMessage => ({ id: ++n, role, text, ...extra });
const typed = (text: string) => row("user", text);
const bot = (text: string) => row("assistant", text);
const steer = (text = DENY) => row("user", text, { display_kind: "steer" });
const framed = (text = DENY) => row("user", text);                                          // no kind: the shape of a steer that landed after the run's last answer
const terminal = (output: string) => row("tool", output, { tool_name: "terminal" });
const marker = () => row("user", "", { display_kind: "skill_draft" });
const show = (rows: HistoryMessage[]) => render(<Conversation bot={BOT} initialTurns={turnsFromHistory(rows)} />);
const notes = () => screen.queryAllByTestId("steer-note");
const cp = (...c: number[]) => String.fromCodePoint(...c);

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); n = 0; setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "basic:ceo", auth_mode: "gated" } : {})); });
afterEach(() => setCustomFetchJSON(null));

describe("a steer between the next message and its answer (the denial that outlived its run)", () => {
  const rows = () => [typed("primeira"), bot("Resposta 1."), typed("segunda"), steer(), bot("Testing the local tool."), terminal('{"output": "ok"}'), bot("Resposta 2.")];

  it("is ONE turn for the message: the person's words, the answer and the note (it was two turns, and the answer hung under the steer's line)", () => {
    const turns = turnsFromHistory(rows());
    expect(turns.map((t) => t.user)).toEqual(["primeira", "segunda"]);
    expect(turns[1].steers).toEqual([DENY]);
    expect(turns[1].state.items.filter((i) => i.kind === "message").length).toBeGreaterThan(0);
    expect(JSON.stringify(turns[1].state.items)).toContain("Resposta 2.");
  });

  it("on screen: the bubble of the message, its answer and the note; no bubble of the person carries the marker", () => {
    show(rows());
    const turn = document.querySelectorAll("[data-turn]")[1] as HTMLElement;
    expect(within(turn).getByText("segunda")).toBeTruthy();
    expect(turn.textContent).toContain("Resposta 2.");
    const note = within(turn).getByTestId("steer-note");
    expect(note.textContent).toContain("Orientação enviada ao Bot");
    expect(note.textContent).toContain("A pessoa negou a ação que você acabou de pedir");
    expect(note.textContent).toContain("[luvebot:ref 0123456789abcdef]");                       // all of it, the tag included: nothing hidden
    for (const el of screen.getAllByText(/\[luvebot:deny\]/)) expect(el.closest("[data-testid=steer-note]")).not.toBeNull();   // the marker is only ever inside a note
    expect(document.querySelectorAll("[data-turn]")).toHaveLength(2);
  });

  it("the note carries no row of its own: the message keeps its row and the answer its last row", () => {
    const turns = turnsFromHistory(rows());
    expect(turns[1].userRow?.id).toBe(3);
    expect(turns[1].replyRow?.id).toBe(7);
  });

  it("in English", () => {
    setLuveLocale("en");
    show(rows());
    expect(notes()[0].textContent).toContain("Guidance sent to the Bot");
  });
});

describe("a steer in the middle of a run, with tool rows around it", () => {
  it("stays in the one turn: both outputs, the answer and the note", () => {
    const turns = turnsFromHistory([typed("rode isso"), bot("Executando."), terminal('{"output": "um"}'), steer("mude o rumo"), terminal('{"output": "dois"}'), bot("Pronto.")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].steers).toEqual(["mude o rumo"]);
    expect(turns[0].state.items.filter((i) => i.kind === "tool")).toHaveLength(2);
    expect(JSON.stringify(turns[0].state.items)).toContain("Pronto.");
  });
});

describe("the other shape of the same send: a plain `user` row that starts with the fixed frame", () => {
  it("is the same note, not a bubble, and its whole text (the tag too) is in it", () => {
    const turns = turnsFromHistory([typed("rode isso"), bot("Feito."), framed(), bot("Entendi.")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].steers).toEqual([DENY]);
    show([typed("rode isso"), bot("Feito."), framed(), bot("Entendi.")]);
    expect(notes()).toHaveLength(1);
    expect(notes()[0].textContent).toContain("[luvebot:ref 0123456789abcdef]");
  });

  it("only at the START of the text: the person's own message that quotes the frame later is still a message", () => {
    const turns = turnsFromHistory([typed("olha isto: " + STEER_FRAME + "x"), bot("ok")]);
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toContain("olha isto");
    expect(turns[0].steers).toBeUndefined();
  });

  it("only a row with NO kind: a row of a kind of its own (the draft's placeholder) that happens to hold that text keeps being what its kind says", () => {
    const turns = turnsFromHistory([typed("a"), bot("b"), row("user", DENY, { display_kind: "skill_draft" }), bot("c")]);
    expect(turns).toHaveLength(2);
    expect(turns[1].skillDraft).toBe(true);
    expect(turns.every((t) => t.steers === undefined)).toBe(true);
  });
});

describe("a skill draft: a steer right after its placeholder still closes the span (A-183)", () => {
  const BODY = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the report.";
  const rows = () => [marker(), steer("mude o rumo"), bot("```luve-skill\n" + BODY + "\n```")];

  it("no card (the answer after the boundary is not the draft's), and the note is in a turn of its own", () => {
    const turns = turnsFromHistory(rows());
    expect(turns).toHaveLength(2);
    expect(turns[0].skillDraft).toBe(true);
    expect(turns[1].steers).toEqual(["mude o rumo"]);
    show(rows());
    expect(screen.queryByTestId("skill-draft-card")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Pedir de novo" }).length).toBeGreaterThan(0);
    expect(notes()).toHaveLength(1);
  });
});

describe("what did not change", () => {
  it("a person's message still opens a turn, with no note", () => {
    const turns = turnsFromHistory([typed("a"), bot("b"), typed("c"), bot("d")]);
    expect(turns.map((t) => t.user)).toEqual(["a", "c"]);
    expect(turns.every((t) => t.steers === undefined)).toBe(true);
  });

  it("the live turns are matched with a history that holds a steer (rowsOfLive): each keeps ITS rows", () => {
    const history = [typed("A"), bot("resposta A"), typed("B"), steer(), bot("resposta B")];
    const live = (id: number, user: string): Turn => ({ id, user, state: initialTranscript(), stopping: false, errors: [], confirmed: "completed" });
    const found = rowsOfLive([live(10, "A"), live(11, "B")], history);
    expect(found.get(10)).toEqual({ userRow: expect.objectContaining({ id: 1 }), replyRow: expect.objectContaining({ id: 2 }) });
    expect(found.get(11)).toEqual({ userRow: expect.objectContaining({ id: 3 }), replyRow: expect.objectContaining({ id: 5 }) });
  });
});

describe("the note's text is prose (R-2): the refuse class is a token, the mark class stays", () => {
  it("a bidi override in a steer is [U+202E]; a ZWNJ of a Persian word stays", () => {
    const RLO = cp(0x202e), ZWNJ = cp(0x200c), word = "می" + ZWNJ + "خواهم";
    show([typed("a"), steer("orienta" + RLO + "cao " + word)]);
    const text = notes()[0].textContent!;
    expect(text).toContain("orienta[U+202E]cao");
    expect(text).toContain(word);
    expect(text).not.toContain(RLO);
  });
});
