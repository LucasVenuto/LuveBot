// tests/unit/ui/primitives.test.tsx
// The F1 building blocks of the messenger shell (T7.1): attention state, accent color, avatar, bubble, side panel.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { attention } from "@/components/messenger/attention";
import type { Bot } from "@/api/types";
import { AttentionBadge } from "@/components/ui/AttentionBadge";
import { botColor, readableOn, contrast, FALLBACK_COLOR } from "@/components/ui/color";
import { Avatar } from "@/components/ui/Avatar";
import { Bubble } from "@/components/ui/Bubble";
import { SidePanel } from "@/components/ui/SidePanel";
import { Markdown } from "@/lib/render/markdown";
import { BOT_COLORS } from "@/api/templates";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("messenger/attention", () => {
  it("puts what needs a human first, then breakage, then live work, then news", () => {
    expect(attention({ status: "waiting_approval", unread: true })).toBe("needs_you");
    expect(attention({ status: "idle" }, 1)).toBe("needs_you"); // a pending approval while status lags behind
    expect(attention({ status: "error", unread: true })).toBe("error");
    expect(attention({ status: "offline", unread: true })).toBe("offline");
    expect(attention({ status: "paused", unread: true })).toBe("paused");
    expect(attention({ status: "working", unread: true })).toBe("working");
    expect(attention({ status: "idle", unread: true })).toBe("unread");
    expect(attention({ status: "idle" })).toBe("idle");
  });

  // Pairwise: every state against every state of lower priority, wherever both can be true at once.
  // Two statuses can never coexist (status is one value), so the pairs that exist are: a pending approval
  // with every status and with unread, and every status with unread.
  const ORDER = ["needs_you", "error", "offline", "paused", "working", "unread", "idle"] as const;
  const STATUS_OF: Record<string, Bot["status"]> = { needs_you: "waiting_approval", error: "error", offline: "offline", paused: "paused", working: "working", unread: "idle", idle: "idle" };
  for (const status of ["idle", "working", "paused", "offline", "error", "waiting_approval"] as const) {
    for (const unread of [false, true]) {
      it(`pending approval wins over status=${status}${unread ? " + unread" : ""}`, () => {
        expect(attention({ status, unread }, 1)).toBe("needs_you");
      });
    }
  }
  for (const [i, higher] of ORDER.entries()) {
    for (const lower of ORDER.slice(i + 1)) {
      if (lower !== "unread" || higher === "idle") continue; // only unread can sit on top of another status
      it(`${higher} wins over ${lower}`, () => {
        expect(attention({ status: STATUS_OF[higher], unread: true })).toBe(higher);
      });
    }
  }

  it("unread works with v0 (boolean) and v0.4 ({count}); an empty count is not unread", () => {
    expect(attention({ status: "idle", unread: { count: 0, replies: 0, routine_results: 0, since: null } })).toBe("idle");
    expect(attention({ status: "idle", unread: { count: 2 } })).toBe("unread");
    expect(attention({ status: "idle", unread: "yes" })).toBe("idle");
  });

  it("each state has its spoken label; idle draws nothing", () => {
    const { container, rerender } = render(<AttentionBadge state="idle" />);
    expect(container.innerHTML).toBe("");
    for (const [state, label] of [["needs_you", "Precisa de você"], ["unread", "Não lido"], ["working", "Trabalhando"], ["paused", "Pausado"], ["error", "Erro"], ["offline", "Desconectado"]] as const) {
      rerender(<AttentionBadge state={state} />);
      expect(screen.getByRole("img", { name: label })).toBeTruthy();
    }
  });
});

describe("ui/color", () => {
  it("only a plain hex reaches a style; anything else falls back to the theme token", () => {
    expect(botColor("#60a5fa")).toBe("#60a5fa");
    expect(botColor("red; background:url(https://x)")).toBe(FALLBACK_COLOR);
    expect(botColor(undefined)).toBe(FALLBACK_COLOR);
  });

  it("text on every Bot color reads at WCAG AA", () => {
    for (const { hex } of BOT_COLORS) expect(contrast(hex, readableOn(hex))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("ui/Avatar", () => {
  it("never loads an image from a URL (A-54): image shows initials, a mascot shows the shipped face; always hidden from screen readers", () => {
    const { container, rerender } = render(<Avatar name="Vendas" avatar={{ kind: "image", value: "https://cdn.example.com/a.png" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("VE");
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    rerender(<Avatar name="Vendas" avatar={{ kind: "image", value: "javascript:alert(1)" }} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<Avatar name="Vendas" avatar={{ kind: "mascot", value: "zuca" }} attention="needs_you" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/dashboard-plugins/luvebot/icons/mascots/zuca-mini.svg#lb-needs-you");
    rerender(<Avatar name="Vendas" avatar={{ kind: "mascot", value: "../zuca" }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("VE");
    rerender(<Avatar name="Vendas" avatar={{ kind: "emoji", value: "🦊" }} />);
    expect(container.textContent).toBe("🦊");
  });
});

describe("ui/Bubble", () => {
  it("is only a frame: agent HTML inside stays text", () => {
    const { container } = render(<Bubble side="bot"><Markdown text={'<script>alert(1)</script><img src=x onerror=alert(1)>'} /></Bubble>);
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("your bubble takes the Bot's accent with readable text", () => {
    render(<Bubble side="me" color="#fbbf24" meta="10:02">oi</Bubble>);
    const bubble = screen.getByText("oi") as HTMLElement;
    expect(bubble.style.background).toBe("rgb(251, 191, 36)");
    expect(bubble.style.color).toBe("rgb(11, 15, 25)");
    expect(screen.getByText("10:02")).toBeTruthy();
  });
});

describe("ui/SidePanel", () => {
  it("desktop: a labelled column, closed by its button or Esc; nothing mounts while closed", () => {
    const onClose = vi.fn();
    const { rerender, container } = render(<SidePanel open={false} onClose={onClose} label="Perfil de Vendas"><form /></SidePanel>);
    expect(container.querySelector("form")).toBeNull();
    rerender(<SidePanel open onClose={onClose} label="Perfil de Vendas"><button>dentro</button></SidePanel>);
    const panel = screen.getByRole("complementary", { name: "Perfil de Vendas" });
    expect(panel.getAttribute("aria-modal")).toBeNull();
    fireEvent.keyDown(screen.getByText("dentro"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Fechar painel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("phone: a modal bottom sheet that takes focus and closes on Esc", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    const onClose = vi.fn();
    render(<SidePanel open onClose={onClose} label="Perfil de Vendas"><button>dentro</button></SidePanel>);
    const sheet = screen.getByRole("dialog", { name: "Perfil de Vendas" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
