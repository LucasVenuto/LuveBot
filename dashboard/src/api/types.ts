// dashboard/src/api/types.ts
// Typed contracts for LuveBot plugin API v0 (docs/contracts/plugin-api-v0.md)

export interface HealthPluginInfo {
  version: string;
  api: string;
  db: {
    ok: boolean;
    schema_version: number;
  };
  /** false: LuveBot was updated on disk but the dashboard still runs the previous code (problem plugin_restart_required). */
  code_current?: boolean | null;
}

/** What /health says about the Hermes under the dashboard (backend F2). Every new field is absent from an older backend (no strip). */
export type HermesCompat = "compatible" | "untested" | "unsupported";
export interface HealthHermesInfo {
  version: string | null;
  display_version?: string | null;
  commit?: string | null;
  channel?: "stable" | "main" | null;
  session_authority?: boolean | null;
  /** plugins.isolation: "host" cannot run LuveBot (compat is then "unsupported"). null: not known. */
  isolation?: "in_process" | "host" | null;
  compat?: HermesCompat;
  /** What does NOT work on this Hermes: approval_resolve, session_other_channel, run_unknown, profile_selector. [] = nothing. */
  limits?: string[];
  /** Same codes as `limits`: has code here but no harness proof on this Hermes version. Absent (older backend) = no line. */
  unproven?: string[];
  /** Old aliases; the UI reads `compat` instead. */
  baseline?: string;
  baseline_ok?: boolean;
}

export interface HealthSdkInfo {
  version: string;
  supported: boolean;
}

export interface HealthResponse {
  ok: boolean;
  plugin: HealthPluginInfo;
  hermes: HealthHermesInfo;
  sdk: HealthSdkInfo;
  auth: {
    required: boolean;
  };
  features: {
    runs: "ok" | "unavailable" | "unknown";
    session_chat_stream: "ok" | "unavailable" | "unknown";
    groups: "ok" | "unavailable" | "unknown";
    approvals: "ok" | "unavailable" | "unknown";
    approval_transport: "not_used";
    [key: string]: string;
  };
  problems: Array<{
    code: string;
    feature: string;
    message: string;
  }>;
}

export interface SessionResponse {
  csrf: string;
  actor: string;
  auth_mode: "loopback" | "gated" | "deployment";   // deployment: the deployment token of Hermes main, a machine (v0.11 5.1)
}

export interface BotAvatar {
  kind: "emoji" | "initials" | "mascot" | "luve" | "image"; // luve: a recipe (components/ui/luve.ts); image: the id `img_<32 hex>` of a PNG the person sent (v0.11 §2, ui/avatarImage.ts); any other value is a legacy row, drawn as initials
  value: string;
}

export interface BotDisplay {
  label: string;
  role: string;
  call_me?: string | null;
  color: string;
  avatar: BotAvatar;
  hidden?: boolean;
  /** contract v0.8 section 9: pinned to the top of the sidebar, and the shared order (null: never ordered) */
  pinned?: boolean;
  position?: number | null;
}

export interface BotTask {
  kind: "run" | "session" | "kanban";
  id: string;
  title: string;
  since: string;
}

export interface BotChannel {
  platform: string;
  state: "connected" | "disconnected" | "error";
}

export interface BotCapabilities {
  runs: boolean;
  session_chat_stream: boolean;
  approval_response: boolean;
  [key: string]: boolean | undefined;
}

export type BotStatus =
  | "idle"
  | "working"
  | "waiting_approval"
  | "paused"
  | "error"
  | "offline";

export interface Bot {
  name: string;
  is_default: boolean;
  display: BotDisplay;
  description: string;
  model: {
    provider: string;
    name: string;
  };
  status: BotStatus;
  status_reason?: "estop" | "budget" | string | null;
  /** The Bot's approval mode: /bots says it (absent when unreadable); the app settles it with the Perfil's fresher word (agent/freeMode.ts). "free" = LuveBot asks nothing for it. */
  approval_mode?: ApprovalSurfaceMode;
  /** Set by the app: /bots has not said this Bot's mode for several reads in a row (it did before), so the last known mode is not confirmed (agent/freeMode.ts). */
  approval_unknown?: boolean;
  current_task?: BotTask | null;
  cost_today_usd?: number | null;
  channels?: BotChannel[];
  capabilities?: BotCapabilities;
  unread?: boolean;
}

export interface BotToolset {
  name: string;
  enabled: boolean;
}

export interface BotMcpServer {
  name: string;
  enabled: boolean;
}

export interface BotDetail extends Bot {
  soul: string;
  toolsets: BotToolset[];
  mcp_servers: BotMcpServer[];
  /** contract v0.6 10.3: what Hermes waits for a person's answer; source "hermes_default" when the profile does not set it */
  approval_timeout?: ApprovalTimeout;
  /** contract v0.9: false when the `clarify` tool is off in the tools this Bot's api_server uses, so it never asks a person (it decides alone). Absent: not readable, never a guess. */
  can_ask?: boolean;
  /** contract v0.9 14: what the Bot's api_server toolsets give it now. Each key ABSENT when it cannot be told; the object absent when no key can be. `true` is a capability, never a promise. */
  file_tools?: BotFileTools;
  /** voice-language-reactions-v0 4, A-282: whether the Bot is told of the person's reactions (Hermes's `display.message_reactions`). The OBJECT is absent when it cannot be told (a Hermes without the announcement, an unreadable file): never a guess. */
  reactions?: { bot_sees: boolean };
}

export interface BotFileTools { read_file?: boolean; vision_analyze?: boolean; terminal?: boolean }

/** contract v0.6 Part D: the 5 waits a person may choose (5, 15, 30 min, 1 h, 4 h) */
export const APPROVAL_TIMEOUTS = [300, 900, 1800, 3600, 14400] as const;
export type ApprovalTimeoutSeconds = typeof APPROVAL_TIMEOUTS[number];
export interface ApprovalTimeout { seconds: number; source: "profile" | "hermes_default" }

export interface BotsResponse {
  bots: Bot[];
}

export interface Template {
  id: string;
  label: string;
  role: string;
  soul: string;
  toolsets: string[];
  model_hint?: string | null;
  intro_prompt: string;
  description?: string;
  color?: string;
  avatar?: BotAvatar;
}

export interface TemplatesResponse {
  templates: Template[];
}

