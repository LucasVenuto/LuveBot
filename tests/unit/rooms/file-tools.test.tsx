// tests/unit/rooms/file-tools.test.tsx (contract v0.9 14, A-89)
// A file attached in a room lands in each recipient's own workspace; what that Bot can do with it depends on its tools. When files are attached, each
// recipient gets one calm line, from `GET /bots/{bot}` -> `file_tools`: what the Bot can TRY (never what it did), `terminal: true` is not a permission,
// nothing blocks the send, and a key the line needs that the server could not tell says nothing. Read lazily: no file, no read.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, configure } from "@testing-library/react";
import { RoomsView } from "@/components/rooms/RoomsView";
import { docLine, imageLine } from "@/components/rooms/FileTools";
import { recipientsOf } from "@/components/rooms/mentions";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { BotFileTools, Room } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

describe("the contract's table, row by row", () => {
  it("text, documents, tables, code", () => {
    expect(docLine({ read_file: true, terminal: false })).toBe("fileToolsReadDoc");
    expect(docLine({ read_file: true })).toBe("fileToolsReadDoc");
    expect(docLine({ read_file: false, terminal: true })).toBe("fileToolsTermDoc");
    expect(docLine({ terminal: true })).toBe("fileToolsTermDoc");                         // "can open it through the terminal" stays true when read_file is unknown
    expect(docLine({ read_file: false, terminal: false })).toBe("fileToolsNoDoc");
  });
  it("text: a needed key that is absent says nothing, never a 'cannot'", () => {
    expect(docLine({ read_file: false })).toBeNull();
    expect(docLine({ terminal: false })).toBeNull();
    expect(docLine({})).toBeNull();
    expect(docLine(undefined)).toBeNull();
    expect(docLine(null)).toBeNull();
    expect(docLine({ read_file: "true", terminal: 1 } as unknown as BotFileTools)).toBeNull();   // only a real boolean counts
  });
  it("images", () => {
    expect(imageLine({ vision_analyze: true, terminal: false })).toBe("fileToolsLookImg");
    expect(imageLine({ vision_analyze: true })).toBe("fileToolsLookImg");
    expect(imageLine({ vision_analyze: false, terminal: true })).toBe("fileToolsTermImg");
    expect(imageLine({ vision_analyze: false, terminal: false })).toBe("fileToolsNoImg");
  });
  it("images: 'only through the terminal, not look at it' needs vision KNOWN false; an absent key says nothing", () => {
    expect(imageLine({ terminal: true })).toBeNull();                                       // vision unknown: that would be a guess
    expect(imageLine({ vision_analyze: false })).toBeNull();                                // terminal unknown
    expect(imageLine({ terminal: false })).toBeNull();
    expect(imageLine({})).toBeNull();
    expect(imageLine(undefined)).toBeNull();
  });
});

describe("who a draft goes to (the server's rooms.check_send)", () => {
  const members = ["vendas", "dev", "suporte"].map((handle) => ({ handle }));
  const names = (text: string, coordinator?: string | null) => recipientsOf(text, members, coordinator).map((m) => m.handle);
  it("no @ and no coordinator: everyone; with a coordinator: only it", () => {
    expect(names("leiam")).toEqual(["vendas", "dev", "suporte"]);
    expect(names("leiam", "dev")).toEqual(["dev"]);
    expect(names("leiam", "ninguem")).toEqual(["vendas", "dev", "suporte"]);              // a coordinator that is not a member: the server's default, everyone
  });
  it("the named members, in order, without repeats, whatever the case; a non-member names no one", () => {
    expect(names("@Dev e @vendas e @dev", "suporte")).toEqual(["dev", "vendas"]);
    expect(names("@fantasma")).toEqual([]);
    expect(names("@dev @fantasma")).toEqual(["dev"]);
  });
  it("@todos, @all and @everyone are everyone, even beside a coordinator", () => {
    for (const word of ["todos", "all", "everyone", "TODOS"]) expect(names(`@${word} leiam`, "dev")).toEqual(["vendas", "dev", "suporte"]);
  });
  it("a member literally called 'todos' (an older room) is that member, not everyone; @all still is everyone", () => {
    const old = [{ handle: "todos" }, { handle: "dev" }, { handle: "suporte" }];
    const who = (text: string) => recipientsOf(text, old).map((m) => m.handle);
    expect(who("@todos leia")).toEqual(["todos"]);
    expect(who("@todos @dev")).toEqual(["todos", "dev"]);
    expect(who("@all leia")).toEqual(["todos", "dev", "suporte"]);
  });

  it("a mention is the server's pattern (and Hermes's): 'ana@dev.com' names the handle 'dev.com', which is not a member", () => {
    expect(names("escreva a ana@dev.com")).toEqual([]);
    expect(names("@dev, leia")).toEqual(["dev"]);                                            // the comma ends the handle
  });
});

