// tests/unit/rooms/rooms-messenger.test.tsx
// Rooms as group chats (T7.1 F6): the room follows the selection (D10), refreshes on its own, every Bot signs its
// bubble, the members panel lists only members, and the kickoff uses the members' real handles.
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { RoomsView } from "@/components/rooms/RoomsView";
import { MessengerShell } from "@/components/messenger/MessengerShell";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Room, RoomEvent } from "@/api/types";

const room = (id: string, name: string, extra: Partial<Room> = {}): Room => ({
  id, name, created_at: "2026-10-01T00:00:00Z", driver: { running: false, pending_actions_count: 0 },
  members: [
    { member_id: "m1", bot: "vendas", handle: "vendas", display_name: "Vendas", color: "#60a5fa" },
    { member_id: "m2", bot: "dev", handle: "dev", display_name: "Dev", color: "#a78bfa" },
  ], ...extra,
});
const ROOMS: Record<string, Room> = { r1: room("r1", "Lançamento"), r2: room("r2", "Suporte VIP", { owner: "dev" }) };
const msg = (seq: number, actor: string, text: string): RoomEvent => ({ seq, event_id: `e${seq}`, kind: "message.member", actor: { kind: "member", id: actor }, payload: { text }, at: "2026-10-01T01:00:00Z" });

function backend(log: Record<string, () => RoomEvent[]>) {
  const urls: string[] = [];
  setCustomFetchJSON(async (url: string) => {
    urls.push(url);
    const m = url.match(/\/rooms\/(r\d)(\/log)?/);
    if (m && m[2]) return { events: (log[m[1]] ?? (() => []))() };
    if (m) return { room: ROOMS[m[1]] };
    if (url.includes("/handoffs")) return { handoffs: [{ id: "h1", from: "vendas", to: "dev", title: "Reproduzir bug", task_id: "t-9", state: "triage", room_id: "r1", created_at: "", updated_at: "" }] };
    return {};
  });
  return urls;
}

beforeEach(() => { cleanup(); resetCsrfToken(); setCustomFetchJSON(null); });

