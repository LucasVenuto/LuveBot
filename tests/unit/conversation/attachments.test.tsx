// tests/unit/conversation/attachments.test.tsx
// Attachments in the chat (T14, ADR-005): the clip, drag and drop and a pasted image add a chip (name, size, remove); a
// short notice says the content goes to the model provider; on "Enviar" each file goes to POST /bots/{bot}/attachments
// (multipart, CSRF) and its reference joins the message; refusals in words (413, 415, 409 workspace with "Criar a pasta").
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within, act } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { precheck, formatSize, IMAGE_MAX, MAX_FILES } from "@/components/conversation/Attachments";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";

const BOT = { name: "vendas", label: "Vendas" };
type Up = { name: string; csrf: string | null; field: string[] };
let uploads: Up[];
let runs: Array<{ input: string }>;
let workspacePosts: Array<string | null>;
let reply: (file: File, n: number) => Response;

const ok = (file: File) => new Response(JSON.stringify({ attachment: { path: `attachments/u-${file.name}`, name: file.name, type: file.type || "text/plain", size: file.size,
  reference: `[Anexo: attachments/u-${file.name}, ${file.type || "text/plain"}, 1 KB]` } }), { status: 201 });
const refuse = (status: number, code: string, details?: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: { code, message: "Some English text.", details } }), { status });
const file = (name: string, type = "", size?: number) => {
  const f = new File(["hello"], name, { type });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
};

beforeEach(() => {
  cleanup(); resetCsrfToken(); uploads = []; runs = []; workspacePosts = [];
  reply = (f) => ok(f);
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/sessions")) return { session: { id: "s1" } };
    if (method === "POST" && url.endsWith("/runs")) { runs.push(JSON.parse(String(init?.body))); return { run: { id: "run_r1", status: "started", session_id: "s1" } }; }
    if (method === "POST" && url.endsWith("/bots/vendas/workspace")) { workspacePosts.push(new Headers(init?.headers).get("X-LuveBot-CSRF")); return { workspace: { state: "empty" } }; }
    return { run: { id: "run_r1", status: "started" } };
  });
  (window as any).__HERMES_PLUGIN_SDK__ = {
    authedFetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe("/api/plugins/luvebot/bots/vendas/attachments");
      const body = init?.body as FormData;
      const f = body.get("file") as File;
      uploads.push({ name: f.name, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF"), field: [...body.keys()] });
      return reply(f, uploads.length);
    },
  };
});
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); vi.restoreAllMocks(); });

const stream = async () => new Response(new ReadableStream(), { status: 200, headers: { "content-type": "text/event-stream" } });
const open = () => render(<Conversation bot={BOT} fetcher={stream} />);
const input = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const pick = (...files: File[]) => { Object.defineProperty(input(), "files", { value: files, configurable: true }); fireEvent.change(input()); };
const chips = () => within(screen.getByRole("list", { name: "Anexos desta mensagem" })).getAllByRole("listitem");
const sendBtn = () => screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement;

describe("what may be attached, said at once", () => {
  it("by kind and size, like the server (which still decides by the bytes)", () => {
    expect(precheck(file("foto.png", "image/png"))).toBeNull();
    expect(precheck(file("relatório.pdf", "application/pdf"))).toBeNull();
    expect(precheck(file("dados.csv"))).toBeNull();
    for (const n of ["logo.svg", "pagina.html", "setup.exe", "foto.bmp", "semtipo"]) expect(precheck(file(n)), n).toBe("type");
    expect(precheck(file("image", "image/png"))).toBeNull();                      // a pasted image without an extension
    expect(precheck(file("foto.png", "image/png", IMAGE_MAX + 1))).toBe("size");
    expect(precheck(file("doc.pdf", "application/pdf", IMAGE_MAX + 1))).toBeNull(); // documents go to 20 MB
    expect([formatSize(500), formatSize(5 * 1024), formatSize(3.5 * 1024 * 1024)]).toEqual(["1 KB", "5 KB", "3.5 MB"]);
  });
});

