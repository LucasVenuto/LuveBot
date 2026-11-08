// tests/unit/viewer/document-viewer.test.tsx
// HTML and SVG of a Bot's workspace (contract v0.6 §5.1-§5.4 as amended by §15). SVG: only with an .svg name AND an SVG root;
// HTML doctype, <html>, <!ENTITY>, an internal subset or non-UTF-8 refused; size from the root (width/height, else viewBox, else the
// display box), 50 MP checked before drawing; rasterized off-DOM to a PNG, the SVG URL revoked. HTML: only with an .html name and
// UTF-8 bytes that are no image; navigating tags neutralized by NAME (entities and a ">" in a quoted value change nothing), THEN
// the CSP and referrer metas at byte 0; one iframe with exactly sandbox="", no-referrer, allow=""; the warning outside the frame.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { isSvg, svgSize, canvasSize, frameText, FRAME_PREFIX, DISPLAY_BOX } from "@/components/viewer/document";
import { checkViewable } from "@/components/viewer/viewable";
import { PageViewer } from "@/components/viewer/PageViewer";
import { FileCard } from "@/components/conversation/FileCard";
import { setCustomFetchJSON } from "@/api/client";

if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = () => fail(r.error); r.readAsArrayBuffer(this); });
  };
}
if (typeof Blob.prototype.text !== "function") {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = () => fail(r.error); r.readAsText(this); });
  };
}

const enc = (s: string) => new TextEncoder().encode(s);
const SVG = '<?xml version="1.0"?>\n<!-- desenho do Bot -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><rect width="320" height="200"/></svg>';

let drawn: number;
let made: Array<{ url: string; type: string }>;
let revoked: string[];
beforeEach(() => {
  cleanup(); drawn = 0; made = []; revoked = [];
  (URL as any).createObjectURL = vi.fn((b: Blob) => { const url = `blob:luvebot/${made.length + 1}`; made.push({ url, type: b.type }); return url; });
  (URL as any).revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  (globalThis as any).createImageBitmap = vi.fn(async () => ({ close() {} }));
  (globalThis as any).Image = class { src = ""; decode = vi.fn(async () => {}); };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({ drawImage: () => { drawn += 1; } }) as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) { cb(new Blob(["png"], { type: "image/png" })); });
  setCustomFetchJSON(async () => ({ rules: [] }));
});
afterEach(() => { delete (window as any).__HERMES_PLUGIN_SDK__; setCustomFetchJSON(null); vi.restoreAllMocks(); });

describe("SVG is recognized only by the name AND its root", () => {
  it("accepts BOM, whitespace, <?xml?>, comments and <!DOCTYPE svg> before the root; refuses the rest", () => {
    expect(isSvg("g.svg", SVG)).toBe(true);
    expect(isSvg("g.svg", "\uFEFF  <svg viewBox='0 0 1 1'/>")).toBe(true);
    expect(isSvg("g.png", SVG)).toBe(false);                                                      // the name must agree
    expect(isSvg("g.svg", "<!DOCTYPE html><svg></svg>")).toBe(false);
    expect(isSvg("g.svg", "<html><svg></svg></html>")).toBe(false);
    expect(isSvg("g.svg", '<!DOCTYPE svg [<!ENTITY a "x">]><svg>&a;</svg>')).toBe(false);          // B4
    expect(isSvg("g.svg", "<!DOCTYPE svg [ ]><svg/>")).toBe(false);                               // an internal subset
    expect(isSvg("g.svg", "<div><svg></svg></div>")).toBe(false);                                // the root is not <svg
    expect(isSvg("g.svg", null)).toBe(false);                                                    // not UTF-8
  });

  it("size from width/height, else viewBox, else the display box; the canvas stays within 4096 px and 16 MP", () => {
    expect(svgSize('<svg width="320px" height="200">')).toEqual({ width: 320, height: 200 });
    expect(svgSize('<svg viewBox="0 0 800 600">')).toEqual({ width: 800, height: 600 });
    expect(svgSize('<svg width="100%" height="50%">')).toEqual(DISPLAY_BOX);
    expect(canvasSize({ width: 10000, height: 1000 })).toEqual({ width: 4096, height: 409 });
    const big = canvasSize({ width: 6000, height: 6000 });
    expect(big.width * big.height).toBeLessThanOrEqual(16_000_000);
  });
});

