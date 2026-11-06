// tests/unit/approvals/page-review.test.tsx
// 21a (docs/contracts/pages-review-v0.md §2-§3): the approval card of a request to save a page. The proposal and the diff are Bot-written text and are
// TEXT ONLY (a <script> in them is just characters); the label is "Aprovar e salvar" only when a proposal exists, else "Aprovar" and "sem prévia";
// 409 page_changed decides nothing, says so in words, and offers "Negar: a página mudou" with the standard reason; a page-review approval is never in a
// batch; a truncated preview says it. The same card in the Caixa, in Hoje and in the conversation (they share ApprovalDecision).
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, configure } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { ApprovalDecision, InlineApproval } from "@/components/chat/InlineApproval";
import { Hoje } from "@/components/Hoje";
import { PageReview } from "@/components/approvals/PageReview";
import { batchItems, approvalErrorText, isPageReview, reviewApproveKey, mayBeRefusedByHermes } from "@/components/approvals/decide";
import { setCustomFetchJSON, resetCsrfToken, resolveApproval, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Approval, Bot } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const bots: Bot[] = [{ name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status: "waiting_approval",
  display: { label: "Vendas", role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } } }];
const HOSTILE = `<script>globalThis.__pr=1</script><img src=x onerror="globalThis.__pr=1"><a href="javascript:globalThis.__pr=1">x</a>`;
const REASON = "Uma pessoa alterou a página depois do seu pedido; releia e refaça a edição.";
const SHA = "a".repeat(64);
const now = Date.now();

const pageApproval = (over: Partial<Approval> = {}): Approval => ({
  request_id: "req-page", bot: "vendas", source: "run", surface: "run", mechanism: "hook_approve", tool: "write_file", rule_id: "r-review", run_id: "run-1",
  digest: "d".repeat(64), allowed_choices: ["once", "deny"], action_class_hash: "h-page", status: "pending",
  created_at: new Date(now - 60_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(),
  page: { slug: "plano", base_sha: SHA },
  proposal: { kind: "whole", path_tag: "workspace:pages/plano.md", size: 90, truncated: false, content: `# Plano\n\nnovo texto ${HOSTILE}` },
  review: { preview: true, label: "approve_and_save" },
  diff: { format: "unified", lines: ["--- agora", "+++ proposta", "@@ -1,3 +1,3 @@", " # Plano", "-texto que a pessoa escreveu", `+novo texto ${HOSTILE}`], truncated: false },
  ...over,
});
const curl = (over: Partial<Approval> = {}): Approval => ({
  request_id: "req-curl", bot: "vendas", source: "run", surface: "run", mechanism: "hook_approve", tool: "terminal", rule_id: null, digest: "c".repeat(64),
  command_redacted: "curl https://x.test/", description: "buscar", allowed_choices: ["once", "deny"], action_class_hash: "h-curl", status: "pending",
  created_at: new Date(now - 30_000).toISOString(), expires_at: new Date(now + 3_600_000).toISOString(), ...over,
});

type Call = { method: string; url: string; body?: any };
function backend(list: Approval[], opts: { onceError?: ApiError } = {}) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "tester", auth_mode: "gated" };
    if (method === "GET" && url.includes("/approvals")) return { ok: true, approvals: list, total: list.length };
    if (method === "POST" && url.includes("/resolve")) {
      if (body.choice === "once" && opts.onceError) throw opts.onceError;
      return { ok: true, reason_delivered: body.choice === "deny" ? true : undefined };
    }
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
  return calls;
}
const changed = () => new ApiError({ code: "page_changed", message: "The page changed after this request", status: 409 });
const card = (id = "req-page") => screen.findByTestId(`approval-card-${id}`);

beforeEach(() => { cleanup(); setLuveLocale("pt"); resetCsrfToken(); delete (globalThis as any).__pr; });
afterEach(() => { setCustomFetchJSON(null); });

