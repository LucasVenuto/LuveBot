// tests/unit/skills/skill-editor.test.tsx
// Editing a skill that exists (contract v0.11 3.3), through the Skills screen: the Edit button only where the SERVER says `editable` (and why not, in words, where it does not), the change shown as a line diff against the
// text that was loaded and read to its last line before Save, the exact PUT with the digest that was loaded, "this skill is on" said, the line ending kept, and every refusal in words.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, configure } from "@testing-library/react";
import { SkillsView } from "@/components/skills/SkillsView";
import { ApiError, resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { BotSkill } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const cp = (...c: number[]) => String.fromCodePoint(...c);
const ZWNJ = cp(0x200c), TAG = cp(0xe0041);
const TEXT = "---\nname: meu-fluxo\ndescription: Use when a report goes out.\n---\n1. Open the report.\n2. Send it.";
const skill = (name: string, over: Partial<BotSkill> = {}): BotSkill => ({ name, description: `faz ${name}`, provenance: "agent", usage: 1, essential: false, enabled: { all: true }, state: "on", ...over });
type Doc = { content: string; digest?: string; editable?: boolean; redacted?: boolean; truncated?: boolean };
const DOCS: Record<string, Doc> = {};
let skills: BotSkill[];
let gets: number;
let contentReads: number;
type Put = { url: string; body: any; csrf: string | null };
let puts: Put[];
let putAnswer: (body: any) => unknown;
let auth = "gated";

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); auth = "gated"; gets = 0; contentReads = 0; puts = [];
  for (const k of Object.keys(DOCS)) delete DOCS[k];
  DOCS["meu-fluxo"] = { content: TEXT, digest: "d1", editable: true, redacted: false, truncated: false };
  skills = [skill("meu-fluxo"), skill("pdf", { provenance: "hub" }), skill("segredo"), skill("grande"), skill("antiga", { enabled: { all: false }, state: "off" }), skill("velha")];
  DOCS.pdf = { content: "# PDF", digest: "dp", editable: false, redacted: false, truncated: false };
  DOCS.segredo = { content: "key: [redacted]", digest: "ds", editable: false, redacted: true, truncated: false };
  DOCS.grande = { content: "x", digest: "dg", editable: false, redacted: false, truncated: true };
  DOCS.antiga = { content: TEXT.replace("meu-fluxo", "antiga"), digest: "da", editable: true, redacted: false, truncated: false };
  DOCS.velha = { content: "# old backend" };                                             // a backend before v0.11 3.3: no digest, no editable
  putAnswer = (b) => ({ name: "meu-fluxo", bytes: new TextEncoder().encode(b.content).length, digest: "d2", warnings: [], on: true, scan: { verdict: "safe", policy: "allow", findings: 0, categories: [] } });
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: auth };
    if (method === "GET" && url.endsWith("/bots/vendas/skills")) { gets++; return { bot: "vendas", platforms: ["api_server"], skills, notes: { on_applies_to_new_conversations: true, fail_open: false, catalog_may_omit: false } }; }
    const m = /\/skills\/([^/]+)\/content$/.exec(url);
    if (method === "GET" && m) { contentReads++; return { name: m[1], ...DOCS[m[1]] }; }
    if (method === "PUT" && m) {
      const body = JSON.parse(String(init!.body)); puts.push({ url, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      return putAnswer(body);
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(() => { setCustomFetchJSON(null); uninstallScroll(); });

// jsdom has no layout: the diff box's scroll metrics come from here (only for that element)
const metrics = { scrollHeight: 0, clientHeight: 0 };
const tops = new WeakMap<object, number>();
function installScroll() {
  const mine = (el: HTMLElement) => el.dataset.testid === "skill-diff-box";
  Object.defineProperty(HTMLDivElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLElement) { return mine(this) ? metrics.scrollHeight : 0; } });
  Object.defineProperty(HTMLDivElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return mine(this) ? metrics.clientHeight : 0; } });
  Object.defineProperty(HTMLDivElement.prototype, "scrollTop", { configurable: true, get() { return tops.get(this) ?? 0; }, set(v: number) { tops.set(this, v); } });
}
function uninstallScroll() { for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) delete (HTMLDivElement.prototype as any)[k]; metrics.scrollHeight = 0; metrics.clientHeight = 0; }

