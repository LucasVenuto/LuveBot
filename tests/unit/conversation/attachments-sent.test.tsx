// tests/unit/conversation/attachments-sent.test.tsx
// t142: a sent message's attachment references become compact chips in the user's bubble (name, format, size) instead of the
// raw "[Anexo: attachments/<uuid>-<name>, <type>, <size>]" lines, which stay in the message for the Bot exactly as sent.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { splitReferences, nameParts } from "@/components/conversation/Attachments";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { initialTranscript } from "@/lib/stream/reducer";

const BOT = { name: "vendas", label: "Vendas" };
// the exact shape the backend writes (backend/pages.py save_attachment), as in the harness capture
const PDF = "[Anexo: attachments/483888d158854cd8a0a5a3e547b473b0-proposta-alder.pdf, application/pdf, 1 KB]";
const PNG = "[Anexo: attachments/ec010ab4facd415ba79c02ef70df9e42-grafico-vendas.png, image/png, 1 KB]";
const XLSX = "[Anexo: attachments/0123456789abcdef0123456789abcdef-planilha.xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 2.4 MB]";

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => { setCustomFetchJSON(null); delete (window as any).__HERMES_PLUGIN_SDK__; });

describe("a long name is cut in the middle, keeping its end and extension", () => {
  it("splits the shrinkable start from the end that always shows (the last 3 letters + the extension)", () => {
    expect(nameParts("proposta-alder.pdf")).toEqual({ head: "proposta-al", tail: "der.pdf" });
    expect(nameParts("relatorio-trimestral-de-vendas-2026.xlsx")).toEqual({ head: "relatorio-trimestral-de-vendas-2", tail: "026.xlsx" });
    expect(nameParts("ab.md")).toEqual({ head: "a", tail: "b.md" });         // short: nothing to cut, still whole
    expect(nameParts("LEIAME")).toEqual({ head: "LEI", tail: "AME" });        // no extension
    // a "extension" longer than 8 is not one: it would never shrink and burst the bubble, so only 3 letters stay fixed
    const long = "x." + "a".repeat(60);
    expect(nameParts(long)).toEqual({ head: long.slice(0, -3), tail: "aaa" });
    expect(nameParts("ata.da-reuniao-de-segunda-feira")).toEqual({ head: "ata.da-reuniao-de-segunda-fe", tail: "ira" });
    expect(nameParts("backup.extensao8")).toEqual({ head: "backup.extens", tail: "ao8" });   // 9 after the dot: a name, not an extension
    expect(nameParts("planilha.xlsx12").tail).toBe("planilha".slice(-3) + ".xlsx12");   // 6 chars after the dot: an extension
    expect(nameParts("foto.").tail).toBe("to.");                                         // nothing after the dot: no extension
    expect(nameParts("a.12345678")).toEqual({ head: "a", tail: ".12345678" });            // exactly 8: still an extension
    expect(nameParts("a.123456789").tail).toBe("789");                                   // 9: not one
    for (const n of ["proposta-alder.pdf", "ab.md", "LEIAME", "a.b.c.tar.json"]) { const p = nameParts(n); expect(p.head + p.tail, n).toBe(n); }
  });
});

describe("the references of a sent message", () => {
  it("are split from the text: name without the folder and the uuid, a short format, the size; other lines stay text", () => {
    expect(splitReferences(`Resuma a proposta e comente o gráfico.\n${PDF}\n${PNG}`)).toEqual({
      text: "Resuma a proposta e comente o gráfico.",
      refs: [{ name: "proposta-alder.pdf", type: "PDF", size: "1 KB" }, { name: "grafico-vendas.png", type: "PNG", size: "1 KB" }],
    });
    expect(splitReferences(XLSX)).toEqual({ text: "", refs: [{ name: "planilha.xlsx", type: "Excel", size: "2.4 MB" }] });
    for (const plain of ["[Anexo: /etc/passwd, text/plain, 1 KB]", "veja o [Anexo: attachments/a.pdf, application/pdf, 1 KB] aqui", "oi"]) {
      expect(splitReferences(plain).refs, plain).toEqual([]);
    }
  });
});

