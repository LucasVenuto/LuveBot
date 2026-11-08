// tests/unit/evidence/evidence-card.test.tsx
// The evidence card (contract v0.10 §3.2, slice E-2): five blocks in the spec's order under "Escrito pelo Bot. O LuveBot não conferiu.", neutral
// bullets, plain text only, a source as text with a copy button (never a link), "absent" (the Bot did not say) apart from "none" (it said
// `- none`), and the one block that must not lie: "awaiting approval" shows the REAL count of pending approvals the screen holds, labels the
// Bot's items "the Bot says", and says so when the two disagree. Nothing on the card decides anything. (lib/evidence.ts, the parser, is E-1.)
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EvidenceCard } from "@/components/evidence/EvidenceCard";
import { SECTIONS, splitEvidence, type Evidence } from "@/lib/evidence";
import { setLuveLocale } from "@/i18n";

const ev = (over: Partial<Evidence> = {}): Evidence => ({
  facts: [{ text: "Vendas fechou 12 propostas em setembro", source: "crm/setembro.csv" }],
  assumptions: [{ text: "O CSV está completo" }],
  done: [{ text: "Gerei o resumo em pages/vendas.md" }],
  awaiting: [{ text: "Enviar o resumo ao cliente X" }],
  questions: [{ text: "O prazo de 15/11 vale para todos?" }],
  ...over,
});
const card = (props: Partial<React.ComponentProps<typeof EvidenceCard>> = {}) => {
  const view = render(<EvidenceCard evidence={ev()} pending={null} {...props} />);
  return { ...view, root: screen.getByTestId("evidence-card") };
};
const clipboard = { writeText: vi.fn(async () => {}) };
beforeEach(() => { cleanup(); setLuveLocale("pt"); clipboard.writeText.mockClear(); Object.assign(navigator, { clipboard }); });
afterEach(() => cleanup());

describe("o cartão", () => {
  it("says at the top that the Bot wrote it and LuveBot did not check it", () => {
    const { root } = card();
    expect(screen.getByTestId("evidence-top").textContent).toBe("Escrito pelo Bot. O LuveBot não conferiu.");
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Evidência escrita pelo Bot");
  });

  it("draws the five blocks in the spec's order, each with its own heading and its items", () => {
    card();
    const blocks = Array.from(screen.getByTestId("evidence-card").querySelectorAll("section")).map((s) => s.getAttribute("data-testid"));
    expect(blocks).toEqual(["evidence-facts", "evidence-assumptions", "evidence-done", "evidence-awaiting", "evidence-questions"]);
    expect(Array.from(screen.getByTestId("evidence-card").querySelectorAll("h4")).map((h) => h.textContent)).toEqual(["Fatos", "Premissas", "Feito", "Aguardando aprovação", "Perguntas em aberto"]);
    expect(within(screen.getByTestId("evidence-done")).getByTestId("evidence-item").textContent).toBe("Gerei o resumo em pages/vendas.md");
    expect(within(screen.getByTestId("evidence-questions")).getByTestId("evidence-item").textContent).toBe("O prazo de 15/11 vale para todos?");
  });

  it("holds the same order as the parser's SECTIONS", () => {
    card();
    expect(Array.from(screen.getByTestId("evidence-card").querySelectorAll("section")).map((s) => s.getAttribute("data-testid")!.replace("evidence-", ""))).toEqual([...SECTIONS]);
  });

  it("bullets are neutral: no check mark, no cross, no status glyph anywhere on the card ('done' is what the Bot claims)", () => {
    const { root } = card({ pending: 1 });
    expect(root.textContent).not.toMatch(/[✓✔✅☑✕✗❌⚠]/u);
    expect(root.querySelectorAll("svg, img")).toHaveLength(0);
  });

  it("a header the Bot did not write is 'the Bot did not say', which is not the same as '- none'", () => {
    card({ evidence: ev({ assumptions: null, questions: [] }) });
    expect(screen.getByTestId("evidence-assumptions-absent").textContent).toBe("O Bot não disse.");
    expect(screen.getByTestId("evidence-questions-none").textContent).toBe("O Bot disse: nada.");
    expect(screen.queryByTestId("evidence-assumptions-none")).toBeNull();
    expect(screen.queryByTestId("evidence-questions-absent")).toBeNull();
    expect(within(screen.getByTestId("evidence-assumptions")).queryAllByTestId("evidence-item")).toHaveLength(0);
  });

  it("speaks English too", () => {
    setLuveLocale("en");
    card({ pending: 2, evidence: ev({ assumptions: null, questions: [] }) });
    expect(screen.getByTestId("evidence-top").textContent).toBe("Written by the Bot. LuveBot did not check it.");
    expect(Array.from(screen.getByTestId("evidence-card").querySelectorAll("h4")).map((h) => h.textContent)).toEqual(["Facts", "Assumptions", "Done", "Awaiting approval", "Open questions"]);
    expect(screen.getByTestId("evidence-assumptions-absent").textContent).toBe("The Bot did not say.");
    expect(screen.getByTestId("evidence-questions-none").textContent).toBe("The Bot said: nothing.");
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pending requests from this conversation: 2");
    cleanup();
    card({ pending: 1, evidence: ev({ awaiting: [] }) });
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("Approvals has 1 request from this conversation that the Bot did not list.");
    cleanup();
    card({ pending: 0 });
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("No pending request from this conversation in Approvals.");
  });
});

