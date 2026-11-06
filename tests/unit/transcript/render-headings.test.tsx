// tests/unit/transcript/render-headings.test.tsx
// Headings in our safe renderer (Pages, T9.3): "#" to "###" become h2/h3/h4 and their text goes through the
// same safe inline as a paragraph. Hostile input in a heading or a quote stays text (RT3).
import React from "react";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Markdown } from "@/lib/render/markdown";

function expectInert(root: HTMLElement) {
  expect(root.querySelector("script,iframe,object,embed,style,img,svg,form,input")).toBeNull();
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      expect(/^on/i.test(a.name), `${el.tagName}[${a.name}]`).toBe(false);
      if (a.name === "href") expect(a.value).toMatch(/^(https?:|mailto:)/i);
    }
  }
}

describe("Markdown headings", () => {
  it("levels 1 to 3 become h2, h3, h4; a closing run of # is dropped", () => {
    const { container } = render(<Markdown text={"# Um\n## Dois ##\n### Três"} />);
    expect(container.querySelector("h2")?.textContent).toBe("Um");
    expect(container.querySelector("h3")?.textContent).toBe("Dois");
    expect(container.querySelector("h4")?.textContent).toBe("Três");
  });

  it("'#' with no space, '# ' alone and 4+ '#' stay text; level 4 is never a heading", () => {
    const { container } = render(<Markdown text={"#semespaco\n\n# \n\n#### Quatro\n\n####### Sete"} />);
    expect(container.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
    expect(container.textContent).toContain("#semespaco");
    expect(container.textContent).toContain("#### Quatro");
  });

  it("a heading ends the paragraph above it", () => {
    const { container } = render(<Markdown text={"texto\n## Seção\nmais texto"} />);
    expect(container.querySelector("h3")?.textContent).toBe("Seção");
    expect(Array.from(container.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["texto", "mais texto"]);
  });

  it("RT3: '# <script>' is text inside the heading", () => {
    const { container } = render(<Markdown text={"# <script>alert(1)</script>"} />);
    expect(container.querySelector("h2")?.textContent).toBe("<script>alert(1)</script>");
    expectInert(container);
  });

  it("RT3: a javascript: link in a heading is refused and shown as text; a safe one keeps the hardened <a>", () => {
    const { container } = render(<Markdown text={"## [x](javascript:alert(1))\n## [ok](https://example.com/a)"} />);
    const [bad, ok] = Array.from(container.querySelectorAll("h3"));
    expect(bad.querySelector("a")).toBeNull();
    expect(bad.textContent).toBe("[x](javascript:alert(1))");
    expect(ok.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(ok.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expectInert(container);
  });

  it("RT3: '> <img onerror>' is text inside the quote", () => {
    const { container } = render(<Markdown text={"> <img src=x onerror=alert(1)>"} />);
    expect(container.querySelector("blockquote")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expectInert(container);
  });

  // A backtracking heading regex must FAIL here, not hang CI: sizes stay small enough that even a quadratic
  // regex finishes in seconds (measured: ~45 ms at 3,000 characters, ~4.5 s at 30,000), and the limit is 1,500 ms.
  const fast = (text: string) => {
    const t0 = performance.now();
    render(<Markdown text={text} />);
    return performance.now() - t0;
  };
  it("a ~3,000-character heading line renders within 1,500 ms", () => {
    expect(fast("# a" + " ".repeat(3_000) + "b")).toBeLessThan(1500);
    expect(fast("# a" + " \t".repeat(1_500) + "b")).toBeLessThan(1500);
  });
  it("a 30,000-character heading line still renders within 1,500 ms (a quadratic regex fails this)", () => {
    expect(fast("# a" + " ".repeat(30_000) + "b")).toBeLessThan(1500);
    expect(fast("## x" + " #".repeat(15_000))).toBeLessThan(1500);
  });
});
