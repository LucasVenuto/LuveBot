// dashboard/src/components/pages/ReviewSwitch.tsx
// "Revisar antes de salvar" on a Bot's Pages (pages-review-v0 §1). The state is the backend's (GET /pages/review: the ACTIVE rule of the exact
// shape, with its seal); the sentence "só vale para as ferramentas de arquivo do Hermes" is always said, because a Bot that writes a page with
// `terminal` is not stopped; a switch that is on while the hook is too old reads "ligado, mas o hook precisa ser atualizado", never plain "ligado".
// No login (loopback): the server refuses both directions, so the switch says so before the click. A backend without the route: no switch.

import React from "react";
import { ApiError, getPagesReview } from "../../api/client";
import type { PagesReviewState } from "../../api/types";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { SealBadge } from "../rules/SealBadge";
import { sealVariant } from "../rules/seal";
import { useNoLoginKind } from "../chat/RunControls";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { HookUpdate } from "../agent/HookUpdate";
import { ReviewRuleElsewhere, ReviewRuleMissing, turnReviewOff, turnReviewOn } from "./review";

type View = PagesReviewState | "hidden" | "error" | null;

export function ReviewSwitch({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const kind = useNoLoginKind();
  const noLogin = kind !== null;
  const [view, setView] = React.useState<View>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  const read = React.useCallback(async () => {
    let next: View;
    try {
      const s = await getPagesReview(bot);
      next = typeof s?.enabled === "boolean" ? s : "hidden";                     // an answer that is not this route's: nothing to show
    } catch (e) {
      next = e instanceof ApiError && (e.status === 404 || e.code === "plugin_route_missing" || e.code === "not_found") ? "hidden" : "error";
    }
    if (alive.current) setView(next);
  }, [bot]);
  React.useEffect(() => { setView(null); setError(null); void read(); }, [read]);

  async function toggle(on: PagesReviewState) {
    if (busy || noLogin) return;
    setBusy(true); setError(null);
    try {
      if (on.enabled) await turnReviewOff(bot, on.rule_id ?? "");
      else await turnReviewOn(bot, t("pageReviewRuleLabel"));
    } catch (e) {
      if (alive.current) setError(e instanceof ReviewRuleMissing ? t("pageReviewNoRule") : e instanceof ReviewRuleElsewhere ? t("pageReviewElsewhere") : humanError(e, t, "pageReviewChangeError"));
    } finally {
      await read();                                                              // the screen says what the backend says now, not what was clicked
      if (alive.current) setBusy(false);
    }
  }

  if (view === null || view === "hidden") return null;
  if (view === "error") {
    return (
      <p role="status" data-testid="pages-review-error" className="lb-caption" style={{ margin: "0 24px 8px", color: "var(--color-muted-foreground)" }}>
        {t("pageReviewReadError")} <button type="button" className="lb-btn lb-btn-plain" onClick={() => void read()}>{t("retry")}</button>
      </p>
    );
  }
  const problems = view.enabled ? view.seal?.problems ?? [] : [];
  const outdated = problems.some((p) => p.code === "hook_outdated");
  const others = problems.filter((p) => p.code !== "hook_outdated");
  const broken = view.enabled && sealVariant(view.seal ?? undefined) === "broken";
  const global = view.enabled && view.scope === "global";   // a rule of every Bot: this screen cannot turn it off (no archive button), Rules can
  const status: TranslationKey = !view.enabled ? "pageReviewOff" : outdated ? "pageReviewOnOutdated" : broken || others.length > 0 ? "pageReviewOnProblem" : "pageReviewOn";
  return (
    <section data-testid="pages-review" aria-labelledby="pages-review-title" className="lb-group" style={{ margin: "0 24px 12px", padding: "12px 16px", display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span id="pages-review-title" className="lb-headline" style={{ flex: 1, minWidth: 0 }}>{t("pageReviewTitle")}</span>
        {view.enabled && <SealBadge sealResult={view.seal ?? undefined} />}
        <button type="button" role="switch" aria-checked={view.enabled} aria-labelledby="pages-review-title" aria-describedby="pages-review-status pages-review-scope"
          disabled={busy || noLogin || global} onClick={() => void toggle(view)} className="lb-switch" data-testid="pages-review-switch"
          style={{ width: 44, height: 26, borderRadius: 13, border: "none", flexShrink: 0, cursor: busy || noLogin || global ? "not-allowed" : "pointer", position: "relative",
            background: view.enabled ? "var(--color-success)" : "var(--lb-fill-2)", opacity: busy || noLogin || global ? 0.55 : 1 }}>
          <span aria-hidden="true" style={{ position: "absolute", top: 3, left: view.enabled ? 21 : 3, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "left 120ms" }} />
        </button>
      </div>
      <p id="pages-review-status" data-testid="pages-review-status" className="lb-subhead" style={{ margin: 0, color: outdated || broken || others.length > 0 ? "var(--color-warning)" : undefined }}>
        {t(status)}
        {outdated && <span style={{ display: "block", color: "var(--color-muted-foreground)" }}>{t("pageReviewOnOutdatedHelp")}</span>}
        {others.map((p, i) => <span key={i} data-testid="pages-review-problem" style={{ display: "block" }}><code>{p.code}</code>: {p.detail}</span>)}
      </p>
      {outdated && <HookUpdate bot={bot} onDone={() => void read()} />}
      <p id="pages-review-scope" data-testid="pages-review-scope" className="lb-caption" style={{ margin: 0, color: "var(--color-muted-foreground)" }}>{t("pageReviewFileToolsOnly")}</p>
      {global && <p role="status" data-testid="pages-review-global" className="lb-caption" style={{ margin: 0 }}>{t("pageReviewGlobal")}</p>}
      {noLogin && !global && <p role="status" className="lb-caption" style={{ margin: 0 }}>{kind === "deployment" ? t("errCredentialNotHuman") : t("pageReviewLogin")}</p>}
      {error && <p role="alert" className="lb-caption" style={{ margin: 0, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </section>
  );
}
