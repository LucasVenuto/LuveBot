// tests/unit/ui/luve-preview.test.tsx
// Crie seu Luve U3 (proposal §5): the studio's preview is the 2D art at once, the 3D view when dist/luve3d.js loads and WebGL works,
// and the 2D art again if either fails or the context is lost. The 3D gets only the parsed recipe, follows the choices, and is
// disposed with the studio. The PNG (1024 px) comes from the 3D canvas, else from the 2D art, and is saved from a detached link;
// it never goes to the server.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/viewer/document", async (orig) => ({ ...(await orig<typeof import("@/components/viewer/document")>()), rasterizeSvg: vi.fn(async () => new Blob(["png-2d"], { type: "image/png" })) }));

import { LuveStudio } from "@/components/ui/LuveStudio";
import { rasterizeSvg } from "@/components/viewer/document";
import { KIT, parseLuve } from "@/components/ui/luve";
import { buildLuveSvg } from "../../../assets/mascots/luve.mjs";
import type { Luve3dView } from "@/luve3d/api";

const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
const SWATCH = (KIT.swatches[0].base as string).slice(1);
const RECIPE = `nimbo.fosco.lupa.${SWATCH}`;
let view: Luve3dView & { set: ReturnType<typeof vi.fn>; toPNG: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
let mount: ReturnType<typeof vi.fn>;
let clicks: { href: string; download: string }[], created: ReturnType<typeof vi.fn>, revoked: ReturnType<typeof vi.fn>;

beforeEach(() => {
  view = { set: vi.fn(), toPNG: vi.fn(async () => new Blob(["png-3d"], { type: "image/png" })), dispose: vi.fn() } as never;
  mount = vi.fn(() => view);
  clicks = [];
  created = vi.fn((b: Blob) => `blob:luvebot/${b.size}`);
  revoked = vi.fn();
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicks.push({ href: this.href, download: this.download }); });
  vi.mocked(rasterizeSvg).mockClear();
  delete window.__LUVEBOT_LUVE3D__;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke });
  for (const s of document.head.querySelectorAll("script[src]")) s.remove();
});

const studio = () => render(<LuveStudio open onClose={() => {}} onUse={() => {}} useLabel="Usar" initial={RECIPE} />);
const art = () => document.querySelector(".lb-luve-preview-art")!;
const with3d = () => { window.__LUVEBOT_LUVE3D__ = { version: 1, mount } as never; };

describe("the preview", () => {
  it("is the 2D art at once, and the 3D view once the file is there: mounted on the canvas with the parsed recipe only", async () => {
    with3d();
    studio();
    expect(art().querySelector("img")).not.toBeNull();                       // 2D first, never an empty box
    await waitFor(() => expect(art().getAttribute("data-view")).toBe("3d"));
    expect(mount).toHaveBeenCalledTimes(1);
    expect(mount.mock.calls[0][0]).toBe(art().querySelector("canvas"));
    expect(mount.mock.calls[0][1]).toEqual(parseLuve(RECIPE));
    expect(mount.mock.calls[0]).toHaveLength(2);                             // nothing else is handed over
    expect(art().querySelector("img")).toBeNull();
    expect(art().getAttribute("aria-hidden")).toBe("true");
  });

  it("follows each choice with set(), never mounting again, and is disposed with the studio", async () => {
    with3d();
    const { unmount } = studio();
    await waitFor(() => expect(art().getAttribute("data-view")).toBe("3d"));
    view.set.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Forma Tico" }));
    await waitFor(() => expect(view.set).toHaveBeenCalledWith(expect.objectContaining({ shape: "tico", material: "fosco", accessory: "lupa" })));
    expect(mount).toHaveBeenCalledTimes(1);
    expect(view.dispose).not.toHaveBeenCalled();
    unmount();
    expect(view.dispose).toHaveBeenCalledTimes(1);
  });

  it("stays 2D when the file does not load (no 3D file, no crash), and when WebGL is missing (mount throws)", async () => {
    studio();                                                                 // nothing registered: the loader adds the script…
    const script = document.head.querySelector<HTMLScriptElement>("script[src]")!;
    await act(async () => { script.onerror!(new Event("error")); });
    expect(art().getAttribute("data-view")).toBe("2d");
    expect(art().querySelector("img")).not.toBeNull();
    cleanup();
    with3d();
    mount.mockImplementation(() => { throw new Error("no webgl"); });
    studio();
    await waitFor(() => expect(mount).toHaveBeenCalled());
    expect(art().getAttribute("data-view")).toBe("2d");
    expect(art().querySelector("img")).not.toBeNull();
  });

  it("goes back to the 2D art, disposing the view, when the WebGL context is lost", async () => {
    with3d();
    studio();
    await waitFor(() => expect(art().getAttribute("data-view")).toBe("3d"));
    act(() => { art().querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost")); });
    expect(art().getAttribute("data-view")).toBe("2d");
    expect(view.dispose).toHaveBeenCalledTimes(1);
    expect(art().querySelector("img")).not.toBeNull();
  });
});

describe("the PNG", () => {
  const download = () => fireEvent.click(screen.getByRole("button", { name: "Baixar PNG" }));

  it("comes from the 3D canvas at 1024 px and is saved from a detached link named for the shape, then revoked", async () => {
    with3d();
    studio();
    await waitFor(() => expect(art().getAttribute("data-view")).toBe("3d"));
    download();
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(view.toPNG).toHaveBeenCalledExactlyOnceWith(1024);
    expect(clicks[0].download).toBe("luve-nimbo.png");
    expect(clicks[0].href).toMatch(/^blob:luvebot\//);
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }));
    expect(document.querySelector("a[download]")).toBeNull();               // the link was never left on the page
    await waitFor(() => expect(revoked).toHaveBeenCalledWith(clicks[0].href));
    expect(rasterizeSvg).not.toHaveBeenCalled();
  });

  it("plan B: without the 3D it is drawn from the 2D art, an SVG the plugin built, at 1024 px, handed to the off-DOM rasterizer", async () => {
    studio();                                                                 // the 3D file never arrives
    download();
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0].download).toBe("luve-nimbo.png");
    const [svg, size] = vi.mocked(rasterizeSvg).mock.calls[0];
    expect(size).toEqual({ width: 1024, height: 1024 });
    expect(svg.type).toBe("image/svg+xml");
    const text = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsText(svg); });
    expect(text).toBe(buildLuveSvg(parseLuve(RECIPE), undefined, false)!.replace("<svg ", '<svg width="1024" height="1024" '));
  });

  it("a view that fails to draw (a lost context) falls back to the 2D art; if that fails too it says so, and saves nothing", async () => {
    with3d();
    view.toPNG.mockRejectedValue(new Error("lost"));
    studio();
    await waitFor(() => expect(art().getAttribute("data-view")).toBe("3d"));
    download();
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(rasterizeSvg).toHaveBeenCalledTimes(1);
    vi.mocked(rasterizeSvg).mockRejectedValueOnce(new Error("no canvas"));
    download();
    expect((await screen.findByRole("alert")).textContent).toBe("Não deu para gerar o PNG. Tente de novo.");
    expect(clicks).toHaveLength(1);
  });
});