describe("an SVG becomes a PNG", () => {
  it("rasterized off-DOM: the Blob shown is image/png; the SVG URL is revoked once decoded; nothing SVG is left in the document", async () => {
    const out = await checkViewable(new File([enc(SVG)], "grafico.svg"), "grafico.svg");
    expect(out).toMatchObject({ kind: "image", width: 320, height: 200 });
    expect(out.kind === "image" && out.blob.type).toBe("image/png");
    expect(drawn).toBe(1);
    expect(made).toEqual([{ url: "blob:luvebot/1", type: "image/svg+xml" }]);
    expect(revoked).toEqual(["blob:luvebot/1"]);
    expect(document.querySelectorAll("svg, img, canvas").length).toBe(0);  // the image and the canvas never touched the document
  });

  it("an SVG the browser will not rasterize (foreignObject taints the canvas: SecurityError) is its own state, 'svg_unsupported', never an error and never shown as an SVG (red team V2)", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => { throw new DOMException("Tainted canvases may not be exported.", "SecurityError"); });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><foreignObject width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml">oi</div></foreignObject></svg>';
    expect((await checkViewable(new File([enc(svg)], "diagrama.svg"), "diagrama.svg")).kind).toBe("svg_unsupported");
    expect(document.querySelectorAll("svg, img, canvas, iframe").length).toBe(0);               // no <img src=blob:>, no frame: failed closed
    // anything else that goes wrong stays 'error': a broken SVG does not decode
    (globalThis as any).Image = class { src = ""; decode = vi.fn(async () => { throw new DOMException("The source image cannot be decoded.", "EncodingError"); }); };
    expect((await checkViewable(new File([enc(svg)], "diagrama.svg"), "diagrama.svg")).kind).toBe("error");
  });

  it("the viewer says it calmly, in words, with Baixar at hand, and the noun is SVG, not page", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(() => { throw new DOMException("Tainted", "SecurityError"); });
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><foreignObject width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml">oi</div></foreignObject></svg>';
    const onDownload = vi.fn();
    render(<PageViewer name="diagrama.svg" load={async () => new Blob([enc(svg)])} onDownload={onDownload} onClose={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Página diagrama.svg" });
    const note = await within(dialog).findByText(/Este SVG usa recursos .* Baixe para ver\./);
    expect(note.closest("p")!.getAttribute("role")).toBe("status");                                  // a calm line, not an alert
    expect(note.textContent).not.toMatch(/não foi possível|página/i);
    fireEvent.click(within(note.closest("p") as HTMLElement).getByRole("button", { name: "Baixar" }));
    expect(onDownload).toHaveBeenCalled();
    expect(within(dialog).queryByTestId("page-frame")).toBeNull();
  });

  it("over 50 MP by its root: too large, never drawn; a .png holding SVG and an .svg holding HTML are not recognized", async () => {
    const huge = '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"></svg>';
    expect((await checkViewable(new File([enc(huge)], "a.svg"), "a.svg")).kind).toBe("too_large");
    expect((await checkViewable(new File([enc(SVG)], "a.png"), "a.png")).kind).toBe("unrecognized_type");
    expect((await checkViewable(new File([enc("<!DOCTYPE html><html><body>x</body></html>")], "a.svg"), "a.svg")).kind).toBe("unrecognized_type");
    expect(drawn).toBe(0);
  });
});

