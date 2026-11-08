// tests/unit/ui/luve-avatar.test.tsx
// Crie seu Luve U1 (proposal docs/propostas/v02-crie-seu-luve.md §4, §5 and §8 Q4): a Bot or a person whose avatar is a Luve
// shows it everywhere a face is drawn (Avatar, AvatarStack, the team map). The SVG comes ONLY from buildLuveSvg (shipped pieces +
// the checked hex), as an <img src=blob:>; one URL per (recipe, state, mini), shared by every face that shows it and revoked when
// the last one goes; the state is the class of the root, never a fragment; a recipe that does not check shows the default mascot.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Avatar } from "@/components/ui/Avatar";
import { AvatarStack } from "@/components/ui/AvatarStack";
import { TeamMapView } from "@/components/map/TeamMapView";
import { liveLuveUrls } from "@/components/ui/luve";
import type { TeamMapResponse } from "@/api/types";
import { buildLuveSvg, parseLuve } from "../../../assets/mascots/luve.mjs";

const RECIPE = "nimbo.fosco.lupa.38bdf8";
let blobs: Map<string, Blob>, created: ReturnType<typeof vi.fn>, revoked: ReturnType<typeof vi.fn>;
const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

beforeEach(() => {
  blobs = new Map();
  created = vi.fn((b: Blob) => { const url = `blob:luvebot/${blobs.size + 1}`; blobs.set(url, b); return url; });
  revoked = vi.fn();
  Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
});
// cleanup() first: unmounting a face revokes its URL, and jsdom has no revokeObjectURL of its own to fall back on
afterEach(() => { cleanup(); Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke }); });

const img = (c: HTMLElement) => c.querySelector("img");
// jsdom's Blob has no text(): read it as a browser would
const text = (url: string) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = no; r.readAsText(blobs.get(url)!); });

describe("a Luve as a face", () => {
  it("is an <img src=blob:> of exactly buildLuveSvg's SVG (image/svg+xml), the mini drawing below 56 px", async () => {
    const { container, unmount } = render(<Avatar name="Vendas" avatar={{ kind: "luve", value: RECIPE }} size={40} />);
    const src = img(container)!.getAttribute("src")!;
    expect(src).toMatch(/^blob:luvebot\//);
    expect(blobs.get(src)!.type).toBe("image/svg+xml");
    expect(await text(src)).toBe(buildLuveSvg(parseLuve(RECIPE), undefined, true));
    expect(img(container)!.getAttribute("alt")).toBe("");
    unmount();
    const big = render(<Avatar name="Vendas" avatar={{ kind: "luve", value: RECIPE }} size={96} />);
    expect(await text(img(big.container)!.getAttribute("src")!)).toBe(buildLuveSvg(parseLuve(RECIPE), undefined, false));
  });

  it("the state is the class of the SVG's root (is-working / needs-you), never a fragment of the URL", async () => {
    const w = render(<Avatar name="V" avatar={{ kind: "luve", value: RECIPE }} attention="working" />);
    const src = img(w.container)!.getAttribute("src")!;
    expect(src).not.toContain("#");
    expect(await text(src)).toMatch(/^<svg [^>]*class="lb-face is-working lb-mascot lb-luve"/);
    const n = render(<Avatar name="V" avatar={{ kind: "luve", value: RECIPE }} attention="needs_you" size={96} />);
    expect(await text(img(n.container)!.getAttribute("src")!)).toMatch(/^<svg [^>]*class="needs-you lb-mascot lb-luve"/);
  });

  it("one URL per recipe, state and size, shared by every face; revoked only when the last face goes", () => {
    const a = render(<Avatar name="A" avatar={{ kind: "luve", value: RECIPE }} />);
    const b = render(<Avatar name="B" avatar={{ kind: "luve", value: RECIPE }} />);
    expect(created).toHaveBeenCalledTimes(1);
    expect(img(a.container)!.getAttribute("src")).toBe(img(b.container)!.getAttribute("src"));
    a.unmount();
    expect(revoked).not.toHaveBeenCalled();
    b.unmount();
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(liveLuveUrls()).toBe(0);
  });

  it("changing the recipe revokes the old URL", () => {
    const r = render(<Avatar name="A" avatar={{ kind: "luve", value: RECIPE }} />);
    const first = img(r.container)!.getAttribute("src");
    r.rerender(<Avatar name="A" avatar={{ kind: "luve", value: "tico.metal.sinos.000000" }} />);
    expect(revoked).toHaveBeenCalledWith(first);
    expect(img(r.container)!.getAttribute("src")).not.toBe(first);
    r.unmount();
    expect(liveLuveUrls()).toBe(0);
  });

  it("a value that is not a recipe never becomes a blob: it shows the default mascot from the plugin", () => {
    for (const value of ["nimbo.fosco.lupa.38BDF8", "https://x/y.svg", "nimbo.ouro.lupa.38bdf8", '"/><script>alert(1)</script>']) {
      const { container, unmount } = render(<Avatar name="Vendas" avatar={{ kind: "luve", value }} />);
      expect(img(container)!.getAttribute("src"), value).toMatch(/^\/dashboard-plugins\/luvebot\/icons\/mascots\/[a-z]+-mini\.svg$/);
      unmount();
    }
    expect(created).not.toHaveBeenCalled();
  });

  it("without createObjectURL (an old engine) the face stays empty instead of failing", () => {
    Object.assign(URL, { createObjectURL: undefined });
    const { container } = render(<Avatar name="V" avatar={{ kind: "luve", value: RECIPE }} />);
    expect(img(container)).toBeNull();
  });

  it("a Luve in a stack has no ring square, like a mascot", () => {
    const { container } = render(<AvatarStack faces={[{ key: "a", name: "A", avatar: { kind: "luve", value: RECIPE } }]} />);
    expect((container.querySelector("span > span") as HTMLElement).style.boxShadow).toBe("");
  });

  it("the team map draws a Bot's Luve as its face (working → is-working), and a broken recipe as initials", async () => {
    const map = (avatar: unknown): TeamMapResponse => ({
      nodes: [{ bot: "vendas", display: { label: "Vendas", role: "", color: "#3b82f6", avatar }, status: "working", rooms: [] } as never],
      edges: [], generated_at: "2026-10-03T12:00:00Z",
    });
    const ok = render(<TeamMapView initialMapData={map({ kind: "luve", value: RECIPE })} />);
    const href = ok.container.querySelector("svg image")!.getAttribute("href")!;
    expect(href).toMatch(/^blob:luvebot\//);
    expect(await text(href)).toMatch(/class="is-working lb-mascot lb-luve"/);
    ok.unmount();
    const bad = render(<TeamMapView initialMapData={map({ kind: "luve", value: "javascript:alert(1)" })} />);
    expect(bad.container.querySelector("svg image")).toBeNull();
  });
});
