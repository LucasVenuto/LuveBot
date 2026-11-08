// tests/unit/ui/avatar-image.test.tsx
// A person's own image as a face (contract v0.11 §2.3, slice AV-6): ui/avatarImage.ts is the ONLY place that turns one into something a page draws. The bytes come from
// GET /avatars/{id} through the SDK's authedFetch (never an <img src> to the route), are checked BEFORE they become a Blob (a PNG, exactly 256 x 256), and the blob: URL is shared
// by every face of the same id with a use count and revoked at zero. Any failure is the initials, as for a legacy `image` row; an external URL or a data URI is never drawn.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Avatar } from "@/components/ui/Avatar";
import { AvatarStack } from "@/components/ui/AvatarStack";
import { TeamMapView } from "@/components/map/TeamMapView";
import { acquireAvatarImage, checkAvatarBytes, isImageId, liveAvatarImages } from "@/components/ui/avatarImage";
import type { TeamMapResponse } from "@/api/types";

const ID = "img_" + "0123456789abcdef".repeat(2), ID2 = "img_" + "fedcba9876543210".repeat(2);
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The first 33 bytes of a PNG: the signature and an IHDR chunk saying w x h (all the sniffer reads); then `extra` filler bytes. */
const png = (w = 256, h = 256, extra = 40): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(33 + extra);
  b.set(SIG, 0);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
};
const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

let served: Map<string, () => Promise<Response> | Response>, asked: string[], blobs: Map<string, Blob>, created: ReturnType<typeof vi.fn>, revoked: ReturnType<typeof vi.fn>;
const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

beforeEach(() => {
  served = new Map(); asked = []; blobs = new Map();
  created = vi.fn((b: Blob) => { const url = `blob:luvebot/${blobs.size + 1}`; blobs.set(url, b); return url; });
  revoked = vi.fn();
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
  (window as any).__HERMES_PLUGIN_SDK__ = {
    authedFetch: vi.fn(async (url: string) => {
      asked.push(url);
      const id = /\/avatars\/([^/?]+)/.exec(url)?.[1] ?? "";
      const make = served.get(decodeURIComponent(id));
      if (!make) return new Response(JSON.stringify({ error: { code: "avatar_not_found", message: "x" } }), { status: 404 });
      return make();
    }),
  };
});
afterEach(() => { cleanup(); delete (window as any).__HERMES_PLUGIN_SDK__; Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke }); });

const ok = (bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) => () => new Response(bytes, { status: 200, headers: { "Content-Type": "image/png", ...headers } });
const img = (c: HTMLElement) => c.querySelector("img");
const face = (id: string = ID, extra: Partial<React.ComponentProps<typeof Avatar>> = {}) => <Avatar name="Vendas" avatar={{ kind: "image", value: id }} size={40} {...extra} />;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("the id and the bytes", () => {
  it("an id is img_ and 32 lowercase hex, nothing else", () => {
    expect(isImageId(ID)).toBe(true);
    for (const bad of ["", "img_", "img_" + "a".repeat(31), "img_" + "a".repeat(33), "img_" + "A".repeat(32), "IMG_" + "a".repeat(32), "img_" + "g".repeat(32), "../x", "https://x/y.png", "data:image/png;base64,AAAA", ID + "\n", " " + ID, null, undefined, 5, {}])
      expect(isImageId(bad), String(bad)).toBe(false);
  });

  it("only a PNG whose header says 256 x 256 passes", () => {
    expect(checkAvatarBytes(png())).toBe(true);
    for (const [name, bytes] of [["255 wide", png(255, 256)], ["256 tall by 257", png(256, 257)], ["1 x 1", png(1, 1)], ["huge", png(20000, 20000)], ["JPEG", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)])],
      ["no PNG signature, but an IHDR where one would be", (() => { const b = png(); b[0] = 0x00; return b; })()], ["SVG", text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"></svg>')], ["HTML", text("<!doctype html><script>alert(1)</script>")], ["GIF", text("GIF89a" + "\0".repeat(40))], ["empty", new Uint8Array()], ["signature only", new Uint8Array(SIG)]] as const)
      expect(checkAvatarBytes(bytes as Uint8Array), name).toBe(false);
  });
});