describe("an HTML page goes into an isolated frame", () => {
  it("navigating tags renamed by NAME whatever entities or quoted '>' say; the CSP and referrer metas at byte 0, before any doctype", () => {
    const page = '<!DOCTYPE html><META http-equiv="&#114;efresh" content="0;url=https://fora.example">' +
      '<meta content="a>b" http-equiv="refresh"><link rel=prefetch href=https://x><base href=https://x/>' +
      '<iframe srcdoc="<script>1</script>"></iframe><frame src=x><frameset></frameset><object data=x></object><embed src=x><portal src=x>' +
      '<p>texto</p><metadata>fica</metadata>';
    const out = frameText(page);
    expect(out.startsWith("<!DOCTYPE html>" + FRAME_PREFIX)).toBe(true);                // the page's own doctype first (V3), then the CSP and the rest
    expect(FRAME_PREFIX.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\';')).toBe(true);
    expect(FRAME_PREFIX).toContain('<meta name="referrer" content="no-referrer">');
    const body = out.slice("<!DOCTYPE html>".length + FRAME_PREFIX.length);
    expect(body.match(/<(meta|link|base|iframe|frame|frameset|object|embed|portal)[\s/>]/gi)).toBeNull();
    expect(body.match(/<x-luvebot-off/g)).toHaveLength(10);
    expect(body).toContain("<metadata>fica</metadata>");   // a longer name is not one of them
  });

  it("the page's doctype is kept (red team V3): at byte 0, even after a BOM and whitespace, it goes FIRST, once, before the CSP; none is ever made up", () => {
    const mode = (page: string) => new DOMParser().parseFromString(frameText(page), "text/html").compatMode;
    expect(mode("<!DOCTYPE html><p>x</p>")).toBe("CSS1Compat");                                     // standards mode, as the Bot's own file
    expect(mode("\uFEFF \n\t<!doctype HTML><p>x</p>")).toBe("CSS1Compat");
    expect(mode('<!DOCTYPE html SYSTEM "http://x.invalid/dtd"><p>x</p>')).toBe("CSS1Compat");       // a doctype loads nothing, SYSTEM included
    expect(mode("<p>sem doctype</p>")).toBe("BackCompat");                                         // none made up: it opens as the file would (quirks)
    expect(mode("<!-- antes --><!DOCTYPE html><p>x</p>")).toBe("BackCompat");                      // not at byte 0: left alone
    const out = frameText("\uFEFF  <!DOCTYPE html><META http-equiv=refresh content=0><p>x</p>");
    expect(out.startsWith("<!DOCTYPE html>" + FRAME_PREFIX)).toBe(true);                           // one doctype, then the CSP, before any content
    expect(out.match(/<!doctype/gi)).toHaveLength(1);
    expect(out).not.toMatch(/\uFEFF/);
    expect(frameText("<p>x</p>").startsWith(FRAME_PREFIX)).toBe(true);
    expect(frameText("<p>x</p>").toLowerCase()).not.toContain("<!doctype");
  });

  it("a link in the page does not navigate the frame (red team V1): every <a> and <area> is renamed by NAME, start and end tags, in any case; the page keeps its text", () => {
    const page = '<p>veja <a href="https://isca.example/login" download>aqui</a>, <A HREF=x>dois</A>, <a\nhref=y>tres</a>, <a/href=z>quatro</a> e ' +
      '<svg><a xlink:href="https://isca.example"><text>svg</text></a></svg><map name=m><area shape=rect coords="0,0,9,9" href=https://isca.example></map>' +
      '<abbr>sigla</abbr><aside>lado</aside><a-b>custom</a-b></p>';
    const out = frameText(page);
    const doc = new DOMParser().parseFromString(out, "text/html");
    expect(doc.querySelectorAll("a, area")).toHaveLength(0);                                     // nothing the browser can follow
    expect(out.slice(FRAME_PREFIX.length).match(/<\/?a[\s/>]|<area[\s/>]/gi)).toBeNull();
    expect([...doc.querySelectorAll("x-luvebot-a")].map((e) => e.textContent)).toEqual(["aqui", "dois", "tres", "quatro", "svg"]);
    expect(doc.body.textContent).toContain("veja aqui, dois, tres, quatro e svg");
    expect(doc.querySelectorAll("abbr, aside, a-b")).toHaveLength(3);                             // longer names are not links
    expect(FRAME_PREFIX).toContain("x-luvebot-a[href]{color:");                                  // and a link keeps looking like one
  });

  it("only with an .html name and UTF-8 bytes that are no image; the frame's Blob is text/html and starts with the CSP", async () => {
    const page = await checkViewable(new File([enc("<p>Relatório</p>")], "relatorio.html"), "relatorio.html");
    expect(page.kind).toBe("page");
    expect(page.kind === "page" && page.blob.type).toBe("text/html;charset=utf-8");
    expect(page.kind === "page" && (await page.blob.text()).startsWith(FRAME_PREFIX)).toBe(true);
    expect((await checkViewable(new File([enc("<p>x</p>")], "relatorio.txt"), "relatorio.txt")).kind).toBe("unrecognized_type");
    expect((await checkViewable(new File([new Uint8Array([0xff, 0xfe, 0xfd, 0x80])], "x.html"), "x.html")).kind).toBe("unrecognized_type");
  });

  it("one iframe with exactly sandbox=\"\", no-referrer and allow=\"\" on a blob: URL; the warning and close outside it; revoked on close", async () => {
    const onClose = vi.fn();
    const view = render(<PageViewer name="relatorio.html" load={async () => new Blob([enc("<h1>Oi</h1>")])} onClose={onClose} />);
    const frame = await screen.findByTestId("page-frame");
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("src")).toBe("blob:luvebot/1");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    const dialog = screen.getByRole("dialog", { name: "Página relatorio.html" });
    expect(within(dialog).getByText(/Aberta isolada: não acessa sua conta nem a internet; os links dela não abrem aqui/)).toBeTruthy();
    expect(frame.contains(within(dialog).getByRole("button", { name: "Fechar a página" }))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar a página" }));
    expect(onClose).toHaveBeenCalled();
    view.unmount();
    expect(revoked).toEqual(["blob:luvebot/1"]);
  });
});

describe("in the file card", () => {
  it("an .svg file gets a preview (the PNG); an .html file gets 'Abrir página', which opens the isolated frame", async () => {
    (window as any).__HERMES_PLUGIN_SDK__ = { authedFetch: async (url: string) => new Response(url.includes(".svg") ? enc(SVG) : enc("<h1>Relatório</h1>")) };
    const svg = render(<FileCard path="out/grafico.svg" botLabel="Vendas" bot="vendas" onDownload={() => {}} />);
    const thumb = await screen.findByRole("button", { name: "Abrir grafico.svg em tela cheia" });
    expect(within(thumb).getByRole("img").getAttribute("src")).toBe("blob:luvebot/2");   // 1 = the SVG (revoked), 2 = the PNG
    expect(made.map((m) => m.type)).toEqual(["image/svg+xml", "image/png"]);
    svg.unmount();
    render(<FileCard path="out/relatorio.html" botLabel="Vendas" bot="vendas" onDownload={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir a página relatorio.html" }));
    expect((await screen.findByTestId("page-frame")).getAttribute("sandbox")).toBe("");
  });
});
