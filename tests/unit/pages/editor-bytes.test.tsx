// tests/unit/pages/editor-bytes.test.tsx
// The page editor of ADR-009 option C (D-029), at the level of the screen:
//  R1  opening and closing a page never changes its bytes and never saves: no edit, no PUT, no dialog; a page with CRLF is written back with
//      CRLF; editing back to what is on disk saves nothing.
//  Leaving with changes shows the 21a diff first (plain text): "Salvar e sair" saves the exact bytes, "Sair sem salvar" writes nothing.
//  The toolbar and the shortcuts only insert Markdown (through pages/format.ts), without moving the selection or the app's own shortcuts.
//  The seam window.__LUVEBOT_EDITOR__: a registered visual editor takes the textarea's place, is asked for the text only after it says the
//  person edited, and one that cannot hold a page leaves the source editor; with no library nothing is loaded.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PageEditor } from "@/components/pages/PageEditor";
import { ApiError, resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { PageWithContent } from "@/api/types";
import type { PageEditorSeam } from "@/editor/api";

const SHA1 = "a".repeat(64), SHA2 = "b".repeat(64);
const pageOf = (content: string, over: Partial<PageWithContent> = {}): PageWithContent => ({
  slug: "proposta", title: "Proposta", excerpt: "", size: content.length, mtime: "2026-10-01T14:00:00Z", sha: SHA1, rev: 1, author: "bot",
  author_label: "Vendas", by_you: false, editable: true, content, redacted: false, ...over,
} as PageWithContent);

let puts: { content: string; base_sha: string }[], conflict: boolean, failPut: boolean;
const bytes = (s: string) => Buffer.from(s, "utf8").toString("hex");

beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); puts = []; conflict = false; failPut = false;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setCustomFetchJSON(async (url, init) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "x", auth_mode: "gated" };
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      if (failPut) throw new ApiError({ code: "hermes_unreachable", message: "x", status: 502 } as never);
      if (conflict) throw new ApiError({ code: "page_conflict", message: "x", status: 409, details: { changed_by_label: "Vendas" } } as never);
      return { page: { ...pageOf(body.content), sha: SHA2, rev: 2 }, changed: true };
    }
    return {};
  });
});
afterEach(() => { vi.useRealTimers(); setCustomFetchJSON(null); delete window.__LUVEBOT_EDITOR__; vi.unstubAllGlobals(); });

const open = (content: string, over: { onDone?: ReturnType<typeof vi.fn> } = {}) => {
  const onDone = over.onDone ?? vi.fn();
  render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf(content)} onDone={onDone} />);
  return { onDone, area: () => screen.getByLabelText("Texto da página em Markdown") as HTMLTextAreaElement };
};
const idle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const type = (ta: HTMLTextAreaElement, value: string) => fireEvent.change(ta, { target: { value } });

describe("R1: abrir e fechar não muda bytes", () => {
  const PAGES: Record<string, string> = {
    LF: "# Título\n\ntexto\n- a\n",
    CRLF: "# Título\r\n\r\ntexto\r\n- a\r\n",
    "no final break": "# Título\n\ntexto",
    BOM: "\ufeff# Título\r\n",
    "mixed line endings": "a\r\nb\r\nc\nd\r\n",
    "a lone CR": "a\rb\n",
    "emoji and accents": "ação 😀 日本語\n",
    empty: "",
  };
  for (const [name, content] of Object.entries(PAGES)) {
    it(`${name}: focus, blur, 10 s idle, and Concluir change nothing and save nothing`, async () => {
      const { onDone, area } = open(content);
      fireEvent.focus(area());
      fireEvent.blur(area());
      await idle(10_000);
      expect(puts).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
      expect(screen.queryByRole("dialog")).toBeNull();                         // nothing to review: it just closes
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(bytes(onDone.mock.calls[0][1])).toBe(bytes(content));              // the reader gets the very same bytes back
    });
  }

  it("the textarea shows the page with plain line breaks (what a browser would give back), never a \\r", () => {
    const { area } = open("a\r\nb\r\n");
    expect(area().value).toBe("a\nb\n");
  });

  it("editing a page back to what is on disk saves nothing and says there are no changes", async () => {
    const { area } = open("# T\n\ntexto\n");
    type(area(), "# T\n\ntexto!\n");
    expect(screen.getByRole("status", { name: "" }) ?? null).toBeTruthy();
    expect(screen.getByText("Não salvo ainda")).toBeTruthy();
    type(area(), "# T\n\ntexto\n");
    expect(screen.queryByText("Não salvo ainda")).toBeNull();
    expect(screen.getByText("Sem mudanças")).toBeTruthy();
    await idle(10_000);
    expect(puts).toHaveLength(0);
  });
});

