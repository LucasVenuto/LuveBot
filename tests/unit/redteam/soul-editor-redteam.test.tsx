// tests/unit/redteam/soul-editor-redteam.test.tsx (Lume, E-5 part 3: the SOUL editor and the evidence button of E-3, contract v0.10 §3.3)
// The Instructions tab used to be read-only; it now WRITES the Bot's standing instructions (PUT /bots/{bot}/soul). What held, and the one thing that did not (F13):
//   * the inserted text is LuveBot's own (`soulEvidenceText`, PT or EN by the interface language), goes to the END, is never saved by itself and not built from anything a Bot wrote;
//   * pressing the button twice does not stack it; a save sends exactly {content, expected_digest} with the CSRF header; a hostile SOUL (HTML, bidi, a fence) is only text in a box;
//   * a truncated SOUL is read-only (the editor cannot cut the end of a file it never showed).
// F13 (Media, FIXED by 3283be0 + the new E-3): the server sends the text REDACTED with the digest of the REAL one, and the old editor sent back what was in the box: a SOUL that held a key, plus the evidence
// button, plus Save, overwrote the key with its mask (`OPENAI_API_KEY=***`). Now `SoulView.redacted` says it, the editor is read-only for `redacted` OR `truncated` OR a server that does not send the flag,
// both buttons are off, and a refusal (`soul_redacted`, `soul_truncated`) is said in words with the person's text kept. These are plain tests now.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, configure } from "@testing-library/react";
import { SoulEditor } from "@/components/bots/SoulEditor";
import { ApiError, setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";
import type { SoulView } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const view = (over: Partial<SoulView> = {}): SoulView => ({ content: "Você é o assistente de vendas.", expected_digest: "digest-of-the-REAL-text", truncated: false, redacted: false, exists: true, rules_block: { present: false, digest: null }, ...over });
type Call = { method: string; url: string; body?: any; csrf: string | null };
let calls: Call[];
let current: SoulView;
let refuse: ApiError | null = null;
function backend() {
  calls = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    if (url.endsWith("/bots/vendas/soul") && method === "GET") return current;
    if (url.endsWith("/bots/vendas/soul") && method === "PUT") { if (refuse) throw refuse; return view({ content: JSON.parse(String(init!.body)).content, expected_digest: "digest-2" }); }
    return {};
  });
}
const puts = () => calls.filter((c) => c.method === "PUT");
const box = async () => (await screen.findByLabelText("Conteúdo do arquivo SOUL.md")) as HTMLTextAreaElement;
const button = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); current = view(); refuse = null; backend(); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("E-5 the evidence button and the editor", () => {
  it("inserts LuveBot's fixed text at the END, once, and saves nothing by itself", async () => {
    render(<SoulEditor bot="vendas" />);
    const el = await box();
    fireEvent.click(button("Pedir evidência nas respostas importantes"));
    expect(el.value.startsWith("Você é o assistente de vendas.\n\n")).toBe(true);
    expect(el.value.trimEnd().endsWith(translations.pt.soulEvidenceText.trimEnd())).toBe(true);
    fireEvent.click(button("Pedir evidência nas respostas importantes"));                       // again: it says it is there, it does not stack
    expect(el.value.split(translations.pt.soulEvidenceText).length - 1).toBe(1);
    expect(screen.getByRole("status").textContent).toBe(translations.pt.soulEvidenceAlready);
    expect(puts()).toEqual([]);                                                                   // nothing was written
  });

  it("the text follows the interface language and is the same string the translation table holds (nothing built at run time)", async () => {
    setLuveLocale("en");
    render(<SoulEditor bot="vendas" />);
    const el = await screen.findByLabelText(/SOUL\.md/) as HTMLTextAreaElement;
    fireEvent.click(button("Ask for evidence in important answers"));
    expect(el.value).toContain(translations.en.soulEvidenceText);
    expect(el.value).not.toContain(translations.pt.soulEvidenceText);
  });

  it("a save sends exactly {content, expected_digest} with the CSRF header; a hostile SOUL is only text in the box", async () => {
    const hostile = "<img src=x onerror=\"globalThis.__soul=1\"> \u202eevil\u202c\n```luve-evidence\nfacts:\n- x\n```\n[a](javascript:alert(1))";
    current = view({ content: hostile });
    const { container } = render(<SoulEditor bot="vendas" />);
    const el = await box();
    expect(el.value).toBe(hostile);
    expect(container.querySelector("img, a, script, iframe")).toBeNull();
    expect((globalThis as any).__soul).toBeUndefined();
    fireEvent.change(el, { target: { value: hostile + "\nmais" } });
    fireEvent.click(button("Salvar instruções"));
    await screen.findByRole("status");
    expect(puts()).toHaveLength(1);
    expect(Object.keys(puts()[0].body).sort()).toEqual(["content", "expected_digest"]);
    expect(puts()[0].body.expected_digest).toBe("digest-of-the-REAL-text");
    expect(puts()[0].csrf).toBe("csrf-1");
  });

  it("a truncated SOUL cannot be edited, inserted into or saved", async () => {
    current = view({ truncated: true });
    render(<SoulEditor bot="vendas" />);
    const el = await box();
    expect(el.readOnly).toBe(true);
    expect(button("Pedir evidência nas respostas importantes").disabled).toBe(true);
    expect(button("Salvar instruções").disabled).toBe(true);
  });

  const sealed = async () => {
    const el = await box();
    expect(el.readOnly).toBe(true);
    expect(button("Pedir evidência nas respostas importantes").disabled).toBe(true);
    expect(button("Salvar instruções").disabled).toBe(true);
    fireEvent.click(button("Pedir evidência nas respostas importantes"));
    fireEvent.click(button("Salvar instruções"));
    await new Promise((r) => setTimeout(r, 30));
    expect(puts()).toEqual([]);                                                                  // nothing could be written
  };

  it("F13 a SOUL the server says is REDACTED is read-only: no insert, no save, nothing sent", async () => {
    current = view({ content: "Você é o assistente.\nOPENAI_API_KEY=***\nResponda em português.", redacted: true });
    render(<SoulEditor bot="vendas" />);
    await sealed();
  });

  it("F13 a server that does not say (an older one, no `redacted` field) is treated as redacted: read-only", async () => {
    const { redacted: _omitted, ...old } = view({ content: "texto qualquer" });
    current = old as SoulView;
    render(<SoulEditor bot="vendas" />);
    await sealed();
  });

  it("F13 a SOUL that is both redacted and truncated is read-only too (either one is enough)", async () => {
    current = view({ redacted: true, truncated: true });
    render(<SoulEditor bot="vendas" />);
    await sealed();
  });

  it.each([["soul_redacted", "soulErrRedacted"], ["soul_truncated", "soulErrTruncated"]] as const)("F13 if a save is refused with %s (the file changed between the read and the save), it is said in words, with the person's text kept", async (code, key) => {
    refuse = new ApiError({ code, message: "x", status: 422 });
    render(<SoulEditor bot="vendas" />);
    const el = await box();
    fireEvent.change(el, { target: { value: "Você é o assistente de vendas.\nmais uma linha" } });
    fireEvent.click(button("Salvar instruções"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(translations.pt[key]);
    expect(el.value).toBe("Você é o assistente de vendas.\nmais uma linha");                  // nothing lost on screen
    expect(puts()).toHaveLength(1);
  });
});