describe("a face of the person's own image", () => {
  it("shows the initials first, then an <img src=blob:> of exactly the bytes the server sent (image/png), fetched through authedFetch by id", async () => {
    const sent = png(256, 256, 100);
    served.set(ID, ok(sent));
    const { container } = render(face());
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe("VE");
    await waitFor(() => expect(img(container)).not.toBeNull());
    const src = img(container)!.getAttribute("src")!;
    expect(src).toMatch(/^blob:luvebot\//);
    expect(blobs.get(src)!.type).toBe("image/png");
    expect(blobs.get(src)!.size).toBe(sent.length);
    expect(img(container)!.getAttribute("alt")).toBe("");
    expect(img(container)!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(`/api/plugins/luvebot/avatars/${ID}`);
    expect(container.textContent).toBe("");   // the initials gave way to the picture
  });

  it("never draws a URL or a data URI the display carries: a legacy or malformed value is the initials and asks the server nothing", async () => {
    for (const value of ["https://tracker.example/p.png", "data:image/png;base64,iVBORw0KGgo=", "/etc/passwd", "../x", "img_" + "a".repeat(31), "img_" + "A".repeat(32), "photo.png", ""]) {
      const { container, unmount } = render(<Avatar name="Vendas" avatar={{ kind: "image", value }} size={40} />);
      await settle();
      expect(img(container), value).toBeNull();
      expect(container.textContent, value).toBe("VE");
      unmount();
    }
    expect(asked).toEqual([]);
    expect(created).not.toHaveBeenCalled();
  });

  it.each([
    ["the server says 404 (not yours, or not there)", () => new Response("{}", { status: 404 })],
    ["the server says 401", () => new Response("{}", { status: 401 })],
    ["the network fails", () => { throw new TypeError("Failed to fetch"); }],
    ["the bytes are a 255-pixel PNG", ok(png(255, 256))],
    ["the bytes are a JPEG", ok(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(40).fill(0)]) as Uint8Array<ArrayBuffer>)],
    ["the bytes are an SVG", ok(text('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" onload="alert(1)"></svg>'))],
    ["the server announces more than the cap", ok(png(), { "Content-Length": String(400 * 1024) })],
  ])("%s: the initials, no <img>, no blob made", async (_name, make) => {
    served.set(ID, make as () => Response);
    const { container } = render(face());
    await settle();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(img(container)).toBeNull();
    expect(container.textContent).toBe("VE");
    expect(created).not.toHaveBeenCalled();
  });

  it("a body over the cap is refused even when the server did not announce its size", async () => {
    served.set(ID, ok(png(256, 256, 300 * 1024)));
    const { container } = render(face());
    await settle();
    expect(img(container)).toBeNull();
    expect(created).not.toHaveBeenCalled();
  });

  it("a chunked body with no announced size is read only up to the cap and then dropped (never the whole of an endless one)", async () => {
    let pulled = 0, cancelled = false;
    const chunk = new Uint8Array(64 * 1024);
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(chunk); }, cancel() { cancelled = true; } });
    served.set(ID, () => new Response(endless, { status: 200, headers: { "Content-Type": "image/png" } }));
    const { container } = render(face());
    await settle();
    expect(img(container)).toBeNull();
    expect(created).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(12);   // 288 KiB is 4.5 chunks of 64 KiB; a few more may be queued ahead, never an unbounded read
  });

  it("a body that arrives in several chunks is put back together byte for byte", async () => {
    const whole = png(256, 256, 5000);
    const parts = [whole.slice(0, 100), whole.slice(100, 2000), whole.slice(2000)];
    served.set(ID, () => new Response(new ReadableStream<Uint8Array>({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }), { status: 200, headers: { "Content-Type": "image/png" } }));
    const { container } = render(face());
    await waitFor(() => expect(img(container)).not.toBeNull());
    expect(blobs.get(img(container)!.getAttribute("src")!)!.size).toBe(whole.length);
  });

  it("without the SDK's authedFetch there is no way to carry the session: the initials, never a plain fetch of the route", async () => {
    delete (window as any).__HERMES_PLUGIN_SDK__;
    const plain = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(png(), { status: 200 }));
    const { container } = render(face());
    await settle();
    expect(img(container)).toBeNull();
    expect(plain).not.toHaveBeenCalled();
    plain.mockRestore();
  });

  it("many faces of one id are ONE request and ONE blob, revoked once when the last lets go", async () => {
    served.set(ID, ok(png()));
    const a = render(face()), b = render(face()), c = render(<AvatarStack faces={[{ key: "1", name: "Vendas", avatar: { kind: "image", value: ID } }]} />);
    await waitFor(() => expect(img(a.container)).not.toBeNull());
    await waitFor(() => expect(img(b.container) && img(c.container)).toBeTruthy());
    expect(asked).toHaveLength(1);
    expect(created).toHaveBeenCalledTimes(1);
    expect(liveAvatarImages()).toBe(1);
    a.unmount(); b.unmount();
    expect(revoked).not.toHaveBeenCalled();
    c.unmount();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(revoked).toHaveBeenCalledWith("blob:luvebot/1");
    expect(liveAvatarImages()).toBe(0);
  });

  it("a face that goes away before the picture arrives leaves no blob behind", async () => {
    let release: (r: Response) => void = () => {};
    served.set(ID, () => new Promise<Response>((r) => { release = r; }) as never);
    const r = render(face());
    await waitFor(() => expect(asked).toHaveLength(1));
    r.unmount();
    await act(async () => { release(new Response(png(), { status: 200, headers: { "Content-Type": "image/png" } })); await new Promise((x) => setTimeout(x, 20)); });
    expect(created).not.toHaveBeenCalled();   // not even made and thrown away
    expect(liveAvatarImages()).toBe(0);
  });

  it("changing the id lets the old picture go and fetches the new one (the old URL is never left on a face)", async () => {
    served.set(ID, ok(png())); served.set(ID2, ok(png(256, 256, 80)));
    const r = render(face(ID));
    await waitFor(() => expect(img(r.container)).not.toBeNull());
    const first = img(r.container)!.getAttribute("src")!;
    r.rerender(face(ID2));
    await waitFor(() => expect(img(r.container)?.getAttribute("src")).not.toBe(first));
    expect(revoked).toHaveBeenCalledWith(first);
    expect(asked).toHaveLength(2);
    expect(img(r.container)!.getAttribute("src")).not.toBe(first);
  });

  it("a failed read stays the initials while a face holds it, and the next mount asks again", async () => {
    served.set(ID, () => new Response("{}", { status: 404 }));
    const a = render(face());
    await settle();
    expect(img(a.container)).toBeNull();
    a.unmount();
    served.set(ID, ok(png()));
    const b = render(face());
    await waitFor(() => expect(img(b.container)).not.toBeNull());
    expect(asked).toHaveLength(2);
  });

  it("a face that comes after a failed read hears the failure at once (it is not left waiting for a picture that will never come)", async () => {
    served.set(ID, () => new Response("{}", { status: 404 }));
    const first = vi.fn(), second = vi.fn();
    const letGo = acquireAvatarImage(ID, first);
    await waitFor(() => expect(first).toHaveBeenCalledWith(null));
    const letGo2 = acquireAvatarImage(ID, second);
    expect(second).toHaveBeenCalledWith(null);   // synchronously, from what is remembered
    expect(asked).toHaveLength(1);
    letGo(); letGo2();
    expect(liveAvatarImages()).toBe(0);
  });

  it("a face lets go once however many times it is told to", async () => {
    served.set(ID, ok(png()));
    const a = vi.fn(), b = vi.fn();
    const one = acquireAvatarImage(ID, a), two = acquireAvatarImage(ID, b);
    await waitFor(() => expect(b).toHaveBeenCalled());
    one(); one(); one();
    expect(revoked).not.toHaveBeenCalled();   // the other face still holds it
    two();
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it("keeps the face's own accent ring for the selected contact (a picture sits in the same tinted square as initials)", async () => {
    served.set(ID, ok(png()));
    const r = render(face(ID, { ring: true }));
    await waitFor(() => expect(img(r.container)).not.toBeNull());
    expect((r.container.firstElementChild as HTMLElement).style.boxShadow).toContain("0 0 0 2px");
  });

  it("an AvatarStack keeps the surface ring around a picture (only a mascot or a Luve is drawn loose)", async () => {
    served.set(ID, ok(png()));
    const r = render(<AvatarStack faces={[{ key: "1", name: "Vendas", avatar: { kind: "image", value: ID } }, { key: "2", name: "Suporte", avatar: { kind: "mascot", value: "luvi" } }]} />);
    await waitFor(() => expect(img(r.container)).not.toBeNull());
    const wrappers = Array.from(r.container.firstElementChild!.children) as HTMLElement[];
    expect(wrappers[0].style.boxShadow).toContain("0 0 0 2px");
    expect(wrappers[1].style.boxShadow).toBe("");
  });
});

