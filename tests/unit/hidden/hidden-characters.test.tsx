// tests/unit/hidden/hidden-characters.test.tsx
// What a person reads is what is there (contract v0.11 §8, A-188 and A-189): a character of the shared table (backend/unicode_invisible.json) is drawn as the visible token `[U+XXXX]`, never removed and never raw.
// STRICT (both classes) where a person decides, edits or copies: the command and the text of an approval (the inbox, its dialog, the card in the conversation, Today), a rule's text, the Terminal of the work
// panel (the command line and the output), a source of the evidence card and code in a message. PROSE (the refuse class only) in a message: ZWNJ and ZWJ of Persian and emoji, the soft hyphen and the isolates stay.
// No invisible character is written in this file: every one is built from its code point.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, configure } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import TABLE from "../../../backend/unicode_invisible.json";
import { proseTokens, visibleTokens } from "@/lib/hiddenChars";
import { Markdown } from "@/lib/render/markdown";
import { ApprovalsInbox } from "@/components/approvals";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { Hoje } from "@/components/Hoje";
import { RulesView } from "@/components/rules";
import { FreePassesCard } from "@/components/agent/FreePassesCard";
import { WorkPanel } from "@/components/conversation";
import { EvidenceCard } from "@/components/evidence/EvidenceCard";
import { parseSse } from "@/components/transcript";
import { reduce, initialTranscript } from "@/lib/stream";
import { resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import { draftLabel, humanApproval } from "@/components/approvals/humanize";
import type { Rule, RuleSuggestion, RuleWithSeal } from "@/api/types";
import { splitEvidence, type Evidence } from "@/lib/evidence";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const cp = (...c: number[]) => String.fromCodePoint(...c);
const RLO = cp(0x202e), ZWSP = cp(0x200b), ZWNJ = cp(0x200c), ZWJ = cp(0x200d), TAG = cp(0xe0041), SHY = cp(0xad), VS16 = cp(0xfe0f), LRI = cp(0x2066);
const tok = (c: number) => `[U+${c.toString(16).toUpperCase().padStart(4, "0")}]`;
const RAW = new RegExp("[" + [...TABLE.refuse, ...TABLE.mark].map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") + "]", "gu");   // the table's characters, drawn raw
/** Every character of the table left raw in `text`, with what is around it (an empty list when none): the failure says WHERE. */
const raw = (text: string | null): string[] => [...(text ?? "").matchAll(RAW)].map((m) => `${tok(m[0].codePointAt(0) as number)} in ${JSON.stringify((text ?? "").slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + 30))}`);

describe("the helpers read the ONE table", () => {
  const ends = (r: number[][]) => r.flatMap(([a, b]) => [a, b]);
  it("strict: both classes become tokens at the ends of every range; prose: the refuse class only", () => {
    for (const c of ends(TABLE.refuse)) {
      expect(visibleTokens("a" + cp(c) + "b"), `strict ${tok(c)}`).toBe("a" + tok(c) + "b");
      expect(proseTokens("a" + cp(c) + "b"), `prose ${tok(c)}`).toBe("a" + tok(c) + "b");
    }
    for (const c of ends(TABLE.mark)) {
      expect(visibleTokens("a" + cp(c) + "b"), `strict ${tok(c)}`).toBe("a" + tok(c) + "b");
      expect(proseTokens("a" + cp(c) + "b"), `prose ${tok(c)}`).toBe("a" + cp(c) + "b");              // the mark class is legitimate in prose
    }
  });

  it("nothing is removed: every other character stays where it was, the tokens sit where the characters were", () => {
    expect(visibleTokens("a" + RLO + "b" + ZWSP + "c" + TAG + "d")).toBe("a[U+202E]b[U+200B]c[U+E0041]d");
    expect(visibleTokens("relatório, ação 😀 ❤" + VS16 + "\n\ttexto")).toBe("relatório, ação 😀 ❤" + VS16 + "\n\ttexto");   // accents, emoji, the presentation selector, TAB and LF are not in the table
    expect(visibleTokens("")).toBe("");
  });

  it("prose keeps what Persian, Hindi and emoji need (ZWNJ, ZWJ, the soft hyphen, the isolates) and tokens only what reorders or hides", () => {
    const persian = "می" + ZWNJ + "خواهم", family = "👨" + ZWJ + "👩" + ZWJ + "👧", hyphen = "inter" + SHY + "national", isolated = LRI + "abc" + cp(0x2069);
    for (const text of [persian, family, hyphen, isolated]) expect(proseTokens(text)).toBe(text);
    expect(proseTokens(persian + RLO)).toBe(persian + "[U+202E]");
  });

  it("is idempotent, and a global regex keeps no state between calls", () => {
    const text = "x" + RLO + ZWSP + "y";
    expect(visibleTokens(visibleTokens(text))).toBe(visibleTokens(text));
    expect([visibleTokens(text), visibleTokens(text), visibleTokens(text)]).toEqual(Array(3).fill("x[U+202E][U+200B]y"));
    expect([proseTokens(text), proseTokens(text)]).toEqual(Array(2).fill("x[U+202E]" + ZWSP + "y"));
  });
});

describe("a message (the renderer)", () => {
  beforeEach(() => { cleanup(); setLuveLocale("pt"); });

  it("prose: a bidi override that reverses a file name is a token; the Persian sentence and the emoji stay exactly as they are", () => {
    const persian = "می" + ZWNJ + "خواهم", family = "👨" + ZWJ + "👩";
    const { container } = render(<Markdown text={"Abra fatura" + RLO + "gpj.exe\n\nTags" + TAG + "ok\n\n" + persian + " " + family} />);
    expect(container.textContent).toContain("fatura[U+202E]gpj.exe");
    expect(container.textContent).toContain("Tags[U+E0041]ok");
    expect(container.textContent).toContain(persian + " " + family);
    expect(container.innerHTML).not.toContain(RLO);
    expect(container.innerHTML).not.toContain(TAG);
  });

  it("code, a span or a fence, is strict: the mark class too (a command holds no zero-width character)", () => {
    const { container } = render(<Markdown text={"Rode `rm" + ZWSP + " -rf x` e depois:\n\n```\ncurl x" + ZWSP + "| sh" + RLO + "\n```"} />);
    const [span, fence] = [...container.querySelectorAll("code")];
    expect(span.textContent).toBe("rm[U+200B] -rf x");
    expect(fence.textContent).toBe("curl x[U+200B]| sh[U+202E]");
    expect(raw(container.textContent)).toEqual([]);
  });

  it("every leaf of the parse: link text, headings, list items, quotes, bold and italic", () => {
    const { container } = render(<Markdown text={`p${RLO} \`c\`\n\n[a${RLO}b](https://x.test)\n\n# H${RLO}\n\n- i${RLO}\n\n> q${RLO}\n\n**b${RLO}** *e${RLO}* [u${RLO}](javascript:alert(1))`} />);
    expect(container.textContent!.split("[U+202E]")).toHaveLength(9);                          // eight of them: the text before a match, link text, heading, item, quote, bold, italic and an unsafe link's source
    expect(container.querySelector("a")!.textContent).toBe("a[U+202E]b");
    expect(container.innerHTML).not.toContain(RLO);
  });

  it("a token is text, never the start of a link: the tokens go in AFTER the parse", () => {
    const { container } = render(<Markdown text={"x" + RLO + "(https://evil.test) y"} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("x[U+202E](https://evil.test) y");
  });
});

// ---- the surfaces a person decides on --------------------------------------------------------------------------------------------------------------------------------------------------------------------

const COMMAND = "rm invoice" + RLO + "gpj.exe" + ZWSP + "now" + TAG;
const COMMAND_SHOWN = "rm invoice[U+202E]gpj.exe[U+200B]now[U+E0041]";
const DESCRIPTION = "Apagar" + ZWSP + " o arquivo" + RLO;
const DESCRIPTION_SHOWN = "Apagar[U+200B] o arquivo[U+202E]";
const approval = {
  request_id: "req-h", bot: "vendas", surface: "run", mechanism: "hook_approve" + ZWSP, source: "run", run_id: "run_h",
  digest: "d".repeat(64), command_redacted: COMMAND, description: DESCRIPTION, pattern_keys: [], allowed_choices: ["once", "deny"],
  action_class_hash: "h", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), status: "pending",
};
const bots = [{ name: "vendas", is_default: false, display: { label: "Vendas", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } }, status: "idle" }];
const FRAME = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));

