// tests/unit/ui/empty-art.test.tsx
// Empty-state art (contract v0.8 §10, Mochi): Memory, Timeline and Suggestions. The scenes are made by assets/mascots/build.mjs
// and shipped as images. Checked: the three files exist and ship unchanged; they are safe to draw (nothing that runs, links
// out or loads); every animation sits inside prefers-reduced-motion: no-preference; the line color reads on light AND dark
// backgrounds (an <img> cannot follow the app's theme); EmptyArt only draws a listed kind; the Timeline's empty state uses it.
import React from "react";
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { EmptyArt, EMPTY_ART_KINDS } from "@/components/ui/EmptyArt";
import { Timeline } from "@/components/activity/Timeline";
// @ts-expect-error módulo JS do pipeline de arte, sem tipos
import { LINE, BACKDROPS, contrast } from "../../../assets/mascots/luve-art.mjs";

const root = process.cwd();
const src = (k: string) => fs.readFileSync(path.resolve(root, `assets/mascots/empty/${k}.svg`), "utf8");
const FORBIDDEN = /<script|\son[a-z]+\s*=|\bhref\s*=|xlink:|<foreignObject|<!ENTITY|<!DOCTYPE|@import|url\(\s*["']?(?!#)/i;

/** The CSS of a file with every `@media (prefers-reduced-motion:no-preference){…}` block taken out (braces balanced). */
function outsideNoPreference(css: string): string {
  let out = "", i = 0;
  const open = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/g;
  for (let m = open.exec(css); m; m = open.exec(css)) {
    out += css.slice(i, m.index);
    let depth = 1, j = open.lastIndex;
    for (; depth && j < css.length; j++) depth += css[j] === "{" ? 1 : css[j] === "}" ? -1 : 0;
    i = open.lastIndex = j;
  }
  return out + css.slice(i);
}

describe("empty-state art", () => {
  it("the three scenes exist and ship as they are made (dashboard/icons/empty)", () => {
    expect(fs.readdirSync(path.resolve(root, "assets/mascots/empty")).sort()).toEqual([...EMPTY_ART_KINDS].map((k) => `${k}.svg`).sort());
    for (const k of EMPTY_ART_KINDS) {
      expect(fs.readFileSync(path.resolve(root, `dashboard/icons/empty/${k}.svg`), "utf8"), k).toBe(src(k));
      expect(src(k), k).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 240 160" aria-hidden="true">/);
    }
  });

  it("safe to draw as an image: nothing that runs, links out or loads", () => {
    for (const k of EMPTY_ART_KINDS) expect(src(k), k).not.toMatch(FORBIDDEN);
  });

  it("every animation (the character's and the objects') is inside prefers-reduced-motion: no-preference", () => {
    for (const k of EMPTY_ART_KINDS) {
      const css = [...src(k).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
      expect(css, k).toMatch(/animation:/);
      expect(outsideNoPreference(css), k).not.toMatch(/animation\s*:/);
    }
  });

  it("the line color reads on the light AND the dark backgrounds (≥ 3:1), and every scene draws with it", () => {
    for (const bg of [...BACKDROPS.light, ...BACKDROPS.dark]) expect(contrast(LINE, bg), bg).toBeGreaterThanOrEqual(3);
    for (const k of EMPTY_ART_KINDS) expect(src(k), k).toContain(`stroke="${LINE}"`);
  });

  it("EmptyArt draws only a listed kind, as a decorative image from the plugin", () => {
    for (const kind of EMPTY_ART_KINDS) {
      const { container, unmount } = render(<EmptyArt kind={kind} />);
      const img = container.querySelector("img")!;
      expect(img.getAttribute("src")).toBe(`/dashboard-plugins/luvebot/icons/empty/${kind}.svg`);
      expect(img.getAttribute("alt")).toBe("");
      expect(img.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
    for (const bad of ["../mascots/luvi", "https://x/y", "constructor", ""]) {
      const { container, unmount } = render(<EmptyArt kind={bad as never} />);
      expect(container.innerHTML, bad).toBe("");
      unmount();
    }
  });

  it("the Timeline's empty state shows its art", () => {
    render(<Timeline data={{ lanes: [], approvals: [], handoffs: [] }} since={0} until={86400} now={100} />);
    expect(screen.getByTestId("timeline-empty").querySelector("img.lb-empty-art")!.getAttribute("src")).toContain("/icons/empty/timeline.svg");
  });
});
