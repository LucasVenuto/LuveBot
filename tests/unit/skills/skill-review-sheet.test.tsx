// tests/unit/skills/skill-review-sheet.test.tsx
// The review sheet and the creation (contract v0.11 3.2 steps 3 to 5, 3.4): ALL of the text in an editable plain-text area, how long it is and where it ends, no Create before the last line was reached, warnings for
// padding, every invisible character named and removed only on a tap, the server's dry run before Create, the skill born OFF and turned on as a second decision with Hermes's scan on screen.
// Invisible characters are built from code points, never typed raw.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, configure, within } from "@testing-library/react";
import { SkillReviewSheet } from "@/components/skills/SkillReviewSheet";
import { extractSkillDraft } from "@/lib/skillDraft";
import { ApiError, resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const cp = (...c: number[]) => String.fromCodePoint(...c);
const ZWNJ = cp(0x200c), LRM = cp(0x200e), TAG = cp(0xe0041);
const BODY = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the report.\n2. Send it to the team.";
const draftOf = (content: string) => { const r = extractSkillDraft("```luve-skill\n" + content + "\n```"); if (!r.ok) throw new Error("not a draft: " + r.why); return r.draft; };

type Call = { method: string; url: string; body: any; csrf: string | null };
type Opts = { auth?: string; dry?: (body: any) => unknown; create?: (body: any) => unknown; toggle?: (body: any) => unknown };
function world(opts: Opts = {}) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: opts.auth ?? "gated" };
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") };
    calls.push(call);
    if (call.method === "PUT") return (opts.toggle ?? (() => ({ skill: { name: "send-report" }, notice: "on_applies_to_new_conversations", still_off_on: [] })))(call.body);
    if (call.body?.dry_run === true) return (opts.dry ?? ((b: any) => ({ name: b.name, category: b.category ?? null, description: "Use when a report must go out.", bytes: new TextEncoder().encode(b.content).length, warnings: [] })))(call.body);
    return (opts.create ?? ((b: any) => ({ skill: { name: b.name }, enabled: false, scan: { verdict: "safe", policy: "allow", findings: 0, categories: [] } })))(call.body);
  });
  return { calls, dry: () => calls.filter((c) => c.method === "POST" && c.body?.dry_run === true), real: () => calls.filter((c) => c.method === "POST" && c.body?.dry_run === false), puts: () => calls.filter((c) => c.method === "PUT") };
}
const mount = (content = BODY, over: Partial<React.ComponentProps<typeof SkillReviewSheet>> = {}) =>
  render(<SkillReviewSheet open bot="vendas" draft={draftOf(content)} onClose={vi.fn()} {...over} />);
const area = () => screen.getByLabelText("Texto da skill (SKILL.md)") as HTMLTextAreaElement;
const create = () => screen.getByRole("button", { name: "Criar skill (nasce desligada)" }) as HTMLButtonElement;
const checked = () => screen.findByText(/^Conferido: \d+ bytes\.$/);

// jsdom has no layout: the textarea's scroll metrics come from here, set BEFORE the sheet mounts (0/0/0 is "everything fits")
const metrics = { scrollHeight: 0, clientHeight: 0 };
const tops = new WeakMap<object, number>();
const protos = ["scrollHeight", "clientHeight", "scrollTop"] as const;
const saved = Object.fromEntries(protos.map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k) ?? Object.getOwnPropertyDescriptor(Element.prototype, k)]));
function installScroll() {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(HTMLTextAreaElement.prototype, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollTop", { configurable: true, get() { return tops.get(this) ?? 0; }, set(v: number) { tops.set(this, v); } });
}
function uninstallScroll() { for (const k of protos) delete (HTMLTextAreaElement.prototype as any)[k]; metrics.scrollHeight = 0; metrics.clientHeight = 0; void saved; }
const scrollTo = (el: HTMLElement, top: number) => { tops.set(el, top); fireEvent.scroll(el); };

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); uninstallScroll(); });

