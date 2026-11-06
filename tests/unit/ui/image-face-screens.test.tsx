// tests/unit/ui/image-face-screens.test.tsx
// An image as a face in the two screens that offer it (contract v0.11 §2.3, slice AV-5): the Bot's Profile and "Meu Luve". Choosing and cropping is image-studio.test.tsx; here: what the
// screens DO with the id. The Profile sends the face in its PATCH only when the person changed it (re-sending it would ask the backend to re-check an image the writer may not own),
// "Remover imagem" goes back to the face before, and an image that left a face is OFFERED for deletion, never deleted on its own.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BotProfile } from "@/components/bots/BotProfile";
import { MyLuve } from "@/components/settings/MyLuve";
import { MyFaceProvider } from "@/hooks/useMyFace";
import { displayFace, withDefaultFace, defaultMascot } from "@/components/ui/mascots";
import { forgetAvatarProbe } from "@/components/ui/avatarImage";
import { ApiError, resetCsrfToken, setCachedCsrf, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { BotAvatar, BotDetail } from "@/api/types";

if (!Blob.prototype.arrayBuffer) Blob.prototype.arrayBuffer = function (this: Blob) { return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result as ArrayBuffer); r.onerror = no; r.readAsArrayBuffer(this); }); };

const ID = "img_" + "0123456789abcdef".repeat(2), OTHER = "img_" + "fedcba9876543210".repeat(2);
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (w = 256, h = 256, extra = 64) => { const b = new Uint8Array(33 + extra); b.set(SIG, 0); b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
const pngFile = () => new File([png(800, 600)], "foto.png", { type: "image/png" });

type Call = { method: string; url: string; body?: any; csrf: string | null };
let calls: Call[], probe: "ok" | "missing", deleteFails: ApiError | null, myFace: BotAvatar | null;
const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
const bot = (avatar: BotAvatar): BotDetail => ({ name: "vendas", is_default: false, display: { label: "Vendas", role: "", color: "#60a5fa", avatar }, description: "", model: { provider: "openrouter", name: "claude-sonnet-5-5" }, status: "idle", soul: "", toolsets: [], mcp_servers: [] } as never);
const ctx = { imageSmoothingEnabled: false, imageSmoothingQuality: "low", clearRect: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: "" };

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); setCachedCsrf("csrf-s"); forgetAvatarProbe();
  calls = []; probe = "ok"; deleteFails = null; myFace = { kind: "mascot", value: "zuca" };
  Object.assign(URL, { createObjectURL: () => "blob:luvebot/x", revokeObjectURL: () => {} });
  (window as any).__HERMES_PLUGIN_SDK__ = {
    authedFetch: vi.fn(async (url: string) => {
      if (url.includes(`/avatars/${ID}`) || url.includes(`/avatars/${OTHER}`)) return new Response(png(), { status: 200, headers: { "Content-Type": "image/png" } });
      return probe === "missing" ? new Response('{"detail":"Not Found"}', { status: 404 }) : new Response('{"error":{"code":"avatar_not_found","message":"x"}}', { status: 404 });
    }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ctx) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(((cb: BlobCallback) => cb(new Blob([new Uint8Array(5000)], { type: "image/png" }))) as never);
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() })));
  setCustomFetchJSON(async (url, init) => {
    const method = init?.method ?? "GET";
    if (url.endsWith("/session")) return { csrf: "csrf-s", actor: "dashboard", auth_mode: "gated" };
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ method, url, body, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") });
    if (url.endsWith("/avatars") && method === "POST") return { id: ID, width: 256, height: 256, bytes: 5000 };
    if (url.includes("/avatars/") && method === "DELETE") { if (deleteFails) throw deleteFails; return { deleted: true }; }
    if (url.includes("/bots/vendas/display") && method === "PATCH") return bot(body.avatar ?? { kind: "emoji", value: "💼" });
    if (url.endsWith("/me/display") && method === "PATCH") { myFace = body.avatar; return { avatar: myFace }; }
    if (url.endsWith("/me/display")) return { avatar: myFace };
    return {};
  });
});
afterEach(() => { cleanup(); setCustomFetchJSON(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); delete (window as any).__HERMES_PLUGIN_SDK__; Object.assign(URL, { createObjectURL: saved.create, revokeObjectURL: saved.revoke }); });

