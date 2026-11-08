// tests/unit/pages/review-switch.test.tsx
// 21a (docs/contracts/pages-review-v0.md §1): the "Revisar antes de salvar" switch on a Bot's Pages. It is ONE rule made through the usual rules routes
// (ask, tools exactly write_file and patch, condition `path under workspace:pages`, scope this Bot): on = draft + activate, off = archive. The state
// shown is always the backend's re-read (GET /pages/review), never the click; the sentence "só vale para as ferramentas de arquivo do Hermes" is
// always there; "ligado" with an outdated hook says so; with no login (loopback) it is locked and says why; a backend without the route shows nothing.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, configure } from "@testing-library/react";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { ReviewSwitch } from "@/components/pages/ReviewSwitch";
import { isReviewRule } from "@/components/pages/review";
import type { Rule } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const HAND = { seal: "hand", mechanisms: [{ id: "hook_approve", verified: true, covers: ["write_file", "patch"] }], problems: [], qualifiers: ["paths_file_tools_only"] };
const OUTDATED = { seal: "broken", problems: [{ code: "hook_outdated", detail: "hook 0.5.0 is older than 0.6.0" }], qualifiers: ["paths_file_tools_only"] };
const PAGES = { fact: "path", op: "under", value: "workspace:pages" };
const rule = (over: Partial<Rule> & Record<string, unknown> = {}): Rule => ({
  id: "r-1", label: "Revisar antes de salvar páginas", level: "ask", scope: { kind: "bot", ref: "vendas" }, state: "draft", origin: "human", builtin: false, version: 1,
  match: { tools: ["write_file", "patch"], conditions: [PAGES] }, ...over,
}) as Rule;

type Call = { method: string; url: string; body?: any };
type World = { enabled: boolean; ruleId: string | null; seal: unknown; rules: Rule[]; authMode: string; patchError?: ApiError; reviewStatus?: number; scope?: "bot" | "global" | "absent"; pageSize?: number };
function backend(world: World) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "dashboard", auth_mode: world.authMode };
    if (method === "GET" && url.endsWith("/bots/vendas/pages/review")) {
      if (world.reviewStatus) throw new ApiError({ code: world.reviewStatus === 404 ? "not_found" : "server_error", message: "x", status: world.reviewStatus });
      const scope = world.scope === "absent" ? undefined : world.enabled ? world.scope ?? "bot" : null;   // "absent": an older backend that does not say
      return { enabled: world.enabled, rule_id: world.ruleId, ...(scope === undefined ? {} : { scope }), seal: world.enabled ? world.seal : null };
    }
    if (method === "GET" && url.includes("/rules")) {
      const from = Number(new URL(url, "http://x").searchParams.get("cursor") ?? 0), size = world.pageSize ?? world.rules.length;   // GET /rules pages (50 by default)
      const page = world.rules.slice(from, from + size);
      return { rules: page.map((r) => ({ rule: r, seal_result: { seal: "none" } })), next_cursor: from + size < world.rules.length ? String(from + size) : null };
    }
    if (method === "POST" && url.endsWith("/rules")) {
      const made = rule({ id: "r-new", ...body, state: "draft", version: 1 });
      world.rules.push(made);
      return { rule: made, seal_result: { seal: "none" } };
    }
    if (method === "PATCH" && url.endsWith("/rules")) {
      if (world.patchError) throw world.patchError;
      const r = world.rules.find((x) => x.id === body.id)!;
      r.state = body.state;
      world.enabled = body.state === "active";
      world.ruleId = world.enabled ? r.id : null;
      return { rule: r, seal_result: { seal: "none" } };
    }
    return {};
  });
  return calls;
}
const world = (over: Partial<World> = {}): World => ({ enabled: false, ruleId: null, seal: HAND, rules: [], authMode: "gated", ...over });
const swtch = () => screen.getByRole("switch", { name: "Revisar antes de salvar" }) as HTMLButtonElement;