export interface CreateBotRequest {
  name: string;
  template?: string;
  display?: Partial<BotDisplay>;
  model?: {
    provider: string;
    name: string;
  };
}

export interface CreateBotResponse {
  bot: Bot;
  intro: {
    session_id: string;
  };
}

export interface UpdateBotDisplayRequest {
  label?: string;
  role?: string;
  call_me?: string | null;
  color?: string;
  avatar?: BotAvatar;
  hidden?: boolean;
  pinned?: boolean;
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  request_id?: string;
  details?: Record<string, any>;
  /** `skill_invalid` names its reason here (contract v0.11 3.4), beside `details`. */
  why?: string;
}

export interface ApiErrorPayload {
  error: ApiErrorDetail;
}

// ---------------------------------------------------------------------------
// Approvals & Rules Addendum (Contract v0.1 §1, §2, §6 & ADR-002)
// ---------------------------------------------------------------------------

export type ApprovalSource = "transport" | "run";
export type ApprovalStatus = "pending" | "decided" | "consumed" | "expired" | "stale";
export type ApprovalChoice = "once" | "deny";

export interface Approval {
  request_id: string;
  bot: string;
  surface?: string;
  mechanism?: string;
  source: ApprovalSource;
  digest: string;
  command_redacted?: string;
  description?: string;
  pattern_keys?: string[];
  tool?: string | null;      // backend/approvals.py view: the tool the request is about
  /** v0.9 §1.9 (C1): a hook request LuveBot could not tie to the tool call it came from (a hook before 0.8.0 on a canonical Hermes): it cannot be approved, only denied. Absent: older backend. */
  details_unavailable?: boolean;
  rule_id?: string | null;   // and the LuveBot rule that asked (null: Hermes's own gate)
  allowed_choices: string[];
  action_class_hash?: string;
  created_at: string;
  expires_at: string;
  status: ApprovalStatus;
  decided_by?: string | null;
  decided_choice?: ApprovalChoice | null;
  /** b3, a deny reason: true reached the Bot; null sent, the run still going; false stayed in LuveBot. Absent: older backend. */
  reason_delivered?: boolean | null;
  consumed_at?: string | null;
  run_id?: string | null;
  /** 21a (pages-review-v0): a write_file / patch approval. All null/absent for any other request and for an older hook ("sem prévia"). */
  page?: { slug: string; base_sha: string | null } | null;
  proposal?: PageProposal | null;
  review?: { preview: boolean; label: "approve_and_save" | "approve" } | null;
  /** only a pending request that would overwrite a whole page: the page now against the proposal, plain unified text (computed at read time) */
  diff?: PageDiff | null;
}

/** What the Bot asks to save: Bot-written text, redacted by the backend, cut at 64 KiB. Shown as TEXT only, never as HTML. */
export interface PageProposal {
  kind: "whole" | "replace" | "v4a";
  path_tag: string;
  size: number;        // bytes the Bot sent
  truncated: boolean;
  content: string;
}

export interface PageDiff {
  format: "unified";
  lines: string[];     // each line carries its own marker: "+", "-", " ", "@@", "---", "+++"
  truncated: boolean;
}

/** GET /bots/{bot}/pages/review: the "Revisar antes de salvar" switch, derived from the ACTIVE rule of the exact shape. */
export interface PagesReviewState {
  enabled: boolean;
  rule_id: string | null;
  /** whose rule is behind "ligado": this Bot's own (the switch may archive it) or a GLOBAL one (every Bot: say where to turn it off, no archive). Absent: an older backend. */
  scope?: "bot" | "global" | null;
  seal: SealResult | null;
}

export interface ApprovalsResponse {
  ok?: boolean;
  approvals: Approval[];
  next_cursor?: string | null;
  total?: number;
}

export interface DraftRulePayload {
  label: string;
  level: "allow" | "explicit";
}

export interface ResolveApprovalRequest {
  digest: string;
  choice: ApprovalChoice;
  reason?: string;
  draft_rule?: DraftRulePayload;
}

export interface ResolveApprovalResponse {
  ok?: boolean;
  approval: Approval;
  draft_error?: string;  // "Always allow" only: why the draft rule was NOT saved (a rule code, `fold_divergence`, `multiple_paths`...; never shown raw); the request WAS decided once (M2)
  reason_delivered?: boolean | null;  // deny only: true reached the Bot (R-4, b3); null sent, run still going; false stayed in LuveBot
  draft_rule?: {
    id: string;
    label: string;
    level: string;
    scope: { kind: string; ref?: string | null };
    state: string;
    origin: string;
  };
}

export interface BatchApprovalItem {
  request_id: string;
  digest: string;
  choice: ApprovalChoice;
  reason?: string;
}

export interface BatchResolveRequest {
  items: BatchApprovalItem[];
}

export interface BatchResolveResponse {
  ok?: boolean;
  approvals: Approval[];
}

export interface RunApprovalRequest extends ResolveApprovalRequest {
  request_id: string;
}

// ---------------------------------------------------------------------------
// Rules Contract v0.1 §3 & ADR-002
// ---------------------------------------------------------------------------

export type RuleLevel = "allow" | "explicit" | "ask" | "handback" | "block";
export type RuleState = "draft" | "active" | "archived" | "suggestion";
export type RuleOrigin = "builtin" | "human" | "always_allow" | "bot_suggestion";
export type ScopeKind = "global" | "room" | "bot" | "routine";

export interface Scope {
  kind: ScopeKind;
  ref?: string | null;
}

export interface RuleMatch {
  tools?: string[];
  toolsets?: string[];
  mcp_servers?: string[];
  commands?: string[];
  /** The API form since the path condition (rules-conditions-v0 §5): a list of {fact, op?, value}; older rules read as an object. */
  conditions?: Record<string, string> | Array<{ fact: string; op?: string; value: string }>;
}

export interface Rule {
  id: string;
  label: string;
  level: RuleLevel;
  scope: Scope;
  match: RuleMatch;
  state: RuleState;
  origin: RuleOrigin;
  builtin: boolean;
  applied?: boolean;
  version: number;
  updated_by?: string;
  /** AA-1: true when the rule covers only the exact command (no unescaped wildcard in what it names); computed by the engine, never by the screen. Absent on a server that does not send it: the screen then says nothing about coverage. */
  exact?: boolean;
  /** AA-1b (A-286): what the rule covers, chosen by the engine beside `exact`: "wider" (exact is false), "command" (the rule has a command), "facts" (no command, narrowed by a file or a recipient) or "tool" (no command and no condition: every call of the tool).
   *  Absent on a server that does not send it, or a value this screen does not know: the screen then says only the neutral sentence, which is true of every rule. */
  covers?: string;
}

