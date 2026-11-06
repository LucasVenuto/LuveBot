// tests/unit/agent/free-mode-unknown.test.tsx
// Red team 29/10 B3. (1) When /bots could not say a Bot's mode for a while, the screen kept the last mode it knew forever: a Bot that became Livre by another
// way had no chip while the server could not say. Now, after 3 reads in a row that did not say it (it had before), the chip says "Modo não confirmado" (neutral,
// never Livre or not Livre by a guess). A Bot last known as Livre keeps its Livre chip (the risky state is shown); a Bot whose mode was never said (an older
// backend) is as it always was. (2) The free passes list cut a command at 96 px with no way to see the end: now "Ver o comando inteiro".
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within, act } from "@testing-library/react";
import { useApprovalModes, announceMode, SILENT_POLLS } from "@/components/agent/freeMode";
import { ContactList } from "@/components/messenger/ContactList";
import { Conversation } from "@/components/conversation";
import { FreePassesCard } from "@/components/agent/FreePassesCard";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { Bot } from "@/api/types";

const bot = (name: string, mode?: "free" | "luvebot"): Bot => ({ name, status: "idle", ...(mode ? { approval_mode: mode } : {}),
  display: { label: name, role: "", color: "#60a5fa", avatar: { kind: "initials", value: name.slice(0, 2).toUpperCase() } } } as any);
let seen: Bot[];
function Probe({ loaded }: { loaded: Bot[] }) { seen = useApprovalModes(loaded); return null; }
const poll = (r: ReturnType<typeof render>, ...bots: Bot[]) => r.rerender(<Probe loaded={[...bots]} />);   // a new array: a new /bots read
const of = (name: string) => seen.find((b) => b.name === name)!;

beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("a mode /bots stopped saying", () => {
  it("after 3 reads in a row without it the Bot is 'não confirmado'; before that it keeps what it was; a read that says it clears it", () => {
    expect(SILENT_POLLS).toBe(3);
    const r = render(<Probe loaded={[bot("unk-a", "luvebot")]} />);
    expect(of("unk-a").approval_mode).toBe("luvebot");
    poll(r, bot("unk-a")); poll(r, bot("unk-a"));
    expect(of("unk-a").approval_unknown).toBeUndefined();               // 2 silent reads: still the last known
    expect(of("unk-a").approval_mode).toBe("luvebot");
    poll(r, bot("unk-a"));
    expect(of("unk-a").approval_unknown).toBe(true);                     // the 3rd
    expect(of("unk-a").approval_mode).toBe("luvebot");                   // the last known stays as data; the chip is what says "not confirmed"
    poll(r, bot("unk-a", "luvebot"));
    expect(of("unk-a").approval_unknown).toBeUndefined();                // it said it again
    poll(r, bot("unk-a")); poll(r, bot("unk-a"));
    expect(of("unk-a").approval_unknown).toBeUndefined();                // and the count starts over
  });

  it("the same read settled again is counted once: an announcement about another Bot recomputes the same /bots read and is not a new read", () => {
    const r = render(<Probe loaded={[bot("unk-b", "luvebot")]} />);
    const silent = [bot("unk-b")];
    r.rerender(<Probe loaded={silent} />);                                // ONE silent read
    for (let i = 0; i < 6; i++) act(() => announceMode("unk-b-other", i % 2 ? "free" : "luvebot"));   // six recomputations of that same read
    expect(of("unk-b").approval_unknown).toBeUndefined();
    poll(r, bot("unk-b")); poll(r, bot("unk-b"));                         // reads 2 and 3
    expect(of("unk-b").approval_unknown).toBe(true);
  });

  it("a Bot last known as Livre keeps its Livre chip, never 'not confirmed'; a Bot never known (an older backend) is never unknown", () => {
    const r = render(<Probe loaded={[bot("unk-c", "free"), bot("unk-d")]} />);
    for (let i = 0; i < 5; i++) poll(r, bot("unk-c"), bot("unk-d"));
    expect(of("unk-c").approval_mode).toBe("free");
    expect(of("unk-c").approval_unknown).toBeUndefined();
    expect(of("unk-d").approval_mode).toBeUndefined();
    expect(of("unk-d").approval_unknown).toBeUndefined();
  });

  it("the Perfil's fresh word clears it at once", () => {
    const r = render(<Probe loaded={[bot("unk-e", "luvebot")]} />);
    for (let i = 0; i < 3; i++) poll(r, bot("unk-e"));
    expect(of("unk-e").approval_unknown).toBe(true);
    announceMode("unk-e", "luvebot");
    poll(r, bot("unk-e"));
    expect(of("unk-e").approval_unknown).toBeUndefined();
  });
});