const patches = () => calls.filter((c) => c.method === "PATCH" && c.url.includes("/bots/vendas/display"));
const sendImage = async () => {
  fireEvent.click(await screen.findByTestId("btn-avatar-send"));
  await act(async () => { fireEvent.change(screen.getByTestId("avatar-file"), { target: { files: [pngFile()] } }); await new Promise((r) => setTimeout(r, 15)); });
  await screen.findByTestId("avatar-canvas");
  fireEvent.click(screen.getByTestId("avatar-use"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
};
const save = () => fireEvent.click(screen.getByText("Salvar alterações"));

describe("the Bot's Profile", () => {
  it("does not offer the image where the backend has no avatar routes", async () => {
    probe = "missing";
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "emoji", value: "💼" })} />);
    await screen.findByRole("button", { name: "Criar seu Luve" });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByTestId("btn-avatar-send")).toBeNull();
  });

  it("saving a NAME does not send the face at all (the backend never re-checks a face the person did not touch)", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "emoji", value: "💼" })} />);
    fireEvent.change(screen.getByDisplayValue("Vendas"), { target: { value: "Vendas Sul" } });
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body).toEqual({ label: "Vendas Sul", role: "", call_me: null, color: "#60a5fa" });
    expect("avatar" in patches()[0].body).toBe(false);
  });

  it("a Bot wearing an image (maybe someone else's) can still have its name saved: no avatar in the PATCH", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "image", value: OTHER })} />);
    fireEvent.change(screen.getByDisplayValue("Vendas"), { target: { value: "Vendas Norte" } });
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect("avatar" in patches()[0].body).toBe(false);
    expect(screen.queryByTestId("image-leftover")).toBeNull();   // the face did not change: nothing is offered for deletion
  });

  it("changing the face still sends it (a mascot pick)", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "emoji", value: "💼" })} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Rosto do Bot (mascote)" })).getAllByRole("button")[0]);
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.avatar.kind).toBe("mascot");
  });

  it("send an image -> it fills the form, nothing is saved yet -> Salvar sends {kind:image, value:<the id>}", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "emoji", value: "💼" })} />);
    await sendImage();
    expect(calls.filter((c) => c.url.endsWith("/avatars"))).toHaveLength(1);
    expect(patches()).toHaveLength(0);
    expect(screen.getByText("Este rosto é uma imagem que você enviou.")).toBeDefined();
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.avatar).toEqual({ kind: "image", value: ID });
    expect(patches()[0].csrf).toBe("csrf-s");
  });

  it("'Remover imagem' goes back to the face before it (not saved until Salvar), and an image that was only picked is not offered for deletion", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "emoji", value: "💼" })} />);
    await sendImage();
    fireEvent.click(screen.getByTestId("btn-avatar-remove"));
    expect(screen.queryByText("Este rosto é uma imagem que você enviou.")).toBeNull();
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect("avatar" in patches()[0].body).toBe(false);   // back to the saved face: nothing changed, so nothing is sent
    expect(screen.queryByTestId("image-leftover")).toBeNull();
  });

  it("'Remover imagem' returns to the face the FORM had before the image (an unsaved mascot pick), not to the saved one", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "emoji", value: "💼" })} />);
    fireEvent.click(within(screen.getByRole("group", { name: "Rosto do Bot (mascote)" })).getAllByRole("button")[0]);
    await sendImage();
    fireEvent.click(screen.getByTestId("btn-avatar-remove"));
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.avatar.kind).toBe("mascot");
  });

  it("a Bot that wore an image: 'Remover' + Salvar changes the face, then OFFERS to delete the image; 'Apagar' sends DELETE with CSRF and says so", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "image", value: ID })} />);
    fireEvent.click(await screen.findByTestId("btn-avatar-remove"));
    expect(screen.getByText("A imagem sai deste rosto quando você salvar.")).toBeDefined();
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.avatar).toEqual({ kind: "mascot", value: defaultMascot("vendas") });
    expect(await screen.findByTestId("image-leftover")).toBeDefined();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);   // offered, never done on its own
    fireEvent.click(screen.getByTestId("btn-image-delete"));
    expect((await screen.findByTestId("image-leftover-deleted")).textContent).toBe("Imagem apagada do servidor.");
    const del = calls.filter((c) => c.method === "DELETE");
    expect(del).toHaveLength(1);
    expect(del[0].url).toContain(`/avatars/${ID}`);
    expect(del[0].csrf).toBe("csrf-s");
  });

  it("'Manter no servidor' hides the offer and deletes nothing", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "image", value: ID })} />);
    fireEvent.click(await screen.findByTestId("btn-avatar-remove"));
    save();
    fireEvent.click(await screen.findByTestId("btn-image-keep"));
    expect(screen.queryByTestId("image-leftover")).toBeNull();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("an image still worn elsewhere (409 avatar_in_use) says who to change first, and the offer stays; any other failure says only whoever sent it can delete it", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "image", value: ID })} />);
    fireEvent.click(await screen.findByTestId("btn-avatar-remove"));
    save();
    await screen.findByTestId("image-leftover");
    deleteFails = new ApiError({ code: "avatar_in_use", message: "x", status: 409 } as never);
    fireEvent.click(screen.getByTestId("btn-image-delete"));
    expect((await screen.findByTestId("image-leftover-error")).textContent).toContain("Ainda há um Bot ou uma pessoa usando esta imagem");
    expect(screen.getByTestId("btn-image-delete")).toBeDefined();
    deleteFails = new ApiError({ code: "avatar_not_found", message: "x", status: 404 } as never);
    fireEvent.click(screen.getByTestId("btn-image-delete"));
    await waitFor(() => expect(screen.getByTestId("image-leftover-error").textContent).toContain("Só quem a enviou pode apagá-la"));
    expect(screen.queryByTestId("image-leftover-deleted")).toBeNull();   // a 404 may be "not yours": never claim it was deleted
  });

  it("replacing one image with another also frees the first for deletion", async () => {
    render(<BotProfile botName="vendas" initialBot={bot({ kind: "image", value: OTHER })} />);
    await sendImage();
    save();
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].body.avatar).toEqual({ kind: "image", value: ID });
    expect(await screen.findByTestId("image-leftover")).toBeDefined();
  });
});

