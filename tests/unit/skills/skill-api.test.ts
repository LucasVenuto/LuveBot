// tests/unit/skills/skill-api.test.ts
// The calls of the "teach a skill" flow (contract v0.11 3): the exact requests, CSRF on every one, and the refusal's `why` kept beside `details` (a `skill_invalid` is explained by its why; without it the screen could
// only say "refused").
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ApiError, createSkill, editSkill, previewSkill, requestSkillDraft, resetCsrfToken, setCustomFetchJSON } from "@/api/client";

type Call = { method: string; url: string; body: any; csrf: string | null };
function world(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  setCustomFetchJSON(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/session")) return { csrf: "csrf-1", actor: "basic:ceo", auth_mode: "gated" };
    const call = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined, csrf: new Headers(init?.headers).get("X-LuveBot-CSRF") };
    calls.push(call);
    return answer(call);
  });
  return calls;
}
beforeEach(() => resetCsrfToken());
afterEach(() => setCustomFetchJSON(null));

describe("the requests", () => {
  it("the draft: POST /bots/{bot}/skills/draft with exactly the session and the note, with the CSRF", async () => {
    const calls = world(() => ({ run: { id: "r1", status: "started", bot: "vendas", session_id: "s1" } }));
    const made = await requestSkillDraft("vendas", { session_id: "s1", note: "como enviar o relatório" });
    expect(made.run?.id).toBe("r1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", csrf: "csrf-1", body: { session_id: "s1", note: "como enviar o relatório" } });
    expect(calls[0].url).toMatch(/\/bots\/vendas\/skills\/draft$/);
    await requestSkillDraft("vendas", { session_id: "s1" });
    expect(calls[1].body).toEqual({ session_id: "s1" });                                       // no note key at all when there is none
  });

  it("the dry run and the creation are the same route and differ ONLY by dry_run; the edit is a PUT of content and the digest it loaded", async () => {
    const calls = world(() => ({ name: "n", skill: { name: "n" }, enabled: false, scan: null }));
    await previewSkill("vendas", { name: "send-report", category: "ops", content: "---\n---\nx" });
    await createSkill("vendas", { name: "send-report", content: "---\n---\nx" });
    await editSkill("vendas", "send-report", { content: "new", expected_digest: "d1" });
    expect(calls.map((x) => `${x.method} ${x.url.replace(/^.*\/api\/plugins\/luvebot/, "")}`)).toEqual(["POST /bots/vendas/skills", "POST /bots/vendas/skills", "PUT /bots/vendas/skills/send-report/content"]);
    expect(calls[0].body).toEqual({ name: "send-report", category: "ops", content: "---\n---\nx", dry_run: true });
    expect(calls[1].body).toEqual({ name: "send-report", content: "---\n---\nx", dry_run: false });
    expect(calls[2].body).toEqual({ content: "new", expected_digest: "d1" });
    expect(calls.every((x) => x.csrf === "csrf-1")).toBe(true);
  });
});

describe("a refusal keeps its why", () => {
  const refuse = (error: Record<string, unknown>, status = 422) => () => { throw { status, body: JSON.stringify({ error: { message: "English for developers", request_id: "req_1", ...error } }) }; };

  it("skill_invalid: why (a word of the closed list) and details (the place or the number) both arrive", async () => {
    world(refuse({ code: "skill_invalid", why: "description_too_long", details: { limit: 60 } }));
    const e = await previewSkill("vendas", { name: "n", content: "c" }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("skill_invalid");
    expect(e.why).toBe("description_too_long");
    expect(e.details).toEqual({ limit: 60 });
    world(refuse({ code: "skill_invalid", why: "hidden_characters", details: { code: "U+E0041", line: 3, column: 9 } }));
    const h = await previewSkill("vendas", { name: "n", content: "c" }).catch((x) => x);
    expect(h.why).toBe("hidden_characters");
    expect(h.details).toEqual({ code: "U+E0041", line: 3, column: 9 });
  });

  it("an error with no why has none, and a why that is not text is dropped", async () => {
    world(refuse({ code: "skill_exists" }, 409));
    expect(((await createSkill("vendas", { name: "n", content: "c" }).catch((x) => x)) as ApiError).why).toBeUndefined();
    world(refuse({ code: "skill_invalid", why: { nested: true } }));
    expect(((await createSkill("vendas", { name: "n", content: "c" }).catch((x) => x)) as ApiError).why).toBeUndefined();
  });
});