const open = async (name: string) => { render(<SkillsView botName="vendas" botLabel="Vendas" />); const row = await screen.findByTestId(`skill-${name}`); fireEvent.click(within(row).getByRole("button", { name: "Ver" })); return row; };
const edit = async (name = "meu-fluxo") => { const row = await open(name); fireEvent.click(await within(row).findByRole("button", { name: "Editar" })); return row; };
const area = () => screen.getByLabelText("Texto da skill (SKILL.md)") as HTMLTextAreaElement;
const change = (to: string) => fireEvent.change(area(), { target: { value: to } });
const review = () => screen.getByRole("button", { name: "Ver a mudança" }) as HTMLButtonElement;
const save = () => screen.getByRole("button", { name: "Salvar a edição" }) as HTMLButtonElement;
const EDITED = TEXT.replace("2. Send it.", "2. Send it to the team.\n3. Archive it.");

describe("who can be edited, and why not", () => {
  it("Editar only where the server says editable (provenance agent, shown whole and unchanged)", async () => {
    const row = await open("meu-fluxo");
    expect(await within(row).findByRole("button", { name: "Editar" })).toBeTruthy();
    expect(within(row).queryByTestId("skill-not-editable")).toBeNull();
  });
  it("a skill from the hub: no button, and it says to edit it where it comes from", async () => {
    const row = await open("pdf");
    expect((await within(row).findByTestId("skill-not-editable")).textContent).toBe(translations.pt.skillEditNotEditable);
    expect(within(row).queryByRole("button", { name: "Editar" })).toBeNull();
  });
  it("a text with hidden parts (redacted) or one that was cut: no button, and the reason in words", async () => {
    expect((await within(await open("segredo")).findByTestId("skill-not-editable")).textContent).toBe(translations.pt.skillEditRedacted);
    cleanup();
    expect((await within(await open("grande")).findByTestId("skill-not-editable")).textContent).toBe(translations.pt.skillEditTruncated);
  });
  it("a backend that does not say (before v0.11 3.3): no button and no sentence, the text is only read", async () => {
    const row = await open("velha");
    await within(row).findByTestId("skill-text");
    expect(within(row).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(within(row).queryByTestId("skill-not-editable")).toBeNull();
  });
});

describe("the change, read before it is saved", () => {
  it("the editor says it changes permanent instructions; with nothing changed there is nothing to review", async () => {
    await edit();
    expect(screen.getByTestId("skill-editor").textContent).toContain("Isto muda as instruções permanentes do seu Bot. Leia a mudança antes de salvar.");
    expect(area().value).toBe(TEXT);
    expect(screen.getByText(translations.pt.skillEditNothing)).toBeTruthy();
    expect(review().disabled).toBe(true);
  });

  it("'Ver a mudança' shows a line diff against the text that was LOADED: removed and added lines, nothing sent yet", async () => {
    await edit();
    change(EDITED);
    expect(review().disabled).toBe(false);
    fireEvent.click(review());
    const list = await screen.findByRole("list", { name: translations.pt.pageDiffLabel });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual(expect.arrayContaining([
      expect.stringContaining("2. Send it."), expect.stringContaining("2. Send it to the team."), expect.stringContaining("3. Archive it.")]));
    expect(screen.getByText("Linhas com − estão em versão salva; com +, em sua edição.")).toBeTruthy();
    expect(puts).toHaveLength(0);
  });

  it("says whether the skill is ON (the Bot uses the change at once) or OFF (only after it is turned on)", async () => {
    await edit();
    change(EDITED); fireEvent.click(review());
    expect(await screen.findByText(translations.pt.skillEditOn)).toBeTruthy();
    cleanup();
    await edit("antiga");
    change(DOCS.antiga.content + "\n3. More."); fireEvent.click(review());
    expect(await screen.findByText(translations.pt.skillEditOff)).toBeTruthy();
    expect(screen.queryByText(translations.pt.skillEditOn)).toBeNull();
  });

  it("Save stays off until the change was read to its LAST line, and 'Voltar a editar' goes back with the text kept", async () => {
    metrics.scrollHeight = 1000; metrics.clientHeight = 300; installScroll();
    await edit();
    change(EDITED); fireEvent.click(review());
    await screen.findByTestId("skill-diff-box");
    expect(save().disabled).toBe(true);
    expect(screen.getByText(translations.pt.skillEditScrollFirst)).toBeTruthy();
    const box = screen.getByTestId("skill-diff-box");
    tops.set(box, 400); fireEvent.scroll(box);
    expect(save().disabled).toBe(true);
    tops.set(box, 700); fireEvent.scroll(box);
    await waitFor(() => expect(save().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Voltar a editar" }));
    expect(area().value).toBe(EDITED);
  });

  it("a change too big to compare here cannot be saved (nothing is written that the person could not see)", async () => {
    await edit();
    change(Array.from({ length: 20_001 }, (_, i) => `step ${i}`).join("\n"));
    fireEvent.click(review());
    expect((await screen.findByRole("alert")).textContent).toBe(translations.pt.skillEditTooBig);
    expect(save().disabled).toBe(true);
  });
});

describe("saving", () => {
  it("one PUT with exactly the new text and the digest that was LOADED, with the CSRF; then it says saved, the scan, and the list is read again", async () => {
    await edit();
    const readsBefore = gets;
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    expect(await screen.findByText(translations.pt.skillEditSaved)).toBeTruthy();
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toMatch(/\/bots\/vendas\/skills\/meu-fluxo\/content$/);
    expect(puts[0].body).toEqual({ content: EDITED, expected_digest: "d1" });
    expect(puts[0].csrf).toBe("csrf-1");
    expect(screen.getByTestId("skill-edit-scan").textContent).toBe(translations.pt.skillScanAllow);
    await waitFor(() => expect(gets).toBe(readsBefore + 1));
  });

  it("after closing, the text shown is the saved one, and the next edit carries the NEW digest", async () => {
    await edit();
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    await screen.findByText(translations.pt.skillEditSaved);
    fireEvent.click(within(screen.getByTestId("skill-editor-saved")).getByRole("button", { name: "Fechar" }));
    expect(screen.getByTestId("skill-text").textContent).toBe(EDITED);
    DOCS["meu-fluxo"] = { ...DOCS["meu-fluxo"], content: EDITED, digest: "d2" };
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    change(EDITED + "\n4. Again."); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts[1].body.expected_digest).toBe("d2");
  });

  it("the skill's own line ending is kept: opening it and changing a line writes CRLF back, and an untouched CRLF text is 'nothing changed'", async () => {
    DOCS["meu-fluxo"].content = TEXT.replace(/\n/g, "\r\n");
    await edit();
    expect(area().value).toBe(TEXT);                                                           // the area shows LF
    expect(review().disabled).toBe(true);
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].body.content).toBe(EDITED.replace(/\n/g, "\r\n"));
  });

  it("an ON skill whose new scan BLOCKS says it is on and blocked (turn it off); an 'ask' scan says what it found; no scan says so", async () => {
    putAnswer = () => ({ name: "meu-fluxo", bytes: 1, digest: "d2", warnings: [], on: true, turned_off: false, scan: { verdict: "dangerous", policy: "block", findings: 2, categories: ["exfiltration"] } });   // A-187: turning it off failed, the text IS saved
    await edit();
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    expect((await screen.findByTestId("skill-edit-scan")).textContent).toBe(translations.pt.skillEditBlockedOn);       // never "we turned it off" when it is still on
    expect(screen.getByTestId("skill-edit-scan").textContent).not.toBe(translations.pt.skillEditTurnedOff);
    cleanup();
    putAnswer = () => ({ name: "meu-fluxo", bytes: 1, digest: "d3", warnings: [], on: false, scan: { verdict: "caution", policy: "ask", findings: 3, categories: ["network", "install"] } });
    await edit();
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    expect((await screen.findByTestId("skill-edit-scan")).textContent).toBe("A verificação do Hermes pede atenção: 3 achados (acesso à rede, install).");
    cleanup();
    putAnswer = () => ({ name: "meu-fluxo", bytes: 1, digest: "d3b", warnings: [], on: false, scan: { verdict: "caution", policy: "ask", findings: 1, categories: ["supply_chain"] } });
    await edit();
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    expect((await screen.findByTestId("skill-edit-scan")).textContent).toBe("A verificação do Hermes pede atenção: 1 achado (baixa e roda código de fora).");   // one finding, never "1 achados"
    cleanup();
    putAnswer = () => ({ name: "meu-fluxo", bytes: 1, digest: "d4", warnings: [], on: false, scan: null });
    await edit();
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    expect((await screen.findByTestId("skill-edit-scan")).textContent).toBe(translations.pt.skillScanNone);
  });

  it("an edit that makes an ON skill blocked: LuveBot turned it OFF (A-177) and says why, never 'it is on'", async () => {
    putAnswer = () => ({ name: "meu-fluxo", bytes: 1, digest: "d2", warnings: [], on: false, turned_off: true, scan: { verdict: "dangerous", policy: "block", findings: 2, categories: ["exfiltration"] } });
    await edit();
    change(EDITED); fireEvent.click(review());
    fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); }));
    expect((await screen.findByTestId("skill-edit-scan")).textContent).toBe(translations.pt.skillEditTurnedOff);
    expect(screen.getByTestId("skill-editor-saved").textContent).not.toContain("está ligada");
  });

  it("without a login (loopback) or with the deployment token, Save is off and says why; the diff is still readable", async () => {
    for (const [mode, words] of [["loopback", translations.pt.skillNeedLogin], ["deployment", translations.pt.errCredentialNotHuman]] as const) {
      cleanup(); auth = mode;
      await edit();
      change(EDITED); fireEvent.click(review());
      await screen.findByRole("list", { name: translations.pt.pageDiffLabel });
      await waitFor(() => expect(screen.getByText(words)).toBeTruthy());
      expect(save().disabled).toBe(true);
    }
    expect(puts).toHaveLength(0);
  });
});

