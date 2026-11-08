// tests/unit/skills/matrix-truncated.test.tsx
// 2nd cross review F6: GET /skills/matrix keeps 50 Bots and 500 skills and used to cut in silence, so the table looked complete. The screen says it:
// by the server's `truncated` flag when there is one (it is the truth, either way), and, for an older backend with none, when a list sits exactly at the limit.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, configure } from "@testing-library/react";
import { SkillsMatrixView, MATRIX_LIMITS } from "@/components/skills/SkillsView";
import { setCustomFetchJSON, resetCsrfToken } from "@/api/client";
import { setLuveLocale } from "@/i18n";

// A test waits for a state with findBy/waitFor and moves on the moment it holds; these ceilings only matter on a loaded machine (the CEO's
// reached load 240): the default 1 s per wait and 5 s per test are about the machine, not about what the test proves. (The old-backend test draws
// a table of 499 skills: in the whole suite at once it ran past the 5 s.)
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const matrix = (nBots: number, nSkills: number, truncated?: { bots: boolean; skills: boolean }) => ({
  bots: Array.from({ length: nBots }, (_, i) => ({ bot: `b${i}` })).map((b) => b.bot),
  skills: Array.from({ length: nSkills }, (_, i) => ({ name: `s${i}`, provenance: "bundled" })),
  cells: [], ...(truncated ? { truncated } : {}),
});
const show = async (m: unknown) => {
  setCustomFetchJSON(async (url: string) => (url.endsWith("/session") ? { csrf: "c", actor: "dashboard", auth_mode: "gated" } : url.includes("/skills/matrix") ? m : {}));
  render(<SkillsMatrixView bots={[]} />);
  await screen.findByRole("table");
};
beforeEach(() => { cleanup(); resetCsrfToken(); setLuveLocale("pt"); });
afterEach(() => { setCustomFetchJSON(null); setLuveLocale("pt"); });

describe("a matrix that was cut says so", () => {
  it("the server's flag: Bots, skills or both are named with the number kept", async () => {
    expect(MATRIX_LIMITS).toEqual({ bots: 50, skills: 500 });
    await show(matrix(3, 3, { bots: true, skills: false }));
    expect(screen.getByTestId("matrix-truncated").textContent).toBe("Mostrando só os primeiros 50 Bots; pode haver mais.");
    cleanup();
    await show(matrix(3, 3, { bots: false, skills: true }));
    expect(screen.getByTestId("matrix-truncated").textContent).toBe("Mostrando só as primeiras 500 skills; pode haver mais.");
    cleanup();
    await show(matrix(3, 3, { bots: true, skills: true }));
    expect(screen.getByTestId("matrix-truncated").textContent).toContain("50 Bots");
    expect(screen.getByTestId("matrix-truncated").textContent).toContain("500 skills");
  });

  it("the server's word wins both ways: false at the limit says nothing", async () => {
    await show(matrix(50, 500, { bots: false, skills: false }));
    expect(screen.queryByTestId("matrix-truncated")).toBeNull();
  });

  it("an older backend (no flag): a list exactly at the limit may have been cut and says so; below it, nothing", async () => {
    await show(matrix(50, 2));
    expect(screen.getByTestId("matrix-truncated").textContent).toBe("Mostrando só os primeiros 50 Bots; pode haver mais.");
    cleanup();
    await show(matrix(49, 499));
    expect(screen.queryByTestId("matrix-truncated")).toBeNull();
  });

  it("in English", async () => {
    setLuveLocale("en");
    await show(matrix(3, 3, { bots: false, skills: true }));
    expect(screen.getByTestId("matrix-truncated").textContent).toBe("Showing only the first 500 skills; there may be more.");
  });
});
