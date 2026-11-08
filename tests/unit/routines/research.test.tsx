// tests/unit/routines/research.test.tsx
// Pesquisa proativa em Rotinas (contract v0.8 §3): "Nova pesquisa" asks topic, sources and the shape of the summary and sends ONLY
// that (the backend forces web + no_mcp, deliver local and the fixed last line); it is created paused. The seal "só leitura" is
// drawn from the backend's `readonly_seal` (the LIVE job, invariant 8): `real` is calm, `broken` says in words that the routine can
// now do more than read, and the UI never infers the seal from the template. Also: the plain "Nova rotina" sends `schedule` as text.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RoutinesView } from "@/components/routines";
import { ReadonlySeal, researchPrompt } from "@/components/routines/ResearchRoutine";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, Routine } from "@/api/types";

const bot = (name: string, label: string): Bot => ({
  name, is_default: false, description: "", model: { provider: "x", name: "y" }, status: "idle",
  display: { label, role: "", color: "#3b82f6", avatar: { kind: "mascot", value: "luvi" } },
} as Bot);
const BOTS = [bot("pesquisa", "Pesquisa"), bot("vendas", "Vendas")];
const routine = (id: string, over: Partial<Routine> = {}): Routine => ({
  id, bot: "pesquisa", name: `Rotina ${id}`, schedule: { expr: "0 8 * * *" }, state: "scheduled", enabled: true, ...over,
} as Routine);

let calls: { url: string; method: string; body?: any; csrf?: string | null }[], list: Routine[], failPost: boolean;

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-r");
  calls = []; list = []; failPost = false;
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/routines") && method === "POST") {
      if (failPost) throw new ApiError({ code: "invalid_field", message: "bad", status: 422 } as never);
      return { routine: routine("novo", { name: body.name, state: "paused", enabled: false }) };
    }
    if (url.includes("/routines") && method === "GET") return { routines: list };
    return {};
  });
});
afterEach(() => cleanup());

const view = () => render(<RoutinesView bots={BOTS} initialRoutines={list} />);
const posts = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/routines"));
const fill = (topic: string, sources = "", deliver = "") => {
  fireEvent.change(screen.getByTestId("input-research-topic"), { target: { value: topic } });
  fireEvent.change(screen.getByTestId("input-research-sources"), { target: { value: sources } });
  fireEvent.change(screen.getByTestId("input-research-deliver"), { target: { value: deliver } });
};