// Contract v0.8 §5: a rule suggestion, built from our own approvals. `draft_preview` is what "Sempre permitir…" would make (null when the
// action cannot become a rule). Nothing is saved or applied by listing it.
export interface RuleSuggestion {
  kind: "rule";
  bot: string;
  action_class: string;   // the digest of the action class; the key to dismiss it
  count: number;          // "uma vez" approvals in the last 7 days
  action: { tool: string; command: string | null };
  /** true: the rule it would make allows the TOOL every time (the action has no command to narrow it); the screen says so (red team M2) */
  whole_tool?: boolean;
  draft_preview: Rule | null;
}

export type SealType = "lock" | "hand" | "note" | "none" | "broken";

export interface Mechanism {
  id: string;
  verified: boolean;
  covers: string[];
}

export interface Problem {
  code: string;
  detail: string;
}

export interface SealResult {
  seal: SealType;
  mechanisms?: Mechanism[];
  problems?: Problem[];
  qualifiers?: string[];
}

export interface RuleWithSeal {
  rule: Rule;
  seal_result: SealResult;
}

export interface RulesResponse {
  ok?: boolean;
  rules: RuleWithSeal[];
  next_cursor?: string | null;
}

export interface RuleAction {
  bot: string;
  tool: string;
  toolset?: string;
  mcp_server?: string;
  command?: string;
  room?: string;
  routine?: string;
  facts?: Record<string, string>;
}

export interface Hit {
  rule_id: string;
  level: RuleLevel;
  scope: Scope;
  builtin: boolean;
  matched_on: string;
}

export interface Decision {
  effect: RuleLevel;
  /** the winning rule's id (backend/rules.py Decision.winner); null when the default decides */
  winner?: string | Hit | null;
  hits: Hit[];
  reason?: string;
}

/** What Hermes's own approval gate would do with the command (F6.3 dry-run: it neither runs, nor asks, nor records). */
export type HermesGateVerdict = "allow" | "ask" | "hardline_deny" | "user_deny";
export type HermesGate =
  | { available: true; verdict: HermesGateVerdict; rule?: string | null; env_type?: string; caveats?: string[] }
  | { available: false; reason: "hermes_without_dry_run" | "unreadable" | "command_too_long" | string };

export interface Simulation {
  ok?: boolean;
  decision: Decision;
  seals?: Record<string, SealResult>;
  effective_mechanisms?: any[];
  /** absent from an older backend; null when the action is not a terminal command */
  hermes_gate?: HermesGate | null;
  /** what the simulation did not have: `paths_lexical` = "simulado sem a pasta do turno" (rules-conditions-v0 §7) */
  caveats?: string[];
}

// ---------------------------------------------------------------------------
// Costs & Budget (Contract v0.2 §4, docs/PRODUCT_SPEC.md §4.13)
// ---------------------------------------------------------------------------

export type CostPeriod = "day" | "7d" | "month" | "30d";
export type CostGroupKey = "bot" | "model" | "routine" | "day";

export interface CostGroup {
  key: string;
  spend_cents: number;
  tokens?: number;
  sessions?: number;
}

export interface CostsTotals {
  spend_cents: number;
  unpriced_sessions: number;
}

export interface CostsLedger {
  lag_s: number;
  watcher_stale: boolean;
}

/** Contract v0.8 §7: the month to its end. A number, never an action. `projected_cents` is null with fewer than 3 days of spend. */
export interface CostsProjection {
  month: string;                      // "YYYY-MM"
  spent_cents: number;
  projected_cents: number | null;
  cap_cents: number | null;           // the monthly cap, when there is one
  crosses_cap_on: string | null;      // "YYYY-MM-DD": the day the pace reaches the cap this month
  basis_days: number;                 // days in the average (up to 7)
}

export interface CostsResponse {
  period: CostPeriod;
  currency: "USD";
  totals: CostsTotals;
  groups: CostGroup[];
  ledger: CostsLedger;
  projection?: CostsProjection;                        // absent from a backend before v0.8
  projection_by_bot?: Record<string, CostsProjection>;
}

export type BudgetScope = "global" | "bot" | "routine";
export type BudgetPeriod = "day" | "month";

export interface BudgetLimit {
  scope: BudgetScope;
  ref?: string | null;
  period: BudgetPeriod;
  cents: number;
  spent_cents: number;
  reserved_cents?: number;
  percent: number;
}

export interface PausedBot {
  bot: string;
  since: number;
  plan_status?: string;
}

export interface BudgetWatcher {
  last_at: number;
  stale: boolean;
}

export interface BudgetAlert {
  scope: BudgetScope;
  ref?: string | null;
  percent: number;
  message?: string;
}

export interface BudgetSnapshot {
  limits: BudgetLimit[];
  paused: PausedBot[];
  watcher: BudgetWatcher;
  alerts: BudgetAlert[];
}

export interface SetBudgetLimitRequest {
  scope: BudgetScope;
  ref?: string | null;
  period: BudgetPeriod;
  cents: number | null;
}

export interface SetBudgetLimitResponse {
  ok?: boolean;
  limit?: BudgetLimit | null;
}

export interface ResumeBotBudgetResponse {
  ok?: boolean;
  bot: string;
  resumed?: boolean;
}

// ---------------------------------------------------------------------------
// Routines (Contract v0.2 §3, docs/PRODUCT_SPEC.md §4.9)
// ---------------------------------------------------------------------------

export type RoutineState = "scheduled" | "paused" | "completed";
export type RoutinePausedReason = "user" | "budget" | "inactivity" | null;

export interface RoutineSchedule {
  kind?: string;
  expr: string;
  tz?: string;
}

export interface RoutineCap {
  period: "day" | "month";
  cents: number;
}

