// tests/unit/redteam/skill-sheet-redteam.test.tsx (Lume, 31/10): SK-5 slice 1 (dfec750), the review sheet and the draft turn, attacked against contract v0.11 3.2 steps 1 to 5 and 3.4.
// Invisible characters are built from code points, never typed raw (the lesson of the day: a tool decodes the escapes you type).
//
// F-SK5-1 is FIXED (Vitral): its seven cases are plain `it` now (the description, the name and the created card's name draw every character of the table as a `[U+XXXX]` token).
//   F-SK5-1 (Baixa, was): the description line of the sheet ("Descricao") draws the server's preview text RAW. A character of any hidden class (a Tag, a bidi override, a zero-width space) that the preview carries is drawn as
//           nothing (or reorders the rest of the line): the one line of the sheet that is not a plain-text area and not passed through the table's tokens. Today the server can still return one (F-SK-A2, a YAML
//           escape), and the sheet is the last place that could show it. The fix is `markedPreview`-like tokens for EVERY character of the table, refused ones included, in that one line.
// HELD (plain tests): padding made of a lone CR is counted and warned about like LF (the extractor turns CR and CRLF into LF before the sheet sees the text: I had thought otherwise, the test found it); the history placeholder row is never a bubble and never draws the text its row carries; Create follows ONLY a login (every other mode of the session, a mix of case or an unknown one, is off);
//   a second tap on Create, on Turn on and on the request is not a second request.
// NOT CLAIMED, in the report: after a reload the history has no run id, so the draft is "the Bot's answer after the placeholder": all the Bot's rows until the next person's message are merged into one message
//   (`turnsFromHistory` joins them with a blank line) and the card reads that merge.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, configure } from "@testing-library/react";
import { SkillReviewSheet } from "@/components/skills/SkillReviewSheet";
import { Conversation } from "@/components/conversation";
import { turnsFromHistory } from "@/components/chat/history";
import { extractSkillDraft } from "@/lib/skillDraft";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const cp = (...c: number[]) => String.fromCodePoint(...c);
const pt = translations.pt;
const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const HEADER = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n";
const BODY = HEADER + "1. Open the report.\n2. Send it to the team.";
const draftOf = (content: string) => { const r = extractSkillDraft("```luve-skill\n" + content + "\n```"); if (!r.ok) throw new Error("not a draft: " + r.why); return r.draft; };

type Call = { method: string; url: string; body: any };
type Opts = { auth?: string; description?: string; scan?: unknown };
function world(opts: Opts = {}) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: opts.auth ?? "gated" };
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.method === "PUT") return { skill: { name: "send-report" }, notice: "on_applies_to_new_conversations", still_off_on: [] };
    if (call.body?.dry_run === true) return { name: call.body.name, category: null, description: opts.description ?? "Use when a report must go out.", bytes: new TextEncoder().encode(call.body.content).length, warnings: [] };
    return { skill: { name: call.body.name }, enabled: false, scan: opts.scan ?? { verdict: "safe", policy: "allow", findings: 0, categories: [] } };
  });
  return { calls, real: () => calls.filter((c) => c.method === "POST" && c.body?.dry_run === false), puts: () => calls.filter((c) => c.method === "PUT") };
}
const mount = (content = BODY) => render(<SkillReviewSheet open bot="vendas" draft={draftOf(content)} onClose={vi.fn()} />);
const area = () => screen.getByLabelText("Texto da skill (SKILL.md)") as HTMLTextAreaElement;
const create = () => screen.getByRole("button", { name: "Criar skill (nasce desligada)" }) as HTMLButtonElement;
const checked = () => screen.findByText(/^Conferido: \d+ bytes\.$/);

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); });

// ---- F-SK5-1: the description line --------------------------------------------------------------------------------------------------------------------------------
const HIDDEN = { "a Tag character": cp(0xe0041, 0xe0042), "a bidi override": cp(0x202e), "a zero-width space": cp(0x200b), "a word joiner": cp(0x2060), "a Hangul filler": cp(0x3164), "NEL": cp(0x85), "a variation selector (supplement)": cp(0xe0100) };

describe("the description line of the sheet", () => {
  it("control: an ordinary description is drawn as it is", async () => {
    world(); mount();
    await checked();
    expect(screen.getByText("Use when a report must go out.")).toBeTruthy();
  });

  it.each(Object.keys(HIDDEN))("never draws %s raw: a reader sees a token, not nothing", async (label) => {
    const hidden = HIDDEN[label as keyof typeof HIDDEN];
    world({ description: "Use when asked." + hidden });
    mount();
    await checked();
    const line = screen.getByText(pt.skillSheetDescription + ":").parentElement as HTMLElement;
    expect(line.textContent!.includes(hidden), `${label} is in the description line, drawn as nothing`).toBe(false);
  });
});

