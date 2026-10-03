import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Plugin Bundle Acceptance Criteria", () => {
  const bundlePath = path.resolve(__dirname, "../../dashboard/dist/index.js");
  const manifestPath = path.resolve(__dirname, "../../dashboard/manifest.json");
  const themePath = path.resolve(__dirname, "../../theme/luve.yaml");

  it("checks manifest.json fields match Hermes plugin spec", () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    expect(manifest.name).toBe("luvebot");
    expect(manifest.tab.override).toBe("/");
    expect(manifest.has_api).toBe(true);
    expect(manifest.api).toBe("plugin_api.py");
    expect(manifest.entry).toBe("dist/index.js");
    expect(manifest.css).toBe("dist/style.css");
  });

  it("checks theme/luve.yaml exists and uses self-hosted system fonts without fontUrl", () => {
    expect(fs.existsSync(themePath)).toBe(true);
    const themeContent = fs.readFileSync(themePath, "utf-8");

    expect(themeContent).toContain("name: luve");
    expect(themeContent).toContain("layoutVariant: tiled");
    expect(themeContent).toContain("background:");
    expect(themeContent).toContain("midground:");
    expect(themeContent).toContain("colorOverrides:");

    // Self-hosted privacy invariant: MUST NOT call Google Fonts or external CDNs
    expect(themeContent).not.toContain("fontUrl");
    expect(themeContent).toContain("system-ui");
    expect(themeContent).toContain("ui-monospace");
  });

  it("checks bundle is an IIFE and does NOT bundle React or scheduler", () => {
    // Invariant: Must fail if bundle does not exist
    expect(fs.existsSync(bundlePath)).toBe(true);

    const bundle = fs.readFileSync(bundlePath, "utf-8");

    // Must be IIFE (wrapped in closure)
    expect(
      bundle.includes("var LuveBotPluginBundle = (() => {") ||
        bundle.includes("(() => {") ||
        bundle.includes("(function")
    ).toBe(true);

    // Must call Hermes plugin registry
    expect(bundle).toContain('register("luvebot"');

    // MUST NOT bundle React internally
    expect(bundle).not.toContain("react.production");
    expect(bundle).not.toContain("scheduler.production");
    expect(bundle).not.toContain("Scheduler-Tracing");
  });
});
