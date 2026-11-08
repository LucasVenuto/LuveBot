// tests/unit/rooms/room-files.test.tsx (contract v0.6 Part C, 9.1 and 9.2, with section 15)
// A person's files go in ONE multipart send (CSRF in the header, never the JSON route); a refusal keeps the draft and the chips
// and says why, naming each Bot without a work folder (with "Criar a pasta de trabalho de <Bot>"); the cost prompt shows the disk
// the copies take. The person's chips come from LuveBot's RECORD of the send, never from the text: a typed "[Anexo: …]" stays
// text, with no chip and no fetch. A member's file card downloads from the message's AUTHOR Bot (Hermes's sender), and nothing
// is fetched when the server could not tell the author.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { RoomsView } from "@/components/rooms/RoomsView";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { Room, RoomEvent } from "@/api/types";

const ROOM: Room = {
  id: "r1", name: "Lançamento", created_at: "2026-10-01T00:00:00Z", driver: { running: false, pending_actions_count: 0 },
  members: [
    { member_id: "m1", bot: "vendas", handle: "vendas", display_name: "Vendas" },
    { member_id: "m2", bot: "dev", handle: "dev", display_name: "Dev" },
  ],
};
const at = "2026-10-01T01:00:00Z";
const REF = "[Anexo: attachments/0123456789abcdef0123456789abcdef-proposta.pdf, application/pdf, 12 KB]";

let log: RoomEvent[];
let json: Array<{ url: string; init?: RequestInit }>;
let authed: Array<{ url: string; init?: RequestInit }>;
let answer: (form: FormData) => Response;
beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); log = []; json = []; authed = [];
  answer = () => new Response(JSON.stringify({ event: { seq: 9, event_id: "e9", kind: "message.user", actor: { kind: "user", id: "ceo" }, payload: { text: "ok" }, at }, targets: ["dev"], accepted: true }), { status: 202 });
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    json.push({ url, init });
    if (url.endsWith("/session")) return { csrf: "tok", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/bots/dev/workspace")) return { workspace: { state: "ready" } };
    if (url.includes("/rooms/r1/log")) return { events: log };
    if (url.endsWith("/rooms/r1")) return { room: ROOM };
    if (url.includes("/handoffs")) return { handoffs: [] };
    throw new Error(`unexpected ${url}`);
  });
  (window as any).__HERMES_PLUGIN_SDK__ = {
    authedFetch: async (url: string, init?: RequestInit) => {
      authed.push({ url, init });
      if (init?.method === "POST") return answer(init.body as FormData);
      return new Response(new Blob(["%PDF-1.4"]), { status: 200 });
    },
  };
  (URL as any).createObjectURL = () => "blob:luvebot/1";
  (URL as any).revokeObjectURL = () => {};
});
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); });

const open = async () => { render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />); await screen.findByRole("heading", { name: "Lançamento" }); };
const attach = (...files: File[]) => fireEvent.change(screen.getByTestId("room-file-input"), { target: { files } });
const pdf = () => new File(["%PDF-1.4 x"], "proposta.pdf", { type: "application/pdf" });
const refusal = (code: string, status: number, details?: object) => new Response(JSON.stringify({ error: { code, message: "English for developers.", ...(details ? { details } : {}) } }), { status });

