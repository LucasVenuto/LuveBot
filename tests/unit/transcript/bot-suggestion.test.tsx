// tests/unit/transcript/bot-suggestion.test.tsx
// Sugestão de Bot pelo marcador (contract v0.8 §5; spec 4.6): a Bot proposes another Bot with ONE marker on its own line,
//   [luvebot:sugerir-bot nome="Cobrança" papel="Cobra faturas vencidas"]
// A WELL-FORMED marker becomes a card with Criar and Ignorar; anything else stays text. Criar opens the create assistant PREFILLED and
// the person still picks everything and confirms: the card and the marker never create a Bot (it is agent output: data, not an order).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { splitBotSuggestions, parseMarker, profileNameOf } from "@/lib/botSuggestion";
import { MessageCard } from "@/components/transcript/cards";
import { BotSuggestionProvider } from "@/components/transcript/BotSuggestion";
import { BotCreateModal } from "@/components/bots/BotCreateModal";
import { setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";

const M = (nome: string, papel: string) => `[luvebot:sugerir-bot nome="${nome}" papel="${papel}"]`;
const OK = M("Cobrança", "Cobra faturas vencidas");

describe("o marcador", () => {
  it("a well-formed marker on its own line is a card; the text around it stays text, in order", () => {
    const parts = splitBotSuggestions(`Posso ajudar com isso.\n${OK}\nFale comigo se quiser.`);
    expect(parts.map((p) => p.kind)).toEqual(["text", "bot", "text"]);
    expect(parts[1]).toEqual({ kind: "bot", suggestion: { name: "Cobrança", role: "Cobra faturas vencidas" } });
    expect((parts[0] as { text: string }).text).toBe("Posso ajudar com isso.");
  });

  it("a message with no marker comes back whole", () => {
    expect(splitBotSuggestions("olá\n\nmundo")).toEqual([{ kind: "text", text: "olá\n\nmundo" }]);
  });

  it.each([
    ["an extra attribute", '[luvebot:sugerir-bot nome="A" papel="B" cor="red"]'],
    ["the attributes swapped", '[luvebot:sugerir-bot papel="B" nome="A"]'],
    ["HTML in the name", M("<b>Cobrança</b>", "Cobra")],
    ["HTML in the role", M("Cobrança", '<img src=x onerror=alert(1)>')],
    ["a backslash", M("Cobr\\ança", "Cobra")],
    ["javascript:", M("Cobrança", "javascript:alert(1)")],
    ["data:", M("data:text/html,x", "Cobra")],
    ["an empty name", M(" ", "Cobra")],
    ["a name over 40 characters", M("x".repeat(41), "Cobra")],
    ["a role over 160 characters", M("Cobrança", "y".repeat(161))],
    ["a control character", `[luvebot:sugerir-bot nome="Cob\tança" papel="Cobra"]`],
    ["the marker inside a sentence", `Sugiro isto ${OK} ok?`],
    ["another marker name", '[luvebot:criar-bot nome="A" papel="B"]'],
  ])("%s is text, not a card", (_label, line) => {
    expect(parseMarker(line)).toBeNull();
    expect(splitBotSuggestions(`antes\n${line}\ndepois`).every((p) => p.kind === "text")).toBe(true);
  });

  it("the limits are inclusive: 40 and 160 characters are accepted", () => {
    expect(parseMarker(M("n".repeat(40), "r".repeat(160)))).not.toBeNull();
  });

  it("a marker inside a code fence is text (a Bot explaining the format is not suggesting)", () => {
    expect(splitBotSuggestions("Assim:\n```\n" + OK + "\n```\nfim").every((p) => p.kind === "text")).toBe(true);
    expect(splitBotSuggestions("~~~\n" + OK + "\n~~~").every((p) => p.kind === "text")).toBe(true);
  });

  it("no more than three cards per message; the rest stay text", () => {
    const parts = splitBotSuggestions([OK, OK, OK, OK, OK].join("\n"));
    expect(parts.filter((p) => p.kind === "bot")).toHaveLength(3);
    expect(parts.filter((p) => p.kind === "text")).toHaveLength(1);
  });

  it("a profile name from the display name", () => {
    expect(profileNameOf("Cobrança")).toBe("cobranca");
    expect(profileNameOf("Equipe de Vendas 2")).toBe("equipe-de-vendas-2");
    expect(profileNameOf("!!!")).toBe("");
    expect(profileNameOf("x".repeat(80)).length).toBeLessThanOrEqual(64);
  });
});

describe("o marcador: caracteres de formatação e cercas (red team B2)", () => {
  it.each([
    ["the right-to-left override U+202E", "\u202E"], ["a left-to-right isolate U+2066", "\u2066"], ["a pop isolate U+2069", "\u2069"],
    ["a zero-width space U+200B", "\u200B"], ["a right-to-left mark U+200F", "\u200F"], ["the BOM U+FEFF", "\uFEFF"],
    ["the line separator U+2028", "\u2028"], ["the paragraph separator U+2029", "\u2029"], ["a C1 control U+0085", "\u0085"], ["DEL", "\u007f"],
  ])("%s in the name or in the role is text, not a card", (_label, ch) => {
    expect(parseMarker(M(`Cob${ch}rança`, "Cobra"))).toBeNull();
    expect(parseMarker(M("Cobrança", `Cobra${ch}faturas`))).toBeNull();
    expect(splitBotSuggestions(`antes\n${M(`Cob${ch}rança`, "Cobra")}\ndepois`).every((p) => p.kind === "text")).toBe(true);
  });

  it("ordinary letters, accents, emoji and spaces still make a card", () => {
    expect(parseMarker(M("Cobrança Ágil 😀", "Cobra faturas, com acentuação"))).toEqual({ name: "Cobrança Ágil 😀", role: "Cobra faturas, com acentuação" });
  });

  it("a ``` line inside a ```` fence is code: the marker after it stays code, and the real closing (4 backticks) ends the fence", () => {
    const inside = ["````", "```", OK, "````"].join("\n");
    expect(splitBotSuggestions(inside).every((p) => p.kind === "text")).toBe(true);
    const after = ["````", "```", "````", OK].join("\n");
    const parts = splitBotSuggestions(after);
    expect(parts.filter((p) => p.kind === "bot")).toHaveLength(1);
  });

  it("a fence closes only with the same character, at least as long, and nothing else on the line", () => {
    expect(splitBotSuggestions(["~~~", "```", OK, "~~~"].join("\n")).every((p) => p.kind === "text")).toBe(true);   // ``` does not close ~~~
    expect(splitBotSuggestions(["````", "``` fim", OK, "````"].join("\n")).every((p) => p.kind === "text")).toBe(true);   // too short, and text after it
    expect(splitBotSuggestions(["```", "``` texto", OK].join("\n")).every((p) => p.kind === "text")).toBe(true);          // text after ``` is not a closing
    expect(splitBotSuggestions(["```", "```", OK].join("\n")).filter((p) => p.kind === "bot")).toHaveLength(1);           // a plain closing ends it
    expect(splitBotSuggestions(["~~~~", "~~~~~", OK].join("\n")).filter((p) => p.kind === "bot")).toHaveLength(1);        // longer closes too
  });
});

describe("o cartão na conversa", () => {
  let calls: { url: string; method: string }[];
  beforeEach(() => { cleanup(); setLuveLocale("pt"); calls = []; setCustomFetchJSON(async (url, init) => { calls.push({ url, method: init?.method ?? "GET" }); return {}; }); });
  afterEach(() => cleanup());
  const message = (text: string, onCreate = vi.fn()) => {
    render(<BotSuggestionProvider onCreate={onCreate}><MessageCard text={text} /></BotSuggestionProvider>);
    return onCreate;
  };

  it("shows 'Sugestão: criar o Bot “Cobrança”' with the role as text and the other lines as Markdown", () => {
    message(`Vi que há faturas atrasadas.\n${OK}`);
    expect(screen.getByTestId("bot-suggestion").textContent).toContain("Sugestão: criar o Bot “Cobrança”");
    expect(screen.getByTestId("bot-suggestion-role").textContent).toBe("Cobra faturas vencidas");
    expect(screen.getByText("Vi que há faturas atrasadas.")).toBeDefined();
    expect(screen.queryByText(/luvebot:sugerir-bot/)).toBeNull();
  });

  it("Criar hands the two fields to the shell and creates NOTHING: no request at all, not even a moment later", async () => {
    const onCreate = message(OK);
    fireEvent.click(screen.getByTestId("btn-bot-suggestion-create"));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({ name: "Cobrança", role: "Cobra faturas vencidas" });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });

  it("Ignorar takes the card off, only for this message", () => {
    message(`${OK}\ntexto`);
    fireEvent.click(screen.getByTestId("btn-bot-suggestion-ignore"));
    expect(screen.queryByTestId("bot-suggestion")).toBeNull();
    expect(screen.getByText("texto")).toBeDefined();
    cleanup();
    message(OK);
    expect(screen.getByTestId("bot-suggestion")).toBeDefined();
  });

  it("a malformed marker shows as text, the whole line, and no card", () => {
    const bad = '[luvebot:sugerir-bot nome="<b>x</b>" papel="y"]';
    message(bad);
    expect(screen.queryByTestId("bot-suggestion")).toBeNull();
    expect(document.body.textContent).toContain("luvebot:sugerir-bot");
    expect(document.querySelector("b")).toBeNull();
  });

  it("without the shell's handler (nothing can open the assistant) the marker stays text", () => {
    render(<MessageCard text={OK} />);
    expect(screen.queryByTestId("bot-suggestion")).toBeNull();
    expect(document.body.textContent).toContain("luvebot:sugerir-bot");
  });

  it("speaks English", () => {
    setLuveLocale("en");
    message(OK);
    expect(screen.getByTestId("bot-suggestion").textContent).toContain("Suggestion: create the Bot “Cobrança”");
    expect(screen.getByRole("button", { name: "Create" })).toBeDefined();
  });
});

describe("o assistente de criação preenchido", () => {
  let posts: string[];
  beforeEach(() => { cleanup(); setLuveLocale("pt"); posts = []; setCustomFetchJSON(async (url, init) => { if ((init?.method ?? "GET") !== "GET") posts.push(url); return {}; }); });
  afterEach(() => cleanup());

  it("after the template is picked, name and role are the Bot's suggestion, with a note; the person still confirms, and nothing is posted", () => {
    render(<BotCreateModal isOpen onClose={() => {}} prefill={{ name: "Cobrança", role: "Cobra faturas vencidas" }} />);
    fireEvent.click(screen.getByText("Vendas"));                            // the template's label and role would have been these
    expect(screen.getByTestId("bot-suggestion-note").textContent).toContain("Sugestão do Bot");
    expect(screen.getByDisplayValue("Cobrança")).toBeDefined();
    expect(screen.getByDisplayValue("Cobra faturas vencidas")).toBeDefined();
    expect(screen.getByDisplayValue("cobranca")).toBeDefined();               // the profile name, derived and still editable
    expect(posts).toHaveLength(0);
  });

  it("opened plainly, it has no note and keeps the template's own name and role", () => {
    render(<BotCreateModal isOpen onClose={() => {}} />);
    fireEvent.click(screen.getByText("Vendas"));
    expect(screen.queryByTestId("bot-suggestion-note")).toBeNull();
    expect(screen.queryByDisplayValue("Cobrança")).toBeNull();
  });
});
