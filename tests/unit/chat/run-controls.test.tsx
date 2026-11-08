// tests/unit/chat/run-controls.test.tsx
// Contract v0.9 §1.2-1.4: a Hermes main can make a run wait for a person's answer (clarify: ONE question, its choices, one or several)
// or lose track of it (unknown). Both show inside the conversation, decided only by a click with a login (invariant 6: the Bot uses clarify as a
// soft confirmation), the Bot's words as text only. Clarify never reaches the stream: the run is read by GET every 3 s while the turn is open.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, configure } from "@testing-library/react";
import { RunControls, POLL_MS } from "@/components/chat/RunControls";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { displayChoice } from "@/lib/clarifyText";

// A test waits for a state with findBy/waitFor and moves on the moment it holds; these ceilings only matter on a loaded machine (the CEO's
// reached load 240): the default 1 s per wait and 5 s per test are about the machine, not about what the test proves.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

type Posts = Array<{ url: string; body: any; csrf: string | null }>;
function world(run: () => any, opts: { post?: (url: string, body: any) => unknown; auth?: string } = {}) {
  const posts: Posts = []; let gets = 0;
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: opts.auth ?? "gated" };
    if (method === "GET" && url.endsWith("/bots/vendas/runs/r1")) { gets++; return { run: run() }; }
    if (method === "POST") {
      const body = JSON.parse(String(init?.body));
      posts.push({ url, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      return opts.post ? opts.post(url, body) : { clarify: { request_id: "q1", status: "resolved" }, run: { id: "r1", status: "started" } };
    }
    throw new Error("unexpected " + method + " " + url);
  });
  return { posts, gets: () => gets };
}
const clarify = (over: Record<string, unknown> = {}) => ({ kind: "clarify", request_id: "q1", question: "Qual <b>cliente</b>?", choices: [], multi_select: false, ...over });
const runWith = (controls: any[]) => ({ id: "r1", status: "started", execution_generation: 7, pending_controls: controls });
const UNKNOWN = { id: "r1", status: "unknown", execution_generation: 3, pending_controls: [], resolution: { needed: true, admission_id: "a1", execution_generation: 3 } };
const mount = (onNeedsYou?: (b: boolean) => void) => render(<RunControls bot="vendas" runId="r1" active pollMs={20} onNeedsYou={onNeedsYou} />);
const refuse = (code: string, status = 409) => () => { throw new ApiError({ code, message: "x", status }); };

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => setCustomFetchJSON(null));

