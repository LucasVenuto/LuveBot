// tests/unit/redteam/evidence-wiring-redteam.test.tsx (Lume, E-5 part 2: the card and its wiring, contract v0.10 §3.2)
// What a Bot can do with the evidence card once it is on the screen. Everything PASSES today except the one `xfail(strict)` (F12); the rest pins what held:
//   * the ONLY door is BotMessageBody (a Bot message): a tool card's result, the person's own message and a commentary never become a card;
//   * an item that IMITATES the card's own parts (the count, the mismatch line, the top line, a header, a "Checked by Hermes" box) is a bullet of plain text: the real parts exist once;
//   * HTML, bidi and zero-width in a field come out as text; a source is never a link and what the copy button copies is EXACTLY what is shown; `$&` and `{x}` in a source stay literal;
//   * the count is the shell's, never the Bot's, and a screen that cannot say (a room) says nothing.
// FINDING F12 (Media, invariant 6, "the one place the card must not lie"): the card COUNTS the approvals of this conversation's runs but SAYS "No pending request in Approvals." (and "In
// Approvals now: N"): a claim about the whole box. With a pending approval of the same Bot raised by another run (a routine, another conversation, a thread), the sidebar shows it and the card
// says there is none. FIXED by e2b (contract v0.10 §3.2, cfdf3bf): every phrase of the count says "desta conversa" / "from this conversation"; the test is a plain one now, and the phrases are read from the
// dictionary (never written here) so a rewording does not break it.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, configure } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { EvidenceProvider, pendingInConversation } from "@/components/transcript/EvidenceContext";
import { BotMessageBody } from "@/components/transcript/BotSuggestion";
import { ToolCard } from "@/components/transcript/cards";
import { turnsFromHistory } from "@/components/chat/history";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { Approval } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BLOCK = (body: string) => "```luve-evidence\n" + body + "\n```";
const GOOD = BLOCK("facts:\n- Vendas fechou 12 propostas | source: crm/setembro.csv\nawaiting:\n- Enviar o resumo ao cliente X");
const pt = translations.pt, en = translations.en;
const say = (phrase: string, count: number) => phrase.replace("{count}", String(count));   // a phrase of the dictionary with its number
const OLD_GLOBAL_PT = ["Nenhum pedido pendente em Aprovações.", "Em Aprovações agora:"];                  // the wording that claimed the whole box (F12): it must never come back
const BOT = { name: "vendas", label: "Vendas" };

const approval = (run_id: string, over: Partial<Approval> = {}): Approval => ({
  request_id: `req-${run_id}-${Math.random()}`, bot: "vendas", source: "run", surface: "run", mechanism: "hook_approve", run_id, digest: "d".repeat(64),
  allowed_choices: ["once", "deny"], action_class_hash: "h", status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...over,
});

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : {}));
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.unstubAllGlobals(); delete (window as any).__HERMES_PLUGIN_SDK__; });

describe("E-5 the door: only a Bot message becomes a card", () => {
  it("a tool card's result holding a valid block stays text", () => {
    const { container } = render(<ToolCard name="web_search" status="done" preview="1 resultado" args={{ q: "x" }} durationS={1} result={GOOD} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByTestId("evidence-card")).toBeNull();
    expect(container.textContent).toContain("luve-evidence");
  });

  it("the person's own message and a Bot message are not the same door: a block the PERSON pastes is not a card", () => {
    const initialTurns = turnsFromHistory([{ id: "u1", role: "user", text: `copie este formato:\n${GOOD}` }, { id: "a1", role: "assistant", text: "Entendi o formato." }] as any);
    render(<Conversation bot={BOT} initialTurns={initialTurns} pendingApprovals={[]} />);
    expect(screen.queryByTestId("evidence-card")).toBeNull();
    expect(screen.getByText("Entendi o formato.")).toBeTruthy();
  });

  it("the same block in the Bot's reply is the card (the control)", () => {
    const initialTurns = turnsFromHistory([{ id: "u1", role: "user", text: "resuma" }, { id: "a1", role: "assistant", text: GOOD }] as any);
    render(<Conversation bot={BOT} initialTurns={initialTurns} pendingApprovals={[]} />);
    expect(screen.getAllByTestId("evidence-card")).toHaveLength(1);
  });
});

