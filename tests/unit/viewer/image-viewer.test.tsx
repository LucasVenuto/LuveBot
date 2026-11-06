// tests/unit/viewer/image-viewer.test.tsx
// The image viewer (contract v0.6 §5.1-§5.3, §5.5): the kind comes from the BYTES (a PNG-named or PNG-typed file holding HTML is
// refused; PNG bytes typed as HTML are shown as PNG); the pixel count comes from each format's HEADER before any decode (a
// 60 MP PNG, GIF, WebP in its three forms and JPEG are refused with the decoder never reached); 25 MiB; the only element is
// one <img> on a blob: URL, revoked when the preview goes away; full screen with "Baixar"; refusals said in words.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { checkImage, sniffImage, headerSize, MAX_PIXELS } from "@/components/viewer/image";
import { ImagePreview } from "@/components/viewer/ImageViewer";
import { FileCard } from "@/components/conversation/FileCard";
import { SentAttachments, splitReferences, AttachmentTray } from "@/components/conversation/Attachments";
import { ApiError, setCustomFetchJSON } from "@/api/client";

const u8 = (...parts: Array<number[] | string>) => new Uint8Array(parts.flatMap((p) => typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w: number, h: number) => u8(PNG_SIG, be32(13), "IHDR", be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
const gif = (w: number, h: number) => u8("GIF89a", le16(w), le16(h), [0, 0, 0]);
const riff = (chunk: number[]) => u8("RIFF", le16(chunk.length + 4), [0, 0], "WEBP", chunk);
const webpX = (w: number, h: number) => riff([...u8("VP8X"), ...be32(10).reverse(), 0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const webpL = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff([...u8("VP8L"), 5, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]);
};
const webp8 = (w: number, h: number) => riff([...u8("VP8 "), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const jpeg = (w: number, h: number) => u8([0xff, 0xd8, 0xff, 0xe0, 0, 16], "JFIF\0", new Array(9).fill(0),
  [0xff, 0xc0, 0, 17, 8, (h >>> 8) & 255, h & 255, (w >>> 8) & 255, w & 255, 3], new Array(9).fill(0), [0xff, 0xd9]);
// a Huffman table (C4) before the frame header, as real files have it: C4 is NOT a frame header (§5.2)
const jpegDht = (w: number, h: number) => u8([0xff, 0xd8, 0xff, 0xc4, 0, 7, 0x00, 0x7f, 0x7f, 0x7f, 0x7f],
  [0xff, 0xc0, 0, 17, 8, (h >>> 8) & 255, h & 255, (w >>> 8) & 255, w & 255, 3], new Array(9).fill(0), [0xff, 0xd9]);
const HTML = u8("<!doctype html><html><body><script>alert(1)</script></body></html>");
const SVG = u8('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');

// jsdom's Blob has no arrayBuffer(); every browser the viewer runs in does (the product reads it directly)
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = () => fail(r.error); r.readAsArrayBuffer(this); });
  };
}

let decodes: number;
let made: string[];
let revoked: string[];
beforeEach(() => {
  cleanup(); decodes = 0; made = []; revoked = [];
  (globalThis as any).createImageBitmap = vi.fn(async () => { decodes += 1; return { close() {} }; });
  (URL as any).createObjectURL = vi.fn((b: Blob) => { const url = `blob:luvebot/${made.length + 1}#${b.type}`; made.push(url); return url; });
  (URL as any).revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  setCustomFetchJSON(async () => ({ rules: [] }));
});
afterEach(() => { delete (globalThis as any).createImageBitmap; delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); vi.restoreAllMocks(); });

