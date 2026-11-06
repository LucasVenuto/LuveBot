// tests/unit/pages/editor-expand.test.tsx
// The CEO (VPS): the page editor opened in the narrow side panel with the text and the preview squeezed side by side.
// In a narrow place it shows one at a time (Editar | Prévia); "Expandir" covers the main area with both wide, side by side;
// "Recolher" or Esc brings it back to the panel, and that Esc does not close the panel.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import { PageView } from "@/components/pages/PageView";

const SHA = "a".repeat(64);
const loaded = { slug: "proposta", title: "Proposta Alder", excerpt: "", size: 10, mtime: "2026-10-01T14:00:00Z", sha: SHA, rev: 1, author: "bot",
  author_label: "Vendas", by_you: false, editable: true, content: "# Proposta\n\nTexto.", redacted: false };
/** The editor's own width, as a ResizeObserver reports it (the side panel is 380 px). */
function width(px: number) {
  vi.stubGlobal("ResizeObserver", class { constructor(private cb: (e: any[]) => void) {} observe() { this.cb([{ contentRect: { width: px } }]); } disconnect() {} });
}
const viewport = (phone: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches: phone && q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {} }));
async function openEditor(onPanelKey = vi.fn()) {
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "x", auth_mode: "gated" } : url.endsWith("/pages/proposta") ? loaded : {}));
  render(<div onKeyDown={onPanelKey}><PageView bot={{ name: "vendas", label: "Vendas" }} slug="proposta" /></div>);
  fireEvent.click(await screen.findByRole("button", { name: "Editar" }));
  return onPanelKey;
}
const source = () => screen.queryByLabelText("Texto da página em Markdown");
const preview = () => screen.queryByRole("region", { name: /Prévia/ });

beforeEach(() => { cleanup(); setLuveLocale("pt"); resetCsrfToken(); });
afterEach(() => { vi.unstubAllGlobals(); setCustomFetchJSON(null); });

describe("the page editor in a narrow place, and expanded", () => {
  it("in the side panel: one at a time (Editar | Prévia), never squeezed side by side", async () => {
    viewport(false); width(380);
    await openEditor();
    const tabs = within(screen.getByRole("tablist"));
    expect(tabs.getByRole("tab", { name: "Editar" }).getAttribute("aria-selected")).toBe("true");
    expect(source()).toBeTruthy();
    expect(preview()).toBeNull();
    fireEvent.click(tabs.getByRole("tab", { name: "Prévia" }));
    expect(preview()).toBeTruthy();
    expect(source()).toBeNull();
  });

  it("'Expandir' covers the main area with both side by side; 'Recolher' brings it back", async () => {
    viewport(false); width(380);
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Expandir" }));
    const root = source()!.closest("[data-expanded]") as HTMLElement;
    expect(root.style.position).toBe("fixed");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(source()).toBeTruthy();
    expect(preview()).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recolher" }));
    expect(document.querySelector("[data-expanded]")).toBeNull();
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("Esc collapses the expanded editor and does not reach the panel (which would close it)", async () => {
    viewport(false); width(380);
    const panelKey = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Expandir" }));
    fireEvent.keyDown(source()!, { key: "Escape" });
    expect(document.querySelector("[data-expanded]")).toBeNull();
    expect(panelKey).not.toHaveBeenCalled();
    fireEvent.keyDown(source()!, { key: "Escape" });   // not expanded: Esc is the panel's again
    expect(panelKey).toHaveBeenCalledTimes(1);
  });

  it("wide enough, both side by side; on a phone, one at a time and no 'Expandir' (the sheet is already the whole screen)", async () => {
    viewport(false); width(1100);
    await openEditor();
    expect(source()).toBeTruthy();
    expect(preview()).toBeTruthy();
    cleanup();
    viewport(true); width(390);
    await openEditor();
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Expandir" })).toBeNull();
  });
});
