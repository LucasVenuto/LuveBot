// tests/unit/ui/layout-fixes.test.tsx
// Two findings of the live photos (2026-10-02): (a) a dialog whose content is not in .lb-dialog-body has no side margins
// (the phone sheet "Assumir o controle da tela?" touched the left edge); (b) the work panel's 4 tabs in 320 px were cut to
// "Ativid… Termi… Arqui…". jsdom measures no layout: the real check of (b) is in Chromium (see the delivery notes).
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkPanel } from "@/components/conversation/WorkPanel";

const src = path.resolve(process.cwd(), "dashboard/src");
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe("dialogs keep their margins", () => {
  it("every <Dialog> in the app puts its content in .lb-dialog-body (the frame itself has no padding)", () => {
    const bare = files(path.join(src, "components")).flatMap((f) => {
      const s = fs.readFileSync(f, "utf8");
      const dialogs = (s.match(/<Dialog\b/g) ?? []).length;
      const bodies = (s.match(/lb-dialog-body/g) ?? []).length;
      return dialogs > bodies ? [`${path.relative(src, f)}: ${dialogs} dialogs, ${bodies} bodies`] : [];
    });
    expect(bare).toEqual([]);
  });

  it("a field fills its row without spilling past the dialog's margin, whatever the host's own CSS does", () => {
    const css = fs.readFileSync(path.join(src, "style.css"), "utf8").replace(/\s+/g, " ");
    expect(css.match(/\.lb-input \{([^}]*)\}/)?.[1] ?? "").toMatch(/box-sizing: border-box/);
  });
});

describe("the work panel's tabs are never cut", () => {
  it("the tab bar is the fitting kind: whole labels, sharing the rest, scrolling sideways if it must", () => {
    render(<WorkPanel items={[]} bot={{ name: "vendas", label: "Vendas" }} />);
    const bar = screen.getByRole("tablist");
    expect(bar.className.split(" ")).toContain("lb-segmented-fit");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Atividade", "Terminal", "Arquivos", "Tela"]);
    const css = fs.readFileSync(path.join(src, "style.css"), "utf8").replace(/\s+/g, " ");
    const rule = (sel: string) => css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}"))?.[1] ?? "";
    expect(rule(".lb-segmented-fit .lb-segment")).toMatch(/flex: 1 0 auto/);
    expect(rule(".lb-segmented-fit .lb-segment")).toMatch(/text-overflow: clip/);
    expect(rule(".lb-segmented-fit .lb-segment")).toMatch(/overflow: visible/);
    expect(rule(".lb-segmented-fit")).toMatch(/overflow-x: auto/);
  });
});

describe("the Bot editor's numbered tabs are never cut on a phone (live photos 2026-10-31: '1. Identid…', '2. Instru…' in 390 px)", () => {
  const css = fs.readFileSync(path.join(src, "style.css"), "utf8").replace(/\s+/g, " ");
  const start = css.indexOf("@media (max-width: 560px) { .lb-segmented-wrap");
  const block = (() => { let depth = 0; for (let i = css.indexOf("{", start); i < css.length; i++) { if (css[i] === "{") depth++; if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1); } return ""; })();
  const rule = (sel: string) => block.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}"))?.[1] ?? "";

  it("under 560 px the bar is two columns and a tab takes its whole label (it wraps) with a touch-sized height", () => {
    expect(start).toBeGreaterThan(-1);
    expect(rule(".lb-segmented-wrap")).toMatch(/display: grid/);
    expect(rule(".lb-segmented-wrap")).toMatch(/grid-template-columns: 1fr 1fr/);
    expect(rule(".lb-segmented-wrap .lb-segment")).toMatch(/white-space: normal/);
    expect(rule(".lb-segmented-wrap .lb-segment")).toMatch(/overflow: visible/);
    expect(rule(".lb-segmented-wrap .lb-segment")).toMatch(/text-overflow: clip/);
    expect(rule(".lb-segmented-wrap .lb-segment")).toMatch(/min-height: 44px/);
  });

  it("wider than a phone nothing changes: the rule lives only inside the media query", () => {
    expect(css.replace(block, "")).not.toContain("lb-segmented-wrap");
  });
});

describe("the phone's bottom bar keeps every label whole (live photo 2026-10-31, 390 px: 'AprovaçõesAtividade', 'BuscarConfiguraç…')", () => {
  const css = fs.readFileSync(path.join(src, "style.css"), "utf8").replace(/\s+/g, " ");
  const bodies = (sel: string) => [...css.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\{([^}]*)\\}", "g"))].map((m) => m[1]).join(" ");

  it("each tab keeps its size (it never shrinks under its neighbour) and a long label wraps inside a fixed maximum", () => {
    expect(bodies(".lb-tabbar .lb-rail-btn")).toMatch(/flex: 0 0 auto/);
    expect(bodies(".lb-tabbar .lb-rail-btn")).toMatch(/max-width: 84px/);
    expect(bodies(".lb-tabbar .lb-rail-btn")).toMatch(/min-width: 56px/);
  });
  it("when the seven do not fit the bar scrolls sideways (no scrollbar drawn), snapping to a tab, and keeps its own 4 px edge", () => {
    expect(bodies(".lb-tabbar")).toMatch(/overflow-x: auto/);
    expect(bodies(".lb-tabbar")).toMatch(/scroll-snap-type: x proximity/);
    expect(bodies(".lb-tabbar")).toMatch(/scroll-padding: 0 4px/);
    expect(bodies(".lb-tabbar")).toMatch(/scrollbar-width: none/);
    expect(css).toContain(".lb-tabbar::-webkit-scrollbar { display: none; }");
  });
  it("the bar is still the shell's own nav with seven tabs (the rail on a wide window is another element)", () => {
    const shell = fs.readFileSync(path.join(src, "components/messenger/MessengerShell.tsx"), "utf8");
    expect(shell).toContain('className="lb-tabbar"');
    expect(shell).toMatch(/\{items\.map\(tabButton\)\}\{searchBtn\}\{settingsBtn\}/);
  });
});