export interface Routine {
  id: string;
  bot: string;
  name: string;
  schedule: RoutineSchedule;
  next_run_at?: string | number | null;
  last_run_at?: string | number | null;
  last_status?: "success" | "error" | "running" | string | null;
  last_error?: string | null;
  state: RoutineState;
  enabled: boolean;
  paused_reason?: RoutinePausedReason;
  deliver?: string | null;
  skills?: string[];
  model?: string | null;
  no_agent?: boolean;
  cap?: RoutineCap | null;
  spend_cents?: number | null;
  scheduler_heartbeat_age_s?: number | null;
  has_script?: boolean;
  template?: "research" | null;                    // v0.8 §3: which template made it (kept only to know which seal to compute)
  readonly_seal?: "real" | "broken" | null;        // v0.8 §3: from the LIVE job; real = Hermes enforces web + no_mcp, broken = it can do more now
}

export interface RoutineDetail {
  routine: Routine;
  detail: {
    instruction?: string;
    input_source?: string;
    delivery_summary?: string;
  };
}

export interface RoutineRun {
  session_id: string;
  kind?: "session" | "script";
  started_at: string | number;
  ended_at?: string | number | null;
  status: "success" | "error" | "running" | "stopped" | string;
  duration_s?: number | null;
  cost_cents?: number | null;
  cost_kind?: "actual" | "estimated" | "unknown";
  tokens?: number | null;
  is_active?: boolean;
}

// Contract v0.8 §8: pause by inactivity. `days` null = off. `paused` is set after the pause ran and until a person resumes.
export type InactivityDays = 3 | 7 | 14 | 30;
export interface InactivityStatus {
  days: InactivityDays | null;
  paused: { count: number; at: number; days: number } | null;   // `at` in epoch seconds
}

export interface RoutinesResponse {
  routines: Routine[];
  next_cursor?: string | null;
}

export interface RoutineRunsResponse {
  runs: RoutineRun[];
  next_cursor?: string | null;
  truncated?: boolean;
}

/** POST /avatars (contract v0.11 §2.2): the stored image's id (the same pixels from the same owner give the same id back, `replayed`). */
export interface AvatarUploadResponse { id: string; width: number; height: number; bytes: number; replayed?: boolean }
// Contract v0.10 §2: a routine Hermes proposes (its own cron/suggestions.json), listed over every Bot. Everything text was written by a model
// or a skill and is shown as plain text. `supported: false` means LuveBot will not create it (`why_not` says why in a code, `fields` names the
// offending keys, never their values): the person accepts that one in Hermes.
export type RoutineSuggestionSource = "catalog" | "blueprint" | "usage" | "integration";
export type RoutineSuggestionWhyNot = "unsupported_fields" | "delivery_outside" | "no_agent" | "invalid_spec" | "too_large";
export interface RoutineSuggestionSpec {
  name?: string;
  schedule?: string | { expr?: string; display?: string };
  prompt?: string;
  skills?: string[];
  model?: string;
  deliver?: string;
  no_agent?: boolean;
  enabled_toolsets?: string[];
}
export interface RoutineSuggestion {
  bot: string;
  id: string;                     // the 12-hex id, the only thing accept/dismiss take
  title: string;
  description: string;
  source: RoutineSuggestionSource | string;
  created_at?: string | number;
  spec: RoutineSuggestionSpec;
  supported: boolean;
  why_not?: RoutineSuggestionWhyNot | string;
  fields?: string[];
  truncated?: { title?: boolean; description?: boolean; prompt?: boolean };
}
export interface RoutineSuggestionsResponse { items: RoutineSuggestion[]; partial?: string[] }
/** 201 of accept: always created PAUSED; `started` only when the person asked and the gates of POST /routines allowed it (`held` says which did not). */
export interface AcceptRoutineSuggestionResponse { routine: Routine; suggestion_id: string; started: boolean; held?: string; replayed?: boolean }

export interface CreateRoutineRequest {
  bot: string;
  name: string;
  schedule: string;               // the expression as text ("0 8 * * 1-5", "every 1h"): the backend refuses an object
  template?: "research";          // v0.8 §3: the backend forces toolsets web + no_mcp, deliver local and the fixed last line
  prompt?: string;
  skills?: string[];
  model?: string;
  deliver?: string;
  no_agent?: boolean;
  enabled_toolsets?: string[];
  start?: boolean;
}

export interface UpdateRoutineRequest {
  name?: string;
  schedule?: RoutineSchedule;
  prompt?: string;
  skills?: string[];
  model?: string;
  deliver?: string;
  no_agent?: boolean;
  enabled_toolsets?: string[];
}

// Activity Types (Contract v0.2 §2, spec §4.7)

export type ActivityTab = "running" | "scheduled" | "done";

export type ActivityKind = "run" | "routine_run" | "routine_due" | "task" | "waiting";  // waiting (v0.9 §7): a wait with no LuveBot run; no detail, no action

export type ActivityOrigin = "message" | "routine" | "webhook" | "handoff";

export type ActivityStatus =
  | "running"
  | "waiting_approval"
  | "scheduled"
  | "done"
  | "error"
  | "stopped"
  | "blocked";

export interface ActivityCheckpoint {
  done: number;
  total: number;
  to_review: number;
}

export interface ActivityLinks {
  session_id?: string;
  run_id?: string;
  task_id?: string;
  job_id?: string;
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  bot: string;
  title: string | null;  // null: no human title (a conversation run); the UI names it, components/labels.ts activityTitle
  origin: ActivityOrigin;
  status: ActivityStatus;
  checkpoint?: ActivityCheckpoint | null;
  started_at?: string | null;
  ended_at?: string | null;
  duration_s?: number | null;
  cost_cents?: number | null;
  links?: ActivityLinks;
  column?: string;
}

export interface ActivityResponse {
  items: ActivityItem[];
  next_cursor?: string | null;
  partial?: string[];
}

// Contract v0.8 §2: GET /activity/timeline (window ≤ 7 days) and GET /activity/heatmap. Times are epoch seconds.
export interface TimelineBlock {
  id: string;
  kind: "run" | "routine";
  title: string | null;
  start: number;
  end: number | null;  // null: still running, or a run from before ended_at was recorded (drawn as a point)
  status: ActivityStatus;
}
export interface TimelineResponse {
  lanes: { bot: string; blocks: TimelineBlock[] }[];
  approvals: { id: string; bot: string; at: number; decided_at: number | null; status: string }[];
  handoffs: { id: string; from: string; to: string; at: number; status: string }[];
  partial?: string[];
}
export interface HeatmapResponse {
  bots: string[];
  cells: { bot: string; hour: number; count: number }[];
  max: number;
}