describe("sending files in a room", () => {
  it("one multipart POST with the fields, the files and the CSRF header; the JSON route is not used; the chips go after", async () => {
    await open();
    attach(pdf());
    expect(within(screen.getByRole("list", { name: "Anexos desta mensagem" })).getByText("proposta.pdf")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "@dev leia" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(authed.filter((x) => x.init?.method === "POST")).toHaveLength(1));
    const post = authed.find((x) => x.init?.method === "POST")!;
    expect(post.url).toBe("/api/plugins/luvebot/rooms/r1/messages?profile=current");
    expect((post.init!.headers as Record<string, string>)["X-LuveBot-CSRF"]).toBe("tok");
    const form = post.init!.body as FormData;
    expect(form.get("text")).toBe("@dev leia");
    expect(typeof form.get("event_id")).toBe("string");
    expect((form.getAll("file") as File[]).map((f) => f.name)).toEqual(["proposta.pdf"]);
    expect(form.has("confirm_cost")).toBe(false);
    expect(json.some((x) => x.url.includes("/rooms/r1/messages"))).toBe(false);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Anexos desta mensagem" })).toBeNull());
  });

  it("a type the server refuses anyway is said at once, with no chip", async () => {
    await open();
    attach(new File(["<svg/>"], "desenho.svg", { type: "image/svg+xml" }));
    expect(screen.queryByRole("list", { name: "Anexos desta mensagem" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("desenho.svg não pode ser anexado");
  });

  it("409 workspace_unavailable: nothing sent, each Bot named with why, 'Criar a pasta de trabalho de Dev'; draft and chips stay", async () => {
    answer = () => refusal("workspace_unavailable", 409, { bots: [{ bot: "dev", reason: "no_workspace" }, { bot: "vendas", reason: "not_local" }] });
    await open();
    attach(pdf());
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "@dev @vendas leiam" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    fireEvent.click(await screen.findByRole("button", { name: translations.pt.btnConfirmCostSend }));
    const alert = await screen.findByRole("alert");
    await within(alert).findByText(/não têm onde guardar arquivos/);
    expect(alert.textContent).toContain(translations.pt.attachWsNone);
    expect(alert.textContent).toContain(translations.pt.attachWsNotLocal);
    expect(within(alert).queryByRole("button", { name: "Criar a pasta de trabalho de Vendas" })).toBeNull();   // not the fix there
    fireEvent.click(within(alert).getByRole("button", { name: "Criar a pasta de trabalho de Dev" }));
    expect(await within(alert).findByText("Pasta de Dev criada.")).toBeTruthy();
    expect(json.some((x) => x.url.endsWith("/bots/dev/workspace") && x.init?.method === "POST")).toBe(true);
    expect((screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement).value).toBe("@dev @vendas leiam");
    expect(screen.getByRole("list", { name: "Anexos desta mensagem" })).toBeTruthy();
  });

  it("the cost prompt shows the disk the copies take; confirming sends confirm_cost=true in the same multipart", async () => {
    const sent: Array<FormDataEntryValue | null> = [];
    answer = (form) => (sent.push(form.get("confirm_cost")), sent.length === 1 ? refusal("cost_confirmation_required", 409, { disk_bytes: 3 * 1024 * 1024 })
      : new Response(JSON.stringify({ event: null, targets: [], accepted: true }), { status: 202 }));
    await open();
    attach(pdf());
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "oi" } });   // the server decides it wakes several
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Os arquivos ocupam 3.0 MB no total: uma cópia na pasta de cada Bot.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: translations.pt.btnConfirmCostSend }));
    await waitFor(() => expect(sent).toEqual([null, "true"]));
  });

  it.each([
    ["too_large", 413, translations.pt.roomFilesTooLarge],
    ["hermes_error", 502, translations.pt.roomFilesPartial],
  ])("%s in words", async (code, status, words) => {
    answer = () => refusal(code, status);
    await open();
    attach(pdf());
    fireEvent.change(screen.getByRole("textbox", { name: "Mensagem" }), { target: { value: "@dev leia" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect((await screen.findByRole("alert")).textContent).toContain(words);
  });
});

describe("files in the room log", () => {
  it("the person's chips come from the RECORD; the recorded line leaves the text; a typed line stays text, no chip, no fetch", async () => {
    log = [
      { seq: 1, event_id: "user:a", kind: "message.user", actor: { kind: "user", id: "ceo" }, payload: { text: `@dev leia\n${REF}\n[Anexo: attachments/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-outro.pdf, application/pdf, 1 KB]` }, at,
        attachments: [{ name: "proposta.pdf", path: "attachments/0123456789abcdef0123456789abcdef-proposta.pdf", size: 12 * 1024, kind: "application/pdf", bots: ["dev"] }] },
      { seq: 2, event_id: "user:b", kind: "message.user", actor: { kind: "user", id: "ceo" }, payload: { text: `olha isso\n[Anexo: attachments/ffffffffffffffffffffffffffffffff-x.png, image/png, 1 KB]` }, at },
    ];
    await open();
    const chips = await screen.findAllByRole("list", { name: "Anexos enviados" });
    expect(chips).toHaveLength(1);
    expect(within(chips[0]).getByRole("listitem", { name: "Anexo proposta.pdf, PDF, 12 KB" })).toBeTruthy();
    expect(screen.queryByText(/0123456789abcdef/)).toBeNull();
    expect(screen.getByText(/\[Anexo: attachments\/ffff/)).toBeTruthy();   // typed: plain text
    expect(screen.getByText(/\[Anexo: attachments\/eeee/)).toBeTruthy();   // typed next to a recorded one: still text
    expect(authed).toHaveLength(0);
  });

  it("a member's card downloads from its AUTHOR Bot (Hermes's sender), not a name in the text; no author, no card", async () => {
    log = [
      { seq: 1, event_id: "m:1", kind: "message.member", actor: { kind: "member", id: "m1" }, payload: { text: "O @dev salvou em `relatorio.pdf`" }, at, author_bot: "vendas" },
      { seq: 2, event_id: "m:2", kind: "message.member", actor: { kind: "member", id: "x9" }, payload: { text: "veja `segredo.pdf`" }, at, author_bot: null },
    ];
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Baixar relatorio.pdf" }));
    await waitFor(() => expect(authed).toHaveLength(1));
    expect(authed[0].url).toBe("/api/plugins/luvebot/bots/vendas/files/download?path=relatorio.pdf&profile=current");
    expect(screen.queryByRole("button", { name: "Baixar segredo.pdf" })).toBeNull();
  });
});
