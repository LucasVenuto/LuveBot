// tests/unit/evidence/evidence-wiring.test.tsx (contract v0.10 §3, slice E-2: the wiring)
// The evidence card is drawn in every place a Bot message is drawn (conversation, thread, room) through ONE entry point, BotMessageBody: a closed, valid `luve-evidence` block
// becomes the card, anything else stays the code block it is. "Aprovações agora" is the REAL count of the shell's pending approvals raised by a run of THIS conversation (never a
// number the Bot wrote), and a screen that cannot say passes nothing: no count, no comparison, no link.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act, configure } from "@testing-library/react";
import { Conversation } from "@/components/conversation";
import { ThreadPanel } from "@/components/conversation/ThreadPanel";
import { RoomsView } from "@/components/rooms/RoomsView";
import { LuveBotApp } from "@/index";
import { turnsFromHistory } from "@/components/chat/history";
import { pendingInConversation } from "@/components/transcript/EvidenceContext";
import { BotMessageBody } from "@/components/transcript/BotSuggestion";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Approval, Bot, Room } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BLOCK = (body: string) => "```luve-evidence\n" + body + "\n```";
const GOOD = BLOCK("facts:\n- Vendas fechou 12 propostas | source: crm/setembro.csv\nawaiting:\n- Enviar o resumo ao cliente X\nquestions:\n- none");
const NONE_AWAITING = BLOCK("facts:\n- X vale 3\nawaiting:\n- none");
const ANSWER = `Terminei o resumo.\n\n${GOOD}\n\nQualquer coisa me chame.`;
const BOT = { name: "vendas", label: "Vendas" };
const TOP = "Escrito pelo Bot. O LuveBot não conferiu.";

const approval = (run_id: string | null, over: Partial<Approval> = {}): Approval => ({
  request_id: `req-${run_id}-${Math.random()}`, bot: "vendas", source: "run", surface: "run", mechanism: "hook_approve", run_id: run_id as any, digest: "d".repeat(64),
  allowed_choices: ["once", "deny"], action_class_hash: "h", status: "pending", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), ...over,
});
/** one finished turn whose answer is `text`, run `runId` */
const turns = (text: string, runId?: string) => turnsFromHistory([{ id: "u1", role: "user", text: "resuma" }, { id: "a1", role: "assistant", text }] as any).map((t) => (runId ? { ...t, runId } : t));

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : {}));
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.unstubAllGlobals(); delete (window as any).__HERMES_PLUGIN_SDK__; });