describe("pergunta do Bot (clarify)", () => {
  it("polls every 3 s by contract", () => { expect(POLL_MS).toBe(3000); });

  it("free text (no choices): the question is TEXT (never markup); sends only on a click, the exact body with the generation it saw and the CSRF", async () => {
    const w = world(() => runWith([clarify({ timeout_s: 120 })]));
    const seen: boolean[] = [];
    mount((b) => seen.push(b));
    const card = await screen.findByTestId("clarify-card");
    expect(card.textContent).toContain("Qual <b>cliente</b>?");
    expect(card.querySelector("b")).toBeNull();
    expect(card.textContent).toContain("O Bot espera até 2 min pela sua resposta.");
    await waitFor(() => expect(seen).toContain(true));
    const send = screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(w.posts).toHaveLength(0);                                           // nothing is answered by itself
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "  A Acme, até sexta  " } });
    fireEvent.click(send);
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0].url).toMatch(/\/bots\/vendas\/runs\/r1\/clarify$/);
    expect(w.posts[0].body).toEqual({ request_id: "q1", execution_generation: 7, answer: "A Acme, até sexta" });
    expect(w.posts[0].csrf).toBe("csrf-1");
  });

  it("a long question or option with no spaces (an address, a hash, a path) wraps inside the card: red team T2", async () => {
    const long = "https://exemplo.invalid/" + "a1b2c3d4e5".repeat(32);
    world(() => runWith([clarify({ question: long, choices: [long, "Não"] })]));
    mount();
    const card = await screen.findByTestId("clarify-card");
    expect(card.style.overflowWrap).toBe("anywhere");                                              // the card itself (jsdom has no layout: the style is the contract)
    expect(card.style.minWidth).toMatch(/^0(px)?$/);
    const text = within(card).getByText(long, { selector: "p" });
    expect(text.style.overflowWrap).toBe("anywhere");
    expect((within(card).getByRole("radio", { name: long }).parentElement!.querySelector("span") as HTMLElement).style.overflowWrap).toBe("anywhere");
  });

  it("one choice: radios, nothing chosen = cannot send, and the answer is the EXACT label", async () => {
    const w = world(() => runWith([clarify({ question: "Posso apagar?", choices: ["Sim, apague", "Não"] })]));
    mount();
    const send = await screen.findByRole("button", { name: "Responder" }) as HTMLButtonElement;
    expect(screen.getByRole("radiogroup", { name: "Escolha uma opção" })).toBeTruthy();
    expect(screen.queryByLabelText("Sua resposta")).toBeNull();                 // no free text when there are choices
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Não" }));
    fireEvent.click(screen.getByRole("radio", { name: "Sim, apague" }));          // changes its mind: still ONE
    fireEvent.click(send);
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(w.posts[0].body.answer).toBe("Sim, apague");
  });

  it("several choices (multi_select): checkboxes, and the answer is a JSON list of the exact labels in the Bot's order", async () => {
    const w = world(() => runWith([clarify({ question: "Quais arquivos?", choices: ["a.csv", "b.csv", "c.csv"], multi_select: true })]));
    mount();
    await screen.findByRole("group", { name: "Escolha uma ou mais opções" });
    fireEvent.click(screen.getByRole("checkbox", { name: "c.csv" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "a.csv" }));
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(w.posts[0].body.answer).toBe(JSON.stringify(["a.csv", "c.csv"]));
  });

  it("a dashboard without a login says so and cannot send (the server refuses it anyway)", async () => {
    const w = world(() => runWith([clarify()]), { auth: "loopback" });
    mount();
    await screen.findByText(/Sem login, o LuveBot não deixa responder pelo Bot/);
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
    expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled).toBe(true);
    expect(w.posts).toHaveLength(0);
  });

  it("refusals in words, the code only behind 'Detalhe técnico'; the answer stays for another try", async () => {
    for (const [code, said] of [
      ["request_not_pending", "Este pedido não está mais esperando"],
      ["invalid_answer", "A resposta não confere com as opções do Bot."],
      ["hermes_draining", "O Hermes está reiniciando."],
    ] as const) {
      world(() => runWith([clarify()]), { post: refuse(code, code === "hermes_draining" ? 503 : 409) });
      const r = mount();
      fireEvent.change(await screen.findByLabelText("Sua resposta"), { target: { value: "ok" } });
      fireEvent.click(screen.getByRole("button", { name: "Responder" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, code).toContain(said);
      expect(alert.textContent, code).not.toContain(code + " ");
      expect((screen.getByLabelText("Sua resposta") as HTMLTextAreaElement).value).toBe("ok");
      r.unmount();
    }
  });

  it("the skip sentence Hermes appends is not shown (v0.11 §4.1: the run surface does not honour it); a reworded one, or one that appears twice, is shown as it is", async () => {
    const HINT = 'Reply "skip" to skip this question.';
    world(() => runWith([clarify({ question: `Qual cliente?\n\n${HINT}` })]));
    const r = mount();
    const card = await screen.findByTestId("clarify-card");
    expect(card.textContent).toContain("Qual cliente?");
    expect(card.textContent).not.toContain("skip");
    expect(screen.getByRole("button", { name: "Pular esta pergunta" })).toBeTruthy();         // what takes its place is the real Skip button (K-3b), not a sentence
    r.unmount();
    world(() => runWith([clarify({ question: `Qual cliente?\n\nResponda "pular" para pular.`, choices: ["A", "B"] })]));
    const again = mount();
    expect((await screen.findByTestId("clarify-card")).textContent).toContain('Responda "pular" para pular.');
    again.unmount();
    world(() => runWith([clarify({ question: `${HINT}\n\nQual?\n\n${HINT}` })]));
    mount();
    expect((await screen.findByTestId("clarify-card")).textContent).toContain(HINT);
  });

  it("goes away when the run stops asking, and an approval control is not a question (it has its own card)", async () => {
    let controls: any[] = [clarify(), { kind: "approval", request_id: "ap1" }];
    world(() => runWith(controls));
    const seen: boolean[] = [];
    mount((b) => seen.push(b));
    await screen.findByTestId("clarify-card");
    expect(screen.getAllByTestId("clarify-card")).toHaveLength(1);
    controls = [];
    await waitFor(() => expect(screen.queryByTestId("clarify-card")).toBeNull());
    // "needs you" is reported by an effect AFTER the card leaves the screen: wait for it, never read it the instant the card is gone
    await waitFor(() => expect(seen[seen.length - 1]).toBe(false));
  });
});

