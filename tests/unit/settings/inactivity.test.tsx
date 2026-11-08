// tests/unit/settings/inactivity.test.tsx
// Pausa por inatividade (contract v0.8 §8; spec 4.9). Ajustes: the card sets the days (off, 3, 7, 14, 30) by PUT with CSRF and says
// in words what the backend refuses (turning it off or lengthening it needs a login). The banner, on the next visit in Hoje and in
// Rotinas, says how many routines were paused and why, and "Retomar" resumes ONLY by a click (never on its own), with a login:
// loopback gets the 403 sentence. A routine paused by inactivity says so (it never looks "agendada").
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InactivityBanner, InactivityCard } from "@/components/settings/Inactivity";
import { SettingsView } from "@/components/settings/SettingsView";
import { RoutinesView } from "@/components/routines";
import { Hoje } from "@/components/Hoje";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { InactivityStatus, Routine } from "@/api/types";

const AT = 1_761_000_000;
const PAUSED = (count = 3, days: 3 | 7 | 14 | 30 = 7): InactivityStatus => ({ days, paused: { count, at: AT, days } });
let status: InactivityStatus, calls: { url: string; method: string; body?: any; csrf?: string | null }[], mode: string;
let failGet: boolean, failPut: ApiError | null, failResume: ApiError | null, resumedCount: number, routines: Routine[];
const err = (code: string, status = 403) => new ApiError({ code, message: code, status } as never);

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-i");
  status = { days: null, paused: null }; calls = []; mode = "gated"; failGet = false; failPut = null; failResume = null; resumedCount = 3; routines = [];
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/session")) return { csrf: "csrf-i", actor: mode === "gated" ? "basic:user" : "dashboard", auth_mode: mode };
    if (url.endsWith("/settings/inactivity-pause")) {
      if (method === "PUT") { if (failPut) throw failPut; status = { ...status, days: JSON.parse(init!.body as string).days }; return { days: status.days }; }
      if (failGet) throw err("hermes_unreachable", 502);
      return status;
    }
    if (url.endsWith("/routines/inactivity-resume")) { if (failResume) throw failResume; status = { ...status, paused: null }; return { resumed: resumedCount }; }
    if (url.includes("/routines") && method === "GET") return { routines };
    return {};
  });
});
afterEach(() => cleanup());

const puts = () => calls.filter((c) => c.method === "PUT");
const resumes = () => calls.filter((c) => c.url.endsWith("/routines/inactivity-resume"));
const select = () => screen.getByTestId("select-inactivity") as HTMLSelectElement;