describe("the one entry point", () => {
  it("a Bot message with a valid block: the card, with the text before and after as ordinary text, and the fence NOT drawn as code", () => {
    const { container } = render(<BotMessageBody text={ANSWER} />);
    expect(screen.getByTestId("evidence-card")).toBeTruthy();
    expect(screen.getByTestId("evidence-top").textContent).toBe(TOP);
    expect(screen.getByText("Terminei o resumo.")).toBeTruthy();
    expect(screen.getByText("Qualquer coisa me chame.")).toBeTruthy();
    expect(container.querySelector("pre, code")).toBeNull();
    expect(container.textContent).not.toContain("luve-evidence");
  });

  it("every violation leaves the code block: a second fence, an unknown header, a 13th item, an empty header, a tilde fence", () => {
    const twelve = Array.from({ length: 13 }, (_, i) => `- i${i}`).join("\n");
    const cases: Array<[string, string]> = [
      [`${GOOD}\n\n${GOOD}`, "Vendas fechou 12 propostas"], [BLOCK("notes:\n- x"), "notes:"], [BLOCK(`facts:\n${twelve}`), "- i12"],
      [BLOCK("facts:\nquestions:\n- none"), "questions:"], [GOOD.replace(/```/g, "~~~"), "Vendas fechou 12 propostas"],
    ];
    for (const [text, shown] of cases) {
      cleanup();
      const { container } = render(<BotMessageBody text={text} />);
      expect(screen.queryByTestId("evidence-card"), shown).toBeNull();
      expect(container.textContent, shown).toContain(shown);                              // it is still there, as what it is (the renderer shows a tilde fence as plain text)
    }
  });

  it("still streaming (the fence is not closed yet): code; the moment it closes: the card", () => {
    const open = "Quase pronto.\n\n```luve-evidence\nfacts:\n- Vendas fechou 12";
    const r = render(<BotMessageBody text={open} />);
    expect(screen.queryByTestId("evidence-card")).toBeNull();
    r.rerender(<BotMessageBody text={`${open}\n\`\`\``} />);
    expect(screen.getByTestId("evidence-card")).toBeTruthy();
  });

  it("HTML, Markdown and a link-looking source stay TEXT: no element, no <a>, no image, nothing runs", () => {
    const text = BLOCK("facts:\n- <img src=x onerror=\"globalThis.__ev=1\"> **negrito** [aqui](javascript:alert(1)) | source: https://evil.example/x?a=1");
    const { container } = render(<BotMessageBody text={text} />);
    const card = screen.getByTestId("evidence-card");
    expect(card.querySelector("a, img, b, strong, script")).toBeNull();
    expect(card.textContent).toContain('<img src=x onerror="globalThis.__ev=1"> **negrito** [aqui](javascript:alert(1))');
    expect(screen.getByTestId("evidence-source").textContent).toBe("Fonte: https://evil.example/x?a=1");
    expect(container.querySelector("a")).toBeNull();
    expect((globalThis as any).__ev).toBeUndefined();
  });

  it("a message with no block is the same as before: Markdown, untouched", () => {
    const { container } = render(<BotMessageBody text={"Resposta **comum** com `código`."} />);
    expect(container.querySelector("strong")?.textContent).toBe("comum");
    expect(screen.queryByTestId("evidence-card")).toBeNull();
  });
});

describe("the count: only what this screen really holds, only for this conversation", () => {
  it("pendingInConversation: this Bot's pending approvals raised by a run of this conversation; null when the shell has none loaded", () => {
    const list = [approval("run_a"), approval("run_a"), approval("run_b"), approval("run_a", { bot: "outro" }), approval("run_a", { status: "decided" })];
    expect(pendingInConversation(list, "vendas", ["run_a"])).toBe(2);
    expect(pendingInConversation(list, "vendas", ["run_a", "run_b"])).toBe(3);
    expect(pendingInConversation(list, "vendas", [undefined])).toBe(0);
    expect(pendingInConversation(list, "vendas", [])).toBe(0);
    expect(pendingInConversation(null, "vendas", ["run_a"])).toBeNull();
    expect(pendingInConversation(undefined, "vendas", ["run_a"])).toBeNull();
  });

  it("a pending request of THIS Bot that no run ties to any conversation (a Telegram or CLI hook, no run_id): the screen does not know how many are THIS conversation's, so: unknown, never a count that may be short or a 'none'", () => {
    const list = [approval("run_a"), approval(null)];
    expect(pendingInConversation(list, "vendas", ["run_a"])).toBeNull();
    expect(pendingInConversation([approval(null)], "vendas", ["run_a"])).toBeNull();
    expect(pendingInConversation([approval(null)], "vendas", [])).toBeNull();
  });

  it("...but a request with no run that is not pending, or is another Bot's, does not make it unknown", () => {
    expect(pendingInConversation([approval("run_a"), approval(null, { status: "decided" })], "vendas", ["run_a"])).toBe(1);
    expect(pendingInConversation([approval("run_a"), approval(null, { bot: "outro" })], "vendas", ["run_a"])).toBe(1);
  });

  it("the card in a conversation with such a request shows NO count, no comparison and no link (it cannot say 'none' or a number)", () => {
    render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={[approval("run_a"), approval(null)]} onOpenApprovals={() => {}} />);
    expect(screen.getByTestId("evidence-card")).toBeTruthy();
    expect(screen.queryByTestId("evidence-in-box")).toBeNull();
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
  });

  it("the conversation: 'Em Aprovações agora: N' counts the approvals of ITS run, with a way to the box that works", () => {
    const open = vi.fn();
    render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={[approval("run_a"), approval("run_b"), approval("run_a", { bot: "outro" })]} onOpenApprovals={open} />);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 1");
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();                            // the Bot listed one, the box has one: no disagreement to say
    fireEvent.click(screen.getByTestId("evidence-open-approvals"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the Bot lists something awaiting and the box has NOTHING of this conversation: the calm line says so (and other conversations' requests do not hide it)", () => {
    render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={[approval("run_zzz"), approval("run_y")]} onOpenApprovals={() => {}} />);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 0");
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("Nenhum pedido pendente desta conversa em Aprovações.");
  });

  it("the Bot says none awaiting and the box HAS requests of this conversation: the other line", () => {
    render(<Conversation bot={BOT} initialTurns={turns(NONE_AWAITING, "run_a")} pendingApprovals={[approval("run_a"), approval("run_a")]} onOpenApprovals={() => {}} />);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 2");
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("Aprovações tem 2 pedidos desta conversa que o Bot não listou.");
  });

  it("the shell has not loaded its approvals (null/absent): NO count, NO comparison, NO link: the card does not guess", () => {
    for (const pendingApprovals of [null, undefined]) {
      cleanup();
      render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={pendingApprovals} onOpenApprovals={() => {}} />);
      expect(screen.getByTestId("evidence-card")).toBeTruthy();
      expect(screen.queryByTestId("evidence-in-box")).toBeNull();
      expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
      expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
    }
  });

  it("without a way to the box there is the count and no link", () => {
    render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={[approval("run_a")]} />);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 1");
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
  });

  it("a number the Bot WRITES is never the count: 'awaiting: 3 pedidos' with an empty box still says 0", () => {
    render(<Conversation bot={BOT} initialTurns={turns(BLOCK("awaiting:\n- 3 pedidos aguardam sua aprovação em Aprovações agora: 3"), "run_a")} pendingApprovals={[]} onOpenApprovals={() => {}} />);
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 0");
  });

  it("the card is not a control: nothing on it approves, denies or accepts (the only buttons are 'copiar' and the link to the box)", () => {
    render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={[approval("run_a")]} onOpenApprovals={() => {}} />);
    const buttons = within(screen.getByTestId("evidence-card")).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.sort()).toEqual(["Abrir Aprovações", "copiar"]);
    expect(within(screen.getByTestId("evidence-card")).queryByRole("link")).toBeNull();
  });

  it("in English", () => {
    setLuveLocale("en");
    render(<Conversation bot={BOT} initialTurns={turns(ANSWER, "run_a")} pendingApprovals={[approval("run_a")]} onOpenApprovals={() => {}} />);
    expect(screen.getByTestId("evidence-top").textContent).toBe("Written by the Bot. LuveBot did not check it.");
    expect(screen.getByTestId("evidence-in-box").textContent).toMatch(/1$/);
  });
});