// ---- F-SK5-2: lines the textarea draws and the sheet does not count -------------------------------------------------------------------------------------------------
describe("padding the sheet counts, whatever the line break", () => {
  const padded = (breaker: string, n: number) => HEADER + breaker.repeat(n) + "1. Open the report.";
  const caption = () => (screen.getByText(/linhas\. Termina na linha/) as HTMLElement).textContent!;
  const lines = (c: string) => Number(/^(\d+) linhas/.exec(c)![1]);

  it("control: 300 LF blank lines are counted and warned about", async () => {
    world(); mount(padded("\n", 300));
    await checked();
    expect(lines(caption())).toBeGreaterThan(300);
    expect(screen.getByText(pt.skillSheetBlankWarn)).toBeTruthy();
  });

  it("300 blank lines made of CR: the count says what the textarea shows (the extractor normalizes CR to LF first)", async () => {
    world(); mount(padded("\r", 300));
    await checked();
    expect(area().value.split("\n").length).toBeGreaterThan(300);
    expect(lines(caption())).toBeGreaterThan(300);
  });

  it("300 blank lines made of CR: the warning about more than 20 in a row fires", async () => {
    world(); mount(padded("\r", 300));
    await checked();
    expect(screen.queryByText(pt.skillSheetBlankWarn)).not.toBeNull();
  });

  it("and padding made of CR+LF is counted and warned about (a CRLF text is a normal one)", async () => {
    world(); mount(padded("\r\n", 300));
    await checked();
    expect(lines(caption())).toBeGreaterThan(300);
    expect(screen.getByText(pt.skillSheetBlankWarn)).toBeTruthy();
  });
});

// ---- Create follows a login, and only a login ---------------------------------------------------------------------------------------------------------------------
describe("Create: a person with a login", () => {
  it("control: a session in gated mode can create, and the body is exactly the checked text with dry_run false", async () => {
    const w = world(); mount();
    await checked();
    expect(create().disabled).toBe(false);
    fireEvent.click(create());
    await screen.findByTestId("skill-created");
    expect(w.real()).toHaveLength(1);
    expect(w.real()[0].body).toEqual({ name: "send-report", content: BODY, dry_run: false });
  });

  it.each(["loopback", "deployment", "GATED", "Gated", " gated", "gated ", "", "session-token", "none", "person"])("the mode %j of the session is not a login: Create is off and the dry run still works", async (auth) => {
    const w = world({ auth }); mount();
    await checked();
    expect(create().disabled, `auth_mode ${JSON.stringify(auth)} let Create through`).toBe(true);
    expect(w.real()).toHaveLength(0);
  });
});

// ---- a second tap is not a second request -------------------------------------------------------------------------------------------------------------------------
describe("one tap, one request", () => {
  it("a second tap on Create while the first is in flight sends nothing, and the skill is created once", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => { release = r; });
    const calls: Call[] = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
      const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (call.body?.dry_run === true) return { name: call.body.name, category: null, description: "Use when a report must go out.", bytes: 10, warnings: [] };
      await gate;
      return { skill: { name: "send-report" }, enabled: false, scan: { verdict: "safe", policy: "allow", findings: 0, categories: [] } };
    });
    mount();
    await checked();
    const button = create();                                                  // its name turns into 'Criando...' after the first tap: hold the element, not the name
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    release(null);
    await screen.findByTestId("skill-created");
    expect(calls.filter((c) => c.body?.dry_run === false)).toHaveLength(1);
  });

  it("a second tap on Turn on is one PUT", async () => {
    const w = world(); mount();
    await checked();
    fireEvent.click(create());
    await screen.findByTestId("skill-created");
    const on = screen.getByRole("button", { name: pt.skillTurnOn });
    fireEvent.click(on); fireEvent.click(on); fireEvent.click(on);
    await screen.findByText(pt.skillTurnedOn);
    expect(w.puts()).toHaveLength(1);
    expect(w.puts()[0].body).toEqual({ enabled: true });
  });
});

// ---- the history's placeholder row ---------------------------------------------------------------------------------------------------------------------------------
describe("the placeholder row of the hidden draft turn (A-175)", () => {
  it("is never a bubble and never draws the text its row carries (a hostile or old server may put some there)", () => {
    const SECRET = "TEXTO-NA-LINHA-MARCADOR-9f2c";
    const turns = turnsFromHistory([
      { id: 1, role: "user", text: "oi" }, { id: 2, role: "assistant", text: "Ola." },
      { id: 3, role: "user", text: SECRET, display_kind: "skill_draft" }, { id: 4, role: "assistant", text: "Nao deu." },
    ] as any);
    render(<Conversation bot={BOT} initialTurns={turns} />);
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.getByText(translations.pt.skillDraftAsked)).toBeTruthy();
  });

  it("a placeholder row is not a draft by itself: with no Bot answer after it, nothing opens", () => {
    const turns = turnsFromHistory([{ id: 1, role: "user", text: "", display_kind: "skill_draft" }] as any);
    render(<Conversation bot={BOT} initialTurns={turns} />);
    expect(screen.queryByTestId("skill-draft-card")).toBeNull();
  });
});
