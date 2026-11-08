// tests/unit/ui/modal-surface.test.tsx
// t162: the modals over the screen in the Approvals inbox and in Activity had a see-through panel (--lb-fill is the text color at
// 6%): in the light theme the page showed through "Negar ação" and its explanation could not be read. Every such panel now has
// the opaque card surface, like every other dialog (.lb-dialog: var(--color-card)).
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { ApprovalsInbox } from "@/components/approvals";
import { ActivityView } from "@/components/activity/ActivityView";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import type { Approval, ActivityItem, Bot } from "@/api/types";

const bots = [{ name: "vendas", is_default: false, status: "idle", description: "", model: { provider: "p", name: "m" },
  display: { label: "Vendas", role: "B2B", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } } }] as unknown as Bot[];
const approval = (id: string): Approval => ({
  request_id: id, bot: "vendas", surface: "gateway", mechanism: "command", source: "transport", digest: `d-${id}`,
  command_redacted: "chmod 600 /tmp/x", description: "Proteger o arquivo", pattern_keys: ["chmod"], allowed_choices: ["once", "deny"],
  action_class_hash: "same", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), status: "pending",
} as Approval);
const items: ActivityItem[] = [
  { id: "task-1", kind: "task", bot: "vendas", title: "Avisar o cliente", origin: "handoff", status: "running", links: { task_id: "task-1" } } as ActivityItem,
];

/** The visible box of an open modal: the element that draws its surface (the one with the shadow). */
function surfaceOf(dialog: HTMLElement): string {
  const panel = [dialog, ...Array.from(dialog.querySelectorAll<HTMLElement>("*"))].find((el) => el.className.includes("shadow-xl"));
  return panel?.className ?? "";
}
const opaque = (dialog: HTMLElement) => {
  const cls = surfaceOf(dialog);
  expect(cls).toContain("bg-[var(--color-card)]");
  expect(cls).not.toContain("bg-[var(--lb-fill)]");
};

beforeEach(() => { cleanup(); resetCsrfToken(); });
afterEach(() => setCustomFetchJSON(null));

describe("modals over the screen have an opaque surface", () => {
  it("in the Approvals inbox: Negar, Ver parâmetros, Sempre permitir and the batch confirmation", async () => {
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "x", auth_mode: "gated" }
      : url.includes("/approvals") ? { approvals: [approval("a1"), approval("a2")] } : {}));
    render(<ApprovalsInbox bots={bots} authMode="gated" />);
    const card = await screen.findByTestId("approval-card-a1");
    fireEvent.click(within(card).getByRole("button", { name: "Negar…" }));
    opaque(screen.getByRole("dialog"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancelar/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Ver parâmetros" }));
    opaque(screen.getByRole("dialog"));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const always = within(card).queryByRole("button", { name: "Sempre permitir…" });
    if (always) { fireEvent.click(always); opaque(screen.getByRole("dialog")); fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancelar/ })); }
    for (const id of ["a1", "a2"]) fireEvent.click(within(screen.getByTestId(`approval-card-${id}`)).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /negar selecionados/i }));
    opaque(screen.getByRole("dialog"));
  });

  it("in Activity: add context, redirect and stop", () => {
    render(<ActivityView bots={bots} initialItems={items} />);
    for (const id of ["btn-context-task-1", "btn-redirect-task-1", "btn-stop-task-1"]) {
      fireEvent.click(screen.getByTestId(id));
      opaque(screen.getByRole("dialog"));
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      cleanup();
      render(<ActivityView bots={bots} initialItems={items} />);
    }
  });
});
