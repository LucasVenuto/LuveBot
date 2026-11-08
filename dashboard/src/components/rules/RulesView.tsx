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
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type {
  RuleWithSeal,
  Rule,
  SealResult,
  RuleLevel,
  RuleAction,
  Simulation,
  Bot,
  RuleSuggestion,
} from "../../api/types";
import { noLoginOf } from "../../lib/authMode";
import { visibleTokens } from "../../lib/hiddenChars";
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
import { sealVariant, filterRules, onlyFreeMode } from "./seal";
import { HermesGateRow } from "./HermesGate";
import { HookUpdate } from "../agent/HookUpdate";
import { ConditionCaveats, ConditionFields, ConditionLines, RuleRecipientWarning, conditionFor, editorCondition, problemWords, toolsFor, type CondKind } from "./RuleConditions";
import { RuleSuggestions, suggestionKey } from "./RuleSuggestions";
import { ErrorNote, humanError, type ErrorState } from "../ui/ErrorNote";
import { simReasonLabel } from "../labels";
import { TechnicalDetail } from "../ui/TechnicalDetail";

export interface RulesViewProps {
  botName?: string;
  bots?: Bot[];
  authMode?: string;
  initialRules?: RuleWithSeal[];
  onRulesChanged?: () => void;
  /** "Revisar e ativar" (v0.11 11, AA-2): the id of the draft the person came to read. On arrival a banner stands above its card and the focus goes to its heading, never to "Ativar"; nothing is turned on by arriving. */
  openDraft?: string | null;
}