describe("RoomsView as a group chat", () => {
  it("guide photos 03/10: the header says the room is working only while a turn is live, and a handoff reads its state and title", async () => {
    let working = true;
    setCustomFetchJSON(async (url: string) => {
      if (url.match(/\/rooms\/r1\/log/)) return { events: [] };
      if (url.match(/\/rooms\/r1/)) return { room: room("r1", "Lançamento", { driver: { running: true, working, pending_actions_count: 0 } }) };
      if (url.includes("/handoffs")) return { handoffs: [{ id: "h1", from: "dev", to: "vendas", title: "Avisar o cliente X", task_id: "t-1", state: "completed", room_id: "r1", created_at: "", updated_at: "" }] };
      return {};
    });
    const { rerender } = render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    await screen.findByRole("heading", { name: "Lançamento" });
    expect(await screen.findByText("Em execução")).toBeTruthy();
    working = false;  // Hermes keeps `running` true while the room exists; only `working` ends with the turns
    rerender(<RoomsView roomId="r2" availableBots={[]} pollMs={0} />);
    rerender(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    await waitFor(() => expect(screen.queryByText("Em execução")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Membros" }));
    const panel = within(screen.getByRole("complementary", { name: "Membros" }));
    expect(panel.getByText("@dev → @vendas · concluído")).toBeTruthy();
    expect(panel.getByText("Avisar o cliente X")).toBeTruthy();
    expect(panel.queryByText(/completed/)).toBeNull();
  });

  it("D10: picking another room switches the open room", async () => {
    const urls = backend({});
    const { rerender } = render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    await screen.findByRole("heading", { name: "Lançamento" });
    rerender(<RoomsView roomId="r2" availableBots={[]} pollMs={0} />);
    await screen.findByRole("heading", { name: "Suporte VIP" });
    expect(screen.queryByRole("heading", { name: "Lançamento" })).toBeNull();
    expect(urls).toContain("/api/plugins/luvebot/rooms/r2");
  });

  it("new Bot messages arrive without a click", async () => {
    let events: RoomEvent[] = [];
    backend({ r1: () => events });
    render(<RoomsView roomId="r1" availableBots={[]} pollMs={20} />);
    await screen.findByRole("heading", { name: "Lançamento" });
    events = [msg(1, "dev", "Bug reproduzido no staging.")];
    expect(await screen.findByText("Bug reproduzido no staging.")).toBeTruthy();
  });

  it("Hermes's control events (turn.*, room.*, signed by the gateway's install id) never become a member's bubble", async () => {
    const control = (seq: number, kind: RoomEvent["kind"], text = ""): RoomEvent =>
      ({ seq, event_id: `c${seq}`, kind, actor: { kind: "system", id: "install:50be1ef2e3d24794ae28ec7b0c069c63" }, payload: { text }, at: "2026-10-01T01:00:00Z" });
    backend({ r1: () => [msg(1, "vendas", "Lead quente."), control(2, "turn.started"), control(3, "turn.settled"), control(4, "room.activity", "x"),
      msg(5, "dev", "Corrigido."), { ...msg(6, "dev", ""), event_id: "e-empty" }] });
    render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    await screen.findByText("Corrigido.");
    expect(screen.queryByText(/install:/)).toBeNull();
    expect(screen.queryByText("IN")).toBeNull();
    expect(screen.queryByText("x")).toBeNull();
    expect(screen.getByText("Lead quente.")).toBeTruthy();
    expect(screen.getAllByText("Dev")).toHaveLength(1);  // the empty message from dev is not a second, blank bubble signed by it
  });

  it("each Bot signs its own bubble", async () => {
    backend({ r1: () => [msg(1, "vendas", "Lead quente."), msg(2, "dev", "Corrigido.")] });
    render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    await screen.findByText("Lead quente.");
    expect(screen.getAllByText("Vendas").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Dev").style.color).toBe("rgb(167, 139, 250)");
  });

  it("the members panel lists only members, open tasks and the team map; a member click writes its @", async () => {
    backend({});
    const onOpenTeamMap = vi.fn();
    const pesquisa = { name: "pesquisa", is_default: false, description: "", status: "idle", model: { provider: "p", name: "m" }, display: { label: "Pesquisa", role: "x", color: "#34d399", avatar: { kind: "emoji", value: "🐝" } } } as const;
    render(<RoomsView roomId="r1" availableBots={[pesquisa as any]} pollMs={0} onOpenTeamMap={onOpenTeamMap} />);
    await screen.findByRole("heading", { name: "Lançamento" });
    expect(screen.queryByRole("complementary")).toBeNull(); // closed by default: no form or list next to the composer
    fireEvent.click(screen.getByRole("button", { name: "Membros" }));
    const panel = within(screen.getByRole("complementary", { name: "Membros" }));
    expect(panel.getByText("@vendas")).toBeTruthy();
    expect(panel.getByText("@dev")).toBeTruthy();
    expect(panel.getByText("Reproduzir bug")).toBeTruthy();
    expect(panel.queryByText(/pesquisa/i)).toBeNull(); // a Bot outside the room is never listed
    fireEvent.click(panel.getByRole("button", { name: "Mapa do time" }));
    expect(onOpenTeamMap).toHaveBeenCalledTimes(1);
    fireEvent.click(panel.getByRole("button", { name: /@dev/ }));
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("@dev ");
  });

  it("handoff states are spoken words from the dictionary, never the backend code", async () => {
    backend({ r1: () => [{ seq: 1, event_id: "h", kind: "handoff.card", actor: { kind: "system", id: "system" }, payload: { handoff_id: "h1", from: "vendas", to: "dev", title: "Reproduzir bug", task_id: "t-9", status: "ready" }, at: "" }] });
    render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    expect(await screen.findByText("pronto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Membros" }));
    expect(screen.getByText(/em triagem/)).toBeTruthy(); // the open task in the panel is in triage
    expect(screen.queryByText(/\b(ready|triage)\b/)).toBeNull();
  });

  it("the empty room suggests a kickoff with the members' real handles", async () => {
    backend({});
    render(<RoomsView roomId="r1" availableBots={[]} pollMs={0} />);
    const kickoff = await screen.findByRole("button", { name: /@vendas junte as fontes\. @dev transforme em rascunho/ });
    fireEvent.click(kickoff);
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toContain("@vendas");
  });

  it("on a phone the open room has ONE strip on top: back and 'Painel do Hermes' move into its header (T11.0)", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    try {
      backend({});
      const { container } = render(<MessengerShell selectedRoomId="r1"><RoomsView roomId="r1" availableBots={[]} pollMs={0} /></MessengerShell>);
      await screen.findByRole("heading", { name: "Lançamento" });
      const header = container.querySelector("main section header") as HTMLElement;
      expect(within(header).getByRole("button", { name: "Voltar para as conversas" })).toBeDefined();
      expect(within(header).getByRole("link", { name: "Painel do Hermes" })).toBeDefined();
      expect(screen.getAllByRole("button", { name: "Voltar para as conversas" })).toHaveLength(1);
      expect(screen.getAllByRole("link", { name: "Painel do Hermes" })).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
