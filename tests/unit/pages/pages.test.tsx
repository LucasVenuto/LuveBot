// tests/unit/pages/pages.test.tsx
// Pages (contract v0.5, P3): honest states (never simulated pages), the reader never renders raw HTML, the page
// text never reaches localStorage, a 409 never saves on its own, autosave sends the loaded sha, the conversation
// card comes only from a valid slug, "Perguntar" adds page:{slug} without sending by itself, and ⌘K finds pages.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within, act } from "@testing-library/react";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { PagesLibrary } from "@/components/pages/PagesLibrary";
import { PageView } from "@/components/pages/PageView";
import { PagesSection } from "@/components/pages/PagesSection";
import { Conversation } from "@/components/conversation";
import { CommandPaletteModal } from "@/components/search/CommandPaletteModal";
import { lineDiff, markSeen, lastSeenSha, blockFromError, isSlug } from "@/components/pages/pages";
import type { Bot, Page } from "@/api/types";

const SHA1 = "a".repeat(64), SHA2 = "b".repeat(64), SHA3 = "c".repeat(64);
const bot: Bot = { name: "vendas", is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle", display: { label: "Vendas", role: "B2B", color: "#60a5fa", avatar: { kind: "initials", value: "VE" } } };
const page = (o: Partial<Page> = {}): Page => ({ slug: "proposta", title: "Proposta Alder", excerpt: "A Alder quer 750 licenças.", size: 10, mtime: "2026-10-01T14:00:00Z", sha: SHA1, rev: 4, author: "bot", author_label: "Vendas", by_you: false, changed_outside: false, editable: true, readonly_reason: null, ...o });
const CANARY = "conteudo-secreto-da-pagina-7f3a";
/** Every key and value in localStorage (Object.keys does not enumerate Storage in jsdom). */
const allStorage = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!).map((k) => `${k}=${localStorage.getItem(k)}`).join("\n");

type Call = { method: string; url: string; body?: any };
const err = (status: number, code?: string, details?: Record<string, unknown>) => ({ status, body: code ? JSON.stringify({ error: { code, message: code, details } }) : '{"detail":"Not Found"}' });

function api(routes: (c: Call) => unknown) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: "gated" };
    const r = routes(c);
    if (r && typeof r === "object" && "status" in (r as object) && "body" in (r as object)) throw r;
    return r;
  });
  return calls;
}

beforeEach(() => { cleanup(); setLuveLocale("pt"); resetCsrfToken(); try { localStorage.clear(); } catch { /* */ } });
afterEach(() => { vi.useRealTimers(); });

