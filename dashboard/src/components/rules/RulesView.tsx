// dashboard/src/components/rules/RulesView.tsx
// Rules view component (spec §4.10, contract v0.1 §3, ADR-002).
// Invariant 8: Seal is HONEST, derived strictly from backend SealResult (never inferred from rule.level).
// Broken seal displays exact problems and qualifiers.
// Drafts are visually distinct and have NO effect until activated.
// Activation requires human click and is blocked in loopback mode (D-012, loopback_not_human).
// Agent suggestions appear as pending suggestions and can never be active (Red Team 6).
// Builtin rules are immutable.
// Simulator executes POST /rules/simulate and displays decision, winner and hits.

import { SealBadge, SealCaveat } from "./SealBadge";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import type {
  RuleWithSeal,
  Rule,
  SealResult,
  RuleLevel,
  RuleAction,
  Simulation,
  Bot,
} from "../../api/types";
import {
  getRules,
  createRule,
  patchRule,
  simulateRule,
  getSession,
  ApiError,
} from "../../api/client";
import {
  ShieldAlertIcon,
  CheckCircleIcon,
  XIcon,
  RefreshCwIcon,
  PlusIcon,
  PlayIcon,
  CheckIcon,
} from "../Icons";
import { useLuveI18n } from "../../i18n";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { sealVariant, filterRules } from "./seal";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { simReasonLabel } from "../labels";

export interface RulesViewProps {
  botName?: string;
  bots?: Bot[];
  authMode?: "loopback" | "gated";
  initialRules?: RuleWithSeal[];
  onRulesChanged?: () => void;
}

