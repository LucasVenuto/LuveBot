// tests/unit/redteam/g3-hostile-approval.test.tsx
// Red team 3, gap G3.1 (docs/redteam/2026-10-02.md): a command and a description that carry hostile markup reach the person
// as TEXT on the three places an approval is shown: the inbox card, its "Ver parâmetros" modal and the card in the conversation.
// Nothing executes, no element and no on* attribute is born from the text, and the text stays readable.
// Mutations: each surface rendering the text as HTML, made on a temporary copy of dashboard/src (the real tree is never touched).
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import * as realInbox from "@/components/approvals";
import * as realInline from "@/components/chat/InlineApproval";
import * as realClient from "@/api/client";
import { parseSse } from "@/components/transcript";

const HOSTILE = '<img src=x onerror="globalThis.__g3=1"><script>globalThis.__g3=1</script><svg onload="globalThis.__g3=1"></svg>'
  + '<a href="javascript:globalThis.__g3=1">ok</a><iframe srcdoc="<script>globalThis.__g3=1</script>"></iframe>';
const COMMAND = `curl https://x.test/ ${HOSTILE}`;
const DESCRIPTION = `Leia antes: ${HOSTILE}`;
const SRC = path.resolve(__dirname, "../../../dashboard/src");
const FRAME = parseSse(readFileSync(path.resolve(__dirname, "../../contract/frames/run/approval.request.sse"), "utf8"));

type Lib = { ApprovalsInbox: any; InlineApproval: any; client: typeof realClient };
const REAL: Lib = { ApprovalsInbox: realInbox.ApprovalsInbox, InlineApproval: realInline.InlineApproval, client: realClient };

const approval = {
  request_id: "req-g3", bot: "vendas", surface: "run", mechanism: "hook_approve", source: "run", run_id: "run_g3",
  digest: "d".repeat(64), command_redacted: COMMAND, description: DESCRIPTION, pattern_keys: [], allowed_choices: ["once", "deny"],
  action_class_hash: "h", created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), status: "pending",
};
const bots = [{ name: "vendas", is_default: false, display: { label: "Vendas", color: "#60a5fa", avatar: { kind: "emoji", value: "💼" } }, status: "idle" }];

function backend(client: Lib["client"]) {
  client.resetCsrfToken();
  client.setCustomFetchJSON(async (url: string) => {
    if (url.endsWith("/session")) return { csrf: "c", actor: "tester", auth_mode: "gated" };
    if (url.includes("/approvals")) return { ok: true, approvals: [approval], total: 1 };
    if (url.includes("/rules")) return { rules: [] };
    return {};
  });
}

/** Inert: no executable element or on* attribute anywhere in the document, nothing ran, and `where` reads the payload as text. */
function inert(where: Element) {
  expect((globalThis as any).__g3).toBeUndefined();
  expect(document.querySelectorAll("script, iframe, object, embed, img[src='x'], a[href^='javascript' i]")).toHaveLength(0);
  const onAttrs = [...document.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${el.tagName}[${a.name}]`));
  expect(onAttrs).toEqual([]);
  expect(where.textContent).toContain(HOSTILE);
}

async function checks(lib: Lib) {
  backend(lib.client);
  const inbox = render(<lib.ApprovalsInbox bots={bots} authMode="gated" />);
  await waitFor(() => expect(inbox.container.textContent).toContain("curl https://x.test/"));
  inert(inbox.container.querySelector("code") ?? inbox.container);                      // the inbox card shows the command as text
  expect(inbox.container.textContent).toContain(DESCRIPTION);                            // and the description
  fireEvent.click(screen.getByText("Ver parâmetros"));
  const dialog = await screen.findByRole("dialog");
  inert(dialog);                                                                         // the modal: command and description as text
  expect(dialog.textContent).toContain(DESCRIPTION);
  cleanup();

  backend(lib.client);
  const frame = { ...FRAME, command: COMMAND, description: DESCRIPTION, request_id: "req-g3", luvebot_digest: "dg" };
  const inline = render(<lib.InlineApproval frame={frame} bot="vendas" runId="run_g3" pending />);
  await waitFor(() => expect(inline.container.querySelector("pre")?.textContent).toContain("curl https://x.test/"));
  inert(inline.container.querySelector("pre")!);                                        // the conversation card's preview
  expect(inline.container.textContent).toContain(DESCRIPTION);                          // the description, in the technical detail
  cleanup();
}

/** A copy of dashboard/src with one edit, under the repository (so `react` resolves), loaded as modules of its own. */
async function mutant(file: string, old: string, edit: string): Promise<Lib> {
  const dir = fs.mkdtempSync(path.join(__dirname, ".g3-mutant-"));
  fs.cpSync(SRC, dir, { recursive: true });
  const target = path.join(dir, file);
  const text = fs.readFileSync(target, "utf8");
  expect(text.split(old).length - 1).toBe(1);                                          // the anchor is still there, exactly once
  fs.writeFileSync(target, text.replace(old, edit));
  copies.push(dir);
  return {
    ApprovalsInbox: (await import(path.join(dir, "components/approvals/index.ts"))).ApprovalsInbox,
    InlineApproval: (await import(path.join(dir, "components/chat/InlineApproval.tsx"))).InlineApproval,
    client: await import(path.join(dir, "api/client.ts")),
  };
}
const copies: string[] = [];

beforeEach(() => { cleanup(); delete (globalThis as any).__g3; });
afterEach(() => { cleanup(); for (const dir of copies.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("G3.1: hostile markup in an approval is text on every surface", () => {
  it("the inbox card, the Ver parâmetros modal and the conversation card render it inert and readable", async () => {
    await checks(REAL);
  });

  const MUTATIONS: [string, string, string, string][] = [
    ["the inbox card renders the command as HTML", "components/approvals/ApprovalsInbox.tsx",
      "<code>{item.command_redacted}</code>", "<code dangerouslySetInnerHTML={{ __html: item.command_redacted }} />"],
    ["the modal renders the command as HTML", "components/approvals/ApprovalsInbox.tsx",
      '<strong>{t("editModalCommandLabel")}</strong> {editModalItem.command_redacted}',
      '<strong>{t("editModalCommandLabel")}</strong> <span dangerouslySetInnerHTML={{ __html: editModalItem.command_redacted }} />'],
    ["the conversation card renders the preview as HTML", "components/chat/InlineApproval.tsx",
      'fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{human.preview}</pre>',
      'fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} dangerouslySetInnerHTML={{ __html: human.preview }} />'],
  ];
  for (const [label, file, old, edit] of MUTATIONS) {
    it(`mutation is caught: ${label}`, async () => {
      const lib = await mutant(file, old, edit);                                         // outside the expect: the edit must apply
      await expect(checks(lib)).rejects.toThrow();
    });
  }
});