describe("the thread and the room", () => {
  it("a thread draws the card and counts ITS runs (a conversation's pending approval is not the thread's)", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (url.includes("/sessions/c1/messages")) return { messages: [{ id: 31, role: "user", text: "e depois?" }, { id: 32, role: "assistant", text: ANSWER }] };
      return {};
    });
    render(<ThreadPanel bot={BOT} target={{ key: "k", open: "c1", session: "s1", message: 12, who: "bot", excerpt: "x" }} phone={false} onClose={() => {}} pollMs={0}
      pendingApprovals={[approval("run_main")]} onOpenApprovals={() => {}} />);
    await screen.findByTestId("evidence-card");
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 0");   // run_main belongs to the main conversation, not to this thread
  });

  const ROOM: Room = { id: "r1", name: "Lançamento", created_at: "2026-10-01T00:00:00Z", driver: { running: false, pending_actions_count: 0 },
    members: [{ member_id: "m1", bot: "vendas", handle: "vendas", display_name: "Vendas" }, { member_id: "m2", bot: "dev", handle: "dev", display_name: "Dev" }] };
  it("a room message draws the card too, with NO count and NO link (a room's approvals are not tied to it: the screen does not know)", async () => {
    setCustomFetchJSON(async (url: string) => {
      if (url.endsWith("/session")) return { csrf: "c", actor: "dashboard", auth_mode: "gated" };
      if (url.includes("/rooms/r1/log")) return { events: [{ seq: 1, event_id: "e1", kind: "message.member", actor: { kind: "member", id: "vendas" }, payload: { text: ANSWER }, at: "2026-10-01T01:00:00Z" }] };
      if (url.endsWith("/rooms/r1")) return { room: ROOM };
      if (url.includes("/handoffs")) return { handoffs: [] };
      return {};
    });
    render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    expect(await screen.findByTestId("evidence-card")).toBeTruthy();
    expect(screen.getByTestId("evidence-top").textContent).toBe(TOP);
    expect(screen.queryByTestId("evidence-in-box")).toBeNull();
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
  });
});