beforeEach(() => { cleanup(); setLuveLocale("pt"); resetCsrfToken(); });
afterEach(() => { setCustomFetchJSON(null); });

describe("the switch", () => {
  it("off: says so, and always says it only covers Hermes's file tools", async () => {
    backend(world());
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByTestId("pages-review-status").textContent).toBe("Desligado: o Bot salva páginas sem pedir.");
    expect(screen.getByTestId("pages-review-scope").textContent).toMatch(/^Só vale para as ferramentas de arquivo do Hermes/);
  });

  it("on: creates ONE draft of the exact shape through the usual route, activates it, and shows what the backend says after (not the click)", async () => {
    const w = world();
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(swtch());
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    const post = calls.filter((c) => c.method === "POST");
    expect(post).toHaveLength(1);
    expect(post[0].url).toMatch(/\/rules$/);
    expect(post[0].body).toMatchObject({ level: "ask", scope: { kind: "bot", ref: "vendas" }, state: "draft", match: { tools: ["write_file", "patch"], conditions: [PAGES] } });
    expect(post[0].body.match.toolsets).toBeUndefined();
    expect(post[0].body.match.commands).toBeUndefined();
    const patch = calls.filter((c) => c.method === "PATCH");
    expect(patch).toHaveLength(1);
    expect(patch[0].body).toEqual({ id: "r-new", version: 1, state: "active" });
    expect(calls.map((c) => c.method + " " + c.url.split("?")[0].replace(/^.*\/api\/plugins\/luvebot/, "")).filter((x) => !x.endsWith("/session"))).toEqual([
      "GET /bots/vendas/pages/review", "GET /rules", "POST /rules", "PATCH /rules", "GET /bots/vendas/pages/review"]);   // the last read is what the screen shows
    expect(screen.getByTestId("pages-review-status").textContent).toBe("Ligado: antes de salvar uma página, o Bot pede a sua aprovação e você vê o que muda.");
  });

  it("a draft of the exact shape left by an activation that failed is used again, never a second copy", async () => {
    const w = world({ rules: [rule({ id: "r-left", version: 4 })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(swtch());
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ id: "r-left", version: 4, state: "active" });
  });

  it("off: archives that rule at the version just read", async () => {
    const w = world({ enabled: true, ruleId: "r-1", rules: [rule({ state: "active", version: 7 })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(swtch());
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ id: "r-1", version: 7, state: "archived" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("scope 'global': says it is on through a rule of every Bot and where to turn it off; no button to archive it, nothing is sent", async () => {
    const w = world({ enabled: true, ruleId: "r-global", scope: "global", rules: [rule({ id: "r-global", state: "active", scope: { kind: "global", ref: null } })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("pages-review-global").textContent).toBe("Ligado por uma regra de todos os Bots. Para desligar, vá em Regras: aqui ela desligaria para todos.");
    expect(swtch().disabled).toBe(true);
    fireEvent.click(swtch());
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(calls.filter((c) => c.url.includes("/rules"))).toHaveLength(0);                    // it did not even read the rules: there is nothing to archive here
  });

  it("scope 'global' with an outdated hook says both, and the hook sentence is never 'plain ligado'", async () => {
    backend(world({ enabled: true, ruleId: "r-global", scope: "global", seal: OUTDATED }));
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(screen.getByTestId("pages-review-status").textContent).toMatch(/^Ligado, mas o hook precisa ser atualizado\./));
    expect(screen.getByTestId("pages-review-global")).toBeTruthy();
  });

  it("scope 'bot': the switch still archives this Bot's own rule", async () => {
    const w = world({ enabled: true, ruleId: "r-1", scope: "bot", rules: [rule({ state: "active", version: 2 })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().disabled).toBe(false));
    expect(screen.queryByTestId("pages-review-global")).toBeNull();
    fireEvent.click(swtch());
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ id: "r-1", version: 2, state: "archived" });
  });

  it("turning it on while a global rule is already active (a stale read) creates no second rule", async () => {
    const w = world({ enabled: false, rules: [rule({ id: "r-global", state: "active", scope: { kind: "global", ref: null } })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(swtch());
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/rules")).length).toBeGreaterThan(0));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/pages/review")).length).toBe(2));   // re-read, as always
    expect(calls.filter((c) => c.method === "POST" || c.method === "PATCH")).toHaveLength(0);
  });

  it("an older backend that does not say the scope: the guard still refuses to archive a rule that is not this Bot's", async () => {
    const w = world({ enabled: true, ruleId: "r-global", scope: "absent", rules: [rule({ id: "r-global", state: "active", scope: { kind: "global", ref: null } })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(swtch());
    expect((await screen.findByRole("alert")).textContent).toContain("Desligue-a em Regras");
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);                    // the global rule is untouched
    expect(swtch().getAttribute("aria-checked")).toBe("true");
  });

  it("a refused change (no login on the server) leaves the switch where the backend says, with the reason", async () => {
    const w = world({ patchError: new ApiError({ code: "loopback_not_human", message: "no", status: 403 }) });
    backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(swtch());
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(swtch().getAttribute("aria-checked")).toBe("false");
    expect(swtch().disabled).toBe(false);
  });

  it("loopback (no login): locked before the click, with the reason, and nothing is sent", async () => {
    const calls = backend(world({ authMode: "loopback" }));
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().disabled).toBe(true));
    expect(screen.getByText(/Entre no painel do Hermes com senha/)).toBeTruthy();
    fireEvent.click(swtch());
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("the deployment token (a machine) and a mode nobody knows are not a person", () => {
  it("locked before the click with the credential's sentence, never the loopback one, and nothing is sent", async () => {
    const calls = backend(world({ authMode: "deployment" }));
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().disabled).toBe(true));
    expect(screen.getByText("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.")).toBeTruthy();
    expect(screen.queryByText(/Entre no painel do Hermes com senha/)).toBeNull();
    fireEvent.click(swtch());
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("a mode nobody knows, or none: locked the same (only `gated` is a person)", async () => {
    for (const authMode of ["", "service", "GATED"]) {
      cleanup();
      backend(world({ authMode }));
      render(<ReviewSwitch bot="vendas" />);
      await waitFor(() => expect(swtch().disabled, JSON.stringify(authMode)).toBe(true));
    }
  });
});

describe("what the seal says", () => {
  it("on with an outdated hook reads 'ligado, mas o hook precisa ser atualizado', never plain 'ligado'", async () => {
    backend(world({ enabled: true, ruleId: "r-1", seal: OUTDATED }));
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(screen.getByTestId("pages-review-status").textContent).toMatch(/^Ligado, mas o hook precisa ser atualizado\./));
    expect(screen.getByTestId("pages-review-status").textContent).not.toContain("você vê o que muda");
    expect(screen.getByTestId("seal-broken")).toBeTruthy();                                // the backend's seal, in its own words
    expect(screen.getByTestId("pages-review-scope").textContent).toContain("Só vale para as ferramentas de arquivo do Hermes");
  });

  it("an outdated hook offers 'Atualizar o hook deste Bot' (one click, then the switch is read again); a current one does not", async () => {
    const calls = backend(world({ enabled: true, ruleId: "r-1", seal: OUTDATED }));
    render(<ReviewSwitch bot="vendas" />);
    fireEvent.click(await screen.findByRole("button", { name: "Atualizar o hook deste Bot" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/bots/vendas/hook/install"))).toHaveLength(1));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/pages/review")).length).toBeGreaterThanOrEqual(2));
    cleanup();
    backend(world({ enabled: true, ruleId: "r-1", seal: HAND }));
    render(<ReviewSwitch bot="vendas" />);
    await screen.findByTestId("pages-review-switch");
    expect(screen.queryByRole("button", { name: "Atualizar o hook deste Bot" })).toBeNull();
  });

  it("any other problem of the seal is said as it is, never as plain 'ligado'", async () => {
    backend(world({ enabled: true, ruleId: "r-1", seal: { seal: "broken", problems: [{ code: "hook_stale", detail: "the hook table is old" }] } }));
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(screen.getByTestId("pages-review-status").textContent).toMatch(/^Ligado, mas há um problema:/));
    expect(screen.getByTestId("pages-review-problem").textContent).toBe("hook_stale: the hook table is old");
  });
});

describe("where it is not", () => {
  it("a backend without the route: no switch at all", async () => {
    backend(world({ reviewStatus: 404 }));
    const view = render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(screen.queryByTestId("pages-review")).toBeNull());
    await new Promise((r) => setTimeout(r, 50));
    expect(view.container.textContent).toBe("");
  });

  it("an answer that is not this route's (no `enabled`): no switch", async () => {
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "d", auth_mode: "gated" } : {}));
    const view = render(<ReviewSwitch bot="vendas" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(view.container.textContent).toBe("");
  });

  it("a read that fails says so quietly and offers to try again", async () => {
    backend(world({ reviewStatus: 500 }));
    render(<ReviewSwitch bot="vendas" />);
    expect((await screen.findByTestId("pages-review-error")).textContent).toContain("Não foi possível ler este interruptor agora.");
  });
});

describe("GET /rules pages: the switch follows the cursor", () => {
  const filler = (n: number) => Array.from({ length: n }, (_, i) => rule({ id: `r-x${i}`, label: `outra ${i}`, state: "active", match: { tools: ["terminal"] } }));

  it("off: the Bot's rule on the THIRD page is found and archived (it used to say 'não achei a regra')", async () => {
    const w = world({ enabled: true, ruleId: "r-1", scope: "bot", pageSize: 50, rules: [...filler(120), rule({ id: "r-1", state: "active", version: 9 })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(swtch());
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ id: "r-1", version: 9, state: "archived" });
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("/rules")).length).toBe(3);   // pages of 50: 50 + 50 + 21
  });

  it("on: a rule that already reviews, on page 2, creates no second one", async () => {
    const w = world({ enabled: false, pageSize: 50, rules: [...filler(60), rule({ id: "r-global", state: "active", scope: { kind: "global", ref: null } })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(swtch());
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/pages/review")).length).toBe(2));
    expect(calls.filter((c) => c.method === "POST" || c.method === "PATCH")).toHaveLength(0);
  });

  it("on: a draft left on page 2 is used again, not copied", async () => {
    const w = world({ enabled: false, pageSize: 50, rules: [...filler(60), rule({ id: "r-left", version: 3 })] });
    const calls = backend(w);
    render(<ReviewSwitch bot="vendas" />);
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(swtch());
    await waitFor(() => expect(swtch().getAttribute("aria-checked")).toBe("true"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ id: "r-left", version: 3, state: "active" });
  });
});

describe("which rule is the switch", () => {
  it("only the exact shape: ask, write_file + patch, path under workspace:pages, this Bot", () => {
    expect(isReviewRule(rule(), "vendas")).toBe(true);
    expect(isReviewRule(rule({ match: { tools: ["patch", "write_file"], conditions: [PAGES] } }), "vendas")).toBe(true);
    expect(isReviewRule(rule({ match: { tools: ["write_file"], conditions: [PAGES] } }), "vendas")).toBe(false);          // leaves patch open
    expect(isReviewRule(rule({ match: { tools: ["write_file", "patch"], conditions: [{ ...PAGES, op: "glob" }] } }), "vendas")).toBe(false);
    expect(isReviewRule(rule({ match: { tools: ["write_file", "patch"], commands: ["x"], conditions: [PAGES] } }), "vendas")).toBe(false);
    expect(isReviewRule(rule({ match: { tools: ["write_file", "patch"] } }), "vendas")).toBe(false);
    expect(isReviewRule(rule({ level: "allow" }), "vendas")).toBe(false);
    expect(isReviewRule(rule({ scope: { kind: "bot", ref: "dev" } }), "vendas")).toBe(false);
    expect(isReviewRule(rule({ builtin: true }), "vendas")).toBe(false);
  });
});
