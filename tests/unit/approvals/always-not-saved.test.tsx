// tests/unit/approvals/always-not-saved.test.tsx
// "Always allow" is approved ONCE and its rule is only a DRAFT (invariant 6). When the server could not save the draft it says so in `draft_error` next to "decided" (M2): the screen says, next to "approved this once", that the rule was
// NOT saved and, for `fold_divergence` (R-13: a letter such as the sharp s or the final sigma that the engine and the network read differently, so no allow can cover the command), why. In words, in PT and EN, never the raw code
// (contract v0.11 section 8, R-15, A-211). The card in the conversation and the Caixa are the two places; Hoje draws the same card.
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, configure } from "@testing-library/react";
import { InlineApproval } from "@/components/chat/InlineApproval";
import { ApprovalsInbox } from "@/components/approvals";
import { alwaysNotSavedText } from "@/components/approvals/decide";
import { parseSse } from "@/components/transcript";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const real = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));
const stored = { ...real, luvebot_digest: "dg-123" };
const PT_FOLD = "Aprovado desta vez. \"Sempre permitir\" não foi salvo: o comando tem uma letra (como ß ou ς) que o LuveBot e a rede leem de jeitos diferentes, então nenhuma regra pode liberá-lo de vez. Você será perguntado de novo.";
const EN_FOLD = "Approved this once. \"Always allow\" was not saved: the command has a letter (such as ß or ς) that LuveBot and the network read differently, so no rule can allow it for good. You will be asked again.";

const pending = { request_id: "req-fold", bot: "vendas", surface: "run", mechanism: "hook_approve", source: "run", run_id: "run_fold", digest: "d".repeat(64), command_redacted: "curl http://straße.de/", description: "Leia antes",
  pattern_keys: [], allowed_choices: ["once", "deny"], action_class_hash: "h", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), status: "pending" };
/** What the server sends when the draft WAS saved (and only then: `draft_rule`, no `draft_error`). A-216: "created" needs this evidence; the absence of an error is not it. */
const SAVED = { id: "aa-1", label: "x", level: "allow", scope: { kind: "bot", ref: "vendas" }, state: "draft", origin: "always_allow" };
const bots = [{ name: "vendas", is_default: false, display: { label: "Vendas", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } }, status: "idle" }];

/** The server of both places: the approval list, and the answer of the resolve routes (the Caixa's and the run's), with or without `draft_error`. */
function backend(answer: Record<string, unknown>) {
  resetCsrfToken();
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (init?.method === "POST" && /\/(resolve|approval)$/.test(url.split("?")[0])) return { approval: { ...pending, status: "consumed", decided_choice: "once" }, ...answer };
    if (url.includes("/approvals")) return { ok: true, approvals: [pending], total: 1 };
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
}
beforeEach(() => { cleanup(); setLuveLocale("pt"); });
afterEach(() => { cleanup(); setCustomFetchJSON(null); });

