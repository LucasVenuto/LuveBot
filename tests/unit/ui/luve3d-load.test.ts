// tests/unit/ui/luve3d-load.test.ts
// Crie seu Luve U3 (proposal §8 Q2): luve3d/load.ts is the ONE place that puts dist/luve3d.js on the page, by a constant URL of the
// plugin, once; a failure is not remembered (the next opening tries again); the studio reads only what the file registers.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { pluginAssetUrl } from "@/pwa/register";

let loadLuve3d: typeof import("@/luve3d/load").loadLuve3d;
const api = { version: 1, mount: vi.fn() } as never;
const scripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>("script[src]"));
beforeEach(async () => {
  delete window.__LUVEBOT_LUVE3D__;
  for (const s of scripts()) s.remove();
  vi.resetModules();                                                         // each test starts with no load in flight
  ({ loadLuve3d } = await import("@/luve3d/load"));
});

describe("the 3D loader", () => {
  it("adds one script with the plugin's constant URL, shared by calls made while it loads", async () => {
    const a = loadLuve3d(), b = loadLuve3d();
    expect(a).toBe(b);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].src).toBe(new URL(pluginAssetUrl("dist/luve3d.js"), document.baseURI).href);
    expect(scripts()[0].getAttribute("src")).toMatch(/\/dashboard-plugins\/luvebot\/dist\/luve3d\.js$/);
    window.__LUVEBOT_LUVE3D__ = api;
    scripts()[0].onload!(new Event("load"));
    await expect(a).resolves.toBe(api);
  });

  it("takes no argument: nothing from a recipe, a Bot or the server can go into the URL", () => {
    expect(loadLuve3d.length).toBe(0);
    void loadLuve3d();
  });

  it("answers at once, without a script, when the file is already registered", async () => {
    window.__LUVEBOT_LUVE3D__ = api;
    await expect(loadLuve3d()).resolves.toBe(api);
    expect(scripts()).toHaveLength(0);
  });

  it("a file that fails to load rejects, leaves no script behind, and the next call tries again", async () => {
    const first = loadLuve3d();
    scripts()[0].onerror!(new Event("error"));
    await expect(first).rejects.toThrow("luve3d");
    expect(scripts()).toHaveLength(0);
    const second = loadLuve3d();
    expect(scripts()).toHaveLength(1);
    window.__LUVEBOT_LUVE3D__ = api;
    scripts()[0].onload!(new Event("load"));
    await expect(second).resolves.toBe(api);
  });

  it("a file that loads but registers nothing rejects", async () => {
    const p = loadLuve3d();
    scripts()[0].onload!(new Event("load"));
    await expect(p).rejects.toThrow("not registered");
  });
});