describe("the kind is decided by the bytes", () => {
  it("each signature, and nothing else: HTML or SVG text is no image whatever the name or type says", async () => {
    expect(sniffImage(png(10, 10))).toBe("png");
    expect(sniffImage(jpeg(10, 10))).toBe("jpeg");
    expect(sniffImage(gif(10, 10))).toBe("gif");
    expect(sniffImage(webpX(10, 10))).toBe("webp");
    expect(sniffImage(HTML)).toBeNull();
    expect(sniffImage(SVG)).toBeNull();  // SVG waits for v0.6 part B
    // a "png" typed and named as an image, holding HTML: refused, never decoded
    expect((await checkImage(new File([HTML], "foto.png", { type: "image/png" }))).kind).toBe("unrecognized_type");
    expect((await checkImage(new File([SVG], "foto.png", { type: "image/png" }))).kind).toBe("unrecognized_type");
    expect(decodes).toBe(0);
    // PNG bytes the server typed as something else are shown as what they are
    const shown = await checkImage(new File([png(4, 3)], "foto.jpg", { type: "text/html" }));
    expect(shown).toMatchObject({ kind: "ready", type: "image/png", width: 4, height: 3 });
    expect(shown.kind === "ready" && shown.blob.type).toBe("image/png");
  });
});

