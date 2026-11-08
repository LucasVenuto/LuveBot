// tests/unit/voice/language.test.tsx (docs/contracts/voice-language-reactions-v0.md section 2 and A-281, slice VL-2)
// The voice language of a Bot, from the screen's side: what the status says is read as it is and never guessed; the Voice card in the profile (three choices, the providers read only, "Definido no Hermes: fr" for a value
// the person set outside pt/en); the ONE line under the Radio, keyed on the RAW `stt.language` being empty (never on `auto`, never on `other`), with ONE click that writes the SCREEN's language and nothing written before it;
// "Transcrevendo… N s" and the line after 8 s; and "Aplicar o idioma da tela a todos os Bots", the screen's own loop of the same PUT, one Bot at a time: a failure stops nobody, nothing is undone, and it says "N de M" and who failed.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within, act, configure } from "@testing-library/react";
import { VoiceCard } from "@/components/agent/VoiceCard";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { VoiceLanguageAll } from "@/components/settings/VoiceLanguageAll";
import { RadioLanguageLine } from "@/voice/RadioLanguageLine";
import { RadioStrip, SLOW_AFTER_S } from "@/voice/RadioStrip";
import { applyLanguageToAll, readVoiceSettings, sttLanguageEmpty } from "@/voice/language";
import { setCustomFetchJSON, resetCsrfToken, ApiError } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot, VoiceSettings } from "@/api/types";

configure({ asyncUtilTimeout: 10_000 });

const S = (language: VoiceSettings["language"], raw: string | null, extra: Partial<VoiceSettings> = {}): VoiceSettings => ({
  stt: { provider: "local", language: raw }, tts: { provider: "edge", voice: "en-US-AriaNeural" }, language, ...extra });
const STATUS = (settings: unknown) => ({ radio: { available: true, reason: null }, call: { available: false, reason: "no_openai_key", cents_per_minute: 5, max_seconds: 900, max_delegations: 6 }, client_direct: false, ...(settings === undefined ? {} : { settings }) });
const bot = (name: string, label = name): Bot => ({ name, display: { label } } as unknown as Bot);

type Call = { method: string; url: string; body?: unknown; csrf: string | null };
let calls: Call[];
let status: Record<string, unknown | Error>;          // GET /bots/{bot}/voice, by Bot
let put: (bot: string, body: { language: string }) => unknown;
let inFlight = 0, maxInFlight = 0;
function backend() {
  calls = []; inFlight = 0; maxInFlight = 0;
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    const name = url.match(/\/bots\/([^/]+)\/voice(?:\/language)?$/)?.[1];
    if (name && method === "GET") { const v = status[name]; if (v instanceof Error) throw v; return v; }
    if (name && method === "PUT") {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { await new Promise((r) => setTimeout(r, 5)); const r = put(name, JSON.parse(String(init!.body))); if (r instanceof Error) throw r; return r; } finally { inFlight--; }
    }
    if (url.includes("/activity")) return { items: [] };
    if (url.includes("/routines")) return { routines: [] };
    if (url.endsWith("/budget")) return { limits: [], paused: [], watcher: { last_at: 0, stale: false }, alerts: [] };
    if (/\/bots\/[^/]+$/.test(url)) return { name: "vendas", display: { label: "Vendas" }, soul: "", toolsets: [], mcp_servers: [] };
    return {};
  });
}
const puts = () => calls.filter((c) => c.method === "PUT");
const err = (code: string, status = 500) => new ApiError({ code, message: "English for developers", status });
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  status = {}; put = (_b, body) => ({ settings: S(body.language as VoiceSettings["language"], body.language === "auto" ? "" : body.language) }); backend();
});
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); vi.useRealTimers(); });