describe("the chip", () => {
  it("neutral 'Modo não confirmado' in the contact list and the conversation header, with the reason in its title; Livre wins over it", () => {
    const unknown = { ...bot("unk-f", "luvebot"), approval_unknown: true } as Bot;
    render(<ContactList bots={[unknown, bot("unk-g", "free")]} onBotsChanged={() => {}} />);
    const rows = document.querySelectorAll("button[aria-pressed]");
    expect(within(rows[0] as HTMLElement).getByTestId("free-chip-unknown").textContent).toContain("Modo não confirmado");
    expect(within(rows[0] as HTMLElement).queryByTestId("free-chip")).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTestId("free-chip")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByTestId("free-chip-unknown")).toBeNull();
    expect(screen.getByTestId("free-chip-unknown").getAttribute("title")).toBe("Não consegui confirmar nas últimas leituras se este Bot está no modo Livre. Confira no Perfil do Bot.");
    cleanup();
    setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : {}));
    render(<Conversation bot={{ name: "unk-f", label: "Unk", approval_mode: "luvebot", approval_unknown: true }} initialTurns={[]} />);
    expect(screen.getByTestId("free-chip-unknown")).toBeTruthy();
    expect(screen.queryByTestId("free-chip")).toBeNull();
  });

  it("in English", () => {
    setLuveLocale("en");
    render(<ContactList bots={[{ ...bot("unk-h", "luvebot"), approval_unknown: true } as Bot]} onBotsChanged={() => {}} />);
    expect(screen.getByTestId("free-chip-unknown").textContent).toContain("Mode not confirmed");
  });
});

describe("Executado sem pedir: the whole command", () => {
  const pass = (at: number, command: string) => ({ at, tool: "terminal", rule_id: null, command, audited: true });
  const LONG = "git push origin main " + "--force-with-lease ".repeat(20) + "\nFIM <b>do</b> comando";
  function backend(rows: any[]) {
    setCustomFetchJSON(async (url: string) => {
      if (url.includes("/rules")) return { rules: [] };
      if (url.includes("/free-passes")) return { free_passes: rows, next_before: null };
      return {};
    });
  }

  it("a long command offers 'Ver o comando inteiro' and opens it (and closes it); a short one offers nothing; the command stays text", async () => {
    backend([pass(1_800_000_100, LONG), pass(1_800_000_000, "git status")]);
    render(<FreePassesCard bot="vendas" />);
    const rows = await screen.findAllByTestId("free-pass");
    const first = rows[0];
    const code = within(first).getByTestId("free-pass-command");
    expect(code.style.maxHeight).toBe("96px");
    expect(code.querySelector("b")).toBeNull();                               // text, never markup
    const more = within(first).getByTestId("free-pass-more");
    expect(more.textContent).toBe("Ver o comando inteiro");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(rows[1]).queryByTestId("free-pass-more")).toBeNull();
    fireEvent.click(more);
    expect(within(first).getByTestId("free-pass-command").style.maxHeight).toBe("");
    expect(within(first).getByTestId("free-pass-more").textContent).toBe("Ver menos");
    expect(within(first).getByTestId("free-pass-more").getAttribute("aria-expanded")).toBe("true");
    expect(within(first).getByTestId("free-pass-command").textContent).toContain("FIM <b>do</b> comando");     // the end of the command is on screen
    fireEvent.click(within(first).getByTestId("free-pass-more"));
    expect(within(first).getByTestId("free-pass-command").style.maxHeight).toBe("96px");
    expect(within(rows[1]).getByTestId("free-pass-command").style.maxHeight).toBe("96px");
  });
});