const turn = (user: string) => ({ id: 1, user, state: { ...initialTranscript(), status: "completed" as any }, stopping: false, errors: [], confirmed: "completed" as const });
const bubble = () => screen.getByText("Resuma a proposta e comente o gráfico.").closest("div") as HTMLElement;

describe("the user's bubble", () => {
  it("shows the text and the attachments as chips, never the path attachments/<uuid>", () => {
    render(<Conversation bot={BOT} initialTurns={[turn(`Resuma a proposta e comente o gráfico.\n${PDF}\n${PNG}`)]} />);
    const list = screen.getByRole("list", { name: "Anexos enviados" });
    const chips = within(list).getAllByRole("listitem");
    expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Anexo proposta-alder.pdf, PDF, 1 KB", "Anexo grafico-vendas.png, PNG, 1 KB"]);
    expect(chips[0].textContent).toBe("proposta-alder.pdf" + "PDF · 1 KB");
    // the end of the name, with the extension, sits in a part that never shrinks; only the start gets the ellipsis
    const name = within(chips[0]).getByTestId("sent-name");
    const [head, tail] = Array.from(name.children) as HTMLElement[];
    expect([head.textContent, tail.textContent]).toEqual(["proposta-al", "der.pdf"]);
    expect(head.className).toContain("lb-truncate");
    expect(tail.style.flexShrink).toBe("0");
    expect(name.parentElement!.style.maxWidth).toBe("min(100%, 420px)");     // no fixed 200 px: the bubble limits it
    const thread = screen.getByLabelText(/^Conversa com/);
    expect(thread.textContent).not.toContain("attachments/");
    expect(thread.textContent).not.toContain("[Anexo:");
    expect(bubble().textContent).toContain("Resuma a proposta e comente o gráfico.");
  });

  it("a message that is only an attachment is just the chip", () => {
    render(<Conversation bot={BOT} initialTurns={[turn(XLSX)]} />);
    expect(within(screen.getByRole("list", { name: "Anexos enviados" })).getByRole("listitem").getAttribute("aria-label")).toBe("Anexo planilha.xlsx, Excel, 2.4 MB");
  });

  it("sending: the run carries the raw reference for the Bot, and the bubble shows the chip", async () => {
    const runs: Array<{ input: string }> = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
      if (url.endsWith("/sessions")) return { session: { id: "s1" } };
      if (method === "POST" && url.endsWith("/runs")) { runs.push(JSON.parse(String(init?.body))); return { run: { id: "run_r1", status: "started", session_id: "s1" } }; }
      return { run: { id: "run_r1", status: "started" } };
    });
    (window as any).__HERMES_PLUGIN_SDK__ = {
      authedFetch: async () => new Response(JSON.stringify({ attachment: { path: "attachments/483888d158854cd8a0a5a3e547b473b0-proposta-alder.pdf", name: "proposta-alder.pdf", type: "application/pdf", size: 900, reference: PDF } }), { status: 201 }),
    };
    render(<Conversation bot={BOT} fetcher={async () => new Response(new ReadableStream(), { status: 200, headers: { "content-type": "text/event-stream" } })} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["%PDF-1.4"], "proposta-alder.pdf", { type: "application/pdf" })], configurable: true });
    fireEvent.change(input);
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "Resuma a proposta e comente o gráfico." } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].input).toBe(`Resuma a proposta e comente o gráfico.\n${PDF}`);             // the Bot reads the raw line
    const chip = await screen.findByRole("listitem", { name: "Anexo proposta-alder.pdf, PDF, 1 KB" });
    expect(chip).toBeTruthy();
    expect(screen.getByLabelText(/^Conversa com/).textContent).not.toContain("attachments/");
  });
});