describe("o cartão em Ajustes", () => {
  it("shows what is stored (off, or the days) and the hint that nothing resumes by itself; the select waits for the read", async () => {
    render(<InactivityCard />);
    expect(select().disabled).toBe(true);
    await waitFor(() => expect(select().disabled).toBe(false));
    expect(select().value).toBe("off");
    expect([...select().options].map((o) => o.textContent)).toEqual(["Desligada", "3 dias", "7 dias", "14 dias", "30 dias"]);
    expect(screen.getByText(/Nada volta sozinho/)).toBeDefined();
    cleanup(); status = { days: 14, paused: null };
    render(<InactivityCard />);
    await waitFor(() => expect(select().value).toBe("14"));
  });

  it("choosing the days saves with PUT and CSRF and says 'Salvo.'; 'Desligada' sends null", async () => {
    render(<InactivityCard />);
    await waitFor(() => expect(select().disabled).toBe(false));
    fireEvent.change(select(), { target: { value: "7" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Salvo."));
    expect(puts()[0].body).toEqual({ days: 7 });
    expect(puts()[0].csrf).toBe("csrf-i");
    expect(select().value).toBe("7");
    fireEvent.change(select(), { target: { value: "off" } });
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1].body).toEqual({ days: null });
  });

  it("a refusal (loosening in loopback) says so in words and the select stays on what is stored", async () => {
    status = { days: 7, paused: null }; mode = "loopback"; failPut = err("loopback_not_human");
    render(<InactivityCard />);
    await waitFor(() => expect(select().value).toBe("7"));
    expect(await screen.findByTestId("inactivity-loopback")).toBeDefined();
    fireEvent.change(select(), { target: { value: "30" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("loopback, sem login");
    expect(select().value).toBe("7");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the deployment token (a machine) gets the credential's sentence in the same place, never the loopback hint", async () => {
    status = { days: 7, paused: null }; mode = "deployment";
    render(<InactivityCard />);
    const hint = await screen.findByTestId("inactivity-loopback");
    expect(hint.textContent).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    expect(hint.textContent).not.toMatch(/loopback|Sem login/);
  });

  it("a mode nobody knows, or none, is not a person: the hint is there too (only `gated` is)", async () => {
    for (const m of ["", "service", "GATED"]) {
      cleanup(); mode = m; status = { days: 7, paused: null };
      render(<InactivityCard />);
      expect((await screen.findByTestId("inactivity-loopback")).textContent, JSON.stringify(m)).toBe("Este acesso não é um login que o LuveBot reconheça como de uma pessoa (uma credencial de implantação ou um provedor que ele não conhece). Entre com o login de uma pessoa ou peça a quem administra o servidor que declare o provedor.");
    }
  });

  it("the loopback hint is only there in loopback", async () => {
    render(<InactivityCard />);
    await waitFor(() => expect(select().disabled).toBe(false));
    await Promise.resolve();
    expect(screen.queryByTestId("inactivity-loopback")).toBeNull();
  });

  it("a failed read says so and leaves the select off", async () => {
    failGet = true;
    render(<InactivityCard />);
    expect((await screen.findByRole("alert")).textContent).toBe("Não deu para ler a pausa por inatividade.");
    expect(select().disabled).toBe(true);
  });

  it("lives in Ajustes > Geral", async () => {
    render(<SettingsView />);
    expect(await screen.findByRole("heading", { name: "Pausa por inatividade" })).toBeDefined();
  });

  it("speaks English", async () => {
    setLuveLocale("en");
    render(<InactivityCard />);
    expect(screen.getByRole("heading", { name: "Pause when away" })).toBeDefined();
    await waitFor(() => expect(select().disabled).toBe(false));
    expect([...select().options].map((o) => o.textContent)).toEqual(["Off", "3 days", "7 days", "14 days", "30 days"]);
  });
});

describe("o aviso na volta", () => {
  it("is absent when nothing was paused, or when the read fails", async () => {
    render(<InactivityBanner />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/settings/inactivity-pause"))).toBe(true));
    await Promise.resolve();
    expect(screen.queryByTestId("inactivity-banner")).toBeNull();
    cleanup(); failGet = true; status = PAUSED();
    render(<InactivityBanner />);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/settings/inactivity-pause")).length).toBe(2));
    await Promise.resolve();
    expect(screen.queryByTestId("inactivity-banner")).toBeNull();
  });

  it("says how many were paused, why and when, in the singular and the plural, and never resumes by itself", async () => {
    status = PAUSED(3, 7);
    render(<InactivityBanner />);
    const banner = await screen.findByTestId("inactivity-banner");
    const date = new Date(AT * 1000).toLocaleDateString("pt-BR", { day: "numeric", month: "long" });
    expect(banner.textContent).toContain("Pausei 3 rotinas porque você ficou 7 dias fora.");
    expect(banner.textContent).toContain(`Pausadas em ${date}.`);
    expect(resumes()).toHaveLength(0);                                   // seeing it changes nothing
    cleanup(); status = PAUSED(1, 14);
    render(<InactivityBanner />);
    expect((await screen.findByTestId("inactivity-banner")).textContent).toContain("Pausei 1 rotina porque você ficou 14 dias fora.");
    expect(resumes()).toHaveLength(0);
  });

  it("'Retomar' resumes on the click only, with CSRF, then says how many and the banner is gone", async () => {
    status = PAUSED();
    const onResumed = vi.fn();
    render(<InactivityBanner onResumed={onResumed} />);
    fireEvent.click(await screen.findByTestId("btn-inactivity-resume"));
    await waitFor(() => expect(screen.getByTestId("inactivity-resumed").textContent).toBe("Retomei 3 rotinas."));
    expect(resumes()).toHaveLength(1);
    expect(resumes()[0].method).toBe("POST");
    expect(resumes()[0].csrf).toBe("csrf-i");
    expect(onResumed).toHaveBeenCalledExactlyOnceWith(3);
    expect(screen.queryByTestId("inactivity-banner")).toBeNull();
  });

  it("says when nothing needed resuming", async () => {
    status = PAUSED(); resumedCount = 0;
    render(<InactivityBanner />);
    fireEvent.click(await screen.findByTestId("btn-inactivity-resume"));
    expect((await screen.findByTestId("inactivity-resumed")).textContent).toBe("Nenhuma rotina precisava ser retomada.");
  });

  it("in loopback the refusal is said in words, the banner stays and the button is back", async () => {
    status = PAUSED(); failResume = err("loopback_not_human");
    render(<InactivityBanner />);
    fireEvent.click(await screen.findByTestId("btn-inactivity-resume"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("loopback, sem login");
    expect(screen.getByTestId("inactivity-banner")).toBeDefined();
    expect((screen.getByTestId("btn-inactivity-resume") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("nas telas", () => {
  it("Hoje shows the banner", async () => {
    status = PAUSED(2, 3);
    render(<Hoje />);
    expect((await screen.findByTestId("inactivity-banner")).textContent).toContain("Pausei 2 rotinas porque você ficou 3 dias fora.");
  });

  it("Rotinas shows it, reloads the list after 'Retomar', and a routine paused by inactivity says so instead of looking scheduled", async () => {
    status = PAUSED();
    routines = [{ id: "r1", bot: "vendas", name: "Diária", schedule: { expr: "0 8 * * *" }, state: "paused", enabled: false, paused_reason: "inactivity" } as Routine];
    render(<RoutinesView bots={[]} initialRoutines={routines} />);
    expect(screen.getByTestId("badge-paused-inactivity-r1").textContent).toBe("Pausada por inatividade");
    expect(screen.queryByTestId("badge-scheduled-r1")).toBeNull();
    expect(screen.queryByTestId("badge-paused-user-r1")).toBeNull();
    const before = calls.filter((c) => c.method === "GET" && c.url.includes("/routines")).length;
    fireEvent.click(await screen.findByTestId("btn-inactivity-resume"));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.url.includes("/routines")).length).toBeGreaterThan(before));
  });
});
