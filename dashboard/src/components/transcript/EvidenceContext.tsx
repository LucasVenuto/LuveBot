// dashboard/src/components/transcript/EvidenceContext.tsx
// What the evidence card needs from the SCREEN it is drawn in (contract v0.10 3.2): how many approvals are pending in THIS conversation (from the approvals the shell already
// holds: no route of its own) and how to open the Approvals box. A screen that cannot say (a room: its approvals are not tied to it; or the approvals are not loaded yet)
// provides nothing, and the card then shows no count and no comparison: `null` means "this screen does not know", never zero.

import React from "react";
import { EvidenceCard } from "../evidence/EvidenceCard";
import type { Evidence } from "../../lib/evidence";
import type { Approval } from "../../api/types";

export interface EvidenceEnv { pending: number | null; onOpenApprovals?: () => void }
const Ctx = React.createContext<EvidenceEnv>({ pending: null });

export function EvidenceProvider({ pending, onOpenApprovals, children }: EvidenceEnv & { children: React.ReactNode }) {
  const value = React.useMemo(() => ({ pending, onOpenApprovals }), [pending, onOpenApprovals]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One parsed block, drawn. Only this component reads the context. */
export function EvidenceBlock({ evidence }: { evidence: Evidence }) {
  const { pending, onOpenApprovals } = React.useContext(Ctx);
  return <EvidenceCard evidence={evidence} pending={pending} onOpenApprovals={onOpenApprovals} />;
}

/** The pending approvals of ONE conversation: the shell's pending list, the Bot's own, the ones raised by a run this conversation holds. `null` (the screen does not know) when the shell has not
 *  loaded them, and when this Bot has a pending request that NO run ties to any conversation (a hook of Telegram or the CLI, an approval with no run): it could be this conversation's, so
 *  "no pending request from this conversation" would be a claim the screen cannot make, and a count would be a number that may be short. */
export function pendingInConversation(pending: readonly Approval[] | null | undefined, bot: string, runIds: Iterable<string | undefined>): number | null {
  if (!pending) return null;
  const ofBot = pending.filter((a) => a.status === "pending" && a.bot === bot);
  if (ofBot.some((a) => !a.run_id)) return null;
  const mine = new Set([...runIds].filter((id): id is string => !!id));
  return ofBot.filter((a) => mine.has(a.run_id as string)).length;
}
