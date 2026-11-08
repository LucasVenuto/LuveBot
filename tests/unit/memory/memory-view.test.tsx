// tests/unit/memory/memory-view.test.tsx
// Contract v0.8 §1: what a Bot remembers, item by item. Hermes's own MemoryStore does every change in the Bot's profile; the screen lists
// the Bot's notes and the person's profile, adds / edits / removes one item or clears all, says in words what went wrong, and never shows a
// secret (redacted items can only be removed). Adding and editing need a login; removing and clearing do not. Items are plain text.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryView, memoryError } from "@/components/memory/MemoryView";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";

type Entry = { id: string; text: string; redacted: boolean };
type World = { memory: Entry[]; user: Entry[]; userEnabled: boolean; provider: string | null; auth: string; used?: number;
  fail?: (m: string, url: string, body: any) => ApiError | null; clear?: { removed: number; skipped: number }; calls: Array<{ method: string; url: string; body: any; csrf: string | null }> };
let w: World;
const view = () => ({ targets: {
  memory: { enabled: true, limit: 2200, used: w.used ?? 340, entries: w.memory },
  user: { enabled: w.userEnabled, limit: 1375, used: 0, entries: w.userEnabled ? w.user : [] } }, provider: w.provider, notice: "applies_to_new_conversations" });