export function RulesView({
  botName,
  bots = [],
  authMode: controlledAuthMode,
  initialRules,
  onRulesChanged,
  openDraft,
}: RulesViewProps) {
  const { t } = useLuveI18n();
  const [rulesWithSeals, setRulesWithSeals] = useState<RuleWithSeal[]>(
    initialRules || []
  );
  const [loading, setLoading] = useState<boolean>(!initialRules);
  const [error, setError] = useState<ErrorState | null>(null);
  const [authMode, setAuthMode] = useState<string>(
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
  const [createError, setCreateError] = useState<ErrorState | null>(null);   // a refusal of the editor (422), said INSIDE it, where the person can fix it
  const [newCondKind, setNewCondKind] = useState<CondKind>("");   // a path or recipient condition (rules-conditions-v0 22a, 22b)
  const [newCondValue, setNewCondValue] = useState<string>("");

  // A suggestion the editor was opened from (contract v0.8 §5): what is saved is a DRAFT; the suggestion is hidden for the rest of the visit
  const [fromSuggestion, setFromSuggestion] = useState<RuleSuggestion | null>(null);
  const [leftBehind, setLeftBehind] = useState(0);   // conditions of a suggestion's draft the editor could not carry
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());

  // a condition goes only with the tools whose adapter reads its fact: choosing one offers them when the tools field is empty
  const chooseCondKind = (kind: CondKind) => {
    setNewCondKind(kind);
    if (kind && !newTools.trim()) setNewTools(toolsFor(kind).join(", "));
  };

  const closeCreateModal = () => {
    if (fromSuggestion) { setNewLabel(""); setNewTools(""); setNewCommands(""); setNewLevel("ask"); setNewCondKind(""); setNewCondValue(""); }   // what a suggestion filled in does not leak into the next editor
    setCreateModalOpen(false);
    setFromSuggestion(null);
    setLeftBehind(0);
    setCreateError(null);
  };
  const createRuleModalRef = useFocusTrap<HTMLDivElement>({
    isOpen: createModalOpen,
    onClose: closeCreateModal,
  });

  // "Criar regra" on a suggestion: the editor opens prefilled from its draft preview, as the same draft "Sempre permitir…" makes
  const openFromSuggestion = (s: RuleSuggestion & { draft_preview: Rule }) => {
    const d = s.draft_preview;
    setNewLabel(d.label);
    setNewLevel(d.level);
    setNewScopeKind(d.scope.kind === "bot" ? "bot" : "global");
    setNewScopeRef(d.scope.kind === "bot" ? d.scope.ref || s.bot : "");
    setNewTools((d.match.tools || []).join(", "));
    setNewCommands((d.match.commands || []).join(", "));
    const cond = editorCondition(d);   // the draft's condition goes into the editor too: a suggestion must not turn into a wider rule than it says
    setNewCondKind(cond.kind); setNewCondValue(cond.value); setLeftBehind(cond.left);
    setFromSuggestion(s);
    setCreateModalOpen(true);
  };

  // Simulator State
  const [simBot, setSimBot] = useState<string>(botName || (bots[0]?.name || "vendas"));
  const [simTool, setSimTool] = useState<string>("send_email");
  const [simCommand, setSimCommand] = useState<string>("");
  const [simPath, setSimPath] = useState<string>("");
  const [simRecipient, setSimRecipient] = useState<string>("");
  const [simResult, setSimResult] = useState<Simulation | null>(null);
  const [simLoading, setSimLoading] = useState<boolean>(false);
  const [simError, setSimError] = useState<ErrorState | null>(null);

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // "Revisar e ativar" (AA-2): the draft of an "Always allow" the person came for; the heading of its card takes the focus once the list is there
  const [arrived, setArrived] = useState<string | null>(openDraft ?? null);
  useEffect(() => { if (openDraft) setArrived(openDraft); }, [openDraft]);
  const arrivedHeading = useRef<HTMLHeadingElement | null>(null);
  const arrivedHandled = useRef(false);
  const [arrivedGone, setArrivedGone] = useState(false);       // the draft is not waiting any more (turned on elsewhere, archived): said, never a card that says otherwise
  const bannerId = React.useId();
  const [activatedHere, setActivatedHere] = useState<ReadonlySet<string>>(new Set());   // "Regra ativa: vale sempre para {bot}" stands in the card the person just turned on
  const [unapplied, setUnapplied] = useState<{ rule: Rule; bots: string[] } | null>(null);   // 409 not_applied: the rules are not installed in those Bots; turning on goes ahead only with a second, explicit click

  // No login (loopback) or the deployment token (a machine): neither activates a rule (v0.11 5.1). The words differ and are never swapped.
  const noLoginKind = noLoginOf(authMode);
  const noLogin = noLoginKind !== null;
  const ruleBlocked = noLoginKind === "deployment" ? t("errCredentialNotHuman") : t("errorLoopbackRuleBlocked");

  // Check session if authMode not passed
  useEffect(() => {
    if (!controlledAuthMode) {
      getSession()
        .then((s) => {
          setAuthMode(s?.auth_mode ?? "unreadable");           // only `gated` is a person (v0.11 5.1): a session that answers no mode is not one
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

  // The arrival of "Revisar e ativar": once the list is here, the focus goes to the heading of the draft's card (a heading is not a control: Enter does nothing there);
  // a draft that is no longer one is said, in a line, and no banner claims it still waits.
  useEffect(() => {
    if (!arrived || loading || arrivedHandled.current) return;
    const there = rulesWithSeals.find((item) => item.rule.id === arrived);
    if (there && there.rule.state === "draft") {
      if (!arrivedHeading.current) return;
      arrivedHeading.current.focus();
    } else setArrivedGone(true);
    arrivedHandled.current = true;
  }, [arrived, loading, rulesWithSeals]);
  // What an "Always allow" draft covers, in ONE sentence chosen by the engine's `covers` (A-286), never by this screen's reading of the pattern (A-255); a value it does not know, or none, gets the neutral sentence that is true of every rule
  const coverage = (rule: Rule) => {
    const bot = botShown(rule), tool = (rule.match.tools ?? []).map(visibleTokens).join(", ");
    switch (rule.covers) {
      case "wider": return t("alwaysCoversMore");
      case "command": return t("alwaysCoversExact", { bot });
      case "facts": return tool ? t("alwaysCoversFacts", { tool, bot }) : t("alwaysCoversNeutral", { bot });
      case "tool": return tool ? t("alwaysCoversTool", { tool, bot }) : t("alwaysCoversNeutral", { bot });
      default: return t("alwaysCoversNeutral", { bot });
    }
  };
  const botNamed = (name: string) => visibleTokens(bots.find((b) => b.name === name)?.display?.label || name);
  const botShown = (rule: Rule) => botNamed(rule.scope.kind === "bot" && rule.scope.ref ? rule.scope.ref : botName ?? "");

  // -------------------------------------------------------------------------
  // Handlers for Rule Actions
  // -------------------------------------------------------------------------

  // Activate Draft Rule (D-012: refused in loopback mode)
  const handleActivateRule = async (rule: Rule, acceptUnapplied = false) => {
    if (noLogin) {
      setError(ruleBlocked);
      return;
    }
    if (rule.builtin) return;

    try {
      setIsSubmitting(true);
      setError(null);
      const res = await patchRule({
        id: rule.id,
        version: rule.version,   // the version of the card the person is reading: a draft that changed since is refused (409), never turned on
        state: "active",
        ...(acceptUnapplied ? { accept_unapplied: true } : {}),
      });
      setUnapplied(null);
      if (rule.origin === "always_allow") setActivatedHere((prev) => new Set(prev).add(rule.id));
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
      if (err instanceof ApiError && err.code === "not_applied") {
        const named = err.details?.bots;
        setUnapplied({ rule, bots: Array.isArray(named) ? named.filter((n): n is string => typeof n === "string") : [] });   // asked again, in words: nothing was turned on
      } else handleApiError(err);
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
      setCreateError(null);
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
          conditions: (() => { const c = conditionFor(newCondKind, newCondValue); return c ? [c] : undefined; })(),
        },
        state: "draft", // Human creation produces draft
      });

      setRulesWithSeals((prev) => [
        { rule: res.rule, seal_result: res.seal_result },
        ...prev,
      ]);
      if (fromSuggestion) setHandled((h) => new Set(h).add(suggestionKey(fromSuggestion)));
      closeCreateModal();
      setNewLabel("");
      setNewTools("");
      setNewCommands("");
      setNewCondKind("");
      setNewCondValue("");
      setSuccessMsg(t("ruleDraftCreated", { label: res.rule.label }));
      setTimeout(() => setSuccessMsg(null), 4000);
      onRulesChanged?.();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 422) setCreateError(humanError(err, t, "errorUnexpectedRule"));   // the editor stays open on it
      else handleApiError(err);
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
        facts: simPath.trim() || simRecipient.trim()
          ? { ...(simPath.trim() ? { path: simPath.trim() } : {}), ...(simRecipient.trim() ? { recipient: simRecipient.trim() } : {}) }
          : undefined,
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
      if (err.code === "credential_not_human") {
        setError(humanError(err, t, "errorLoadingRules"));          // a sign-in LuveBot does not take for a person (the deployment token, or an unknown provider), not "this dashboard has no login"
      } else if (err.code === "loopback_not_human" || err.status === 403) {
        setError(t("errorLoopbackRuleBlocked"));
      } else if (err.code === "builtin_immutable") {
        setError(t("errorBuiltinImmutable"));
      } else if (err.code === "stale") {
        setError(t("errorStaleRule"));
      } else if (err.code === "stale_version") {
        void loadRulesList();                       // the card is read again, so what the person reads is what changed; nothing is turned on
        setError(t("ruleChangedReadAgain"));
      } else {
        setError(humanError(err, t, "errorUnexpectedRule"));
      }
    } else {
      setError(humanError(err, t, "errorUnexpectedRule"));
    }
  };

  // INVARIANTE 8: the seal comes ONLY from SealResult (components/rules/SealBadge.tsx)
  const renderSealBadge = (sealResult?: SealResult) => <SealBadge sealResult={sealResult} />;

  // the backend's winner is the rule id (backend/rules.py Decision.winner: str); an older shape sent the hit itself
  const winnerId = (w: unknown): string | null => typeof w === "string" ? w : (w && typeof (w as { rule_id?: unknown }).rule_id === "string" ? (w as { rule_id: string }).rule_id : null);
  const ruleName = (id: string) => visibleTokens(rulesWithSeals.find((item) => item.rule.id === id)?.rule.label || id);

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
            onClick={() => { setFromSuggestion(null); setCreateError(null); setCreateModalOpen(true); }}
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
      {noLogin && (
        <div
          role="alert"
          className="lb:px-4 lb:py-2.5 lb:bg-[var(--color-warning)]/15 lb:border-b lb:border-[var(--color-warning)]/30 lb:text-[var(--color-warning)] lb:flex lb:items-center lb:gap-2.5 lb:text-[13px] lb:shrink-0"
        >
          <ShieldAlertIcon size={16} className="lb:shrink-0" />
          <span>{noLoginKind === "deployment" ? t("errCredentialNotHuman") : t("loopbackWarningRules")}</span>
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
            {arrivedGone && <p role="status" className="lb:m-0 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">{t("alwaysArrivedGone")}</p>}
            {unapplied && (
              <div role="alert" className="lb:p-3 lb:rounded-xl lb:border lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-warning)]/10 lb:flex lb:flex-wrap lb:items-center lb:gap-2 lb:text-[13px]">
                <span style={{ overflowWrap: "anywhere" }}>{t("ruleNotAppliedHead", { bots: unapplied.bots.map(botNamed).join(", ") })}</span>
                <button type="button" className="lb-btn" disabled={isSubmitting} onClick={() => void handleActivateRule(unapplied.rule, true)}>{t("ruleActivateUnapplied")}</button>
                <button type="button" className="lb-btn lb-btn-plain" onClick={() => setUnapplied(null)}>{t("alwaysModalCancel")}</button>
              </div>
            )}
            <RuleSuggestions bots={bots} botName={botName} refreshKey={rulesWithSeals.length} handled={handled} onCreate={openFromSuggestion} />

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
              const calmFree = isBroken && onlyFreeMode(seal_result);  // Free mode: the seal stays broken, the reason is said calmly

              const isArrived = rule.id === arrived;
              const fromAlways = rule.origin === "always_allow";
              return (
                <React.Fragment key={rule.id}>
                {isArrived && isDraft && (
                  <div id={bannerId} role="note" className="lb:p-3 lb:rounded-xl lb:border lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-warning)]/10 lb:text-[13px] lb:font-medium" style={{ overflowWrap: "anywhere" }}>
                    {t("alwaysArrivedBanner")}
                  </div>
                )}
                <div
                  data-testid={`rule-card-${rule.id}`}
                  className={`lb:rounded-2xl lb:p-4 lb:flex lb:flex-col lb:gap-3 lb:motion-safe:transition-colors ${
                    isDraft
                      ? "lb:border-dashed lb:border-[var(--color-warning)]/40 lb:bg-[var(--color-card)]/80"
                      : isSuggestion
                      ? "lb:border-dashed lb:border-[var(--color-primary)]/40 lb:bg-[var(--color-card)]/80"
                      : isBroken && !calmFree
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
                      <h3 ref={isArrived ? arrivedHeading : undefined} tabIndex={isArrived ? -1 : undefined} aria-describedby={isArrived && isDraft ? bannerId : undefined}
                        className="lb:text-[13px] lb:font-bold lb:text-[var(--color-card-foreground)]" style={{ overflowWrap: "anywhere", outlineOffset: 2 }}>
                        {visibleTokens(rule.label)}
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

                  {/* What an "Always allow" draft covers: ONE sentence, chosen by the engine's `covers` (AA-1b, A-286), never by a comparison made here */}
                  {isDraft && fromAlways && (
                    <p className="lb:m-0 lb:text-[13px] lb:font-medium lb:text-[var(--color-foreground)]" style={{ overflowWrap: "anywhere" }}>{coverage(rule)}</p>
                  )}

                  {/* Card Match Criteria */}
                  <div className="lb:space-y-1.5 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
                    {rule.match.tools && rule.match.tools.length > 0 && (
                      <div className="lb:flex lb:items-center lb:gap-1.5 lb:flex-wrap">
                        <span className="lb:font-medium">{t("toolsLabel")}</span>
                        {rule.match.tools.map((toolName) => (
                          <span
                            key={toolName}
                            className="lb:font-mono lb:text-xs lb:px-1.5 lb:py-0.5 lb:rounded-lg lb:bg-[var(--background)] lb:border-[var(--lb-separator)]"
                            style={{ overflowWrap: "anywhere" }}   // what the Bot wrote wraps inside the card: a text with no space is one line (F-A206-1)
                          >
                            {visibleTokens(toolName)}
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
                            style={{ overflowWrap: "anywhere" }}   // what the Bot wrote wraps inside the card: a text with no space is one line (F-A206-1)
                          >
                            {visibleTokens(cmd)}
                          </span>
                        ))}
                      </div>
                    )}

                    <ConditionLines rule={rule} />
                  </div>

                  {/* A real HAND or LOCK by a command pattern: what it covers (the "pattern" qualifier) */}
                  <SealCaveat sealResult={seal_result} />
                  {/* A condition (path, recipient): what the seal does not see, and the warning of an allow towards a Bot */}
                  <ConditionCaveats sealResult={seal_result} />
                  <RuleRecipientWarning rule={rule} bots={bots} />

                  {/* Broken State: Display exact problems and qualifiers */}
                  {calmFree && (
                    <p data-testid={`rule-free-why-${rule.id}`} className="lb:m-0 lb:text-[13px] lb:text-[var(--color-muted-foreground)]">{t("surfaceSealFree")}</p>
                  )}
                  {!calmFree && (isBroken || hasProblems) && (
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
                            {problemWords(p.code) ? t(problemWords(p.code)!) : p.detail}
                          </li>
                        ))}
                      </ul>
                      {/* the seal says hook_outdated: the fix is one click for the Bot this seal is about (a Bot's page, or a rule of one Bot); an aggregate has no single Bot */}
                      {seal_result?.problems?.some((p) => p.code === "hook_outdated") && (botName || (rule.scope.kind === "bot" && rule.scope.ref)) && (
                        <HookUpdate bot={(botName || rule.scope.ref) as string} onDone={() => void loadRulesList()} />
                      )}
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

                  {isDraft && fromAlways && <p className="lb:m-0 lb:text-[13px] lb:text-[var(--color-muted-foreground)]" style={{ overflowWrap: "anywhere" }}>{t("alwaysOnDoes")}</p>}
                  {fromAlways && rule.state === "active" && activatedHere.has(rule.id) && (
                    <p role="status" className="lb:m-0 lb:text-[13px] lb:font-semibold lb:text-[var(--color-success)]" style={{ overflowWrap: "anywhere" }}>{t("alwaysActiveHere", { bot: botShown(rule) })}</p>
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
                          disabled={noLogin || isSubmitting}
                          title={
                            noLogin
                              ? ruleBlocked
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
                </React.Fragment>
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

              <div className="lb:grid lb:grid-cols-1 lb:sm:grid-cols-2 lb:gap-3">
                <div>
                  <label htmlFor="sim-path-input" className="lb-label lb:block lb:mb-1">{t("simPathLabel")}</label>
                  <input id="sim-path-input" type="text" value={simPath} onChange={(e) => setSimPath(e.target.value)} placeholder={t("simPathPlaceholder")} className="lb-input lb-mono" />
                </div>
                <div>
                  <label htmlFor="sim-recipient-input" className="lb-label lb:block lb:mb-1">{t("simRecipientLabel")}</label>
                  <input id="sim-recipient-input" type="text" value={simRecipient} onChange={(e) => setSimRecipient(e.target.value)} placeholder={t("simRecipientPlaceholder")} className="lb-input lb-mono" />
                </div>
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
                {simResult.caveats?.includes("paths_lexical") && <p data-testid="sim-paths-lexical" className="lb:text-[13px] lb:m-0 lb:text-[var(--color-muted-foreground)]">{t("simPathsLexical")}</p>}
                {simResult.caveats?.includes("recipients_lexical") && <p data-testid="sim-recipients-lexical" className="lb:text-[13px] lb:m-0 lb:text-[var(--color-muted-foreground)]">{t("simRecipientsLexical")}</p>}
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

                  <div className="lb:text-right">
                    <span className="lb:text-xs lb:text-[var(--color-muted-foreground)]">
                      {t("simWinningRuleLabel")}
                    </span>
                    <div className="lb:text-[13px] lb:font-semibold lb:text-[var(--color-card-foreground)]">
                      {winnerId(simResult.decision.winner) ? ruleName(winnerId(simResult.decision.winner)!) : t("simNoWinner")}
                    </div>
                  </div>
                </div>

                <HermesGateRow gate={simResult.hermes_gate} effect={simResult.decision.effect}
                  winnerSeal={winnerId(simResult.decision.winner) ? simResult.seals?.[winnerId(simResult.decision.winner)!] : undefined} />

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
                              {getLevelLabel(hit.level)}
                            </span>
                            <span className="lb:font-semibold lb:text-[var(--color-card-foreground)]">
                              {ruleName(hit.rule_id)}
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

                {/* the rule ids, what each matched on and the reason code, for whoever needs them */}
                <TechnicalDetail testId="simulation-technical" lines={[
                  winnerId(simResult.decision.winner),
                  ...(simResult.decision.hits ?? []).map((hit) => `${hit.rule_id} ${t("simMatchedOn", { pattern: String(hit.matched_on) })}`),
                  simResult.decision.reason,
                ]} />
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
                onClick={closeCreateModal}
                className="lb-icon-btn" style={{ background: "var(--lb-fill)" }}
              >
                <XIcon size={16} />
              </button>
            </div>

            <p className="lb:text-[13px] lb:text-[var(--color-muted-foreground)]">
              {t("newRuleModalDesc")}
            </p>

            {fromSuggestion && (
              <p data-testid="suggestion-draft-note" className="lb:text-[13px] lb:text-[var(--color-foreground)]">
                {t("sgDraftNote", { count: fromSuggestion.count })}
              </p>
            )}
            {fromSuggestion?.whole_tool && (
              <p data-testid="suggestion-draft-whole" className="lb:text-[13px]" style={{ color: "var(--color-warning)", fontWeight: 600 }}>{t("sgWholeTool", { tool: fromSuggestion.action.tool })}</p>
            )}
            {fromSuggestion && leftBehind > 0 && (
              <p data-testid="suggestion-draft-left" role="status" className="lb:text-[13px]" style={{ color: "var(--color-warning)" }}>{t("sgConditionsLeft", { n: leftBehind })}</p>
            )}

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

            <ConditionFields kind={newCondKind} value={newCondValue} level={newLevel} bots={bots} onKind={chooseCondKind} onValue={setNewCondValue} />

            {createError && (
              <p role="alert" data-testid="create-rule-error" className="lb:text-[13px] lb:m-0 lb:text-[var(--color-destructive)]"><ErrorNote error={createError} /></p>
            )}

            <div className="lb:flex lb:items-center lb:justify-end lb:gap-2 lb:pt-2">
              <button
                type="button"
                onClick={closeCreateModal}
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