describe("the pixel count is read from the header, before any decode (decompression bombs)", () => {
  it("reads width and height of every format", () => {
    expect(headerSize("png", png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(headerSize("gif", gif(320, 200))).toEqual({ width: 320, height: 200 });
    expect(headerSize("webp", webpX(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(headerSize("webp", webpL(800, 600))).toEqual({ width: 800, height: 600 });
    expect(headerSize("webp", webp8(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(headerSize("jpeg", jpeg(1280, 720))).toEqual({ width: 1280, height: 720 });
    expect(headerSize("jpeg", jpegDht(1280, 720))).toEqual({ width: 1280, height: 720 });
  });

  it("over 50 MP in any format: too large, and the decoder is never reached", async () => {
    (globalThis as any).createImageBitmap = vi.fn(async () => { throw new Error("the decoder was reached"); });
    const bombs = { png: png(10_000, 6_000), gif: gif(10_000, 6_000), webpX: webpX(10_000, 6_000), webpL: webpL(16_000, 4_000), webp8: webp8(16_000, 4_000), jpeg: jpeg(10_000, 6_000) };
    for (const [name, bytes] of Object.entries(bombs)) {
      expect([name, (await checkImage(new Blob([bytes]))).kind]).toEqual([name, "too_large"]);
    }
    expect((globalThis as any).createImageBitmap).not.toHaveBeenCalled();
    expect(10_000 * 6_000).toBeGreaterThan(MAX_PIXELS);
  });

  it("within the caps the decoder runs once, as a second check; a failure there is 'não foi possível abrir'", async () => {
    expect((await checkImage(new Blob([png(100, 100)]))).kind).toBe("ready");
    expect(decodes).toBe(1);
    (globalThis as any).createImageBitmap = vi.fn(async () => { throw new Error("corrupt"); });
    expect((await checkImage(new Blob([png(100, 100)]))).kind).toBe("error");
  });

  it("over 25 MiB: too large without reading it; a header that cannot be read: download only", async () => {
    const big = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]);
    const read = vi.spyOn(big, "arrayBuffer");
    expect((await checkImage(big)).kind).toBe("too_large");
    expect(read).not.toHaveBeenCalled();
    expect((await checkImage(new Blob([u8(PNG_SIG, [0, 0])]))).kind).toBe("error");
    expect(decodes).toBe(0);
  });
});

describe("the cross review's cases (F4, F5)", () => {
  it("a PNG signature without IHDR right after it: the header is unreadable, download only, nothing decoded", async () => {
    const fake = u8(PNG_SIG, be32(13), "tEXt", be32(10), be32(10), [8, 6, 0, 0, 0], [0, 0, 0, 0]);
    expect(headerSize("png", fake)).toBeNull();
    expect((await checkImage(new Blob([fake]))).kind).toBe("error");
    expect(decodes).toBe(0);
  });

  it("a JPEG whose EXIF thumbnail is small and whose main image is 60 MP: the main frame header counts (APPn skipped by length)", async () => {
    const thumb = [0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 16, 0, 16, 3, ...new Array(9).fill(0), 0xff, 0xd9];
    const app1 = [...u8("Exif\0\0"), ...thumb];
    const bytes = u8([0xff, 0xd8, 0xff, 0xe1, ((app1.length + 2) >>> 8) & 255, (app1.length + 2) & 255], app1,
      [0xff, 0xc0, 0, 17, 8, (6000 >>> 8) & 255, 6000 & 255, (10000 >>> 8) & 255, 10000 & 255, 3], new Array(9).fill(0), [0xff, 0xd9]);
    expect(headerSize("jpeg", bytes)).toEqual({ width: 10000, height: 6000 });
    (globalThis as any).createImageBitmap = vi.fn(async () => { throw new Error("the decoder was reached"); });
    expect((await checkImage(new Blob([bytes]))).kind).toBe("too_large");
  });

  it("a GIF/HTML polyglot is a GIF image only: typed image/gif, shown in one <img>, never a page", async () => {
    const poly = u8("GIF89a", le16(10), le16(10), [0, 0, 0], "<html><body><script>alert(1)</script></body></html>");
    const checked = await checkImage(new File([poly], "pagina.html", { type: "text/html" }));
    expect(checked).toMatchObject({ kind: "ready", type: "image/gif" });
    render(<ImagePreview id="poly" name="pagina.html" load={async () => new File([poly], "pagina.html", { type: "text/html" })} />);
    await screen.findByRole("button", { name: "Abrir pagina.html em tela cheia" });
    expect(document.querySelectorAll("img")).toHaveLength(1);
    expect(document.querySelector("img")!.getAttribute("src")).toMatch(/#image\/gif$/);
    expect(document.querySelectorAll("iframe, object, embed, script")).toHaveLength(0);
  });

  it("F5: a GIF whose logical screen is 1x1 but whose first frame is 60 MP is too large (the frame grows the canvas)", async () => {
    const frame = (w: number, h: number) => u8("GIF89a", le16(1), le16(1), [0, 0, 0],
      [0x21, 0xf9, 4, 0, 0, 0, 0, 0],                               // a graphic control extension before the frame
      [0x2c, ...le16(0), ...le16(0), ...le16(w), ...le16(h), 0], [2, 2, 0x4c, 0x01, 0], [0x3b]);
    expect(headerSize("gif", frame(10_000, 6_000))).toEqual({ width: 10_000, height: 6_000 });
    expect(headerSize("gif", frame(1, 1))).toEqual({ width: 1, height: 1 });
    (globalThis as any).createImageBitmap = vi.fn(async () => { throw new Error("the decoder was reached"); });
    expect((await checkImage(new Blob([frame(10_000, 6_000)]))).kind).toBe("too_large");
  });
});

describe("the preview, full screen and the blob: URL", () => {
  it("one <img> on a blob: URL typed by the bytes; full screen with Baixar; the URL is revoked when it goes away", async () => {
    const onDownload = vi.fn();
    const view = render(<ImagePreview id="a" name="grafico.png" load={async () => new Blob([png(800, 600)], { type: "application/octet-stream" })} onDownload={onDownload} />);
    const thumb = await screen.findByRole("button", { name: "Abrir grafico.png em tela cheia" });
    const imgs = document.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe("blob:luvebot/1#image/png");
    fireEvent.click(thumb);
    const dialog = screen.getByRole("dialog", { name: "Imagem grafico.png" });
    expect(within(dialog).getByText("800 × 600 px")).toBeTruthy();
    // the viewer is dark in both themes: its name and buttons carry light colors of their own (the theme's dark text vanished)
    expect(within(dialog).getByText("grafico.png").style.color).toBe("rgb(255, 255, 255)");
    for (const name of ["Tamanho real", "Baixar"]) expect(within(dialog).getByRole("button", { name }).style.color).toBe("rgb(255, 255, 255)");
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe("blob:luvebot/1#image/png");
    fireEvent.click(within(dialog).getByRole("button", { name: "Tamanho real" }));
    expect((within(dialog).getByRole("img") as HTMLImageElement).style.width).toBe("800px");
    fireEvent.click(within(dialog).getByRole("button", { name: "Baixar" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelectorAll("iframe, object, embed, svg").length).toBe(0);
    expect(revoked).toEqual([]);
    view.unmount();
    expect(revoked).toEqual(["blob:luvebot/1#image/png"]);
  });

  it("refusals in words, with the download offered; no <img> at all", async () => {
    const cases: Array<[() => Promise<Blob>, string]> = [
      [async () => new Blob([HTML]), "Tipo não reconhecido"],
      [async () => new Blob([png(10_000, 6_000)]), "grande demais"],
      [async () => { throw new ApiError({ code: "file_redacted", message: "x", status: 409 }); }, "contém um segredo"],
      [async () => { throw new ApiError({ code: "too_large", message: "x", status: 413 }); }, "grande demais"],
    ];
    for (const [i, [load, words]] of cases.entries()) {
      const onDownload = vi.fn();
      const view = render(<ImagePreview id={`r${i}`} name="x.png" load={load} onDownload={onDownload} />);
      await waitFor(() => expect(screen.getByTestId("image-state").textContent).toContain(words));
      expect(document.querySelectorAll("img")).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Baixar" }));
      expect(onDownload).toHaveBeenCalledTimes(1);
      view.unmount();
    }
    expect(made).toEqual([]);
  });
});

describe("where it shows", () => {
  it("the file card (conversation and Arquivos) previews an image of the workspace, read with purpose=view", async () => {
    const hits: string[] = [];
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async (url: string) => { hits.push(url); return new Response(png(64, 48)); } };
    render(<FileCard path="out/grafico.png" botLabel="Vendas" bot="vendas" onDownload={() => {}} />);
    await screen.findByRole("button", { name: "Abrir grafico.png em tela cheia" });
    expect(hits).toEqual(["/api/plugins/luvebot/bots/vendas/files/download?path=out%2Fgrafico.png&purpose=view&profile=current"]);
  });

  it("a chip in the composer previews the person's own file before sending (no download: it is theirs)", async () => {
    const a = { items: [{ id: "c1", file: new File([png(64, 48)], "print.png", { type: "image/png" }) }, { id: "c2", file: new File([HTML], "pagina.png", { type: "image/png" }) }],
      busy: false, remove: () => {}, error: null, notice: null, canCreate: false, createWorkspace: async () => {} } as any;
    render(<AttachmentTray a={a} />);
    fireEvent.click(await screen.findByRole("button", { name: "Abrir print.png em tela cheia" }));
    const dialog = screen.getByRole("dialog", { name: "Imagem print.png" });
    expect(within(dialog).queryByRole("button", { name: "Baixar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Abrir pagina.png em tela cheia" })).toBeNull();  // HTML named .png: no preview
  });

  it("a sent image's chip previews the file from attachments/ and keeps the glyph while it is not an image", async () => {
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async (url: string) => new Response(url.includes("foto") ? png(64, 48) : HTML) };
    const { refs } = splitReferences("Veja\n[Anexo: attachments/0123456789abcdef0123456789abcdef-foto.png, image/png, 12 KB]\n[Anexo: attachments/0123456789abcdef0123456789abcdef-falsa.png, image/png, 1 KB]");
    expect(refs.map((r) => r.path)).toEqual(["attachments/0123456789abcdef0123456789abcdef-foto.png", "attachments/0123456789abcdef0123456789abcdef-falsa.png"]);
    render(<SentAttachments refs={refs} spaced bot="vendas" />);
    await screen.findByRole("button", { name: "Abrir foto.png em tela cheia" });
    await waitFor(() => expect(document.querySelectorAll(".lb-page-glyph")).toHaveLength(1));  // the fake one keeps its glyph
    expect(screen.queryByRole("button", { name: "Abrir falsa.png em tela cheia" })).toBeNull();
  });
});