const ROOM: Room = {
  id: "r1", name: "Lançamento", created_at: "2026-10-01T00:00:00Z", driver: { running: false, pending_actions_count: 0 },
  members: [
    { member_id: "m1", bot: "vendas", handle: "vendas", display_name: "Vendas" },
    { member_id: "m2", bot: "dev", handle: "dev", display_name: "Dev" },
  ],
};
let tools: Record<string, BotFileTools | undefined | "fail">;
let reads: string[];
let posted: number;
beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt"); tools = {}; reads = []; posted = 0;
  setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "tok", actor: "basic:ceo", auth_mode: "gated" };
    const bot = url.match(/\/bots\/([^/?]+)(?:\?|$)/)?.[1];
    if (bot) {
      reads.push(bot);
      if (tools[bot] === "fail") throw new Error("boom");
      return { name: bot, ...(tools[bot] ? { file_tools: tools[bot] } : {}) };
    }
    if (url.includes("/rooms/r1/log")) return { events: [] };
    if (url.endsWith("/rooms/r1")) return { room: ROOM };
    if (url.includes("/handoffs")) return { handoffs: [] };
    throw new Error(`unexpected ${url}`);
  });
  (window as any).__HERMES_PLUGIN_SDK__ = {
    authedFetch: async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") { posted += 1; return new Response(JSON.stringify({ event: { seq: 9, event_id: "e9", kind: "message.user", actor: { kind: "user", id: "ceo" }, payload: { text: "ok" }, at: "2026-10-01T01:00:00Z" }, accepted: true }), { status: 202 }); }
      return new Response(new Blob(["x"]), { status: 200 });
    },
  };
  (URL as any).createObjectURL = () => "blob:luvebot/1";
  (URL as any).revokeObjectURL = () => {};
});
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); setLuveLocale("pt"); });

const open = async () => { render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />); await screen.findByRole("heading", { name: "Lançamento" }); };
const attach = (...files: File[]) => fireEvent.change(screen.getByTestId("room-file-input"), { target: { files } });
const write = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: /^(Mensagem|Message)$/ }), { target: { value } });
const pdf = () => new File(["%PDF-1.4 x"], "proposta.pdf", { type: "application/pdf" });
const png = () => new File(["x"], "foto.png", { type: "image/png" });
const LIST = "O que cada Bot consegue fazer com os anexos";
const lines = async () => (await screen.findByRole("list", { name: LIST })).textContent;