describe("the card in the conversation (and in Hoje, which draws the same card)", () => {
  async function alwaysAllow() {
    render(<InlineApproval frame={stored} bot="vendas" runId="run_r1" pending />);
    fireEvent.click(screen.getByText(/Sempre permitir…|Always allow…/));
    fireEvent.click(await screen.findByRole("button", { name: /Criar rascunho e permitir uma vez|Create draft and allow once/ }));
  }

  it("fold_divergence: 'approved this once', the rule was NOT saved and why, in Portuguese; never the code", async () => {
    backend({ draft_error: "fold_divergence" });
    await alwaysAllow();
    const line = await screen.findByRole("status");
    await waitFor(() => expect(line.textContent).toContain(PT_FOLD));
    expect(document.body.textContent).not.toContain("fold_divergence");
    expect(screen.queryByText(/Aprovado\. Criamos|rascunho de regra criado/i)).toBeNull();               // the draft was NOT made: nothing says it was
  });

  it("in English", async () => {
    setLuveLocale("en");
    backend({ draft_error: "fold_divergence" });
    await alwaysAllow();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(EN_FOLD));
    expect(document.body.textContent).not.toContain("fold_divergence");
  });

  // Every code `approvals._draft` hands back (backend/rules.py `draft_from_always_allow` + the store), and one the screen has never seen: each says "approved this once", "not saved", its reason, "asked again"; never the code, never "saved".
  const REASONS = { noncanonical_action: "alwaysNotSavedNoncanonical", command_too_long: "alwaysNotSavedTooLong", draft_not_saved: "alwaysNotSavedStore", multiple_paths: "errMultiplePaths",
    unusable_path: "errUnusablePath", multiple_recipients: "errMultipleRecipients", unusable_recipient: "errUnusableRecipient", a_code_from_the_future: "alwaysNotSavedGeneric" } as const;
  for (const [code, key] of Object.entries(REASONS)) {
    for (const lang of ["pt", "en"] as const) {
      it(`${code} (${lang}): approved once, NOT saved, why, and asked again; never the code`, async () => {
        setLuveLocale(lang);
        backend({ draft_error: code });
        await alwaysAllow();
        const w = translations[lang];
        await waitFor(() => expect(screen.getByRole("status").textContent).toContain(`${w.alwaysNotSavedHead} ${w[key]} ${w.alwaysNotSavedAgain}`));
        expect(document.body.textContent).not.toContain(code);
        expect(screen.getByRole("status").textContent).not.toContain(w.approvalInlineAlways);
      });
    }
  }

  it("A-216: neither a draft_rule nor a draft_error is not 'saved' either; the card says the general 'not saved'", async () => {
    backend({});
    await alwaysAllow();
    const w = translations.pt;
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(`${w.alwaysNotSavedHead} ${w.alwaysNotSavedGeneric} ${w.alwaysNotSavedAgain}`));
    expect(screen.getByRole("status").textContent).not.toContain(w.approvalInlineAlways);
  });

  it("no draft_error: the card says what it always said (the draft was saved)", async () => {
    backend({ draft_rule: { id: "aa-1", label: "x", level: "allow", scope: { kind: "bot", ref: "vendas" }, state: "draft", origin: "always_allow" } });
    await alwaysAllow();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(translations.pt.approvalInlineAlways));
    expect(screen.getByRole("status").textContent).not.toContain("não foi salvo");
  });
});

