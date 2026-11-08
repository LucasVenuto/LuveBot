// tests/unit/rules/always-allow-review.test.tsx
// AA-2 (plugin-api v0.11 section 11), the SECOND act on the Rules screen: "Revisar e ativar" brings the person to the draft of their "Sempre permitir" on the Rules screen of that Bot. On arrival a banner stands above the card and the
// focus goes to the card's HEADING, never to "Ativar" (so Enter cannot turn it on); the card says what the draft covers (one sentence from the engine's `exact`, never a guess of the screen), what turning on does, and after
// "Ativar" that the rule counts for that Bot. The activation sends the version the person SAW; a draft that changed, a Bot without the rules installed and a dashboard without a login each say it in words.
// (3) arrival, banner, focus; (4) the card: strict pattern, seal, coverage exact and wider; (5) the activation: the version, 409 stale, not_applied, loopback; (6) NOTHING turns on by arriving, by a key or by a combined control; (8) PT and EN.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RulesView } from "@/components/rules";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Rule, RuleWithSeal } from "@/api/types";

const BANNER_PT = "Esta regra nasceu de um 'Sempre permitir' que você deu. Ela só vale depois que você ativar.";
const BANNER_EN = "This rule came from an 'Always allow' you gave. It counts only after you turn it on.";
const EXACT_PT = "Cobre só este comando exato (e este arquivo, se houver), no Bot Vendas, toda vez que for pedido. Não cobre variações.";
const EXACT_EN = "Covers only this exact command (and this file, if any), for the Bot Vendas, every time it is asked. It does not cover variations.";
const MORE_PT = "Cobre MAIS do que você aprovou: qualquer comando que combine com o padrão abaixo.";
const MORE_EN = "Covers MORE than you approved: any command that matches the pattern below.";
const FACTS_PT = "Cobre só chamadas de write_file que combinem exatamente com as condições abaixo (arquivo ou destinatário), no Bot Vendas, toda vez que for pedido. Não cobre variações.";
const FACTS_EN = "Covers only calls of write_file that match the conditions below exactly (file or recipient), for the Bot Vendas, every time it is asked. It does not cover variations.";
const TOOL_PT = "Cobre toda chamada de web_search, com qualquer argumento, no Bot Vendas, toda vez que for pedido. Não cobre outras ferramentas.";
const TOOL_EN = "Covers every call of web_search, with any arguments, for the Bot Vendas, every time it is asked. It does not cover other tools.";
const NEUTRAL_PT = "Vale exatamente o padrão abaixo, no Bot Vendas, toda vez que for pedido.";
const NEUTRAL_EN = "It counts exactly as the pattern below, for the Bot Vendas, every time it is asked.";
const DOES_PT = "Ao ativar, o LuveBot deixa de pedir aprovação para isto. As regras de Bloquear e de Perguntar continuam valendo mais, e os avisos do próprio Hermes continuam.";
const DOES_EN = "Turning it on, LuveBot stops asking for approval for this. Block and Ask rules still win, and Hermes's own prompts still apply.";
const ACTIVE_PT = "Regra ativa: vale sempre para Vendas";
const RLO = String.fromCodePoint(0x202e);

const BOTS = [{ name: "vendas", is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle", display: { label: "Vendas", role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } } } as Bot];
const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id, label: `Regra ${id}`, level: "allow", scope: { kind: "bot", ref: "vendas" }, match: { tools: ["terminal"], commands: ["curl -X POST https://api.example.com/sync"] }, state: "draft", origin: "always_allow", builtin: false, version: 3, exact: true, covers: "command", ...over,
} as Rule);
const withSeal = (r: Rule, seal: Partial<RuleWithSeal["seal_result"]> = {}): RuleWithSeal => ({ rule: r, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [], ...seal } });

type Call = { method: string; url: string; body?: any };
let calls: Call[];
let patch: (body: any) => unknown;
let listed: RuleWithSeal[];
beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-c"); calls = []; listed = [withSeal(rule("aa-1"))];
  patch = (body) => ({ rule: { ...rule("aa-1"), version: body.version + 1, state: "active" }, seal_result: { seal: "hand", mechanisms: [], problems: [], qualifiers: [] } });
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/suggestions")) return { suggestions: [] };
    if (method === "PATCH") { const r = patch(JSON.parse(String(init!.body))); if (r instanceof Error) throw r; return r; }
    return { rules: listed };
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); setLuveLocale("pt"); });

