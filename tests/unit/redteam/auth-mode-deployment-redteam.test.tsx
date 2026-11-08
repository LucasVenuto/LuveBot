// tests/unit/redteam/auth-mode-deployment-redteam.test.tsx (Lume, DT-1 attacked, 30/10): the server now answers `auth_mode: "deployment"` for the deployment credential of Hermes `main` (contract v0.11 5, DT-1).
// The screens that decide "is there a person here" read `auth_mode === "loopback"` (RunControls, MemoryView, RoutineSuggestions, Inactivity, Costs, Rules), so a third value falls on the side of the person: the answer
// box is enabled and the refusal comes only at the click (`403 credential_not_human`, in words since 02bf73c). The contract says the server decides at the click, and it does; but a screen that shows
// "no login" for loopback should show it for EVERY mode that is not a person (`auth_mode !== "gated"`: closed for a value nobody knows, as `identity.human_refusal` is on the server).
// `it.fails` = red the day it is fixed. Here for RunControls; the same line is in the five other components.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RunControls } from "@/components/chat/RunControls";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const clarify = { kind: "clarify", request_id: "q1", question: "Qual cliente?", choices: [], multi_select: false };
function world(auth: string) {
  const posts: unknown[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "session-token:deployment-token", auth_mode: auth };
    if (method === "GET" && url.endsWith("/bots/vendas/runs/r1")) return { run: { id: "r1", status: "started", execution_generation: 7, pending_controls: [clarify] } };
    if (method === "POST") { posts.push(url); return { clarify: { request_id: "q1", status: "resolved" } }; }
    throw new Error("unexpected " + method + " " + url);
  });
  return posts;
}
const mount = () => render(<RunControls bot="vendas" runId="r1" active pollMs={20} />);
// The session is read after the card is on screen (RunControls `useNoLoginKind`): the box shows up BEFORE the notice, so a check made on the box alone races the session under load. Wait for the notice (the credential sentence:
// `deployment` and every mode nobody knows get it, never the "Sem login" of loopback), then check the button.
const credentialNotice = () => screen.findByText(/não é um login que o LuveBot reconheça/);

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => setCustomFetchJSON(null));

describe("a session whose auth_mode is not `gated` is not a person, and the screen should say so before the click", () => {
  it("loopback: the notice and a disabled button (the control, pinned)", async () => {
    world("loopback");
    mount();
    await screen.findByText(/Sem login, o LuveBot não deixa responder pelo Bot/);
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
    expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a person (gated) can answer: the box and the button are live (the other control)", async () => {
    const posts = world("gated");
    mount();
    await screen.findByLabelText("Sua resposta");
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
    expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Sem login/)).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it("`deployment` (the deployment credential): the same notice and a disabled button, never a live one: the machine cannot answer a question", async () => {
    world("deployment");
    mount();
    await credentialNotice();
    fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
    expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a value nobody knows (a newer server, a typo, null) closes too: the screen is as closed as `identity.human_refusal` is", async () => {
    for (const auth of ["service", "", "GATED"]) {
      cleanup();
      world(auth);
      mount();
      await credentialNotice();
      fireEvent.change(screen.getByLabelText("Sua resposta"), { target: { value: "ok" } });
      expect((screen.getByRole("button", { name: "Responder" }) as HTMLButtonElement).disabled, auth).toBe(true);
    }
  });
});