describe("the line per recipient, in the room composer", () => {
  it("a text file: each RECIPIENT gets its own line from its own tools, and only the recipients are asked", async () => {
    tools = { dev: { read_file: true, vision_analyze: true, terminal: true }, vendas: { read_file: false, vision_analyze: false, terminal: true } };
    await open();
    write("@dev e @vendas leiam");
    attach(pdf());
    await waitFor(() => expect(within(screen.getByRole("list", { name: LIST })).getAllByRole("listitem")).toHaveLength(2));
    const items = within(screen.getByRole("list", { name: LIST })).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Dev: consegue ler textos e documentos.", "Vendas: consegue abrir textos e documentos pelo terminal (cada comando passa pelas suas regras de aprovação)."]);
    expect(reads.sort()).toEqual(["dev", "vendas"]);
  });

  it("only the Bots the draft goes to: '@dev' alone does not ask or speak about Vendas", async () => {
    tools = { dev: { read_file: true }, vendas: { read_file: true } };
    await open();
    write("@dev leia");
    attach(pdf());
    expect(await lines()).toBe("Dev: consegue ler textos e documentos.");
    expect(reads).toEqual(["dev"]);
  });

  it("who it goes to follows the text as it is typed (no @: everyone in a room without a coordinator)", async () => {
    tools = { dev: { read_file: true }, vendas: { read_file: false, terminal: false } };
    await open();
    attach(pdf());
    await waitFor(() => expect(within(screen.getByRole("list", { name: LIST })).getAllByRole("listitem")).toHaveLength(2));
    expect(await lines()).toContain("Vendas: não tem como abrir arquivos.");
    write("@dev");
    await waitFor(() => expect(within(screen.getByRole("list", { name: LIST })).getAllByRole("listitem")).toHaveLength(1));
    expect(await lines()).toBe("Dev: consegue ler textos e documentos.");
  });

  it("an image and a document: both sentences, each from its own key", async () => {
    tools = { dev: { read_file: true, vision_analyze: true } };
    await open();
    write("@dev");
    attach(pdf(), png());
    expect(await lines()).toBe("Dev: consegue ler textos e documentos. Pode tentar ver imagens (precisa de um modelo que enxergue).");
  });

  it("an image: 'only through the terminal' when vision is off and the terminal is on", async () => {
    tools = { dev: { read_file: true, vision_analyze: false, terminal: true } };
    await open();
    write("@dev");
    attach(png());
    expect(await lines()).toBe("Dev: só alcança imagens pelo terminal, não consegue vê-las.");
  });

  it("no word without the answer: no field, an empty one, a failed read and an absent key leave the tray as it was", async () => {
    tools = { dev: undefined, vendas: "fail" };
    await open();
    write("@dev @vendas leiam");
    attach(pdf());
    await waitFor(() => expect(reads.sort()).toEqual(["dev", "vendas"]));
    expect(screen.queryByRole("list", { name: LIST })).toBeNull();
    expect(screen.getByText(/O conteúdo dos anexos vai para o provedor/)).toBeTruthy();   // what the tray said before stays
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("it never blocks the send, even for 'has no way to open files'; and it is calm (no alert, no status)", async () => {
    tools = { dev: { read_file: false, terminal: false } };
    await open();
    write("@dev leia");
    attach(pdf());
    expect(await lines()).toBe("Dev: não tem como abrir arquivos.");
    const list = screen.getByRole("list", { name: LIST });
    expect(list.getAttribute("role")).toBeNull();
    expect(list.querySelector("[role], [aria-live]")).toBeNull();                              // no alert, no status, no live region: it does not interrupt
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(posted).toBe(1));
  });

  it("lazy: no file, no read; the files going away takes the lines away; the next attach asks again", async () => {
    tools = { dev: { read_file: true } };
    await open();
    write("@dev leia");
    expect(reads).toEqual([]);
    attach(pdf());
    await lines();
    expect(reads).toEqual(["dev"]);
    fireEvent.click(screen.getByRole("button", { name: "Remover proposta.pdf" }));
    await waitFor(() => expect(screen.queryByRole("list", { name: LIST })).toBeNull());
    attach(pdf());
    await lines();
    expect(reads).toEqual(["dev", "dev"]);
  });

  it("the text is the Bot's word and the label is ours: a Bot's name that looks like markup stays text", async () => {
    tools = { dev: { read_file: true } };
    const room = { ...ROOM, members: [{ member_id: "m2", bot: "dev", handle: "dev", display_name: "<b>Dev</b>" }, ROOM.members[0]] };
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "tok", actor: "basic:ceo", auth_mode: "gated" };
      if (/\/bots\/dev(\?|$)/.test(url)) return { name: "dev", file_tools: { read_file: true } };
      if (url.includes("/rooms/r1/log")) return { events: [] };
      if (url.endsWith("/rooms/r1")) return { room };
      if (url.includes("/handoffs")) return { handoffs: [] };
      throw new Error(`unexpected ${url}`);
    });
    await open();
    write("@dev");
    attach(pdf());
    const list = await screen.findByRole("list", { name: LIST });
    expect(list.textContent).toBe("<b>Dev</b>: consegue ler textos e documentos.");
    expect(list.querySelector("b")).toBeNull();
  });

  it("in English", async () => {
    setLuveLocale("en");
    tools = { dev: { read_file: false, vision_analyze: false, terminal: true } };
    await open();
    write("@dev");
    attach(pdf(), png());
    const list = await screen.findByRole("list", { name: "What each Bot can do with the attachments" });
    expect(list.textContent).toBe("Dev: can open text and documents through the terminal (each command goes through your approval rules). Can only reach images through the terminal, not look at them.");
  });

  it("in Portuguese: the second line starts a sentence after the first one's full stop (it used to read '...aprovação). só alcança...'); alone, it stays lower case after the name", async () => {
    tools = { dev: { read_file: false, vision_analyze: false, terminal: true } };
    await open();
    write("@dev");
    attach(pdf(), png());
    expect(await lines()).toBe("Dev: consegue abrir textos e documentos pelo terminal (cada comando passa pelas suas regras de aprovação). Só alcança imagens pelo terminal, não consegue vê-las.");
    cleanup();
    await open();
    write("@dev");
    attach(png());
    expect(await lines()).toBe("Dev: só alcança imagens pelo terminal, não consegue vê-las.");
  });
});
