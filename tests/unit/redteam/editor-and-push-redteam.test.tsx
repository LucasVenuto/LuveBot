// tests/unit/redteam/editor-and-push-redteam.test.tsx
// Red team (Lume, 30/10) of the page editor (640948e) and of the worker's tap (3c1a17d). Each FINDING is `it.fails`: it passes today BECAUSE the
// expectation does not hold, and turns red the day the defect is fixed (then the `.fails` goes away). The controls are plain `it`: they prove the
// scenario is valid, so a `.fails` is about the defect and not about the setup.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PageEditor } from "@/components/pages/PageEditor";
import { lineDiff } from "@/components/pages/pages";
import { openTarget } from "@/pwa/push";
import { resetCsrfToken, setCustomFetchJSON } from "@/api/client";
import { setLuveLocale } from "@/i18n";
import type { PageWithContent } from "@/api/types";
import type { PageEditorSeam } from "@/editor/api";

const SHA1 = "a".repeat(64), SHA2 = "b".repeat(64);
const pageOf = (content: string): PageWithContent => ({
  slug: "proposta", title: "Proposta", excerpt: "", size: content.length, mtime: "2026-10-01T14:00:00Z", sha: SHA1, rev: 1, author: "bot",
  author_label: "Vendas", by_you: false, editable: true, content, redacted: false,
} as PageWithContent);

let puts: { content: string; base_sha: string }[];
beforeEach(() => {
  cleanup(); setLuveLocale("pt"); resetCsrfToken(); puts = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setCustomFetchJSON(async (url, init) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "x", auth_mode: "gated" };
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      return { page: { ...pageOf(body.content), sha: SHA2, rev: 2 }, changed: true };
    }
    return {};
  });
});
afterEach(() => { vi.useRealTimers(); setCustomFetchJSON(null); delete window.__LUVEBOT_EDITOR__; });

const idle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const area = () => screen.getByLabelText("Texto da página em Markdown") as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(area(), { target: { value } });

describe("editor: an edit made right after an autosave", () => {
  // The pace rule (one save per second) turns a save asked within 1 s of the last one into a TIMER; leaving the screen clears every timer.
  async function scenario(leave: boolean) {
    const view = render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("a\n")} onDone={vi.fn()} />);
    type("a\num\n");
    await idle(3200);                                  // the 3 s idle autosave: PUT #1
    expect(puts.map((p) => p.content)).toEqual(["a\num\n"]);
    type("a\num dois\n");                              // typed right after the save...
    fireEvent.blur(area());                            // ...and the person clicks another Bot: blur asks for a save, 1 s has not passed
    if (leave) view.unmount();
    await idle(5000);
    return puts.map((p) => p.content);
  }
  it("control: the person stays, the second edit is saved a second later", async () => {
    expect(await scenario(false)).toEqual(["a\num\n", "a\num dois\n"]);
  });
  it("FINDING (Média), fixed: the person leaves within that second, and the edit is saved on the way out", async () => {
    expect(await scenario(true)).toEqual(["a\num\n", "a\num dois\n"]);
  });
});

describe("editor: the diff of a page with a huge number of lines", () => {
  it("control: an ordinary page is compared", () => {
    expect(lineDiff("a\nb\n", "a\nc\n")?.map((l) => l.kind)).toEqual(["same", "del", "add", "same"]);
  });
  // lineDiff caps n*m (4M cells) but not n or m alone: a page of N empty lines against ONE line has n*m = N, under the cap, and costs N typed arrays
  // plus N rows for DiffView (a 1 MB page, the limit, is 1,000,000 empty lines: measured 445 ms and +347 MB in node; a million <li> in the tab).
  it("FINDING (Média), fixed: a page of 100,000 empty lines is not compared line by line (refused, or cut)", () => {
    const d = lineDiff("\n".repeat(100_000), "x");
    expect(d === null || d.length <= 20_000).toBe(true);
  });
});

describe("editor: the visual-editor seam (no library today)", () => {
  // api.d.ts: onChange "fires after an edit by the person, never on mount". The host trusts it: a seam that fires on its own (a normalization after an
  // async init) makes the page autosave without any person input, breaking R1 ("never without an edit").
  it.fails("FINDING (Baixa, hardening): a seam that calls onChange by itself does not make the page save", async () => {
    const seam: PageEditorSeam = {
      version: 1,
      mount: (_el, { onChange }) => { setTimeout(onChange, 100); return { getMarkdown: () => "# normalizado\n", destroy: () => undefined }; },
    };
    window.__LUVEBOT_EDITOR__ = seam;
    render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("# original\n")} onDone={vi.fn()} />);
    await idle(10_000);
    expect(puts).toHaveLength(0);
  });
  it("control: with no seam registered the source editor is there and nothing is created", async () => {
    const before = document.head.querySelectorAll("script").length;
    render(<PageEditor bot="vendas" botLabel="Vendas" page={pageOf("# original\n")} onDone={vi.fn()} />);
    await idle(5000);
    expect(area().value).toBe("# original\n");
    expect(document.head.querySelectorAll("script").length).toBe(before);
    expect(puts).toHaveLength(0);
  });
});

describe("worker: which window a tap on the notification goes to", () => {
  const win = (url: string) => ({ url, focus: vi.fn(async () => undefined), postMessage: vi.fn() });
  const clientsOf = (list: ReturnType<typeof win>[]) => ({ matchAll: async () => list, openWindow: vi.fn(async () => undefined) });

  it("control: LuveBot's own window is focused and told", async () => {
    const luve = win("https://h.example/"), c = clientsOf([luve]);
    await openTarget(c, "https://h.example", "", { target: "costs" });
    expect(luve.focus).toHaveBeenCalled();
    expect(luve.postMessage).toHaveBeenCalledWith({ type: "luvebot.open", target: "costs" });
  });
  // N1 (fixed): home is `${origin}${basePath}/`; with the dashboard at the root EVERY window of the origin starts with it (/logs, /sessions...), and the first one may be a
  // Hermes page that never listens for "luvebot.open". Only the plugin's home page itself counts as LuveBot's window now.
  it("another dashboard window listed first does not take the tap away from LuveBot's own (red team N1, fixed)", async () => {
    const logs = win("https://h.example/logs"), luve = win("https://h.example/"), c = clientsOf([logs, luve]);
    await openTarget(c, "https://h.example", "", { target: "approvals" });
    expect(luve.postMessage).toHaveBeenCalledWith({ type: "luvebot.open", target: "approvals" });
    expect(logs.postMessage).not.toHaveBeenCalled();
  });
  it("what is NOT a place stays out: the tap's data is a whitelist, never an address", async () => {
    const c = clientsOf([]);
    await openTarget(c, "https://h.example", "", { target: "javascript:alert(1)", url: "https://evil.example/" });
    expect(c.openWindow).toHaveBeenCalledWith("https://h.example/?luvebot=approvals");
  });
});