let seq = 0;
function backend() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: w.auth };
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    w.calls.push({ method, url: url.replace("/api/plugins/luvebot", ""), body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (method === "GET" && url.endsWith("/memory")) return view();
    const err = w.fail?.(method, url, body); if (err) throw err;
    const m = url.match(/\/memory\/(memory|user)(?:\/([^/?]+))?(\?confirm=all)?$/);
    if (!m) throw new Error("unexpected " + method + " " + url);
    const list = w[m[1] as "memory" | "user"];
    if (method === "POST") { const e = { id: `n${++seq}`, text: body.text, redacted: false }; list.push(e); return { id: e.id }; }
    if (method === "PATCH") { const e = list.find((x) => x.id === m[2])!; e.text = body.text; return { id: e.id }; }
    if (method === "DELETE" && m[3]) { const r = w.clear ?? { removed: list.length, skipped: 0 }; list.splice(0, r.removed); return r; }
    if (method === "DELETE") { list.splice(list.findIndex((x) => x.id === m[2]), 1); return { removed: 1 }; }
    throw new Error("unexpected " + method + " " + url);
  });
}
const e = (id: string, text: string, redacted = false): Entry => ({ id, text, redacted });
const open = async () => { render(<MemoryView botName="vendas" botLabel="Vendas" />); await screen.findByTestId("memory-memory"); };
const writes = () => w.calls.filter((c) => c.method !== "GET");

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); seq = 0;
  w = { memory: [e("a1", "Prefere respostas curtas."), e("a2", "Cliente <b>Acme</b> paga em 30 dias."), e("a3", "chave sk-…oculta", true)], user: [e("u1", "Lucas, fala português.")], userEnabled: true, provider: null, auth: "gated", calls: [] };
  backend();
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("what the Bot remembers", () => {
  it("lists the notes and the profile with their use of the limit; an item's text is plain text; a secret is shown as hidden; an off memory and an external provider are said", async () => {
    w.userEnabled = false; w.provider = "honcho";
    await open();
    expect(screen.getByText("Memória de Vendas")).toBeTruthy();
    expect(screen.getByTestId("memory-used-memory").textContent).toBe("340 de 2.200 caracteres usados");
    const items = within(screen.getByTestId("memory-memory")).getAllByTestId("memory-item");
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toContain("Cliente <b>Acme</b> paga em 30 dias.");
    expect(items[1].querySelector("b")).toBeNull();                                            // text, never markup
    expect(within(items[2]).getByTestId("memory-hidden").textContent).toContain("contém texto oculto");
    expect((within(items[2]).getByRole("button", { name: /^Editar/ }) as HTMLButtonElement).disabled).toBe(true);   // nothing to edit over a secret
    expect((within(items[2]).getByRole("button", { name: /^Remover/ }) as HTMLButtonElement).disabled).toBe(false);  // but it can go
    expect(screen.getByTestId("memory-off-user").textContent).toBe("Esta memória está desligada para este Bot no Hermes.");
    expect(screen.getByTestId("memory-provider").textContent).toContain("Memória externa: honcho, gerenciada no Hermes");
    expect(screen.getByText(/vale para as conversas novas/)).toBeTruthy();
  });

  it("adding: the text (trimmed) goes to the chosen memory with the CSRF; the list is read again and the person is told it counts in new conversations", async () => {
    await open();
    const notes = within(screen.getByTestId("memory-memory"));
    fireEvent.click(notes.getByRole("button", { name: "Adicionar" }));
    const field = screen.getByLabelText("Novo item") as HTMLTextAreaElement;
    const save = notes.getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);                                                          // nothing to save yet
    fireEvent.change(field, { target: { value: "  Não ligar às sextas.  " } });
    expect(notes.getByText("24 de 2.000 caracteres")).toBeTruthy();                           // the raw field, spaces included
    fireEvent.click(save);
    await screen.findByText("Salvo. Vale para as conversas novas.");
    expect(writes()).toEqual([{ method: "POST", url: "/bots/vendas/memory/memory", body: { text: "Não ligar às sextas." }, csrf: "csrf-1" }]);
    await screen.findByText("Não ligar às sextas.");                                           // the server's list
    expect(screen.queryByLabelText("Novo item")).toBeNull();
  });

  it("editing is pinned to the item (its id in the URL; here the second one, not the first) and only enabled for a real change; an item that moved meanwhile says so and the list is read again", async () => {
    await open();
    const second = () => within(screen.getByTestId("memory-memory")).getAllByTestId("memory-item")[1];
    fireEvent.click(within(second()).getByRole("button", { name: /^Editar/ }));
    const field = within(second()).getByLabelText("Editar") as HTMLTextAreaElement;
    expect((within(second()).getByRole("button", { name: "Salvar" }) as HTMLButtonElement).disabled).toBe(true);   // unchanged
    fireEvent.change(field, { target: { value: "Cliente Acme paga em 45 dias." } });
    w.fail = (m) => (m === "PATCH" ? new ApiError({ code: "memory_changed", message: "x", status: 409 }) : null);
    fireEvent.click(within(second()).getByRole("button", { name: "Salvar" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Este item mudou enquanto você olhava. Recarreguei a lista; tente de novo.");
    expect(alert.textContent).not.toContain("memory_changed ");
    expect(writes()[0]).toEqual({ method: "PATCH", url: "/bots/vendas/memory/memory/a2", body: { text: "Cliente Acme paga em 45 dias." }, csrf: "csrf-1" });
    await waitFor(() => expect(screen.queryByLabelText("Editar")).toBeNull());                  // the edit closed, the list is the server's again
    w.fail = undefined;
    fireEvent.click(within(second()).getByRole("button", { name: /^Editar/ }));
    fireEvent.change(within(second()).getByLabelText("Editar"), { target: { value: "Cliente Acme paga em 45 dias." } });
    fireEvent.click(within(second()).getByRole("button", { name: "Salvar" }));
    await screen.findByText("Salvo. Vale para as conversas novas.");
    await screen.findByText("Cliente Acme paga em 45 dias.");
    expect(writes().map((c) => c.url)).toEqual(["/bots/vendas/memory/memory/a2", "/bots/vendas/memory/memory/a2"]);
  });

  it("Hermes's refusals are said in words (the screen's own, never the server's English or the code): it looks like an instruction, the memory is full, a secret cannot be edited, it was turned off, the item is gone", () => {
    const words: Record<string, string> = { memErrRefused: "recusou", memErrFull: "cheia", memErrRedacted: "oculto", memErrDisabled: "desligada", memErrNotFound: "sumiu", memErrGeneric: "genérico" };
    const say = (c: string) => (memoryError(new ApiError({ code: c, message: "English from the server", status: 422 }), ((k: string) => words[k] ?? k) as any) as any).text;
    expect(say("memory_refused")).toBe("recusou");
    expect(say("memory_full")).toBe("cheia");
    expect(say("memory_redacted")).toBe("oculto");
    expect(say("memory_disabled")).toBe("desligada");
    expect(say("memory_entry_not_found")).toBe("sumiu");
    expect(say("who_knows")).toBe("genérico");
  });

  it("removing one item takes two clicks ('Remover' then 'Remover mesmo'); 'Cancelar' keeps it; only then is the DELETE sent", async () => {
    await open();
    const row = () => within(screen.getByTestId("memory-memory")).getAllByTestId("memory-item")[0];
    fireEvent.click(within(row()).getByRole("button", { name: /^Remover/ }));
    fireEvent.click(within(row()).getByRole("button", { name: "Cancelar" }));
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(row()).getByRole("button", { name: /^Remover/ }));
    fireEvent.click(within(row()).getByRole("button", { name: "Remover mesmo" }));
    await screen.findByText("Removido.");
    expect(writes()).toEqual([{ method: "DELETE", url: "/bots/vendas/memory/memory/a1", body: null, csrf: "csrf-1" }]);
    await waitFor(() => expect(screen.queryByText("Prefere respostas curtas.")).toBeNull());
  });

  it("clear all asks first (with the count), then sends confirm=all; items that changed meanwhile and stayed are said", async () => {
    w.clear = { removed: 2, skipped: 1 };
    await open();
    const notes = within(screen.getByTestId("memory-memory"));
    fireEvent.click(notes.getByRole("button", { name: "Limpar tudo" }));
    expect(screen.getByTestId("memory-clear-confirm-memory").textContent).toContain("Apagar todos os 3 itens? Não dá para desfazer.");
    expect(writes()).toHaveLength(0);
    fireEvent.click(within(screen.getByTestId("memory-clear-confirm-memory")).getByRole("button", { name: "Apagar tudo" }));
    await screen.findByText("2 apagados; 1 mudaram enquanto isso e ficaram. Recarreguei a lista.");
    expect(writes()).toEqual([{ method: "DELETE", url: "/bots/vendas/memory/memory?confirm=all", body: null, csrf: "csrf-1" }]);
  });

  it("without a login (loopback): adding and editing are off with the reason, removing still works", async () => {
    w.auth = "loopback";
    await open();
    await screen.findByTestId("memory-no-login");
    const notes = within(screen.getByTestId("memory-memory"));
    expect((notes.getByRole("button", { name: "Adicionar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((notes.getAllByRole("button", { name: /^Editar/ })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(notes.getAllByRole("button", { name: /^Remover/ })[0]);
    fireEvent.click(notes.getByRole("button", { name: "Remover mesmo" }));
    await screen.findByText("Removido.");
    expect(writes().map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("with the deployment token (a machine) adding and editing are off too, with the credential's sentence and never loopback's; removing still works", async () => {
    w.auth = "deployment";
    await open();
    const note = await screen.findByTestId("memory-no-login");
    expect(note.textContent).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(note.textContent).not.toMatch(/painel do Hermes|loopback/);
    const notes = within(screen.getByTestId("memory-memory"));
    const add = notes.getByRole("button", { name: "Adicionar" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.getAttribute("title")).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect((notes.getAllByRole("button", { name: /^Editar/ })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("a mode nobody knows, or none, is not a person: adding is off (only `gated` is)", async () => {
    for (const auth of ["", "service", "GATED"]) {
      cleanup(); w.auth = auth; backend();
      await open();
      await screen.findByTestId("memory-no-login");
      expect((within(screen.getByTestId("memory-memory")).getByRole("button", { name: "Adicionar" }) as HTMLButtonElement).disabled, JSON.stringify(auth)).toBe(true);
    }
  });

  it("a server that refuses the write in loopback is said with the general words, never the code", async () => {
    w.fail = (m) => (m === "POST" ? new ApiError({ code: "loopback_not_human", message: "x", status: 403 }) : null);
    await open();
    fireEvent.click(within(screen.getByTestId("memory-memory")).getByRole("button", { name: "Adicionar" }));
    fireEvent.change(screen.getByLabelText("Novo item"), { target: { value: "algo" } });
    fireEvent.click(within(screen.getByTestId("memory-memory")).getByRole("button", { name: "Salvar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Neste modo (loopback, sem login)");
  });

  it("export hands the redacted Markdown to the browser as a file named after the Bot", async () => {
    const saved: Array<{ name: string; type: string }> = [];
    (URL as any).createObjectURL = vi.fn((b: Blob) => { saved.push({ name: "", type: b.type }); return "blob:x/1"; });
    (URL as any).revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved[saved.length - 1].name = this.download; });
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async (url: string) => { w.calls.push({ method: "GET", url: url.replace("/api/plugins/luvebot", ""), body: null, csrf: null }); return new Response("# Memória de vendas", { status: 200, headers: { "content-type": "text/markdown" } }); } };
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Exportar (Markdown)" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].name).toBe("memoria-vendas.md");
    expect(w.calls.some((c) => c.url.endsWith("/bots/vendas/memory/export?profile=current") || c.url.endsWith("/bots/vendas/memory/export"))).toBe(true);
    click.mockRestore(); delete (window as any).__HERMES_PLUGIN_SDK__;
  });

  it("in English; and the Bot's profile lists it as 'Memória deste Bot'", async () => {
    setLuveLocale("en");
    await open();
    expect(screen.getByText("Vendas's memory")).toBeTruthy();
    expect(screen.getByText("The Bot's notes")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(2);        // one per memory
    cleanup(); setLuveLocale("pt");
    const onOpenPage = vi.fn();
    render(<AgentPanel bot={{ name: "vendas", is_default: false, description: "", status: "idle", display: { label: "Vendas", role: "", color: "#60a5fa", avatar: { kind: "emoji", value: "🐳" } } } as any} onOpenPage={onOpenPage} />);
    fireEvent.click(await screen.findByRole("button", { name: "Memória deste Bot" }));
    expect(onOpenPage).toHaveBeenCalledWith("memory");
  });
});

describe("two equal items (the server names an item by the sha of its text, so they share an id)", () => {
  beforeEach(() => { w.memory = [e("d1", "Prefere respostas curtas."), e("d1", "Prefere respostas curtas."), e("a2", "Outra nota.")]; });
  const items = () => within(screen.getByTestId("memory-memory")).getAllByTestId("memory-item");

  it("both are listed, with no repeated React key (red team, Info of 2026-10-29)", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    await open();
    expect(items()).toHaveLength(3);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/same key|unique "key"/i);
    warn.mockRestore();
  });

  it("editing the second opens only the second, with its own field id, and the call still names the item by the server's id", async () => {
    await open();
    fireEvent.click(within(items()[1]).getByRole("button", { name: /^Editar/ }));
    expect(screen.getAllByLabelText("Editar")).toHaveLength(1);
    expect(within(items()[1]).getByLabelText("Editar")).toBeTruthy();
    const ids = [...document.querySelectorAll("[id^='mem-edit-']")].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    fireEvent.change(within(items()[1]).getByLabelText("Editar"), { target: { value: "Prefere respostas longas." } });
    fireEvent.click(within(items()[1]).getByRole("button", { name: "Salvar" }));
    await screen.findByText("Salvo. Vale para as conversas novas.");
    expect(writes()[0]).toMatchObject({ method: "PATCH", url: "/bots/vendas/memory/memory/d1", body: { text: "Prefere respostas longas." } });
  });

  it("asking to remove the second asks only about the second", async () => {
    await open();
    fireEvent.click(within(items()[1]).getByRole("button", { name: /^Remover/ }));
    expect(within(items()[1]).getByRole("button", { name: /Confirmar|Remover mesmo|Sim/i })).toBeTruthy();
    expect(within(items()[0]).queryByRole("button", { name: /Confirmar|Remover mesmo|Sim/i })).toBeNull();
  });
});