describe("ALL of the text, as text, and where it ends", () => {
  it("the area holds exactly what the Bot wrote; the sheet warns it becomes permanent instructions, and says how long it is and where it ends", async () => {
    world();
    mount();
    expect(area().value).toBe(BODY);
    expect(screen.getByRole("dialog").textContent).toContain("Isto vira instruções permanentes do seu Bot. Leia tudo.");
    expect(screen.getByText("6 linhas. Termina na linha 6.")).toBeTruthy();
    expect(area().getAttribute("spellcheck")).toBe("false");
    await checked();
  });

  it("markup in the draft stays characters (nothing is rendered, nothing is executed)", async () => {
    world();
    const body = BODY + "\n3. <script>window.hacked = 1</script> and <b>bold</b> and [link](javascript:alert(1))";
    mount(body);
    expect(area().value).toContain("<script>window.hacked = 1</script>");
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect((window as any).hacked).toBeUndefined();
    await checked();
  });

  it("the name and the description come from the header and the server's preview, and only for the text that was checked", async () => {
    const w = world();
    mount();
    expect(screen.getByText("send-report")).toBeTruthy();
    await checked();
    expect(screen.getByText("Use when a report must go out.")).toBeTruthy();
    fireEvent.change(area(), { target: { value: BODY + "\n3. One more step." } });
    expect(screen.queryByText("Use when a report must go out.")).toBeNull();                    // a new text has not been checked yet
    await waitFor(() => expect(w.dry()).toHaveLength(2));
    await screen.findByText("Use when a report must go out.");
  });
});