describe("o formulário da pesquisa", () => {
  it("opens from 'Nova pesquisa', says it only reads and what is always added, and needs a topic to save", () => {
    view();
    expect(screen.queryByTestId("modal-research")).toBeNull();
    fireEvent.click(screen.getByTestId("btn-new-research"));
    expect(screen.getByTestId("research-readonly").textContent).toContain("A pesquisa só lê");
    expect(screen.getByTestId("modal-research").textContent).toContain("Sempre no fim da instrução: “Só pesquise e resuma; não execute ações.”");
    expect(screen.getByTestId("modal-research").textContent).toContain("nasce pausada");
    expect((screen.getByTestId("btn-save-research") as HTMLButtonElement).disabled).toBe(true);
    fill("   ");
    expect((screen.getByTestId("btn-save-research") as HTMLButtonElement).disabled).toBe(true);
    fill("concorrentes de logística");
    expect((screen.getByTestId("btn-save-research") as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the research and NOTHING about tools or delivery (the backend forces them), as text, with CSRF; then closes and reloads, saying it is paused", async () => {
    view();
    fireEvent.click(screen.getByTestId("btn-new-research"));
    fireEvent.change(screen.getByTestId("input-research-bot"), { target: { value: "vendas" } });
    fill("concorrentes de logística", "https://a.example, Valor Econômico", "resumo de 5 linhas com links");
    fireEvent.change(screen.getByTestId("input-research-schedule"), { target: { value: "every 1h" } });
    const before = calls.filter((c) => c.method === "GET").length;
    fireEvent.click(screen.getByTestId("btn-save-research"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const sent = posts()[0];
    expect(Object.keys(sent.body).sort()).toEqual(["bot", "name", "prompt", "schedule", "template"]);
    expect(sent.body).toEqual({
      bot: "vendas", name: "Pesquisa: concorrentes de logística", schedule: "every 1h", template: "research",
      prompt: "Pesquise sobre: concorrentes de logística\nFontes: https://a.example, Valor Econômico\nO que entregar: resumo de 5 linhas com links",
    });
    expect(sent.csrf).toBe("csrf-r");
    await waitFor(() => expect(screen.queryByTestId("modal-research")).toBeNull());
    expect(screen.getByText("Pesquisa criada, pausada. Retome quando quiser que ela comece.")).toBeDefined();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(before));
  });

  it("the instruction leaves out the optional lines that were left empty", () => {
    expect(researchPrompt({ topic: " preços de frete ", sources: "", deliver: "  " })).toBe("Pesquise sobre: preços de frete");
    expect(researchPrompt({ topic: "x", sources: "a", deliver: "" })).toBe("Pesquise sobre: x\nFontes: a");
  });

  it("a refusal stays on the form, in words, and the button is back", async () => {
    failPost = true;
    view();
    fireEvent.click(screen.getByTestId("btn-new-research"));
    fill("tema");
    fireEvent.click(screen.getByTestId("btn-save-research"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toBe("");
    expect(screen.getByTestId("modal-research")).toBeDefined();
    expect((screen.getByTestId("btn-save-research") as HTMLButtonElement).disabled).toBe(false);
  });

  it("Esc closes it without creating anything", () => {
    view();
    fireEvent.click(screen.getByTestId("btn-new-research"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("modal-research")).toBeNull();
    expect(posts()).toHaveLength(0);
  });
});

describe("o selo 'só leitura' (invariante 8)", () => {
  it("real is calm, broken says in words that the routine can now do more than read, a plain routine has none", () => {
    list = [
      routine("a", { template: "research", readonly_seal: "real" }),
      routine("b", { template: "research", readonly_seal: "broken" }),
      routine("c"),
    ];
    view();
    expect(screen.getByTestId("seal-a").textContent).toContain("Pesquisa · só leitura");
    expect(screen.getByTestId("seal-a").getAttribute("data-seal")).toBe("real");
    expect(screen.queryByTestId("seal-note-a")).toBeNull();
    expect(screen.getByTestId("seal-b").textContent).toContain("Pesquisa · pode mais que ler");
    expect(screen.getByTestId("seal-b").getAttribute("data-seal")).toBe("broken");
    expect(screen.getByTestId("seal-note-b").textContent).toContain("A rotina agora pode mais do que ler");
    expect(screen.queryByTestId("seal-c")).toBeNull();
  });

  it("is drawn from `readonly_seal` alone: the template without a seal from the backend shows no seal", () => {
    list = [routine("a", { template: "research" })];
    view();
    expect(screen.queryByTestId("seal-a")).toBeNull();
    const { container } = render(<ReadonlySeal routine={{ id: "z", readonly_seal: null }} />);
    expect(container.textContent).toBe("");
  });

  it("speaks English", () => {
    setLuveLocale("en");
    render(<ReadonlySeal routine={{ id: "e", readonly_seal: "broken" }} />);
    expect(screen.getByTestId("seal-e").textContent).toContain("Research · can do more than read");
  });
});

describe("a rotina comum", () => {
  it("'Nova rotina' sends the schedule as text, which is what the backend accepts (it refuses an object)", async () => {
    view();
    fireEvent.click(screen.getByTestId("btn-new-routine"));
    fireEvent.change(screen.getByTestId("input-routine-name"), { target: { value: "Diária" } });
    fireEvent.click(screen.getByTestId("btn-save-routine"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.schedule).toBe("0 8 * * 1-5");
    expect(posts()[0].body.template).toBeUndefined();
  });
});
