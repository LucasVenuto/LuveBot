// tests/unit/ui/hermes-compat.test.tsx
// Invariant 9: the faixa de compatibilidade com o Hermes. Lê SÓ o `hermes` do /health (backend F2): `compat` decide; sem `compat`
// (backend antigo) ou "compatible", nada. "Não testado" pode ser dispensado (por versão, neste navegador); "não suportado" não.
// `isolation: host` tem a sua frase; `limits` lista em palavras o que não funciona, e um código desconhecido nunca aparece cru.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HermesCompatStrip, HermesTestedLine } from "@/components/messenger/HermesCompatStrip";
import { LuveBotApp } from "@/index";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { HealthHermesInfo } from "@/api/types";

const hermes = (over: Partial<HealthHermesInfo> = {}): HealthHermesInfo => ({ version: "0.22.2", display_version: "0.22.2", compat: "untested", limits: [], ...over });
const strip = () => screen.queryByTestId("hermes-compat");
const UNTESTED = "Este Hermes ainda não foi testado com o LuveBot. Deve funcionar, mas pode ter pequenos problemas.";

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); try { localStorage.clear(); } catch { /* */ } });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("faixa de compatibilidade com o Hermes", () => {
  it("no strip when /health says nothing about compat (older backend), says compatible, or there is no health yet", () => {
    for (const h of [hermes({ compat: undefined }), hermes({ compat: "compatible" }), null, undefined]) {
      const r = render(<HermesCompatStrip hermes={h} />);
      expect(strip()).toBeNull();
      r.unmount();
    }
  });

  it("não testado: says it plainly with the version, can be dismissed, and the dismissal holds for that version only", () => {
    const r = render(<HermesCompatStrip hermes={hermes()} />);
    expect(strip()!.textContent).toContain("Hermes 0.22.2: " + UNTESTED);
    expect(strip()!.getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: "Entendi" }));
    expect(strip()).toBeNull();
    r.unmount();
    render(<HermesCompatStrip hermes={hermes()} />);                                   // same Hermes, new visit: stays dismissed
    expect(strip()).toBeNull();
    cleanup();
    render(<HermesCompatStrip hermes={hermes({ version: "0.23.0", display_version: "0.23.0" })} />);  // another version: back
    expect(strip()!.textContent).toContain("Hermes 0.23.0");
  });

  it("não suportado por versão: warning color, no dismiss button, and never the isolation sentence", () => {
    render(<HermesCompatStrip hermes={hermes({ compat: "unsupported", isolation: "in_process" })} />);
    expect(strip()!.getAttribute("data-compat")).toBe("unsupported");
    expect(strip()!.textContent).toContain("não é suportado pelo LuveBot");
    expect(strip()!.textContent).not.toContain("plugins.isolation");
    expect(screen.queryByRole("button", { name: "Entendi" })).toBeNull();
  });

  it("isolation host: its own sentence (what breaks, what to do), not dismissible", () => {
    render(<HermesCompatStrip hermes={hermes({ compat: "unsupported", isolation: "host" })} />);
    const text = strip()!.textContent!;
    expect(text).toContain("plugins.isolation: host");
    expect(text).toContain("Volte para in_process no config.yaml do Hermes e reinicie o painel.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("limits: listed in words; a code the UI does not know is left out, never shown raw; none = no line", () => {
    render(<HermesCompatStrip hermes={hermes({ limits: ["approval_resolve", "profile_selector", "something_new"] })} />);
    expect(screen.getByTestId("hermes-compat-limits").textContent)
      .toBe("Ainda não funciona neste Hermes: aprovações do Hermes pela Caixa de Aprovações, trocar o perfil no seletor do painel do Hermes.");
    expect(strip()!.textContent).not.toContain("something_new");
    cleanup();
    render(<HermesCompatStrip hermes={hermes({ limits: [] })} />);
    expect(screen.queryByTestId("hermes-compat-limits")).toBeNull();
  });

  it("unproven (code here, no harness proof on this Hermes): a calm line apart from limits; absent or empty = no line; unknown codes say nothing", () => {
    const r = render(<HermesCompatStrip hermes={hermes({ limits: [], unproven: ["approval_resolve", "run_unknown", "something_new"] })} />);
    expect(screen.getByTestId("hermes-compat-unproven").textContent)
      .toBe("Pronto, mas ainda não testado neste Hermes: aprovações do Hermes pela Caixa de Aprovações, execuções paradas ou que fazem uma pergunta.");
    expect(strip()!.textContent).not.toContain("something_new");
    expect(screen.queryByTestId("hermes-compat-limits")).toBeNull();                       // it is NOT "does not work"
    r.unmount();
    for (const u of [undefined, [], ["something_new"]]) { const x = render(<HermesCompatStrip hermes={hermes({ unproven: u as any })} />); expect(screen.queryByTestId("hermes-compat-unproven")).toBeNull(); x.unmount(); }
    render(<HermesCompatStrip hermes={hermes({ limits: ["profile_selector"], unproven: ["session_other_channel"] })} />);   // both, each in its own line
    expect(screen.getByTestId("hermes-compat-limits").textContent).toContain("Ainda não funciona neste Hermes: trocar o perfil");
    expect(screen.getByTestId("hermes-compat-unproven").textContent).toContain("Pronto, mas ainda não testado neste Hermes: continuar aqui conversas");
  });

  it("the dismissal is per what is said: a different unproven list brings the strip back", () => {
    const r = render(<HermesCompatStrip hermes={hermes({ unproven: ["run_unknown"] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Entendi" }));
    expect(strip()).toBeNull();
    r.unmount();
    render(<HermesCompatStrip hermes={hermes({ unproven: ["run_unknown"] })} />);
    expect(strip()).toBeNull();
    cleanup();
    render(<HermesCompatStrip hermes={hermes({ unproven: ["run_unknown", "approval_resolve"] })} />);
    expect(strip()).not.toBeNull();
  });

  it("a version the backend did not tell is not made up; display_version wins over version", () => {
    render(<HermesCompatStrip hermes={hermes({ version: null, display_version: null })} />);
    expect(strip()!.textContent).toContain("Hermes: " + UNTESTED);
    cleanup();
    render(<HermesCompatStrip hermes={hermes({ version: "0.22.2", display_version: "0.22.2+canary.4" })} />);
    expect(strip()!.textContent).toContain("Hermes 0.22.2+canary.4");
  });

  it("in English", () => {
    setLuveLocale("en");
    render(<HermesCompatStrip hermes={hermes({ limits: ["run_unknown"] })} />);
    expect(strip()!.textContent).toContain("This Hermes has not been tested with LuveBot yet. It should work, but expect rough edges.");
    expect(screen.getByTestId("hermes-compat-limits").textContent).toBe("Does not work yet on this Hermes: runs that are stuck or ask a question.");
    expect(screen.getByRole("button", { name: "Got it" })).toBeTruthy();
    cleanup();
    render(<HermesCompatStrip hermes={hermes({ unproven: ["run_unknown"] })} />);
    expect(screen.getByTestId("hermes-compat-unproven").textContent).toBe("Built, but not tested on this Hermes yet: runs that are stuck or ask a question.");
  });

  it("in the app: /health with hermes.compat 'untested' shows the strip; 'compatible' shows none", async () => {
    const health = (compat: string) => ({ ok: true, plugin: { version: "0.1.0", api: "0", db: { ok: true, schema_version: 1 } }, problems: [],
      hermes: { version: "0.22.2", display_version: "0.22.2", compat, limits: [] } });
    const open = (h: unknown) => {
      setCustomFetchJSON(async (url: string) => {
        if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
        if (url.endsWith("/health")) return h;
        if (/\/bots$/.test(url)) return { bots: [] };
        return {};
      });
      return render(<LuveBotApp />);
    };
    const r = open(health("untested"));
    expect((await screen.findAllByTestId("hermes-compat"))[0].textContent).toContain("Hermes 0.22.2: " + UNTESTED);
    r.unmount();
    open(health("compatible"));
    await screen.findByRole("navigation");
    await new Promise((res) => setTimeout(res, 50));
    expect(strip()).toBeNull();
  });
});

describe("a tested Hermes that still has a known limit (ADR-007 section 7, A-193): no strip anywhere, one calm line in Settings", () => {
  const line = () => screen.queryByTestId("hermes-tested-line");
  const TESTED = hermes({ version: "0.22.5", display_version: "0.22.5", compat: "compatible", limits: ["profile_selector"] });
  const SELECTOR_PT = "com o seletor de perfil do Hermes em outro Bot, o LuveBot não aparece ao abrir; volte o seletor ao perfil do painel";

  it("compatible with limits has NO strip (the strip is only for untested and unsupported)", () => {
    render(<HermesCompatStrip hermes={TESTED} />);
    expect(strip()).toBeNull();
    cleanup();
    render(<HermesCompatStrip hermes={hermes({ ...TESTED, limits: ["approval_resolve", "profile_selector"] })} />);
    expect(strip()).toBeNull();
  });

  it("the line says it was tested and names the limit in the words of what the person sees, PT and EN", () => {
    render(<HermesTestedLine hermes={TESTED} />);
    expect(line()!.textContent).toBe(`Testado neste Hermes. Uma limitação conhecida: ${SELECTOR_PT}.`);
    cleanup();
    setLuveLocale("en");
    render(<HermesTestedLine hermes={TESTED} />);
    expect(line()!.textContent).toBe("Tested on this Hermes. One known limit: with the Hermes profile selector on another Bot, LuveBot does not appear when it opens; set the selector back to the dashboard's profile.");
  });

  it("several limits are 'Limitações conhecidas', a limit the UI does not know is left out and never shown raw", () => {
    render(<HermesTestedLine hermes={hermes({ ...TESTED, limits: ["run_unknown", "profile_selector", "something_new"] })} />);
    expect(line()!.textContent).toBe(`Testado neste Hermes. Limitações conhecidas: execuções paradas ou que fazem uma pergunta · ${SELECTOR_PT}.`);
    expect(line()!.textContent).not.toContain("something_new");
  });

  it("no line when there is nothing to say, or when the strip is the one that speaks", () => {
    for (const h of [hermes({ ...TESTED, limits: [] }), hermes({ ...TESTED, limits: undefined }), hermes({ ...TESTED, limits: ["something_new"] }),
                     hermes({ ...TESTED, compat: "untested" }), hermes({ ...TESTED, compat: "unsupported" }), hermes({ ...TESTED, compat: undefined }), null, undefined]) {
      const r = render(<HermesTestedLine hermes={h} />);
      expect(line()).toBeNull();
      r.unmount();
    }
  });

  it("in the app: a tested Hermes with a limit has no strip on the home and the line in Settings; an untested one keeps the strip and has no line", async () => {
    const health = (compat: string) => ({ ok: true, plugin: { version: "0.1.0", api: "0", db: { ok: true, schema_version: 1 } }, problems: [],
      hermes: { version: "0.22.5", display_version: "0.22.5", compat, limits: ["profile_selector"] } });
    const open = (h: unknown) => {
      setCustomFetchJSON(async (url: string) => {
        if (url.endsWith("/session")) return { csrf: "c", actor: "basic:ceo", auth_mode: "gated" };
        if (url.endsWith("/health")) return h;
        if (/\/bots$/.test(url)) return { bots: [] };
        return {};
      });
      return render(<LuveBotApp />);
    };
    const settings = async () => { fireEvent.click(await screen.findByRole("button", { name: /^configurações$/i })); await screen.findByRole("tablist"); };
    const r = open(health("compatible"));
    const nav = await screen.findByRole("navigation");
    await new Promise((res) => setTimeout(res, 50));
    expect(strip()).toBeNull();                                                              // no strip on the home...
    await settings();
    expect(strip()).toBeNull();                                                              // ...nor in Settings...
    expect((await screen.findByTestId("hermes-tested-line")).textContent).toContain("Testado neste Hermes. Uma limitação conhecida:");   // ...where the one calm line is
    expect(nav).toBeTruthy();
    r.unmount();
    open(health("untested"));
    expect((await screen.findAllByTestId("hermes-compat"))[0].textContent).toContain("Hermes 0.22.5: " + UNTESTED);   // the strip, as today
    await settings();
    expect(line()).toBeNull();                                                               // and no calm line: the strip already speaks
  });
});
