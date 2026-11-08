// tests/unit/ui/luve-studio.test.tsx
// Crie seu Luve U2 (proposal docs/propostas/v02-crie-seu-luve.md §2): the studio is four steps (shape, color, material, accessory)
// with a live 2D preview. Its only output is the canonical recipe, built from the kit's fixed lists; choosing is a click, closing
// without "use" changes nothing, Esc and Tab never reach the screen underneath, and every option is a named button.
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { LuveEntry, LuveStudio, startRecipe, surprise } from "@/components/ui/LuveStudio";
import { BotProfile } from "@/components/bots/BotProfile";
import { BotCreateModal } from "@/components/bots/BotCreateModal";
import { KIT, formatLuve, parseLuve } from "@/components/ui/luve";
import type { BotDetail } from "@/api/types";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";

const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
beforeEach(() => { Object.assign(URL, { createObjectURL: () => "blob:luvebot/x", revokeObjectURL: () => {} }); });
afterEach(() => { cleanup(); Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke }); });

const SWATCH = (i: number) => (KIT.swatches[i].base as string).slice(1);
const open = (props: Partial<React.ComponentProps<typeof LuveStudio>> = {}) => {
  const onUse = vi.fn(), onClose = vi.fn();
  render(<LuveStudio open onClose={onClose} onUse={onUse} useLabel="Usar em Vendas" {...props} />);
  return { onUse, onClose };
};
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
const summary = () => document.querySelector(".lb-luve-summary")!.textContent;

