// dashboard/src/components/settings/SettingsView.tsx
// Settings (brief §2.11, spec §4.15): the global things that left the main menu under D-016. Each tab mounts only
// while open, so the costs and rules screens load their own real data and never sit side by side.

import React from "react";
import type { Bot } from "../../api/types";
import { useLuveI18n, type Locale, type TranslationKey } from "../../i18n";
import { CostsView } from "../costs";
import { RulesView } from "../rules";
import { readSoundPref, writeSoundPref, type SoundPref } from "../../sound/cues";

type Tab = "general" | "costs" | "rules";

// Spec §8. Key names are symbols, not words, so they stay out of the dictionary; what each does is translated.
const SHORTCUTS: Array<[string, TranslationKey]> = [
  ["⌘K", "shortcutSearch"], ["⌘N", "shortcutNewBot"], ["⌘⇧N", "shortcutNewRoom"], ["⌘B", "shortcutSidebar"],
  ["⌘1…9", "shortcutBotN"], ["⌥↑ / ⌥↓", "shortcutBotStep"], ["⌘I", "shortcutComposer"], ["G · A", "shortcutApprovals"], ["Esc", "shortcutClose"],
];

export function SettingsView({ bots = [] }: { bots?: Bot[] }) {
  const { t, locale, setLocale } = useLuveI18n();
  const [tab, setTab] = React.useState<Tab>("general");
  const [sound, setSound] = React.useState<SoundPref>(readSoundPref);
  const sounds: Array<[SoundPref, TranslationKey]> = [["all", "soundsAll"], ["needs_you", "soundsNeedsYou"], ["off", "soundsOff"]];
  const tabs: Array<[Tab, TranslationKey]> = [["general", "settingsTabGeneral"], ["costs", "settingsTabCosts"], ["rules", "settingsTabRules"]];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--color-background)" }}>
      <header style={{ padding: "24px 24px 0" }}>
        <h1 className="lb-large-title" style={{ margin: 0 }}>{t("navConfig")}</h1>
        <div role="tablist" aria-label={t("navConfig")} className="lb-segmented" style={{ marginTop: 16, maxWidth: 420 }}>
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className="lb-segment">
              {t(label)}
            </button>
          ))}
        </div>
      </header>
      <div role="tabpanel" style={{ flex: 1, minHeight: 0, overflowY: "auto", marginTop: 16 }}>
        {tab === "general" && (
          <div style={{ padding: "8px 24px", maxWidth: 560 }}>
            <div className="lb-group">
              <label className="lb-row" style={{ justifyContent: "space-between" }}>
                <span className="lb-body">{t("settingsLanguage")}</span>
                <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)} className="lb-input" style={{ width: "auto", minWidth: 140 }}>
                  <option value="pt">{t("langPortuguese")}</option>
                  <option value="en">{t("langEnglish")}</option>
                </select>
              </label>
            </div>
            <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>{t("settingsThemeNote")}</p>

            <h2 id="settings-sounds" className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("soundsTitle")}</h2>
            <div role="radiogroup" aria-labelledby="settings-sounds" className="lb-group">
              {sounds.map(([value, label]) => (
                <label key={value} className="lb-row lb-row-flat" style={{ minHeight: 44, gap: 12, cursor: "pointer" }}>
                  <input type="radio" name="luvebot-sounds" value={value} checked={sound === value} onChange={() => { setSound(value); writeSoundPref(value); }} />
                  <span className="lb-body">{t(label)}</span>
                </label>
              ))}
            </div>
            <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>{t("soundsNote")}</p>

            {/* The install and offline facts left the contact list (F8): they are settings, not conversation */}
            <h2 className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("settingsAppTitle")}</h2>
            <div className="lb-group">
              <div className="lb-row lb-row-flat" style={{ minHeight: 44 }}><span className="lb-body">{t("pwaInstallableBadge")}</span></div>
              <div className="lb-row lb-row-flat" style={{ minHeight: 44 }}><span className="lb-body">{t("pwaOfflineNoticeHeader")}</span></div>
            </div>
            <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>{t("pwaScopeNotice")}</p>

            <h2 className="lb-headline" style={{ margin: "24px 4px 8px" }}>{t("shortcutsTitle")}</h2>
            <dl className="lb-group" style={{ margin: 0 }}>
              {SHORTCUTS.map(([keys, label]) => (
                <div key={keys} className="lb-row lb-row-flat" style={{ minHeight: 44, justifyContent: "space-between" }}>
                  <dt className="lb-body">{t(label)}</dt>
                  <dd style={{ margin: 0 }}><kbd className="lb-pill" style={{ fontFamily: "var(--lb-font)" }}>{keys}</kbd></dd>
                </div>
              ))}
            </dl>
            <p className="lb-caption" style={{ color: "var(--color-muted-foreground)", margin: "8px 16px" }}>{t("shortcutsNote")}</p>
          </div>
        )}
        {tab === "costs" && <CostsView bots={bots} />}
        {tab === "rules" && <RulesView bots={bots} />}
      </div>
    </div>
  );
}