describe("the card in the Caixa", () => {
  it("shows the diff and the text the Bot wants to save as TEXT: nothing in it becomes an element or runs", async () => {
    backend([pageApproval()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    const diff = within(c).getByTestId("page-review-diff");
    expect(diff.textContent).toContain(`+novo texto ${HOSTILE}`);                      // the characters, readable
    expect(diff.textContent).toContain("-texto que a pessoa escreveu");              // the person's own line being removed
    expect(within(c).getByTestId("page-review-preview").textContent).toContain(HOSTILE);
    expect(c.querySelectorAll("script, iframe, img[src='x'], a[href^='javascript' i]")).toHaveLength(0);
    expect([...c.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)))).toHaveLength(0);
    expect((globalThis as any).__pr).toBeUndefined();
    expect(within(c).getByText("O Bot quer salvar plano inteira, no lugar do que está lá.")).toBeTruthy();
  });

  it("the label is 'Aprovar e salvar' with a proposal; 'Sempre permitir esta página' names the page", async () => {
    backend([pageApproval()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).getByRole("button", { name: "Aprovar e salvar" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Sempre permitir esta página" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Permitir uma vez" })).toBeNull();
  });

  it("an old row (no proposal): says 'sem prévia' and the label is plain 'Aprovar'", async () => {
    backend([pageApproval({ proposal: null, diff: null, review: { preview: false, label: "approve" } })]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).getByTestId("page-review-none").textContent).toMatch(/^Sem prévia/);
    expect(within(c).getByRole("button", { name: "Aprovar" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Aprovar e salvar" })).toBeNull();
  });

  it("the backend's label alone is not enough: 'approve_and_save' without a proposal still reads 'Aprovar'", () => {
    expect(reviewApproveKey({ review: { preview: true, label: "approve_and_save" }, proposal: null })).toBe("pageReviewApprove");
    expect(reviewApproveKey({ review: { preview: true, label: "approve_and_save" }, proposal: pageApproval().proposal })).toBe("pageReviewApproveSave");
    expect(reviewApproveKey({ review: null, proposal: null })).toBeNull();
    expect(reviewApproveKey({ review: { preview: true, label: "approve_and_save" }, proposal: { ...pageApproval().proposal!, truncated: true } })).toBe("pageReviewApproveCut");
  });

  it("any other approval is untouched: no review block, the usual labels", async () => {
    backend([curl()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card("req-curl");
    expect(within(c).queryByTestId("page-review")).toBeNull();
    expect(within(c).getByRole("button", { name: "Permitir uma vez" })).toBeTruthy();
    expect(within(c).getByRole("button", { name: "Sempre permitir…" })).toBeTruthy();
  });

  it("a diff cut at its own line limit says so; the label stays 'Aprovar e salvar' (the whole text is in the preview)", async () => {
    backend([pageApproval({ diff: { ...pageApproval().diff!, truncated: true } })]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).getByTestId("page-review-diff-truncated").textContent).toBe("O diff mostra só as primeiras linhas.");
    expect(within(c).getByRole("button", { name: "Aprovar e salvar" })).toBeTruthy();
  });

  // red team M1 (29/10): a proposal cut at 64 KiB hides the END of what would be saved; the server's diff against the cut text would show the
  // page's tail as removed and never the tail the Bot adds. So: the cut is said first, the diff is withheld, the button says what it does.
  it("M1: a CUT proposal says so first, withholds the (false) diff, opens the text, and the button reads 'Aprovar sem ver tudo'", async () => {
    const cut = pageApproval({ proposal: { ...pageApproval().proposal!, truncated: true, size: 300_000 }, diff: { ...pageApproval().diff!, lines: ["--- agora", "+++ proposta", "@@ -1,1 +0,0 @@", "-linha da pessoa que o corte faria parecer apagada"] } });
    backend([cut]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).getByTestId("page-review-cut").textContent).toBe("Atenção: o Bot enviou 293 KiB, mas só os primeiros 64 KiB aparecem aqui. Você não vê o fim do texto, e o texto inteiro é o que seria salvo.");
    expect(within(c).queryByTestId("page-review-diff")).toBeNull();                       // the diff that would lie is not drawn at all
    expect(c.textContent).not.toContain("linha da pessoa que o corte faria parecer apagada");
    expect(within(c).getByTestId("page-review-diff-withheld").textContent).toMatch(/^O diff não é mostrado/);
    expect((within(c).getByTestId("page-review-preview") as HTMLDetailsElement).open).toBe(true);
    expect(within(c).getByTestId("page-review-truncated").textContent).toBe("A prévia mostra só o começo: o Bot enviou 293 KiB.");
    expect(within(c).getByRole("button", { name: "Aprovar sem ver tudo" })).toBeTruthy();
    expect(within(c).queryByRole("button", { name: "Aprovar e salvar" })).toBeNull();
    expect(within(c).queryByRole("button", { name: "Aprovar" })).toBeNull();
  });

  it("M1: the same label in Hoje and in the conversation (ApprovalDecision)", () => {
    const cut = pageApproval({ proposal: { ...pageApproval().proposal!, truncated: true, size: 300_000 } });
    backend([cut]);
    render(<ApprovalDecision bare bot="vendas" pending request={{ requestId: cut.request_id, digest: cut.digest, choices: cut.allowed_choices, tool: cut.tool,
      pageReview: { page: cut.page, proposal: cut.proposal, review: cut.review, diff: cut.diff } }} resolve={(body) => resolveApproval(cut.request_id, body)} />);
    expect(screen.getByRole("button", { name: "Aprovar sem ver tudo" })).toBeTruthy();
    expect(screen.getByTestId("page-review-cut")).toBeTruthy();
    expect(screen.queryByTestId("page-review-diff")).toBeNull();
  });

  it("a request that is not about ONE page (a multi-file patch) says there is no page check and no diff; the contract's label stays", async () => {
    backend([pageApproval({ page: null, diff: null, proposal: { kind: "v4a", path_tag: "workspace:pages/a.md", size: 40, truncated: false, content: "*** Update File: pages/a.md\n*** Update File: pages/b.md" } })]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).getByTestId("page-review-no-guard").textContent).toBe("Este pedido não é de uma página só: o LuveBot não confere se a página mudou depois do pedido e não mostra o diff.");
    expect(within(c).getByRole("button", { name: "Aprovar e salvar" })).toBeTruthy();
    expect(within(c).queryByTestId("page-review-cut")).toBeNull();
  });

  it("one page, not cut: no 'no guard' note, no cut warning", async () => {
    backend([pageApproval()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).queryByTestId("page-review-no-guard")).toBeNull();
    expect(within(c).queryByTestId("page-review-cut")).toBeNull();
  });

  it("a page that does not exist yet says it is new; an unchanged proposal says there is no difference", async () => {
    backend([pageApproval({ page: { slug: "nova", base_sha: null }, diff: { format: "unified", lines: [], truncated: false } })]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).getByTestId("page-review-new").textContent).toBe("Página nova: ainda não existe.");
    expect(within(c).getByText("Sem diferença: a proposta é igual à página de agora.")).toBeTruthy();
  });

  it("replace and v4a proposals are text too: '- old / + new' lines, or the patch as it is", () => {
    const rep = pageApproval({ proposal: { kind: "replace", path_tag: "workspace:pages/plano.md", size: 20, truncated: false, content: `- velho\n+ novo ${HOSTILE}` }, diff: null });
    const view = render(<PageReview approval={rep} />);
    expect(view.container.textContent).toContain(`+ novo ${HOSTILE}`);
    expect(view.container.querySelectorAll("script, img")).toHaveLength(0);
    view.unmount();
    const v4a = pageApproval({ proposal: { kind: "v4a", path_tag: "workspace:pages/plano.md", size: 20, truncated: false, content: `*** Update File: pages/plano.md\n${HOSTILE}` }, diff: null });
    const view2 = render(<PageReview approval={v4a} />);
    expect(view2.container.textContent).toContain("*** Update File: pages/plano.md");
    expect(view2.container.querySelectorAll("script, img")).toHaveLength(0);
  });
});