export function RulesView({
  botName,
  bots = [],
  authMode: controlledAuthMode,
  initialRules,
  onRulesChanged,
}: RulesViewProps) {
  const { t } = useLuveI18n();
  const [rulesWithSeals, setRulesWithSeals] = useState<RuleWithSeal[]>(
    initialRules || []
  );
  const [loading, setLoading] = useState<boolean>(!initialRules);
  const [error, setError] = useState<ErrorState | null>(null);
  const [authMode, setAuthMode] = useState<"loopback" | "gated">(
    controlledAuthMode || "gated"
  );
  const [activeTab, setActiveTab] = useState<"regras" | "simulador">("regras");
  const [filterLevel, setFilterLevel] = useState<string>("all");
  const [filterState, setFilterState] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Create Modal
  const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
  const [newLabel, setNewLabel] = useState<string>("");
  const [newLevel, setNewLevel] = useState<RuleLevel>("ask");
  const [newScopeKind, setNewScopeKind] = useState<"global" | "bot">(
    botName ? "bot" : "global"
  );
  const [newScopeRef, setNewScopeRef] = useState<string>(botName || "");
  const [newTools, setNewTools] = useState<string>("");
  const [newCommands, setNewCommands] = useState<string>("");

  const createRuleModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: createModalOpen,
    onClose: () => setCreateModalOpen(false),
  });

  // Simulator State
  const [simBot, setSimBot] = useState<string>(botName || (bots[0]?.name || "vendas"));
  const [simTool, setSimTool] = useState<string>("send_email");
  const [simCommand, setSimCommand] = useState<string>("");
  const [simResult, setSimResult] = useState<Simulation | null>(null);
  const [simLoading, setSimLoading] = useState<boolean>(false);
  const [simError, setSimError] = useState<ErrorState | null>(null);

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const isLoopback = authMode === "loopback";

  // Check session if authMode not passed
  useEffect(() => {
    if (!controlledAuthMode) {
      getSession()
        .then((s) => {
          if (s?.auth_mode) setAuthMode(s.auth_mode);
        })
        .catch(() => {});
    } else {
      setAuthMode(controlledAuthMode);
    }
  }, [controlledAuthMode]);

  // Load rules from backend
  const loadRulesList = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await getRules(undefined, botName);  // a Bot's own page shows that Bot's seals, not the aggregate
      setRulesWithSeals(res?.rules || []);
      onRulesChanged?.();
    } catch (err: unknown) {
      setError(humanError(err, t, "errorLoadingRules"));
    } finally {
      setLoading(false);
    }
  }, [onRulesChanged, t, botName]);

  useEffect(() => {
    if (!initialRules) {
      loadRulesList();
    }
  }, [initialRules, loadRulesList]);

  // Filtered Rules
  const displayedRules = useMemo(
    () => filterRules(rulesWithSeals, { botName, level: filterLevel, state: filterState, query: searchQuery }),
    [rulesWithSeals, botName, filterLevel, filterState, searchQuery]
  );

  // -------------------------------------------------------------------------
  // Handlers for Rule Actions
  // -------------------------------------------------------------------------

  // Activate Draft Rule (D-012: refused in loopback mode)
  const handleActivateRule = async (rule: Rule) => {
    if (isLoopback) {
      setError(t("errorLoopbackRuleBlocked"));
      return;
    }
    if (rule.builtin) return;

    try {
      setIsSubmitting(true);
      setError(null);
      const res = await patchRule({
        id: rule.id,
        version: rule.version,
        state: "active",
      });
      setRulesWithSeals((prev) =>
        prev.map((item) =>
          item.rule.id === rule.id
            ? { ...item, rule: res.rule, seal_result: res.seal_result }
            : item
        )
      );
      setSuccessMsg(t("ruleActivatedSuccess", { label: rule.label }));
      setTimeout(() => setSuccessMsg(null), 4000);
      onRulesChanged?.();
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Convert Suggestion to Draft (Red Team 6)
  const handleReviewSuggestion = async (rule: Rule) => {
    if (rule.builtin) return;
    try {
      setIsSubmitting(true);
      setError(null);
      const res = await patchRule({
        id: rule.id,
        version: rule.version,
        state: "draft",
      });
      setRulesWithSeals((prev) =>
        prev.map((item) =>
          item.rule.id === rule.id
            ? { ...item, rule: res.rule, seal_result: res.seal_result }
            : item
        )
      );
      setSuccessMsg(t("ruleDraftConverted", { label: rule.label }));
      setTimeout(() => setSuccessMsg(null), 4000);
      onRulesChanged?.();
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Archive Rule
  const handleArchiveRule = async (rule: Rule) => {
    if (rule.builtin) return;
    try {
      setIsSubmitting(true);
      setError(null);
      const res = await patchRule({
        id: rule.id,
        version: rule.version,
        state: "archived",
      });
      setRulesWithSeals((prev) =>
        prev.map((item) =>
          item.rule.id === rule.id
            ? { ...item, rule: res.rule, seal_result: res.seal_result }
            : item
        )
      );
      setSuccessMsg(t("ruleArchivedSuccess", { label: rule.label }));
      setTimeout(() => setSuccessMsg(null), 4000);
      onRulesChanged?.();
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Create Draft Rule
  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLabel.trim()) return;

    try {
      setIsSubmitting(true);
      setError(null);
      const toolsList = newTools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const cmdsList = newCommands
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);

      const res = await createRule({
        label: newLabel.trim(),
        level: newLevel,
        scope: {
          kind: newScopeKind,
          ref: newScopeKind === "bot" ? newScopeRef || botName : null,
        },
        match: {
          tools: toolsList.length > 0 ? toolsList : undefined,
          commands: cmdsList.length > 0 ? cmdsList : undefined,
        },
        state: "draft", // Human creation produces draft
      });

      setRulesWithSeals((prev) => [
        { rule: res.rule, seal_result: res.seal_result },
        ...prev,
      ]);
      setCreateModalOpen(false);
      setNewLabel("");
      setNewTools("");
      setNewCommands("");
      setSuccessMsg(t("ruleDraftCreated", { label: res.rule.label }));
      setTimeout(() => setSuccessMsg(null), 4000);
      onRulesChanged?.();
    } catch (err: unknown) {
      handleApiError(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Run Simulator
  const handleRunSimulation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simBot || !simTool) return;

    try {
      setSimLoading(true);
      setSimError(null);
      setSimResult(null);

      const actionPayload: RuleAction = {
        bot: simBot,
        tool: simTool.trim(),
        command: simCommand.trim() || undefined,
      };

      const result = await simulateRule(actionPayload);
      setSimResult(result);
    } catch (err: unknown) {
      setSimError(humanError(err, t, "errorSimulatingRule"));
    } finally {
      setSimLoading(false);
    }
  };

  const handleApiError = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.code === "loopback_not_human" || err.status === 403) {
        setError(t("errorLoopbackRuleBlocked"));
      } else if (err.code === "builtin_immutable") {
        setError(t("errorBuiltinImmutable"));
      } else if (err.code === "stale") {
        setError(t("errorStaleRule"));
      } else {
        setError(humanError(err, t, "errorUnexpectedRule"));
      }
    } else {
      setError(humanError(err, t, "errorUnexpectedRule"));
    }
  };

  // INVARIANTE 8: the seal comes ONLY from SealResult (components/rules/SealBadge.tsx)
  const renderSealBadge = (sealResult?: SealResult) => <SealBadge sealResult={sealResult} />;

  const getLevelLabel = (level: RuleLevel) => {
    switch (level) {
      case "allow":
        return t("levelAllow");
      case "explicit":
        return t("levelExplicit");
      case "ask":
        return t("levelAsk");
      case "handback":
        return t("levelHandback");
      case "block":
        return t("levelBlock");
    }
  };

  const getLevelBadgeClass = (level: RuleLevel) => {
    switch (level) {
      case "block":
        return "lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)]";
      case "handback":
        return "lb:bg-[var(--color-warning)]/15 lb:text-[var(--color-warning)]";
      case "ask":
        return "lb:bg-[var(--color-primary)]/15 lb:text-[var(--color-primary)]";
      case "explicit":
        return "lb:bg-[var(--color-accent)] lb:text-[var(--color-card-foreground)]";
      case "allow":
        return "lb:bg-[var(--color-success)]/15 lb:text-[var(--color-success)]";
    }
  };

  const botLabel = (name: string) => bots.find((b) => b.name === name)?.display?.label || name;
  // Where a rule applies, in words: never the scope code or a profile slug.
  const scopeText = (scope: { kind: string; ref?: string | null }) =>
    scope.kind === "global" ? t("ruleScopeGlobal")
      : scope.kind === "bot" ? botLabel(scope.ref || "")
      : scope.kind === "room" ? t("ruleScopeRoom", { name: scope.ref || "" })
      : scope.kind === "routine" ? t("ruleScopeRoutine", { name: scope.ref || "" })
      : scope.kind;

  return (
    <div className="lb:flex lb:flex-col lb:h-full lb:w-full lb:overflow-hidden lb:bg-[var(--background)] lb:text-[var(--color-foreground)]">
      {/* View Header */}
      <header className="lb:px-6 lb:pt-6 lb:pb-2 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-3 lb:shrink-0">
        <div>
          <h1 className="lb-large-title">
            {botName ? t("rulesTitleBot", { bot: botLabel(botName) }) : t("rulesTitle")}
          </h1>
          <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
            {t("rulesSubtitle")}
          </p>
        </div>

        <div className="lb:flex lb:items-center lb:gap-2">
          {/* View Tab Switcher: Regras vs Simulador */}
          <div role="tablist" aria-label={t("rulesTabRules", { count: displayedRules.length })} className="lb-segmented">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "regras"}
              onClick={() => setActiveTab("regras")}
              className="lb-segment" style={{ padding: "0 12px", flex: "none" }}
            >
              {t("rulesTabRules", { count: displayedRules.length })}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "simulador"}
              onClick={() => setActiveTab("simulador")}
              className="lb-segment" style={{ padding: "0 12px", flex: "none" }}
            >
              {t("rulesTabSimulator")}
            </button>
          </div>

          {/* New Rule Button */}
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 lb:motion-safe:transition-opacity focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
          >
            <PlusIcon size={13} />
            <span>{t("newRuleBtn")}</span>
          </button>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={loadRulesList}
            disabled={loading}
            aria-label={t("refreshRules")}
            className="lb:p-1.5 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] disabled:lb:opacity-50"
          >
            <RefreshCwIcon size={14} className={loading ? "lb:animate-spin" : ""} />
          </button>
        </div>
      </header>

      {/* Loopback Warning Banner */}
      {isLoopback && (
        <div
          role="alert"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2.5 lb:text-[13px] lb:shrink-0"
        >
          <ShieldAlertIcon size={16} className="lb:shrink-0" />
          <span>{t("loopbackWarningRules")}</span>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div
          role="alert"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-destructive)]/15 lb:border-b lb:border-[var(--color-destructive)]/30 lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:justify-between lb:gap-2 lb:text-[13px] lb:shrink-0"
        >
          <span><ErrorNote error={error} /></span>
          <button type="button" onClick={() => setError(null)} aria-label={t("closeError")}>
            <XIcon size={14} />
          </button>
        </div>
      )}

      {/* Success Status */}
      {successMsg && (
        <div
          role="status"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-success)]/15 lb:border-b lb:border-[var(--color-success)]/30 lb:text-[var(--color-success)] lb:flex lb:items-center lb:gap-2 lb:text-[13px] lb:shrink-0"
        >
          <CheckIcon size={14} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* TAB 1: REGRAS LIST */}
      {activeTab === "regras" && (
        <div className="lb:flex lb:flex-col lb:flex-1 lb:overflow-hidden">
          {/* Filters Bar */}
          <div className="lb:px-4 lb:py-2.5 lb:border-b lb:border-[var(--lb-separator)] lb:bg-[var(--color-card)]/50 lb:flex lb:flex-wrap lb:items-center lb:justify-between lb:gap-2 lb:shrink-0">
            <div className="lb:flex lb:items-center lb:gap-2 lb:flex-wrap">
              {/* Search */}
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("searchRulesPlaceholder")}
                className="lb:px-2.5 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] lb:w-80 focus:lb:outline-none focus:lb:border-[var(--color-primary)]"
              />

              {/* Level Filter */}
              <select
                aria-label={t("filterByLevel")}
                value={filterLevel}
                onChange={(e) => setFilterLevel(e.target.value)}
                className="lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]"
              >
                <option value="all">{t("filterAllLevels")}</option>
                <option value="block">{t("levelBlock")}</option>
                <option value="handback">{t("levelHandback")}</option>
                <option value="ask">{t("levelAsk")}</option>
                <option value="explicit">{t("levelExplicit")}</option>
                <option value="allow">{t("levelAllow")}</option>
              </select>

              {/* State Filter */}
              <select
                aria-label={t("filterByState")}
                value={filterState}
                onChange={(e) => setFilterState(e.target.value)}
                className="lb:px-2 lb:py-1 lb:rounded-xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:text-[13px] lb:text-[var(--color-foreground)] focus:lb:outline-none focus:lb:border-[var(--color-primary)]"
              >
                <option value="all">{t("filterAllStates")}</option>
                <option value="active">{t("filterActive")}</option>
                <option value="draft">{t("filterDrafts")}</option>
                <option value="suggestion">{t("filterSuggestions")}</option>
                <option value="archived">{t("filterArchived")}</option>
              </select>
            </div>

            <div className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("precedenceRuleText")}
            </div>
          </div>

          {/* Rules Cards Container */}
          <div className="lb:flex-1 lb:overflow-y-auto lb:p-4 lb:space-y-3 luvebot-scroll-container">
            {displayedRules.length === 0 && !loading && (
              <div
                data-testid="rules-empty-state"
                className="lb:p-12 lb:text-center lb:flex lb:flex-col lb:items-center lb:justify-center lb:gap-2 lb:border-dashed lb:border-[var(--lb-separator)] lb:rounded-2xl lb:bg-[var(--color-card)]/50"
              >
                <CheckCircleIcon size={24} className="lb:text-[var(--color-muted-foreground)]" />
                <h3 className="lb-headline">
                  {t("noRulesFoundTitle")}
                </h3>
                <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                  {t("noRulesFoundDesc")}
                </p>
                <button
                  type="button"
                  onClick={() => setCreateModalOpen(true)}
                  className="lb:mt-2 lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3 lb:py-1.5 lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:text-[13px] lb:font-semibold lb:hover:opacity-90 lb:motion-safe:transition-opacity lb:min-h-11 lb:md:min-h-7 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
                >
                  <PlusIcon size={14} />
                  <span>{t("newRuleBtn")}</span>
                </button>
              </div>
            )}

            {displayedRules.map(({ rule, seal_result }) => {
              const isDraft = rule.state === "draft";
              const isSuggestion = rule.state === "suggestion";
              const isBuiltin = rule.builtin;
              const isBroken = seal_result?.seal === "broken";
              const hasProblems = seal_result?.problems && seal_result.problems.length > 0;

              return (
                <div
                  key={rule.id}
                  data-testid={`rule-card-${rule.id}`}
                  className={`lb:rounded-2xl lb:p-4 lb:flex lb:flex-col lb:gap-3 lb:motion-safe:transition-colors ${
                    isDraft
                      ? "lb:border-dashed lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-card)]/80"
                      : isSuggestion
                      ? "lb:border-dashed lb:border-[var(--color-primary)]/40 lb:bg-[var(--color-card)]/80"
                      : isBroken
                      ? "lb:border-[var(--color-destructive)]/40 lb:bg-[var(--lb-fill)]"
                      : "lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)]"
                  }`}
                >
                  {/* Card Header */}
                  <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
                    <div className="lb:flex lb:items-center lb:gap-2 lb:flex-wrap">
                      {/* Level Badge */}
                      <span
                        className={`lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-[13px] lb:font-bold ${getLevelBadgeClass(
                          rule.level
                        )}`}
                      >
                        {getLevelLabel(rule.level)}
                      </span>

                      {/* Rule Label */}
                      <h3 className="lb:text-[13px] lb:font-bold lb:text-[var(--color-card-foreground)]">
                        {rule.label}
                      </h3>

                      {/* Builtin Badge */}
                      {isBuiltin && (
                        <span
                          data-testid="badge-builtin"
                          className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--lb-fill)] lb:text-[var(--color-muted-foreground)] lb:border-[var(--lb-separator)]"
                        >
                          {t("badgeBuiltin")}
                        </span>
                      )}

                      {/* Draft Badge (Visually distinct & sem efeito) */}
                      {isDraft && (
                        <span
                          data-testid="badge-draft"
                          className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--color-warning)]/15 lb:text-[var(--color-warning)] lb:border-[var(--color-warning)]/30"
                        >
                          {t("badgeDraft")}
                        </span>
                      )}

                      {/* Suggestion Badge (Never active - Red Team 6) */}
                      {isSuggestion && (
                        <span
                          data-testid="badge-suggestion"
                          className="lb:inline-flex lb:items-center lb:gap-1 lb:px-2 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-semibold lb:bg-[var(--color-primary)]/15 lb:text-[var(--color-primary)] lb:border-[var(--color-primary)]/30"
                        >
                          {t("badgeSuggestion")}
                        </span>
                      )}

                      {/* Scope Badge */}
                      <span className="lb-pill lb-caption">
                        {scopeText(rule.scope)}
                      </span>
                    </div>

                    {/* Selo Honesto (Invariante 8) */}
                    <div className="lb:shrink-0">{renderSealBadge(seal_result)}</div>
                  </div>

                  {/* Card Match Criteria */}
                  <div className="lb:space-y-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                    {rule.match.tools && rule.match.tools.length > 0 && (
                      <div className="lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap">
                        <span className="lb:font-medium">{t("toolsLabel")}</span>
                        {rule.match.tools.map((toolName) => (
                          <span
                            key={toolName}
                            className="lb:font-mono lb:text-xs lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--background)] lb:border-[var(--lb-separator)]"
                          >
                            {toolName}
                          </span>
                        ))}
                      </div>
                    )}

                    {rule.match.commands && rule.match.commands.length > 0 && (
                      <div className="lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap">
                        <span className="lb:font-medium">{t("commandsLabel")}</span>
                        {rule.match.commands.map((cmd) => (
                          <span
                            key={cmd}
                            className="lb:font-mono lb:text-xs lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--background)] lb:border-[var(--lb-separator)]"
                          >
                            {cmd}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* A real HAND or LOCK by a command pattern: what it covers (the "pattern" qualifier) */}
                  <SealCaveat sealResult={seal_result} />

                  {/* Broken State: Display exact problems and qualifiers */}
                  {(isBroken || hasProblems) && (
                    <div
                      data-testid={`rule-problems-${rule.id}`}
                      className="lb:p-2.5 lb:rounded-xl lb:bg-[var(--color-destructive)]/10 lb:border-[var(--color-destructive)]/30 lb:space-y-1 lb:text-[13px]"
                    >
                      <div className="lb:font-semibold lb:text-[var(--color-destructive)] lb:flex lb:items-center lb:gap-1.5">
                        <span>{t("problemsDetectedTitle")}</span>
                      </div>
                      <ul className="lb:list-disc lb:list-inside lb:space-y-0.5 lb:text-[var(--color-destructive)]">
                        {seal_result?.problems?.map((p, idx) => (
                          <li key={idx}>
                            <code className="lb:font-mono lb:font-bold">{p.code}</code>:{" "}
                            {p.detail}
                          </li>
                        ))}
                      </ul>
                      {seal_result?.qualifiers && seal_result.qualifiers.length > 0 && (
                        <div className="lb:text-xs lb:text-[var(--color-muted-foreground)] lb:mt-1">
                          {t("qualifiersLabel")}{" "}
                          <span className="lb:font-mono">
                            {seal_result.qualifiers.join(", ")}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Actions Bar */}
                  <div className="lb:pt-2 lb:border-t lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:gap-2">
                    <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                      {isBuiltin
                        ? t("statusBuiltinProtection")
                        : isDraft
                        ? t("statusDraftInactive")
                        : isSuggestion
                        ? t("statusHumanReviewNeeded")
                        : t("statusActiveVersion", { version: rule.version })}
                    </span>

                    <div className="lb:flex lb:items-center lb:gap-2">
                      {/* Activate Draft (Disabled in loopback per D-012) */}
                      {isDraft && (
                        <button
                          type="button"
                          disabled={isLoopback || isSubmitting}
                          title={
                            isLoopback
                              ? t("errorLoopbackRuleBlocked")
                              : undefined
                          }
                          onClick={() => handleActivateRule(rule)}
                          className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full"
                        >
                          {t("activateRuleBtn")}
                        </button>
                      )}

                      {/* Convert Suggestion to Draft (Red Team 6) */}
                      {isSuggestion && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => handleReviewSuggestion(rule)}
                          className="lb:px-2.5 lb:py-1 lb:text-[13px] lb:font-medium lb:border-[var(--color-primary)] lb:text-[var(--color-primary)] lb:hover:bg-[var(--color-primary)]/10 lb:rounded-full"
                        >
                          {t("reviewAsDraftBtn")}
                        </button>
                      )}

                      {/* Archive (Only for custom rules) */}
                      {!isBuiltin && rule.state !== "archived" && (
                        <button
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => handleArchiveRule(rule)}
                          className="lb:px-2 lb:py-1 lb:text-[13px] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-destructive)] lb:rounded-full"
                        >
                          {t("archiveBtn")}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 2: SIMULADOR (Spec §4.10) */}
      {activeTab === "simulador" && (
        <div className="lb:flex-1 lb:overflow-y-auto lb:p-6 lb:space-y-6 luvebot-scroll-container">
          <div className="lb:max-w-2xl lb:mx-auto lb:space-y-5">
            <div>
              <h2 className="lb-title">
                {t("simulatorTitle")}
              </h2>
              <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                {t("simulatorSubtitle")}
              </p>
            </div>

            {/* Simulation Input Form */}
            <form
              onSubmit={handleRunSimulation}
              className="lb:p-4 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-4"
            >
              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3">
                <div>
                  <label
                    htmlFor="sim-bot-select"
                    className="lb-label lb:block lb:mb-1"
                  >
                    {t("simBotLabel")}
                  </label>
                  <select
                    id="sim-bot-select"
                    value={simBot}
                    onChange={(e) => setSimBot(e.target.value)}
                    className="lb-input"
                  >
                    {bots.length > 0 ? (
                      bots.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.display?.label || b.name}
                        </option>
                      ))
                    ) : (
                      <option value="vendas">vendas</option>
                    )}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="sim-tool-input"
                    className="lb-label lb:block lb:mb-1"
                  >
                    {t("simToolLabel")}
                  </label>
                  <input
                    id="sim-tool-input"
                    type="text"
                    required
                    value={simTool}
                    onChange={(e) => setSimTool(e.target.value)}
                    placeholder={t("simToolPlaceholder")}
                    className="lb-input"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="sim-command-input"
                  className="lb-label lb:block lb:mb-1"
                >
                  {t("simCommandLabel")}
                </label>
                <input
                  id="sim-command-input"
                  type="text"
                  value={simCommand}
                  onChange={(e) => setSimCommand(e.target.value)}
                  placeholder={t("simCommandPlaceholder")}
                  className="lb-input"
                />
              </div>

              <div className="lb:flex lb:justify-end">
                <button
                  type="submit"
                  disabled={simLoading || !simTool.trim()}
                  className="lb:inline-flex lb:items-center lb:gap-1.5 lb:px-3.5 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 lb:rounded-full"
                >
                  <PlayIcon size={12} />
                  <span>{simLoading ? t("simEvaluating") : t("simEvaluateBtn")}</span>
                </button>
              </div>
            </form>

            {simError && (
              <div
                role="alert"
                className="lb:p-3 lb:rounded-xl lb:bg-[var(--color-destructive)]/15 lb:text-[var(--color-destructive)] lb:text-[13px]"
              >
                <ErrorNote error={simError} />
              </div>
            )}

            {/* Simulation Results Display */}
            {simResult && (
              <div
                data-testid="simulation-result"
                className="lb:p-5 lb:rounded-2xl lb:border-[var(--lb-separator)] lb:bg-[var(--lb-fill)] lb:space-y-4 lb:animate-in lb:fade-in"
              >
                <div className="lb:flex lb:items-center lb:justify-between lb:border-b lb:border-[var(--lb-separator)] lb:pb-3">
                  <div>
                    <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                      {t("simResultEvaluation")}
                    </span>
                    <div className="lb:flex lb:items-center lb:gap-2 lb:mt-0.5">
                      <span
                        className={`lb:px-2.5 lb:py-0.5 lb:rounded-lg lb:text-[13px] lb:font-bold ${getLevelBadgeClass(
                          simResult.decision.effect
                        )}`}
                      >
                        {getLevelLabel(simResult.decision.effect)}
                      </span>
                    </div>
                  </div>

                  {simResult.decision.winner && (
                    <div className="lb:text-right">
                      <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                        {t("simWinningRuleLabel")}
                      </span>
                      <div className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)]">
                        {simResult.decision.winner.rule_id}
                      </div>
                    </div>
                  )}
                </div>

                {simResult.decision.reason && (
                  <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                    <strong>{t("simReasonLabel")}</strong> {simReasonLabel(simResult.decision.reason, t)}
                  </p>
                )}

                {/* Hits List */}
                <div>
                  <h4 className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)] lb:mb-2">
                    {t("simMatchingRulesTitle", { count: simResult.decision.hits?.length || 0 })}
                  </h4>
                  {simResult.decision.hits && simResult.decision.hits.length > 0 ? (
                    <div className="lb:space-y-2">
                      {simResult.decision.hits.map((hit, idx) => (
                        <div
                          key={idx}
                          className="lb:p-2.5 lb:rounded-lg lb:bg-[var(--lb-fill)] lb:border-[var(--lb-separator)] lb:flex lb:items-center lb:justify-between lb:text-[13px]"
                        >
                          <div className="lb:flex lb:items-center lb:gap-2">
                            <span
                              className={`lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:text-xs lb:font-bold ${getLevelBadgeClass(
                                hit.level
                              )}`}
                            >
                              {hit.level}
                            </span>
                            <span className="lb:font-semibold lb:text-[var(--color-card-foreground)]">
                              {hit.rule_id}
                            </span>
                            <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                              {t("simMatchedOn", { pattern: hit.matched_on })}
                            </span>
                          </div>
                          <span className="lb-caption lb:text-[var(--color-muted-foreground)]">
                            {scopeText(hit.scope)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                      {t("simNoMatchingRules")}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Modal: Create Rule (Produces Draft)                                  */}
      {/* -------------------------------------------------------------------- */}
      {createModalOpen && (
        <div
          ref={createRuleModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-rule-title"
          className="lb-dialog-overlay"
        >
          <form
            onSubmit={handleCreateRule}
            className="lb-dialog lb:max-w-md lb:p-5 lb:space-y-4 lb:overflow-y-auto"
          >
            <div className="lb:flex lb:items-start lb:justify-between lb:gap-2">
              <h2
                id="create-rule-title"
                className="lb-title"
              >
                {t("newRuleModalTitle")}
              </h2>
              <button
                type="button"
                aria-label={t("close")}
                onClick={() => setCreateModalOpen(false)}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("newRuleModalDesc")}
            </p>

            <div>
              <label
                htmlFor="new-rule-label"
                className="lb-label lb:block lb:mb-1"
              >
                {t("ruleLabelInput")}
              </label>
              <input
                id="new-rule-label"
                type="text"
                required
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("ruleLabelPlaceholder")}
                className="lb-input"
              />
            </div>

            <div>
              <label
                htmlFor="new-rule-level"
                className="lb-label lb:block lb:mb-1"
              >
                {t("ruleLevelInput")}
              </label>
              <select
                id="new-rule-level"
                value={newLevel}
                onChange={(e) => setNewLevel(e.target.value as RuleLevel)}
                className="lb-input"
              >
                <option value="block">{t("levelBlock")}</option>
                <option value="handback">{t("levelHandback")}</option>
                <option value="ask">{t("levelAsk")}</option>
                <option value="explicit">{t("levelExplicit")}</option>
                <option value="allow">{t("levelAllow")}</option>
              </select>
            </div>

            <div className="lb:grid lb:grid-cols-2 lb:gap-3">
              <div>
                <label
                  htmlFor="new-rule-scope"
                  className="lb-label lb:block lb:mb-1"
                >
                  {t("ruleScopeKindInput")}
                </label>
                <select
                  id="new-rule-scope"
                  value={newScopeKind}
                  onChange={(e) => setNewScopeKind(e.target.value as any)}
                  className="lb-input"
                >
                  <option value="global">{t("scopeGlobal")}</option>
                  <option value="bot">{t("scopeBot")}</option>
                </select>
              </div>

              {newScopeKind === "bot" && (
                <div>
                  <label
                    htmlFor="new-rule-bot-ref"
                    className="lb-label lb:block lb:mb-1"
                  >
                    {t("targetBotInput")}
                  </label>
                  <input
                    id="new-rule-bot-ref"
                    type="text"
                    value={newScopeRef}
                    onChange={(e) => setNewScopeRef(e.target.value)}
                    placeholder="vendas"
                    className="lb-input"
                  />
                </div>
              )}
            </div>

            <div>
              <label
                htmlFor="new-rule-tools"
                className="lb-label lb:block lb:mb-1"
              >
                {t("toolsMatchInput")}
              </label>
              <input
                id="new-rule-tools"
                type="text"
                value={newTools}
                onChange={(e) => setNewTools(e.target.value)}
                placeholder={t("toolsMatchPlaceholder")}
                className="lb-input"
              />
            </div>

            <div>
              <label
                htmlFor="new-rule-commands"
                className="lb-label lb:block lb:mb-1"
              >
                {t("commandsMatchInput")}
              </label>
              <input
                id="new-rule-commands"
                type="text"
                value={newCommands}
                onChange={(e) => setNewCommands(e.target.value)}
                placeholder={t("commandsMatchPlaceholder")}
                className="lb-input"
              />
            </div>

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={() => setCreateModalOpen(false)}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:border-[var(--lb-separator)] lb:text-[var(--color-muted-foreground)] lb:hover:text-[var(--color-foreground)] focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("cancelBtn")}
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !newLabel.trim()}
                className="lb:px-3 lb:py-1.5 lb:text-[13px] lb:font-medium lb:bg-[var(--color-foreground)] lb:text-[var(--color-background)] lb:hover:opacity-90 disabled:lb:opacity-50 focus-visible:lb:ring-2 focus-visible:lb:ring-[var(--color-primary)] focus-visible:lb:outline-none lb:rounded-full"
              >
                {t("createDraftBtn")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default RulesView;