describe("the server's dry run (writes nothing)", () => {
  it("asks once the text stops changing, with exactly the name from the header, the text and dry_run true; a category typed goes along", async () => {
    const w = world();
    mount();
    await checked();
    expect(w.dry()).toHaveLength(1);
    expect(w.dry()[0].body).toEqual({ name: "send-report", content: BODY, dry_run: true });
    expect(w.dry()[0].csrf).toBe("csrf-1");
    fireEvent.change(screen.getByLabelText("Categoria (opcional)"), { target: { value: " ops " } });
    await waitFor(() => expect(w.dry()).toHaveLength(2));
    expect(w.dry()[1].body).toEqual({ name: "send-report", category: "ops", content: BODY, dry_run: true });
    expect(w.real()).toHaveLength(0);
  });

  it("a burst of typing is ONE request, and an answer that arrives after a newer text is ignored", async () => {
    const release: { fn: (() => void) | null } = { fn: null };
    const w = world({ dry: (b) => (b.content.endsWith("slow") ? new Promise((res) => { release.fn = () => res({ name: "send-report", category: null, description: "OLD answer.", bytes: 1, warnings: [] }); }) : { name: "send-report", category: null, description: "NEW answer.", bytes: 2, warnings: [] }) });
    mount();
    await screen.findByText("NEW answer.");
    for (const tail of ["\n3. a", "\n3. ab", "\n3. abc slow"]) fireEvent.change(area(), { target: { value: BODY + tail } });
    await waitFor(() => expect(w.dry()).toHaveLength(2));                                       // the first check, then ONE for the burst (the slow one)
    fireEvent.change(area(), { target: { value: BODY + "\n3. fast" } });
    await waitFor(() => expect(w.dry()).toHaveLength(3));
    await screen.findByText("NEW answer.");
    release.fn?.();
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.queryByText("OLD answer.")).toBeNull();                                      // the slow one answered last and is not the current text
  });

  it("no name in the header: the sheet says so and asks the server nothing; with a refused character it says which kind, where, and asks nothing", async () => {
    const w = world();
    mount("---\ndescription: Use when something happens.\n---\nsteps");
    expect(screen.getByRole("alert").textContent).toBe(translations.pt.skillWhyNoName);
    await new Promise((r) => setTimeout(r, 700));
    expect(w.dry()).toHaveLength(0);
    expect(create().disabled).toBe(true);
    cleanup();
    mount();
    await checked();
    fireEvent.change(area(), { target: { value: BODY + "\n3. hidden" + TAG + "text" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("um caractere de etiqueta Unicode");
    expect(alert.textContent).toContain("linha 7, coluna 10");
    expect(alert.textContent).not.toContain(TAG);
    const before = w.dry().length;
    await new Promise((r) => setTimeout(r, 700));
    expect(w.dry()).toHaveLength(before);
    expect(create().disabled).toBe(true);
  });

  it("more than 50 invisible characters: refused on the screen with the count, nothing asked", async () => {
    const w = world();
    mount();
    await checked();
    const before = w.dry().length;
    fireEvent.change(area(), { target: { value: BODY + "\n3. " + ZWNJ.repeat(51) } });
    expect((await screen.findByRole("alert")).textContent).toBe("Este texto tem 51 caracteres invisíveis; o limite é 50.");
    await new Promise((r) => setTimeout(r, 700));
    expect(w.dry()).toHaveLength(before);
  });
});

describe("what the server refuses, in words (never its English)", () => {
  const refuse = (error: Record<string, unknown>, status = 422) => () => { throw new ApiError({ code: String(error.code), message: "English for developers", status, why: error.why as string | undefined, details: error.details as Record<string, any> | undefined }); };
  it.each([
    [{ code: "skill_invalid", why: "description_too_long", details: { limit: 60 } }, "A descrição passa do limite: no máximo 60 caracteres."],
    [{ code: "skill_invalid", why: "bad_name" }, translations.pt.skillWhyBadName],
    [{ code: "skill_invalid", why: "bad_yaml" }, translations.pt.skillWhyBadYaml],
    [{ code: "skill_invalid", why: "bad_category" }, translations.pt.skillWhyBadCategory],
    [{ code: "skill_has_secret" }, translations.pt.skillHasSecret],
  ])("%j", async (error, words) => {
    world({ dry: refuse(error) });
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(words);
    expect(alert.textContent).not.toContain("English for developers");
    expect(create().disabled).toBe(true);
  });
});

describe("Create waits until the LAST line was reached (padding must not hide text)", () => {
  it("a long text: Create is off and says to read to the end; scrolled to the last line it turns on; a change re-arms it until the end is reached again", async () => {
    metrics.scrollHeight = 1000; metrics.clientHeight = 300; installScroll();
    world();
    mount();
    await checked();
    expect(create().disabled).toBe(true);
    expect(screen.getByText(translations.pt.skillSheetScrollFirst)).toBeTruthy();
    scrollTo(area(), 500);
    expect(create().disabled).toBe(true);                                                      // not yet the last line
    scrollTo(area(), 700);
    await waitFor(() => expect(create().disabled).toBe(false));
    expect(screen.queryByText(translations.pt.skillSheetScrollFirst)).toBeNull();
    tops.set(area(), 100);
    fireEvent.change(area(), { target: { value: BODY + "\n3. changed" } });
    expect(create().disabled).toBe(true);
    await checked();
    expect(create().disabled).toBe(true);                                                      // checked by the server, but the end has not been reached since the change
    scrollTo(area(), 700);
    await waitFor(() => expect(create().disabled).toBe(false));
  });

  it("a short text that fits has nothing to scroll to: Create is on as soon as the server has checked it", async () => {
    world();
    mount();
    await checked();
    expect(create().disabled).toBe(false);
    expect(screen.queryByText(translations.pt.skillSheetScrollFirst)).toBeNull();
  });

  it("warns about more than 20 blank lines in a row and about a line of more than 1,000 columns, and does not block", async () => {
    world();
    mount(BODY + "\n".repeat(22) + "last step");
    expect(screen.getByText(translations.pt.skillSheetBlankWarn)).toBeTruthy();
    expect(screen.queryByText(translations.pt.skillSheetLongWarn)).toBeNull();
    await checked();
    expect(create().disabled).toBe(false);
    cleanup();
    world();
    mount(BODY + "\n3. " + "x".repeat(1001));
    expect(screen.getByText(translations.pt.skillSheetLongWarn)).toBeTruthy();
    expect(screen.queryByText(translations.pt.skillSheetBlankWarn)).toBeNull();
  });

  it("20 blank lines and a line of 1,000 columns are fine: no warning", () => {
    world();
    mount(BODY + "\n".repeat(21) + "3. " + "x".repeat(997));
    expect(screen.queryByText(translations.pt.skillSheetBlankWarn)).toBeNull();
    expect(screen.queryByText(translations.pt.skillSheetLongWarn)).toBeNull();
  });
});

describe("the invisible characters the table allows: named, previewed, removed ONLY on a tap", () => {
  const WITH = "---\nname: send-report\ndescription: Use when a report" + ZWNJ + " must go out.\n---\n1. Open" + ZWNJ + " the report" + LRM + ".\n2. Send it.";
  it("a panel says how many, which and where; the preview shows each one as a visible token; the editable text is untouched", async () => {
    world();
    mount(WITH);
    const panel = screen.getByTestId("skill-invisible-panel");
    expect(panel.textContent).toContain("Este rascunho tem 3 caracteres invisíveis: ZWNJ ×2, LRM ×1, nas linhas 3 e 5.");
    expect(screen.getByTestId("skill-marked-preview").textContent).toBe(WITH.split(ZWNJ).join("[U+200C]").split(LRM).join("[U+200E]"));
    expect(area().value).toBe(WITH);
    await checked();
    expect(create().disabled).toBe(false);                                                     // creating with them left in is allowed once the panel was shown
  });

  it("Remover takes out exactly the marked characters on the tap, then the server checks the new text; nothing is removed before", async () => {
    const w = world();
    mount(WITH);
    await checked();
    expect(area().value).toBe(WITH);
    fireEvent.click(within(screen.getByTestId("skill-invisible-panel")).getByRole("button", { name: "Remover" }));
    expect(area().value).toBe(WITH.split(ZWNJ).join("").split(LRM).join(""));
    expect(screen.queryByTestId("skill-invisible-panel")).toBeNull();
    await waitFor(() => expect(w.dry()).toHaveLength(2));
    expect(w.dry()[1].body.content).toBe(area().value);
  });

  it("the sentence agrees in number: ONE character on ONE line, several on one line, several on several (never '1 caracteres' or 'nas linhas 9')", () => {
    world();
    mount("---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open" + ZWNJ + " the report.\n2. Send it.");
    expect(screen.getByTestId("skill-invisible-panel").textContent).toContain("Este rascunho tem 1 caractere invisível: ZWNJ ×1, na linha 5.");
    cleanup();
    mount("---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open" + ZWNJ + " the" + ZWNJ + " report.\n2. Send it.");
    expect(screen.getByTestId("skill-invisible-panel").textContent).toContain("Este rascunho tem 2 caracteres invisíveis: ZWNJ ×2, na linha 5.");
    cleanup();
    setLuveLocale("en");
    mount("---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open" + ZWNJ + " the report.\n2. Send it.");
    expect(screen.getByTestId("skill-invisible-panel").textContent).toContain("This draft holds 1 invisible character: ZWNJ ×1, at line 5.");
    cleanup();
    mount(WITH);
    expect(screen.getByTestId("skill-invisible-panel").textContent).toContain("This draft holds 3 invisible characters: ZWNJ ×2, LRM ×1, at lines 3 and 5.");
  });

  it("the preview is short, so it opens ON the first line that holds one (the tokens are on screen, not below the fold), and what it says is still the whole text", () => {
    const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get() { return (this as HTMLElement).tagName === "MARK" ? 400 : 0; } });
    Object.defineProperty(Element.prototype, "scrollTop", { configurable: true, get() { return (this as { _top?: number })._top ?? 0; }, set(v: number) { (this as { _top?: number })._top = v; } });
    try {
      world();
      const text = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n\n# Report\n\n1. Open the report.\n2. Sum" + ZWNJ + " it" + ZWNJ + ".\n3. Send it.";
      mount(text);
      const box = screen.getByTestId("skill-marked-preview");
      expect(box.scrollTop).toBe(400 - 24);
      expect(box.querySelector("mark")!.textContent).toBe("2. Sum[U+200C] it[U+200C].");
      expect(box.textContent).toBe(text.split(ZWNJ).join("[U+200C]"));
      for (const edge of [ZWNJ + "---\nname: send-report\n---\nbody", "---\nname: send-report\n---\nbody" + ZWNJ]) {   // typed into the area: a mark on the first and on the last line
        fireEvent.change(area(), { target: { value: edge } });
        expect(screen.getByTestId("skill-marked-preview").textContent).toBe(edge.split(ZWNJ).join("[U+200C]"));
      }
    } finally {
      if (top) Object.defineProperty(HTMLElement.prototype, "offsetTop", top); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
      if (scroll) Object.defineProperty(Element.prototype, "scrollTop", scroll); else delete (Element.prototype as unknown as Record<string, unknown>).scrollTop;
    }
  });

  it("no invisible characters, no panel", () => {
    world();
    mount();
    expect(screen.queryByTestId("skill-invisible-panel")).toBeNull();
    expect(screen.queryByTestId("skill-marked-preview")).toBeNull();
  });
});

