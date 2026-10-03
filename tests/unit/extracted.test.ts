// tests/unit/extracted.test.ts
// The pure modules pulled out of the views (T7.1 F0). They hold the safety rules the new shell will reuse,
// so each rule is pinned here, apart from any markup.
import { describe, it, expect } from "vitest";
import type { Approval, Handoff, RuleWithSeal, RoomMember } from "@/api/types";
import { onceRequest, alwaysRequest, denyRequest, mixedActionClass, batchItems } from "@/components/approvals/decide";
import { sealVariant, filterRules } from "@/components/rules/seal";
import { mentionAt, offersAll, matchingMembers, isMultiTarget, insertMention } from "@/components/rooms/mentions";
import { needsYou, upcomingRoutines, activeBotCount } from "@/components/home/derive";

const appr = (id: string, cls = "c1", extra: Partial<Approval> = {}): Approval => ({
  request_id: id, bot: "vendas", source: "run", digest: `d-${id}`, allowed_choices: ["once", "deny"],
  action_class_hash: cls, created_at: "2026-10-01T10:00:00Z", expires_at: "2026-10-01T11:00:00Z", status: "pending", ...extra,
});

describe("approvals/decide (invariant 6)", () => {
  it("'Sempre permitir' resolves once with a draft rule, never 'always'", () => {
    const body = alwaysRequest(appr("a"), "Permitir crm_read");
    expect(body).toEqual({ digest: "d-a", choice: "once", draft_rule: { label: "Permitir crm_read", level: "allow" } });
    expect(JSON.stringify(body)).not.toContain("always");
    expect(onceRequest(appr("a"))).toEqual({ digest: "d-a", choice: "once" });
  });

  it("deny needs a non-blank reason, trimmed", () => {
    expect(denyRequest(appr("a"), "   ")).toBeNull();
    expect(denyRequest(appr("a"), "  fora do horário ")).toEqual({ digest: "d-a", choice: "deny", reason: "fora do horário" });
  });

  it("a batch is refused for mixed action classes or a deny without reason", () => {
    expect(mixedActionClass([appr("a")])).toBe(false);
    expect(mixedActionClass([appr("a"), appr("b", "c2")])).toBe(true);
    expect(batchItems([appr("a"), appr("b", "c2")], "once", "")).toBeNull();
    expect(batchItems([appr("a"), appr("b")], "deny", " ")).toBeNull();
    expect(batchItems([appr("a"), appr("b")], "deny", " não ")).toEqual([
      { request_id: "a", digest: "d-a", choice: "deny", reason: "não" },
      { request_id: "b", digest: "d-b", choice: "deny", reason: "não" },
    ]);
  });
});

describe("rules/seal (invariant 8)", () => {
  it("reads the seal only from SealResult; anything unknown is broken", () => {
    expect(sealVariant(undefined)).toBe("unverified");
    expect(sealVariant({ seal: "lock" } as any)).toBe("lock");
    expect(sealVariant({ seal: "hand" } as any)).toBe("hand");
    expect(sealVariant({ seal: "none" } as any)).toBe("note");
    expect(sealVariant({ seal: "broken" } as any)).toBe("broken");
    expect(sealVariant({ seal: "future_seal" } as any)).toBe("broken");
  });

  it("a Bot scope shows its own and non-bot rules only", () => {
    const r = (id: string, kind: string, ref?: string) =>
      ({ rule: { id, label: id, level: "ask", state: "active", scope: { kind, ref }, match: {} }, seal_result: { seal: "hand" } }) as unknown as RuleWithSeal;
    const rules = [r("g", "global"), r("v", "bot", "vendas"), r("d", "bot", "dev")];
    expect(filterRules(rules, { botName: "vendas", level: "all", state: "all", query: "" }).map((x) => x.rule.id)).toEqual(["g", "v"]);
    expect(filterRules(rules, { level: "all", state: "all", query: "D" }).map((x) => x.rule.id)).toEqual(["d"]);
  });
});

describe("rooms/mentions (red team 10)", () => {
  const members: RoomMember[] = [
    { member_id: "m1", bot: "vendas", handle: "vendas", display_name: "Vendas" },
    { member_id: "m2", bot: "dev", handle: "dev" },
  ];

  it("offers only members, plus @todos when it matches", () => {
    expect(matchingMembers(members, "ve").map((m) => m.handle)).toEqual(["vendas"]);
    expect(matchingMembers(members, "pesquisa")).toEqual([]);
    expect(offersAll("to")).toBe(true);
    expect(offersAll("dev")).toBe(false);
  });

  it("finds the token before the cursor and replaces it", () => {
    expect(mentionAt("oi @Ve", 6)).toEqual({ query: "ve", start: 3 });
    expect(mentionAt("oi @ve tudo", 11)).toBeNull();
    expect(insertMention("oi @ve!", 3, 6, "vendas")).toEqual({ text: "oi @vendas !", caret: 11 });
  });

  it("several targets need a cost confirmation", () => {
    expect(isMultiTarget("@vendas olá")).toBe(false);
    expect(isMultiTarget("@vendas e @dev")).toBe(true);
    expect(isMultiTarget("@TODOS bom dia")).toBe(true);
  });
});

describe("home/derive", () => {
  it("needs-you lists pending approvals and handoffs waiting for a human, nothing else", () => {
    const h = (id: string, state: string, needs_review = false) => ({ id, from: "vendas", to: "dev", title: id, state, needs_review }) as unknown as Handoff;
    const items = needsYou([appr("p"), appr("x", "c1", { status: "decided" })], [h("t", "triage"), h("r", "running", true), h("ok", "done")]);
    expect(items.map((i) => [i.kind, i.id])).toEqual([["approval", "p"], ["handoff", "t"], ["handoff", "r"]]);
  });

  it("upcoming routines skip paused ones; active bots skip offline and paused", () => {
    const rt = (id: string, enabled: boolean, state = "scheduled") => ({ id, enabled, state }) as any;
    expect(upcomingRoutines([rt("a", true), rt("b", false), rt("c", true, "paused")]).map((r) => r.id)).toEqual(["a"]);
    expect(activeBotCount([{ status: "idle" }, { status: "paused" }, { status: "offline" }, { status: "working" }] as any)).toBe(2);
  });
});