describe("what the server refuses, in words (never its English)", () => {
  const refuse = (code: string, extra: Partial<{ why: string; details: Record<string, any>; status: number }> = {}) => () => { throw new ApiError({ code, message: "English for developers", status: extra.status ?? 422, details: extra.details, why: extra.why }); };
  const attempt = async () => { await edit(); change(EDITED); fireEvent.click(review()); fireEvent.click(await waitFor(() => { expect(save().disabled).toBe(false); return save(); })); return screen.findByRole("alert"); };

  it("an old digest (409 stale): the words, a Reload that reads the skill again and closes the editor, and nothing was overwritten", async () => {
    putAnswer = refuse("stale", { status: 409 });
    const alert = await attempt();
    expect(alert.textContent).toContain(translations.pt.skillEditStale);
    expect(alert.textContent).not.toContain("English for developers");
    const before = contentReads;
    DOCS["meu-fluxo"] = { ...DOCS["meu-fluxo"], content: TEXT + "\n3. Someone else's step.", digest: "d9" };
    fireEvent.click(screen.getByRole("button", { name: translations.pt.skillEditReload }));
    await waitFor(() => expect(contentReads).toBe(before + 1));
    expect((await screen.findByTestId("skill-text")).textContent).toContain("Someone else's step.");
    expect(screen.queryByTestId("skill-editor")).toBeNull();
  });

  it.each([
    ["skill_not_editable", {}, translations.pt.skillEditNotEditable],
    ["skill_redacted", {}, translations.pt.skillEditRedacted],
    ["skill_truncated", {}, translations.pt.skillEditTruncated],
    ["skill_has_secret", {}, translations.pt.skillHasSecret],
    ["skill_invalid", { why: "description_too_long", details: { limit: 1024 } }, "A descrição passa do limite: no máximo 1024 caracteres."],
    ["skill_invalid", { why: "bad_yaml" }, translations.pt.skillWhyBadYaml],
    ["skill_invalid", { why: "hidden_characters", details: { code: "U+202E", line: 3, column: 5 } }, "um controle de direção do texto (bidi)"],
  ] as const)("%s %j", async (code, extra, words) => {
    putAnswer = refuse(code, extra as any);
    const alert = await attempt();
    expect(alert.textContent).toContain(words);
    expect(alert.textContent).not.toContain("English for developers");
    expect(screen.queryByText(translations.pt.skillEditSaved)).toBeNull();
  });
});