describe("Create: born OFF, a person with a login, the exact body", () => {
  it("sends the checked text with dry_run false and shows the created card: off, with Hermes's scan on screen", async () => {
    const w = world();
    mount();
    await checked();
    fireEvent.click(create());
    const card = await screen.findByTestId("skill-created");
    expect(w.real()).toHaveLength(1);
    expect(w.real()[0].body).toEqual({ name: "send-report", content: BODY, dry_run: false });
    expect(w.real()[0].csrf).toBe("csrf-1");
    expect(card.textContent).toContain("Skill criada, desligada");
    expect(card.textContent).toContain("send-report existe no seu Bot e está desligada.");
    expect(screen.getByTestId("skill-scan").textContent).toBe(translations.pt.skillScanAllow);
    expect(w.puts()).toHaveLength(0);                                                          // creating never turns it on
  });

  it("a refused creation says why in words and the text stays for another try", async () => {
    world({ create: () => { throw new ApiError({ code: "skill_exists", message: "English", status: 409 }); } });
    mount();
    await checked();
    fireEvent.click(create());
    expect((await screen.findByRole("alert")).textContent).toContain(translations.pt.skillExists);
    expect(area().value).toBe(BODY);
    expect(screen.queryByTestId("skill-created")).toBeNull();
  });

  it("a name that someone else took while this one was being created says so (it is not the reviewed text, LuveBot turned it off, read it in Skills first), and the text stays (A-187)", async () => {
    world({ create: () => { throw new ApiError({ code: "skill_exists", message: "English", status: 409, details: { appeared_meanwhile: true } }); } });
    mount();
    await checked();
    fireEvent.click(create());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Uma skill com este nome apareceu enquanto esta era criada. Não é a que você revisou: o texto dela é outro. O LuveBot a desligou; leia-a em Skills antes de ligar, se quiser.");
    expect(alert.textContent).toMatch(/Não é a que você revisou/);                            // what the person must know: it is NOT their draft, and it is off by LuveBot's hand
    expect(alert.textContent).not.toContain(translations.pt.skillExists);
    expect(area().value).toBe(BODY);
    expect(screen.queryByTestId("skill-created")).toBeNull();
  });

  it("without a login (loopback) Create is off and says to sign in; the deployment token says its own words; the dry run still works", async () => {
    for (const [auth, words] of [["loopback", translations.pt.skillNeedLogin], ["deployment", translations.pt.errCredentialNotHuman]] as const) {
      cleanup();
      const w = world({ auth });
      mount();
      await checked();
      expect(w.dry().length).toBeGreaterThan(0);
      await waitFor(() => expect(screen.getByText(words)).toBeTruthy());
      expect(create().disabled).toBe(true);
      expect(w.real()).toHaveLength(0);
    }
  });

  it("Create is off while the server is checking and when the check found a problem", async () => {
    world({ dry: () => { throw new ApiError({ code: "skill_invalid", message: "x", status: 422, why: "no_description" }); } });
    mount();
    expect(create().disabled).toBe(true);
    await screen.findByRole("alert");
    expect(create().disabled).toBe(true);
  });
});

