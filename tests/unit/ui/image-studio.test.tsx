// tests/unit/ui/image-studio.test.tsx
// "Enviar imagem" (contract v0.11 §2.3, slice AV-5): the entry only exists when the backend has the avatar routes; a file is judged by its BYTES before anything is decoded;
// the crop (keyboard, zoom, centre) decides which square of the source is drawn on the 256 x 256 canvas; "Usar" exports a NEW PNG (opaque RGB when the first is over the server's
// cap), sends it with CSRF, and hands back only the id the server made. Nothing is worn until the screen saves. (Canvas, decoding and the real PNG are proven in a real Chrome:
// tests/harness/evidence/luve-browser/avatar.mjs.)
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ImageEntry } from "@/components/ui/ImageStudio";
import { forgetAvatarProbe } from "@/components/ui/avatarImage";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";

// jsdom's Blob has no arrayBuffer(): read it the way a browser would
if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function (this: Blob) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = no; r.readAsArrayBuffer(this); }); };

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A file whose BYTES say PNG w x h (signature + IHDR + filler). */
const pngFile = (w: number, h: number, name = "foto.png", extra = 64) => {
  const b = new Uint8Array(33 + extra);
  b.set(SIG, 0); b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  return new File([b], name, { type: "image/png" });
};
const jpegFile = (w: number, h: number) => {   // SOI, a frame header (SOF0) saying h x w, filler
  const b = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  return new File([b], "foto.jpg", { type: "image/jpeg" });
};
const textFile = (s: string, name = "x.png") => new File([new TextEncoder().encode(s)], name, { type: "image/png" });

const ID = "img_" + "0123456789abcdef".repeat(2);
let probe: "ok" | "missing" | "network", bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[], decodeSize: [number, number], decodeFails: boolean;
let draws: number[][], ctxOpts: unknown[], fills: string[], exportSizes: number[], sent: { url: string; method: string; body: unknown; headers: Headers }[], uploadReply: () => unknown;
const ctx = { imageSmoothingEnabled: false, imageSmoothingQuality: "low", fillStyle: "", clearRect: vi.fn(), fillRect: vi.fn(function (this: unknown) { fills.push(String(ctx.fillStyle)); }), drawImage: vi.fn((...a: unknown[]) => { draws.push(a.slice(1).map(Number)); }) };

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-img"); forgetAvatarProbe();
  probe = "ok"; bitmaps = []; decodeSize = [800, 600]; decodeFails = false; draws = []; ctxOpts = []; fills = []; exportSizes = []; sent = [];
  uploadReply = () => ({ id: ID, width: 256, height: 256, bytes: 1234 });
  ctx.clearRect.mockClear(); ctx.fillRect.mockClear(); ctx.drawImage.mockClear();
  (window as any).__HERMES_PLUGIN_SDK__ = {
    authedFetch: vi.fn(async (url: string) => {
      if (!url.includes("/avatars/")) throw new Error("unexpected " + url);
      if (probe === "network") throw new TypeError("Failed to fetch");
      if (probe === "missing") return new Response('{"detail":"Not Found"}', { status: 404 });                          // the dashboard's own catch-all: no LuveBot envelope
      return new Response('{"error":{"code":"avatar_not_found","message":"x"}}', { status: 404 });                    // our route, answering
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((_: string, opts?: unknown) => { ctxOpts.push(opts); return ctx; }) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb: BlobCallback, type?: string) {
    const size = exportSizes.shift() ?? 4000;
    cb(new Blob([new Uint8Array(size)], { type: type ?? "image/png" }));
  } as never);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => {
    if (decodeFails) throw new DOMException("bad", "InvalidStateError");
    const bm = { width: decodeSize[0], height: decodeSize[1], close: vi.fn() };
    bitmaps.push(bm);
    return bm;
  }));
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-img", actor: "dashboard", auth_mode: "gated" };
    if (url.endsWith("/avatars") && method === "POST") { sent.push({ url, method, body: init?.body, headers: new Headers(init?.headers) }); const r = uploadReply(); if (r instanceof Error) throw r; return r; }
    throw new Error("unexpected " + method + " " + url);
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (window as any).__HERMES_PLUGIN_SDK__; });