describe("texto puro, fonte sem link", () => {
  it("HTML, Markdown and a link in an item are characters, never elements", () => {
    const { root } = card({ evidence: ev({
      facts: [{ text: "<img src=x onerror=alert(1)> [clique](https://evil.example) **negrito** <a href=\"https://evil.example\">Aprovar</a>", source: "https://evil.example/x" }],
      awaiting: [{ text: "<script>alert(1)</script>" }],
    }) });
    expect(root.querySelectorAll("a, img, script, strong, em, [onerror]")).toHaveLength(0);
    expect(within(screen.getByTestId("evidence-facts")).getByTestId("evidence-item").textContent).toContain("**negrito**");
    expect(within(screen.getByTestId("evidence-awaiting")).getByTestId("evidence-item").textContent).toBe("<script>alert(1)</script>");
  });

  it("a source is text with a copy button: it shows as written, copies exactly that, and is never a link even when it is a URL", async () => {
    const { root } = card({ evidence: ev({ facts: [{ text: "x", source: "https://exemplo.com/relatorio?id=1" }] }) });
    expect(screen.getByTestId("evidence-source").textContent).toBe("Fonte: https://exemplo.com/relatorio?id=1");
    expect(root.querySelectorAll("a")).toHaveLength(0);
    const copy = screen.getByRole("button", { name: "Copiar a fonte: https://exemplo.com/relatorio?id=1" });
    await act(async () => { fireEvent.click(copy); });
    expect(clipboard.writeText).toHaveBeenCalledWith("https://exemplo.com/relatorio?id=1");
    expect(await screen.findByText("copiado")).toBeDefined();
  });

  it("an item without a source has no source line and no copy button", () => {
    card({ evidence: ev({ facts: [{ text: "sem fonte" }] }) });
    expect(screen.queryByTestId("evidence-source")).toBeNull();
    expect(screen.queryByRole("button", { name: /Copiar a fonte/ })).toBeNull();
  });

  it("a clipboard that refuses says nothing false (no 'copiado')", async () => {
    clipboard.writeText.mockRejectedValueOnce(new Error("denied"));
    card();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Copiar a fonte/ })); });
    expect(clipboard.writeText).toHaveBeenCalled();
    expect(screen.queryByText("copiado")).toBeNull();
  });
});