describe("turning it on is a second decision, with Hermes's scan on screen", () => {
  const made = (scan: unknown) => world({ create: (b) => ({ skill: { name: b.name }, enabled: false, scan }) });
  const reach = async () => { mount(); await checked(); fireEvent.click(create()); return screen.findByTestId("skill-created"); };
  const turnOn = (name = "Ligar") => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("allow: Ligar sends exactly {enabled: true} for that skill, and says it applies to the next conversations", async () => {
    const w = made({ verdict: "safe", policy: "allow", findings: 0, categories: [] });
    await reach();
    fireEvent.click(turnOn());
    await screen.findByText(translations.pt.skillTurnedOn);
    expect(w.puts()).toHaveLength(1);
    expect(w.puts()[0].url).toMatch(/\/bots\/vendas\/skills\/send-report$/);
    expect(w.puts()[0].body).toEqual({ enabled: true });
    expect(w.puts()[0].csrf).toBe("csrf-1");
    expect(screen.queryByRole("button", { name: "Ligar" })).toBeNull();
  });

  it("ONE finding is '1 achado', never '1 achados', and its category is in words (a category Hermes did not list yet stays as its own name)", async () => {
    made({ verdict: "caution", policy: "ask", findings: 1, categories: ["supply_chain", "novo_tipo"] });
    await reach();
    expect(screen.getByTestId("skill-scan").textContent).toBe("A verificação do Hermes pede atenção: 1 achado (baixa e roda código de fora, novo_tipo). Ligue só se você confia no que leu.");
  });

  it("ask: the findings are on screen and the button says 'Ligar mesmo assim'", async () => {
    const w = made({ verdict: "caution", policy: "ask", findings: 3, categories: ["network", "install"] });
    await reach();
    expect(screen.getByTestId("skill-scan").textContent).toBe("A verificação do Hermes pede atenção: 3 achados (acesso à rede, install). Ligue só se você confia no que leu.");
    expect(screen.queryByRole("button", { name: "Ligar" })).toBeNull();
    fireEvent.click(turnOn("Ligar mesmo assim"));
    await screen.findByText(translations.pt.skillTurnedOn);
    expect(w.puts()).toHaveLength(1);
  });

  it("block: it says so, and the turn-on is OFF (no request can be made from here)", async () => {
    const w = made({ verdict: "dangerous", policy: "block", findings: 2, categories: ["exfiltration"] });
    await reach();
    expect(screen.getByTestId("skill-scan").textContent).toBe(translations.pt.skillScanBlock);
    expect(turnOn().disabled).toBe(true);
    fireEvent.click(turnOn());
    await new Promise((r) => setTimeout(r, 60));
    expect(w.puts()).toHaveLength(0);
  });

  it("no scan available: it says Hermes could not scan, and the turn-on is still the person's decision (the server checks again)", async () => {
    made(null);
    await reach();
    expect(screen.getByTestId("skill-scan").textContent).toBe(translations.pt.skillScanNone);
    expect(turnOn().disabled).toBe(false);
  });

  it("the server blocks anyway (409 skill_scan_blocked): the words and the categories, and the button stays for no second try that could work", async () => {
    world({ toggle: () => { throw new ApiError({ code: "skill_scan_blocked", message: "English", status: 409, details: { verdict: "dangerous", categories: ["exfiltration"] } }); },
            create: (b) => ({ skill: { name: b.name }, enabled: false, scan: { verdict: "safe", policy: "allow", findings: 0, categories: [] } }) });
    await reach();
    fireEvent.click(turnOn());
    expect((await screen.findByRole("alert")).textContent).toContain(`${translations.pt.skillScanBlocked} (envio de dados para fora)`);
    expect(screen.queryByText(translations.pt.skillTurnedOn)).toBeNull();
  });
});

