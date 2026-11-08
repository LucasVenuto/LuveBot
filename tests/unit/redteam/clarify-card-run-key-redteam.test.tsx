// tests/unit/redteam/clarify-card-run-key-redteam.test.tsx (Lume, A-169, 30/10): the question card is keyed by run + request id, never by the request id alone. Hermes makes the id (uuid4 hex[:10], run_turn_runner.py:606)
// by chance, not by contract, so two runs of one Bot may show the SAME id for different questions. A card that is the same instance across the two keeps what belongs to the first: what was typed (it would be SENT as the
// answer to the second question) and "skipped" (the second question would be drawn closed, with no controls, and nobody could answer it). The cases are `it.fails`, red the day the card is keyed by run + request id and what the screen closed (the confirmation lines) is kept per run.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RunControls } from "@/components/chat/RunControls";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const same = (run: string) => ({ kind: "clarify", request_id: "x", question: `Pergunta de ${run}?`, choices: [], multi_select: false });
/** Two runs of one Bot, each listing a question with the SAME id. `lingers`: after a skip the first run keeps listing it (Hermes' lag), so the card is on screen when the person moves to the second run. */
function world() {
  const posts: any[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "x", auth_mode: "gated" };
    const m = /\/bots\/vendas\/runs\/(r[12])(\/|$)/.exec(url);
    if (method === "GET" && m) return { run: { id: m[1], status: "started", execution_generation: 7, pending_controls: [same(m[1])] } };
    if (method === "POST") { posts.push({ url, body: JSON.parse(String(init?.body)) }); return { clarify: { request_id: "x", status: "resolved" } }; }
    throw new Error("unexpected " + method + " " + url);
  });
  return posts;
}
/** Same as `world`, but each run lists its OWN id (a for r1, b for r2): here no card is shared, so what is left of the first run is its closed list. */
function worldOwnIds() {
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "x", auth_mode: "gated" };
    const m = /\/bots\/vendas\/runs\/(r[12])(\/|$)/.exec(url);
    if (method === "GET" && m) return { run: { id: m[1], status: "started", execution_generation: 7, pending_controls: [{ ...same(m[1]), request_id: m[1] === "r1" ? "a" : "b" }] } };
    if (method === "POST") return { clarify: { status: "resolved" } };
    throw new Error("unexpected " + method + " " + url);
  });
}
const view = (run: string) => <RunControls bot="vendas" runId={run} active pollMs={20} />;

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => setCustomFetchJSON(null));

describe("one card per run and question", () => {
  it("what was typed for the first run's question is not carried to the second run's question with the same id", async () => {
    world();
    const { rerender } = render(view("r1"));
    fireEvent.change(await screen.findByLabelText("Sua resposta"), { target: { value: "resposta para o r1" } });
    rerender(view("r2"));
    await screen.findByText("Pergunta de r2?");
    expect((screen.getByLabelText("Sua resposta") as HTMLTextAreaElement).value).toBe("");
  });

  it("a skip in the first run does not close the second run's question that has the same id", async () => {
    const posts = world();
    const { rerender } = render(view("r1"));
    await screen.findByText("Pergunta de r1?");
    fireEvent.click(screen.getByRole("button", { name: "Pular esta pergunta" }));
    await screen.findByText(/Pulada/);
    rerender(view("r2"));
    await screen.findByText("Pergunta de r2?");
    expect(screen.queryByText(/Pulada/)).toBeNull();
    const skip = screen.getByRole("button", { name: "Pular esta pergunta" }) as HTMLButtonElement;
    expect(skip.disabled).toBe(false);
    fireEvent.click(skip);
    await new Promise((r) => setTimeout(r, 60));
    expect(posts.map((p) => p.url.includes("/runs/r2/"))).toEqual([false, true]);
  });

  it("the confirmation line of a question closed in the first run is not drawn under the second run (the closed list is per run)", async () => {
    worldOwnIds();
    const { rerender } = render(view("r1"));
    await screen.findByText("Pergunta de r1?");
    fireEvent.click(screen.getByRole("button", { name: "Pular esta pergunta" }));
    await screen.findByText(/Pulada/);
    rerender(view("r2"));
    await screen.findByText("Pergunta de r2?");
    expect(screen.queryByText("Pergunta de r1?")).toBeNull();
    expect(screen.queryByText(/Pulada/)).toBeNull();
  });
});
