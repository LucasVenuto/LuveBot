// tests/unit/conversation/files.test.tsx
// The file card (T12 download contract): a file the Bot cites gets "Baixar"; the download goes through the SDK's authedFetch
// (token in the header, never the query) and is saved with <a download> under the server's Content-Disposition name;
// 404 and 409 file_redacted are said in plain words. Also in the reply's "…" menu.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { citedFiles, workspacePath } from "@/components/conversation/FileCard";
import { initialTranscript } from "@/lib/stream/reducer";
import { setCustomFetchJSON, ApiError } from "@/api/client";
import type { Turn } from "@/components/chat/useConversation";

const BOT = { name: "vendas", label: "Vendas", color: "#60a5fa" };
const turn = (text: string, confirmed: Turn["confirmed"] = "completed"): Turn => ({
  id: 1, user: "Faz o relatório", stopping: false, errors: [], confirmed,
  state: { ...initialTranscript(), status: "completed" as any, items: [{ kind: "message", id: "m1", text }] as any },
});
type Hit = { url: string; init?: RequestInit };
let hits: Hit[];
let saved: Array<{ download: string; href: string }>;
function sdk(reply: (url: string) => Response) {
  (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async (url: string, init?: RequestInit) => { hits.push({ url, init }); return reply(url); } };
}
const err = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: "x" } }), { status });

beforeEach(() => {
  cleanup(); hits = []; saved = [];
  setCustomFetchJSON(async () => ({ rules: [] }));
  (URL as any).createObjectURL = vi.fn(() => "blob:luvebot/1");
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push({ download: this.download, href: this.href }); });
});
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); vi.restoreAllMocks(); });

describe("which paths get a card", () => {
  it("keeps workspace-relative files of the types the server serves; drops hidden, parent, home, links and other folders", () => {
    expect(workspacePath("relatorios/q3.pdf")).toBe("relatorios/q3.pdf");
    expect(workspacePath("./notas.md")).toBe("notas.md");
    expect(workspacePath("/root/.hermes/profiles/vendas/workspace/out/plan.xlsx")).toBe("out/plan.xlsx");
    for (const bad of ["/etc/passwd.txt", "../segredo.md", ".env.md", "a/.git/x.json", "~/x.md", "script.py", "a//b.md", "C:\\x.md"]) expect(workspacePath(bad)).toBeNull();
    expect(citedFiles("Salvei em `relatório final.md` e em out/vendas.csv. Veja https://x.com/workspace/a.pdf e config.py.")).toEqual(["relatório final.md", "out/vendas.csv"]);
    expect(citedFiles("a.md b.md c.md d.md a.md")).toEqual(["a.md", "b.md", "c.md"]);   // at most 3, no repeats
  });
});

