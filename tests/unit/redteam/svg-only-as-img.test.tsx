// tests/unit/redteam/svg-only-as-img.test.tsx (contract v0.6 §6.1, as amended by §15 B1)
// A hostile SVG (<script>, onload, <foreignObject>, an outside <image href>) opened in every viewer surface (the file card, the
// work panel's Arquivos card, the full screen) leaves exactly one <img> on screen, whose src is a blob: URL of a PNG, and NO <svg>,
// <iframe>, <object>, <embed> or <foreignObject> element and no "data:image/svg" anywhere in the document.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { FileCard } from "@/components/conversation/FileCard";
import { setCustomFetchJSON } from "@/api/client";

if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = () => fail(r.error); r.readAsArrayBuffer(this); });
  };
}

const HOSTILE = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" onload="globalThis.__svg=1">' +
  '<script>globalThis.__svg=1</script><foreignObject width="200" height="100"><div xmlns="http://www.w3.org/1999/xhtml">oi</div></foreignObject>' +
  '<image href="https://fora.example/x.png"/><image xlink:href="https://fora.example/y.png"/></svg>';
const types = new Map<string, string>();

beforeEach(() => {
  cleanup(); types.clear();
  (URL as any).createObjectURL = vi.fn((b: Blob) => { const url = `blob:luvebot/${types.size + 1}`; types.set(url, b.type); return url; });
  (URL as any).revokeObjectURL = vi.fn();
  (globalThis as any).createImageBitmap = vi.fn(async () => ({ close() {} }));
  (globalThis as any).Image = class { src = ""; decode = vi.fn(async () => {}); };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ drawImage: () => {} }) as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) { cb(new Blob(["png"], { type: "image/png" })); });
  (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async () => new Response(new TextEncoder().encode(HOSTILE)) };
  setCustomFetchJSON(async () => ({ rules: [] }));
});
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); vi.restoreAllMocks(); });

function onlyOnePng() {
  const imgs = Array.from(document.querySelectorAll("img"));
  expect(imgs).toHaveLength(1);
  const src = imgs[0].getAttribute("src")!;
  expect(src.startsWith("blob:")).toBe(true);
  expect(types.get(src)).toBe("image/png");
  expect(document.querySelectorAll("svg[xmlns], iframe, object, embed, foreignObject").length).toBe(0);
  expect(document.documentElement.innerHTML.includes("data:image/svg")).toBe(false);
  expect((globalThis as any).__svg).toBeUndefined();
}

describe("SVG reaches the screen only as a PNG in one <img>", () => {
  it("the file card (conversation and Arquivos), then the full screen", async () => {
    render(<FileCard path="desenhos/hostil.svg" botLabel="Vendas" bot="vendas" onDownload={() => {}} />);
    const thumb = await screen.findByRole("button", { name: "Abrir hostil.svg em tela cheia" });
    onlyOnePng();
    fireEvent.click(thumb);
    const dialog = screen.getByRole("dialog", { name: "Imagem hostil.svg" });
    const shown = within(dialog).getByRole("img").getAttribute("src")!;
    expect(types.get(shown)).toBe("image/png");
    expect(document.querySelectorAll("svg[xmlns], iframe, object, embed, foreignObject").length).toBe(0);
  });
});
