// dashboard/src/components/bots/BotCreateModal.tsx
// Stepper wizard for creating a Bot adhering strictly to spec 4.6:
// 1. Choose from the 7 templates or from scratch
// 2. Identity (validated name, avatar, 8 colors, call_me)
// 3. Operational description & guidelines
// 4. Model selection
// 5. Bot presentation message (spec 4.6 §7)

import React, { useState } from "react";
import type { Bot, BotAvatar, Template, CreateBotRequest } from "../../api/types";
import { createBot } from "../../api/client";
import { DEFAULT_TEMPLATES, BOT_COLORS } from "../../api/templates";
import { XIcon, ArrowRightIcon } from "../Icons";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Avatar } from "../ui/Avatar";
import { MascotPicker } from "../ui/MascotPicker";
import { humanError, ErrorNote, type ErrorState } from "../ui/ErrorNote";
import { BotIntroduction } from "./BotIntroduction";

export interface BotCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBotCreated?: (newBot: Bot, introSessionId?: string) => void;
  templates?: Template[];
  disableFocusTrap?: boolean;
}

export const PROFILE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** The wizard is mounted only while open: every "Novo Bot" starts at step 1 with an empty form, also after closing halfway (the
 *  shell keeps this component mounted, so state held in it brought back the previous Bot's last step). The focus trap stays
 *  here, mounted all along, so closing still gives focus back to what opened the wizard. */
export function BotCreateModal(props: BotCreateModalProps) {
  const trapRef = useFocusTrap<HTMLDivElement>({ isOpen: props.isOpen, onClose: props.onClose, disableTrap: props.disableFocusTrap });
  return props.isOpen ? <BotCreateWizard {...props} trapRef={trapRef} /> : null;
}

function BotCreateWizard({
  onClose,
  onBotCreated,
  templates = DEFAULT_TEMPLATES,
  trapRef: modalContainerRef,
}: BotCreateModalProps & { trapRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useLuveI18n();
  const [step, setStep] = useState<number>(1);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);

  // Step 2 & 3 Form fields
  const [name, setName] = useState<string>("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");
  const [role, setRole] = useState<string>("");
  const [callMe, setCallMe] = useState<string>("");
  const [avatarValue, setAvatarValue] = useState<string>("luvi");
  const [avatarKind, setAvatarKind] = useState<BotAvatar["kind"]>("mascot");
  const [color, setColor] = useState<string>("#38bdf8");
  const [description, setDescription] = useState<string>("");
  const [soul, setSoul] = useState<string>("");

  // Step 4 Model fields
  const [provider, setProvider] = useState<string>("openrouter");
  const [modelName, setModelName] = useState<string>("claude-sonnet-5-5");

  // Step 5 Presentation & Status
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [apiError, setApiError] = useState<ErrorState | null>(null);
  const [createdBot, setCreatedBot] = useState<Bot | null>(null);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);

  const handleSelectTemplate = (tpl: Template | null) => {
    setSelectedTemplate(tpl);
    if (tpl) {
      const defaultName = tpl.id === "sales" ? "vendas" : tpl.id.replace(/[^a-zA-Z0-9_-]/g, "");
      setName(defaultName);
      setLabel(tpl.label);
      setRole(tpl.role);
      setDescription(tpl.description || "");
      setColor(tpl.color || "#38bdf8");
      setAvatarKind(tpl.avatar?.kind || "mascot");
      setAvatarValue(tpl.avatar?.value || "luvi");
      setSoul(tpl.soul);
      if (tpl.model_hint) {
        setModelName(tpl.model_hint);
      }
    } else {
      // Do zero
      setName("");
      setLabel("");
      setRole("");
      setDescription("");
      setColor("#38bdf8");
      setAvatarKind("mascot");
      setAvatarValue("luvi");
      setSoul("# SOUL.md\nDefina regras perpétuas para este Bot...");
    }
    setNameError(null);
    setStep(2);
  };

  const handleNameChange = (val: string) => {
    setName(val);
    if (!val) {
      setNameError(t("nameRequired"));
    } else if (!PROFILE_NAME_REGEX.test(val)) {
      setNameError(t("nameFormatError"));
    } else {
      setNameError(null);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!PROFILE_NAME_REGEX.test(name)) {
      setNameError(t("nameInvalid"));
      return;
    }

    setIsSubmitting(true);
    setApiError(null);

    const payload: CreateBotRequest = {
      name: name.trim(),
      template: selectedTemplate?.id,
      display: {
        label: label.trim() || name.trim(),
        role: role.trim(),
        call_me: callMe.trim() || null,
        color,
        avatar: { kind: avatarKind, value: avatarValue },
      },
      model: {
        provider,
        name: modelName,
      },
    };

    try {
      const resp = await createBot(payload);
      setCreatedBot(resp.bot);
      setCreatedSessionId(resp.intro?.session_id || null);
      setStep(5); // Advance to presentation step
    } catch (err: unknown) {
      const msg = humanError(err, t, "errorLoadingBots");
      setApiError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFinish = () => {
    if (createdBot) {
      onBotCreated?.(createdBot, createdSessionId || undefined);
    }
    onClose();
  };

  return (
    <div
      ref={modalContainerRef}
      className="lb-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div className="lb-dialog lb:max-w-2xl lb:overflow-y-auto">
        {/* Header */}
        <div className="lb:flex lb:items-center lb:justify-between lb:px-5 lb:pt-5 lb:pb-3 lb:shrink-0">
          <div className="lb:flex lb:items-center lb:gap-2">
            <h2 id="modal-title" className="lb-title">
              {t("createBotModalTitle")} {step < 5 && `· ${t("stepOf", { step })}`}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* Stepper Progress Bar */}
        {step < 5 && (
          <div className="lb:flex lb:h-1 lb:bg-[var(--lb-fill)]">
            <div
              className="lb:bg-[var(--color-foreground)] lb:motion-safe:transition-all lb:duration-300"
              style={{ width: `${(step / 4) * 100}%` }}
            />
          </div>
        )}

        {/* Error message */}
        {apiError && (
          <div className="lb:mx-4 lb:mt-3 lb:p-3 lb:rounded-lg lb:text-[13px] lb:bg-[var(--color-destructive)]/15 lb:border-[var(--color-destructive)]/40 lb:text-[var(--color-destructive)]">
            <ErrorNote error={apiError} />
          </div>
        )}

        {/* Modal Body */}
        <div className="lb:flex-1 lb:overflow-y-auto lb:p-4 lb:md:p-6 lb:text-[13px] lb:text-[var(--color-foreground)]">
          {/* STEP 1: Escolher Template */}
          {step === 1 && (
            <div className="lb:flex lb:flex-col lb:gap-4">
              <div>
                <h3 className="lb-headline">
                  {t("wizardStep1Title")}
                </h3>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
                  {t("wizardStep1Subtitle")}
                </p>
              </div>

              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-2.5">
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => handleSelectTemplate(tpl)}
                    className="lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:hover:bg-[var(--lb-fill-2)] lb:hover:border-[var(--color-primary)] lb:text-left lb:motion-safe:transition-all lb:flex lb:flex-col lb:justify-between lb:group"
                  >
                    <div>
                      <div className="lb:flex lb:items-center lb:gap-2">
                        <Avatar name={tpl.label} avatar={tpl.avatar} color={tpl.color} size={28} />
                        <span className="lb:font-semibold lb:text-[13px] lb:text-[var(--color-card-foreground)] lb:group-hover:text-[var(--color-primary)]">
                          {tpl.label}
                        </span>
                      </div>
                      <p className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-1 lb:line-clamp-2 lb:leading-relaxed">
                        {tpl.description}
                      </p>
                    </div>
                    <span className="lb:text-xs lb:text-[var(--color-primary)] lb:font-medium lb:mt-2 lb:flex lb:items-center lb:gap-1">
                      {t("useThisTemplate")} <ArrowRightIcon size={11} />
                    </span>
                  </button>
                ))}

                {/* Do zero */}
                <button
                  type="button"
                  onClick={() => handleSelectTemplate(null)}
                  className="lb:p-3 lb:rounded-2xl lb:border-dashed lb:border-[var(--lb-separator)] lb:hover:border-[var(--color-foreground)] lb:bg-transparent lb:text-left lb:motion-safe:transition-all lb:flex lb:flex-col lb:justify-between"
                >
                  <div>
                    <div className="lb:flex lb:items-center lb:gap-2">
                      <Avatar name={t("createFromScratch")} avatar={{ kind: "mascot", value: "luvi" }} size={28} />
                      <span className="lb:font-semibold lb:text-[13px] lb:text-[var(--color-card-foreground)]">
                        {t("createFromScratch")}
                      </span>
                    </div>
                    <p className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-1 lb:leading-relaxed">
                      {t("createFromScratchDesc")}
                    </p>
                  </div>
                  <span className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:font-medium lb:mt-2 lb:flex lb:items-center lb:gap-1">
                    {t("customBadge")} <ArrowRightIcon size={11} />
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Identidade */}
          {step === 2 && (
            <div className="lb:flex lb:flex-col lb:gap-4">
              <div>
                <h3 className="lb-headline">
                  {t("wizardStep2Title")}
                </h3>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
                  {t("wizardStep2Subtitle")}
                </p>
              </div>

              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5">
                <div>
                  <label className="lb-label lb:block lb:mb-1">
                    {t("profileIdentifierLabel")}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={t("profileIdentifierPlaceholder")}
                    required
                    className={`lb:w-full lb:px-3 lb:py-1.5 lb:font-mono lb:rounded-lg ${
                      nameError
                        ? "lb:border-[var(--color-destructive)] lb:bg-[var(--color-destructive)]/10"
                        : "lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]"
                    } lb:text-[var(--color-foreground)] lb:focus:border-[var(--color-primary)] lb:focus:outline-hidden`}
                  />
                  {nameError && (
                    <span className="lb:text-xs lb:text-[var(--color-destructive)] lb:mt-1 lb:block">
                      {nameError}
                    </span>
                  )}
                </div>

                <div>
                  <label className="lb-label lb:block lb:mb-1">
                    {t("visibleNameLabel")}
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t("visibleNamePlaceholder")}
                    className="lb-input"
                  />
                </div>
              </div>

              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5">
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
                    {t("callMeLabel")}
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

              <div className="lb:pt-2">
                <div className="lb-label lb:block lb:mb-2">{t("mascotPickerLabel")}</div>
                <MascotPicker value={avatarKind === "mascot" ? avatarValue : null} color={color}
                  onPick={(id) => { setAvatarKind("mascot"); setAvatarValue(id); }} />
              </div>

              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5 lb:pt-2">
                <div>
                  <label className="lb-label lb:block lb:mb-1">
                    {t("avatarLabel")}
                  </label>
                  <div className="lb:flex lb:items-center lb:gap-2">
                    <input
                      type="text"
                      aria-label={t("avatarLabel")}
                      value={avatarKind === "emoji" ? avatarValue : ""}
                      onChange={(e) => { setAvatarKind("emoji"); setAvatarValue(e.target.value); }}
                      maxLength={4}
                      className="lb:w-16 lb:px-2 lb:py-1.5 lb:text-center lb:text-[15px] lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]"
                    />
                    <div className="lb:flex lb:gap-1">
                      {["👔", "💼", "🎧", "📊", "💻", "🔍", "✍️", "🤖"].map((em) => (
                        <button
                          key={em}
                          type="button"
                          onClick={() => { setAvatarKind("emoji"); setAvatarValue(em); }}
                          className="lb:w-6 lb:h-6 lb:flex lb:items-center lb:justify-center lb:rounded-lg lb:border-[var(--lb-separator)] lb:hover:bg-[var(--lb-fill-2)]"
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

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
                          className={`lb:w-6 lb:h-6 lb:rounded-full lb:motion-safe:transition-transform lb:flex lb:items-center lb:justify-center ${
                            isSelected
                              ? "lb:scale-110 lb:ring-2 lb:ring-offset-2 lb:ring-offset-[var(--background)] lb:ring-[var(--color-foreground)]"
                              : "lb:opacity-80 lb:hover:opacity-100"
                          }`}
                          style={{ backgroundColor: c.hex }}
                        >
                          {isSelected && <span className="lb:w-1.5 lb:h-1.5 lb:rounded-full lb:bg-white" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 3: Diretrizes Operacionais */}
          {step === 3 && (
            <div className="lb:flex lb:flex-col lb:gap-4">
              <div>
                <h3 className="lb-headline">
                  {t("wizardStep3Title")}
                </h3>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
                  {t("wizardStep3Subtitle")}
                </p>
              </div>

              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("operationalDescriptionLabel")}
                </label>
                <div className="lb:p-3 lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-xs lb:text-[var(--color-card-foreground)] lb:leading-relaxed">
                  {description || t("operationalDescriptionDefault")}
                </div>
              </div>

              {/* Informação sobre o motor de regras */}
              <div className="lb:p-3.5 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--color-popover)]/60 lb:flex lb:flex-col lb:gap-2">
                <span className="lb:font-semibold lb:text-[13px] lb:text-[var(--color-card-foreground)] lb:flex lb:items-center lb:gap-1.5">
                  <span className="lb:text-[var(--color-muted-foreground)]">ℹ️</span>
                  <span>{t("technicalRulesNoticeTitle")}</span>
                </span>
                <p className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:leading-relaxed">
                  {t("technicalRulesNotice")}
                </p>
              </div>

              <div>
                <label className="lb-label lb:block lb:mb-1">
                  {t("permanentSoulLabel")}
                </label>
                <div className="lb:p-2.5 lb:font-mono lb:text-xs lb:rounded-lg lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:max-h-32 lb:overflow-y-auto lb:whitespace-pre-wrap">
                  {soul}
                </div>
              </div>
            </div>
          )}

          {/* STEP 4: Modelo de IA */}
          {step === 4 && (
            <div className="lb:flex lb:flex-col lb:gap-4">
              <div>
                <h3 className="lb-headline">
                  {t("wizardStep4Title")}
                </h3>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:mt-0.5">
                  {t("wizardStep4Subtitle")}
                </p>
              </div>

              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3.5">
                <div>
                  <label className="lb-label lb:block lb:mb-1">
                    {t("providerLabel")}
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="lb-input"
                  >
                    <option value="openrouter">{t("providerOpenRouter")}</option>
                    <option value="anthropic">{t("providerAnthropic")}</option>
                    <option value="openai">{t("providerOpenAI")}</option>
                    <option value="nous">{t("providerNous")}</option>
                  </select>
                </div>

                <div>
                  <label className="lb-label lb:block lb:mb-1">
                    {t("modelLabel")}
                  </label>
                  <input
                    type="text"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    placeholder={t("modelPlaceholder")}
                    className="lb-input lb-mono"
                  />
                </div>
              </div>

              <div className="lb:p-3 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-xs lb:text-[var(--color-muted-foreground)]">
                💡 <span className="lb:font-semibold lb:text-[var(--color-foreground)]">LuveBot:</span> {t("connectMinimumNotice")}
              </div>
            </div>
          )}

          {/* STEP 5: O Bot se apresenta (spec 4.6 §7) */}
          {step === 5 && (
            <div className="lb:flex lb:flex-col lb:items-center lb:text-center lb:gap-4 lb:py-2" data-testid="bot-presentation">
              <Avatar name={label || name} avatar={{ kind: avatarKind, value: avatarValue } as BotAvatar} color={color} size={64} />

              <div>
                <span className="lb:px-2.5 lb:py-0.5 lb:rounded-full lb:text-xs lb:font-semibold lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)] lb:border-[var(--color-success)]/30">
                  {t("botCreatedSuccess")}
                </span>
                <h3 className="lb-headline lb:mt-2">
                  {label || name} {t("botReadyToOperate")}
                </h3>
              </div>

              {/* The Bot introduces itself for real (contract v0.4 B4): no sample text */}
              {createdBot && <BotIntroduction bot={createdBot.name} onSession={setCreatedSessionId} />}
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="lb:flex lb:items-center lb:justify-between lb:px-5 lb:py-4 lb:border-t lb:border-[var(--lb-separator)] lb:shrink-0">
          {step > 1 && step < 5 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] lb:motion-safe:transition-colors lb:rounded-full"
            >
              {t("back")}
            </button>
          ) : (
            <div />
          )}

          <div className="lb:flex lb:items-center lb:gap-2">
            {step < 4 && (
              <button
                type="button"
                onClick={() => {
                  if (step === 2 && !PROFILE_NAME_REGEX.test(name)) {
                    setNameError(t("nameInvalid"));
                    return;
                  }
                  setStep((s) => s + 1);
                }}
                disabled={step === 2 && !name}
                className="lb:px-3.5 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:disabled:opacity-50 lb:motion-safe:transition-opacity lb:rounded-full"
              >
                {t("next")}
              </button>
            )}

            {step === 4 && (
              <button
                type="button"
                onClick={handleCreateSubmit}
                disabled={isSubmitting || !name}
                className="lb:px-4 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:disabled:opacity-50 lb:motion-safe:transition-opacity lb:rounded-full"
              >
                {isSubmitting ? t("creatingBotBtn") : t("createBotBtn")}
              </button>
            )}

            {step === 5 && (
              <button
                type="button"
                onClick={handleFinish}
                className="lb:px-4 lb:py-1.5 lb:text-[13px] lb:font-semibold lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity lb:rounded-full"
              >
                {t("startWithThisBot")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
