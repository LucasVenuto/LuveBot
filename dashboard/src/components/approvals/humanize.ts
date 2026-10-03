// dashboard/src/components/approvals/humanize.ts
// What an approval asks, in words a person reads (the CEO saw "luvebot:noncanonical" and "<terminal> (plugin approval rule)").
// Hermes builds those strings for plugin rules (tools/approval.py request_tool_approval: display_target "<tool> (plugin approval
// rule)", pattern_key "plugin_rule:luvebot:<rule id>#…"); LuveBot's hook writes "luvebot:<id>" as the message. Here they become
// the rule's own label, the tool's name and the redacted command; the raw ids stay in a collapsed detail.

import React from "react";
import { getRules } from "../../api/client";
import type { TranslationKey } from "../../i18n";

export interface ApprovalFacts {
  description?: string | null;
  command?: string | null;          // from the stream frame: for a plugin rule it is Hermes's synthetic label, not the command
  commandRedacted?: string | null;  // stored by the backend, redacted
  patternKey?: string | null;
  tool?: string | null;
  ruleId?: string | null;
}

export interface HumanApproval { title: string; tool: string | null; preview: string | null; technical: string[] }

const SYNTHETIC = /^<([A-Za-z0-9_.:-]{1,64})> \(plugin approval rule\)$/;
const RAW = /^luvebot:/;
const TOOLS: Record<string, TranslationKey> = {
  terminal: "toolTerminal", write_file: "toolWriteFile", read_file: "toolReadFile", patch: "toolPatch",
  web_search: "toolWebSearch", web_extract: "toolWebExtract", browser_navigate: "toolBrowser", send_message: "toolSendMessage",
};

export function ruleIdOf(f: ApprovalFacts): string | null {
  if (f.ruleId) return f.ruleId;
  const m = (f.patternKey ?? "").match(/(?:^|:)luvebot:([^#\s]+)#/) ?? (f.description ?? "").match(/^luvebot:(?:channel_block:[^:]+:)?([^:\s]+)$/);
  return m ? m[1] : null;
}

export function toolOf(f: ApprovalFacts): string | null {
  return f.tool || (f.command ?? "").match(SYNTHETIC)?.[1] || null;
}

export function humanApproval(f: ApprovalFacts, ruleLabel: (id: string) => string | undefined, t: (k: TranslationKey, p?: Record<string, string>) => string): HumanApproval {
  const rule = ruleIdOf(f);
  const tool = toolOf(f);
  const label = rule && rule !== "noncanonical" ? ruleLabel(rule) : undefined;
  const plainDescription = f.description && !RAW.test(f.description) ? f.description : null;
  const title = rule === "noncanonical" ? t("approvalRuleNoncanonical")
    : label ? t("approvalRuleNamed", { label })
    : plainDescription ?? (rule ? t("approvalRuleUnknown") : t("defaultActionLabel"));
  const command = f.command && !SYNTHETIC.test(f.command) ? f.command : null;
  const preview = f.commandRedacted || command || null;
  const technical = [f.description, f.command, f.patternKey, rule].filter((x, i, all): x is string => !!x && all.indexOf(x) === i)
    .filter((x) => x !== title && x !== preview);
  return { title, tool: tool ? (TOOLS[tool] ? t(TOOLS[tool]) : tool) : null, preview, technical };
}

/** A stored approval's title (the inbox, Hoje): the same words as the card in the conversation. */
export function approvalTitle(a: { description?: string | null; command_redacted?: string | null; pattern_keys?: string[]; tool?: string | null; rule_id?: string | null },
  ruleLabel: (id: string) => string | undefined, t: (k: TranslationKey, p?: Record<string, string>) => string): string {
  return humanApproval({ description: a.description, commandRedacted: a.command_redacted, patternKey: a.pattern_keys?.[0], tool: a.tool, ruleId: a.rule_id }, ruleLabel, t).title;
}

let labels: Promise<Map<string, string>> | null = null;
const readLabels = () => getRules().then((r) => new Map((r?.rules ?? []).map((x) => [x.rule.id, x.rule.label] as [string, string]))).catch(() => { labels = null; return new Map<string, string>(); });
/** LuveBot's rule labels by id, read once per page; a rule the cache does not know yet (made after the read, e.g. by
 *  "Sempre permitir") triggers one more read. A failed read is retried next time. */
export function useRuleLabels(enabled = true, want?: string | null): (id: string) => string | undefined {
  const [map, setMap] = React.useState<Map<string, string>>(new Map());
  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    labels ??= readLabels();
    void labels.then((m) => {
      if (want && want !== "noncanonical" && !m.has(want)) labels = readLabels().then((fresh) => fresh);
      return labels!;
    }).then((m) => { if (alive) setMap(m); });
    return () => { alive = false; };
  }, [enabled, want]);
  return React.useCallback((id: string) => map.get(id), [map]);
}