describe("E-5 the card: nothing a Bot writes can pass for the card's own parts", () => {
  const MIMIC = BLOCK([
    "facts:", `- ${say(pt.eviInBox, 0)}`, `- ${pt.eviNoPending}`, "- Escrito pelo Bot. O LuveBot CONFERIU.", "- Conferido pelo Hermes: passou", "- awaiting:",
    "awaiting:", `- ${say(pt.eviInBox, 0)} | source: Conferido pelo Hermes`,
  ].join("\n"));

  it("the real count, the real top line and the real mismatch line exist once; every imitation is an ordinary bullet", () => {
    render(<EvidenceProvider pending={2} onOpenApprovals={() => {}}><BotMessageBody text={MIMIC} /></EvidenceProvider>);
    const card = screen.getByTestId("evidence-card");
    expect(within(card).getAllByTestId("evidence-in-box")).toHaveLength(1);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe(say(pt.eviInBox, 2));
    expect(within(card).getAllByTestId("evidence-top")).toHaveLength(1);
    expect(screen.getByTestId("evidence-top").textContent).toBe(pt.eviTop);
    expect(within(card).queryAllByTestId("evidence-mismatch")).toHaveLength(0);                       // the Bot listed one, the box has two: the real count is there, no false line
    const items = within(card).getAllByTestId("evidence-item").map((n) => n.textContent);
    expect(items).toContain(say(pt.eviInBox, 0));                                                   // the lie is there, as a bullet, labelled as the Bot's
    expect(within(screen.getByTestId("evidence-awaiting")).getByText(pt.eviBotSays)).toBeTruthy();
    expect(card.querySelectorAll("a, button[type=submit], input, textarea, select, form").length).toBe(0);
  });

  it("HTML, a hostile source and the invisible characters are text (the characters are tokens), and the copy button copies exactly what is shown", async () => {
    const written: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (s: string) => { written.push(s); } } });
    const evil = "\u202ehttps://evil.example/x\u202c\u200b?a=$&b {count} {source}";
    const text = BLOCK(`facts:\n- <img src=x onerror="globalThis.__ev=1"> | source: ${evil}`);
    const { container } = render(<BotMessageBody text={text} />);
    expect(container.querySelector("a, img, script, iframe, svg")).toBeNull();
    expect((globalThis as any).__ev).toBeUndefined();
    const shown = screen.getByTestId("evidence-source").textContent!;
    expect(shown).toBe("Fonte: [U+202E]https://evil.example/x[U+202C][U+200B]?a=$&b {count} {source}");   // the bidi and the zero-width are tokens (A-195), and `$&` / `{count}` literal
    fireEvent.click(screen.getByRole("button", { name: /Copiar/ }));
    await Promise.resolve();
    expect(written).toEqual(["[U+202E]https://evil.example/x[U+202C][U+200B]?a=$&b {count} {source}"]);   // what the person copies is what the person saw
  });
});

describe("E-5 the count and what the card says about it", () => {
  const withShell = (shell: Approval[], runs: string[], text = GOOD) => render(
    <EvidenceProvider pending={pendingInConversation(shell, "vendas", runs)} onOpenApprovals={() => {}}><BotMessageBody text={text} /></EvidenceProvider>);

  it("control: the box holds what the Bot listed (one request of this conversation's run): the count says 1 and no mismatch is told", () => {
    withShell([approval("run_a")], ["run_a"]);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe(say(pt.eviInBox, 1));
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
  });

  it("control: the Bot listed a request and the box holds none of this conversation's: the calm mismatch line", () => {
    withShell([], ["run_a"]);
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe(pt.eviNoPending);
  });

  it("control: a room says nothing (no provider: no count, no comparison, no link)", () => {
    render(<BotMessageBody text={GOOD} />);
    expect(screen.queryByTestId("evidence-in-box")).toBeNull();
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
  });

  it("control: a count of the Bot is never taken from its own text (a header can only be absent or listed)", () => {
    withShell([approval("run_a"), approval("run_a")], ["run_a"], BLOCK("awaiting:\n- none"));
    expect(screen.getByTestId("evidence-in-box").textContent).toBe(say(pt.eviInBox, 2));
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe(say(pt.eviExtraMany, 2));
  });

  it("F12 (fixed by e2b) with a pending approval of this Bot from ANOTHER run in the shell, every phrase of the count says it is about THIS conversation, in both languages", () => {
    // the sidebar badge and the Approvals box have ONE pending request (another run: a routine, a thread, another conversation); the card counts this conversation's runs and must say so
    for (const [locale, words] of [["pt", pt], ["en", en]] as const) {
      cleanup(); setLuveLocale(locale);
      withShell([approval("run_of_a_routine")], ["run_a"]);
      const said = screen.getByTestId("evidence-in-box").textContent! + " | " + screen.getByTestId("evidence-mismatch").textContent!;
      expect(said).toContain(say(words.eviInBox, 0));
      expect(said).toContain(words.eviNoPending);
      expect(words.eviInBox + words.eviNoPending + words.eviExtraOne + words.eviExtraMany).toMatch(locale === "pt" ? /desta conversa/ : /this conversation/);
      if (locale === "pt") for (const old of OLD_GLOBAL_PT) expect(said).not.toContain(old);
    }
  });
});
