// tests/unit/pages/editor-load.test.ts
// The seam of the visual editor (ADR-009 §6, D-029): editor/load.ts is the ONE place that would put dist/editor.js on the page, by a constant
// URL of the plugin, once; a failure is not remembered; and while no library is bundled (VISUAL_EDITOR_FILE is false) the page editor never asks.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { pluginAssetUrl } from "@/pwa/register";

let mod: typeof import("@/editor/load");
const api = { version: 1, mount: vi.fn() } as never;
const scripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>("script[src]"));

beforeEach(async () => {
  delete window.__LUVEBOT_EDITOR__;
  for (const s of scripts()) s.remove();
  vi.resetModules();                                                          // each test starts with no load in flight
  mod = await import("@/editor/load");
});

describe("the editor loader", () => {
  it("adds one script with the plugin's constant URL, shared by calls made while it loads", async () => {
    const a = mod.loadEditor(), b = mod.loadEditor();
    expect(a).toBe(b);
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0].src).toBe(new URL(pluginAssetUrl("dist/editor.js"), document.baseURI).href);
    expect(scripts()[0].getAttribute("src")).toMatch(/\/dashboard-plugins\/luvebot\/dist\/editor\.js$/);
    window.__LUVEBOT_EDITOR__ = api;
    scripts()[0].onload!(new Event("load"));
    await expect(a).resolves.toBe(api);
  });

  it("takes no argument: nothing from a page, a Bot or the server can go into the URL", () => {
    expect(mod.loadEditor.length).toBe(0);
    void mod.loadEditor();
  });

  it("answers at once, without a script, when an editor is already registered", async () => {
    window.__LUVEBOT_EDITOR__ = api;
    await expect(mod.loadEditor()).resolves.toBe(api);
    expect(scripts()).toHaveLength(0);
  });

  it("a file that fails to load rejects, leaves no script behind, and the next call tries again", async () => {
    const first = mod.loadEditor();
    scripts()[0].onerror!(new Event("error"));
    await expect(first).rejects.toThrow("editor");
    expect(scripts()).toHaveLength(0);
    const second = mod.loadEditor();
    expect(scripts()).toHaveLength(1);
    window.__LUVEBOT_EDITOR__ = api;
    scripts()[0].onload!(new Event("load"));
    await expect(second).resolves.toBe(api);
  });

  it("a file that loads but registers nothing rejects", async () => {
    const p = mod.loadEditor();
    scripts()[0].onload!(new Event("load"));
    await expect(p).rejects.toThrow("not registered");
  });

  it("no library is bundled today: the build has no editor file, so the flag is off", () => {
    expect(mod.VISUAL_EDITOR_FILE).toBe(false);
  });
});