describe("what the server says is read as it is", () => {
  it("a status or a PUT answer with settings is read; the answer may be the settings or {settings}", () => {
    expect(readVoiceSettings(STATUS(S("pt", "pt")))).toEqual(S("pt", "pt"));
    expect(readVoiceSettings({ settings: S("auto", "") })).toEqual(S("auto", ""));
    expect(readVoiceSettings(S("other", "fr"))).toEqual(S("other", "fr"));
    expect(readVoiceSettings(S("en", null))?.stt.language).toBeNull();
  });
  it("a server older than VL-1, or an answer that is not the shape, is null: the screen then claims nothing", () => {
    for (const bad of [null, undefined, "x", {}, STATUS(undefined), STATUS({}), STATUS({ ...S("pt", "pt"), language: "fr" }), STATUS({ ...S("pt", "pt"), language: 3 }), STATUS({ ...S("pt", "pt"), stt: null }),
      STATUS({ ...S("pt", "pt"), tts: "edge" }), STATUS({ ...S("pt", "pt"), stt: { provider: "x", language: 4 } })]) expect(readVoiceSettings(bad)).toBeNull();
  });
  it("'no language set' is the RAW stt.language being empty: never `auto` alone, never `other`", () => {
    expect(sttLanguageEmpty(S("auto", ""))).toBe(true);
    expect(sttLanguageEmpty(S("auto", null))).toBe(true);
    expect(sttLanguageEmpty(S("auto", "   "))).toBe(true);
    expect(sttLanguageEmpty(S("auto", "xx"))).toBe(false);     // `auto` does not make it empty
    expect(sttLanguageEmpty(S("other", "fr"))).toBe(false);     // a language the person set in Hermes
    expect(sttLanguageEmpty(S("pt", "pt"))).toBe(false);
    expect(sttLanguageEmpty(S("en", "en"))).toBe(false);
    expect(sttLanguageEmpty(null)).toBe(false);                 // unknown is not empty
  });
});