describe("Pular a pergunta (K-3b, contract v0.11 §4.1)", () => {
  const skipBtn = () => screen.getByRole("button", { name: "Pular esta pergunta" }) as HTMLButtonElement;
  const sendBtn = () => screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement;
  const KINDS: Array<[string, Record<string, unknown>]> = [
    ["free text", clarify()],
    ["one choice", clarify({ choices: ["Acme", "Beta"] })],
    ["several choices", clarify({ choices: ["A", "B", "C"], multi_select: true })],
  ];

  it("every kind of question has it: a real button named 'Pular esta pergunta' with 'Pular' on it, apart from the send button in the DOM, enabled", async () => {
    for (const [kind, control] of KINDS) {
      world(() => runWith([control]));
      const r = mount();
      await screen.findByTestId("clarify-card");
      const b = skipBtn();
      expect(b.tagName, kind).toBe("BUTTON");
      expect(b.type, kind).toBe("button");
      expect(b.textContent, kind).toBe("Pular");
      expect(b.disabled, kind).toBe(false);
      expect(b, kind).not.toBe(sendBtn());
      expect(screen.getAllByRole("button"), kind).toHaveLength(2);
      r.unmount();
    }
  });

  it("the click sends EXACTLY {request_id, execution_generation, skip: true} with the CSRF: no answer, no choices; what was typed or picked stays in the browser", async () => {
    const acts: Array<[string, Record<string, unknown>, () => void, string[]]> = [
      ["free text", clarify(), () => fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "Segredo da Acme" } }), ["Segredo da Acme"]],
      ["one choice", clarify({ choices: ["Acme", "Beta"] }), () => fireEvent.click(screen.getByLabelText("Acme")), ["Acme"]],
      ["several choices", clarify({ choices: ["A", "B", "C"], multi_select: true }), () => { fireEvent.click(screen.getByLabelText("A")); fireEvent.click(screen.getByLabelText("C")); }, ["[\"A\"", "\"C\"]"]],
    ];
    for (const [kind, control, act, mustNotTravel] of acts) {
      const w = world(() => runWith([control]));
      const r = mount();
      await screen.findByTestId("clarify-card");
      act();
      fireEvent.click(skipBtn());
      await waitFor(() => expect(w.posts).toHaveLength(1));
      const { url, body, csrf } = w.posts[0];
      expect(url, kind).toContain("/bots/vendas/runs/r1/clarify");
      expect(Object.keys(body).sort(), kind).toEqual(["execution_generation", "request_id", "skip"]);
      expect(body, kind).toEqual({ request_id: "q1", execution_generation: 7, skip: true });
      expect(body.skip, kind).toBe(true);                                   // the boolean, not "true"
      for (const text of mustNotTravel) expect(JSON.stringify(body), kind).not.toContain(text);
      expect(csrf, kind).toBe("csrf-1");
      r.unmount();
    }
  });

  it("after the skip the card says it was SKIPPED: never 'answered', never the typed text, never the word as if it were the answer; the controls are gone", async () => {
    world(() => runWith([clarify()]));
    mount();
    fireEvent.change(await screen.findByLabelText("Sua resposta"), { target: { value: "minha resposta" } });
    fireEvent.click(skipBtn());
    const said = await screen.findByText("Pulada. O Bot segue daqui.");
    expect(said.getAttribute("role")).toBe("status");
    const card = screen.getByTestId("clarify-card");
    expect(card.textContent).not.toMatch(/enviada|respondid/i);
    expect(card.textContent).not.toContain("minha resposta");
    expect(card.textContent).not.toMatch(/skip/i);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByLabelText("Sua resposta")).toBeNull();
  });

  it("an answer still says 'sent', not 'skipped' (the two states are not mixed up)", async () => {
    world(() => runWith([clarify({ choices: ["Acme", "Beta"] })]));
    mount();
    fireEvent.click(await screen.findByLabelText("Beta"));
    fireEvent.click(sendBtn());
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(screen.getByTestId("clarify-card").textContent).not.toContain("Pulada");
  });

  it("Enter in the text field never skips: plain Enter and Shift+Enter send nothing, and Ctrl+Enter sends the typed ANSWER (a body with `answer` and no `skip`)", async () => {
    const w = world(() => runWith([clarify()]));
    mount();
    const field = await screen.findByLabelText("Sua resposta");
    fireEvent.change(field, { target: { value: "Acme" } });
    fireEvent.keyDown(field, { key: "Enter" });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(w.posts).toHaveLength(0);                                          // the field's default action is not a skip, and not a send either
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0].body).toEqual({ request_id: "q1", execution_generation: 7, answer: "Acme" });
    expect("skip" in w.posts[0].body).toBe(false);
  });

  it("the button is not inside a form (the composer is the only form) and has no confirmation: one click, one request, no dialog", async () => {
    const w = world(() => runWith([clarify()]));
    mount();
    await screen.findByTestId("clarify-card");
    expect(skipBtn().closest("form")).toBeNull();
    fireEvent.click(skipBtn());
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("without a login it is disabled like the answer controls, and nothing is sent", async () => {
    const w = world(() => runWith([clarify()]), { auth: "loopback" });
    mount();
    await screen.findByText(/Sem login, o LuveBot não deixa responder pelo Bot/);
    expect(skipBtn().disabled).toBe(true);
    fireEvent.click(skipBtn());
    await new Promise((r) => setTimeout(r, 60));
    expect(w.posts).toHaveLength(0);
  });

  it("with the deployment token (a machine) or a mode nobody knows it is disabled too: a skip stands for a decision, and a machine decides nothing; nothing is sent", async () => {
    for (const auth of ["deployment", "", "GATED"]) {
      cleanup();
      const w = world(() => runWith([clarify()]), { auth });
      mount();
      await screen.findByText("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
      expect(skipBtn().disabled, JSON.stringify(auth)).toBe(true);
      fireEvent.click(skipBtn());
      await new Promise((r) => setTimeout(r, 40));
      expect(w.posts, JSON.stringify(auth)).toHaveLength(0);
    }
  });

  it("while a request is in flight both buttons are disabled (no second click, no skip over an answer on its way)", async () => {
    let release: () => void = () => {};
    const w = world(() => runWith([clarify()]), { post: () => new Promise((res) => { release = () => res({ clarify: { request_id: "q1", status: "resolved" }, run: { id: "r1", status: "started" } }); }) });
    mount();
    fireEvent.change(await screen.findByLabelText("Sua resposta"), { target: { value: "Acme" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(skipBtn().disabled).toBe(true);
    fireEvent.click(skipBtn());
    expect(w.posts).toHaveLength(1);
    release();
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
  });

  it("a refused skip is said in words, the card stays, the button works again; and a later ANSWER is then 'sent', never 'skipped'", async () => {
    let first = true;
    const w = world(() => runWith([clarify()]), { post: (_url, body) => { if (body.skip && first) { first = false; refuse("request_not_pending")(); } return { clarify: { request_id: "q1", status: "resolved" }, run: { id: "r1", status: "started" } }; } });
    mount();
    await screen.findByTestId("clarify-card");
    fireEvent.click(skipBtn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Este pedido não está mais esperando");
    expect(screen.queryByText(/Pulada/)).toBeNull();
    expect(skipBtn().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
    fireEvent.click(sendBtn());
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(screen.getByTestId("clarify-card").textContent).not.toContain("Pulada");
    expect(w.posts.map((p) => "skip" in p.body)).toEqual([true, false]);
  });

  it("each question is its own: skipping one sends that control's request_id, and the next control is untouched", async () => {
    const w = world(() => runWith([clarify({ request_id: "q1", question: "Primeira?" }), clarify({ request_id: "q2", question: "Segunda?" })]));
    mount();
    await screen.findAllByTestId("clarify-card");
    const cards = screen.getAllByTestId("clarify-card");
    fireEvent.click(within(cards[1]).getByRole("button", { name: "Pular esta pergunta" }));
    await waitFor(() => expect(w.posts).toHaveLength(1));
    expect(w.posts[0].body).toEqual({ request_id: "q2", execution_generation: 7, skip: true });
    expect(within(cards[0]).queryByText(/Pulada/)).toBeNull();
  });

  it("in English: the name, the label and what the card says", async () => {
    setLuveLocale("en");
    world(() => runWith([clarify()]));
    mount();
    await screen.findByTestId("clarify-card");
    const b = screen.getByRole("button", { name: "Skip this question" });
    expect(b.textContent).toBe("Skip");
    fireEvent.click(b);
    await screen.findByText("Skipped. The Bot carries on from here.");
    expect(screen.getByTestId("clarify-card").textContent).not.toMatch(/answer sent/i);
  });
});

describe("with the deployment token (a machine) or a mode nobody knows: not a person (v0.11 5.1)", () => {
  it("the question says it in the credential's words (never the loopback ones), the answer stays off and nothing is sent", async () => {
    const w = world(() => runWith([clarify()]), { auth: "deployment" });
    mount();
    await screen.findByText("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(screen.queryByText(/Sem login, o LuveBot não deixa responder pelo Bot/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
    expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Sua resposta"), { key: "Enter", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(w.posts).toHaveLength(0);
  });

  it("the lost-run card too: the credential's sentence, the button off, nothing sent", async () => {
    const w = world(() => UNKNOWN, { auth: "deployment" });
    mount();
    await screen.findByText("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(screen.queryByText(/Sem login, o LuveBot não deixa liberar a conversa/)).toBeNull();
    expect((screen.getByRole("button", { name: "Confirmar que acabou" }) as HTMLButtonElement).disabled).toBe(true);
    expect(w.posts).toHaveLength(0);
  });

  it("a mode nobody knows, or none ('' or 'GATED' or an unknown name): the same closed card", async () => {
    for (const auth of ["", "service", "GATED"]) {
      cleanup();
      const w = world(() => runWith([clarify()]), { auth });
      mount();
      await screen.findByText("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
      expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled, JSON.stringify(auth)).toBe(true);
      expect(w.posts).toHaveLength(0);
    }
  });
});

describe("o cartão fechado: a confirmação fica e o FOCO tem onde pousar (K-3b, passada de acessibilidade)", () => {
  const skipBtn = () => screen.getByRole("button", { name: "Pular esta pergunta" }) as HTMLButtonElement;
  const sendBtn = () => screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement;
  /** Hermes lists the question until it is resolved, then not any more (what the backend does); the POST resolves it. `held` keeps the POST in flight. */
  function resolving(opts: { first?: any[]; then?: any[]; hold?: boolean; fail?: string } = {}) {
    let open = true; let release: () => void = () => {}; let failNext = opts.fail ?? "";
    const w = world(() => runWith(open ? (opts.first ?? [clarify()]) : (opts.then ?? [])), {
      post: () => new Promise((res, rej) => {
        const go = () => { if (failNext) { const c = failNext; failNext = ""; try { refuse(c)(); } catch (e) { rej(e); } return; } open = false; res({ clarify: { request_id: "q1", status: "resolved" }, run: { id: "r1", status: "started" } }); };
        if (opts.hold) release = go; else go();
      }),
    });
    return { w, release: () => release() };
  }
  /** Chrome drops the focus of a control the moment it turns disabled (the request is on its way) and it falls to the page body; jsdom keeps a disabled button focused, so the test does what the browser does. */
  const asChromeDoes = () => { const t = document.createElement("div"); t.tabIndex = -1; document.body.appendChild(t); t.focus(); t.blur(); t.remove(); };
  const settled = async (w: ReturnType<typeof world>) => { const n = w.gets(); await waitFor(() => expect(w.gets()).toBeGreaterThanOrEqual(n + 2)); };

  it("a skip: Hermes stops listing the question and the card STAYS as its confirmation (it said 'Pulada' for one round trip before), the FOCUS is on that line, and it no longer says the Bot is waiting", async () => {
    const { w } = resolving({ first: [clarify({ timeout_s: 120 })] });
    mount();
    await screen.findByTestId("clarify-card");
    expect(screen.getByTestId("clarify-card").textContent).toContain("O Bot espera até 2 min");   // asking: the deadline is said
    expect(screen.getByTestId("clarify-card").getAttribute("style")).toContain("--color-warning");  // ...and the card has the "it needs you" edge
    skipBtn().focus();
    fireEvent.click(skipBtn());
    asChromeDoes();
    const said = await screen.findByText("Pulada. O Bot segue daqui.");
    await settled(w);                                                                   // the next GET came back WITHOUT the question
    const card = screen.getByTestId("clarify-card");                                    // ...and the card is still there
    expect(card.contains(said)).toBe(true);
    expect(document.activeElement).toBe(said);                                           // the focus did not fall to the page body
    expect(said.getAttribute("role")).toBe("status");
    expect(said.getAttribute("tabindex")).toBe("-1");                                    // reachable for focus(), not a stop in the Tab order
    expect(card.textContent).toContain("Qual <b>cliente</b>?");                          // the question stays: what was closed
    expect(card.textContent).not.toContain("está esperando");                           // not "the Bot is waiting" any more...
    expect(card.textContent).not.toContain("O Bot espera até");                         // ...nor its deadline
    expect(card.getAttribute("aria-label")).toBe("Pergunta do Bot");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    expect(card.getAttribute("style")).not.toContain("--color-warning");                // the "it needs you" edge went calm
    expect(card.getAttribute("style")).toContain("--color-border");
  });

  it("the focus is on the confirmation line in the SAME commit that puts it on screen (a layout effect): the instant 'Pulada.' exists in the DOM it already has the focus", async () => {
    const { w, release } = resolving({ hold: true });
    mount();
    await screen.findByTestId("clarify-card");
    skipBtn().focus();
    fireEvent.click(skipBtn());
    await waitFor(() => expect(w.posts).toHaveLength(1));
    asChromeDoes();
    const out = { seen: false, focus: "" };
    const mo = new MutationObserver(() => {   // runs right after the commit that changed the DOM, before any passive effect or paint
      const line = [...document.querySelectorAll("[role=status]")].find((e) => e.textContent?.includes("Pulada."));
      if (line && !out.seen) { out.seen = true; out.focus = document.activeElement === line ? "the line" : document.activeElement === document.body ? "BODY" : "something else"; }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    release();
    await screen.findByText("Pulada. O Bot segue daqui.");
    mo.disconnect();
    expect(out).toEqual({ seen: true, focus: "the line" });
  });

  it("an answer (free text, one choice, several): the same: 'Resposta enviada' stays and holds the focus", async () => {
    for (const control of [clarify(), clarify({ choices: ["Acme", "Beta"] }), clarify({ choices: ["A", "B"], multi_select: true })]) {
      cleanup();
      const { w } = resolving({ first: [control] });
      mount();
      await screen.findByTestId("clarify-card");
      if (control.choices.length === 0) fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "Acme" } });
      else fireEvent.click(screen.getByLabelText(control.choices[0]));
      sendBtn().focus();
      fireEvent.click(sendBtn());
      asChromeDoes();
      const said = await screen.findByText("Resposta enviada. O Bot segue daqui.");
      await settled(w);
      expect(screen.getByTestId("clarify-card").contains(said)).toBe(true);
      expect(document.activeElement).toBe(said);
    }
  });

  it("it is the SAME card afterwards, in the same place, and the next question comes after it (nothing remounts, the order is the order they were asked)", async () => {
    const { w } = resolving({ first: [clarify({ request_id: "q1", question: "Primeira?" })], then: [clarify({ request_id: "q2", question: "Segunda?" })] });
    mount();
    const first = await screen.findByTestId("clarify-card");
    fireEvent.click(skipBtn());
    await screen.findByText("Pulada. O Bot segue daqui.");
    await waitFor(() => expect(screen.getAllByTestId("clarify-card")).toHaveLength(2));
    await settled(w);
    const cards = screen.getAllByTestId("clarify-card");
    expect(cards[0]).toBe(first);                                                        // the same element: its state and focus survived the list change
    expect(cards[0].textContent).toContain("Primeira?");
    expect(cards[0].textContent).toContain("Pulada");
    expect(cards[1].textContent).toContain("Segunda?");
    expect(within(cards[1]).getByRole("button", { name: "Pular esta pergunta" })).toBeTruthy();   // the new one is live
    expect(within(cards[1]).queryByText(/Pulada/)).toBeNull();
  });

  it("a question that leaves WITHOUT this person's click (answered elsewhere, timed out) is not kept", async () => {
    let listed = true;
    const w = world(() => runWith(listed ? [clarify()] : []));
    mount();
    await screen.findByTestId("clarify-card");
    listed = false;
    await waitFor(() => expect(screen.queryByTestId("clarify-card")).toBeNull());
    expect(w.posts).toHaveLength(0);
  });

  it("a person who has moved on keeps THEIR focus: the confirmation does not take it back", async () => {
    const { w, release } = resolving({ hold: true });
    render(<><input aria-label="fora" /><RunControls bot="vendas" runId="r1" active pollMs={20} /></>);
    await screen.findByTestId("clarify-card");
    skipBtn().focus();
    fireEvent.click(skipBtn());
    await waitFor(() => expect(w.posts).toHaveLength(1));
    asChromeDoes();
    (screen.getByLabelText("fora") as HTMLInputElement).focus();                          // they went to the composer while it was on its way
    release();
    await screen.findByText("Pulada. O Bot segue daqui.");
    await settled(w);
    expect(document.activeElement).toBe(screen.getByLabelText("fora"));
  });

  it("a REFUSED skip puts the focus back on the button that was used (it had dropped to the page body), and the answer's refusal goes back to the field on Ctrl+Enter", async () => {
    const a = resolving({ hold: true, fail: "request_not_pending" });
    mount();
    await screen.findByTestId("clarify-card");
    skipBtn().focus();
    fireEvent.click(skipBtn());
    await waitFor(() => expect(a.w.posts).toHaveLength(1));
    asChromeDoes();
    expect(document.activeElement).toBe(document.body);
    a.release();
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(skipBtn());
    cleanup();
    const b = resolving({ hold: true, fail: "request_not_pending" });
    mount();
    const field = (await screen.findByLabelText("Sua resposta")) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Acme" } });
    field.focus();
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(b.w.posts).toHaveLength(1));
    asChromeDoes();
    b.release();
    await screen.findByRole("alert");
    expect(document.activeElement).toBe(screen.getByLabelText("Sua resposta"));
  });

  it("even when the backend stops sending pending_controls altogether after the answer, the closed card stays (it does not depend on the run's next reading)", async () => {
    let open = true;
    const w = world(() => (open ? runWith([clarify()]) : { id: "r1", status: "started" }), { post: () => { open = false; return { clarify: { request_id: "q1", status: "resolved" }, run: { id: "r1", status: "started" } }; } });
    mount();
    await screen.findByTestId("clarify-card");
    fireEvent.click(skipBtn());
    const said = await screen.findByText("Pulada. O Bot segue daqui.");
    await waitFor(() => expect(w.gets()).toBeGreaterThanOrEqual(2));                     // the reading after the click came back bare (and, being bare, the polling stops)
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.getByTestId("clarify-card").contains(said)).toBe(true);
    expect(document.activeElement).toBe(said);
  });

  it("the Skip button is at least 44 px wide (a short word, 'Skip', was 40 on a phone)", async () => {
    resolving();
    mount();
    await screen.findByTestId("clarify-card");
    expect(skipBtn().style.minWidth).toBe("44px");
  });

  it("in English: the closed card says 'The Bot's question' and 'Skipped.'", async () => {
    setLuveLocale("en");
    const { w } = resolving();
    mount();
    await screen.findByTestId("clarify-card");
    fireEvent.click(screen.getByRole("button", { name: "Skip this question" }));
    const said = await screen.findByText("Skipped. The Bot carries on from here.");
    await settled(w);
    expect(screen.getByTestId("clarify-card").getAttribute("aria-label")).toBe("The Bot's question");
    expect(document.activeElement).toBe(said);
  });

  it("the unknown-run card is the same: it stays as 'Conversa liberada.', holds the focus, and no longer says the conversation is stopped", async () => {
    let lost = true;
    const w = world(() => (lost ? UNKNOWN : { id: "r1", status: "started", execution_generation: 3, pending_controls: [] }), { post: () => { lost = false; return { run: { id: "r1", status: "started" } }; } });
    mount();
    const btn = await screen.findByRole("button", { name: "Confirmar que acabou" });
    btn.focus();
    fireEvent.click(btn);
    asChromeDoes();
    const said = await screen.findByText("Conversa liberada.");
    await settled(w);
    const card = screen.getByTestId("unknown-run-card");
    expect(card.contains(said)).toBe(true);
    expect(document.activeElement).toBe(said);
    expect(card.textContent).not.toContain("A conversa está parada");
    expect(card.getAttribute("style")).not.toContain("--color-warning");
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
  });
});

describe("the card's state belongs to a RUN and a request, not to the request id alone (A-169)", () => {
  // Hermes makes the id per question (random), but that is chance, not Hermes's contract: the mark ("skipped", "sent") never rests on the id alone.
  const twoRuns = (hold?: { r2: Promise<void> }) => {
    const posts: Array<{ url: string; body: any }> = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
      if (method === "GET" && url.endsWith("/bots/vendas/runs/r1")) return { run: { id: "r1", status: "started", execution_generation: 7, pending_controls: [clarify({ request_id: "same-id" })] } };
      if (method === "GET" && url.endsWith("/bots/vendas/runs/r2")) { if (hold) await hold.r2; return { run: { id: "r2", status: "started", execution_generation: 9, pending_controls: [clarify({ request_id: "same-id" })] } }; }
      if (method === "POST") { posts.push({ url, body: JSON.parse(String(init?.body)) }); return { clarify: { request_id: "same-id", status: "resolved" } }; }
      throw new Error("unexpected " + method + " " + url);
    });
    return posts;
  };
  const on = (runId: string) => <RunControls bot="vendas" runId={runId} active pollMs={20} />;

  it("two controls with the SAME request_id in different runs do not inherit each other's mark: after a skip in r1, r2's control is a fresh card with its own controls", async () => {
    twoRuns();
    const r = render(on("r1"));
    fireEvent.click(await screen.findByRole("button", { name: "Pular esta pergunta" }));
    await screen.findByText("Pulada. O Bot segue daqui.");
    r.rerender(on("r2"));
    await waitFor(() => expect(screen.queryByText("Pulada. O Bot segue daqui.")).toBeNull());
    expect(await screen.findByLabelText("Sua resposta")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Pular esta pergunta" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the same for an ANSWER: 'sent' in r1 is not carried into r2's control with the same id", async () => {
    twoRuns();
    const r = render(on("r1"));
    fireEvent.change(await screen.findByLabelText("Sua resposta"), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    r.rerender(on("r2"));
    await waitFor(() => expect(screen.queryByText("Resposta enviada. O Bot segue daqui.")).toBeNull());
    expect((await screen.findByLabelText("Sua resposta") as HTMLTextAreaElement).value).toBe("");           // and what was typed in r1 is not carried over either
  });

  it("while the new run's own read is on the way, the old run's control is NOT shown under it (it could not be answered into r2 with r1's request)", async () => {
    let release: () => void = () => {};
    const posts = twoRuns({ r2: new Promise<void>((res) => { release = res; }) });
    const r = render(on("r1"));
    await screen.findByTestId("clarify-card");
    r.rerender(on("r2"));
    await new Promise((res) => setTimeout(res, 80));
    expect(screen.queryByTestId("clarify-card")).toBeNull();
    release();
    fireEvent.click(await screen.findByRole("button", { name: "Pular esta pergunta" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain("/runs/r2/clarify");
    expect(posts[0].body).toEqual({ request_id: "same-id", execution_generation: 9, skip: true });          // r2's generation, never r1's
  });
  it("the lost-run card: 'Conversa liberada' confirmed in r1 is not shown under r2", async () => {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
      if (method === "GET" && url.endsWith("/bots/vendas/runs/r1")) return { run: UNKNOWN };
      if (method === "GET" && url.endsWith("/bots/vendas/runs/r2")) return { run: { id: "r2", status: "started", execution_generation: 2, pending_controls: [] } };
      if (method === "POST") return { run: { id: "r1", status: "resolved" } };
      throw new Error("unexpected " + method + " " + url);
    });
    const r = render(<RunControls bot="vendas" runId="r1" active pollMs={20} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirmar que acabou" }));
    await screen.findByText("Conversa liberada.");
    r.rerender(<RunControls bot="vendas" runId="r2" active pollMs={20} />);
    await waitFor(() => expect(screen.queryByTestId("unknown-run-card")).toBeNull());
  });
});

describe("execução que o Hermes perdeu (unknown)", () => {
  it("shows only for status unknown with resolution.needed; the click sends the generation the person saw, with the CSRF", async () => {
    const w = world(() => UNKNOWN);
    mount();
    const card = await screen.findByTestId("unknown-run-card");
    expect(card.textContent).toContain("O Hermes perdeu o rastro desta execução");
    await new Promise((r) => setTimeout(r, 60));
    expect(w.posts).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirmar que acabou" }));
    await screen.findByText("Conversa liberada.");
    expect(w.posts[0].url).toMatch(/\/bots\/vendas\/runs\/r1\/resolve-unknown$/);
    expect(w.posts[0].body).toEqual({ execution_generation: 3 });
    expect(w.posts[0].csrf).toBe("csrf-1");
  });

  it("without a login it says so and cannot send; a run no longer lost, and a stale generation, are said in words", async () => {
    const w = world(() => UNKNOWN, { auth: "loopback" });
    const r = mount();
    await screen.findByText(/Sem login, o LuveBot não deixa liberar a conversa/);
    expect((screen.getByRole("button", { name: "Confirmar que acabou" }) as HTMLButtonElement).disabled).toBe(true);
    expect(w.posts).toHaveLength(0);
    r.unmount();
    for (const [code, said] of [["run_not_unknown", "Esta execução já não está perdida."], ["stale", "Algo mudou enquanto você mexia aqui."]] as const) {
      world(() => UNKNOWN, { post: refuse(code) });
      const x = mount();
      fireEvent.click(await screen.findByRole("button", { name: "Confirmar que acabou" }));
      expect((await screen.findByRole("alert")).textContent, code).toContain(said);
      x.unmount();
    }
  });

  it("an unknown run without resolution.needed shows nothing (never a button that cannot be honest)", async () => {
    const w = world(() => ({ id: "r1", status: "unknown", pending_controls: [], resolution: { needed: false, execution_generation: 3 } }));
    mount();
    await waitFor(() => expect(w.gets()).toBeGreaterThan(1));
    expect(screen.queryByTestId("unknown-run-card")).toBeNull();
  });
});

describe("a backend that does not say", () => {
  it("without pending_controls (older backend, or a Hermes without session authority): ONE read, then it leaves the run alone", async () => {
    const w = world(() => ({ id: "r1", status: "started" }));
    mount();
    await waitFor(() => expect(w.gets()).toBe(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(w.gets()).toBe(1);
    expect(screen.queryByTestId("clarify-card")).toBeNull();
  });

  it("a finished turn (active=false) is not read at all; in English", async () => {
    const w = world(() => runWith([clarify()]));
    const r = render(<RunControls bot="vendas" runId="r1" active={false} pollMs={20} />);
    await new Promise((res) => setTimeout(res, 80));
    expect(w.gets()).toBe(0);
    r.unmount();
    setLuveLocale("en");
    world(() => runWith([clarify({ choices: ["Yes", "No"] })]));
    mount();
    expect((await screen.findByTestId("clarify-card")).textContent).toContain("The Bot is waiting for your answer");
    expect(screen.getByRole("radiogroup", { name: "Pick one option" })).toBeTruthy();
  });
});

describe("the '(Recommended)' Hermes puts on the first choice (tools/clarify_tool.py mark_recommended)", () => {
  const labels = (card: HTMLElement) => [...card.querySelectorAll("label")].map((l) => l.textContent?.trim());

  it("a Portuguese screen says it in Portuguese, and the ANSWER is the original label (the card never sends its own wording)", async () => {
    const w = world(() => runWith([clarify({ question: "Posso apagar?", choices: ["Sim (Recommended)", "Não"] })]));
    mount();
    const card = await screen.findByTestId("clarify-card");
    expect(labels(card)).toEqual(["Sim (Recomendada)", "Não"]);
    expect(card.textContent).not.toContain("Recommended");
    fireEvent.click(within(card).getByRole("radio", { name: "Sim (Recomendada)" }));
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(w.posts[0].body).toEqual({ request_id: "q1", execution_generation: 7, answer: "Sim (Recommended)" });
  });

  it("several may be chosen: the list sent holds the original labels in the Bot's order", async () => {
    const w = world(() => runWith([clarify({ choices: ["PDF (Recommended)", "Markdown", "HTML"], multi_select: true })]));
    mount();
    const card = await screen.findByTestId("clarify-card");
    expect(labels(card)).toEqual(["PDF (Recomendada)", "Markdown", "HTML"]);
    fireEvent.click(within(card).getByRole("checkbox", { name: "Markdown" }));
    fireEvent.click(within(card).getByRole("checkbox", { name: "PDF (Recomendada)" }));
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(w.posts[0].body.answer).toBe(JSON.stringify(["PDF (Recommended)", "Markdown"]));
  });

  it("in English it reads as Hermes wrote it", async () => {
    setLuveLocale("en");
    world(() => runWith([clarify({ choices: ["Yes (Recommended)", "No"] })]));
    mount();
    expect(labels(await screen.findByTestId("clarify-card"))).toEqual(["Yes (Recommended)", "No"]);
  });

  it("only that exact decoration on the FIRST of two or more choices: anything else is the Bot's own text and stays", async () => {
    for (const choices of [["Sim", "Não (Recommended)"], ["Sim (recommended)", "Não"], ["Sim(Recommended)", "Não"], ["Sim (Recommended)"], [" (Recommended)", "Não"], ["Sim (Recommended) agora", "Não"]]) {
      cleanup();
      world(() => runWith([clarify({ choices })]));
      mount();
      expect(labels(await screen.findByTestId("clarify-card")), JSON.stringify(choices)).toEqual(choices.map((c) => c.trim()));   // a label ends in a blank of its own markup
    }
  });

  it("the pure rule", () => {
    expect(displayChoice("Sim (Recommended)", true, 2)).toEqual({ text: "Sim", recommended: true });
    expect(displayChoice("Sim (Recommended)", false, 2)).toEqual({ text: "Sim (Recommended)", recommended: false });
    expect(displayChoice("Sim (Recommended)", true, 1)).toEqual({ text: "Sim (Recommended)", recommended: false });
    expect(displayChoice(" (Recommended)", true, 2).recommended).toBe(false);
    expect(displayChoice("Sim (Recommended) (Recommended)", true, 2)).toEqual({ text: "Sim (Recommended)", recommended: true });   // one suffix is taken, the Bot's own text stays
  });
});
