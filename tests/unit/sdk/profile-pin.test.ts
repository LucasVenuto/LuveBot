// tests/unit/sdk/profile-pin.test.ts
// ADR-006 D1: every call of ours through the SDK (fetchJSON and authedFetch) carries `profile=current`, so the Hermes dashboard's profile
// selector can never send LuveBot to another profile's plugin host (Hermes main). Anything that is not ours, or already says `profile=`,
// goes exactly as it came; the rest of the SDK is untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getSDK } from "@/sdk";
import { getBots, resetCsrfToken } from "@/api/client";
import { openStream } from "@/lib/stream";

const ORIGIN = window.location.origin;
function install() {
  const seen: Array<{ via: "json" | "authed"; url: unknown; init?: any; options?: any }> = [];
  const hooks = { useState: () => 1 };
  (window as any).__HERMES_PLUGIN_SDK__ = {
    sdkVersion: "1.1.0", React: {}, hooks,
    fetchJSON: async (url: unknown, init?: any, options?: any) => { seen.push({ via: "json", url, init, options }); return { bots: [] }; },
    authedFetch: async (url: unknown, init?: any) => { seen.push({ via: "authed", url, init }); return new Response("", { status: 200 }); },
  };
  return { seen, hooks };
}
beforeEach(() => { resetCsrfToken(); });
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; });

describe("D1: profile=current on every call of ours", () => {
  it("fetchJSON and authedFetch add it to our URLs: a bare path, one with a query, and a same-origin absolute URL; the rest of the call is untouched", async () => {
    const { seen } = install();
    const sdk = getSDK()!;
    const init = { method: "POST", body: "{}" };
    await sdk.fetchJSON("/api/plugins/luvebot/bots", init, { allowUnauthorized: true });
    await sdk.fetchJSON("/api/plugins/luvebot/bots?limit=5&x=a%20b#top");
    await sdk.authedFetch("/api/plugins/luvebot/bots/vendas/files/download?path=a%2Fb.md");
    await sdk.authedFetch(`${ORIGIN}/api/plugins/luvebot/health`, init);
    await sdk.fetchJSON("/api/plugins/luvebot");
    await sdk.fetchJSON("/api/plugins/luvebot/bots?");
    expect(seen.map((s) => s.url)).toEqual([
      "/api/plugins/luvebot/bots?profile=current",
      "/api/plugins/luvebot/bots?limit=5&x=a%20b&profile=current#top",                // the rest of the URL keeps its encoding
      "/api/plugins/luvebot/bots/vendas/files/download?path=a%2Fb.md&profile=current",
      `${ORIGIN}/api/plugins/luvebot/health?profile=current`,
      "/api/plugins/luvebot?profile=current",
      "/api/plugins/luvebot/bots?profile=current",
    ]);
    expect(seen[0].init).toBe(init);                                      // method, body, headers: exactly as sent
    expect(seen[0].options).toEqual({ allowUnauthorized: true });
    expect(seen[3].init).toBe(init);
  });

  it("an explicit profile= wins (never overridden), and what is not ours goes exactly as it came", async () => {
    const { seen } = install();
    const sdk = getSDK()!;
    for (const u of [
      "/api/plugins/luvebot/bots?profile=vendas",
      "/api/plugins/luvebot/bots?profile=",
      "/api/status",
      "/api/profiles/active",
      "/api/plugins/other/x",
      "/api/plugins/luvebotX/x",
      "/dashboard-plugins/luvebot/dist/index.js",
      "https://elsewhere.example/api/plugins/luvebot/bots",
    ]) await sdk.fetchJSON(u);
    expect(seen.map((s) => s.url)).toEqual([
      "/api/plugins/luvebot/bots?profile=vendas", "/api/plugins/luvebot/bots?profile=", "/api/status", "/api/profiles/active",
      "/api/plugins/other/x", "/api/plugins/luvebotX/x", "/dashboard-plugins/luvebot/dist/index.js", "https://elsewhere.example/api/plugins/luvebot/bots",
    ]);
  });

  it("the rest of the SDK is the Hermes's own, and getSDK() keeps one identity per SDK (a new SDK gets its own wrapper)", () => {
    const { hooks } = install();
    expect(getSDK()).toBe(getSDK());
    expect(getSDK()!.hooks).toBe(hooks);
    expect(getSDK()!.sdkVersion).toBe("1.1.0");
    const first = getSDK();
    install();
    expect(getSDK()).not.toBe(first);
    delete (window as any).__HERMES_PLUGIN_SDK__;
    expect(getSDK()).toBeUndefined();
  });

  it("through the real client and the real stream: the JSON calls and the SSE open carry it, with no code of theirs changed", async () => {
    const { seen } = install();
    await getBots();
    await openStream("/api/plugins/luvebot/bots/vendas/runs/r1/events", () => {});
    expect(seen.map((s) => [s.via, s.url])).toEqual([
      ["json", "/api/plugins/luvebot/bots?profile=current"],
      ["authed", "/api/plugins/luvebot/bots/vendas/runs/r1/events?profile=current"],
    ]);
  });

  it("an SDK without one of the two keeps it absent (the callers' own 'not available' checks still work)", () => {
    (window as any).__HERMES_PLUGIN_SDK__ = { sdkVersion: "1.1.0", React: {}, hooks: {}, fetchJSON: async () => ({}) };
    expect(getSDK()!.fetchJSON).toBeTypeOf("function");
    expect(getSDK()!.authedFetch).toBeUndefined();
  });
});
