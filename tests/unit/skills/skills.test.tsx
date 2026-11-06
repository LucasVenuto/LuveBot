// tests/unit/skills/skills.test.tsx (contract v0.6 Part A)
// A Bot's skills: the state in words ("Ligada, exceto no Telegram"), the switch calls PUT with {enabled} and the row shows the
// state Hermes RE-READ (not the click), what is still off where (LuveBot first), essential locked, errors in words, the SKILL.md
// as plain text; the Bot x Skill matrix, with a Bot that could not be read said as such.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { SkillsView, SkillsMatrixView } from "@/components/skills/SkillsView";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { BotSkill } from "@/api/types";

const skill = (name: string, over: Partial<BotSkill> = {}): BotSkill => ({
  name, description: `faz ${name}`, provenance: "hub", usage: 3, essential: false, enabled: { all: true }, state: "on", ...over,
});
const LIST = {
  bot: "vendas", platforms: ["api_server", "telegram"],
  skills: [
    skill("pdf", { enabled: { all: true, api_server: true, telegram: false }, state: "partial" }),
    skill("planilha", { enabled: { all: false }, state: "off" }),
    skill("memoria", { essential: true, provenance: "bundled" }),
  ],
  notes: { on_applies_to_new_conversations: true, fail_open: true, catalog_may_omit: true },
};

let puts: Array<{ url: string; body: any }>;
let answer: (url: string, body: any) => any;
beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); puts = [];
  answer = () => { throw new Error("no answer"); };
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
    if ((init?.method ?? "GET") === "PUT") { const body = JSON.parse(String(init!.body)); puts.push({ url, body }); return answer(url, body); }
    if (url.endsWith("/bots/vendas/skills")) return LIST;
    if (url.endsWith("/skills/pdf/content")) return { name: "pdf", content: "# PDF\n<a href=\"https://fora.example\">x</a> ![i](https://fora.example/i.png) <img src=x>", redacted: true, truncated: false };
    if (url.endsWith("/skills/matrix")) return {
      bots: ["vendas", { bot: "suporte", error: "hermes_error" }],
      skills: [{ name: "pdf", provenance: "hub" }, { name: "planilha", provenance: "agent" }],
      cells: [{ bot: "vendas", skill: "pdf", state: "partial" }, { bot: "vendas", skill: "planilha", state: "absent" }],
    };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(() => setCustomFetchJSON(null));

const row = async (name: string) => screen.findByTestId(`skill-${name}`);