describe("Meu Luve", () => {
  const settings = () => render(<MyFaceProvider><MyLuve /></MyFaceProvider>);
  const mine = () => calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/me/display"));

  it("not offered without the routes", async () => {
    probe = "missing";
    settings();
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    expect(screen.queryByTestId("btn-avatar-send")).toBeNull();
  });

  it("send an image: it saves at once (PATCH /me/display with CSRF) and the face is drawn from it", async () => {
    settings();
    await sendImage();
    await waitFor(() => expect(mine()).toHaveLength(1));
    expect(mine()[0].body).toEqual({ avatar: { kind: "image", value: ID } });
    expect(mine()[0].csrf).toBe("csrf-s");
    expect(await screen.findByText("Rosto salvo.")).toBeDefined();
    await waitFor(() => expect(document.querySelector("span[aria-hidden] img")?.getAttribute("src")).toMatch(/^blob:/));
  });

  it("'Remover imagem' goes back to the face before the image, saves it, and offers to delete the image", async () => {
    settings();
    await screen.findByTestId("btn-avatar-send");
    await waitFor(() => expect(screen.getByText("Seu rosto nas suas mensagens, nas conversas e nas salas. Fica na sua conta: quem entra com outro login vê o próprio.")).toBeDefined());
    await sendImage();
    await waitFor(() => expect(mine()).toHaveLength(1));
    fireEvent.click(await screen.findByTestId("btn-avatar-remove"));
    await waitFor(() => expect(mine()).toHaveLength(2));
    expect(mine()[1].body).toEqual({ avatar: { kind: "mascot", value: "zuca" } });
    expect(await screen.findByTestId("image-leftover")).toBeDefined();
    fireEvent.click(screen.getByTestId("btn-image-delete"));
    expect(await screen.findByTestId("image-leftover-deleted")).toBeDefined();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("an image face is a face that was chosen", () => {
  it("displayFace keeps an image with a value (it never turns into the default mascot), and withDefaultFace leaves the Bot alone", () => {
    const face: BotAvatar = { kind: "image", value: ID };
    expect(displayFace("vendas", face)).toBe(face);
    const b = { name: "vendas", display: { avatar: face } };
    expect(withDefaultFace(b)).toBe(b);
  });
});
