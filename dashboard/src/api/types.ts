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

export interface HealthHermesInfo {
  version: string;
  release_date: string;
  baseline: string;
  baseline_ok: boolean;
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
  auth_mode: "loopback" | "gated";
}

export interface BotAvatar {
  kind: "emoji" | "initials" | "mascot" | "image"; // image: legacy rows only, read-only, drawn as initials (contract §14.4)
  value: string;
}

export interface BotDisplay {
  label: string;
  role: string;
  call_me?: string | null;
  color: string;
  avatar: BotAvatar;
  hidden?: boolean;
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
}

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
}

export interface ApiErrorDetail {
  code: string;
  message: string;
  request_id?: string;
  details?: Record<string, any>;
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
  conditions?: Record<string, string>;
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
  winner?: Hit | null;
  hits: Hit[];
  reason?: string;
}

export interface Simulation {
  ok?: boolean;
  decision: Decision;
  seals?: Record<string, SealResult>;
  effective_mechanisms?: any[];
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

export interface CostsResponse {
  period: CostPeriod;
  currency: "USD";
  totals: CostsTotals;
  groups: CostGroup[];
  ledger: CostsLedger;
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
export type RoutinePausedReason = "user" | "budget" | null;

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

export interface RoutinesResponse {
  routines: Routine[];
  next_cursor?: string | null;
}

export interface RoutineRunsResponse {
  runs: RoutineRun[];
  next_cursor?: string | null;
  truncated?: boolean;
}

export interface CreateRoutineRequest {
  bot: string;
  name: string;
  schedule: RoutineSchedule;
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

export type ActivityKind = "run" | "routine_run" | "routine_due" | "task";

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
}

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
  tool_calls?: { name: string; args_summary: string | null }[];
  /** async_delegation_complete: a background helper's result delivered to the session (gateway/wake.py), never the person. */
  display_kind?: "steer" | "failed_turn" | "hidden" | "async_delegation_complete";
  display_metadata?: { delegation_id?: string; task_count?: number; completed_count?: number; failed_count?: number; duration_seconds?: number };
  page_ref?: { slug: string };
}

export interface HistoryMessagesResponse {
  messages: HistoryMessage[];
  next_cursor?: string | null;
}

// ---- D-025: where a Bot's approvals are answered (docs/propostas/d025-superficie-de-aprovacao.md §d) ----
export type ApprovalSurfaceMode = "luvebot" | "channel";
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