const patches = () => calls.filter((c) => c.method === "PATCH");
const arrive = (opts: { open?: string | null; auth?: string; rules?: RuleWithSeal[] } = {}) =>
  render(<RulesView botName="vendas" bots={BOTS} authMode={opts.auth ?? "gated"} initialRules={opts.rules ?? listed} openDraft={opts.open === undefined ? "aa-1" : opts.open} />);
const card = (id = "aa-1") => screen.getByTestId(`rule-card-${id}`);
const heading = (id = "aa-1") => within(card(id)).getByRole("heading", { level: 3 });
const activate = () => screen.getByRole("button", { name: /^(Ativar regra|Activate rule)$/ });

describe("(3) the arrival: a banner above the card, the focus on its heading", () => {
  it("the banner stands ABOVE the card, the heading takes the focus and is described by the banner", async () => {
    arrive();
    const banner = screen.getByRole("note");
    expect(banner.textContent).toBe(BANNER_PT);
    expect(banner.compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();   // above the card, not inside a second sheet
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(heading().getAttribute("tabindex")).toBe("-1");                                              // a place for focus(), not a stop in the Tab order
    expect(heading().getAttribute("aria-describedby")).toBe(banner.id);
    expect(document.activeElement).not.toBe(activate());
  });
  it("in English", () => {
    setLuveLocale("en");
    arrive();
    expect(screen.getByRole("note").textContent).toBe(BANNER_EN);
  });
  it("only the draft the person came for is marked: another draft has no banner and no focus", async () => {
    listed = [withSeal(rule("other", { origin: "human" })), withSeal(rule("aa-1"))];
    arrive({ rules: listed });
    expect(screen.getAllByRole("note")).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(heading("aa-1")));
    expect(heading("other").getAttribute("tabindex")).toBeNull();
  });
  it("a normal visit to the Rules screen has no banner and the focus is nowhere in particular", () => {
    arrive({ open: null });
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
  it("a draft that is no longer waiting (turned on elsewhere, archived, gone) is said in a line, with no banner and no focus moved", async () => {
    for (const rules of [[withSeal(rule("aa-1", { state: "active" }))], [withSeal(rule("aa-1", { state: "archived" }))], [withSeal(rule("zzz"))]]) {
      cleanup();
      arrive({ rules });
      expect((await screen.findByText(/já não está esperando por você/)).getAttribute("role")).toBe("status");
      expect(screen.queryByRole("note")).toBeNull();
      expect(document.activeElement).toBe(document.body);
    }
  });
  it("waits for the list: the focus moves when the card exists, not before", async () => {
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => { release = r; });
    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/suggestions")) return { suggestions: [] };
      calls.push({ method: init?.method ?? "GET", url });
      await slow; return { rules: listed };
    });
    render(<RulesView botName="vendas" bots={BOTS} authMode="gated" openDraft="aa-1" />);
    expect(screen.queryByText(/já não está esperando por você/)).toBeNull();                              // not "gone" while the list is on its way
    release(null);
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });
});

describe("(6) nothing turns on without the second act", () => {
  it("arriving sends no PATCH at all, and neither does a key on the heading, on the card or on the page", async () => {
    arrive();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    for (const key of ["Enter", " ", "Spacebar"]) {
      fireEvent.keyDown(heading(), { key }); fireEvent.keyUp(heading(), { key }); fireEvent.keyPress(heading(), { key, charCode: 13 });
      fireEvent.keyDown(card(), { key }); fireEvent.keyDown(document.body, { key });
    }
    fireEvent.click(heading());
    await new Promise((r) => setTimeout(r, 30));
    expect(patches()).toHaveLength(0);
    expect(within(card()).getByTestId("badge-draft")).toBeTruthy();                                    // still a draft
    expect(activate().hasAttribute("disabled")).toBe(false);                                           // offered, not pressed
  });
  it("there is no control that approves and turns on at once on the Rules screen: the only way is the card's own \"Ativar\"", () => {
    arrive();
    const names = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(names.filter((n) => /ativar/i.test(n))).toEqual(["Ativar regra"]);
    expect(names.some((n) => /permitir e ativar|aprovar e ativar|ativar todas|activate all/i.test(n))).toBe(false);
  });
  it("the draft stays a draft until the click, and one click sends exactly one PATCH", async () => {
    arrive();
    fireEvent.click(activate());
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ id: "aa-1", version: 3, state: "active" });
  });
});

