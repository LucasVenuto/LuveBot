// tests/unit/skills/skill-draft-card.test.tsx
// What the conversation draws in place of the Bot's answer to the skill-draft turn (contract v0.11 3.2 step 2): a card "Draft ready, N lines" that opens the sheet, NEVER the draft text; a text that is not a draft says
// why in words (the answer stays ordinary text, except when it holds characters the table refuses) and offers to ask again.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, configure } from "@testing-library/react";
import { SkillDraftCard } from "@/components/skills/SkillDraftCard";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale, translations } from "@/i18n";

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const BODY = "---\nname: send-report\ndescription: Use when a report must go out.\n---\n1. Open the SECRET-STEP report.\n2. Send it.";
const fence = (body: string, ticks = "```") => `Aqui está.\n${ticks}luve-skill\n${body}\n${ticks}\nPronto.`;
const TAG = String.fromCodePoint(0xe0041), ZWNJ = String.fromCodePoint(0x200c);

beforeEach(() => {
  cleanup(); resetCsrfToken(); setLuveLocale("pt");
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "basic:ceo", auth_mode: "gated" } : { name: "send-report", category: null, description: "d", bytes: 1, warnings: [] }));
});
afterEach(() => setCustomFetchJSON(null));

function mount(text: string) {
  const plain = vi.fn(() => <div data-testid="plain-answer">{text}</div>);
  const again = vi.fn();
  render(<SkillDraftCard text={text} bot="vendas" onAskAgain={again} plain={plain} />);
  return { plain, again };
}

describe("a draft: a card, never the text", () => {
  it("says 'Draft ready, N lines' and offers the review; the answer is NOT drawn (no word of the draft is on the page)", () => {
    const { plain } = mount(fence(BODY));
    const card = screen.getByTestId("skill-draft-card");
    expect(card.textContent).toContain("Rascunho pronto, 6 linhas");
    expect(screen.getByRole("button", { name: "Revisar e criar" })).toBeTruthy();
    expect(plain).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("SECRET-STEP");
    expect(document.body.textContent).not.toContain("send-report");
    expect(screen.queryByTestId("skill-draft-refused")).toBeNull();
  });

  it("a draft written in a FOUR-backtick fence (it holds fences of its own) is one draft, with all its lines, and still not drawn", () => {
    const inner = BODY + "\n3. Run:\n```sh\necho SECRET-STEP\n```\n4. Done.";
    mount(fence(inner, "````"));
    expect(screen.getByTestId("skill-draft-card").textContent).toContain("Rascunho pronto, 11 linhas");
    expect(document.body.textContent).not.toContain("echo SECRET-STEP");
  });

  it("'Revisar e criar' opens the sheet with the WHOLE draft in the editable area; closing it leaves the card", () => {
    mount(fence(BODY));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revisar e criar" }));
    const dialog = screen.getByRole("dialog");
    expect((screen.getByLabelText("Texto da skill (SKILL.md)") as HTMLTextAreaElement).value).toBe(BODY);
    expect(dialog.textContent).toContain("Isto vira instruções permanentes do seu Bot. Leia tudo.");
    fireEvent.click(screen.getAllByRole("button", { name: "Cancelar" }).pop()!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("skill-draft-card")).toBeTruthy();
  });

  it("allowed invisible characters do not stop it (a Persian or a Hindi skill needs them); the sheet will name them", () => {
    mount(fence(BODY.replace("Open", "Open" + ZWNJ)));
    expect(screen.getByTestId("skill-draft-card")).toBeTruthy();
  });
});

describe("not a draft: why, in words, and ask again", () => {
  it.each([
    ["no fence at all", "Fiz o relatório e enviei.", translations.pt.skillWhyNone],
    ["two fences", fence(BODY) + "\n" + fence(BODY), translations.pt.skillWhyTwoFences],
    ["a fence never closed", "```luve-skill\n" + BODY, translations.pt.skillWhyUnclosed],
    ["no header", fence("1. Open the report."), translations.pt.skillWhyNoFrontmatter],
    ["a header that never closes", fence("---\nname: x\ndescription: y.\nbody"), translations.pt.skillWhyNoFrontmatter],
    ["an empty body", fence("---\nname: x\ndescription: y.\n---\n"), translations.pt.skillWhyEmptyBody],
    ["a text over 32 KiB", fence(BODY + "\n" + "x".repeat(33 * 1024)), translations.pt.skillWhyTooLarge],
    ["a tilde fence", "~~~luve-skill\n" + BODY + "\n~~~", translations.pt.skillWhyNone],
    ["a luve-skill fence inside another fence (a quote)", "````\n" + fence(BODY) + "\n````", translations.pt.skillWhyNone],
  ])("%s", (_what, text, words) => {
    const { plain, again } = mount(text);
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain(words);
    expect(plain).toHaveBeenCalledTimes(1);                                                  // the answer stays ordinary text
    expect(screen.queryByTestId("skill-draft-card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pedir de novo" }));
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("a refused character (a Tag, a bidi override...): the reason names its CLASS and place, never the character, and the answer is STILL drawn as an ordinary message (A-185: a refusal never hides it)", () => {
    const { plain } = mount(fence(BODY.replace("Send it.", "Send it." + TAG + "now")));
    const note = screen.getByTestId("skill-draft-refused");
    expect(note.textContent).toContain("um caractere de etiqueta Unicode");
    expect(note.textContent).toContain("linha 6, coluna 12");
    expect(note.textContent).not.toContain(TAG);                                              // the REASON never carries the character
    expect(plain).toHaveBeenCalledTimes(1);                                                    // the message is drawn, as every Bot message is
    expect(screen.getByTestId("plain-answer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pedir de novo" })).toBeTruthy();
  });

  it("more than 50 invisible characters: the count, and the answer is still drawn as an ordinary message", () => {
    const { plain } = mount(fence(BODY + "\n3. " + ZWNJ.repeat(51)));
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("Este texto tem 51 caracteres invisíveis; o limite é 50.");
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it("in English", () => {
    setLuveLocale("en");
    mount("just text");
    expect(screen.getByTestId("skill-draft-refused").textContent).toContain("The Bot's answer is not a skill draft.");
    expect(screen.getByRole("button", { name: "Ask again" })).toBeTruthy();
  });
});