export interface ActivityFilterParams {
  tab: ActivityTab;
  bot?: string;
  room?: string;
  origin?: ActivityOrigin | "all";
  status?: ActivityStatus | "all";
  since?: string;
  until?: string;
  min_cost_cents?: number;
  limit?: number;
  cursor?: string;
}

export interface ActivityContextRequest {
  text: string;
  kind: "context" | "correction";
}

export interface ActivityRedirectRequest {
  bot: string;
  reclaim_first?: boolean;
  reason?: string;
}

export interface ActivityStopRequest {
  reason?: string;
}

export const HERMES_KANBAN_COLUMNS = [
  "triage",
  "todo",
  "scheduled",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
] as const;

export type HermesKanbanColumn = (typeof HERMES_KANBAN_COLUMNS)[number];

// Room Types (Contract v0.3 §3, spec §4.4)

export interface RoomMember {
  member_id: string;
  bot: string; // profile slug
  handle: string; // unique, letters/digits/._:-
  display_name?: string;
  avatar?: BotAvatar;
  color?: string;
}

export interface RoomDriverStatus {
  running: boolean;
  /** a member's turn is live (Hermes `working`); absent from an older backend, which only had `running` */
  working?: boolean;
  pending_actions_count: number;
}

export interface Room {
  id: string; // Hermes room_id
  name: string;
  members: RoomMember[];
  created_at: string;
  disbanded_at?: string | null;
  next_seq?: number;
  driver: RoomDriverStatus;
  goal?: string | null;
  owner?: string | null;
  coordinator?: string | null;
  open_tasks?: number;
}

export interface RoomActor {
  kind: "user" | "member" | "system";
  id: string;
  display_name?: string;
}

export type RoomEventKind =
  | "message.user"
  | "message.member"
  | "turn.started"
  | "turn.settled"
  | "turn.failed"
  | "turn.cancelled"
  | "turn.deferred"
  | "turn.reassigned"
  | "member.unavailable"
  | "room.activity"
  | "room.stop_requested"
  | "room.created"
  | "room.renamed"
  | "room.members_changed"
  | "room.disbanded"
  | "handoff.card";

export interface RoomEvent {
  seq: number;
  event_id: string;
  kind: RoomEventKind;
  actor: RoomActor;
  payload: {
    text?: string;
    tool_calls?: any[];
    thread_id?: string;
    error?: string;
    handoff_id?: string;
    from?: string;
    to?: string;
    task_id?: string;
    title?: string;
    status?: string;
    [key: string]: any;
  };
  at: string;
  /** contract v0.6 9.1 step 6: a person's message, the files from LuveBot's RECORD of that send (never from its text) */
  attachments?: RoomAttachment[];
  /** 9.2: a member's message, the profile of the Bot that SENT it (Hermes's sender); null when it cannot be told */
  author_bot?: string | null;
}

/** One file of a person's room send: the same `attachments/<uuid>-<name>` copied into each of `bots`. */
export interface RoomAttachment { name: string; path: string; size: number; kind: string; bots: string[] }

export interface RoomsListResponse {
  rooms: Room[];
  next_cursor?: string | null;
}

export interface RoomResponse {
  room: Room;
  driver_status?: RoomDriverStatus;
}

export interface RoomLogResponse {
  events: RoomEvent[];
  next_seq?: number;
}

export interface CreateRoomMemberInput {
  bot: string;
  handle?: string;
  display_name?: string;
}

export interface CreateRoomRequest {
  name: string;
  members: CreateRoomMemberInput[];
  goal?: string;
  owner?: string;
  coordinator?: string;
  kickoff?: boolean;
}

export interface PatchRoomRequest {
  name?: string;
  goal?: string;
  owner?: string;
  coordinator?: string;
}

export interface SendRoomMessageRequest {
  text: string;
  event_id: string;
  thread_id?: string;
  confirm_cost?: boolean;
}

export interface SendRoomMessageResponse {
  event: RoomEvent;
  targets: string[];
  accepted: boolean;
  attachments?: RoomAttachment[];
}

export interface StopRoomResponse {
  stopped: boolean;
  cancel_id: string;
}

export interface DisbandRoomRequest {
  confirm_name: string;
}

// Handoff Types (Contract v0.3 §4, spec §4.4)

export type HandoffState =
  | "triage"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "cancelled"
  | "open"
  | "needs_review"
  | "completed";

export interface Handoff {
  id: string;
  from: string;
  to: string;
  /** the Kanban task's title, read live; null when the task cannot be read */
  title: string | null;
  body?: string;
  room_id?: string | null;
  task_id: string;
  state: HandoffState;
  needs_review?: boolean;
  created_at: string;
  updated_at: string;
  source?: "human" | "bot";
}

export interface HandoffsListResponse {
  handoffs: Handoff[];
  next_cursor?: string | null;
}

export interface CreateHandoffRequest {
  from: string;
  to: string;
  title: string;
  body?: string;
  room_id?: string;
  priority?: string;
  skills?: string[];
}

// ---------------------------------------------------------------------------
// Team Map Contract v0.3 §5 (spec §4.12)
// ---------------------------------------------------------------------------

export interface TeamMapNode {
  bot: string;
  display?: BotDisplay;
  status: BotStatus;
  status_reason?: string;
  current_task?: BotTask | null;  // the same object GET /bots gives (plugin_api.py /map: bot['current_task'])
  rooms: string[];
  week_cost_cents?: number;
}

export interface TeamMapEdge {
  from: string;
  to: string;
  count: number;
  last_at?: string;
  live?: boolean;
  handoff_ids?: string[];
}

