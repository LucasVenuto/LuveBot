// tests/unit/redteam/skip-button-modes-redteam.test.tsx (Lume, K-3b attacked, 30/10): the Skip button is "enabled exactly when the answer controls are" (contract v0.11 4.1), and the answer controls are enabled for every
// auth_mode that is not `loopback` (F-DT5, fixed: only `gated` is a person). The control (a person), the loopback case and the machine's modes (`deployment` and a mode nobody knows) are pinned: the card draws before the
// session is read, so the button is looked at only after the screen has had the answer (waitFor), never at the first paint. Also the scenarios the card's own tests do not make: a skip, then the NEXT question with ANOTHER id in the same poll, must be a fresh card.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { RunControls } from "@/components/chat/RunControls";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const clarify = (id: string, over: Record<string, unknown> = {}) => ({ kind: "clarify", request_id: id, question: `Pergunta ${id}?`, choices: [], multi_select: false, ...over });
function world(auth: string, controls: () => any[], onPost?: (body: any) => void) {
  const posts: any[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "x", auth_mode: auth };
    if (method === "GET" && url.endsWith("/bots/vendas/runs/r1")) return { run: { id: "r1", status: "started", execution_generation: 7, pending_controls: controls() } };
    if (method === "POST") { const body = JSON.parse(String(init?.body)); posts.push(body); onPost?.(body); return { clarify: { request_id: body.request_id, status: "resolved" } }; }
    throw new Error("unexpected " + method + " " + url);
  });
  return posts;
}
const mount = () => render(<RunControls bot="vendas" runId="r1" active pollMs={20} />);
const skipButton = () => screen.getByRole("button", { name: "Pular esta pergunta" }) as HTMLButtonElement;

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => setCustomFetchJSON(null));

describe("the Skip button follows the answer controls, whatever the mode", () => {
  it("a person: live; loopback: disabled with the notice (the controls)", async () => {
    world("gated", () => [clarify("q1")]);
    mount();
    await screen.findByLabelText("Sua resposta");
    expect(skipButton().disabled).toBe(false);
    cleanup();
    world("loopback", () => [clarify("q1")]);
    mount();
    await screen.findByText(/Sem login, o LuveBot não deixa responder pelo Bot/);
    expect(skipButton().disabled).toBe(true);
  });

  it("`deployment`, or a mode nobody knows: disabled too, for the machine cannot skip a question any more than answer one", async () => {
    for (const auth of ["deployment", "service", "", "GATED"]) {
      cleanup();
      world(auth, () => [clarify("q1")]);
      mount();
      await screen.findByLabelText("Sua resposta");
      await waitFor(() => expect(skipButton().disabled, auth).toBe(true));
      expect(screen.getByRole("status").textContent, auth).not.toMatch(/Sem login/);                    // the machine is told its own sentence, never the loopback one
    }
  });
});

describe("one card per question", () => {
  it("a skip, then the poll returns the NEXT question (another id): a fresh card with its own controls, nothing carried over", async () => {
    let step = 0;
    const posts = world("gated", () => (step === 0 ? [clarify("q1")] : [clarify("q2", { choices: ["a", "b"] })]), () => { step = 1; });
    mount();
    await screen.findByText("Pergunta q1?");
    fireEvent.click(skipButton());
    await screen.findByText("Pergunta q2?");
    // the card that was skipped stays as ITS confirmation (closed, focused, no controls); the new one is a card of its own: no "Pulada", its own controls, nothing carried over
    const [old, fresh] = screen.getAllByTestId("clarify-card");
    expect(old.textContent).toContain("Pergunta q1?");
    expect(old.querySelector('[role="status"]')?.textContent).toMatch(/Pulada/);
    expect(old.querySelectorAll("button")).toHaveLength(0);
    expect(fresh.textContent).toContain("Pergunta q2?");
    expect(fresh.textContent).not.toMatch(/Pulada/);
    expect(fresh.querySelector('[role="status"]')).toBeNull();
    expect(screen.getAllByText(/Pulada/)).toHaveLength(1);
    expect(posts).toEqual([{ request_id: "q1", execution_generation: 7, skip: true }]);
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(skipButton().disabled).toBe(false);
    fireEvent.click(skipButton());
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ request_id: "q2", execution_generation: 7, skip: true });
  });

  it("a skip refused as stale leaves the card live; the skip is then sent again ONCE with the same body, and an answer after a skip that failed is an answer, never a skip", async () => {
    let calls = 0;
    const posts: any[] = [];
    setCustomFetchJSON(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "x", auth_mode: "gated" };
      if (method === "GET") return { run: { id: "r1", status: "started", execution_generation: 7, pending_controls: [clarify("q1")] } };
      posts.push(JSON.parse(String(init?.body)));
      if (++calls === 1) { const { ApiError } = await import("@/api/client"); throw new ApiError({ code: "request_not_pending", message: "x", status: 409 }); }
      return { clarify: { request_id: "q1", status: "resolved" } };
    });
    mount();
    await screen.findByText("Pergunta q1?");
    fireEvent.click(skipButton());
    await screen.findByRole("alert");
    expect(skipButton().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "sim" } });
    fireEvent.click(screen.getByRole("button", { name: "Responder" }));
    await screen.findByText("Resposta enviada. O Bot segue daqui.");
    expect(posts).toEqual([{ request_id: "q1", execution_generation: 7, skip: true }, { request_id: "q1", execution_generation: 7, answer: "sim" }]);
  });

  it("two quick clicks on Skip send ONE request (the second click lands on a disabled button)", async () => {
    const posts = world("gated", () => [clarify("q1")]);
    mount();
    await screen.findByText("Pergunta q1?");
    const button = skipButton();
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/Pulada/);
    expect(posts).toHaveLength(1);
  });
});
