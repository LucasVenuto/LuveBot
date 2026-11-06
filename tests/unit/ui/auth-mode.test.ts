// tests/unit/ui/auth-mode.test.ts (contract v0.11 5.1)
// Who is at the other end of the dashboard: only `gated` is a person with a login. `loopback` has none and `deployment` is the deployment token of Hermes main, a machine; both read and tighten, neither decides.
// The screens ask this of what a session ANSWERED (`noLoginOf`) and the server's rule is the screen's: anything that is not `gated` is closed, a value nobody knows included, and the machine gets its own words.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { noLoginOf } from "@/lib/authMode";
import { approvalErrorText } from "@/components/approvals/decide";
import { ApiError } from "@/api/client";
import { translations } from "@/i18n";

const pt = (k: string) => (translations.pt as Record<string, string>)[k];

describe("noLoginOf: only `gated` is a person", () => {
  it("gated is a person; loopback is no login; deployment is the machine", () => {
    expect(noLoginOf("gated")).toBeNull();
    expect(noLoginOf("loopback")).toBe("loopback");
    expect(noLoginOf("deployment")).toBe("deployment");
  });

  it("a mode nobody knows is closed as the machine, whatever it is: a newer server's word, a typo, the wrong case, an empty string, nothing, another type", () => {
    for (const mode of ["service", "GATED", "Gated", " gated", "gated ", "", "None", "null", undefined, null, 0, 1, true, false, {}, [], ["gated"]]) {
      expect(noLoginOf(mode), JSON.stringify(mode) ?? String(mode)).toBe("deployment");
    }
  });

  it("the case of `loopback` is not folded either: 'LOOPBACK' is not the no-login mode, it is an unknown one (the machine's words)", () => {
    expect(noLoginOf("LOOPBACK")).toBe("deployment");
  });
});

describe("no screen decides 'no login' by comparing the mode with 'loopback'", () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  it("`auth_mode === \"loopback\"` and `authMode === \"loopback\"` appear nowhere in dashboard/src: a third mode would fall on the side of the person (the Lume's F-DT5)", () => {
    const hits = files(path.join(process.cwd(), "dashboard/src")).filter((f) => /auth_?[mM]ode\s*[!=]==?\s*["']loopback["']/.test(fs.readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});

describe("a refused decision: the machine's words are not the loopback words", () => {
  const t = pt as (k: never) => string;
  const refused = (code: string, status = 403) => new ApiError({ code, message: "x", status });

  it("credential_not_human is the credential's sentence", () => {
    expect(approvalErrorText(refused("credential_not_human"), t as never)).toEqual({ text: translations.pt.errCredentialNotHuman, code: "credential_not_human" });
  });

  it("and names the provider the server refused, in the technical detail (DT-1b)", () => {
    const named = new ApiError({ code: "credential_not_human", message: "x", status: 403, details: { provider: "acme" } });
    expect(approvalErrorText(named, t as never)).toEqual({ text: translations.pt.errCredentialNotHuman, code: "credential_not_human (acme)" });
  });

  it("loopback_not_human, and any other 403, stay the loopback sentence as before", () => {
    expect(approvalErrorText(refused("loopback_not_human"), t as never)).toBe(translations.pt.errorLoopbackApprovalBlocked);
    expect(approvalErrorText(refused("something_else"), t as never)).toBe(translations.pt.errorLoopbackApprovalBlocked);
  });
});