describe("in the app: the count comes from the shell's own list, and the link opens the box (on a phone too)", () => {
  const bot: Bot = { name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle", display: { label: "Vendas", role: "Prospecção", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } } };
  const phone = () => vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
  let held: (() => void) | null = null;                                                         // the approvals request kept open on purpose, released at the end of the test
  afterEach(() => { held?.(); held = null; });
  async function openConversationWithEvidence(pending: Approval[] | "never") {
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
      if (method === "GET" && /\/bots$/.test(url)) return { bots: [bot] };
      if (method === "GET" && url.includes("/approvals")) return pending === "never" ? new Promise((r) => { held = () => r({ approvals: [] }); }) : { approvals: pending };
      if (method === "GET" && url.includes("/budget")) return { limits: [], paused: [], watcher: { last_at: null }, alerts: [] };
      if (method === "POST" && url.endsWith("/bots/vendas/sessions")) return { session: { id: "s1" } };
      if (method === "POST" && url.endsWith("/runs")) return { run: { id: "run_1", status: "started", session_id: "s1" } };
      if (method === "GET" && url.includes("/runs/")) return { run: { id: "run_1", status: "completed" } };
      return {};
    });
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) { ctl = c; } }), { status: 200, headers: { "content-type": "text/event-stream" } }) };
    render(<LuveBotApp />);
    fireEvent.click(await screen.findByRole("button", { name: /Vendas/, pressed: false }));
    fireEvent.change(await screen.findByLabelText("Mensagem"), { target: { value: "resuma" } });
    fireEvent.click(screen.getByText("Enviar"));
    const enc = new TextEncoder();
    await waitFor(() => expect(ctl).toBeDefined());                                              // the run started: the stream is open
    await act(async () => {
      ctl.enqueue(enc.encode(`id: 1\ndata: ${JSON.stringify({ event: "message.delta", run_id: "run_1", seq: 1, delta: ANSWER })}\n\n`));
      ctl.enqueue(enc.encode(`id: 2\ndata: ${JSON.stringify({ event: "run.completed", run_id: "run_1", seq: 2, output: ANSWER })}\n\n`));
      ctl.close();
    });
  }

  it("a live answer: the card, 'Em Aprovações agora: 1' from the shell's approvals of run_1, and 'Abrir Aprovações' takes a phone to the Approvals screen (not back to the list)", async () => {
    phone();
    await openConversationWithEvidence([approval("run_1"), approval("run_other")]);
    expect((await screen.findByTestId("evidence-in-box")).textContent).toBe("Pedidos pendentes desta conversa: 1");
    fireEvent.click(screen.getByTestId("evidence-open-approvals"));
    await waitFor(() => expect(screen.queryByTestId("evidence-card")).toBeNull());               // left the conversation
    expect(await screen.findByRole("heading", { name: /Aprovações|Caixa de aprovações/i })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "sidebar" })).toBeNull();                 // the Approvals screen, not the contact list
  });

  it("the shell's approvals have NOT arrived yet: the card shows no count at all (never a 0 that would read 'the box has no such request')", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    await openConversationWithEvidence("never");
    expect(await screen.findByTestId("evidence-card")).toBeTruthy();
    expect(screen.queryByTestId("evidence-in-box")).toBeNull();
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
  });

  it("on a wide screen the same link opens Approvals with the list beside it", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    await openConversationWithEvidence([approval("run_1")]);
    fireEvent.click(await screen.findByTestId("evidence-open-approvals"));
    await waitFor(() => expect(screen.queryByTestId("evidence-card")).toBeNull());
    expect(screen.getByRole("complementary", { name: "sidebar" })).toBeTruthy();
  });
});
