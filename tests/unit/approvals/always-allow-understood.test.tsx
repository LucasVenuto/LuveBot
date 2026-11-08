// tests/unit/approvals/always-allow-understood.test.tsx
// AA-2 (plugin-api v0.11 section 11, A-253..A-256): "Sempre permitir" that the person understands. The first act (approve once + leave a DRAFT) tells the truth and points at the second (turn it on, on the Rules screen of that Bot):
// (1) after the click, in the three places that draw it (the Caixa's strip, the card in a conversation, the card in Hoje), the line says the rule is still a draft and must be turned on, and never says a rule is on;
// (2) "Revisar e ativar" exists only with a saved draft (`draft_rule` with an id and no `draft_error`); (7) before the click the card says what it does; (8) PT and EN; and above all the invariant:
// (6) NOTHING is turned on by this part: the button only OPENS the screen, the arrival turns nothing on (that half is in tests/unit/rules/always-allow-review.test.tsx, and the whole walk through the app is the last test here).
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { ApprovalDecision, InlineApproval } from "@/components/chat/InlineApproval";
import { ReviewDraftContext } from "@/components/approvals/ReviewDraftButton";
import { savedDraftId } from "@/components/approvals/decide";
import { parseSse } from "@/components/transcript";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { Approval, Bot } from "@/api/types";

const PT = "Permitido desta vez. A regra ainda é só um rascunho: ative para valer sempre.";
const EN = "Allowed this once. The rule is still a draft: turn it on to make it count every time.";
const HINT_PT = "Permite agora e cria um rascunho de regra para você ativar.";
const HINT_EN = "Allows now and creates a draft rule for you to turn on.";
const REVIEW = /^Revisar e ativar$/;

const face = (label: string) => ({ label, role: "", color: "#60a5fa", avatar: { kind: "emoji", value: "x" } });
const bots = [{ name: "vendas", is_default: false, display: face("Vendas"), description: "", model: { provider: "x", name: "y" }, status: "idle" } as unknown as Bot];
const pending: Approval = {
  request_id: "req-1", bot: "vendas", surface: "gateway", mechanism: "command", source: "transport", digest: "d".repeat(64), command_redacted: "curl -X POST https://api.example.com/sync",
  description: "Sync", pattern_keys: ["curl"], allowed_choices: ["once", "deny", "always"], action_class_hash: "h", created_at: new Date(Date.now() - 60000).toISOString(),
  expires_at: new Date(Date.now() + 3600000).toISOString(), status: "pending",
} as Approval;
const real = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));
const stored = { ...real, luvebot_digest: "dg-123" };

const SAVED = { id: "aa-1", label: "Permitir curl", level: "allow", scope: { kind: "bot", ref: "vendas" }, state: "draft", origin: "always_allow" };
const decided = (extra: object) => ({ ok: true, approval: { request_id: "req-1", status: "decided", decided_choice: "once" }, ...extra });

/** What the three places send: the server's answer to the "always" click. */
let answer: object;
let opened: Array<[string, string]>;
const open = (bot: string, id: string) => { opened.push([bot, id]); };
function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "tester", auth_mode: "gated" };
    if (method === "GET" && url.includes("/approvals")) return { ok: true, approvals: [pending], total: 1 };
    if (method === "POST") return answer;
    return {};
  });
}
beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); provided = true; opened = []; answer = decided({ draft_rule: SAVED }); backend(); });
afterEach(() => { cleanup(); setCustomFetchJSON(null); setLuveLocale("pt"); });

// ---- the three places --------------------------------------------------------------------------------------------------------------------------------
let provided = true;   // false: the card drawn alone, with no app to open a screen
const wrapped = (node: React.ReactNode) => <ReviewDraftContext.Provider value={provided ? open : null}>{node}</ReviewDraftContext.Provider>;
const ALWAYS = /^(Sempre permitir…|Always allow…)$/, CREATE = /criar rascunho e permitir uma vez|create draft and allow once/i;
const alwaysBtn = () => screen.getByRole("button", { name: ALWAYS });
const DRAFT_LINE = /ainda é só um rascunho|still a draft/;
type Place = { name: string; mount: () => void; confirm: () => Promise<void>; line: () => HTMLElement };
const PLACES: Place[] = [
  { name: "the Caixa (inbox strip)",
    mount: () => { render(wrapped(<ApprovalsInbox bots={bots} authMode="gated" />)); },
    confirm: async () => { const card = await screen.findByTestId("approval-card-req-1"); fireEvent.click(within(card).getByRole("button", { name: /sempre permitir…|always allow…/i })); fireEvent.click(screen.getByRole("button", { name: CREATE })); },
    line: () => screen.getByText(DRAFT_LINE).closest('[role="status"]') as HTMLElement },
  { name: "the card in a conversation",
    mount: () => { render(wrapped(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />)); },
    confirm: async () => { fireEvent.click(alwaysBtn()); fireEvent.click(screen.getByRole("button", { name: CREATE })); },
    line: () => screen.getByText(DRAFT_LINE) },
  { name: "the card in Hoje (the bare decision)",
    mount: () => { render(wrapped(<ApprovalDecision bare bot="vendas" pending resolve={async () => answer}
      request={{ requestId: "req-1", digest: "d".repeat(64), choices: ["once", "deny", "always"], command: "curl -X POST https://api.example.com/sync", description: "Sync", patternKey: "curl" }} />)); },
    confirm: async () => { fireEvent.click(alwaysBtn()); fireEvent.click(screen.getByRole("button", { name: CREATE })); },
    line: () => screen.getByText(DRAFT_LINE) },
];

