// tests/unit/ui/my-luve.test.tsx
// Crie seu Luve U4 (proposal §5, §8 Q3): "Meu Luve" is the face of the LOGIN (GET/PATCH /me/display). The person's own bubbles wear
// it (yours only, never the Bot's), it is loaded once by the provider and costs nothing without it, a failed read is no face, a
// pick is a click that saves with CSRF, and the same face shows everywhere at once.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Bubble } from "@/components/ui/Bubble";
import { SettingsView } from "@/components/settings/SettingsView";
import { MyFaceProvider } from "@/hooks/useMyFace";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { KIT, parseLuve } from "@/components/ui/luve";
import type { BotAvatar } from "@/api/types";

const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let stored: BotAvatar | null, calls: { method: string; url: string; body?: string; csrf?: string | null }[], failPatch: boolean, failGet: boolean;

beforeEach(() => {
  resetCsrfToken(); setLuveLocale("pt");
  stored = null; calls = []; failPatch = false; failGet = false;
  Object.assign(URL, { createObjectURL: () => "blob:luvebot/x", revokeObjectURL: () => {} });
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-me", actor: "dashboard", auth_mode: "loopback" };
    if (url.endsWith("/me/display")) {
      calls.push({ method, url, body: init?.body as string | undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
      if (method === "PATCH") { if (failPatch) throw new Error("boom"); stored = JSON.parse(init!.body as string).avatar; return { avatar: stored }; }
      if (failGet) throw new Error("boom");
      return { avatar: stored };
    }
    return {};
  });
});
afterEach(() => { cleanup(); Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke }); });

const face = (c: HTMLElement) => c.querySelector("span[aria-hidden] img");
// the face beside "minha mensagem" (Settings also draws mascots of its own, so the scope is the bubble's row)
const mine = () => screen.getByText("minha mensagem").parentElement!.querySelector("img");
const gets = () => calls.filter((c) => c.method === "GET");

describe("the person's own bubble", () => {
  it("wears the face of the login, small beside the bubble; the Bot's bubble never does", async () => {
    stored = { kind: "mascot", value: "zuca" };
    const { container } = render(<MyFaceProvider><Bubble side="me" color="#60a5fa">oi</Bubble><Bubble side="bot" author="Vendas">olá</Bubble></MyFaceProvider>);
    await waitFor(() => expect(face(container)).not.toBeNull());
    expect(face(container)!.getAttribute("src")).toBe("/dashboard-plugins/luvebot/icons/mascots/zuca-mini.svg");
    expect(container.querySelectorAll("img")).toHaveLength(1);                       // not on the Bot's bubble
    expect(screen.getByText("oi")).toBeDefined();
  });

  it("a Luve is drawn as the Luve, and one request loads it for every bubble", async () => {
    stored = { kind: "luve", value: `eco.laca.sinos.${(KIT.swatches[0].base as string).slice(1)}` };
    const { container } = render(<MyFaceProvider><Bubble side="me">a</Bubble><Bubble side="me">b</Bubble></MyFaceProvider>);
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(container.querySelector("img")!.getAttribute("src")).toMatch(/^blob:luvebot\//);
    expect(gets()).toHaveLength(1);
  });

  it("with no face chosen, a failed read, or no provider at all the bubble is as it always was, and nothing is requested without the provider", async () => {
    const none = render(<MyFaceProvider><Bubble side="me">x</Bubble></MyFaceProvider>);
    await waitFor(() => expect(gets()).toHaveLength(1));
    expect(none.container.querySelector("img")).toBeNull();
    cleanup(); calls = []; failGet = true;
    const bad = render(<MyFaceProvider><Bubble side="me">y</Bubble></MyFaceProvider>);
    await waitFor(() => expect(gets()).toHaveLength(1));
    expect(bad.container.querySelector("img")).toBeNull();
    expect(screen.getByText("y")).toBeDefined();
    cleanup(); calls = [];
    const bare = render(<Bubble side="me">z</Bubble>);
    expect(bare.container.querySelector("img")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("Meu Luve in Settings", () => {
  const settings = () => render(<MyFaceProvider><SettingsView /><Bubble side="me">minha mensagem</Bubble></MyFaceProvider>);

  it("says so when there is no face yet, and picking a mascot saves it with CSRF and shows it on the bubble at once", async () => {
    settings();
    expect(await screen.findByText("Você ainda não escolheu um rosto.")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Meu Luve" })).toBeDefined();
    expect(mine()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pipo" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Rosto salvo."));
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(JSON.parse(patch.body!)).toEqual({ avatar: { kind: "mascot", value: "pipo" } });
    expect(patch.csrf).toBe("csrf-me");
    expect(mine()!.getAttribute("src")).toContain("mascots/pipo-mini.svg");   // the bubble, same tree
    expect(screen.getByRole("button", { name: "Pipo" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("the studio's 'use' saves the canonical Luve recipe", async () => {
    settings();
    await screen.findByText("Você ainda não escolheu um rosto.");
    fireEvent.click(screen.getByRole("button", { name: "Criar seu Luve" }));
    fireEvent.click(screen.getByRole("button", { name: "Forma Tico" }));
    fireEvent.click(screen.getByRole("tab", { name: "Acessório" }));
    fireEvent.click(screen.getByRole("button", { name: "Usar como meu" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const avatar = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!).avatar;
    expect(avatar.kind).toBe("luve");
    expect(parseLuve(avatar.value)?.shape).toBe("tico");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a face that fails to save says so, and the bubble keeps the old face", async () => {
    stored = { kind: "mascot", value: "zuca" };
    settings();
    await waitFor(() => expect(mine()).not.toBeNull());
    failPatch = true;
    fireEvent.click(screen.getByRole("button", { name: "Pipo" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Não deu para salvar seu rosto. Tente de novo.");
    expect(mine()!.getAttribute("src")).toContain("mascots/zuca-mini.svg");
  });
});