describe("page_changed (409)", () => {
  it("decides nothing, says so in words, and offers 'Negar: a página mudou' with the standard reason; deny is one click and goes through", async () => {
    const calls = backend([pageApproval()], { onceError: changed() });
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const c = await card();
    expect(within(c).queryByRole("button", { name: "Negar: a página mudou" })).toBeNull();
    fireEvent.click(within(c).getByRole("button", { name: "Aprovar e salvar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("A página mudou depois do pedido do Bot, então nada foi decidido");
    expect(within(await card()).getByTestId("approval-technical-req-page")).toBeTruthy();   // still there, still pending: the card did not go away
    const once = calls.filter((x) => x.method === "POST");
    expect(once).toHaveLength(1);
    expect(once[0].body).toEqual({ digest: "d".repeat(64), choice: "once" });
    fireEvent.click(within(await card()).getByTestId("deny-changed-req-page"));
    await waitFor(() => expect(calls.filter((x) => x.method === "POST")).toHaveLength(2));
    expect(calls.filter((x) => x.method === "POST")[1].body).toEqual({ digest: "d".repeat(64), choice: "deny", reason: REASON });
  });

  it("is not the generic 'someone else decided' sentence", () => {
    const t = (k: string) => k;
    expect(approvalErrorText(changed(), t as any)).toBe("errorPageChanged");
    expect(approvalErrorText(new ApiError({ code: "stale", message: "x", status: 409 }), t as any)).toBe("errorStaleConflict");
    expect(approvalErrorText(new ApiError({ code: "not_batchable", message: "x", status: 422 }), t as any)).toBe("errorNotBatchable");
    expect(approvalErrorText(new ApiError({ code: "multiple_paths", message: "x", status: 422 }), t as any)).toBe("errorMultiplePaths");
  });
});

describe("never in a batch", () => {
  it("no checkbox on the card, 'Selecionar todas' leaves it out, and it says to decide it alone", async () => {
    backend([pageApproval(), curl()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const page = await card(), other = await card("req-curl");
    expect(within(page).queryByRole("checkbox")).toBeNull();
    expect(within(other).getByRole("checkbox")).toBeTruthy();
    expect(within(page).getByTestId("page-review-alone").textContent).toBe("Decida este sozinho: cada página tem o seu diff.");
    fireEvent.click(screen.getByLabelText("Selecionar todas as pendentes"));
    expect(await screen.findByText("1 selecionado(s)")).toBeTruthy();                   // only the curl
    expect((within(other).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });

  it("batchItems refuses a page review (the server answers 422 not_batchable too)", () => {
    expect(isPageReview(pageApproval())).toBe(true);
    expect(isPageReview(curl())).toBe(false);
    expect(batchItems([curl()], "once", "")).not.toBeNull();
    expect(batchItems([curl(), pageApproval({ action_class_hash: "h-curl" })], "once", "")).toBeNull();
    expect(batchItems([pageApproval()], "deny", "motivo")).toBeNull();
  });
});

describe("the same card in Hoje and in the conversation (ApprovalDecision)", () => {
  const request = (a: Approval) => ({ requestId: a.request_id, digest: a.digest, choices: a.allowed_choices, tool: a.tool, ruleId: a.rule_id,
    pageReview: a.review ? { page: a.page, proposal: a.proposal, review: a.review, diff: a.diff } : undefined });

  it("shows the review, the 'Aprovar e salvar' label, and handles page_changed the same way", async () => {
    const a = pageApproval();
    const calls = backend([a], { onceError: changed() });
    render(<ApprovalDecision bare bot="vendas" pending request={request(a)} resolve={(body) => resolveApproval(a.request_id, body)} />);
    expect(screen.getByTestId("page-review-diff").textContent).toContain("-texto que a pessoa escreveu");
    expect(screen.getByRole("button", { name: "Sempre permitir esta página" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aprovar e salvar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nada foi decidido");
    fireEvent.click(await screen.findByTestId("deny-changed"));
    await waitFor(() => expect(calls.filter((x) => x.method === "POST")).toHaveLength(2));
    expect(calls.filter((x) => x.method === "POST")[1].body).toEqual({ digest: a.digest, choice: "deny", reason: REASON });
    expect((globalThis as any).__pr).toBeUndefined();
  });

  it("a non-file request keeps the usual card", () => {
    const a = curl();
    backend([a]);
    render(<ApprovalDecision bare bot="vendas" pending request={request(a)} resolve={(body) => resolveApproval(a.request_id, body)} />);
    expect(screen.queryByTestId("page-review")).toBeNull();
    expect(screen.getByRole("button", { name: "Permitir uma vez" })).toBeTruthy();
  });
});

// pages-review-v0 §6: Hermes's write_file overwrites an EXISTING page only if the Bot read it whole first; else it refuses and leaves the page alone, and the Bot
// asks again. LuveBot cannot see that result (the hook runs before the tool), so the DECIDED row of exactly that case says what MAY happen, never that it did.
describe("a decided whole-page save over a page that exists", () => {
  const MAY = "Aprovado. Para trocar uma página que já existe, o Hermes só grava se o Bot a leu inteira antes; se não leu (ou a página mudou desde a leitura), recusa, deixa a página como está e o Bot lê e pede de novo: aí você verá outro pedido.";
  const decided = (over: Partial<Approval> = {}) => pageApproval({ status: "decided", decided_choice: "once", ...over });
  const inAll = async (list: Approval[]) => {
    backend(list);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    fireEvent.change(await screen.findByLabelText("Filtrar por status"), { target: { value: "all" } });   // a decided row is in "Todas"
    return card(list[0].request_id);
  };

  it("says what may happen, calmly (no alert, no status), for whole + an existing page + once", async () => {
    const c = await inAll([decided()]);
    const line = within(c).getByTestId("page-review-may-refuse");
    expect(line.textContent).toBe(MAY);
    expect(line.getAttribute("role")).toBeNull();
    expect(within(c).queryByRole("alert")).toBeNull();
    expect(line.textContent).not.toMatch(/gravada|foi recusada|não foi gravada/);                      // "may", never "did"
  });

  it("not for replace, v4a, a new page (base_sha null), a deny, or a request not decided yet", async () => {
    const whole = pageApproval().proposal!;
    for (const over of [
      { proposal: { ...whole, kind: "replace" as const } },
      { proposal: { ...whole, kind: "v4a" as const } },
      { page: { slug: "plano", base_sha: null } },
      { decided_choice: "deny" as const },
      { status: "pending" as const, decided_choice: null },
      { proposal: null, diff: null, review: { preview: false, label: "approve" as const } },
    ]) {
      cleanup();
      const c = await inAll([decided(over)]);
      expect(within(c).queryByTestId("page-review-may-refuse")).toBeNull();
    }
    cleanup();
    const c = await inAll([{ ...curl(), status: "decided", decided_choice: "once" }]);               // not a page at all
    expect(within(c).queryByTestId("page-review-may-refuse")).toBeNull();
  });

  it("the predicate is exactly that case", () => {
    const base = { page: { slug: "p", base_sha: SHA }, proposal: pageApproval().proposal!, decided_choice: "once" as const };
    expect(mayBeRefusedByHermes(base)).toBe(true);
    expect(mayBeRefusedByHermes({ ...base, proposal: { ...base.proposal, kind: "replace" } })).toBe(false);
    expect(mayBeRefusedByHermes({ ...base, page: { slug: "p", base_sha: null } })).toBe(false);
    expect(mayBeRefusedByHermes({ ...base, page: null })).toBe(false);
    expect(mayBeRefusedByHermes({ ...base, decided_choice: "deny" })).toBe(false);
    expect(mayBeRefusedByHermes({ ...base, decided_choice: null })).toBe(false);
  });

  it("right after the click the row keeps its page and proposal, so the line is there under 'Todas'", async () => {
    backend([pageApproval()]);
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    fireEvent.click(within(await card()).getByRole("button", { name: "Aprovar e salvar" }));
    await waitFor(() => expect(screen.queryByTestId("approval-card-req-page")).toBeNull());           // decided: it leaves "Pendentes"
    fireEvent.change(screen.getByLabelText("Filtrar por status"), { target: { value: "all" } });
    expect((await within(await card()).findByTestId("page-review-may-refuse")).textContent).toBe(MAY);
  });
});

// The same sentence on the two other places that show the click's result: the card in the conversation and the card in Hoje (they share ApprovalDecision).
// There it stands where "Permitida uma vez." stands (it opens with "Aprovado." itself); every other case keeps the short line.
describe("the sentence right after the click, in the conversation and in Hoje", () => {
  const MAY = "Aprovado. Para trocar uma página que já existe, o Hermes só grava se o Bot a leu inteira antes; se não leu (ou a página mudou desde a leitura), recusa, deixa a página como está e o Bot lê e pede de novo: aí você verá outro pedido.";
  const MAY_EN = "Approved. To replace a page that already exists, Hermes only saves it if the Bot read the whole page first; if it did not (or the page changed since it read it), Hermes refuses, leaves the page as it is, and the Bot reads it and asks again: you will then see another request.";
  const frameOf = (a: Approval) => ({ event: "approval.request", request_id: a.request_id, luvebot_digest: a.digest, choices: a.allowed_choices, description: "salvar", command: "write_file", pattern_key: "k" });
  /** the card in the conversation, once the stored row (the review, the page) has come in */
  async function inConversation(a: Approval) {
    backend([a]);
    render(<InlineApproval frame={frameOf(a)} bot="vendas" runId="run-1" pending />);
    await screen.findByRole("button", { name: "Aprovar e salvar" });
  }
  const approve = async () => { fireEvent.click(screen.getByRole("button", { name: "Aprovar e salvar" })); return (await screen.findByRole("status")).textContent; };
  const whole = () => pageApproval().proposal!;

  it("in the conversation: whole + an existing page + once says Hermes may refuse, calmly, instead of the short line", async () => {
    await inConversation(pageApproval());
    expect(await approve()).toBe(MAY);
    const line = screen.getByRole("status");
    expect(line.textContent).not.toContain("Permitida uma vez.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(line.textContent).not.toMatch(/gravada|foi recusada|não foi gravada/);                      // "may", never "did"
  });

  it("in the conversation: replace, v4a and a new page keep 'Permitida uma vez.'", async () => {
    for (const over of [{ proposal: { ...whole(), kind: "replace" as const } }, { proposal: { ...whole(), kind: "v4a" as const } }, { page: { slug: "plano", base_sha: null } }]) {
      cleanup();
      await inConversation(pageApproval(over));
      expect(await approve()).toBe("Permitida uma vez.");
    }
  });

  it("in the conversation: a denial and an 'always' never say it (only a once does)", async () => {
    await inConversation(pageApproval());
    fireEvent.click(screen.getByRole("button", { name: "Negar…" }));
    fireEvent.change(screen.getByLabelText(/Motivo da negação/), { target: { value: "não agora" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar negação" }));
    expect((await screen.findByRole("status")).textContent).not.toContain("Aprovado.");
    expect(screen.getByRole("status").textContent).not.toBe(MAY);
    cleanup();
    await inConversation(pageApproval());
    fireEvent.click(screen.getByRole("button", { name: "Sempre permitir esta página" }));
    fireEvent.click(screen.getByRole("button", { name: "Criar rascunho e permitir uma vez" }));
    expect((await screen.findByRole("status")).textContent).not.toBe(MAY);
  });

  it("in English it is the English sentence", async () => {
    setLuveLocale("en");
    backend([pageApproval()]);
    render(<InlineApproval frame={frameOf(pageApproval())} bot="vendas" runId="run-1" pending />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve and save" }));
    expect((await screen.findByRole("status")).textContent).toBe(MAY_EN);
  });

  it("in Hoje: the same sentence for the same case, and the short line for a new page", async () => {
    backend([pageApproval()]);
    render(<Hoje approvals={[pageApproval()]} />);
    expect(await approve()).toBe(MAY);
    cleanup();
    backend([pageApproval({ page: { slug: "plano", base_sha: null } })]);
    render(<Hoje approvals={[pageApproval({ page: { slug: "plano", base_sha: null } })]} />);
    expect(await approve()).toBe("Permitida uma vez.");
  });
});
