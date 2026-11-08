// dashboard/src/components/agent/HookUpdate.tsx
// "Atualizar o hook deste Bot": the only way, from the screen, to bring the new hook to a Bot that already exists. One click installs it
// (POST /bots/{bot}/hook/install, no body, CSRF, audited by the backend); the screen that offers it is read again by `onDone`.
// Shared by the Perfil's "Onde aprovar", the approval card that cannot say what it asks (details_unavailable) and the Perguntar rules whose seal
// says hook_outdated. A gateway that must be restarted is said plainly, never "atualizado".

import React from "react";
import { ApiError, installBotHook } from "../../api/client";
import { useLuveI18n, type TranslationKey } from "../../i18n";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";

/** `offered` false hides the button but keeps the last answer on screen: the card that offered it may stop asking for it the moment the update worked. */
export function HookUpdate({ bot, onDone, pad, offered = true }: { bot: string; onDone?: () => void; pad?: string; offered?: boolean }) {
  const { t } = useLuveI18n();
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<TranslationKey | null>(null);
  const [error, setError] = React.useState<ErrorState | null>(null);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  async function update() {
    setBusy(true); setError(null); setResult(null);
    try {
      const r = await installBotHook(bot);
      if (alive.current) setResult(r.restart_required ? "hookUpdateRestart" : r.changed ? "hookUpdated" : "hookAlreadyCurrent");
      onDone?.();   // the screen says what the hook does now
    } catch (e) {
      if (alive.current) setError(e instanceof ApiError && e.code === "hook_install_failed" ? t("hookUpdateFailed") : humanError(e, t, "hookUpdateFailed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <>
      {offered && <div style={pad ? { padding: pad } : undefined}>
        <button type="button" className="lb-btn" disabled={busy} onClick={() => void update()}>{busy ? t("hookUpdating") : t("hookUpdateBtn")}</button>
      </div>}
      {result && <p role="status" className="lb-caption" style={{ margin: 0, padding: pad, color: result === "hookUpdateRestart" ? "var(--color-warning)" : undefined }}>{t(result)}</p>}
      {error && <p role="alert" className="lb-caption" style={{ margin: 0, padding: pad, color: "var(--color-destructive)" }}><ErrorNote error={error} /></p>}
    </>
  );
}