describe("the Voice card in the Bot's profile", () => {
  it("shows the three choices with the current one marked, the providers read only, and writes nothing on sight", async () => {
    status = { vendas: STATUS(S("en", "en", { tts: { provider: "edge", voice: "en-US-AriaNeural" } })) };
    render(<VoiceCard bot="vendas" />);
    const section = (await screen.findByRole("heading", { name: "Voz" })).closest("section")!;
    const group = within(section).getByRole("radiogroup", { name: "Idioma da voz" });
    expect(within(group).getAllByRole("radio").map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([["Automático", "false"], ["Português", "false"], ["English", "true"]]);
    expect(section.textContent).toContain("Transcrição: local");
    expect(section.textContent).toContain("Voz: edge · en-US-AriaNeural");
    expect(section.textContent).toContain("O provedor e a voz se escolhem no Hermes.");
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(puts()).toEqual([]);
  });
  it("a tap saves at once: the body is EXACTLY {language}, with the CSRF header; the card shows what the server answered", async () => {
    status = { vendas: STATUS(S("auto", "")) };
    render(<VoiceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Português" }));
    await screen.findByText("Idioma da voz salvo.");
    expect(puts()).toEqual([{ method: "PUT", url: expect.stringMatching(/\/bots\/vendas\/voice\/language$/), body: { language: "pt" }, csrf: "csrf-1" }]);
    expect(screen.getByRole("radio", { name: "Português" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Automático" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: "Português" }));   // the same choice again writes nothing
    await settle();
    expect(puts()).toHaveLength(1);
  });
  it("a language the person set in Hermes outside pt/en: 'Definido no Hermes: fr', no choice marked, and the three still work", async () => {
    status = { vendas: STATUS(S("other", "fr")) };
    render(<VoiceCard bot="vendas" />);
    expect(await screen.findByText("Definido no Hermes: fr")).toBeTruthy();
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "false"]);
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    await screen.findByText("Idioma da voz salvo.");
    expect(puts().map((c) => c.body)).toEqual([{ language: "en" }]);
    expect(screen.queryByText(/Definido no Hermes/)).toBeNull();
  });
  it("the raw value is the person's text: shown as text with a hidden character made visible, cut, never as markup", async () => {
    status = { vendas: STATUS(S("other", `<img src=x onerror=alert(1)>${String.fromCodePoint(0x202e)}${"x".repeat(100)}`)) };
    render(<VoiceCard bot="vendas" />);
    const line = await screen.findByText(/^Definido no Hermes:/);
    expect(line.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(line.textContent).toContain("[U+202E]");
    expect(line.textContent).not.toContain(String.fromCodePoint(0x202e));
    expect([...(line.textContent as string)].length).toBeLessThan(100);
    expect(line.querySelector("img")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });
  it("a refusal is a sentence (never the server's English), the choice does not change, and a second try is possible", async () => {
    status = { vendas: STATUS(S("auto", "")) };
    put = () => err("loopback_not_human", 403);
    render(<VoiceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: "English" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("English for developers");
    expect(alert.textContent).toMatch(/login|entrar|sessão|pessoa/i);
    expect(screen.getByRole("radio", { name: "Automático" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Idioma da voz salvo.")).toBeNull();
    put = (_b, body) => ({ settings: S("en", body.language) });
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
    await screen.findByText("Idioma da voz salvo.");
  });
  it("an answer that is not the settings is read again; and one that says another language than asked is an error, never 'saved'", async () => {
    status = { vendas: STATUS(S("auto", "")) };
    put = () => ({ ok: true });
    render(<VoiceCard bot="vendas" />);
    status = { vendas: STATUS(S("pt", "pt")) };            // what the server holds after the write
    fireEvent.click(await screen.findByRole("radio", { name: "Português" }));
    await screen.findByText("Idioma da voz salvo.");
    expect(calls.filter((c) => c.method === "GET" && /\/voice$/.test(c.url)).length).toBeGreaterThanOrEqual(2);
    cleanup(); backend();
    status = { vendas: STATUS(S("auto", "")) };
    put = () => ({ settings: S("auto", "") });             // the server kept `auto` although `pt` was asked
    render(<VoiceCard bot="vendas" />);
    fireEvent.click(await screen.findByRole("radio", { name: "Português" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Não foi possível mudar o idioma da voz agora. Nada foi alterado.");
    expect(screen.queryByText("Idioma da voz salvo.")).toBeNull();
  });
  it("a server without settings (older), an unreadable status or no answer yet: no card", async () => {
    for (const s of [STATUS(undefined), err("hermes_unreachable"), STATUS({ language: "pt" })]) {
      cleanup(); backend(); status = { vendas: s };
      render(<VoiceCard bot="vendas" />);
      await waitFor(() => expect(calls.some((c) => /\/voice$/.test(c.url))).toBe(true));
      await settle();
      expect(document.body.textContent).toBe("");
    }
  });
  it("is in English too, and the providers that are not set say so", async () => {
    setLuveLocale("en");
    status = { vendas: STATUS({ stt: { provider: null, language: "" }, tts: { provider: null, voice: null }, language: "auto" }) };
    render(<VoiceCard bot="vendas" />);
    const section = (await screen.findByRole("heading", { name: "Voice" })).closest("section")!;
    expect(within(section).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Automatic", "Portuguese".replace("Portuguese", "Português"), "English"]);
    expect(section.textContent).toContain("Transcription: not set");
    expect(section.textContent).toContain("Voice: not set");
    expect(section.textContent).toContain("The provider and the voice are chosen in Hermes.");
  });
});

describe("in the Bot's profile, one Bot at a time", () => {
  const profile = (name: string) => ({ name, is_default: false, description: "", status: "idle", model: { provider: "p", name: "m" }, display: { label: name, role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "B" } } } as unknown as Bot);
  it("the profile has the Voice card for a Bot whose status carries settings, and none for an older server", async () => {
    status = { vendas: STATUS(S("pt", "pt")) };
    render(<AgentPanel bot={profile("vendas")} onOpenPage={() => {}} />);
    expect(await screen.findByRole("radio", { name: "Português" })).toBeTruthy();
    cleanup(); backend(); status = { vendas: STATUS(undefined) };
    render(<AgentPanel bot={profile("vendas")} onOpenPage={() => {}} />);
    await waitFor(() => expect(calls.some((c) => /bots\/vendas\/voice$/.test(c.url))).toBe(true));
    await settle();
    expect(screen.queryByRole("radio", { name: "Português" })).toBeNull();
  });
  it("switching Bot drops the previous Bot's card at once, and a LATE answer of the old Bot never shows under the new one; a tap writes to the Bot on screen only", async () => {
    let late!: (v: unknown) => void;
    status = { vendas: new Promise((r) => { late = r; }) as unknown as Record<string, unknown>, dev: STATUS(S("en", "en")) };
    const r = render(<VoiceCard bot="vendas" />);
    await waitFor(() => expect(calls.some((c) => /bots\/vendas\/voice$/.test(c.url))).toBe(true));
    r.rerender(<VoiceCard bot="dev" />);
    await screen.findByRole("radio", { name: "English" });
    late(STATUS(S("pt", "pt")));
    await settle();
    expect(screen.getByRole("radio", { name: "English" }).getAttribute("aria-checked")).toBe("true");   // still dev's
    fireEvent.click(screen.getByRole("radio", { name: "Português" }));
    await screen.findByText("Idioma da voz salvo.");
    expect(puts().map((c) => c.url.match(/bots\/([^/]+)\//)?.[1])).toEqual(["dev"]);
  });
});

describe("the line under the Radio", () => {
  const line = (settings: VoiceSettings | null, pressed = true, onSettings = vi.fn()) => render(<RadioLanguageLine bot="vendas" settings={settings} pressed={pressed} onSettings={onSettings} />);
  it("shows only after the Radio was pressed, only when the RAW stt.language is empty, with the contract's words and a button for the screen's language", async () => {
    line(S("auto", ""));
    expect(screen.getByText("A transcrição deste Bot não tem idioma definido e pode sair em inglês.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usar Português" })).toBeTruthy();
    await settle();
    expect(puts()).toEqual([]);                      // nothing written until the click
  });
  it.each([
    ["not pressed yet", S("auto", ""), false],
    ["`other` (a language set in Hermes)", S("other", "fr"), true],
    ["pt", S("pt", "pt"), true],
    ["en", S("en", "en"), true],
    ["`auto` with a raw value", S("auto", "xx"), true],
    ["settings unknown (older server)", null, true],
  ])("is not shown: %s", (_name, settings, pressed) => {
    line(settings, pressed);
    expect(screen.queryByTestId("radio-language-line")).toBeNull();
    expect(document.body.textContent).toBe("");
  });
  it("the click writes the SCREEN's language (Portuguese screen: pt; English screen: en), tells the parent the new settings and says it saved", async () => {
    const onSettings = vi.fn();
    line(S("auto", ""), true, onSettings);
    fireEvent.click(screen.getByRole("button", { name: "Usar Português" }));
    await screen.findByText("Idioma da voz salvo.");
    expect(puts().map((c) => c.body)).toEqual([{ language: "pt" }]);
    expect(onSettings).toHaveBeenCalledWith(S("pt", "pt"));
    expect(screen.queryByText(/não tem idioma definido/)).toBeNull();
    cleanup(); backend(); setLuveLocale("en");
    line(S("auto", ""));
    expect(screen.getByText("This Bot's transcription has no language set and may come out in English.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use English" }));
    await screen.findByText("Voice language saved.");
    expect(puts().map((c) => c.body)).toEqual([{ language: "en" }]);
  });
  it("a refusal is said in words and the line stays; nothing was marked saved", async () => {
    put = () => err("hermes_error", 502);
    line(S("auto", ""));
    fireEvent.click(screen.getByRole("button", { name: "Usar Português" }));
    expect((await screen.findByRole("alert")).textContent).not.toContain("English for developers");
    expect(screen.getByText("A transcrição deste Bot não tem idioma definido e pode sair em inglês.")).toBeTruthy();
    expect(screen.queryByText("Idioma da voz salvo.")).toBeNull();
  });
});

describe("Transcrevendo… N s, and the line after 8 s", () => {
  const strip = (provider: string | null) => render(<RadioStrip phase="sending" seconds={0} tapMode={false} onCancel={() => {}} provider={provider} />);
  it("counts the seconds, says nothing more before 8 s, and after 8 s names the provider and that the first time after a restart is the slowest", () => {
    vi.useFakeTimers();
    strip("local");
    expect(screen.getByText("Transcrevendo… 0 s")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("Transcrevendo… 3 s")).toBeTruthy();
    act(() => { vi.advanceTimersByTime((SLOW_AFTER_S - 3) * 1000 - 600); });
    expect(screen.queryByTestId("radio-slow")).toBeNull();
    act(() => { vi.advanceTimersByTime(1200); });
    expect(SLOW_AFTER_S).toBe(8);
    expect(screen.getByTestId("radio-slow").textContent).toBe("Demorou mais que o normal (local). A primeira vez depois de reiniciar costuma ser a mais lenta.");
  });
  it("without a provider the line has no parentheses; in English it is the English line", () => {
    vi.useFakeTimers();
    strip(null);
    act(() => { vi.advanceTimersByTime(9000); });
    expect(screen.getByTestId("radio-slow").textContent).toBe("Demorou mais que o normal. A primeira vez depois de reiniciar costuma ser a mais lenta.");
    cleanup(); setLuveLocale("en");
    strip("openai");
    expect(screen.getByText("Transcribing… 0 s")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(8500); });
    expect(screen.getByTestId("radio-slow").textContent).toBe("Slower than usual (openai). The first one after a restart is usually the slowest.");
  });
  it("the timer stops with the strip: nothing keeps ticking after it leaves", () => {
    vi.useFakeTimers();
    const { unmount } = strip("local");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Aplicar o idioma da tela a todos os Bots: the screen's own loop of the same PUT", () => {
  const BOTS = [bot("vendas", "Vendas"), bot("suporte", "Suporte"), bot("marketing", "Marketing")];
  const all = () => { status = { vendas: STATUS(S("auto", "")), suporte: STATUS(S("en", "en")), marketing: STATUS(S("auto", "")) }; };
  const names = (calls: Call[]) => calls.map((c) => c.url.match(/bots\/([^/]+)\//)?.[1]);
  const apply = async () => fireEvent.click(await screen.findByRole("button", { name: "Aplicar o idioma da tela a todos os Bots" }));
  it("nothing runs until the click; then every Bot is READ, one at a time, and each that changes gets one PUT with the screen's language; 'N de M aplicados'", async () => {
    all();
    render(<VoiceLanguageAll bots={BOTS} />);
    await screen.findByText("Muda a transcrição de cada Bot para Português, um por vez. Uma voz que você escolheu não é trocada, e um idioma definido no Hermes fica como está.");
    await settle();
    expect(puts()).toEqual([]);                                                  // nothing written on sight
    const readOnSight = calls.filter((c) => c.method === "GET" && /\/voice$/.test(c.url)).length;
    await apply();
    expect(await screen.findByText("3 de 3 aplicados.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET" && /\/voice$/.test(c.url)).slice(readOnSight).map((c) => c.url.match(/bots\/([^/]+)\//)?.[1])).toEqual(["vendas", "suporte", "marketing"]);
    expect(puts().map((c) => [names([c])[0], c.body, c.csrf])).toEqual([["vendas", { language: "pt" }, "csrf-1"], ["suporte", { language: "pt" }, "csrf-1"], ["marketing", { language: "pt" }, "csrf-1"]]);
    expect(maxInFlight).toBe(1);                                                 // never two writes at once
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("BEFORE the first write it says how many will change and how many stay (A-282), and every status was already read when it did", async () => {
    all(); status.marketing = STATUS(S("pt", "pt")); status.suporte = STATUS(S("other", "fr"));
    let atFirstWrite = "", readsAtFirstWrite = 0;
    put = (name, body) => {
      if (!atFirstWrite) { atFirstWrite = document.body.textContent ?? ""; readsAtFirstWrite = calls.filter((c) => c.method === "GET" && /\/voice$/.test(c.url)).length; }
      return { settings: S("pt", body.language) };
    };
    render(<VoiceLanguageAll bots={BOTS} />);
    await screen.findByRole("button", { name: "Aplicar o idioma da tela a todos os Bots" });
    await settle();
    const onSight = calls.filter((c) => c.method === "GET" && /\/voice$/.test(c.url)).length;   // the section's own look at the statuses
    await apply();
    await screen.findByText("1 de 3 aplicados.");
    expect(atFirstWrite).toContain("Bots que vão mudar para Português: 1. Ficam como estão: 2.");
    expect(readsAtFirstWrite - onSight).toBe(3);                                 // all three statuses read by the click, before the first write
    expect(screen.getByTestId("voice-all-plan").textContent).toBe("Bots que vão mudar para Português: 1. Ficam como estão: 2.");
  });
  it("a Bot already in the screen's language is NOT written (no empty audit row) and is named; one set in Hermes outside pt/en stays and is named", async () => {
    all(); status.marketing = STATUS(S("pt", "pt")); status.suporte = STATUS(S("other", "fr"));
    render(<VoiceLanguageAll bots={BOTS} />);
    await apply();
    expect(await screen.findByText("1 de 3 aplicados.")).toBeTruthy();
    expect(names(puts())).toEqual(["vendas"]);
    expect(screen.getByText("Já estavam em Português: Marketing.")).toBeTruthy();
    expect(screen.getByText("Ficaram como estão (idioma definido no Hermes): Suporte.")).toBeTruthy();
    expect(screen.queryByText(/Falharam/)).toBeNull();
  });
  it("a write that fails does not stop the others and nothing already written is undone; it says 'N de M' and WHICH Bot failed, by its name", async () => {
    all();
    put = (name, body) => (name === "suporte" ? err("hermes_error", 502) : { settings: S("pt", body.language) });
    render(<VoiceLanguageAll bots={BOTS} />);
    await apply();
    expect(await screen.findByText("2 de 3 aplicados.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Falharam: Suporte.");
    expect(names(puts())).toEqual(["vendas", "suporte", "marketing"]);            // the third still ran after the second failed
    expect(puts().every((c) => (c.body as { language: string }).language === "pt")).toBe(true);   // and nothing was rolled back
  });
  it("a Bot whose status cannot be read, or has no settings, is a failure and is NEVER written blind", async () => {
    all(); status.suporte = err("hermes_unreachable", 502); status.marketing = STATUS(undefined);
    render(<VoiceLanguageAll bots={BOTS} />);
    await apply();
    expect(await screen.findByText("1 de 3 aplicados.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Falharam: Suporte, Marketing.");
    expect(names(puts())).toEqual(["vendas"]);
  });
  it("in English: the screen's language is English, the words are English, and 'N of M' says who failed", async () => {
    setLuveLocale("en"); all(); status.marketing = STATUS(S("en", "en"));
    put = (name, body) => (name === "vendas" ? err("hermes_error", 502) : { settings: S("en", body.language) });
    render(<VoiceLanguageAll bots={BOTS} />);
    expect(await screen.findByText("Sets each Bot's transcription to English, one at a time. A voice you chose is not replaced, and a language set in Hermes stays as it is.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Apply the screen's language to all Bots" }));
    expect(await screen.findByText("0 of 3 applied.")).toBeTruthy();
    expect(screen.getByTestId("voice-all-plan").textContent).toBe("Bots that will change to English: 1. Left as they are: 2.");
    expect(screen.getByRole("alert").textContent).toBe("Failed: Vendas.");
    expect(screen.getByText("Already in English: Suporte, Marketing.")).toBeTruthy();
    expect(puts().every((c) => (c.body as { language: string }).language === "en")).toBe(true);
  });
  it("progress is said while it runs, and with no Bots the button is off", async () => {
    all();
    render(<VoiceLanguageAll bots={BOTS} />);
    await apply();
    await screen.findByText(/Lendo os Bots… \d de 3/);
    await screen.findByText(/Aplicando… \d de 3/);
    await screen.findByText("3 de 3 aplicados.");
    cleanup();
    render(<VoiceLanguageAll bots={[]} />);
    await settle();
    expect(document.body.textContent).toBe("");
  });
  it("on a server without VL-1 (no Bot's status has settings, or none can be read) the section is NOT there: no button that could only fail, and nothing is written", async () => {
    status = { vendas: STATUS(undefined), suporte: STATUS({ language: "pt" }), marketing: err("hermes_unreachable", 502) };
    render(<VoiceLanguageAll bots={BOTS} />);
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && /\/voice$/.test(c.url))).toHaveLength(3));
    await settle();
    expect(document.body.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
    expect(puts()).toEqual([]);
  });
  it("one Bot with settings is enough for the section to show", async () => {
    status = { vendas: STATUS(undefined), suporte: STATUS(S("auto", "")), marketing: err("hermes_unreachable", 502) };
    render(<VoiceLanguageAll bots={BOTS} />);
    expect(await screen.findByRole("button", { name: "Aplicar o idioma da tela a todos os Bots" })).toBeTruthy();
  });
  it("the loop reports each read and each write, says the plan once, and returns who was applied, already there, kept and failed", async () => {
    all(); status.marketing = STATUS(S("other", "de")); status.vendas = STATUS(S("pt", "pt"));
    put = (name, body) => (name === "suporte" ? err("hermes_error", 502) : { settings: S("pt", body.language) });
    const reads: Array<[number, number]> = [], steps: Array<[number, number]> = [], plans: Array<{ change: number; stay: number }> = [];
    const out = await applyLanguageToAll(BOTS, "pt", { onRead: (d, t) => reads.push([d, t]), onStep: (d, t) => steps.push([d, t]), onPlan: (p) => plans.push(p) });
    expect(out).toEqual({ applied: [], already: ["vendas"], kept: ["marketing"], failed: ["suporte"], total: 3 });
    expect(reads).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(plans).toEqual([{ change: 1, stay: 2 }]);
    expect(steps).toEqual([[1, 1]]);
    expect(await applyLanguageToAll([], "en")).toEqual({ applied: [], already: [], kept: [], failed: [], total: 0 });
  });
});