describe("a gravação mantém os bytes que a página tinha", () => {
  it("a CRLF page is written back with CRLF in every break, byte for byte", async () => {
    const { area } = open("# T\r\n\r\ntexto\r\n");
    type(area(), "# T\n\ntexto\n\nmais uma linha\n");                       // what a browser reports after typing
    await idle(3100);
    expect(puts).toHaveLength(1);
    expect(bytes(puts[0].content)).toBe(bytes("# T\r\n\r\ntexto\r\n\r\nmais uma linha\r\n"));
    expect(puts[0].base_sha).toBe(SHA1);
  });

  it("an LF page stays LF, with its BOM and its missing final break", async () => {
    const { area } = open("\ufeff# T\ntexto");
    type(area(), "\ufeff# T\ntexto aqui");
    await idle(3100);
    expect(bytes(puts[0].content)).toBe(bytes("\ufeff# T\ntexto aqui"));
  });

  it("a page that mixes line endings is made uniform (the dominant one) only when edited", async () => {
    const { area } = open("a\r\nb\r\nc\nd\r\n");
    await idle(5000);
    expect(puts).toHaveLength(0);
    type(area(), "a\nb\nc\nd\ne\n");
    await idle(3100);
    expect(puts[0].content).toBe("a\r\nb\r\nc\r\nd\r\ne\r\n");
  });
});

