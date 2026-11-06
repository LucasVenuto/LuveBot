// tests/unit/rules/recipient-reach.test.tsx
// Red team 29/10 M3: an `allow` (or `explicit`) with a recipient only warned for `bot:`. `all` (every channel that is on) and `chat:<platform>:<id>`
// (people outside LuveBot) are the destinations that reach people, and said nothing. Now every recipient that is not `origin` or `local` warns, with its
// own sentence for a Bot, `all` and a chat; what the screen does not know warns too; an ask never does.
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RecipientWarning, RuleRecipientWarning, recipientScope } from "@/components/rules/RuleConditions";
import { setLuveLocale } from "@/i18n";
import type { Rule } from "@/api/types";

const BOTS = [{ name: "suporte", status: "idle", display: { label: "Suporte", role: "", color: "#60a5fa", avatar: { kind: "initials", value: "SU" } } }] as any;
beforeEach(() => { cleanup(); setLuveLocale("pt"); });
afterEach(() => setLuveLocale("pt"));

describe("where a recipient reaches", () => {
  it("origin and local stay home; a Bot, all, a chat and anything unknown reach somewhere; empty says nothing yet", () => {
    expect(["origin", "local", "", "  "].map(recipientScope)).toEqual([null, null, null, null]);
    expect(["bot:suporte", "all", "chat:telegram:123", "slack:#geral", "ALL", "Local"].map(recipientScope)).toEqual(["bot", "all", "chat", "other", "other", "other"]);
  });
});

describe("the warning on an allow", () => {
  const warn = (level: any, value: string) => { cleanup(); render(<RecipientWarning level={level} value={value} bots={BOTS} />); return screen.queryByTestId("recipient-warning"); };

  it("each destination has its own sentence", () => {
    expect(warn("allow", "bot:suporte")!.textContent).toContain("faz o Bot Suporte passar a receber");
    expect(warn("allow", "all")!.textContent).toBe("Permitir assim libera o envio para TODOS os canais ligados: o que o Bot escrever pode chegar a pessoas de fora do LuveBot.");
    expect(warn("allow", "chat:telegram:123")!.textContent).toBe("Permitir assim libera o envio para a conversa chat:telegram:123, fora do LuveBot: quem estiver nela recebe o que o Bot escrever.");
    expect(warn("explicit", "slack:#geral")!.textContent).toContain("slack:#geral, que não é este chat nem local");
    expect(warn("allow", "all")!.getAttribute("data-scope")).toBe("all");
  });

  it("origin, local, an empty value and every level that is not allow or explicit say nothing", () => {
    for (const quiet of [["allow", "origin"], ["allow", "local"], ["allow", ""], ["ask", "all"], ["ask", "chat:telegram:1"], ["block", "all"], ["handback", "all"]]) {
      expect([quiet, warn(quiet[0], quiet[1])]).toEqual([quiet, null]);
    }
  });

  it("the rule's card carries it too, for the first recipient that reaches somewhere", () => {
    const rule = (level: string, value: string) => ({ id: "r", level, match: { tools: ["kanban_create"], conditions: [{ fact: "recipient", op: "eq", value }] } }) as unknown as Rule;
    render(<RuleRecipientWarning rule={rule("allow", "all")} bots={BOTS} />);
    expect(screen.getByTestId("recipient-warning").getAttribute("data-scope")).toBe("all");
    cleanup(); render(<RuleRecipientWarning rule={rule("allow", "chat:telegram:9")} bots={BOTS} />);
    expect(screen.getByTestId("recipient-warning").getAttribute("data-scope")).toBe("chat");
    cleanup(); render(<RuleRecipientWarning rule={rule("allow", "local")} bots={BOTS} />);
    expect(screen.queryByTestId("recipient-warning")).toBeNull();
    cleanup(); render(<RuleRecipientWarning rule={rule("ask", "all")} bots={BOTS} />);
    expect(screen.queryByTestId("recipient-warning")).toBeNull();
  });

  it("in English", () => {
    setLuveLocale("en");
    expect(warn("allow", "all")!.textContent).toBe("Allowing this lets it send to EVERY channel that is on: what the Bot writes can reach people outside LuveBot.");
  });
});
