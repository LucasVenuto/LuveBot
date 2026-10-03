// tests/unit/transcript/render-safety.test.tsx
// Defensive tests for our own renderer (threat model T9/T14): untrusted agent text must become TEXT.
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown, safeHref } from "@/lib/render/markdown";

const HOSTILE_SCHEMES = [
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  " javascript:alert(1)",
  "\tjava\nscript:alert(1)",
  "java\u0000script:alert(1)",
  "&#106;avascript:alert(1)",
  "jav&#x61;script:alert(1)",
  "%6Aavascript:alert(1)",
  " javascript:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "DATA:text/html;base64,PHNjcmlwdD4=",
  "file:///etc/passwd",
  "//evil.example/x",
];

function unsafeAttrs(root: HTMLElement) {
  const bad: string[] = [];
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) bad.push(`${el.tagName}[${a.name}]`);
      if (["href", "src", "xlink:href", "action", "formaction"].includes(a.name) &&
          !/^(https?:|mailto:)/i.test(a.value)) bad.push(`${el.tagName}[${a.name}=${a.value}]`);
    }
  }
  return bad;
}

function expectInert(container: HTMLElement) {
  expect(container.querySelector("script,iframe,object,embed,style,img,svg,form,input")).toBeNull();
  expect(unsafeAttrs(container)).toEqual([]);
}

describe("Markdown: markup from the agent stays text", () => {
  it("<script> tag is shown as text", () => {
    const { container } = render(<Markdown text={"oi <script>window.__pwn=1</script> fim"} />);
    expectInert(container);
    expect(container.textContent).toContain("<script>window.__pwn=1</script>");
    expect((window as any).__pwn).toBeUndefined();
  });

  it("<img onerror> is shown as text", () => {
    const { container } = render(<Markdown text={'<img src=x onerror="window.__pwn=1">'} />);
    expectInert(container);
    expect(container.textContent).toContain("onerror=");
  });

  it("inline HTML inside bold/code/quote/list/fence stays text", () => {
    const text = [
      "**<b onclick=1>x</b>**", "`<script>`", "> <iframe src=//e>", "- <svg onload=1>",
      "```", "<script>1</script>", "```",
    ].join("\n");
    const { container } = render(<Markdown text={text} />);
    expectInert(container);
  });

  it.each(HOSTILE_SCHEMES)("link with %j becomes text, not <a>", (url) => {
    const { container } = render(<Markdown text={`[clique](${url})`} />);
    expect(container.querySelector("a")).toBeNull();
    expectInert(container);
    expect(container.textContent).toContain("[clique](");
    expect(safeHref(url)).toBeNull();
  });

  it("safe links keep a hardened <a>", () => {
    const { container } = render(<Markdown text="[ok](https://example.com/a?b=1) e [m](mailto:a@b.co)" />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/a?b=1", "mailto:a@b.co"]);
    for (const a of links) {
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.getAttribute("target")).toBe("_blank");
    }
    expect(unsafeAttrs(container)).toEqual([]);
  });

  it("pathological input is bounded and does not hang", () => {
    const t0 = Date.now();
    const { container } = render(<Markdown text={"[".repeat(50_000) + "*".repeat(50_000)} />);
    expect(Date.now() - t0).toBeLessThan(5000);
    expectInert(container);
  });
});