describe("the team map", () => {
  const map = (avatar: unknown): TeamMapResponse => ({
    nodes: [{ bot: "vendas", display: { label: "Vendas", role: "", color: "#3b82f6", avatar }, status: "idle", rooms: [] } as never],
    edges: [], generated_at: "2026-10-30T12:00:00Z",
  });

  it("draws the picture in a disc (an SVG <image href=blob:> clipped to a circle) and only when it came back as the 256 x 256 PNG", async () => {
    served.set(ID, ok(png()));
    const r = render(<TeamMapView initialMapData={map({ kind: "image", value: ID })} />);
    await waitFor(() => expect(r.container.querySelector("svg image")).not.toBeNull());
    const im = r.container.querySelector("svg image")!;
    expect(im.getAttribute("href")).toMatch(/^blob:luvebot\//);
    const clip = im.getAttribute("clip-path")!;
    expect(clip).toMatch(/^url\(#lbf-[A-Za-z0-9_-]+\)$/);
    expect(r.container.querySelector(`clipPath${clip.replace(/^url\(/, "").replace(/\)$/, "")}`)).not.toBeNull();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("initials on a disc when the image cannot be read, and for a legacy value", async () => {
    served.set(ID, () => new Response("{}", { status: 404 }));
    const bad = render(<TeamMapView initialMapData={map({ kind: "image", value: ID })} />);
    await settle();
    expect(bad.container.querySelector("svg image")).toBeNull();
    expect(bad.container.textContent).toContain("VE");
    bad.unmount();
    const legacy = render(<TeamMapView initialMapData={map({ kind: "image", value: "https://tracker.example/p.png" })} />);
    await settle();
    expect(legacy.container.querySelector("svg image")).toBeNull();
    expect(asked).toHaveLength(1);   // only the first one asked; the legacy value asked nothing
  });
});