describe("attachments in the composer", () => {
  it("the clip opens the file picker (keyboard reachable), a chip shows name and size with 'Remover', and the provider notice", async () => {
    open();
    const clip = screen.getByRole("button", { name: "Anexar arquivo" });
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    clip.focus();
    expect(document.activeElement).toBe(clip);
    fireEvent.click(clip);
    expect(click).toHaveBeenCalled();
    pick(file("proposta.pdf", "application/pdf"));
    expect(chips()).toHaveLength(1);
    expect(chips()[0].textContent).toContain("proposta.pdf");
    expect(chips()[0].textContent).toContain("1 KB");
    expect(screen.getByText("O conteúdo dos anexos vai para o provedor do modelo deste Bot.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remover proposta.pdf" }));
    expect(screen.queryByRole("list", { name: "Anexos desta mensagem" })).toBeNull();
    expect(uploads).toHaveLength(0);                                               // nothing leaves before "Enviar"
  });

  it("on Enviar: uploads (multipart field 'file', CSRF), then the message carries the text and the reference", async () => {
    open();
    pick(file("proposta.pdf", "application/pdf"));
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "Resuma isto" } });
    fireEvent.click(sendBtn());
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(uploads).toEqual([{ name: "proposta.pdf", csrf: "csrf-1", field: ["file"] }]);
    expect(runs[0].input).toBe("Resuma isto\n[Anexo: attachments/u-proposta.pdf, application/pdf, 1 KB]");
    expect(screen.queryByRole("list", { name: "Anexos desta mensagem" })).toBeNull();
  });

  it("an attachment alone can be sent", async () => {
    open();
    expect(sendBtn().disabled).toBe(true);
    pick(file("foto.png", "image/png"));
    expect(sendBtn().disabled).toBe(false);
    fireEvent.click(sendBtn());
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].input).toBe("[Anexo: attachments/u-foto.png, image/png, 1 KB]");
  });

  it("refused by the server (415 by the bytes, 413): said in words, the chip and the text stay, nothing is sent", async () => {
    reply = () => refuse(415, "attachment_refused", { reason: "type" });
    open();
    pick(file("notas.txt"));
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: "veja" } });
    fireEvent.click(sendBtn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("O LuveBot não aceitou este arquivo: pelo conteúdo, não é de um tipo aceito.");
    expect(alert.textContent).not.toContain("Some English text.");
    expect(chips()).toHaveLength(1);
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("veja");
    expect(runs).toHaveLength(0);
    fireEvent.click(within(alert).getByRole("button", { name: "Detalhe técnico" }));
    expect(within(alert).getByText("attachment_refused:type")).toBeTruthy();
    reply = () => refuse(413, "too_large");
    fireEvent.click(sendBtn());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("O arquivo passa do limite: 10 MB para imagens, 20 MB para documentos."));
  });

  it("a Bot without a work folder: says so and offers to create it (POST /workspace with CSRF); then sending works", async () => {
    reply = (f, n) => (n === 1 ? refuse(409, "workspace_unavailable", { reason: "no_workspace" }) : ok(f));
    open();
    pick(file("foto.png", "image/png"));
    fireEvent.click(sendBtn());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Este Bot ainda não tem uma pasta de trabalho, que é onde os anexos ficam.");
    fireEvent.click(within(alert).getByRole("button", { name: "Criar a pasta do Bot" }));
    expect(await screen.findByText("Pasta criada. Envie de novo.")).toBeTruthy();
    expect(workspacePosts).toEqual(["csrf-1"]);
    fireEvent.click(sendBtn());
    await waitFor(() => expect(runs).toHaveLength(1));
  });

  it("other folder states say their own thing and offer nothing to create", async () => {
    reply = () => refuse(409, "workspace_unavailable", { reason: "not_local" });
    open();
    pick(file("foto.png", "image/png"));
    fireEvent.click(sendBtn());
    expect((await screen.findByRole("alert")).textContent).toContain("Anexos ainda não funcionam com o terminal remoto ou em contêiner deste Bot.");
    expect(screen.queryByRole("button", { name: "Criar a pasta do Bot" })).toBeNull();
  });

  it("a retry never uploads again what already went: the first file is kept, only the refused one is tried again", async () => {
    reply = (f) => (f.name === "b.txt" ? refuse(415, "attachment_refused", { reason: "type" }) : ok(f));
    open();
    pick(file("a.pdf", "application/pdf"), file("b.txt"));
    fireEvent.click(sendBtn());
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Remover b.txt" }));
    fireEvent.click(sendBtn());
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(uploads.map((u) => u.name)).toEqual(["a.pdf", "b.txt"]);              // a.pdf went once
    expect(runs[0].input).toBe("[Anexo: attachments/u-a.pdf, application/pdf, 1 KB]");
  });

  it("a type or size the server would refuse is refused at once, with no chip and no upload; at most 5 per message", () => {
    open();
    pick(file("logo.svg", "image/svg+xml"));
    expect(screen.getByRole("alert").textContent).toContain("logo.svg não pode ser anexado.");
    expect(screen.queryByRole("list", { name: "Anexos desta mensagem" })).toBeNull();
    pick(file("grande.png", "image/png", IMAGE_MAX + 1));
    expect(screen.getByRole("alert").textContent).toBe("grande.png passa do limite: 10 MB para imagens, 20 MB para documentos.");
    pick(...Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`)));
    expect(chips()).toHaveLength(MAX_FILES);
    expect(screen.getByRole("alert").textContent).toBe("Até 5 anexos por mensagem.");
    expect(uploads).toHaveLength(0);
  });

  it("a pasted image becomes a chip (a pasted text stays text); a dropped file too, with 'Solte para anexar' while dragging", () => {
    open();
    const box = screen.getByLabelText("Mensagem");
    fireEvent.paste(box, { clipboardData: { files: [file("image.png", "image/png")], getData: () => "" } });
    expect(chips()).toHaveLength(1);
    fireEvent.paste(box, { clipboardData: { files: [], getData: () => "só texto" } });
    expect(chips()).toHaveLength(1);
    const area = screen.getByRole("region", { name: /Conversa com/ }) ?? box;
    fireEvent.dragOver(area, { dataTransfer: { types: ["Files"], files: [] } });
    expect((box as HTMLTextAreaElement).placeholder).toBe("Solte para anexar");
    fireEvent.drop(area, { dataTransfer: { types: ["Files"], files: [file("planilha.xlsx")] } });
    expect(chips()).toHaveLength(2);
    expect((box as HTMLTextAreaElement).placeholder).not.toBe("Solte para anexar");
  });
});
