// dashboard/src/components/pages/review.ts
// The "Revisar antes de salvar" switch (pages-review-v0 §1) is NOT a new write route: it is ONE rule per Bot made through the usual rules
// routes (ask, tools exactly write_file and patch, condition `path under workspace:pages`, scope this Bot). On = create a draft and activate it
// (both human-only: loopback is refused by the server); off = archive it, which loosens, so it is human-only too. The switch's STATE always comes
// from GET /bots/{bot}/pages/review after the change, never from what was clicked.

import { createRule, getRules, patchRule } from "../../api/client";
import type { Rule } from "../../api/types";

export const REVIEW_TOOLS = ["write_file", "patch"];
const PAGES = { fact: "path", op: "under", value: "workspace:pages" };

export class ReviewRuleMissing extends Error {}
/** The active rule behind "ligado" is not this Bot's own (the backend counts a global rule of the same shape): archiving it would turn the review off for every Bot. */
export class ReviewRuleElsewhere extends Error {}

/** The shape the switch makes, whatever the scope (any other rule is not the switch: a rule with only write_file leaves patch open). */
function isReviewShape(r: Rule): boolean {
  const m = r.match, tools = [...(m.tools ?? [])].sort().join(",");
  const c = Array.isArray(m.conditions) ? m.conditions : [];
  return r.level === "ask" && !r.builtin && tools === [...REVIEW_TOOLS].sort().join(",")
    && !m.toolsets?.length && !m.mcp_servers?.length && !m.commands?.length && c.length === 1 && c[0].fact === PAGES.fact && c[0].op === PAGES.op && c[0].value === PAGES.value;
}

/** This Bot's own switch rule: the shape, scoped to this Bot. */
export const isReviewRule = (r: Rule, bot: string): boolean => isReviewShape(r) && r.scope.kind === "bot" && r.scope.ref === bot;

/** An ACTIVE rule of the shape that already reviews this Bot's writes: its own or a global one (the backend counts both). */
const reviewsBot = (r: Rule, bot: string): boolean => r.state === "active" && isReviewShape(r) && (r.scope.kind === "global" || (r.scope.kind === "bot" && r.scope.ref === bot));

/** Every rule that applies to this Bot. GET /rules pages at 50 (the built-ins first), so follow the cursor: a rule on page 2 is still THE rule
 *  (not finding it would say "rule not found" when turning off and pile up a second one when turning on). */
async function rulesOf(bot: string): Promise<Rule[]> {
  const out: Rule[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {   // 20 pages of 50: far past any real list; a loop that cannot end is worse than a rule not found
    const page = await getRules(cursor, bot);
    out.push(...page.rules.map((x) => x.rule));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  return out;
}

export async function turnReviewOn(bot: string, label: string): Promise<void> {
  // a draft of this exact shape is left by an activation that failed (no login): use it again, never pile up copies
  const all = await rulesOf(bot);
  if (all.some((r) => reviewsBot(r, bot))) return;                      // already reviewed (a global rule counts): a second rule would only pile up
  const have = all.find((r) => r.state === "draft" && isReviewRule(r, bot));
  const rule = have ?? (await createRule({ label, level: "ask", scope: { kind: "bot", ref: bot }, match: { tools: [...REVIEW_TOOLS], conditions: [PAGES] }, state: "draft" })).rule;
  await patchRule({ id: rule.id, version: rule.version, state: "active" });
}

export async function turnReviewOff(bot: string, ruleId: string): Promise<void> {
  const rule = (await rulesOf(bot)).find((r) => r.id === ruleId);
  if (!rule) throw new ReviewRuleMissing();
  if (rule.scope.kind !== "bot" || rule.scope.ref !== bot) throw new ReviewRuleElsewhere();   // never archive a rule that is more than this Bot's switch
  await patchRule({ id: rule.id, version: rule.version, state: "archived" });
}