describe("sair com mudanças mostra o diff antes", () => {
  it("saved by the autosave: the review says everything is saved, shows what changed since it was opened, and Concluir leaves with what is on disk", async () => {
    const { area, onDone } = open("# T\nlinha antiga\n");
    type(area(), "# T\nlinha nova\n");
    await idle(3100);
    expect(puts).toHaveLength(1);
    expect(screen.getByTestId("btn-page-changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("page-review-state").textContent).toContain("Tudo o que você mudou já está gravado");
    const diff = within(dialog).getByRole("list", { name: /Diferenças/ });
    expect(diff.textContent).toContain("linha antiga");
    expect(diff.textContent).toContain("linha nova");
    expect(within(dialog).queryByTestId("btn-page-save-leave")).toBeNull();      // nothing left to save
    fireEvent.click(within(dialog).getByTestId("btn-page-leave"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe("# T\nlinha nova\n");
  });

  it("not saved yet: 'Salvar e sair' saves the exact bytes once and leaves with them", async () => {
    const { area, onDone } = open("a\r\nb\r\n");
    type(area(), "a\nb\nc\n");
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("page-review-state").textContent).toContain("ainda não foram gravadas");
    await act(async () => { fireEvent.click(within(dialog).getByTestId("btn-page-save-leave")); await vi.advanceTimersByTimeAsync(50); });
    expect(puts).toHaveLength(1);
    expect(bytes(puts[0].content)).toBe(bytes("a\r\nb\r\nc\r\n"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe("a\r\nb\r\nc\r\n");
  });

  it("'Salvar e sair' leaves only when the server took the text: a failure keeps the editor open and says so", async () => {
    failPut = true;
    const { area, onDone } = open("original\n");
    type(area(), "rascunho\n");
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByTestId("btn-page-save-leave")); await vi.advanceTimersByTimeAsync(50); });
    expect(puts).toHaveLength(1);
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Não salvo. Seu texto continua aqui.")).toBeTruthy();
    expect(area().value).toBe("rascunho\n");                               // what was typed is still there
  });

  it("not saved yet: 'Sair sem salvar' writes nothing and leaves with what was on disk", async () => {
    const { area, onDone } = open("original\n");
    type(area(), "rascunho\n");
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByTestId("btn-page-discard"));
    await idle(5000);
    expect(puts).toHaveLength(0);
    expect(onDone.mock.calls[0][1]).toBe("original\n");
  });

  it("'Continuar editando' closes the review and changes nothing", async () => {
    const { area, onDone } = open("x\n");
    type(area(), "y\n");
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Continuar editando" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(area().value).toBe("y\n");
  });

  it("in a conflict there is no 'Salvar e sair': the 409 is never overwritten from here", async () => {
    conflict = true;
    const { area } = open("x\n");
    type(area(), "y\n");
    fireEvent.blur(area());
    await idle(100);
    expect(screen.getByText(/Vendas alterou esta página/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByTestId("btn-page-save-leave")).toBeNull();
    expect(within(dialog).getByTestId("btn-page-discard")).toBeTruthy();
    expect(puts).toHaveLength(1);
  });

  it("the diff is text: markup in either version is never drawn", async () => {
    const { area } = open("ok\n");
    type(area(), 'ok\n<img src=x onerror="alert(1)">\n');
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("'Ver o que mudei' appears only after a change and shows the same diff without leaving", async () => {
    const { area, onDone } = open("um\n");
    expect(screen.queryByTestId("btn-page-changes")).toBeNull();
    type(area(), "dois\n");
    fireEvent.click(screen.getByTestId("btn-page-changes"));
    expect(within(screen.getByRole("dialog")).getByRole("list", { name: /Diferenças/ }).textContent).toContain("dois");
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe("a barra e os atalhos", () => {
  const select = (ta: HTMLTextAreaElement, from: number, to: number) => { ta.focus(); ta.setSelectionRange(from, to); };

  it("seven buttons, by name, in a toolbar", () => {
    open("texto");
    const bar = screen.getByRole("toolbar", { name: "Formatação do texto" });
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Título", "Negrito", "Itálico", "Lista", "Citação", "Código", "Link"]);
  });

  it("Negrito wraps the selection, keeps it selected, and the autosave sends exactly that", async () => {
    const { area } = open("uma palavra aqui\n");
    select(area(), 4, 11);
    fireEvent.click(screen.getByRole("button", { name: "Negrito" }));
    expect(area().value).toBe("uma **palavra** aqui\n");
    expect([area().selectionStart, area().selectionEnd]).toEqual([4, 15]);
    await idle(3100);
    expect(puts).toHaveLength(1);
    expect(puts[0].content).toBe("uma **palavra** aqui\n");
  });

  it("each button inserts only what the renderer knows: título, itálico, lista, citação, código, link", () => {
    const { area } = open("alfa\n");
    const click = (name: string, from = 0, to = 4) => { select(area(), from, to); fireEvent.click(screen.getByRole("button", { name })); };
    click("Título", 2, 2); expect(area().value).toBe("## alfa\n");
    click("Título", 3, 3); expect(area().value).toBe("### alfa\n");
    click("Título", 3, 3); expect(area().value).toBe("alfa\n");
    click("Itálico"); expect(area().value).toBe("*alfa*\n");
    click("Itálico", 0, 6); expect(area().value).toBe("alfa\n");
    click("Lista", 0, 4); expect(area().value).toBe("- alfa\n");
    click("Lista", 0, 6); expect(area().value).toBe("alfa\n");
    click("Citação"); expect(area().value).toBe("> alfa\n");
    click("Citação", 0, 6); expect(area().value).toBe("alfa\n");
    click("Código"); expect(area().value).toBe("`alfa`\n");
    click("Código", 0, 6); expect(area().value).toBe("alfa\n");
    click("Link"); expect(area().value).toBe("[alfa](https://)\n");
    expect(area().value.slice(area().selectionStart, area().selectionEnd)).toBe("https://");
  });

  it("a button that would make Markdown the renderer draws wrong changes nothing", () => {
    const { area } = open("a*b\n");
    select(area(), 0, 3);
    fireEvent.click(screen.getByRole("button", { name: "Negrito" }));
    expect(area().value).toBe("a*b\n");
    expect(screen.queryByText("Não salvo ainda")).toBeNull();
  });

  it("a button does not take the focus or the selection from the text (mousedown is cancelled)", () => {
    open("texto");
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Negrito" }))).toBe(false);
  });

  it("a CRLF page keeps its line ending through a list made of several lines", async () => {
    const { area } = open("um\r\ndois\r\n");
    select(area(), 0, 8);
    fireEvent.click(screen.getByRole("button", { name: "Lista" }));
    expect(area().value).toBe("- um\n- dois\n");
    await idle(3100);
    expect(puts[0].content).toBe("- um\r\n- dois\r\n");
  });

  it("Ctrl+B, Ctrl+I, Ctrl+E, Ctrl+Shift+K, Ctrl+Shift+7 and Ctrl+Shift+. work in the text and are not the app's: the window never hears them", () => {
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    const { area } = open("alfa");
    const press = (init: KeyboardEventInit) => { select(area(), 0, 4); return fireEvent.keyDown(area(), init); };
    expect(press({ key: "b", ctrlKey: true })).toBe(false);
    expect(area().value).toBe("**alfa**");
    area().setSelectionRange(0, 8); fireEvent.keyDown(area(), { key: "b", ctrlKey: true });
    expect(area().value).toBe("alfa");
    press({ key: "i", ctrlKey: true, code: "KeyI" }); expect(area().value).toBe("*alfa*");
    area().setSelectionRange(0, 6); fireEvent.keyDown(area(), { key: "i", ctrlKey: true, code: "KeyI" });
    press({ key: "e", metaKey: true }); expect(area().value).toBe("`alfa`");
    area().setSelectionRange(0, 6); fireEvent.keyDown(area(), { key: "e", metaKey: true });
    press({ key: "K", ctrlKey: true, shiftKey: true, code: "KeyK" }); expect(area().value).toBe("[alfa](https://)");
    area().setSelectionRange(0, 16); fireEvent.keyDown(area(), { key: "K", ctrlKey: true, shiftKey: true, code: "KeyK" });
    press({ key: "&", ctrlKey: true, shiftKey: true, code: "Digit7" }); expect(area().value).toBe("- alfa");
    area().setSelectionRange(0, 6); fireEvent.keyDown(area(), { key: "&", ctrlKey: true, shiftKey: true, code: "Digit7" });
    press({ key: ">", ctrlKey: true, shiftKey: true, code: "Period" }); expect(area().value).toBe("> alfa");
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener("keydown", heard);
  });

  it("Ctrl+K stays the app's search: it writes nothing into the page and reaches the window", () => {
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    const { area } = open("alfa");
    area().setSelectionRange(0, 4);
    expect(fireEvent.keyDown(area(), { key: "k", ctrlKey: true, code: "KeyK" })).toBe(true);
    expect(area().value).toBe("alfa");
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", heard);
  });

  it("with the browser's insertText the change goes in as typing (so Ctrl+Z undoes it), and the selection lands on the formatted text", () => {
    const { area } = open("a x b");
    const exec = vi.fn((cmd: string, _ui: boolean, text?: string) => {
      const ta = area(), v = ta.value;
      ta.value = v.slice(0, ta.selectionStart) + (text ?? "") + v.slice(ta.selectionEnd);
      fireEvent.input(ta);
      return cmd === "insertText" || cmd === "delete";
    });
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    try {
      area().setSelectionRange(2, 3);
      fireEvent.click(screen.getByRole("button", { name: "Negrito" }));
      expect(exec).toHaveBeenCalledWith("insertText", false, "**x**");
      expect(area().value).toBe("a **x** b");
      expect([area().selectionStart, area().selectionEnd]).toEqual([2, 7]);
    } finally { delete (document as unknown as { execCommand?: unknown }).execCommand; }
  });
});

describe("a costura window.__LUVEBOT_EDITOR__", () => {
  const fake = () => {
    const state = { text: "", onChange: () => {}, md: "", destroyed: 0, getMarkdown: vi.fn(), element: null as HTMLElement | null };
    const seam: PageEditorSeam = { version: 1, mount: (element, { text, onChange }) => {
      state.text = text; state.onChange = onChange; state.element = element; state.md = text;
      element.textContent = "visual";
      return { getMarkdown: () => { state.getMarkdown(); return state.md; }, destroy: () => { state.destroyed++; } };
    } };
    return { seam, state };
  };

  it("with no library registered and no file in the build, nothing is loaded and the source editor is there", () => {
    open("texto");
    expect(document.head.querySelectorAll("script[src]")).toHaveLength(0);
    expect(screen.getByLabelText("Texto da página em Markdown")).toBeTruthy();
    expect(screen.queryByTestId("visual-editor")).toBeNull();
  });

  it("a registered editor takes the textarea's place, gets the page once with plain breaks, and is asked for the text only after onChange", async () => {
    const { seam, state } = fake(); window.__LUVEBOT_EDITOR__ = seam;
    open("# T\r\ntexto\r\n");
    expect(screen.queryByLabelText("Texto da página em Markdown")).toBeNull();
    expect(screen.queryByTestId("format-bar")).toBeNull();                         // its own UI, not the source toolbar
    expect(screen.getByTestId("visual-editor").textContent).toBe("visual");
    expect(state.text).toBe("# T\ntexto\n");
    await idle(10_000);
    expect(state.getMarkdown).not.toHaveBeenCalled();                              // R1: nothing is read, nothing is saved, without an edit
    expect(puts).toHaveLength(0);
    state.md = "# T\ntexto novo\n";                                                // and an editor that normalized on load changes nothing either
    act(() => state.onChange());
    await idle(3100);
    expect(state.getMarkdown).toHaveBeenCalledTimes(1);
    expect(puts).toHaveLength(1);
    expect(bytes(puts[0].content)).toBe(bytes("# T\r\ntexto novo\r\n"));            // the page's own line ending, written by the page editor
  });

  it("it is taken off the page when the editor closes", () => {
    const { seam, state } = fake(); window.__LUVEBOT_EDITOR__ = seam;
    open("x");
    cleanup();
    expect(state.destroyed).toBe(1);
  });

  it("an editor that cannot hold this page (it throws on mount) leaves the source editor", () => {
    window.__LUVEBOT_EDITOR__ = { version: 1, mount: () => { throw new Error("tabela suja"); } };
    open("| a |\n");
    expect(screen.getByLabelText("Texto da página em Markdown")).toBeTruthy();
    expect(screen.getByTestId("format-bar")).toBeTruthy();
  });

  it("leaving with changes shows the same diff", async () => {
    const { seam, state } = fake(); window.__LUVEBOT_EDITOR__ = seam;
    open("antes\n");
    state.md = "depois\n";
    act(() => state.onChange());
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    expect(within(screen.getByRole("dialog")).getByRole("list", { name: /Diferenças/ }).textContent).toContain("depois");
  });
});

describe("sair da tela com algo digitado (red team E1)", () => {
  it("leaving with an unsaved edit saves it on the way out, even within a second of the last save", async () => {
    const view = render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("a\n")} onDone={vi.fn()} />);
    const area = () => screen.getByLabelText("Texto da página em Markdown") as HTMLTextAreaElement;
    type(area(), "a\num\n");
    await idle(3100);
    type(area(), "a\num dois\n");
    view.unmount();
    await idle(100);
    expect(puts.map((p) => p.content)).toEqual(["a\num\n", "a\num dois\n"]);
  });

  it("leaving with nothing typed saves nothing", async () => {
    const view = render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("a\n")} onDone={vi.fn()} />);
    view.unmount();
    await idle(5000);
    expect(puts).toHaveLength(0);
  });

  it("'Sair sem salvar' drops what was typed: the screen going away does not save it after all", async () => {
    const onDone = vi.fn();
    const view = render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("original\n")} onDone={onDone} />);
    type(screen.getByLabelText("Texto da página em Markdown") as HTMLTextAreaElement, "rascunho\n");
    fireEvent.click(screen.getByRole("button", { name: "Concluir" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByTestId("btn-page-discard"));
    view.unmount();                                                         // what the reader does when onDone brings it back
    await idle(5000);
    expect(puts).toHaveLength(0);
  });

  it("in a conflict, leaving saves nothing (the 409 is never overwritten from here)", async () => {
    conflict = true;
    const view = render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("x\n")} onDone={vi.fn()} />);
    const ta = screen.getByLabelText("Texto da página em Markdown") as HTMLTextAreaElement;
    type(ta, "y\n");
    fireEvent.blur(ta);
    await idle(100);
    expect(puts).toHaveLength(1);
    view.unmount();
    await idle(5000);
    expect(puts).toHaveLength(1);
  });
});