describe("the file card in the conversation", () => {
  it("downloads through authedFetch with the path in the query and saves it under the server's name", async () => {
    sdk(() => new Response(new Blob(["oi"]), { status: 200, headers: { "Content-Disposition": "attachment; filename*=UTF-8''relat%C3%B3rio%20Q3.md" } }));
    render(<Conversation bot={BOT} initialTurns={[turn("Pronto, salvei em `relatorios/relatório.md`.")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Baixar relatório.md" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(hits[0].url).toBe("/api/plugins/luvebot/bots/vendas/files/download?path=relatorios%2Frelat%C3%B3rio.md");
    expect(hits[0].url).not.toMatch(/token/i);
    expect(saved[0]).toEqual({ download: "relatório Q3.md", href: "blob:luvebot/1" });   // the server's name, not the path's
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("404 says the file is not available and 409 file_redacted says it was not delivered, in plain words", async () => {
    sdk((url) => (url.includes("sumiu") ? err(404, "file_not_found") : err(409, "file_redacted")));
    render(<Conversation bot={BOT} initialTurns={[turn("Veja sumiu.md e chaves.txt")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Baixar sumiu.md" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Arquivo não disponível: ele não está na pasta do Bot.");
    fireEvent.click(screen.getByRole("button", { name: "Baixar chaves.txt" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    expect(screen.getAllByRole("alert")[1].textContent).toBe("Não foi entregue: o arquivo contém algo que parece um segredo.");
    expect(document.body.textContent).not.toContain("file_redacted");
    expect(saved).toHaveLength(0);
  });

  it("the other refusals and a lost connection are said in plain words too", async () => {
    for (const [reply, said] of [
      [() => err(409, "workspace_unavailable"), "A pasta de trabalho deste Bot não está disponível."],
      [() => err(413, "too_large"), "O arquivo passa de 25 MiB e não pode ser baixado por aqui."],
      [() => err(404, "bot_not_found"), "Arquivo não disponível: ele não está na pasta do Bot."],
      [() => { throw new TypeError("Failed to fetch"); }, "Sem conexão com o LuveBot. Tente de novo."],
    ] as Array<[() => Response, string]>) {
      sdk(reply);
      const r = render(<Conversation bot={BOT} initialTurns={[turn("Veja notas.md")]} />);
      fireEvent.click(screen.getByRole("button", { name: "Baixar notas.md" }));
      expect((await screen.findByRole("alert")).textContent).toBe(said);
      r.unmount();
    }
  });

  it("is also in the reply's '…' menu, and a reply still being written gets no card", async () => {
    sdk(() => new Response(new Blob(["x"]), { status: 200 }));
    const { unmount } = render(<Conversation bot={BOT} initialTurns={[{ ...turn("Gerei out/plan.xlsx"), confirmed: undefined }]} />);
    expect(screen.queryByRole("button", { name: "Baixar plan.xlsx" })).toBeNull();
    unmount();
    render(<Conversation bot={BOT} initialTurns={[turn("Gerei out/plan.xlsx")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mais ações desta mensagem" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Baixar plan.xlsx" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].download).toBe("plan.xlsx");   // no Content-Disposition: the path's name
    expect(hits[0].url).toContain("path=out%2Fplan.xlsx");
  });
});

describe("the Arquivos tab (the CEO: a file created, and the tab said nothing was observed)", () => {
  it("lists the files the conversation delivered, with the same download, even when no file tool ran", async () => {
    sdk(() => new Response(new Blob(["# teste"]), { status: 200, headers: { "Content-Disposition": "attachment; filename=teste-edicao.md" } }));
    render(<Conversation bot={BOT} initialTurns={[turn("Criei o arquivo `teste-edicao.md` no workspace.")]} />);
    const panel = within(screen.getByLabelText("Painel de trabalho"));
    fireEvent.click(panel.getByRole("tab", { name: "Arquivos" }));
    expect(panel.queryByText(/Nenhuma ferramenta de arquivo/)).toBeNull();
    const delivered = within(panel.getByRole("region", { name: "Entregues na conversa" }));
    fireEvent.click(delivered.getByRole("button", { name: "Baixar teste-edicao.md" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(hits[0].url).toBe("/api/plugins/luvebot/bots/vendas/files/download?path=teste-edicao.md");
  });

  it("a reply still being written delivers nothing yet, and with nothing at all the tab stays honestly empty", () => {
    render(<Conversation bot={BOT} initialTurns={[{ ...turn("Vou criar `rascunho.md`."), confirmed: undefined }]} />);
    const panel = within(screen.getByLabelText("Painel de trabalho"));
    fireEvent.click(panel.getByRole("tab", { name: "Arquivos" }));
    expect(panel.getByText(/Nenhuma ferramenta de arquivo/)).toBeTruthy();
    expect(panel.queryByRole("region", { name: "Entregues na conversa" })).toBeNull();
  });
});

describe("a Markdown file can be edited (the CEO could not find where)", () => {
  // the test DOM's Blob has no text() (every current browser has it): filled in here, in the test only
  if (typeof (Blob.prototype as any).text !== "function") {
    (Blob.prototype as any).text = function (this: Blob) {
      return new Promise<string>((done) => { const r = new FileReader(); r.onload = () => done(String(r.result)); r.readAsText(this); });
    };
  }
  type Call = { method: string; url: string; body?: any; csrf: string | null };
  function backend(create: (body: any) => unknown) {
    const calls: Call[] = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
      if (method === "POST" && url.endsWith("/bots/vendas/pages")) return create(JSON.parse(String(init!.body)));
      return { rules: [] };
    });
    return calls;
  }
  const md = () => sdk(() => new Response("# Teste\n\nTexto do Bot.", { status: 200, headers: { "Content-Disposition": "attachment; filename=teste-edicao.md" } }));

  it("a page's own file (pages/<slug>.md) has 'Editar', which opens that page", () => {
    const onOpenPage = vi.fn();
    render(<Conversation bot={BOT} initialTurns={[turn("Atualizei `pages/plano-q4.md`.")]} onOpenPage={onOpenPage} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Editar plano-q4.md" })[0]);
    expect(onOpenPage).toHaveBeenCalledWith("plano-q4");
    expect(screen.queryByText(/cópia em Páginas/)).toBeNull();
  });

  it("any other .md: 'Abrir no editor' copies it into Páginas by the Pages writer and opens the copy; the card says the Bot keeps the original", async () => {
    md();
    const calls = backend(() => ({ page: { slug: "teste-edicao", title: "teste-edicao", rev: 1, sha256: "s" } }));
    const onOpenPage = vi.fn();
    render(<Conversation bot={BOT} initialTurns={[turn("Criei o arquivo `teste-edicao.md` no workspace.")]} onOpenPage={onOpenPage} />);
    expect(screen.getAllByText(/O arquivo original fica no workspace do Bot, e o Bot continua mexendo nele, não na cópia\./).length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);              // nothing happens before the click
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir teste-edicao.md no editor" })[0]);
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith("teste-edicao"));
    expect(hits[0].url).toBe("/api/plugins/luvebot/bots/vendas/files/download?path=teste-edicao.md");
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/plugins/luvebot/bots/vendas/pages");
    expect(post.body).toEqual({ title: "teste-edicao", content: "# Teste\n\nTexto do Bot." });
    expect(post.csrf).toBe("csrf-1");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a page with that name already exists: nothing is overwritten, and it offers to open the existing page", async () => {
    md();
    const calls = backend(() => { throw new ApiError({ code: "page_exists", message: "x", status: 409, details: { slug: "teste-edicao" } }); });
    const onOpenPage = vi.fn();
    render(<Conversation bot={BOT} initialTurns={[turn("Criei `teste-edicao.md`.")]} onOpenPage={onOpenPage} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir teste-edicao.md no editor" })[0]);
    expect((await screen.findAllByText(/Já existe uma página com esse nome \(teste-edicao\); nada foi sobrescrito\./)).length).toBeGreaterThan(0);
    expect(onOpenPage).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir a página existente" })[0]);
    expect(onOpenPage).toHaveBeenCalledWith("teste-edicao");
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  });

  it("Pages not set up for the Bot is said in words; files that are not Markdown, or a screen with no Pages, get no edit button", async () => {
    md();
    backend(() => { throw new ApiError({ code: "pages_unavailable", message: "x", status: 409, details: { reason: "no_workspace" } }); });
    const r = render(<Conversation bot={BOT} initialTurns={[turn("Criei `teste-edicao.md` e `relatorio.pdf`.")]} onOpenPage={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir teste-edicao.md no editor" })[0]);
    expect((await screen.findAllByText(/As Páginas deste Bot ainda não estão disponíveis/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /relatorio\.pdf no editor|Editar relatorio\.pdf/ })).toBeNull();
    r.unmount();
    render(<Conversation bot={BOT} initialTurns={[turn("Criei `teste-edicao.md`.")]} />);
    expect(screen.queryByRole("button", { name: /no editor|^Editar/ })).toBeNull();
  });
});
