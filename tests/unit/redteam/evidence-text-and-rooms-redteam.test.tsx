// tests/unit/redteam/evidence-text-and-rooms-redteam.test.tsx (Lume, 30/10): F-E6 after the decision A-171 (contract v0.10 §3.1, "Not a delivery"): the WHOLE luve-evidence card is evidence, the TEXT of
// every item (all five headers, with or without a source) as much as the source, and the file cards of the rooms read it the same way as the conversation. Written against the behavior, so it holds
// for any fix; it is red on f6f9b3f and green once `citedFiles` reads only what is outside a block that IS a card (the Vitral's patch over evidence-source-not-delivered-redteam).
// Three groups: (1) what must NOT become a file card (item text at each header, the contract's own `done:` example, a code span with spaces, a card full of paths) on the three surfaces of the
// conversation; (2) what must KEEP its card, which is the guard against a fix that tears out any `luve-evidence` text by pattern: a refused, open, double, oversized, wrongly-named or nested block
// is ordinary code, prose before and after a real card keeps its card, and the two halves around a card never join into one path; (3) the rooms (RoomFiles.MemberFiles, the second reader).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { RoomsView } from "@/components/rooms/RoomsView";
import { citedFiles } from "@/components/conversation/FileCard";
import { initialTranscript } from "@/lib/stream/reducer";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Turn } from "@/components/chat/useConversation";
import type { Room, RoomEvent } from "@/api/types";

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const FENCE = "```";
const BLOCK = (body: string) => `${FENCE}luve-evidence\n${body}\n${FENCE}`;
const HEADERS = ["facts", "assumptions", "done", "awaiting", "questions"] as const;
const IN_TEXT = "Salvei o resumo em out/resumo.md";
const turn = (text: string): Turn => ({
  id: 1, user: "Como foi o mês?", stopping: false, errors: [], confirmed: "completed",
  state: { ...initialTranscript(), status: "completed" as any, items: [{ kind: "message", id: "m1", text }] as any },
});

beforeEach(() => { cleanup(); setCustomFetchJSON(async () => ({ rules: [] })); });
afterEach(() => { setCustomFetchJSON(null); vi.restoreAllMocks(); });