describe("(4) the card of such a draft, before \"Ativar\" can be pressed", () => {
  it("the pattern (tool, command) through the strict helper: a hidden character is drawn as its code, never as the character", () => {
    listed = [withSeal(rule("aa-1", { match: { tools: ["term" + RLO + "inal"], commands: ["curl" + RLO + " x"] } }))];
    arrive({ rules: listed });
    const text = card().textContent ?? "";
    expect(text).not.toContain(RLO);
    expect(text).toContain("term[U+202E]inal");
    expect(text).toContain("curl[U+202E] x");
  });
  it("the seal, in words, as the screen already draws it", () => {
    arrive();
    expect(within(card()).getByTestId("seal-hand")).toBeTruthy();
    cleanup(); listed = [withSeal(rule("aa-1"), { seal: "broken", problems: [{ code: "hook_missing", detail: "x" } as never] })];
    arrive({ rules: listed });
    expect(within(card()).getByTestId("rule-problems-aa-1")).toBeTruthy();
  });
  it("command: ONE sentence, naming the Bot, saying it covers only this command and no variation; wider: it says it covers MORE; in both languages", () => {
    arrive();
    expect(within(card()).getByText(EXACT_PT)).toBeTruthy();
    expect(within(card()).queryByText(MORE_PT)).toBeNull();
    cleanup(); listed = [withSeal(rule("aa-1", { exact: false, covers: "wider", match: { tools: ["terminal"], commands: ["curl *"] } }))];
    arrive({ rules: listed });
    expect(within(card()).getByText(MORE_PT)).toBeTruthy();
    expect(within(card()).queryByText(EXACT_PT)).toBeNull();
    cleanup(); setLuveLocale("en"); listed = [withSeal(rule("aa-1"))];
    arrive({ rules: listed });
    expect(within(card()).getByText(EXACT_EN)).toBeTruthy();
    cleanup(); listed = [withSeal(rule("aa-1", { exact: false, covers: "wider" }))];
    arrive({ rules: listed });
    expect(within(card()).getByText(MORE_EN)).toBeTruthy();
  });
  it("facts (no command, narrowed by a file or a recipient) and tool (no command, no condition: every call of it): each has its own sentence, naming the tool, in both languages", () => {
    const facts = rule("aa-1", { covers: "facts", match: { tools: ["write_file"], commands: [], conditions: [{ fact: "path", op: "eq", value: "/srv/app/a.txt" }] } });
    const tool = rule("aa-1", { covers: "tool", match: { tools: ["web_search"], commands: [], conditions: [] } });
    for (const [r, pt, en, others] of [[facts, FACTS_PT, FACTS_EN, [EXACT_PT, MORE_PT, TOOL_PT, NEUTRAL_PT]], [tool, TOOL_PT, TOOL_EN, [EXACT_PT, MORE_PT, FACTS_PT, NEUTRAL_PT]]] as const) {
      cleanup(); setLuveLocale("pt"); arrive({ rules: [withSeal(r)] });
      expect(within(card()).getByText(pt)).toBeTruthy();
      for (const other of others) expect(within(card()).queryByText(other)).toBeNull();
      cleanup(); setLuveLocale("en"); arrive({ rules: [withSeal(r)] });
      expect(within(card()).getByText(en)).toBeTruthy();
    }
  });
  it("the sentence is chosen by `covers` and by nothing else: a rule that says \"tool\" has the tool sentence whatever its pattern looks like, and `exact` does not pick one", () => {
    listed = [withSeal(rule("aa-1", { covers: "tool", exact: false, match: { tools: ["terminal"], commands: ["curl -X POST https://x.test"] } }))];
    arrive({ rules: listed });
    expect(within(card()).getByText("Cobre toda chamada de terminal, com qualquer argumento, no Bot Vendas, toda vez que for pedido. Não cobre outras ferramentas.")).toBeTruthy();
    cleanup(); listed = [withSeal(rule("aa-1", { covers: "wider", exact: true }))];
    arrive({ rules: listed });
    expect(within(card()).getByText(MORE_PT)).toBeTruthy();
    cleanup(); listed = [withSeal(rule("aa-1", { covers: "command", exact: false }))];
    arrive({ rules: listed });
    expect(within(card()).getByText(EXACT_PT)).toBeTruthy();
  });
  it("without `covers` (an older server), with a value this screen does not know (a newer one) or with a value that is not text: the NEUTRAL sentence, which is true of every rule and promises no more; the `exact` of an older server picks nothing", () => {
    for (const covers of [undefined, "everything", "", "WIDER", 7 as never, null as never, { x: 1 } as never]) for (const exact of [true, false, undefined]) {
      cleanup(); listed = [withSeal(rule("aa-1", { covers, exact }))];
      arrive({ rules: listed });
      expect(within(card()).getByText(NEUTRAL_PT), `${String(covers)} / ${String(exact)}`).toBeTruthy();
      for (const other of [EXACT_PT, MORE_PT, FACTS_PT, TOOL_PT]) expect(within(card()).queryByText(other)).toBeNull();
    }
    cleanup(); setLuveLocale("en"); arrive({ rules: [withSeal(rule("aa-1", { covers: undefined }))] });
    expect(within(card()).getByText(NEUTRAL_EN)).toBeTruthy();
  });
  it("the tool's name in the sentence goes through the strict helper too: a hidden character is its code, never the character", () => {
    arrive({ rules: [withSeal(rule("aa-1", { covers: "tool", match: { tools: ["web" + RLO + "_search"], commands: [], conditions: [] } }))] });
    const said = within(card()).getByText(/^Cobre toda chamada de /).textContent ?? "";
    expect(said).toContain("web[U+202E]_search");
    expect(said).not.toContain(RLO);
  });
  it("a sentence that needs the tool's name and has none (a rule without tools) falls back to the neutral one, never to a blank", () => {
    for (const covers of ["facts", "tool"]) {
      cleanup(); arrive({ rules: [withSeal(rule("aa-1", { covers, match: { commands: [], conditions: [] } }))] });
      expect(within(card()).getByText(NEUTRAL_PT)).toBeTruthy();
    }
  });
  it("the sentence belongs to a draft that CAME from an Always allow, and only while it is a draft", () => {
    listed = [withSeal(rule("human", { origin: "human" })), withSeal(rule("act", { state: "active" })), withSeal(rule("aa-1"))];
    arrive({ rules: listed });
    expect(screen.getAllByText(EXACT_PT)).toHaveLength(1);
    expect(within(card("human")).queryByText(EXACT_PT)).toBeNull();
    expect(within(card("act")).queryByText(EXACT_PT)).toBeNull();
    expect(within(card("act")).queryByText(ACTIVE_PT)).toBeNull();                                  // an active rule seen on a normal visit does not claim the person turned it on just now
    expect(screen.getAllByText(DOES_PT)).toHaveLength(1);
  });
  it("the wider sentence says \"below\" and it IS above the pattern; the exact one stands above it too", () => {
    listed = [withSeal(rule("aa-1", { exact: false, covers: "wider" }))];
    arrive({ rules: listed });
    const more = within(card()).getByText(MORE_PT), chip = within(card()).getByText("curl -X POST https://api.example.com/sync");
    expect(more.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("what turning it on does, in the words of Free mode: LuveBot stops asking, Block and Ask still win, Hermes's own prompts still apply", () => {
    arrive();
    const does = within(card()).getByText(DOES_PT);
    expect(does.textContent).toMatch(/deixa de pedir aprovação/);
    expect(does.textContent).toMatch(/Bloquear e de Perguntar continuam valendo mais/);
    expect(does.textContent).toMatch(/Hermes/);
    cleanup(); setLuveLocale("en"); arrive();
    expect(within(card()).getByText(DOES_EN)).toBeTruthy();
  });
});

describe("(5) the activation", () => {
  it("sends the version of the card that was read, and then says the rule counts for that Bot (and the banner no longer says it only counts later)", async () => {
    listed = [withSeal(rule("aa-1", { version: 7 }))];
    arrive({ rules: listed });
    fireEvent.click(activate());
    expect(await within(card()).findByText(ACTIVE_PT)).toBeTruthy();
    expect(patches()[0].body).toEqual({ id: "aa-1", version: 7, state: "active" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(within(card()).queryByText(DOES_PT)).toBeNull();
    cleanup(); setLuveLocale("en"); listed = [withSeal(rule("aa-1"))]; arrive({ rules: listed });
    fireEvent.click(activate());
    expect(await within(card()).findByText("Rule on: it counts every time for Vendas")).toBeTruthy();
  });
  it("a draft that changed since it was read (409 stale_version) is NOT turned on: it says so, reads the card again, and a second click sends the NEW version", async () => {
    patch = (body) => (body.version === 3 ? new ApiError({ code: "stale_version", message: "This rule changed since you loaded it.", status: 409 } as never)
      : { rule: { ...rule("aa-1"), version: 5, state: "active" }, seal_result: { seal: "hand" } });
    arrive();
    listed = [withSeal(rule("aa-1", { version: 4, match: { tools: ["terminal"], commands: ["curl *"] }, exact: false, covers: "wider" }))];   // what the server holds now: someone edited the draft with a wildcard
    fireEvent.click(activate());
    expect(await screen.findByText("A regra mudou desde que você a leu. Leia de novo antes de ativar.")).toBeTruthy();
    expect(patches()).toHaveLength(1);
    await within(card()).findByText(MORE_PT);                                                            // read again BY THE SCREEN: the card now says what the draft covers today
    expect(within(card()).getByTestId("badge-draft")).toBeTruthy();                                      // and it is still a draft
    fireEvent.click(activate());
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1].body.version).toBe(4);                                                           // the version that was read the second time, never the stale 3
    cleanup(); setLuveLocale("en"); calls = []; listed = [withSeal(rule("aa-1"))];
    patch = () => new ApiError({ code: "stale_version", message: "x", status: 409 } as never);
    arrive();
    fireEvent.click(activate());
    expect(await screen.findByText("The rule changed since you read it. Read it again before turning it on.")).toBeTruthy();
  });
  it("409 not_applied keeps the confirmation: the Bots are named, nothing was turned on, \"Cancelar\" sends nothing and the confirmation sends accept_unapplied with the SAME version", async () => {
    patch = (body) => (body.accept_unapplied ? { rule: { ...rule("aa-1"), state: "active" }, seal_result: { seal: "broken" } }
      : new ApiError({ code: "not_applied", message: "The LuveBot rules are not installed in: vendas.", status: 409, details: { bots: ["vendas"] } } as never));
    arrive();
    fireEvent.click(activate());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("As regras do LuveBot não estão instaladas em Vendas. Instale-as ou confirme ativar sem aplicar.");
    expect(within(card()).getByTestId("badge-draft")).toBeTruthy();                                       // still a draft
    expect(patches()).toHaveLength(1);
    fireEvent.click(within(alert).getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(patches()).toHaveLength(1);                                                                    // cancelling asks nothing
    fireEvent.click(activate());
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Ativar sem aplicar" }));
    await waitFor(() => expect(patches()).toHaveLength(3));
    expect(patches()[2].body).toEqual({ id: "aa-1", version: 3, state: "active", accept_unapplied: true });
    expect(patches()[0].body.accept_unapplied).toBeUndefined();                                           // the first ask never carried the confirmation
    expect(await within(card()).findByText(ACTIVE_PT)).toBeTruthy();
    cleanup(); setLuveLocale("en");
    arrive(); fireEvent.click(activate());
    expect((await screen.findByRole("alert")).textContent).toContain("LuveBot's rules are not installed in Vendas. Install them or confirm turning it on without applying.");
  });
  it("a dashboard without a login (loopback) cannot turn it on: the button is off, says why, and no PATCH leaves", async () => {
    arrive({ auth: "loopback" });
    expect(activate().hasAttribute("disabled")).toBe(true);
    expect(activate().getAttribute("title")).toContain("precisa de uma pessoa com login");
    fireEvent.click(activate());
    await new Promise((r) => setTimeout(r, 20));
    expect(patches()).toHaveLength(0);
  });
  it("a refusal 403 loopback_not_human from the server is said in words", async () => {
    patch = () => new ApiError({ code: "loopback_not_human", message: "x", status: 403 } as never);
    arrive();
    fireEvent.click(activate());
    expect((await screen.findByRole("alert")).textContent).toContain("Ativar uma regra precisa de uma pessoa com login no dashboard.");
    expect(within(card()).getByTestId("badge-draft")).toBeTruthy();
  });
});