const mount = (props: Partial<React.ComponentProps<typeof ImageEntry>> = {}) => {
  const onUse = vi.fn(), onRemove = vi.fn();
  const view = render(<ImageEntry useLabel="Usar em Vendas" onUse={onUse} onRemove={onRemove} {...props} />);
  return { onUse, onRemove, ...view };
};
const open = async (props: Partial<React.ComponentProps<typeof ImageEntry>> = {}) => {
  const m = mount(props);
  fireEvent.click(await screen.findByTestId("btn-avatar-send"));
  return m;
};
const pick = async (file: File) => {
  const input = screen.getByTestId("avatar-file") as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); await new Promise((r) => setTimeout(r, 15)); });
};
const lastDraw = () => draws.at(-1)!;   // [sx, sy, size, size, dx, dy, dw, dh] of the last drawImage (the preview ones are 0,0,256,256 -> 64)
const mainDraw = () => [...draws].reverse().find((d) => d[4] === 0 && d[6] === 256 && d[3] !== 256) ?? [...draws].reverse().find((d) => d[6] === 256)!;

describe("only where the backend has the routes", () => {
  it("not shown when the answer is the dashboard's catch-all (no LuveBot envelope: the routes are not there)", async () => {
    probe = "missing";
    const { container } = mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("btn-avatar-send")).toBeNull();
  });

  it("shown when our route answers, even with a 404 (an id that cannot exist is not found: that is the route working)", async () => {
    mount();
    expect((await screen.findByTestId("btn-avatar-send")).textContent).toBe("Enviar imagem");
  });

  it("a network failure is not an answer: not shown now, and the next screen asks again", async () => {
    probe = "network";
    const { container, unmount } = mount();
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(container.textContent).toBe("");
    unmount();
    probe = "ok";
    mount();
    expect(await screen.findByTestId("btn-avatar-send")).toBeDefined();
  });

  it("'Remover imagem' is there only while the face is an image, and only with a handler", async () => {
    mount();
    await screen.findByTestId("btn-avatar-send");
    expect(screen.queryByTestId("btn-avatar-remove")).toBeNull();
    cleanup();
    const { onRemove } = mount({ worn: true });
    fireEvent.click(await screen.findByTestId("btn-avatar-remove"));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("choosing the file", () => {
  it("starts at 'Escolher uma imagem' with the privacy sentence and a chooser that takes PNG, JPEG and WebP (no canvas yet)", async () => {
    await open();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("button", { name: "Escolher uma imagem" })).toBeDefined();
    expect((screen.getByTestId("avatar-file") as HTMLInputElement).accept).toBe("image/png,image/jpeg,image/webp");
    expect(screen.getByTestId("avatar-privacy").textContent).toBe("A imagem fica no seu servidor, entra no backup do LuveBot, e “Remover” a apaga (um backup mais antigo ainda a guarda).");
    expect(screen.queryByTestId("avatar-canvas")).toBeNull();
    expect(screen.queryByTestId("avatar-use")).toBeNull();
  });

  it("a PNG: decoded honouring its orientation, then the crop with the square centred at the shorter side", async () => {
    await open();
    await pick(pngFile(800, 600));
    expect(await screen.findByTestId("avatar-canvas")).toBeDefined();
    expect((globalThis.createImageBitmap as any).mock.calls[0][1]).toEqual({ imageOrientation: "from-image" });
    expect(mainDraw()).toEqual([100, 0, 600, 600, 0, 0, 256, 256]);
    expect(screen.getByTestId("avatar-preview-round")).toBeDefined();
    expect(screen.getByTestId("avatar-preview-square")).toBeDefined();
    expect(screen.getByRole("group", { name: "Área do rosto" })).toBeDefined();
    expect(screen.getByTestId("avatar-privacy")).toBeDefined();   // the sentence stays while cropping
  });

  it("a JPEG and a WebP are taken too (by their bytes)", async () => {
    decodeSize = [1200, 900];
    await open();
    await pick(jpegFile(1200, 900));
    expect(await screen.findByTestId("avatar-canvas")).toBeDefined();
    expect(mainDraw()).toEqual([150, 0, 900, 900, 0, 0, 256, 256]);
  });

  it.each([
    ["text with a .png name", () => textFile("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), "Isso não parece uma imagem PNG, JPEG ou WebP."],
    ["HTML", () => textFile("<!doctype html><script>alert(1)</script>", "pagina.png"), "Isso não parece uma imagem PNG, JPEG ou WebP."],
    ["a GIF", () => new File([new TextEncoder().encode("GIF89a" + "\0".repeat(60))], "a.gif", { type: "image/gif" }), "Só PNG, JPEG e WebP. Escolha outra imagem."],
    ["a PNG that claims 30000 x 30000 pixels (a bomb)", () => pngFile(30000, 30000), "A imagem tem pixels demais para abrir neste aparelho. Escolha uma menor."],
    ["a file over 25 MB", () => Object.defineProperty(pngFile(100, 100), "size", { value: 26 * 1024 * 1024 }), "O arquivo é grande demais (máximo 25 MB)."],
  ])("%s: said in words, and NOTHING is decoded", async (_name, make, words) => {
    await open();
    await pick(make());
    expect((await screen.findByTestId("avatar-error")).textContent).toContain(words);
    expect((globalThis.createImageBitmap as any)).not.toHaveBeenCalled();
    expect(screen.queryByTestId("avatar-canvas")).toBeNull();
    expect(screen.getByRole("button", { name: "Escolher uma imagem" })).toBeDefined();   // and the person can choose another
  });

  it("a file the browser cannot decode is 'Não deu para abrir esta imagem.'", async () => {
    decodeFails = true;
    await open();
    await pick(pngFile(800, 600));
    expect((await screen.findByTestId("avatar-error")).textContent).toContain("Não deu para abrir esta imagem.");
    expect(screen.queryByTestId("avatar-canvas")).toBeNull();
  });

  it("the file is judged by its bytes, never its name or type: a .jpg name on PNG bytes is a PNG, a .png name on text is not an image", async () => {
    decodeSize = [640, 480];
    await open();
    const real = pngFile(640, 480, "so-o-nome-diz.jpg");
    await pick(real);
    expect(await screen.findByTestId("avatar-canvas")).toBeDefined();
    expect(mainDraw()).toEqual([80, 0, 480, 480, 0, 0, 256, 256]);
  });
});

describe("the crop", () => {
  const cropped = async () => { decodeSize = [1000, 600]; await open(); await pick(pngFile(1000, 600)); await screen.findByTestId("avatar-canvas"); };
  const key = (k: string) => fireEvent.keyDown(screen.getByRole("group", { name: "Área do rosto" }), { key: k });

  it("the arrow keys move the square by 5% of its side, and stop at the edge", async () => {
    await cropped();
    expect(mainDraw().slice(0, 3)).toEqual([200, 0, 600]);
    key("ArrowRight");
    await waitFor(() => expect(mainDraw()[0]).toBeCloseTo(230, 6));   // 600 * 0.05 = 30
    for (let i = 0; i < 30; i++) key("ArrowRight");
    await waitFor(() => expect(mainDraw()[0]).toBeCloseTo(400, 6));   // 1000 - 600: the right edge
    key("ArrowUp");
    await waitFor(() => expect(mainDraw()[1]).toBeCloseTo(0, 6));      // already at the top of a 600-high image
  });

  it("+ and − zoom (the square shrinks to a quarter and back), Home goes back to the start", async () => {
    await cropped();
    key("+"); key("+");
    await waitFor(() => expect(mainDraw()[2]).toBeCloseTo(400, 6));    // zoom 1.5: 600 / 1.5
    key("-");
    await waitFor(() => expect(mainDraw()[2]).toBeCloseTo(480, 6));    // zoom 1.25
    for (let i = 0; i < 20; i++) key("+");
    await waitFor(() => expect(mainDraw()[2]).toBeCloseTo(150, 6));    // never past a quarter: 600 / 4
    key("Home");
    await waitFor(() => expect(mainDraw().slice(0, 3)).toEqual([200, 0, 600]));
  });

  it("the zoom slider and 'Centralizar' do the same, and the slider is named", async () => {
    await cropped();
    const slider = screen.getByRole("slider", { name: "Zoom" }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "2" } });
    await waitFor(() => expect(mainDraw()[2]).toBeCloseTo(300, 6));
    key("ArrowLeft");
    fireEvent.click(screen.getByRole("button", { name: "Centralizar" }));
    await waitFor(() => expect(mainDraw().slice(0, 3)).toEqual([200, 0, 600]));
    expect(slider.min).toBe("1"); expect(slider.max).toBe("4");
  });

  it("a key that is not the crop's does nothing (and is not swallowed)", async () => {
    await cropped();
    const before = ctx.drawImage.mock.calls.length;
    const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    screen.getByRole("group", { name: "Área do rosto" }).dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(ctx.drawImage.mock.calls.length).toBe(before);
  });

  it("'Escolher outra' goes back to the chooser and lets the decoded picture go", async () => {
    await cropped();
    fireEvent.click(screen.getByRole("button", { name: "Escolher outra" }));
    expect(screen.queryByTestId("avatar-canvas")).toBeNull();
    expect(screen.getByRole("button", { name: "Escolher uma imagem" })).toBeDefined();
    await waitFor(() => expect(bitmaps[0].close).toHaveBeenCalled());
  });

  it("closing the dialog lets the decoded picture go and sends nothing", async () => {
    await cropped();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bitmaps[0].close).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });
});

describe("Usar", () => {
  const ready = async () => { const m = await open(); await pick(pngFile(800, 600)); await screen.findByTestId("avatar-canvas"); return m; };

  it("exports a PNG, sends THAT with CSRF and Content-Type image/png, and hands back only the id; the dialog closes and no blob: URL was made", async () => {
    const createdUrl = vi.fn(() => "blob:nope");
    Object.assign(URL, { createObjectURL: createdUrl });
    const { onUse } = await ready();
    exportSizes = [123_456];
    fireEvent.click(screen.getByTestId("avatar-use"));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(ID));
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get("Content-Type")).toBe("image/png");
    expect(sent[0].headers.get("X-LuveBot-CSRF")).toBe("csrf-img");
    expect((sent[0].body as Blob).size).toBe(123_456);
    expect((sent[0].body as Blob).type).toBe("image/png");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(createdUrl).not.toHaveBeenCalled();
  });

  it("over the server's 288 KiB the picture is drawn AGAIN on an opaque white background (no alpha) and THAT is sent", async () => {
    const { onUse } = await ready();
    exportSizes = [300 * 1024, 150_000];
    fireEvent.click(screen.getByTestId("avatar-use"));
    await waitFor(() => expect(onUse).toHaveBeenCalled());
    expect((sent[0].body as Blob).size).toBe(150_000);
    expect(ctxOpts).toContainEqual({ alpha: false });
    expect(fills.at(-1)).toBe("#ffffff");
  });

  it("when even the opaque one is over the cap: a sentence, nothing sent, and the person can still choose another", async () => {
    await ready();
    exportSizes = [300 * 1024, 290 * 1024];
    fireEvent.click(screen.getByTestId("avatar-use"));
    expect((await screen.findByTestId("avatar-error")).textContent).toContain("Mesmo reduzida, esta imagem ficou grande demais.");
    expect(sent).toHaveLength(0);
    expect((screen.getByTestId("avatar-use") as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ["422 invalid_image", () => new ApiError({ code: "invalid_image", message: "x", status: 422 } as never), "O servidor não aceitou esta imagem. Escolha outra."],
    ["409 avatar_quota", () => new ApiError({ code: "avatar_quota", message: "x", status: 409 } as never), "Você chegou ao limite de imagens enviadas. Remova uma antes de enviar outra."],
    ["the network", () => new Error("down"), "Não deu para enviar a imagem. Nada mudou."],
  ])("%s: the sentence, the dialog stays open, nothing is handed to the screen, and it can try again", async (_n, fail, words) => {
    const { onUse } = await ready();
    uploadReply = fail as never;
    fireEvent.click(screen.getByTestId("avatar-use"));
    expect((await screen.findByTestId("avatar-error")).textContent).toContain(words);
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeDefined();
    uploadReply = () => ({ id: ID, width: 256, height: 256, bytes: 5 });
    fireEvent.click(screen.getByTestId("avatar-use"));
    await waitFor(() => expect(onUse).toHaveBeenCalledWith(ID));
  });

  it("a second click while it is sending does not send a second time", async () => {
    const { onUse } = await ready();
    let release: (v: unknown) => void = () => {};
    setCustomFetchJSON(async (url, init) => {
      if (url.endsWith("/session")) return { csrf: "csrf-img", actor: "d", auth_mode: "gated" };
      sent.push({ url, method: init?.method ?? "GET", body: init?.body, headers: new Headers(init?.headers) });
      return new Promise((r) => { release = r; });
    });
    fireEvent.click(screen.getByTestId("avatar-use"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(screen.getByTestId("avatar-use").textContent).toBe("Enviando…");
    fireEvent.click(screen.getByTestId("avatar-use"));
    fireEvent.click(screen.getByTestId("avatar-use"));
    expect(sent).toHaveLength(1);
    release({ id: ID, width: 256, height: 256, bytes: 1 });
    await waitFor(() => expect(onUse).toHaveBeenCalledTimes(1));
  });

  it("speaks English", async () => {
    setLuveLocale("en");
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Send an image" }));
    expect(screen.getByTestId("avatar-privacy").textContent).toBe("The image stays on your server, goes into LuveBot's backup, and “Remove” deletes it (an older backup still holds it).");
    expect(screen.getByRole("button", { name: "Choose an image" })).toBeDefined();
  });
});