describe("aguardando aprovação: o único bloco que não pode mentir", () => {
  it("shows the real count of pending approvals and a way to open Approvals", () => {
    const open = vi.fn();
    card({ pending: 2, onOpenApprovals: open });
    expect(screen.queryByTestId("evidence-count-unknown")).toBeNull();
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 2");
    fireEvent.click(screen.getByTestId("evidence-open-approvals"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("the Bot's own items are labeled 'the Bot says' (a block with no items has no such label)", () => {
    card({ pending: 1 });
    expect(within(screen.getByTestId("evidence-awaiting")).getByText("O Bot diz:")).toBeDefined();
    cleanup();
    card({ pending: 0, evidence: ev({ awaiting: [] }) });
    expect(within(screen.getByTestId("evidence-awaiting")).queryByText("O Bot diz:")).toBeNull();
  });

  it("without a way to open it, the count shows and there is no link", () => {
    card({ pending: 3 });
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 3");
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
  });

  it("when this screen does not know (pending null) there is NO count, NO comparison and NO link, never a made-up zero", () => {
    card({ pending: null, onOpenApprovals: vi.fn() });
    expect(screen.queryByTestId("evidence-in-box")).toBeNull();
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
    expect(screen.queryByTestId("evidence-open-approvals")).toBeNull();
    expect(screen.getByTestId("evidence-count-unknown").textContent).toBe("Aqui o LuveBot não conta os pedidos pendentes.");   // said once, calmly: never mistaken for "nothing pending"
    expect(screen.getByTestId("evidence-card").textContent).not.toMatch(/Pedidos pendentes desta conversa/);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY])("a count that is not a real one (%s) is 'unknown'", (bad) => {
    card({ pending: bad });
    expect(screen.queryByTestId("evidence-in-box")).toBeNull();
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
  });

  it("the Bot lists something and the box is empty: a calm line says so", () => {
    card({ pending: 0 });
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 0");
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("Nenhum pedido pendente desta conversa em Aprovações.");
  });

  it("the box has requests the Bot did not list (absent or '- none'): a calm line with the count, singular and plural", () => {
    card({ pending: 1, evidence: ev({ awaiting: null }) });
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("Aprovações tem 1 pedido desta conversa que o Bot não listou.");
    cleanup();
    card({ pending: 3, evidence: ev({ awaiting: [] }) });
    expect(screen.getByTestId("evidence-mismatch").textContent).toBe("Aprovações tem 3 pedidos desta conversa que o Bot não listou.");
  });

  it("no mismatch line when they agree that there is something, or that there is nothing", () => {
    card({ pending: 3 });
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
    cleanup();
    card({ pending: 0, evidence: ev({ awaiting: [] }) });
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
    cleanup();
    card({ pending: 0, evidence: ev({ awaiting: null }) });
    expect(screen.queryByTestId("evidence-mismatch")).toBeNull();
  });

  it("the count is the screen's, never the length of what the Bot listed", () => {
    card({ pending: 0, evidence: ev({ awaiting: [{ text: "a" }, { text: "b" }, { text: "c" }] }) });
    expect(screen.getByTestId("evidence-in-box").textContent).toBe("Pedidos pendentes desta conversa: 0");
  });
});

describe("nada no cartão decide", () => {
  it("the only buttons are the copy buttons and 'Abrir Aprovações'; no link, no form, no input; and no request goes out", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const open = vi.fn();
    const { root } = card({ pending: 2, onOpenApprovals: open, evidence: ev({ facts: [{ text: "a", source: "s1" }, { text: "b", source: "s2" }] }) });
    const names = Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
    expect(names.sort()).toEqual(["Abrir Aprovações", "copiar", "copiar"]);
    expect(root.querySelectorAll("a, form, input, textarea, select")).toHaveLength(0);
    await act(async () => { for (const b of Array.from(root.querySelectorAll("button"))) fireEvent.click(b); });
    expect(open).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("no word on it approves, denies or accepts", () => {
    const { root } = card({ pending: 2, onOpenApprovals: vi.fn() });
    expect(Array.from(root.querySelectorAll("button")).map((b) => b.textContent).join(" ")).not.toMatch(/aprov(ar|e)\b|negar|recusar|aceitar|permitir|sempre/i);
  });
});

describe("com o parser (E-1) de ponta a ponta", () => {
  const BLOCK = ["Terminei.", "```luve-evidence", "facts:", "- Vendas fechou 12 propostas | source: crm/setembro.csv", "assumptions:", "- none", "done:", "- Gerei o resumo", "awaiting:", "- Enviar ao cliente X", "```"].join("\n");
  it("a valid block parsed by splitEvidence draws the card with what the Bot wrote", () => {
    const seg = splitEvidence(BLOCK).find((s) => s.kind === "evidence");
    expect(seg).toBeDefined();
    render(<EvidenceCard evidence={(seg as { evidence: Evidence }).evidence} pending={1} />);
    expect(within(screen.getByTestId("evidence-facts")).getByTestId("evidence-item").textContent).toBe("Vendas fechou 12 propostas");
    expect(screen.getByTestId("evidence-source").textContent).toBe("Fonte: crm/setembro.csv");
    expect(screen.getByTestId("evidence-assumptions-none")).toBeDefined();
    expect(screen.getByTestId("evidence-questions-absent")).toBeDefined();
  });
});