describe("the studio's four steps", () => {
  it("starts from the seed mascot's shape in its own color, vinyl, no accessory, and says it in words", () => {
    open({ seedShape: "nimbo" });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Forma", "Cor", "Material", "Acessório"]);
    expect(screen.getByRole("tab", { name: "Forma" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".lb-luve-step")!.textContent).toBe("1 de 4");
    expect(summary()).toMatch(/^Nimbo, cor #[0-9a-f]{6}, vinil, sem acessório$/);
    expect(screen.getByRole("button", { name: "Forma Nimbo" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("choosing in each step changes the preview and the sentence, and 'use' sends exactly the canonical recipe", () => {
    const { onUse, onClose } = open({ seedShape: "nimbo" });
    fireEvent.click(screen.getByRole("button", { name: "Forma Tico" }));
    tab("Cor");
    fireEvent.click(screen.getByRole("button", { name: `Cor #${SWATCH(2)}` }));
    tab("Material");
    fireEvent.click(screen.getByRole("button", { name: "Material fosco" }));
    tab("Acessório");
    fireEvent.click(screen.getByRole("button", { name: "Acessório lupa" }));
    expect(summary()).toBe(`Tico, cor #${SWATCH(2)}, fosco, com lupa`);
    expect(onUse).not.toHaveBeenCalled();                                   // nothing happens until the person says so
    fireEvent.click(screen.getByRole("button", { name: "Usar em Vendas" }));
    expect(onUse).toHaveBeenCalledExactlyOnceWith(`tico.fosco.lupa.${SWATCH(2)}`);
    expect(parseLuve(onUse.mock.calls[0][0])).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();                                 // the caller decides what happens after "use"
  });

  it("'Próximo' walks the four steps and becomes the 'use' button on the last; 'Voltar' is off on the first", () => {
    open();
    const back = screen.getByRole("button", { name: "Voltar" });
    expect((back as HTMLButtonElement).disabled).toBe(true);
    for (const name of ["Cor", "Material", "Acessório"]) {
      fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
      expect(screen.getByRole("tab", { name }).getAttribute("aria-selected")).toBe("true");
    }
    expect(screen.queryByRole("button", { name: "Próximo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Usar em Vendas" })).toBeDefined();
    fireEvent.click(back);
    expect(screen.getByRole("tab", { name: "Material" }).getAttribute("aria-selected")).toBe("true");
  });

  it("offers every shape, material and accessory of the kit as a named, pressed-or-not button", () => {
    open();
    const group = () => screen.getByRole("group", { name: screen.getByRole("tab", { selected: true }).textContent! });
    expect(within(group()).getAllByRole("button")).toHaveLength(Object.keys(KIT.shapes).length);
    tab("Material");
    expect(within(group()).getAllByRole("button")).toHaveLength(Object.keys(KIT.materials).length);
    tab("Acessório");
    expect(within(group()).getAllByRole("button")).toHaveLength(Object.keys(KIT.accessories).length);
    tab("Cor");
    expect(within(group()).getAllByRole("button")).toHaveLength(KIT.swatches.length);
    for (const b of within(group()).getAllByRole("button")) expect(b.getAttribute("aria-pressed")).toMatch(/^(true|false)$/);
  });

  it("opens on the Luve already worn, with its choice marked in every step", () => {
    open({ initial: `eco.laca.sinos.${SWATCH(1)}` });
    expect(screen.getByRole("button", { name: "Forma Eco" }).getAttribute("aria-pressed")).toBe("true");
    tab("Material");
    expect(screen.getByRole("button", { name: "Material laca" }).getAttribute("aria-pressed")).toBe("true");
    tab("Acessório");
    expect(screen.getByRole("button", { name: "Acessório sininhos" }).getAttribute("aria-pressed")).toBe("true");
    tab("Cor");
    expect(screen.getByRole("button", { name: `Cor #${SWATCH(1)}` }).getAttribute("aria-pressed")).toBe("true");
  });

  it("'Outra cor' takes the native color input, lowercased, without the #", () => {
    const { onUse } = open({ initial: `eco.vinil.nenhum.${SWATCH(0)}` });
    tab("Cor");
    const input = screen.getByLabelText("Outra cor") as HTMLInputElement;
    expect(input.type).toBe("color");
    fireEvent.change(input, { target: { value: "#AABBCC" } });
    expect(summary()).toContain("#aabbcc");
    tab("Acessório");
    fireEvent.click(screen.getByRole("button", { name: "Usar em Vendas" }));
    expect(onUse).toHaveBeenCalledWith("eco.vinil.nenhum.aabbcc");
  });

  it("'Surpreenda-me' always makes a valid recipe (and so does surprise() a thousand times)", () => {
    const { onUse } = open();
    fireEvent.click(screen.getByRole("button", { name: "Surpreenda-me" }));
    tab("Acessório");
    fireEvent.click(screen.getByRole("button", { name: "Usar em Vendas" }));
    expect(parseLuve(onUse.mock.calls[0][0])).not.toBeNull();
    for (let i = 0; i < 1000; i++) expect(parseLuve(formatLuve(surprise())), `surprise ${i}`).not.toBeNull();
  });

  it("a recipe that does not check never starts the studio: it falls back to the seed (or the first shape)", () => {
    expect(startRecipe("nimbo.ouro.lupa.38bdf8", "zuca").shape).toBe("zuca");
    expect(startRecipe("https://x/y.svg", "../x").shape).toBe(Object.keys(KIT.shapes)[0]);
    expect(startRecipe(null).accessory).toBe("nenhum");
  });
});

describe("keyboard and focus", () => {
  it("arrows move among the options (one tab stop for the group), Home and End go to the ends", () => {
    open({ seedShape: "luvi" });
    const first = screen.getByRole("button", { name: "Forma Luvi" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute("aria-label")).toMatch(/^Forma /);
    expect(first.getAttribute("tabindex")).toBe("0");                       // only the chosen one is in the tab order
    expect(second.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Forma Tico");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(first);
  });

  it("Esc closes the studio and is stopped there: a listener on window (the screen underneath) never sees it", () => {
    const below = vi.fn();
    window.addEventListener("keydown", below);
    const { onClose } = open();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Forma" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "a" });
    expect(below).toHaveBeenCalledTimes(1);                                 // other keys still pass
    window.removeEventListener("keydown", below);
  });

  it("Tab wraps inside the studio, in both directions, and the screen underneath never sees it", () => {
    const below = vi.fn();
    window.addEventListener("keydown", below);
    open();
    const dialog = screen.getByRole("dialog");
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input")).filter((e) => e.getAttribute("tabindex") !== "-1");
    stops.at(-1)!.focus();
    fireEvent.keyDown(stops.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(stops[0]);
    fireEvent.keyDown(stops[0], { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(stops.at(-1));
    expect(below).not.toHaveBeenCalled();
    window.removeEventListener("keydown", below);
  });

  it("the studio is a modal dialog with its title and the step count read out", () => {
    open();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("heading", { name: "Crie seu Luve" })).toBeDefined();
    expect(document.querySelector(".lb-luve-step")!.getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector(".lb-luve-preview-art")!.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelector(".lb-luve-summary")!.getAttribute("aria-live")).toBe("polite");
  });
});

describe("the entry button", () => {
  it("opens the studio, 'use' hands over the recipe and closes it; closing otherwise changes nothing", () => {
    const onUse = vi.fn();
    render(<LuveEntry seedShape="pipo" useLabel="Usar em Vendas" onUse={onUse} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    fireEvent.click(screen.getByRole("button", { name: "Forma Faro" }));    // starts again from the seed, not from the last opening
    tab("Acessório");
    fireEvent.click(screen.getByRole("button", { name: "Usar em Vendas" }));
    expect(onUse).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^faro\.vinil\.nenhum\.[0-9a-f]{6}$/));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("in the Bot profile", () => {
  const bot: BotDetail = {
    name: "vendas", is_default: false,
    display: { label: "Vendas", role: "", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } },
    description: "", model: { provider: "openrouter", name: "claude-sonnet-5-5" }, status: "idle", soul: "", toolsets: [], mcp_servers: [],
  } as never;
  beforeEach(() => { resetCsrfToken(); setCustomFetchJSON(null); });

  it("create a Luve → use in the Bot → save: the PATCH carries kind luve with the canonical recipe, and nothing before the click", async () => {
    const bodies: unknown[] = [];
    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) return { csrf: "csrf", actor: "dashboard", auth_mode: "loopback" };
      if (url.includes("/bots/vendas/display") && init?.method === "PATCH") { bodies.push(JSON.parse(init.body as string)); return bot; }
      throw new Error(`Unexpected url: ${url}`);
    });
    render(<BotProfile botName="vendas" initialBot={bot} />);
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    fireEvent.click(screen.getByRole("button", { name: "Forma Brisa" }));
    tab("Material");
    fireEvent.click(screen.getByRole("button", { name: "Material metal" }));
    tab("Acessório");
    fireEvent.click(screen.getByRole("button", { name: "Usar em Vendas" }));
    expect(bodies).toHaveLength(0);                                          // using it fills the form; saving is its own click
    fireEvent.click(screen.getByText("Salvar alterações"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    const avatar = (bodies[0] as { avatar: { kind: string; value: string } }).avatar;
    expect(avatar.kind).toBe("luve");
    expect(avatar.value).toMatch(/^brisa\.metal\.nenhum\.[0-9a-f]{6}$/);
    expect(parseLuve(avatar.value)).not.toBeNull();
  });

  it("a Bot that already wears a Luve opens the studio on it", () => {
    render(<BotProfile botName="vendas" initialBot={{ ...bot, display: { ...bot.display, avatar: { kind: "luve", value: `rumo.laca.antena.${SWATCH(3)}` } } } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    expect(screen.getByRole("button", { name: "Forma Rumo" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("in the Create Bot dialog", () => {
  it("starts from the template's mascot; Esc closes only the studio, never the dialog under it; 'use' sends the Luve with the new Bot", async () => {
    resetCsrfToken();
    let body = "";
    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) return { csrf: "csrf", actor: "dashboard", auth_mode: "loopback" };
      if (url.endsWith("/bots") && init?.method === "POST") { body = init.body as string; return { bot: { name: "vendas", display: {} }, intro: { session_id: null } }; }
      return { state: "none", session_id: null, run_id: null, estimate_cents: 3, requires_confirm: true };
    });
    const onClose = vi.fn();
    render(<BotCreateModal isOpen onClose={onClose} />);
    fireEvent.click(screen.getByText("Vendas"));
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    expect(screen.getByRole("button", { name: "Forma Zuca" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Forma" }), { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Crie seu Luve" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    fireEvent.click(screen.getByRole("button", { name: "Forma Eco" }));
    tab("Acessório");
    fireEvent.click(screen.getByRole("button", { name: /^Usar/ }));
    expect(screen.queryByRole("heading", { name: "Crie seu Luve" })).toBeNull();
    fireEvent.click(screen.getByText("Avançar"));
    fireEvent.click(screen.getByText("Avançar"));
    fireEvent.click(screen.getByText("Criar Bot"));
    await waitFor(() => expect(body).not.toBe(""));
    const avatar = JSON.parse(body).display.avatar;
    expect(avatar.kind).toBe("luve");
    expect(parseLuve(avatar.value)?.shape).toBe("eco");
  });
});

// Seen in real Chrome (390 x 844 and an 800 px window): the sheet's body scrolls, so the actions and Voltar / Próximo / Usar fell below the
// edge and had to be scrolled to. jsdom measures no layout: the real check is evidence/luve-browser/studio.mjs (footer inside the viewport).
describe("the studio's bottom edge stays on screen", () => {
  it("the actions and Voltar / Próximo / Usar live in one dock, the last child of the scrolling body, stuck to its bottom", () => {
    open();
    const dock = document.querySelector(".lb-luve-dock")!;
    expect(dock.parentElement!.classList.contains("lb-dialog-body")).toBe(true);
    expect(dock.parentElement!.lastElementChild).toBe(dock);
    expect(dock.querySelector(".lb-luve-actions")).not.toBeNull();
    expect(dock.querySelector(".lb-dialog-footer")).not.toBeNull();
    const css = fs.readFileSync(path.resolve(process.cwd(), "dashboard/src/style.css"), "utf8").replace(/\s+/g, " ");
    const rule = css.match(/\.lb-luve-dock \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/position: sticky/);
    expect(rule).toMatch(/bottom: 0/);
    expect(rule).toMatch(/background: var\(--color-card\)/);   // content scrolling under it never shows through
  });
});