describe("a Bot's skills", () => {
  it("the usage count agrees in number: 0 vezes, 1 vez, 3 vezes (never 'vez(es)'); and in English", async () => {
    const keep = LIST.skills;
    LIST.skills = [skill("zero", { usage: 0 }), skill("um", { usage: 1 }), skill("tres", { usage: 3 })];
    try {
      render(<SkillsView botName="vendas" botLabel="Vendas" />);
      expect((await row("zero")).textContent).toContain("usada 0 vezes");
      expect((await row("um")).textContent).toContain("usada 1 vez");
      expect((await row("um")).textContent).not.toContain("vezes");
      expect((await row("tres")).textContent).toContain("usada 3 vezes");
      cleanup();
      setLuveLocale("en");
      render(<SkillsView botName="vendas" botLabel="Vendas" />);
      expect((await row("um")).textContent).toContain("used 1 time");
      expect((await row("um")).textContent).not.toContain("times");
      expect((await row("tres")).textContent).toContain("used 3 times");
    } finally { LIST.skills = keep; }
  });

  it("the state in words: on, off, and 'Ligada, exceto no Telegram'", async () => {
    render(<SkillsView botName="vendas" botLabel="Vendas" />);
    expect(within(await row("pdf")).getByTestId("skill-state").textContent).toBe("Ligada, exceto no Telegram");
    expect(within(await row("planilha")).getByTestId("skill-state").textContent).toBe("Desligada");
    expect(within(await row("memoria")).getByTestId("skill-state").textContent).toBe("Ligada");
    expect(screen.getByText(translations.pt.skillsFailOpen)).toBeTruthy();
    expect(screen.getByText(translations.pt.skillsCatalogMayOmit)).toBeTruthy();
  });

  it("the switch sends {enabled} and the row shows Hermes's RE-READ state; still off where, LuveBot first; new conversations", async () => {
    // Hermes turned it on globally but keeps it off on api_server and telegram: the row must say so, not what was clicked
    answer = () => ({ skill: skill("planilha", { enabled: { all: true, api_server: false, telegram: false }, state: "partial" }),
      notice: "on_applies_to_new_conversations", still_off_on: ["telegram", "api_server"] });
    render(<SkillsView botName="vendas" />);
    const r = await row("planilha");
    const sw = within(r).getByRole("switch", { name: "Ligar ou desligar planilha" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    await waitFor(() => expect(within(r).getByTestId("skill-state").textContent).toBe("Ligada, exceto no LuveBot, Telegram"));
    expect(puts).toEqual([{ url: expect.stringMatching(/\/bots\/vendas\/skills\/planilha$/), body: { enabled: true } }]);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const lines = within(r).getByRole("status").querySelectorAll("p");
    expect(Array.from(lines).map((p) => p.textContent)).toEqual([
      translations.pt.skillsStillOffLuvebot, "Ainda desligada no Telegram: ajuste só pelo Hermes (hermes skills).", translations.pt.skillsNewConversations,
    ]);
  });

  it("turning off: the re-read state, and 'vale na hora'", async () => {
    answer = () => ({ skill: skill("pdf", { enabled: { all: false }, state: "off" }), notice: null, still_off_on: [] });
    render(<SkillsView botName="vendas" />);
    const r = await row("pdf");
    fireEvent.click(within(r).getByRole("switch"));
    await waitFor(() => expect(within(r).getByTestId("skill-state").textContent).toBe("Desligada"));
    expect(puts[0].body).toEqual({ enabled: false });
    expect(within(r).getByRole("status").textContent).toBe(translations.pt.skillsOffNow);
  });

  it("an essential skill is locked: no PUT", async () => {
    render(<SkillsView botName="vendas" />);
    const sw = within(await row("memoria")).getByRole("switch");
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sw);
    expect(puts).toHaveLength(0);
  });

  it.each([
    [new ApiError({ code: "loopback_not_human", message: "x", status: 403 }), translations.pt.errLoopback],
    [new ApiError({ code: "skill_essential", message: "x", status: 409 }), translations.pt.skillsErrEssential],
    [new ApiError({ code: "skill_not_found", message: "x", status: 404 }), translations.pt.skillsErrNotFound],
    [new ApiError({ code: "hermes_error", message: "Hermes could not", status: 502 }), translations.pt.skillsErrHermes],
  ])("an error in words, and the row keeps its state (%#)", async (err, words) => {
    answer = () => { throw err; };
    render(<SkillsView botName="vendas" />);
    const r = await row("planilha");
    fireEvent.click(within(r).getByRole("switch"));
    expect((await within(r).findByRole("alert")).textContent).toContain(words);
    expect(within(r).getByTestId("skill-state").textContent).toBe("Desligada");
    expect(within(r).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("the SKILL.md is plain text: no link, no image; 'redacted' said", async () => {
    render(<SkillsView botName="vendas" />);
    const r = await row("pdf");
    fireEvent.click(within(r).getByRole("button", { name: "Ver" }));
    const text = await within(r).findByTestId("skill-text");
    expect(text.textContent).toContain('<a href="https://fora.example">x</a>');
    expect(r.querySelectorAll("a, img").length).toBe(0);
    expect(within(r).getByText(translations.pt.skillsRedacted)).toBeTruthy();
  });
});

describe("the Bot x Skill matrix", () => {
  it("each cell from the server; an absent cell is a dash; a Bot that could not be read says so", async () => {
    render(<SkillsMatrixView bots={[{ name: "vendas", display: { label: "Vendas" } } as any, { name: "suporte" } as any]} />);
    const table = await screen.findByRole("table", { name: translations.pt.skillsMatrixTitle });
    expect(within(table).getByRole("columnheader", { name: "Vendas" })).toBeTruthy();
    expect(screen.getByTestId("cell-vendas-pdf").textContent).toBe("Parcial");
    expect(screen.getByTestId("cell-vendas-planilha").textContent).toBe("—");
    expect(screen.getByTestId("cell-suporte-pdf").textContent).toBe(translations.pt.skillsUnreadable);
    expect(screen.getByTestId("cell-suporte-planilha").textContent).toBe(translations.pt.skillsUnreadable);
  });
});
