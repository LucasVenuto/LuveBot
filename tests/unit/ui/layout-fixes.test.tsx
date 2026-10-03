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
