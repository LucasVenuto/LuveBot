// tests/unit/ui/default-face.test.tsx
// A Bot with no face of its own shows a stable default mascot (T11.4, Maestro's delegated decision): picked by a hash of
// the profile id, display only, never stored; a chosen mascot, an emoji or other initials still win.
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MASCOTS, defaultMascot, displayFace, withDefaultFace } from "@/components/ui/mascots";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { BotProfile } from "@/components/bots";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Bot, BotDetail } from "@/api/types";

const bot = (name: string, avatar: Bot["display"]["avatar"]): Bot => ({
  name, is_default: false, description: "", model: { provider: "p", name: "m" }, status: "idle",
  display: { label: name[0].toUpperCase() + name.slice(1), role: "", color: "#60a5fa", avatar },
});
const backendDefault = (name: string) => ({ kind: "initials" as const, value: name.slice(0, 2).toUpperCase() });  // bot_meta.default_display

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("default face", () => {
  it("is one of the 15 mascots, the same every time for the same profile id, and varies across ids", () => {
    const ids = ["default", "vendas", "juridico", "financeiro", "marketing", "lucais", "naescala", "trafegopago"];
    for (const id of ids) {
      expect(MASCOTS.some((m) => m.id === defaultMascot(id))).toBe(true);
      expect(defaultMascot(id)).toBe(defaultMascot(id));
    }
    expect(new Set(ids.map(defaultMascot)).size).toBeGreaterThanOrEqual(4);
  });

  it("applies only to a Bot with no face of its own; a chosen mascot, an emoji or other initials win", () => {
    expect(displayFace("juridico", undefined)).toEqual({ kind: "mascot", value: defaultMascot("juridico") });
    expect(displayFace("juridico", backendDefault("juridico"))).toEqual({ kind: "mascot", value: defaultMascot("juridico") });
    expect(displayFace("juridico", { kind: "initials", value: "JR" })).toEqual({ kind: "initials", value: "JR" });
    expect(displayFace("juridico", { kind: "emoji", value: "⚖️" })).toEqual({ kind: "emoji", value: "⚖️" });
    expect(displayFace("juridico", { kind: "mascot", value: "zuca" })).toEqual({ kind: "mascot", value: "zuca" });
  });

  it("the contact list shows the face, not the initials", () => {
    render(<MessengerShell bots={[withDefaultFace(bot("juridico", backendDefault("juridico")))]} />);
    const img = document.querySelector('aside[aria-label="sidebar"] button[aria-pressed] img');
    expect(img?.getAttribute("src")).toContain(`mascots/${defaultMascot("juridico")}-mini.svg`);
    expect(screen.queryByText("JU")).toBeNull();
  });

  it("is never stored: saving the profile without choosing a face still sends the Bot's own avatar", async () => {
    let body: any = null;
    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:user", auth_mode: "gated" };
      if (url.includes("/bots/juridico/display") && init?.method === "PATCH") { body = JSON.parse(String(init.body)); return { ...detail }; }
      throw new Error("unexpected " + url);
    });
    const detail = { ...bot("juridico", backendDefault("juridico")), soul: "", toolsets: [], mcp_servers: [] } as unknown as BotDetail;
    render(<BotProfile botName="juridico" initialBot={detail} onBotUpdated={vi.fn()} />);
    // the profile header shows the default face too, whole (56 px: the full file, with its orbit)
    expect(document.querySelector("img")?.getAttribute("src")).toContain(`mascots/${defaultMascot("juridico")}.svg`);
    fireEvent.click(screen.getByText("Salvar alterações"));
    await waitFor(() => expect(body).not.toBeNull());
    expect(body.avatar).toEqual(backendDefault("juridico"));
  });
});
