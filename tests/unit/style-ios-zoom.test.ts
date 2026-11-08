// tests/unit/style-ios-zoom.test.ts
// The CEO's iPhone: touching the message field zoomed the page and he needed a pinch to come back. iOS Safari zooms when a text field with a font under 16px gets the focus. The guarantee: on a phone (a narrow window or a
// touch screen), EVERY text field of LuveBot (input, textarea, select) has a font-size of 16px, whatever its own rule, class or inline style says, WITHOUT turning off the zoom of accessibility (the viewport is never locked).
// jsdom does not evaluate media queries, so the proof is on the stylesheet itself (parsed here, rule by rule) plus a scan of the sources.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NARROW } from "@/hooks/useNarrow";

const ROOT = path.resolve(__dirname, "../..");
const CSS = fs.readFileSync(path.join(ROOT, "dashboard/src/style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Block { prelude: string; body: string }
/** The blocks at the top of a stylesheet (and, for an at-rule, its inner blocks): a prelude and what is between its braces. */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i), semi = css.indexOf(";", i);
    if (open === -1) break;
    if (semi !== -1 && semi < open) { i = semi + 1; continue; }   // an @import and the like
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) { if (css[j] === "{") depth++; else if (css[j] === "}") depth--; j++; }
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}
const splitSelectors = (list: string) => {
  const parts: string[] = []; let depth = 0, cur = "";
  for (const ch of list) { if (ch === "(" || ch === "[") depth++; if (ch === ")" || ch === "]") depth--; if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch; }
  return [...parts, cur.trim()].filter(Boolean);
};

const PHONE = blocks(CSS).filter((x) => x.prelude.startsWith("@media") && x.prelude.includes(NARROW) && x.prelude.includes("(pointer: coarse)"));
const FIELD_RULE = PHONE.flatMap((m) => blocks(m.body)).find((r) => /font-size:\s*16px\s*!important/.test(r.body) && /textarea/.test(r.prelude));
const SELECTORS = FIELD_RULE ? splitSelectors(FIELD_RULE.prelude) : [];
const TYPING = ["text", "search", "number", "password", "email", "url", "tel", "date", "time", "datetime-local", "month", "week"];
const NO_TYPING = ["checkbox", "radio", "range", "button", "submit", "reset", "file", "color", "image", "hidden"];
const excluded = (SELECTORS.find((s) => /\binput\b/.test(s)) ?? "").match(/:not\(\[type="([a-z-]+)"\]\)/g)?.map((x) => /"([a-z-]+)"/.exec(x)?.[1] as string) ?? [];

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "__pycache__", ".git"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out); else if (/\.(tsx?|css|json|py|html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("on a phone every text field is 16px (iOS does not zoom on focus)", () => {
  it("one rule, in the phone media query the stylesheet already uses (a narrow window OR a touch screen), says font-size: 16px !important", () => {
    expect(PHONE.length).toBeGreaterThan(0);
    expect(FIELD_RULE, "no rule with font-size: 16px !important for the fields in the phone media query").toBeDefined();
    expect(NARROW).toBe("(max-width: 767px)");
  });
  it("it covers input, textarea and select, each inside LuveBot's own root (the Hermes pages are not touched)", () => {
    expect(SELECTORS).toHaveLength(3);
    expect(SELECTORS.some((s) => /^\.lb-root input\b/.test(s))).toBe(true);
    expect(SELECTORS).toContain(".lb-root textarea");
    expect(SELECTORS).toContain(".lb-root select");
    for (const s of SELECTORS) expect(s.startsWith(".lb-root ")).toBe(true);
  });
  it("it is `!important`: that is what lets one rule beat an inline fontSize and a utility class on any of the ~110 fields", () => {
    expect(FIELD_RULE?.body.trim()).toBe("font-size: 16px !important;");
  });
  it("only fields that take no typing are left out of the input rule, and no typing type is", () => {
    expect(excluded.length).toBeGreaterThan(0);
    for (const t of excluded) expect(NO_TYPING, `"${t}" takes typing and must be 16px`).toContain(t);
    for (const t of TYPING) expect(excluded).not.toContain(t);
    for (const t of ["checkbox", "radio", "range", "file", "color"]) expect(excluded).toContain(t);
  });
  it("every `type` that an <input> of the sources uses is either typing (so 16px) or one of the left-out kinds: nothing new slips through", () => {
    const used = new Set<string>();
    for (const f of files(path.join(ROOT, "dashboard")).filter((p) => /\.tsx$/.test(p))) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/<input\b[^>]*?\btype="([a-z-]+)"/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const t of used) expect([...TYPING, ...NO_TYPING], `an <input type="${t}"> that this test does not know: say whether it takes typing`).toContain(t);
    for (const t of used) if (TYPING.includes(t)) expect(excluded).not.toContain(t);
  });
  it("no other rule of the stylesheet sets an `!important` font-size on a field (it would beat the 16px)", () => {
    const rest = blocks(CSS).flatMap((b) => (b.prelude.startsWith("@") ? blocks(b.body) : [b])).filter((r) => !(FIELD_RULE && r.prelude === FIELD_RULE.prelude && r.body === FIELD_RULE.body));
    const clashes = rest.filter((r) => /font(-size)?:[^;]*\d+px[^;]*!important/.test(r.body) && /\b(input|textarea|select)\b|lb-input|lb-field|lb-textarea/.test(r.prelude));
    expect(clashes.map((r) => r.prelude)).toEqual([]);
  });
});

describe("the zoom of accessibility stays", () => {
  it("nothing in the front end or the plugin locks the viewport: no maximum-scale, no minimum-scale, no user-scalable", () => {
    const bad: string[] = [];
    for (const dir of ["dashboard", "hermes-plugin", "scripts"]) {
      const full = path.join(ROOT, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of files(full)) if (/maximum-scale|minimum-scale|user-scalable/i.test(fs.readFileSync(f, "utf8"))) bad.push(path.relative(ROOT, f));
    }
    expect(bad).toEqual([]);
  });
  it("and the rule changes the size of the TEXT only: no `touch-action: none`, no `zoom`, no `transform` on the fields", () => {
    expect(FIELD_RULE?.body).not.toMatch(/touch-action|zoom|transform|maximum/);
  });
});