// The three places a delivered file shows up in a conversation, read from what is on the screen.
const card = () => screen.queryByRole("button", { name: "Baixar resumo.md" });
const menuItem = () => { fireEvent.click(screen.getByRole("button", { name: "Mais ações desta mensagem" })); return within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Baixar resumo.md" }); };
const delivered = () => { const panel = within(screen.getByLabelText("Painel de trabalho")); fireEvent.click(panel.getByRole("tab", { name: "Arquivos" })); return panel.queryByRole("region", { name: "Entregues na conversa" }); };
const eachHeader = (surface: () => unknown, extra = "") => {
  for (const h of HEADERS) {
    const r = render(<Conversation bot={BOT} initialTurns={[turn("Fechei o mês.\n" + BLOCK(`${h}:\n- ${IN_TEXT}${extra}`))]} />);
    expect(surface(), `the text of an item under ${h}:`).toBeNull();
    r.unmount();
  }
};

describe("(1) nothing inside a card is a delivered file: the item TEXT, at each of the five headers", () => {
  it("the reading: a path in the text of an item (no source at all) is not a cited file, under every header", () => {
    for (const h of HEADERS) expect(citedFiles("Fechei o mês.\n" + BLOCK(`${h}:\n- ${IN_TEXT}`)), h).toEqual([]);
  });
  it("the reading: text AND source both naming a file, under every header, still none", () => {
    for (const h of HEADERS) expect(citedFiles(BLOCK(`${h}:\n- ${IN_TEXT} | source: out/fonte.csv`)), h).toEqual([]);
  });
  it("the contract's own example, a `done:` item that says it made a page, and a code span with spaces in an item", () => {
    expect(citedFiles(BLOCK("done:\n- Gerei o resumo em pages/vendas.md"))).toEqual([]);
    expect(citedFiles(BLOCK("done:\n- Salvei em `relatório final.md`\nfacts:\n- Li `crm/mês de setembro.csv` | source: `crm/setembro.csv`"))).toEqual([]);
  });
  it("a card with a path in every header, in the text and in the source, gives no cited file at all", () => {
    const body = HEADERS.map((h, i) => `${h}:\n- Item ${i} em out/a${i}.md | source: out/s${i}.csv\n- ${IN_TEXT}`).join("\n");
    expect(citedFiles(BLOCK(body))).toEqual([]);
  });
  it("a card indented up to three spaces and one with CRLF line ends is a card all the same", () => {
    expect(citedFiles(`  ${FENCE}luve-evidence\nfacts:\n- ${IN_TEXT}\n  ${FENCE}`)).toEqual([]);
    expect(citedFiles(BLOCK(`facts:\n- ${IN_TEXT}\ndone:\n- Gerei out/b.md`).replace(/\n/g, "\r\n"))).toEqual([]);
  });

  it("the card on the screen: no Baixar button for the text of an item, at any header", () => { eachHeader(card); });
  it("the menu: no Baixar item in the '...' menu for the text of an item, at any header", () => { eachHeader(menuItem); });
  it("the tab: no 'Entregues na conversa' region for the text of an item, at any header", () => { eachHeader(delivered); });
  it("the card itself still shows the item as text, with the path in it (nothing was hidden to get here)", () => {
    render(<Conversation bot={BOT} initialTurns={[turn("Fechei o mês.\n" + BLOCK(`done:\n- ${IN_TEXT}`))]} />);
    expect(screen.getByText(new RegExp(IN_TEXT))).toBeTruthy();
  });
});

describe("(2) what stays a file card (the guard against taking out too much)", () => {
  it("prose before and after a real card keeps its cards; the card's own paths add none; the same file in both is one", () => {
    expect(citedFiles(`Salvei em out/antes.md\n${BLOCK("done:\n- Gerei out/dentro.md | source: out/fonte.csv")}\nE também out/depois.md`)).toEqual(["out/antes.md", "out/depois.md"]);
    expect(citedFiles(`Entreguei out/resumo.md\n${BLOCK(`done:\n- ${IN_TEXT}`)}`)).toEqual(["out/resumo.md"]);
  });
  it("the two halves around a card never join into one path or one code span", () => {
    expect(citedFiles(`veja out/\n${BLOCK("facts:\n- x")}\nresumo.md fim`)).toEqual(["resumo.md"]);
    expect(citedFiles(`veja \`out/\n${BLOCK("facts:\n- x")}\nr.md\` fim`)).toEqual(["r.md"]);
  });

  const KEEPS: Array<[string, string]> = [
    ["an unknown header", `facts:\n- ${IN_TEXT}\nnotes:\n- x`],
    ["a header with no items", `facts:\n- ${IN_TEXT}\ndone:`],
    ["two source marks in one item", `facts:\n- ${IN_TEXT} | source: a | source: b`],
    ["a nested or continuation line", `facts:\n- ${IN_TEXT}\n  - filho`],
    ["a 13th item", `facts:\n- ${IN_TEXT}\n${Array.from({ length: 12 }, (_, i) => `- item ${i}`).join("\n")}`],
    ["a body over 8 KiB (blank lines count)", `facts:\n- ${IN_TEXT}${"\n".repeat(9000)}`],
  ];
  for (const [what, body] of KEEPS) {
    it(`a refused block (${what}) is ordinary code: its path keeps the card`, () => { expect(citedFiles(BLOCK(body))).toEqual(["out/resumo.md"]); });
  }
  it("an open block (still streaming) and two blocks in one message are ordinary code: their paths keep the card", () => {
    expect(citedFiles(`${FENCE}luve-evidence\nfacts:\n- ${IN_TEXT}`)).toEqual(["out/resumo.md"]);
    expect(citedFiles(`${BLOCK(`facts:\n- ${IN_TEXT}`)}\n${BLOCK("done:\n- x")}`)).toEqual(["out/resumo.md"]);
  });
  it("a fence that is not exactly `luve-evidence` (another info string, another case, a tilde fence) or a card nested in another fence is ordinary code", () => {
    const body = `facts:\n- ${IN_TEXT}`;
    for (const open of [`${FENCE}luve-evidence extra`, `${FENCE}Luve-Evidence`, `${FENCE}luve-evidences`, `${FENCE}evidence`]) {
      expect(citedFiles(`${open}\n${body}\n${FENCE}`), open).toEqual(["out/resumo.md"]);
    }
    expect(citedFiles(`~~~luve-evidence\n${body}\n~~~`)).toEqual(["out/resumo.md"]);
    expect(citedFiles(`${FENCE}\`\nexemplo:\n${BLOCK(body)}\n${FENCE}\``)).toEqual(["out/resumo.md"]);
  });
  it("a refused block on the screen still gets its Baixar card", () => {
    render(<Conversation bot={BOT} initialTurns={[turn(BLOCK(`facts:\n- ${IN_TEXT}\nnotes:\n- x`))]} />);
    expect(card()).not.toBeNull();
  });
});

// (3) The rooms read the same function: MemberFiles (a member's message, from its AUTHOR Bot).
const ROOM: Room = {
  id: "r1", name: "Lançamento", created_at: "2026-10-01T00:00:00Z", driver: { running: false, pending_actions_count: 0 },
  members: [{ member_id: "m1", bot: "vendas", handle: "vendas", display_name: "Vendas" }, { member_id: "m2", bot: "dev", handle: "dev", display_name: "Dev" }],
};
const at = "2026-10-01T01:00:00Z";
const said = (seq: number, text: string): RoomEvent => ({ seq, event_id: `m:${seq}`, kind: "message.member", actor: { kind: "member", id: "m1" }, payload: { text }, at, author_bot: "vendas" });

describe("(3) the rooms: a member's message reads the same way", () => {
  let log: RoomEvent[];
  let authed: string[];
  beforeEach(() => {
    resetCsrfToken(); setLuveLocale("pt"); log = []; authed = [];
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "tok", actor: "basic:ceo", auth_mode: "gated" };
      if (url.includes("/rooms/r1/log")) return { events: log };
      if (url.endsWith("/rooms/r1")) return { room: ROOM };
      if (url.includes("/handoffs")) return { handoffs: [] };
      throw new Error(`unexpected ${url}`);
    });
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async (url: string) => { authed.push(url); return new Response(new Blob(["x"]), { status: 200 }); } };
    (URL as any).createObjectURL = () => "blob:luvebot/1";
    (URL as any).revokeObjectURL = () => {};
  });
  afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; });
  const open = async () => { render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />); await screen.findByRole("heading", { name: "Lançamento" }); };

  it("a path only in a card (the text of an item under each header, and a source) gets no Baixar card and fetches nothing", async () => {
    log = HEADERS.map((h, i) => said(i + 1, `Fechei.\n${BLOCK(`${h}:\n- Item em out/h${i}.md | source: out/s${i}.csv\n- ${IN_TEXT}`)}`));
    await open();
    await screen.findAllByText(new RegExp(IN_TEXT));       // the cards are drawn: the messages are on the screen
    expect(screen.queryAllByRole("button", { name: /^Baixar / })).toHaveLength(0);
    expect(authed).toHaveLength(0);
  });
  it("a path in the member's prose, outside the card, keeps its card and downloads from the AUTHOR Bot", async () => {
    log = [said(1, `Entreguei out/resumo.md\n${BLOCK(`done:\n- Gerei out/dentro.md | source: out/fonte.csv`)}`)];
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Baixar resumo.md" }));
    await waitFor(() => expect(authed).toHaveLength(1));
    expect(authed[0]).toBe("/api/plugins/luvebot/bots/vendas/files/download?path=out%2Fresumo.md&profile=current");
    expect(screen.queryByRole("button", { name: "Baixar dentro.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Baixar fonte.csv" })).toBeNull();
  });
  it("a refused block in a member's message is ordinary code and keeps its card", async () => {
    log = [said(1, BLOCK(`facts:\n- ${IN_TEXT}\nnotes:\n- x`))];
    await open();
    expect(await screen.findByRole("button", { name: "Baixar resumo.md" })).toBeTruthy();
  });
});