describe.each(PLACES)("after \"Sempre permitir\", in $name", (place) => {
  it("(1) says it is still a draft and must be turned on, in PT and in EN, and never that a rule is on", async () => {
    place.mount(); await place.confirm();
    await screen.findByText(DRAFT_LINE);
    const said = place.line().textContent ?? "";
    expect(said.toLowerCase()).toContain(PT.toLowerCase());                       // the strip of the Caixa names the Bot first ("Vendas: permitido desta vez…"): it is outside any row
    expect(said).not.toMatch(/regra ativa|rule on|vale sempre para|resolvida uma vez|regra criada/i);
    cleanup(); setLuveLocale("en"); backend();
    place.mount(); await place.confirm();
    await screen.findByText(DRAFT_LINE);
    expect((place.line().textContent ?? "").toLowerCase()).toContain(EN.toLowerCase());
    expect(document.body.textContent).not.toMatch(/Rule on:|counts every time for/);
  });

  it("(2) offers \"Revisar e ativar\" with a saved draft, and the click OPENS that Bot's draft: it sends nothing", async () => {
    place.mount(); await place.confirm();
    const button = await screen.findByRole("button", { name: REVIEW });
    const sent = vi.fn();
    const before = opened.length;
    fireEvent.click(button);
    expect(opened.slice(before)).toEqual([["vendas", "aa-1"]]);     // the Bot whose card it was, and the draft the server made
    expect(sent).not.toHaveBeenCalled();
    cleanup(); setLuveLocale("en"); backend();
    place.mount(); await place.confirm();
    expect(await screen.findByRole("button", { name: "Review and turn on" })).toBeTruthy();
  });

  it("(2) has NO button without a saved draft: a draft_error, no draft_rule, a draft without an id, or an app that cannot open the screen", async () => {
    for (const bad of [decided({ draft_error: "noncanonical_action" }), decided({}), decided({ draft_rule: { label: "x", state: "draft" } }), decided({ draft_rule: { id: "", label: "x" } }),
      decided({ draft_rule: SAVED, draft_error: "draft_not_saved" }), decided({ draft_rule: "aa-1" })]) {
      cleanup(); answer = bad; backend();
      place.mount(); await place.confirm();
      await screen.findAllByRole("status");
      expect(screen.queryByRole("button", { name: REVIEW })).toBeNull();
    }
    cleanup(); answer = decided({ draft_rule: SAVED }); provided = false; backend();      // a saved draft but nobody to open the screen (the card drawn alone): the sentence stands, nothing to offer
    place.mount(); await place.confirm();
    await screen.findByText(DRAFT_LINE);
    expect(screen.queryByRole("button", { name: REVIEW })).toBeNull();
  });
});

describe("(2) the id of a saved draft", () => {
  it("is read on the same positive evidence as the 'not saved' words, and from nothing else", () => {
    expect(savedDraftId({ draft_rule: SAVED })).toBe("aa-1");
    const bad: Array<Parameters<typeof savedDraftId>[0]> = [null, undefined, {}, { draft_error: "x" }, { draft_rule: SAVED, draft_error: "x" }, { draft_rule: SAVED, draft_error: "" }, { draft_rule: null }, { draft_rule: "aa-1" }, { draft_rule: {} }, { draft_rule: { id: 7 } }, { draft_rule: { id: "" } }];
    for (const one of bad) expect(savedDraftId(one), JSON.stringify(one)).toBeNull();
  });
});

describe("(7) before the click", () => {
  it("the card in a conversation and the card in Hoje say what \"Sempre permitir…\" does, and the button is described by it", () => {
    for (const mount of [PLACES[1].mount, PLACES[2].mount]) {
      cleanup(); mount();
      const hint = screen.getByText(HINT_PT);
      const always = screen.getByRole("button", { name: "Sempre permitir…" });
      expect(always.getAttribute("aria-describedby")).toBe(hint.id);
      expect(hint.id).not.toBe("");
      expect(screen.queryByRole("button", { name: REVIEW })).toBeNull();                 // nothing to review before anything was saved
    }
    cleanup(); setLuveLocale("en"); PLACES[1].mount();
    expect(screen.getByText(HINT_EN)).toBeTruthy();
  });
  it("a card that cannot be approved (a blind request, no 'once') says nothing about a draft", () => {
    render(<ApprovalDecision bare bot="vendas" pending resolve={async () => answer}
      request={{ requestId: "req-1", digest: "d".repeat(64), choices: ["deny"], command: "x", description: "Sync", detailsUnavailable: false }} />);
    expect(screen.queryByText(HINT_PT)).toBeNull();
    cleanup();
    render(<ApprovalDecision bare bot="vendas" pending resolve={async () => answer}
      request={{ requestId: "req-1", digest: "d".repeat(64), choices: ["once", "deny", "always"], command: "x", description: "Sync", detailsUnavailable: true }} />);
    expect(screen.queryByText(HINT_PT)).toBeNull();
  });
});

describe("the words are in the dictionary, both languages", () => {
  it("every key AA-2 added has a PT and an EN sentence, and PT/EN differ", () => {
    for (const key of ["alwaysAllowHint", "reviewAndActivate", "alwaysArrivedBanner", "alwaysArrivedGone", "alwaysCoversExact", "alwaysCoversMore", "alwaysCoversFacts", "alwaysCoversTool", "alwaysCoversNeutral", "alwaysOnDoes", "alwaysActiveHere", "ruleChangedReadAgain", "ruleNotAppliedHead", "ruleActivateUnapplied", "alwaysStripClose", "approvalInlineAlways", "actionAlwaysResolved"]) {
      const pt = (translations.pt as Record<string, string>)[key], en = (translations.en as Record<string, string>)[key];
      expect(pt, key).toBeTruthy(); expect(en, key).toBeTruthy(); expect(pt).not.toBe(en);
    }
  });
});
