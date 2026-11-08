// tests/unit/skills/skill-ask-dialog.test.tsx
// "Save as a skill" (contract v0.11 3.2 step 1): the cost line, the optional note (300 characters), ONE request with exactly the session and the note, no login needed (A-174), and every way it can be refused in words.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, configure } from "@testing-library/react";
import { SkillAskDialog, NOTE_MAX } from "@/components/skills/SkillAskDialog";
import { ApiError, resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

type Call = { method: string; url: string; body: any; csrf: string | null };
function world(answer: (call: Call) => unknown = () => ({ run: { id: "r1", status: "started", bot: "vendas", session_id: "s1" } }), auth = "gated") {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: auth };
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
const props = (over: Partial<React.ComponentProps<typeof SkillAskDialog>> = {}) => ({ open: true, bot: "vendas", session: "s1", busyTurn: false, onClose: vi.fn(), onAsked: vi.fn(), ...over });
const go = () => screen.getByRole("button", { name: "Pedir o rascunho" }) as HTMLButtonElement;
beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => setCustomFetchJSON(null));

describe("the request", () => {
  it("says what it is and what it costs BEFORE anything is sent, and sends nothing by itself", async () => {
    const calls = world();
    render(<SkillAskDialog {...props()} />);
    expect(screen.getByRole("dialog").textContent).toContain(translations.pt.skillAskIntro);
    expect(screen.getByRole("dialog").textContent).toContain("Isto gasta uma vez do seu Bot, dentro do teto de gasto dele.");
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(0);
  });

  it("sends exactly the session and the note, once, with the CSRF; the run it starts goes to the conversation, and the dialog does not close itself", async () => {
    const calls = world();
    const p = props();
    render(<SkillAskDialog {...p} />);
    fireEvent.change(screen.getByLabelText("Sobre o que a skill deve ser (opcional)"), { target: { value: "  enviar o relatório semanal  " } });
    fireEvent.click(go());
    await waitFor(() => expect(p.onAsked).toHaveBeenCalledTimes(1));
    expect((p.onAsked as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: "r1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", csrf: "csrf-1", body: { session_id: "s1", note: "enviar o relatório semanal" } });
    expect(calls[0].url).toMatch(/\/bots\/vendas\/skills\/draft$/);
  });

  it("no note, no note key; a blank note is no note", async () => {
    const calls = world();
    render(<SkillAskDialog {...props()} />);
    fireEvent.change(screen.getByLabelText("Sobre o que a skill deve ser (opcional)"), { target: { value: "   " } });
    fireEvent.click(go());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ session_id: "s1" });
  });

  it("the note stops at 300 characters, counted as the server counts (code points: an emoji is one)", () => {
    world();
    render(<SkillAskDialog {...props()} />);
    const field = screen.getByLabelText("Sobre o que a skill deve ser (opcional)") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "x".repeat(400) } });
    expect(field.value).toHaveLength(NOTE_MAX);
    expect(screen.getByText("300 de 300")).toBeTruthy();
    fireEvent.change(field, { target: { value: String.fromCodePoint(0x1f600).repeat(310) } });
    expect(Array.from(field.value)).toHaveLength(NOTE_MAX);
  });

  it("works with no login: the request is a typed-turn equivalent (A-174), so loopback and the deployment token are not blocked here", async () => {
    for (const auth of ["loopback", "deployment"]) {
      cleanup();
      const calls = world(undefined, auth);
      render(<SkillAskDialog {...props()} />);
      expect(go().disabled).toBe(false);
      fireEvent.click(go());
      await waitFor(() => expect(calls).toHaveLength(1));
    }
  });
});

describe("when it cannot be asked", () => {
  it("with no session (nothing said yet) or while a turn is running, the button is off and says why", async () => {
    const calls = world();
    render(<SkillAskDialog {...props({ session: null })} />);
    expect(go().disabled).toBe(true);
    cleanup();
    render(<SkillAskDialog {...props({ busyTurn: true })} />);
    expect(go().disabled).toBe(true);
    expect(screen.getByText("Espere o Bot terminar a resposta atual.")).toBeTruthy();
    fireEvent.click(go());
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(0);
  });

  it("a note with a hidden character is refused by the server and the dialog says so in words, not the server's English", async () => {
    world(() => { throw new ApiError({ code: "skill_invalid", message: "English for developers", status: 422, why: "hidden_characters" }); });
    render(<SkillAskDialog {...props()} />);
    fireEvent.click(go());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(translations.pt.skillNoteRefused);
    expect(alert.textContent).not.toContain("English for developers");
  });

  it("a paused Bot, a spent cap or any other refusal says its own general words, and the button is back for another try", async () => {
    world(() => { throw new ApiError({ code: "bot_paused", message: "x", status: 409 }); });
    render(<SkillAskDialog {...props()} />);
    fireEvent.click(go());
    expect((await screen.findByRole("alert")).textContent).toContain(translations.pt.errBotPaused);
    expect(go().disabled).toBe(false);
  });

  it("Hermes keeps the request for later (no run to follow): it says so, offers Fechar, and the request is not resent", async () => {
    const calls = world(() => ({ run: null, queued: true }));
    const p = props();
    render(<SkillAskDialog {...p} />);
    fireEvent.click(go());
    expect((await screen.findByText(translations.pt.skillAskQueued))).toBeTruthy();
    expect(p.onAsked).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Pedir o rascunho" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" }).pop()!);                  // the footer's (the dialog's X has the same name)
    expect(p.onClose).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("in English", () => {
    setLuveLocale("en");
    world();
    render(<SkillAskDialog {...props()} />);
    expect(screen.getByRole("dialog").textContent).toContain("This spends one turn of your Bot, within its spending cap.");
    expect(screen.getByRole("button", { name: "Ask for the draft" })).toBeTruthy();
  });
});