describe("in English", () => {
  it("the sheet speaks English", async () => {
    setLuveLocale("en");
    world();
    mount();
    expect(screen.getByRole("dialog").textContent).toContain("This becomes permanent instructions for your Bot. Read all of it.");
    expect(screen.getByText("6 lines. It ends at line 6.")).toBeTruthy();
    await screen.findByText(/^Checked: \d+ bytes\.$/);
    expect(screen.getByRole("button", { name: "Create skill (born off)" })).toBeTruthy();
  });
});

describe("the other lines of the sheet draw the table's characters as tokens too (F-SK5-1)", () => {
  it("the name the header says, when it holds a hidden character, is drawn with its token (and the server refuses the name)", async () => {
    world({ dry: () => { throw new ApiError({ code: "skill_invalid", message: "x", status: 422, why: "bad_name" }); } });
    mount(BODY.replace("name: send-report", "name: send" + ZWNJ + "-report"));
    expect(screen.getByText("send[U+200C]-report")).toBeTruthy();
    await screen.findByRole("alert");
  });
  it("the created card draws the server's name the same way", async () => {
    world({ create: (b) => ({ skill: { name: b.name + String.fromCodePoint(0x200b) }, enabled: false, scan: { verdict: "safe", policy: "allow", findings: 0, categories: [] } }) });
    mount();
    await checked();
    fireEvent.click(create());
    const card = await screen.findByTestId("skill-created");
    expect(card.textContent).toContain("send-report[U+200B] existe no seu Bot");
  });
});