describe("Pages library: honest states, never simulated pages", () => {
  const health = (pages?: string) => ({ status: "ok", features: { runs: "ok", ...(pages ? { pages } : {}) }, problems: [] });

  it("an older backend (no features.pages) says Pages does not exist here and offers no create", async () => {
    api((c) => (c.url.endsWith("/health") ? health() : err(500)));
    render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText(/Páginas ainda não existe nesta instalação do LuveBot/)).toBeTruthy();
    expect(screen.queryByText("Nova página")).toBeNull();
    // the list is asked at once (health can take 5 s); health's verdict still wins and no page is shown
  });

  it("each workspace state shows the contract's copy, and an unknown state fails closed", async () => {
    for (const [state, copy] of [["no_workspace", /ainda não tem uma pasta de trabalho/], ["not_local", /terminal remoto ou em contêiner/], ["inside_hermes", /dentro do Hermes/], ["unsafe", /é um atalho/], ["weird", /Não deu para abrir as páginas agora/]] as const) {
      api((c) => (c.url.endsWith("/health") ? health("ok") : { workspace: { state }, pages: [page()], skipped: 0 }));
      render(<PagesLibrary bot={bot} onOpen={() => {}} />);
      expect(await screen.findByText(copy)).toBeTruthy();
      expect(screen.queryByText("Proposta Alder")).toBeNull();
      cleanup();
    }
  });

  it("no_workspace offers 'Criar a pasta do Bot' (the attachments' route) instead of sending the person to config.yaml; then the pages load", async () => {
    let made = false;
    const calls = api((c) => c.url.endsWith("/health") ? health("ok")
      : c.method === "POST" && c.url.endsWith("/bots/vendas/workspace") ? (made = true, { workspace: { state: "empty" } })
      : made ? { workspace: { state: "ready" }, pages: [page()], skipped: 0 } : { workspace: { state: "no_workspace" }, pages: [], skipped: 0 });
    render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText("Vendas ainda não tem uma pasta de trabalho para as Páginas.")).toBeTruthy();
    expect(screen.queryByText(/config\.yaml|terminal\.cwd/)).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);                     // nothing is made before the click
    fireEvent.click(screen.getByRole("button", { name: "Criar a pasta do Bot" }));
    expect(await screen.findByText("Proposta Alder")).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/plugins/luvebot/bots/vendas/workspace"]);
  });

  it("in the profile's Páginas card too; a state the folder does not fix, or a failure, is said in words", async () => {
    api((c) => c.method === "POST" ? { workspace: { state: "not_local" } } : { workspace: { state: "no_workspace" }, pages: [], skipped: 0 });
    render(<PagesSection bot="vendas" label="Vendas" onOpen={() => {}} onOpenAll={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar a pasta do Bot" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/terminal remoto ou em contêiner/);
    cleanup();
    api((c) => { if (c.method === "POST") throw err(503, "hermes_unreachable"); return { workspace: { state: "no_workspace" }, pages: [], skipped: 0 }; });
    render(<PagesSection bot="vendas" label="Vendas" onOpen={() => {}} onOpenAll={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Criar a pasta do Bot" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    cleanup();
    api(() => ({ workspace: { state: "inside_hermes" }, pages: [], skipped: 0 }));          // making a folder would not fix it
    render(<PagesSection bot="vendas" label="Vendas" onOpen={() => {}} onOpenAll={() => {}} />);
    expect(await screen.findByText(/dentro do Hermes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Criar a pasta do Bot" })).toBeNull();
  });

  it("a page route that answers 404 without our envelope means the dashboard runs an older LuveBot: restart it; 503 offers a retry", async () => {
    api((c) => (c.url.endsWith("/health") ? health("ok") : err(404)));
    render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText("Esta função ainda não está ativa: o painel do Hermes precisa ser reiniciado para carregar a versão nova do LuveBot.")).toBeTruthy();
    cleanup();
    api((c) => (c.url.endsWith("/health") ? health("ok") : err(503, "hermes_unavailable")));
    render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText(/Não deu para abrir as páginas agora/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeTruthy();
  });

  it("read_only lists the pages but hides 'Nova página'; empty says so", async () => {
    api((c) => (c.url.endsWith("/health") ? health("read_only") : { workspace: { state: "ready" }, pages: [page()], skipped: 0 }));
    render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText("Proposta Alder")).toBeTruthy();
    expect(screen.getByText(/não deixa o LuveBot salvar/)).toBeTruthy();
    expect(screen.queryByText("Nova página")).toBeNull();
    cleanup();
    api((c) => (c.url.endsWith("/health") ? health("ok") : { workspace: { state: "empty" }, pages: [], skipped: 0 }));
    render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText(/Nenhuma página ainda/)).toBeTruthy();
  });

  it("the excerpt is plain text, never Markdown or HTML; the 'changed' mark shows only for a page read before", async () => {
    markSeen("vendas", "proposta", SHA2); // read before, at another sha
    api((c) => (c.url.endsWith("/health") ? health("ok") : { workspace: { state: "ready" }, skipped: 0,
      pages: [page({ excerpt: "<b>negrito</b> **forte**" }), page({ slug: "nunca-lida", title: "Nunca lida", sha: SHA3 })] }));
    const { container } = render(<PagesLibrary bot={bot} onOpen={() => {}} />);
    expect(await screen.findByText("<b>negrito</b> **forte**")).toBeTruthy();
    expect(container.querySelector("b, strong")).toBeNull();
    expect(screen.getAllByRole("img", { name: "Mudou desde a sua última leitura" })).toHaveLength(1);
  });
});

describe("Page reader", () => {
  it("renders hostile Markdown inert (RT3 extension, contract test 14): no script, no img, no javascript: link", async () => {
    const hostile = "# T\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[clique](javascript:alert(1))";
    api((c) => (c.url.includes("/revisions/2") ? { rev: 2, sha: SHA2, author: "bot", author_label: "Vendas", by_you: false, origin_kind: "agent", at: "2026-10-01T13:00:00Z", size: 9, content: hostile, redacted: false }
      : c.url.endsWith("/revisions") ? { revisions: [{ rev: 2, sha: SHA2, author: "bot", author_label: "Vendas", by_you: false, origin_kind: "agent", at: "2026-10-01T13:00:00Z", size: 9 }], next_cursor: null }
      : { ...page(), content: hostile, redacted: false }));
    const { container } = render(<PageView bot={{ name: "vendas", label: "Vendas" }} slug="proposta" />);
    await screen.findByText(/Atualizada por Vendas/);
    const inert = () => {
      expect(container.querySelector("script, img, iframe, [onerror]")).toBeNull();
      expect(Array.from(container.querySelectorAll("a")).some((a) => /^javascript:/i.test(a.getAttribute("href") ?? ""))).toBe(false);
    };
    inert();
    fireEvent.click(screen.getByRole("button", { name: "Histórico" }));
    fireEvent.click(await screen.findByText(/revisão 2/));
    await screen.findByRole("button", { name: "Restaurar esta versão" });
    inert();
  });

  it("the page text never goes to localStorage: only the sha of the version read", async () => {
    api(() => ({ ...page(), content: `# Proposta\n${CANARY}`, redacted: false }));
    render(<PageView bot={{ name: "vendas", label: "Vendas" }} slug="proposta" />);
    await screen.findByText(/conteudo-secreto/);
    const stored = allStorage();
    expect(stored).not.toContain(CANARY);
    expect(lastSeenSha("vendas", "proposta")).toBe(SHA1);
  });

  it("markSeen refuses anything that is not a sha (mutation guard: page text cannot be stored)", () => {
    markSeen("vendas", "proposta", CANARY);
    expect(allStorage()).not.toContain(CANARY);
  });

  it("a redacted page is read-only with the contract's copy", async () => {
    api(() => ({ ...page({ editable: false, readonly_reason: "redacted" }), content: "# P\n[REDACTED]", redacted: true }));
    render(<PageView bot={{ name: "vendas", label: "Vendas" }} slug="proposta" />);
    expect(await screen.findByText(/parece um segredo/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Editar" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Page editor: autosave and conflict", () => {
  async function openEditor(routes: (c: Call) => unknown) {
    const calls = api((c) => (c.method === "GET" && c.url.endsWith("/pages/proposta") ? { ...page(), content: "# Proposta\nantes", redacted: false } : routes(c)));
    render(<PageView bot={{ name: "vendas", label: "Vendas" }} slug="proposta" />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
    return calls;
  }
  const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

  it("saves after 3 s idle with the sha it loaded, not one it computed", async () => {
    const calls = await openEditor(() => ({ page: page({ sha: SHA2, rev: 5, author: "human", author_label: "Você", by_you: true }), changed: true }));
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Texto da página em Markdown"), { target: { value: "# Proposta\ndepois" } });
    await act(async () => { vi.advanceTimersByTime(2900); });
    expect(puts(calls)).toHaveLength(0);
    await act(async () => { vi.advanceTimersByTime(200); });
    vi.useRealTimers();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0].body).toEqual({ content: "# Proposta\ndepois", base_sha: SHA1 });
    expect(await screen.findByText(/Salvo às/)).toBeTruthy();
  });

  it("a 409 never saves on its own; 'Gravar a minha por cima' writes only on the click, with the sha just read", async () => {
    let n = 0;
    const calls = await openEditor((c) => {
      if (c.method === "PUT") return ++n === 1 ? err(409, "page_conflict", { current_sha: SHA3, changed_by: "bot", changed_by_label: "Vendas" }) : { page: page({ sha: "d".repeat(64) }), changed: true };
      return undefined;
    });
    fireEvent.change(screen.getByLabelText("Texto da página em Markdown"), { target: { value: "# Proposta\nminha" } });
    fireEvent.blur(screen.getByLabelText("Texto da página em Markdown"));
    expect(await screen.findByText(/Vendas alterou esta página/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 1200)); // no automatic retry, even after the pace window
    expect(puts(calls)).toHaveLength(1);
    // The next GET returns the Bot's version (sha SHA3) before writing over it.
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const c: Call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(c);
      if (url.endsWith("/session")) return { csrf: "csrf-1" };
      if (c.method === "GET") return { ...page({ sha: SHA3 }), content: "# Proposta\ndo Bot", redacted: false };
      return { page: page({ sha: "d".repeat(64) }), changed: true };
    });
    fireEvent.click(screen.getByRole("button", { name: "Gravar a minha por cima" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect(puts(calls)[1].body).toEqual({ content: "# Proposta\nminha", base_sha: SHA3 });
  });
});

describe("Pages in the conversation", () => {
  const sse = (frames: Array<[string, object]>) => new ReadableStream<Uint8Array>({
    start(c) { const e = new TextEncoder(); for (const [ev, d] of frames) c.enqueue(e.encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)); c.close(); },
  });
  function conv(frames: Array<[string, object]>, extra: Partial<React.ComponentProps<typeof Conversation>> = {}) {
    const calls = api((c) => (c.url.endsWith("/sessions") ? { session: { id: "s1" } }
      : c.method === "POST" && c.url.endsWith("/runs") ? { run: { id: "run_1", status: "started" } }
      : c.method === "POST" && c.url.endsWith("/pages") ? { page: page({ slug: "resumo", title: "Resumo" }) }
      : { run: { id: "run_1", status: "completed" } }));
    const fetcher = async () => new Response(sse(frames), { status: 200, headers: { "content-type": "text/event-stream" } });
    render(<Conversation bot={{ name: "vendas", label: "Vendas" }} fetcher={fetcher} pollMs={10} {...extra} />);
    return calls;
  }
  const send = (text = "oi") => { fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value: text } }); fireEvent.click(screen.getByText("Enviar")); };

  it("luvebot.page.updated becomes a page card only for a valid slug; the card has no svg", async () => {
    const onOpenPage = vi.fn();
    conv([["luvebot.page.updated", { slug: "../SOUL", rev: 1, title: "Mau" }], ["luvebot.page.updated", { slug: "proposta", rev: 5, title: "Proposta Alder" }], ["run.completed", { output: "" }]], { onOpenPage });
    send();
    expect(await screen.findByText("Proposta Alder")).toBeTruthy();
    expect(screen.queryByText("Mau")).toBeNull();
    const turn = document.querySelector("[data-turn]")!;
    expect(turn.querySelector("svg")).toBeNull();
    fireEvent.click(within(turn as HTMLElement).getByRole("button", { name: "Abrir a página Proposta Alder" }));
    expect(onOpenPage).toHaveBeenCalledWith("proposta");
  });

  it("'Perguntar' puts a chip above the composer, sends nothing by itself, then adds page:{slug} to the run", async () => {
    const onClearAsk = vi.fn();
    const calls = conv([["run.completed", { output: "" }]], { askAbout: { slug: "proposta", title: "Proposta Alder" }, onClearAsk });
    expect(screen.getByText("Sobre a página Proposta Alder")).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/runs"))).toBe(false);
    send("Quais são os riscos?");
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/runs"))).toBe(true));
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/runs"))!.body).toMatchObject({ input: "Quais são os riscos?", page: { slug: "proposta" } });
    expect(JSON.stringify(calls.find((c) => c.url.endsWith("/runs"))!.body)).not.toContain("[luvebot:page]"); // the server builds the note
    expect(onClearAsk).toHaveBeenCalled();
  });

  it("'Salvar como página do Bot' (in the reply's … menu) creates the page with the answer's text; it never overwrites an existing one", async () => {
    const onOpenPage = vi.fn();
    const calls = conv([["message.delta", { delta: "# Resumo da semana\nTudo certo." }], ["run.completed", { output: "" }]], { onOpenPage });
    send();
    fireEvent.click(await screen.findByRole("button", { name: "Mais ações desta mensagem" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Salvar como página do Bot" }));
    expect((screen.getByLabelText("Título") as HTMLInputElement).value).toBe("Resumo da semana");
    fireEvent.click(screen.getByRole("button", { name: "Criar" }));
    await waitFor(() => expect(onOpenPage).toHaveBeenCalledWith("resumo"));
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/pages"))!;
    expect(post.body).toEqual({ title: "Resumo da semana", content: "# Resumo da semana\nTudo certo." });
  });

  // T11.5: the reply's … menu (no fixed link under every answer)
  it("no 'Salvar como página' link sits under the reply; the action lives in the menu, with a hint of what it does", async () => {
    conv([["message.delta", { delta: "Pronto." }], ["run.completed", { output: "" }]], {});
    send();
    const more = await screen.findByRole("button", { name: "Mais ações desta mensagem" });
    expect(screen.queryByRole("button", { name: /Salvar como página/ })).toBeNull();
    expect(screen.queryByText(/Salvar como página/)).toBeNull();
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    const item = screen.getByRole("menuitem", { name: "Salvar como página do Bot" });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(item.getAttribute("aria-describedby") && document.getElementById(item.getAttribute("aria-describedby")!)?.textContent)
      .toBe("Guarda esta resposta como um documento do Bot, para abrir e editar depois em Páginas.");
  });

  it("works from the keyboard: ArrowDown opens and focuses the item, Esc closes and returns focus to …", async () => {
    conv([["message.delta", { delta: "Pronto." }], ["run.completed", { output: "" }]], {});
    send();
    const more = await screen.findByRole("button", { name: "Mais ações desta mensagem" });
    more.focus();
    fireEvent.keyDown(more, { key: "ArrowDown" });
    const item = await screen.findByRole("menuitem", { name: "Salvar como página do Bot" });
    await waitFor(() => expect(document.activeElement).toBe(item));
    fireEvent.keyDown(item, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  it("a long press on the reply opens the same menu on a touch screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      conv([["message.delta", { delta: "Pronto." }], ["run.completed", { output: "" }]], {});
      send();
      const reply = await screen.findByText("Pronto.");
      // jsdom has no PointerEvent: build the touch press the browser would send
      const down = new MouseEvent("pointerdown", { bubbles: true });
      Object.defineProperty(down, "pointerType", { value: "touch" });
      act(() => { reply.dispatchEvent(down); });
      act(() => { vi.advanceTimersByTime(600); });
      expect(screen.getByRole("menuitem", { name: "Salvar como página do Bot" })).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it("a reply whose turn failed has no menu (only a finished answer can be saved)", async () => {
    conv([["message.delta", { delta: "Escrevendo..." }], ["run.failed", { error: "x" }]], {});
    send();
    await screen.findByText("Escrevendo...");
    expect(screen.queryByRole("button", { name: "Mais ações desta mensagem" })).toBeNull();
  });
});

describe("Pages elsewhere", () => {
  it("the profile section lists the 3 newest and 'Ver todas (n)'", async () => {
    api(() => ({ workspace: { state: "ready" }, skipped: 0, pages: ["a", "b", "c", "d"].map((s) => page({ slug: s, title: `Página ${s}` })) }));
    const onOpen = vi.fn();
    render(<PagesSection bot="vendas" onOpen={onOpen} onOpenAll={() => {}} />);
    expect(await screen.findByText("Página a")).toBeTruthy();
    expect(screen.queryByText("Página d")).toBeNull();
    expect(screen.getByRole("button", { name: "Ver todas (4)" })).toBeTruthy();
    fireEvent.click(screen.getByText("Página b"));
    expect(onOpen).toHaveBeenCalledWith("b");
  });

  it("⌘K searches each Bot's pages and opens the one picked; a Bot whose Pages cannot open is skipped", async () => {
    const other: Bot = { ...bot, name: "atlas", display: { ...bot.display!, label: "Atlas" } };
    const calls = api((c) => c.url.includes("/bots/vendas/pages") ? { workspace: { state: "ready" }, skipped: 0, pages: [page()] }
      : c.url.includes("/bots/atlas/pages") ? { workspace: { state: "no_workspace" }, skipped: 0, pages: [page({ title: "Não deve aparecer" })] }
      : { messages: [], bots: [], rooms: [], routines: [], files: [], actions: [] });
    const onSelectPage = vi.fn();
    render(<CommandPaletteModal isOpen onClose={() => {}} availableBots={[bot, other]} onSelectPage={onSelectPage} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pro" } });
    fireEvent.click(await screen.findByText("Proposta Alder"));
    expect(onSelectPage).toHaveBeenCalledWith("vendas", "proposta");
    expect(screen.queryByText("Não deve aparecer")).toBeNull();
    expect(calls.some((c) => c.url.includes("/bots/vendas/pages?q=pro"))).toBe(true);
  });
});

describe("pages.ts", () => {
  it("slug rule, diff and error mapping", () => {
    expect(isSlug("proposta-alder")).toBe(true);
    for (const bad of ["../SOUL", "a/b", "X", "", "x.md", "-a"]) expect(isSlug(bad)).toBe(false);
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([{ kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "same", text: "c" }, { kind: "add", text: "d" }]);
    expect(blockFromError({})).toBe("error");
  });
});
