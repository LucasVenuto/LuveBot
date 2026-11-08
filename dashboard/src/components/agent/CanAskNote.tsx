// dashboard/src/components/agent/CanAskNote.tsx
// A Bot whose api_server toolset has no `clarify` never asks a person anything: Hermes sets the question aside and the Bot decides alone, so it
// never shows in "esperando você" and the person thinks the feature is broken. GET /bots/{bot} says `can_ask` (absent when the backend could not
// read it, never a guess): ONE calm line, only when it is exactly `false`. No switch: turning a tool on gives the Bot a capability (v0.3).

import React from "react";
import { getBot } from "../../api/client";
import { useLuveI18n } from "../../i18n";

export function CanAskNote({ bot }: { bot: string }) {
  const { t } = useLuveI18n();
  const [cannot, setCannot] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    setCannot(false);   // another Bot: its own answer, never the last one's
    getBot(bot).then((d) => { if (alive) setCannot(d?.can_ask === false); }, () => { /* advisory only: no line when it cannot be read */ });
    return () => { alive = false; };
  }, [bot]);
  if (!cannot) return null;
  return (
    <p data-testid="bot-cannot-ask" className="lb-caption" style={{ margin: "12px 4px 0" }}>
      {t("canAskNo")} {t("canAskHow")}
    </p>
  );
}
