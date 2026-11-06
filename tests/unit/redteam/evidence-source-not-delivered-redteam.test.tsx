// tests/unit/redteam/evidence-source-not-delivered-redteam.test.tsx (Lume, 30/10; decision F-E6 by the Architect, contract v0.10 §3.1 "Not a delivery"): the evidence fence is evidence ONLY.
// A source is "plain text, never a link ... a URL, a file name or a phrase", and the same goes for the text of an item (facts, assumptions, done, awaiting, questions): where a fact CAME FROM is not
// something the Bot DELIVERED. `citedFiles` (conversation/FileCard.tsx) reads only the text OUTSIDE a block that IS a card, so neither a source nor an item names a file that gets a "Baixar" card, a
// "Baixar" item in the reply's "..." menu, a row in the Arquivos tab's "Entregues na conversa", or a card under a member's message in a Room (RoomFiles reads the same function).
// What keeps its paths (it is not a card, so it is ordinary text or code): a path in the prose before or after the block; an ordinary code block; a block the parser refuses, one still open (streaming), two blocks.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { citedFiles } from "@/components/conversation/FileCard";
import { MemberFiles } from "@/components/rooms/RoomFiles";
import { initialTranscript } from "@/lib/stream/reducer";
import { setCustomFetchJSON } from "@/api/client";
import type { Turn } from "@/components/chat/useConversation";

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const BLOCK = (body: string) => "```luve-evidence\n" + body + "\n```";
const SOURCE_ONLY = "Fechei o mês.\n" + BLOCK("facts:\n- Vendas fechou 12 propostas | source: crm/setembro.csv");
const IN_PROSE = "Li crm/setembro.csv para isso.\n" + BLOCK("facts:\n- Vendas fechou 12 propostas | source: crm/setembro.csv");
const turn = (text: string): Turn => ({
  id: 1, user: "Como foi o mês?", stopping: false, errors: [], confirmed: "completed",
  state: { ...initialTranscript(), status: "completed" as any, items: [{ kind: "message", id: "m1", text }] as any },
});

beforeEach(() => { cleanup(); setCustomFetchJSON(async () => ({ rules: [] })); });
afterEach(() => { setCustomFetchJSON(null); vi.restoreAllMocks(); });

// The three places a delivered file shows up, read from a rendered conversation. Each is a function of the message text, so the same helper serves the control and the attack.
const card = () => screen.queryByRole("button", { name: "Baixar setembro.csv" });
const menuItem = () => { fireEvent.click(screen.getByRole("button", { name: "Mais ações desta mensagem" })); return within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Baixar setembro.csv" }); };
const delivered = () => { const panel = within(screen.getByLabelText("Painel de trabalho")); fireEvent.click(panel.getByRole("tab", { name: "Arquivos" })); return panel.queryByRole("region", { name: "Entregues na conversa" }); };
const show = (text: string) => render(<Conversation bot={BOT} initialTurns={[turn(text)]} />);

describe("F-E6: a source is where a fact came from, not a file the Bot delivered", () => {
  it("holds: the same path named in the prose OUTSIDE the block keeps its card; an ordinary code block keeps its path too", () => {
    expect(citedFiles(IN_PROSE)).toEqual(["crm/setembro.csv"]);
    expect(citedFiles("```\nnotas.md\n```")).toEqual(["notas.md"]);
  });

  it("control (so the three selectors below can be trusted): named in the prose, the path gets the card, the menu item and the Entregues row", () => {
    show(IN_PROSE);
    expect(card()).not.toBeNull();
    expect(menuItem()).not.toBeNull();
    expect(delivered()).not.toBeNull();
  });

  it("the reading: a path only in a `| source:` is not a cited file", () => { expect(citedFiles(SOURCE_ONLY)).toEqual([]); });
  it("the card: no Baixar button under the reply for a source", () => { show(SOURCE_ONLY); expect(card()).toBeNull(); });
  it("the menu: no Baixar item in the reply's '...' menu for a source", () => { show(SOURCE_ONLY); expect(menuItem()).toBeNull(); });
  it("the tab: no 'Entregues na conversa' row for a source (the tab says delivered, the Bot only said where a fact came from)", () => { show(SOURCE_ONLY); expect(delivered()).toBeNull(); });

  it.each(["facts", "assumptions", "done", "awaiting", "questions"])("the TEXT of an item under %s that names a file is not a cited file either", (header) => {
    expect(citedFiles("Pronto.\n" + BLOCK(`${header}:\n- Abri crm/setembro.csv e contei 12 propostas`))).toEqual([]);
    expect(citedFiles("Pronto.\n" + BLOCK(`${header}:\n- Abri \`relatórios/q3 final.pdf\` e contei`))).toEqual([]);
  });

  it("the screen: an item's text and a source name files, none of the three places draws a delivery", () => {
    const text = "Fechei o mês.\n" + BLOCK("facts:\n- Abri crm/setembro.csv | source: crm/setembro.csv\nawaiting:\n- Falta `crm/outubro.csv`");
    const view = show(text);
    expect(screen.queryByRole("button", { name: "Baixar setembro.csv" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Baixar outubro.csv" })).toBeNull();
    expect(menuItem()).toBeNull();
    expect(delivered()).toBeNull();
    view.unmount();
  });

  it("the prose around the block keeps its files; the block's own paths do not join them", () => {
    const before = "Gerei reports/q3.pdf.\n", after = "\nTambém salvei out/final.md.";
    expect(citedFiles(before + BLOCK("facts:\n- x | source: crm/setembro.csv") + after)).toEqual(["reports/q3.pdf", "out/final.md"]);
  });

  it("only a block that IS a card is cut: a refused block, an open one (streaming) and two blocks stay code and keep their paths", () => {
    expect(citedFiles(BLOCK("feitos:\n- crm/setembro.csv"))).toEqual(["crm/setembro.csv"]);                                       // an unknown header: all-or-nothing, so code
    expect(citedFiles(BLOCK("facts:\n- crm/setembro.csv\n  - nested"))).toEqual(["crm/setembro.csv"]);                           // nesting: refused
    expect(citedFiles("```luve-evidence\nfacts:\n- x | source: crm/setembro.csv")).toEqual(["crm/setembro.csv"]);                // not closed yet
    expect(citedFiles(SOURCE_ONLY + "\n" + BLOCK("facts:\n- y | source: crm/outubro.csv"))).toEqual(["crm/setembro.csv", "crm/outubro.csv"]);   // two blocks: none is a card
  });

  it("the Room: a member's message with a source gets no card, and one that cites the file in prose keeps it", () => {
    const event = (text: string) => ({ event_id: "e1", author_bot: "vendas", payload: { text } }) as any;
    const only = render(<MemberFiles event={event(SOURCE_ONLY)} label="Vendas" />);
    expect(only.container.innerHTML).toBe("");
    only.unmount();
    render(<MemberFiles event={event(IN_PROSE)} label="Vendas" />);
    expect(screen.queryByRole("button", { name: "Baixar setembro.csv" })).not.toBeNull();
  });
});