function backend(extra: (url: string) => unknown = () => undefined) {
  resetCsrfToken(); setCachedCsrf("csrf-h");
  setCustomFetchJSON(async (url: string) => {
    const mine = extra(url);
    if (mine !== undefined) return mine;
    if (url.endsWith("/session")) return { csrf: "c", actor: "tester", auth_mode: "gated" };
    if (url.includes("/approvals")) return { ok: true, approvals: [approval], total: 1 };
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
}

describe("an approval: the command and the text", () => {
  beforeEach(() => { cleanup(); setLuveLocale("pt"); backend(); });
  afterEach(() => { cleanup(); setCustomFetchJSON(null); });

  it("the inbox draws the command and the text with every hidden character as a token, and the dialog does too", async () => {
    render(<ApprovalsInbox bots={bots as never} authMode="gated" />);
    const box = await screen.findByTestId("approval-command");
    expect(box.textContent).toBe(COMMAND_SHOWN);                                              // a bidi override reverses "invoice.exe" and is still there to be seen
    expect(document.body.textContent).toContain(DESCRIPTION_SHOWN);
    fireEvent.click(screen.getByText("Ver parâmetros"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(COMMAND_SHOWN);
    expect(dialog.textContent).toContain(DESCRIPTION_SHOWN);
    expect(dialog.textContent).toContain("hook_approve[U+200B]");
    expect(raw(document.body.textContent)).toEqual([]);
  });

  it("the card in the conversation draws the title, the preview and the technical lines the same way", async () => {
    const frame = { ...FRAME, command: COMMAND, description: DESCRIPTION, request_id: "req-h", luvebot_digest: "dg" };
    const { container } = render(<InlineApproval frame={frame as never} bot="vendas" runId="run_h" pending />);
    await waitFor(() => expect(container.querySelector("pre")?.textContent).toContain(COMMAND_SHOWN));
    await waitFor(() => expect(container.textContent).toContain(DESCRIPTION_SHOWN));
    expect(raw(container.textContent)).toEqual([]);
  });

  it("Today draws a pending approval's command as plain text with tokens (never markdown), and its title the same", async () => {
    render(<Hoje bots={bots as never} botsStatus="ready" approvals={[approval as never]} handoffs={[]} inProgressItems={[]} completedItems={[]} routines={[]} waiting={[]} />);
    await waitFor(() => expect(document.body.textContent).toContain(COMMAND_SHOWN));
    expect(document.body.textContent).toContain(DESCRIPTION_SHOWN);
    expect(raw(document.body.textContent)).toEqual([]);
  });
});

describe("a rule's text", () => {
  const HASH = "a".repeat(64);
  const rule = (over: Partial<Rule> = {}): Rule => ({
    id: "r-h", label: "Permitir" + RLO + "gpj", level: "ask", scope: { kind: "bot", ref: "vendas" },
    match: { tools: ["terminal"], commands: ["git" + ZWSP + " status"], conditions: [{ fact: "path", op: "under", value: "/srv/" + RLO + "app" }] }, state: "draft", origin: "human", builtin: false, version: 1, ...over,
  } as Rule);
  const withSeal = (r: Rule): RuleWithSeal => ({ rule: r, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [] } } as RuleWithSeal);
  const suggestion: RuleSuggestion = { kind: "rule", bot: "vendas", action_class: HASH, count: 4, action: { tool: "terminal" + ZWSP, command: "git" + ZWSP + " push" + RLO }, draft_preview: rule({ id: "sg-preview" }) } as RuleSuggestion;

  beforeEach(() => {
    cleanup(); setLuveLocale("pt");
    backend((url) => url.endsWith("/suggestions") ? { suggestions: [suggestion] } : url.includes("/rules") ? { rules: [withSeal(rule())] } : undefined);
  });
  afterEach(() => { cleanup(); setCustomFetchJSON(null); });

  it("the label, the commands and the conditions of the rule's card", async () => {
    render(<RulesView bots={bots as never} authMode="gated" initialRules={[withSeal(rule())]} />);
    expect(await screen.findByRole("heading", { name: "Permitir[U+202E]gpj" })).toBeTruthy();
    expect(screen.getByText("git[U+200B] status")).toBeTruthy();
    expect(screen.getByTestId("rule-condition-r-h-0").textContent).toContain("/srv/[U+202E]app");
    expect(raw(document.body.textContent)).toEqual([]);
  });

  it("the simulator names the winner and each hit by the rule's label, with its tokens", async () => {
    backend((url) => url.endsWith("/rules/simulate") ? { decision: { effect: "ask", winner: "r-h", hits: [{ rule_id: "r-h", level: "ask", scope: { kind: "bot", ref: "vendas" } }], reason: "rule" }, caveats: [] }
      : url.endsWith("/suggestions") ? { suggestions: [] } : url.includes("/rules") ? { rules: [withSeal(rule())] } : undefined);
    render(<RulesView bots={bots as never} authMode="gated" initialRules={[withSeal(rule())]} />);
    fireEvent.click(screen.getByRole("tab", { name: /simulador/i }));
    fireEvent.change(screen.getByLabelText(/nome da ferramenta/i), { target: { value: "terminal" } });
    fireEvent.click(screen.getByRole("button", { name: /simular ação/i }));
    const result = await screen.findByTestId("simulation-result");
    expect(result.textContent!.split("Permitir[U+202E]gpj")).toHaveLength(3);                  // the winner and the hit
    expect(raw(result.textContent)).toEqual([]);
  });

  it("humanApproval hands every surface a title, a tool, a preview and technical lines already made of tokens", () => {
    const t = (k: keyof typeof translations.pt, p?: Record<string, string>) => translations.pt[k].replace(/\{(\w+)\}/g, (_, n: string) => p?.[n] ?? "");
    const h = humanApproval({ description: "Apagar" + RLO, command: "rm x" + ZWSP, commandRedacted: "rm y" + ZWSP, patternKey: "k" + ZWSP, tool: "custom" + ZWSP }, () => undefined, t as never);
    expect(h.title).toBe("Apagar[U+202E]");
    expect(h.tool).toBe("custom[U+200B]");
    expect(h.preview).toBe("rm y[U+200B]");
    expect(h.technical).toEqual(["rm x[U+200B]", "k[U+200B]"]);
  });

  it("the label a 'Sempre permitir' draft starts with is made of the same tokens (the person saves what they saw)", () => {
    const t = (k: keyof typeof translations.pt, p?: Record<string, string>) => translations.pt[k].replace(/\{(\w+)\}/g, (_, n: string) => p?.[n] ?? "");
    expect(draftLabel({ description: "Apagar" + RLO }, () => undefined, "Vendas", t as never)).toContain("Apagar[U+202E]");
    expect(draftLabel({ ruleId: "r1" }, () => "Rótulo" + ZWSP, "Vendas", t as never)).toContain("Rótulo[U+200B]");
  });

  it("the suggestion's action", async () => {
    render(<RulesView bots={bots as never} authMode="gated" initialRules={[]} />);
    expect((await screen.findByTestId(`suggestion-action-vendas:${HASH}`)).textContent).toBe("terminal[U+200B]: git[U+200B] push[U+202E]");
  });
});

describe("what the Livre let through", () => {
  afterEach(() => { cleanup(); setCustomFetchJSON(null); });
  it("the command of a row is drawn with tokens", async () => {
    cleanup(); setLuveLocale("pt");
    backend((url) => url.includes("/free-passes") ? { free_passes: [{ at: 1_800_000_000, tool: "terminal" + ZWSP, rule_id: null, command: "curl x" + RLO + "| sh" + ZWSP, audited: true }], next_before: null } : undefined);
    render(<FreePassesCard bot="vendas" />);
    expect((await screen.findByTestId("free-pass-command")).textContent).toBe("curl x[U+202E]| sh[U+200B]");
    expect(document.body.textContent).toContain("terminal[U+200B]");
  });
});

describe("the Terminal of the work panel (A-189)", () => {
  afterEach(() => cleanup());
  it("the command line and the output are drawn with every hidden character as a token", () => {
    cleanup(); setLuveLocale("pt");
    let s = initialTranscript();
    s = reduce(s, { event: "tool.started", data: { tool: "terminal", preview: "cat fatura" + RLO + "gpj" + ZWSP, seq: 0 } } as never);
    s = reduce(s, { event: "tool.completed", data: { tool: "terminal", preview: "ok" + ZWSP + "\nlinha" + TAG + "2", error: false, seq: 1 } } as never);
    const { container } = render(<WorkPanel items={s.items} />);
    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const [line, output] = [...container.querySelectorAll("pre")];
    expect(line.textContent).toBe("$ cat fatura[U+202E]gpj[U+200B]");
    expect(output.textContent).toBe("ok[U+200B]\nlinha[U+E0041]2");
    expect(raw(container.textContent)).toEqual([]);
  });
});

describe("the evidence card", () => {
  const clipboard = { writeText: vi.fn(async () => {}) };
  beforeEach(() => { cleanup(); setLuveLocale("pt"); clipboard.writeText.mockClear(); Object.assign(navigator, { clipboard }); });
  afterEach(() => cleanup());
  const evidence = (): Evidence => ({
    facts: [{ text: "Fatura" + RLO + "gpj paga", source: "crm/" + ZWSP + "setembro" + RLO + ".csv" }, { text: "می" + ZWNJ + "خواهم" }],
    assumptions: [], done: [], awaiting: [], questions: [],
  } as unknown as Evidence);

  it("an item is prose (the refuse class), a source is what a person copies (both), and the copy button copies what is drawn", () => {
    render(<EvidenceCard evidence={evidence()} pending={null} />);
    const items = screen.getAllByTestId("evidence-item");
    expect(items[0].textContent).toBe("Fatura[U+202E]gpj paga");
    expect(items[1].textContent).toBe("می" + ZWNJ + "خواهم");                                   // the Persian sentence keeps its ZWNJ
    expect(screen.getByTestId("evidence-source").textContent).toContain("crm/[U+200B]setembro[U+202E].csv");
    fireEvent.click(screen.getByRole("button", { name: /^Copiar/ }));
    expect(clipboard.writeText).toHaveBeenCalledWith("crm/[U+200B]setembro[U+202E].csv");      // a source that holds a hidden character does not run as drawn
  });

  it("end to end (EV-1): an evidence block in a Bot message reaches the card with tokens in the item and in the source, and a Persian ZWNJ stays", () => {
    const message = "Pronto.\n\n```luve-evidence\nfacts:\n- Fatura" + RLO + "gpj paga | source: crm/" + ZWSP + "novembro" + RLO + ".csv\n- می" + ZWNJ + "خواهم\nassumptions:\n- none\ndone:\n- none\nawaiting:\n- none\nquestions:\n- none\n```";
    const card = splitEvidence(message).find((x) => x.kind === "evidence") as { evidence: Evidence } | undefined;
    expect(card).toBeDefined();                                                                    // nothing is removed, so nothing refuses the block
    render(<EvidenceCard evidence={card!.evidence} pending={null} />);
    const items = screen.getAllByTestId("evidence-item");
    expect(items[0].textContent).toBe("Fatura[U+202E]gpj paga");
    expect(items[1].textContent).toBe("می" + ZWNJ + "خواهم");
    expect(screen.getByTestId("evidence-source").textContent).toContain("crm/[U+200B]novembro[U+202E].csv");
    fireEvent.click(screen.getByRole("button", { name: /^Copiar/ }));
    expect(clipboard.writeText).toHaveBeenCalledWith("crm/[U+200B]novembro[U+202E].csv");
  });
});
