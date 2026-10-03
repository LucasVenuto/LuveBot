// dashboard/src/components/bots/BotProfile.tsx
// Bot Profile component (spec 4.5):
// - Tabs 1-3: Identidade, Instruções (SOUL.md editor with tip), Modelo
// - Uses typed client to fetch details and update display metadata with CSRF

import React, { useState, useEffect } from "react";
import type { BotDetail, BotDisplay, BotAvatar } from "../../api/types";
import { getBot, updateBotDisplay } from "../../api/client";
import { BOT_COLORS } from "../../api/templates";
import { AttentionBadge } from "../ui/AttentionBadge";
import { attention } from "../messenger/attention";
import { XIcon, CheckCircleIcon, SparklesIcon } from "../Icons";
import { RulesView } from "../rules";
import { Avatar } from "../ui/Avatar";
import { MascotPicker } from "../ui/MascotPicker";
import { displayFace } from "../ui/mascots";
import { useLuveI18n } from "../../i18n";
import { withDisplayName } from "../../lib/botName";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";

export interface BotProfileProps {
  botName: string;
  initialBot?: BotDetail;
  onClose?: () => void;
  onBotUpdated?: (updated: BotDetail) => void;
}

export function BotProfile({
  botName,
  initialBot,
  onClose,
  onBotUpdated,
}: BotProfileProps) {
  const { t } = useLuveI18n();
  const [activeTab, setActiveTab] = useState<"identidade" | "instrucoes" | "modelo" | "regras">("identidade");
  const [bot, setBot] = useState<BotDetail | null>(initialBot || null);
  const [loading, setLoading] = useState<boolean>(!initialBot);
  const [error, setError] = useState<ErrorState | null>(null);

  // Form states for Tab 1: Identidade
  const [label, setLabel] = useState<string>(initialBot?.display?.label || botName);
  const [role, setRole] = useState<string>(initialBot?.display?.role || "");
  const [callMe, setCallMe] = useState<string>(initialBot?.display?.call_me || "");
  const [color, setColor] = useState<string>(initialBot?.display?.color || "#38bdf8");
  const [avatarValue, setAvatarValue] = useState<string>(initialBot?.display?.avatar?.value || "🤖");
  const [avatarKind, setAvatarKind] = useState<BotAvatar["kind"]>(initialBot?.display?.avatar?.kind || "emoji");
  const [isSavingDisplay, setIsSavingDisplay] = useState<boolean>(false);
  const [saveSuccessMessage, setSaveSuccessMessage] = useState<string | null>(null);

  // Form states for Tab 2: Instruções (SOUL.md)
  const [soul, setSoul] = useState<string>(initialBot?.soul || "");

  // Form states for Tab 3: Modelo

  // Load bot details if not supplied
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const data = withDisplayName(await getBot(botName));
        if (!cancelled) {
          setBot(data);
          setLabel(data.display?.label || data.name);
          setRole(data.display?.role || "");
          setCallMe(data.display?.call_me || "");
          setColor(data.display?.color || "#38bdf8");
          setAvatarValue(data.display?.avatar?.value || "🤖");
          setAvatarKind(data.display?.avatar?.kind || "emoji");
          setSoul(data.soul || "");
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = humanError(err, t, "errorLoadingBots");
          setError(msg);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (!initialBot || initialBot.name !== botName) {
      load();
    }
    return () => {
      cancelled = true;
    };
  }, [botName, initialBot, t]);

  // Accessibility: Close profile on Escape key if onClose is provided
  useEffect(() => {
    if (!onClose) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Handle Tab 1 Save
  const handleSaveDisplay = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingDisplay(true);
    setSaveSuccessMessage(null);
    setError(null);

    try {
      const avatar: BotAvatar = { kind: avatarKind, value: avatarValue.trim() || "🤖" };
      const updatedBot = await updateBotDisplay(botName, {
        label: label.trim(),
        role: role.trim(),
        call_me: callMe.trim() || null,
        color,
        avatar,
      });

      const fullUpdated: BotDetail = {
        ...(bot || ({} as BotDetail)),
        ...updatedBot,
        soul: bot?.soul || "",
      };

      setBot(fullUpdated);
      setSaveSuccessMessage(t("identitySaveSuccess"));
      onBotUpdated?.(fullUpdated);

      setTimeout(() => setSaveSuccessMessage(null), 3000);
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorSaving");
      setError(msg);
    } finally {
      setIsSavingDisplay(false);
    }
  };

  if (loading) {
    return (
      <div className="lb:flex lb:flex-col lb:items-center lb:justify-center lb:p-12 lb:text-[15px] lb:text-[var(--color-muted-foreground)]" aria-busy="true">
        <div className="lb:w-6 lb:h-6 lb:border-2 lb:border-[var(--color-primary)] lb:border-t-transparent lb:rounded-full lb:animate-spin lb:mb-3" />
        <span>{t("profileLoading")}</span>
      </div>
    );
  }

  return (
    <div className="lb:flex lb:flex-col lb:h-full lb:w-full lb:bg-[var(--background)] lb:overflow-y-auto" data-testid="bot-profile">
      {/* Profile Header */}
      <header className="lb:px-6 lb:pt-6 lb:pb-2 lb:shrink-0">
        <div className="lb:flex lb:items-center lb:justify-between lb:gap-4 lb:max-w-4xl lb:mx-auto">
          <div className="lb:flex lb:items-center lb:gap-3.5">
            <Avatar name={label || botName} avatar={displayFace(botName, { kind: avatarKind, value: avatarValue } as BotAvatar)} color={color} size={56} />
            <div>
              <div className="lb:flex lb:items-center lb:gap-2">
                <h1 className="lb-large-title">
                  {label || botName}
                </h1>
                {bot && <AttentionBadge state={attention(bot)} />}
              </div>
              <p className="lb-subhead lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
                {role || t("defaultRoleAgent")}
              </p>
            </div>
          </div>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("closeProfile")}
              className="lb:p-2 lb:min-h-11 lb:min-w-11 lb:flex lb:items-center lb:justify-center lb:rounded-xl lb:hover:bg-[var(--lb-fill-2)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none"
            >
              <XIcon size={18} />
            </button>
          )}
        </div>

        {/* Tabs Bar */}
        <div role="tablist" aria-label={t("botProfileTabs")} className="lb-segmented lb:mt-6 lb:max-w-4xl lb:mx-auto">
          <button
            type="button"
            role="tab"
            id="tab-identidade"
            aria-controls="panel-identidade"
            aria-selected={activeTab === "identidade"}
            onClick={() => setActiveTab("identidade")}
            className="lb-segment"
          >
            {t("tabIdentity")}
          </button>
          <button
            type="button"
            role="tab"
            id="tab-instrucoes"
            aria-controls="panel-instrucoes"
            aria-selected={activeTab === "instrucoes"}
            onClick={() => setActiveTab("instrucoes")}
            className="lb-segment"
          >
            {t("tabInstructions")}
          </button>
          <button
            type="button"
            role="tab"
            id="tab-modelo"
            aria-controls="panel-modelo"
            aria-selected={activeTab === "modelo"}
            onClick={() => setActiveTab("modelo")}
            className="lb-segment"
          >
            {t("tabModel")}
          </button>
          <button
            type="button"
            role="tab"
            id="tab-regras"
            aria-controls="panel-regras"
            aria-selected={activeTab === "regras"}
            onClick={() => setActiveTab("regras")}
            className="lb-segment"
          >
            {t("tabRules")}
          </button>
        </div>
      </header>

      {/* Notifications */}
      {saveSuccessMessage && (
        <div className="lb:max-w-4xl lb:mx-auto lb:w-full lb:px-4 lb:md:px-6 lb:pt-4">
          <div className="lb:p-3 lb:rounded-xl lb:border-[var(--color-success)]/40 lb:bg-[var(--color-success)]/10 lb:text-[var(--color-success)] lb:text-[13px] lb:flex lb:items-center lb:gap-2">
            <CheckCircleIcon size={15} />
            <span>{saveSuccessMessage}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="lb:max-w-4xl lb:mx-auto lb:w-full lb:px-4 lb:md:px-6 lb:pt-4">
          <div className="lb:p-3 lb:rounded-xl lb:border-[var(--color-destructive)]/40 lb:bg-[var(--color-destructive)]/10 lb:text-[var(--color-destructive)] lb:text-[13px] lb:flex lb:items-center lb:justify-between lb:gap-2">
            <span><ErrorNote error={error} /></span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="lb:text-xs lb:underline lb:hover:no-underline"
            >
              {t("close")}
            </button>
          </div>
        </div>
      )}

      {/* Main Tab Content */}
      <main className="lb:flex-1 lb:p-4 lb:md:p-6 lb:max-w-4xl lb:mx-auto lb:w-full">
        {/* Tab 1: Identidade */}
        {activeTab === "identidade" && (
          <form role="tabpanel" id="panel-identidade" aria-labelledby="tab-identidade" onSubmit={handleSaveDisplay} className="lb:flex lb:flex-col lb:gap-5">
            <div className="lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4">
              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("visibleNameLabel")}
                </label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={t("visibleNamePlaceholder")}
                  required
                  className="lb-input"
                />
              </div>

              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("hermesIdentifierLabel")}
                </label>
                <input
                  type="text"
                  value={botName}
                  disabled
                  className="lb-input lb-mono lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                />
              </div>
            </div>

            <div className="lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4">
              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("primaryRoleLabel")}
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  placeholder={t("primaryRolePlaceholder")}
                  className="lb-input"
                />
              </div>

              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("callMeLabelProfile")}
                </label>
                <input
                  type="text"
                  value={callMe}
                  onChange={(e) => setCallMe(e.target.value)}
                  placeholder={t("callMePlaceholder")}
                  className="lb-input"
                />
              </div>
            </div>

            {/* Mascot face (T8.3): only by a click here, never changed on its own */}
            <div>
              <div className="lb-label lb:block lb:mb-2">{t("mascotPickerLabel")}</div>
              <MascotPicker value={avatarKind === "mascot" ? avatarValue : null} color={color}
                onPick={(id) => { setAvatarKind("mascot"); setAvatarValue(id); }} />
            </div>

            {/* Avatar & Emoji */}
            <div className="lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4">
              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("avatarEmojiInitialsLabel")}
                </label>
                <div className="lb:flex lb:items-center lb:gap-2">
                  <input
                    type="text"
                    aria-label={t("avatarEmojiInitialsLabel")}
                    value={avatarKind === "emoji" || avatarKind === "initials" ? avatarValue : ""}
                    onChange={(e) => { if (avatarKind !== "initials") setAvatarKind("emoji"); setAvatarValue(e.target.value); }}
                    maxLength={4}
                    className="lb:w-20 lb:px-3 lb:py-1.5 lb:text-base lb:text-center lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-foreground)] lb:focus:border-[var(--color-primary)] lb:focus:outline-hidden"
                  />
                  <div className="lb:flex lb:gap-1.5 lb:text-[13px]">
                    {["💼", "🎧", "💻", "🔍", "✍️", "📊", "👔", "🤖"].map((em) => (
                      <button
                        key={em}
                        type="button"
                        onClick={() => {
                          setAvatarValue(em);
                          setAvatarKind("emoji");
                        }}
                        className="lb:w-7 lb:h-7 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)] lb:motion-safe:transition-colors"
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* 8-color Archetype Palette */}
              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("botColorLabel")}
                </label>
                <div className="lb:flex lb:items-center lb:gap-2 lb:flex-wrap">
                  {BOT_COLORS.map((c) => {
                    const isSelected = color.toLowerCase() === c.hex.toLowerCase();
                    return (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setColor(c.hex)}
                        title={`${c.name} (${c.archetype})`}
                        className={`lb:w-7 lb:h-7 lb:rounded-full lb:motion-safe:transition-transform lb:flex lb:items-center lb:justify-center ${
                          isSelected
                            ? "lb:scale-110 lb:ring-2 lb:ring-offset-2 lb:ring-offset-[var(--background)] lb:ring-[var(--color-foreground)]"
                            : "lb:hover:scale-105 lb:opacity-80 lb:hover:opacity-100"
                        }`}
                        style={{ backgroundColor: c.hex }}
                      >
                        {isSelected && <span className="lb:w-2 lb:h-2 lb:rounded-full lb:bg-white" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="lb:pt-4 lb:border-t lb:border-[var(--lb-separator)] lb:flex lb:justify-end">
              <button
                type="submit"
                disabled={isSavingDisplay}
                className="lb:px-4 lb:py-2 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:disabled:opacity-50 lb:motion-safe:transition-opacity lb:rounded-full"
              >
                {isSavingDisplay ? t("saving") : t("saveChanges")}
              </button>
            </div>
          </form>
        )}

        {/* Tab 2: Instruções (SOUL.md) */}
        {activeTab === "instrucoes" && (
          <div role="tabpanel" id="panel-instrucoes" aria-labelledby="tab-instrucoes" className="lb:flex lb:flex-col lb:gap-4">
            {/* Notice: Read-only in v0 */}
            <div className="lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:flex lb:items-center lb:justify-between">
              <span>{t("soulNotice")}</span>
              <span className="lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:shrink-0 lb:ml-2">
                {t("readOnlyBadge")}
              </span>
            </div>

            {/* Spec 4.5 mandatory tip banner */}
            <div className="lb:p-3 lb:rounded-2xl lb:border-[var(--color-primary)]/30 lb:bg-[var(--color-accent)] lb:text-[13px] lb:text-[var(--color-card-foreground)] lb:flex lb:items-start lb:gap-2.5">
              <SparklesIcon size={16} className="lb:text-[var(--color-primary)] lb:shrink-0 lb:mt-0.5" />
              <div>
                <span className="lb:font-semibold lb:text-[var(--color-primary)]">
                  {t("soulTipTitle")}
                </span>{" "}
                <span>
                  {t("soulTipText")}
                </span>
                <p className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
                  {t("soulTipSub")}
                </p>
              </div>
            </div>

            <div className="lb:flex lb:flex-col lb:gap-1">
              <div className="lb:flex lb:items-center lb:justify-between lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                <span className="lb:font-semibold lb:text-[var(--color-card-foreground)]">{t("soulContentTitle")}</span>
                <span className="lb:font-mono lb:text-xs">{(bot?.soul || soul).length} {t("charactersCount")}</span>
              </div>
              <textarea
                value={bot?.soul || soul}
                readOnly
                rows={14}
                className="lb-input lb-mono lb:leading-relaxed lb:resize-y lb:cursor-default"
                placeholder={t("soulPlaceholder")}
              />
            </div>
          </div>
        )}

        {/* Tab 3: Modelo */}
        {activeTab === "modelo" && (
          <div role="tabpanel" id="panel-modelo" aria-labelledby="tab-modelo" className="lb:flex lb:flex-col lb:gap-5">
            {/* Notice: Read-only in v0 */}
            <div className="lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:flex lb:items-center lb:justify-between">
              <span>{t("modelNotice")}</span>
              <span className="lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:shrink-0 lb:ml-2">
                {t("readOnlyBadge")}
              </span>
            </div>

            <div className="lb:grid lb:grid-cols-1 lb:md:grid-cols-2 lb:gap-4">
              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("providerAILabel")}
                </label>
                <input
                  type="text"
                  value={bot?.model?.provider || "—"}
                  disabled
                  className="lb-input lb-mono lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                />
              </div>

              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("mainModelLabel")}
                </label>
                <input
                  type="text"
                  value={bot?.model?.name || "—"}
                  disabled
                  className="lb-input lb-mono lb:text-[var(--color-muted-foreground)] lb:cursor-not-allowed"
                />
              </div>
            </div>

            {/* Only what Hermes reports: reasoning and fallback have no source yet, so they are not shown (D5). */}
          </div>
        )}

        {/* Tab 4: Regras (Spec 4.10) */}
        {activeTab === "regras" && (
          <div role="tabpanel" id="panel-regras" aria-labelledby="tab-regras" className="lb:max-w-4xl lb:mx-auto lb:w-full lb:h-[600px] lb:flex lb:flex-col lb:border-[var(--lb-separator)] lb:rounded-2xl lb:overflow-hidden">
            <RulesView botName={botName} />
          </div>
        )}
      </main>
    </div>
  );
}