describe("the Caixa de Aprovações", () => {
  async function alwaysAllow() {
    render(<ApprovalsInbox bots={bots as never} authMode="gated" />);
    fireEvent.click(await screen.findByRole("button", { name: /Sempre permitir|Always allow/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Criar rascunho e permitir uma vez|Create draft and allow once/ }));
  }

  it("fold_divergence: the confirmation says 'approved this once' and that the rule was NOT saved, and why; never the code", async () => {
    backend({ draft_error: "fold_divergence" });
    await alwaysAllow();
    expect(await screen.findByText(PT_FOLD)).toBeTruthy();
    expect(document.body.textContent).not.toContain("fold_divergence");
    expect(screen.queryByText(/regra criada em rascunho/)).toBeNull();
  });

  it("in English", async () => {
    setLuveLocale("en");
    backend({ draft_error: "fold_divergence" });
    await alwaysAllow();
    expect(await screen.findByText(EN_FOLD)).toBeTruthy();
  });

  it("the 'not saved' line is a warning, not the green good news of a decision that went through whole (and the success line stays for the draft that was saved)", async () => {
    backend({ draft_error: "fold_divergence" });
    await alwaysAllow();
    const line = (await screen.findByText(PT_FOLD)).closest('[role="status"]')!;
    expect(line.className).toContain("--color-warning");
    expect(line.className).not.toContain("--color-success");
    cleanup(); backend({ draft_rule: SAVED });
    await alwaysAllow();
    const ok = (await screen.findByText(/A regra ainda é só um rascunho: ative para valer sempre/)).closest('[role="status"]')!;
    expect(ok.className).toContain("--color-success");
  });

  it("any other code: the confirmation says approved once, NOT saved, its reason (or the general one for a code never seen), never the code and never 'created'", async () => {
    const w = translations.pt;
    for (const [code, key] of [["noncanonical_action", "alwaysNotSavedNoncanonical"], ["draft_not_saved", "alwaysNotSavedStore"], ["a_code_from_the_future", "alwaysNotSavedGeneric"]] as const) {
      cleanup(); backend({ draft_error: code });
      await alwaysAllow();
      expect(await screen.findByText(`${w.alwaysNotSavedHead} ${w[key]} ${w.alwaysNotSavedAgain}`)).toBeTruthy();
      expect(document.body.textContent).not.toContain(code);
      expect(screen.queryByText(/regra criada em rascunho/)).toBeNull();
      expect(screen.queryByText(/ainda é só um rascunho/)).toBeNull();   // the draft sentence of AA-2 is no more true here than the old one
    }
  });

  it("a draft_rule and no draft_error: the confirmation says what it always said", async () => {
    backend({ draft_rule: SAVED });
    await alwaysAllow();
    expect(await screen.findByText(/A regra ainda é só um rascunho: ative para valer sempre/)).toBeTruthy();
  });

  it("A-216: neither a draft_rule nor a draft_error is not 'created'; it is the general 'not saved', in the warning's colors", async () => {
    backend({});
    await alwaysAllow();
    const w = translations.pt;
    const line = (await screen.findByText(`${w.alwaysNotSavedHead} ${w.alwaysNotSavedGeneric} ${w.alwaysNotSavedAgain}`)).closest('[role="status"]')!;
    expect(line.className).toContain("--color-warning");
    expect(screen.queryByText(/regra criada em rascunho/)).toBeNull();
  });
});

describe("the helper", () => {
  const t = (k: keyof typeof translations.pt) => translations.pt[k];
  it("a code that has its own words gets them, any other code the general ones; 'saved' (null) only with a draft_rule and no draft_error; anything else is the general 'not saved' (A-216)", () => {
    expect(alwaysNotSavedText({ draft_error: "fold_divergence" }, t as never)).toBe(PT_FOLD);
    expect(alwaysNotSavedText({ draft_error: "draft_not_saved" }, t as never)).toBe(`${translations.pt.alwaysNotSavedHead} ${translations.pt.alwaysNotSavedStore} ${translations.pt.alwaysNotSavedAgain}`);
    expect(alwaysNotSavedText({ draft_error: "unusable_path" }, t as never)).toBe(`${translations.pt.alwaysNotSavedHead} ${translations.pt.errUnusablePath} ${translations.pt.alwaysNotSavedAgain}`);
    expect(alwaysNotSavedText({ draft_error: "never_seen" }, t as never)).toBe(`${translations.pt.alwaysNotSavedHead} ${translations.pt.alwaysNotSavedGeneric} ${translations.pt.alwaysNotSavedAgain}`);
    expect(alwaysNotSavedText({ draft_rule: SAVED }, t as never)).toBeNull();                                  // the one positive evidence: a draft_rule and no draft_error
    expect(alwaysNotSavedText({ draft_rule: SAVED, draft_error: "fold_divergence" }, t as never)).toBe(PT_FOLD);   // both: not saved
    const general = `${translations.pt.alwaysNotSavedHead} ${translations.pt.alwaysNotSavedGeneric} ${translations.pt.alwaysNotSavedAgain}`;
    for (const none of [undefined, null, {}, { draft_rule: null }, { draft_rule: "x" }, { draft_rule: true }, { draft_error: "" }, { draft_error: 7 }, { draft_error: null }, { draft_error: true }, { draft_error: {} },
      ...["", true, 7, {}, null].map((draft_error) => ({ draft_rule: SAVED, draft_error }))]) expect(alwaysNotSavedText(none as never, t as never)).toBe(general);
  });
});