describe("the text itself", () => {
  it("a refused character typed in: its class and place in words, no review, nothing sent", async () => {
    await edit();
    change(TEXT + "\n3. sneaky" + TAG + "step");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("um caractere de etiqueta Unicode");
    expect(alert.textContent).toContain("linha 7, coluna 10");
    expect(alert.textContent).not.toContain(TAG);
    expect(review().disabled).toBe(true);
  });
  it("allowed invisible characters are named and removed only on a tap", async () => {
    await edit();
    const withZ = TEXT.replace("Open", "Open" + ZWNJ);
    change(withZ);
    expect(screen.getByTestId("skill-invisible-panel").textContent).toContain("ZWNJ ×1");
    expect(area().value).toBe(withZ);
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    expect(area().value).toBe(TEXT);
    expect(screen.queryByTestId("skill-invisible-panel")).toBeNull();
  });
});

describe("in English", () => {
  it("the editor speaks English", async () => {
    setLuveLocale("en");
    render(<SkillsView botName="vendas" botLabel="Vendas" />);
    const row = await screen.findByTestId("skill-meu-fluxo");
    fireEvent.click(within(row).getByRole("button", { name: "View" }));
    fireEvent.click(await within(row).findByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("skill-editor").textContent).toContain("This changes your Bot's permanent instructions. Read the change before saving.");
    expect(screen.getByText("Nothing has changed yet.")).toBeTruthy();
  });
});
