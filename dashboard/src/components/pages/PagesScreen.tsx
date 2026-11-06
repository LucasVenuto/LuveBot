// dashboard/src/components/pages/PagesScreen.tsx
// The Bot's Pages in the main area (T9.3a §2): the library, and a page opened from it with a way back.

import React from "react";
import type { Bot, Page } from "../../api/types";
import { useLuveI18n } from "../../i18n";
import { PagesLibrary } from "./PagesLibrary";
import { PageView } from "./PageView";

export function PagesScreen({ bot, initialSlug = null, onAsk }: { bot: Bot; initialSlug?: string | null; onAsk?: (page: Page) => void }) {
  const { t } = useLuveI18n();
  const [slug, setSlug] = React.useState<string | null>(initialSlug);
  if (!slug) return <PagesLibrary bot={bot} onOpen={setSlug} />;
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "16px 24px 24px", background: "var(--color-background)" }}>
      <button type="button" onClick={() => setSlug(null)} className="lb-btn lb-btn-plain" style={{ marginBottom: 8 }}>‹ {t("pagesTitle")}</button>
      <div style={{ maxWidth: 1120 }}>
        <PageView bot={{ name: bot.name, label: bot.display?.label, avatar: bot.display?.avatar, color: bot.display?.color }} slug={slug} onAsk={onAsk} />
      </div>
    </div>
  );
}