export interface TeamMapResponse {
  nodes: TeamMapNode[];
  edges: TeamMapEdge[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Search & Palette Contract v0.3 §6 (spec §4.14)
// ---------------------------------------------------------------------------

export type SearchCategory = "all" | "messages" | "bots" | "rooms" | "routines" | "files" | "actions" | "pages"; // pages: v0.5, searched per Bot

export interface SearchMessageHit {
  bot: string;
  session_id: string;
  title: string;
  snippet: string;
  role: string;
  at: string;
  links?: {
    room_id?: string;
  };
}

export interface SearchBotHit {
  name: string;
  display: BotDisplay;
  description: string;
  status: BotStatus;
}

export interface SearchRoomHit {
  id: string;
  name: string;
  goal?: string | null;
  members_count: number;
}

export interface SearchRoutineHit {
  id: string;
  bot: string;
  name: string;
  schedule: string;
  paused: boolean;
}

export interface SearchFileHit {
  name: string;
  path: string;
  bot?: string;
}

export interface SearchActionHit {
  id: string;
  title: string;
  category?: string;
  shortcut?: string;
  description?: string;
  requiresConfirmation?: boolean;
  confirmMessage?: string;
  actionKey: string;
}

export interface SearchResponse {
  messages: SearchMessageHit[];
  bots: SearchBotHit[];
  rooms: SearchRoomHit[];
  routines: SearchRoutineHit[];
  files: SearchFileHit[];
  actions: SearchActionHit[];
  partial?: string[];
}

export interface SearchParams {
  q: string;
  types?: string;
  bots?: string;
  limit?: number;
}








// ---------------------------------------------------------------------------
// Contract v0.4 B3: pause and resume a Bot
// ---------------------------------------------------------------------------

export interface PauseRequest {
  reason?: string;
  stop_active?: boolean;
}

export interface PauseResponse {
  ok?: boolean;
  paused: boolean;
  scope: "fleet" | "profile" | "luvebot_only";
  stopped_runs?: unknown[];
}

// ---------------------------------------------------------------------------
// Contract v0.5 (T9.3): Pages. A page is pages/<slug>.md in the Bot's workspace; the slug is never a path.
// ---------------------------------------------------------------------------

/** Workspace state (§1). Anything but ready/empty: no file is read or written. */
export type PagesWorkspaceState = "ready" | "empty" | "not_local" | "no_workspace" | "inside_hermes" | "unsafe";
export type PageAuthor = "human" | "bot" | "external";

export interface Page {
  slug: string;
  title: string;
  excerpt: string;        // plain text, redacted, ≤ 200 chars (A-62): shown as text, never as Markdown
  size: number;
  mtime: string;
  sha: string;
  rev: number | null;
  author: PageAuthor;
  author_label: string;   // ready to show (A-63): "Você", a person's name, the Bot's label, "Fora do LuveBot"
  by_you: boolean;
  changed_outside: boolean;
  editable: boolean;
  readonly_reason: null | "redacted" | "write_unsupported";
}

export interface PageWithContent extends Page {
  content: string;
  redacted: boolean;
}

export interface PagesListResponse {
  workspace: { state: PagesWorkspaceState };
  pages: Page[];
  skipped: number;
}

export interface PageRevision {
  rev: number;
  sha: string;
  author: PageAuthor;
  author_label: string;
  by_you: boolean;
  origin_kind: "ui" | "agent" | "system";
  origin_ref?: string | null;
  at: string;
  size: number;
}

export interface PageRevisionWithContent extends PageRevision {
  content: string;
  redacted: boolean;
}

export interface PageRevisionsResponse {
  revisions: PageRevision[];
  next_cursor: string | null;
}

export interface PageSaveResponse {
  page: Page;
  changed?: boolean;
  history_saved?: boolean;
}

// ---- Contract v0.4 B1: session history (served by the backend, redacted) ----
export interface HistorySession {
  id: string;
  title?: string | null;
  started_at?: number | null;
  last_active?: number | null;
  ended_at?: number | null;
  message_count?: number | null;
  source?: string;
  is_active?: boolean;
  kind: "conversation" | "routine" | "channel" | "introduction";
}

export interface HistorySessionsResponse {
  sessions: HistorySession[];
  next_cursor?: string | null;
}

export interface HistoryMessage {
  id: string | number;
  role: "user" | "assistant" | "tool";
  text: string;
  at?: number | string | null;
  truncated?: boolean;
  tool_name?: string;
  /** BA-7: a mask of the server replaced what this tool row returned; `text` is then its English line. The screen draws the words of `kind` in the person's language and, for a reader of the context, the shown path and the size. */
  masked?: { kind: "read" | "hidden"; path?: string; size?: number };
  tool_calls?: { name: string; args_summary: string | null }[];
  /** async_delegation_complete: a background helper's result delivered to the session (gateway/wake.py), never the person. */
  display_kind?: "steer" | "failed_turn" | "hidden" | "async_delegation_complete" | "skill_draft";   // skill_draft (A-175): the placeholder of LuveBot's hidden skill-draft turn, with no text
  display_metadata?: { delegation_id?: string; task_count?: number; completed_count?: number; failed_count?: number; duration_seconds?: number };
  page_ref?: { slug: string };
  /** A person's and the Bot's marks on this message, as Hermes keeps them (contract v0.8 §4). `user` is the team's one slot, never a name. */
  reactions?: MessageReaction[];
}

export interface MessageReaction { emoji: string; author: "user" | "agent" }
/** One thread of a message (contract v0.8 §4): a new conversation of the same Bot linked to it. `replies` null = could not be counted (never zero). */
export interface ThreadInfo { message_id: number; child_session: string; replies: number | null; last_at: number | null }
export interface ThreadsResponse { threads: ThreadInfo[]; truncated: boolean }
/** A saved Hermes message the page can react to or start a thread from: its durable row id and the marks it has. */
export interface MessageRow { id: number; reactions: MessageReaction[] }

export interface HistoryMessagesResponse {
  messages: HistoryMessage[];
  next_cursor?: string | null;
}

// ---- D-025: where a Bot's approvals are answered (docs/propostas/d025-superficie-de-aprovacao.md §d) ----
// "free": the owner chose that this Bot asks nothing (hook 0.4.0); Block and Handback rules and Hermes's own approvals still hold.
export type ApprovalSurfaceMode = "luvebot" | "channel" | "free";
export interface ApprovalSurface {
  bot: string;
  mode: ApprovalSurfaceMode;
  approvers: string[];          // "telegram:<numeric user id>", typed by a person, never read from Hermes
  platforms: string[];          // where "channel" works today: ["telegram"]
  allow_all: boolean;           // read only in "channel": the gateway lets everyone in (or could not tell)
  allow_all_reason: string | null;
  applied: boolean;             // the live hook applies this setting
  /** Why not (backend approval_surface.applied_reason): absent from an older backend. */
  applied_reason?: "applied" | "pending" | "hook_outdated" | "hook_not_live";
  hook_version: string | null;
  /** The hook version this LuveBot ships, when the backend says it (absent today): an older hook_version offers the update. */
  hook_latest_version?: string | null;
  updated_at: number | null;
  updated_by: string | null;
}

/** POST /bots/{bot}/hook/install (ADR-003 3.3): what installing or updating the Bot's hook did. */
export interface HookInstallResult {
  hook: { status: string; version: string | null };
  changed: boolean;
  gateway_reloaded: boolean | null;
  restart_required: boolean;
}

// ---- D-007: the Bot's live screen (docs/propostas/d007-aba-tela.md §4). No viewer id ever reaches the browser. ----
export interface ScreenLease {
  holder: "agent" | "human";
  since?: number | null;
  mine: boolean;        // the person in control is the viewer THIS person took
  by_luvebot: boolean;  // the person in control took it through LuveBot
}

export interface BotScreen {
  supported: boolean;
  installed: boolean;
  missing: string[];
  install_command?: string | null;
  running: boolean;
  geometry?: string | null;
  placement?: string | null;
  memory?: { available_mb?: number | null; limit_mb?: number | null; needed_mb?: number | null };
  blocker?: string | null;
  lease: ScreenLease;
}

export interface ScreenTicket {
  ticket: string;
  path: string;
  expires_in: number;
  lease?: ScreenLease;
}


// ---- T14 attachments (ADR-005): POST /bots/{bot}/attachments -> 201 {attachment} ----
export interface Attachment {
  path: string;        // "attachments/<uuid>-<clean name>", inside the Bot's workspace
  name: string;        // the clean name the server kept
  type: string;        // the MIME type decided by the bytes
  size: number;        // bytes
  reference: string;   // "[Anexo: attachments/…, type, size]": the line the message carries; the agent reads the file itself
}

// ---- Contract v0.4 B4: the Bot introduces itself (GET/POST /bots/{bot}/introduction, plugin_api.py introduce_bot) ----
export interface IntroductionView {
  state: "none" | "running" | "done" | "unavailable";
  session_id: string | null;
  run_id: string | null;
  estimate_cents: number | null;   // a real model run: the person confirms this cost first
  requires_confirm: boolean;
  reason?: "bot_offline" | "hook_not_live" | "budget_exceeded" | "bot_paused" | "no_template" | string;  // when unavailable
}

/** Change a Bot's model from its Profile (contract v0.11 1). `provider` and `model` are null when none is set. Nothing else of Hermes's answer reaches the screen. */
export interface BotModelInfo { provider: string | null; model: string | null; context_length: number | null }
export interface ModelProviderOption { slug: string; name?: string; current?: boolean; models: string[] }
export interface ModelOptions { providers: ModelProviderOption[] }
/** POST answer: it applies from the next message, a LuveBot conversation that is already open included (v0.11 M-2: the API Server builds an agent for every run); a channel conversation is not measured, so nothing is promised about it. `stale_aux` names the helper slots (vision, ...) that still use the previous provider. */
export interface ModelSetResult { provider: string; model: string; applies: "next_message"; stale_aux: string[] }

/** GET /bots/{bot}/soul and the answer of PUT (contract v0.4 B6): the SOUL.md WITHOUT the managed rules block (which the server keeps byte for byte), the digest of that
 *  text the PUT must send back (`expected_digest`: a file that changed meanwhile is 409 `stale`), and whether the text was cut at 64 KiB. The text is fully shown (and so editable) only when `redacted` is false and `truncated` is false. */
export interface SoulView {
  content: string;
  expected_digest: string;
  truncated: boolean;
  /** v0.10 6: `true` when what is shown is NOT what the file holds (a key hidden as asterisks, an inline image shown as [image]); always sent. Saving such a text would write the hiding over the real one. */
  redacted: boolean;
  exists: boolean;
  rules_block: { present: boolean; digest: string | null };
}

/** The voice language a person can choose per Bot (docs/contracts/voice-language-reactions-v0.md section 2): the only three words the PUT takes. */
export type VoiceLanguage = "auto" | "pt" | "en";
/** What the status says about the Bot's voice configuration (VL-1): `language` is `other` for a value the person set in Hermes outside pt/en (A-281), read only; `stt.language` is the RAW value, empty when not set. No secret. */
export interface VoiceSettings {
  stt: { provider: string | null; language: string | null };
  tts: { provider: string | null; voice: string | null };
  language: VoiceLanguage | "other";
}

/** GET /bots/{bot}/voice (contract v0.7 3.1) */
export interface VoiceStatus {
  /** VL-1: absent on a server older than that; the screen then shows no voice card and no line under the Radio. */
  settings?: VoiceSettings;
  radio: { available: boolean; reason: null | "hermes_audio_missing" };
  call: { available: boolean; reason: null | "no_openai_key" | "hermes_audio_missing" | "bot_paused" | "budget"; cents_per_minute: number; max_seconds: number; max_delegations: number };
  client_direct: boolean;
}

// ---- Skills per Bot (contract v0.6 Part A) ----
export type SkillState = "on" | "off" | "partial";
export interface BotSkill {
  name: string; description: string; category?: string | null;
  provenance: "hub" | "bundled" | "agent" | string; usage?: number | null; essential: boolean;
  /** `all` is the global state Hermes writes; one key per platform the Bot's config can differ on (api_server, telegram, …) */
  enabled: Record<string, boolean> & { all: boolean };
  state: SkillState; toggle?: boolean;
}
export interface BotSkillsResponse {
  bot: string; platforms: string[]; skills: BotSkill[];
  notes: { on_applies_to_new_conversations: boolean; fail_open: boolean; catalog_may_omit: boolean };
}
export interface SkillsMatrix {
  bots: Array<string | { bot: string; error: string }>;
  skills: Array<{ name: string; provenance: string }>;
  cells: Array<{ bot: string; skill: string; state: SkillState | "absent" }>;
  /** The route cuts at 50 Bots and 500 skills; says which it cut (2nd cross review F6). Absent on an older backend: the screen then goes by the counts. */
  truncated?: { bots: boolean; skills: boolean };
}
export interface SkillToggleResult { skill: BotSkill; notice: "on_applies_to_new_conversations" | null; still_off_on: string[] }
export interface SkillContent {
  name: string; content: string; redacted: boolean; truncated: boolean;
  /** Contract v0.11 3.3 (additive): the digest of the REAL text, and whether the editor may write it back (`provenance: agent`, shown whole and unchanged). Absent on an older backend: not editable. */
  digest?: string; editable?: boolean;
}

// ---- Teach by demonstration (contract v0.11 section 3) ----
/** What the dry run says of the invisible characters the table ALLOWS (3.4): how many, which (by code point) and where (line from 1 by LF, column from 1 in code points). */
export interface SkillInvisibleWarning { kind: "invisible_characters"; count: number; kinds: Array<{ code: string; count: number }>; where: Array<{ line: number; column: number }> }
/** POST /bots/{bot}/skills with `dry_run: true`: the normalized preview. Nothing was written. */
export interface SkillPreview { name: string; category: string | null; description: string; bytes: number; warnings: SkillInvisibleWarning[] }
/** Hermes's own scanner on the skill, as counts and category names only (never a finding's text); `policy` is what LuveBot does with it: `block` cannot be turned on from here. */
export interface SkillScan { verdict: string; policy: "allow" | "ask" | "block"; findings: number; categories: string[] }
/** POST /bots/{bot}/skills with `dry_run: false`: created OFF. */
export interface SkillCreated { skill: BotSkill; enabled: false; scan: SkillScan | null }
/** PUT /bots/{bot}/skills/{skill}/content: `on` says the skill is ON (the Bot uses the change at once). */
export interface SkillEdited { name: string; bytes: number; digest: string; warnings: SkillInvisibleWarning[]; on: boolean; scan: SkillScan | null;
  /** A-177: the edit left an ON skill with a `block` scan, so LuveBot turned it OFF (`on` is then false). Absent on a server before SK-2f. */
  turned_off?: boolean }

// ---- GET /costs/quota (contract F6.1): the plan quota Hermes reports per provider. Information only: it never gates anything. ----
export interface QuotaWindow { label: string; scope: string; used_percent: number; remaining_percent: number; resets_at: number | null }
export type QuotaAccountState = "ready" | "limited" | "unknown" | "unavailable";
export interface QuotaProvider {
  slug: string;
  name: string;
  /** a single account's windows, or a pool of 2+ credentials as unnamed rows (an account's id and label never leave the backend) */
  usage: null | { windows: QuotaWindow[] } | { accounts: Array<{ state: QuotaAccountState; windows: QuotaWindow[]; resets_at: number | null }> };
  limit: null | { scope: "account"; resets_at: number } | { scope: "models"; models: Record<string, number> };
}
export interface PlanQuotaResponse {
  available: boolean;
  reason: null | "hermes_without_quota" | "unreadable";
  fetched_at: number | null;
  stale: boolean;
  bots: Array<{ bot: string; providers: QuotaProvider[] }>;
}

// ---- Hermes main (contract v0.9 §1.2): present only when the backend sees a Hermes with session authority ----
/** What a run waits for. The clarify text is agent-written: plain text only. `multi_select`: one or more of `choices`; no choices: free text. */
export type RunControl =
  | { kind: "approval"; request_id: string }
  | { kind: "clarify"; request_id: string; question: string; choices: string[]; multi_select: boolean; timeout_s?: number };
/** A run Hermes lost track of (status "unknown", not terminal): it stays open until a person with a login says it ended. */
export interface RunResolution { needed: boolean; admission_id?: string; execution_generation: number }

// ---- GET /waiting?bot= (contract v0.9 §7): what the Bots wait for a person to do, seen by the hook (observed, never answered) ----
export type WaitingKind = "clarify" | "sudo" | "approval" | "other";
export interface WaitingItem {
  bot: string;
  request_id: string;
  kind: WaitingKind;
  since: number;                 // epoch seconds
  session_id: string | null;
  platform: string | null;       // the session's source: "api_server" is LuveBot's own conversation, "cli", "telegram"…; null when unreadable
  prompt: string | null;         // only for clarify: agent-written, redacted, plain text; sudo and approval carry a command, so null
}
export interface WaitingResponse { waiting: WaitingItem[]; partial: string[] }

// ---- Call, real time (contract v0.7 §3.2-3.4): the media goes browser <-> OpenAI; LuveBot exchanges the SDP, counts minutes and delegations ----
export interface CallStart { call_id: string; sdp: string; max_seconds: number; max_delegations: number; heartbeat_seconds: number }
export interface CallBeat { stop: boolean; reason: null | "max_time" | "budget" | "bot_paused"; remaining_seconds: number }
export interface CallReceipt { seconds: number; delegations: number; cents: number }

// ---- GET /bots/{bot}/free-passes (contract v0.9 §5, hook 0.5.0): what the Livre let through, newest first ----
export interface FreePass { at: number; tool: string; rule_id: string | null; command: string | null; audited: boolean }
export interface FreePassesResponse { free_passes: FreePass[]; next_before: number | null }

// ---- Memory, item by item (contract v0.8 §1): Hermes's own MemoryStore in the Bot's profile; the page never sees an unredacted entry ----
export type MemoryTarget = "memory" | "user";
export interface MemoryEntry { id: string; text: string; redacted: boolean }
export interface MemoryTargetView { enabled: boolean; limit: number; used: number; entries: MemoryEntry[] }
export interface MemoryViewResponse {
  targets: Record<MemoryTarget, MemoryTargetView>;
  /** an external memory provider the Bot uses (managed in Hermes, not editable here), or null */
  provider: string | null;
  notice: "applies_to_new_conversations";
}

// ---- Notifications, push without payload (contract v0.8 §6) ----
export type PushKind = "approval" | "budget";
/** `subject`: whether the server has a contact address the push services accept (contract v0.11 7.1); `ok: false` means LuveBot sends nothing. Never the address itself. Absent on a server before 7.1. */
export interface PushConfig { public_key: string; enabled_kinds: string[]; subject?: { ok: boolean; source: "setting" | "public_url" | null } }
/** One device of the signed-in person that gets notifications. `host` is the push service (never the delivery address, which stays on the server). */
export interface PushDevice {
  id: number; kinds: string[]; created_at: number | null; host: string | null;
  /** The last send to this device (7.2): `ok` false is a refusal, with `reason` from the server's closed list; null: nothing was sent yet. */
  last?: { at: number | null; ok: boolean; status: number; reason: string | null } | null;
  /** The device was subscribed without the current key (7.4): the push service refuses what is sent to it. */
  stale?: boolean;
}
