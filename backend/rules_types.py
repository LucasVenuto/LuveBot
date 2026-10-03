"""Types of the pure rules engine (ADR-002 section 8). Data only: no logic, no I/O."""
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

RULES_API_VERSION = 1


class Level(StrEnum):
    ALLOW = "allow"
    EXPLICIT = "explicit"
    ASK = "ask"
    HANDBACK = "handback"
    BLOCK = "block"


class ScopeKind(StrEnum):
    GLOBAL = "global"
    ROOM = "room"
    BOT = "bot"
    ROUTINE = "routine"


class RuleState(StrEnum):
    DRAFT = "draft"
    ACTIVE = "active"
    ARCHIVED = "archived"
    SUGGESTION = "suggestion"


class Origin(StrEnum):
    BUILTIN = "builtin"
    HUMAN = "human"
    ALWAYS_ALLOW = "always_allow"
    BOT_SUGGESTION = "bot_suggestion"


class Seal(StrEnum):
    LOCK = "lock"      # real block (also real handback, with the "handback" qualifier)
    HAND = "hand"      # real approval
    NOTE = "note"      # guidance only
    NONE = "none"      # nothing to seal (allow, drafts)
    BROKEN = "broken"  # the seal would contradict the live state


class MechanismId(StrEnum):  # M1..M12 of the ADR
    TOOLSET_OFF = "toolset_off"
    MCP_OFF = "mcp_off"
    MCP_TOOL_EXCLUDE = "mcp_tool_exclude"
    APPROVALS_DENY = "approvals_deny"
    HOOK_BLOCK = "hook_block"
    HOOK_APPROVE = "hook_approve"
    COMMAND_GATE = "command_gate"
    MCP_TRUST = "mcp_trust"
    SOUL = "soul"


class ActorKind(StrEnum):
    HUMAN = "human"
    AGENT = "agent"
    SYSTEM = "system"


@dataclass(frozen=True, slots=True)
class Actor:
    kind: ActorKind
    id: str  # "basic:harness-human", "dashboard", "bot:vendas", "system"


@dataclass(frozen=True, slots=True)
class Scope:
    kind: ScopeKind
    ref: str | None = None  # None for GLOBAL; profile / room id / job id otherwise


@dataclass(frozen=True, slots=True)
class Match:
    tools: tuple[str, ...] = ()        # globs (`*`, `?`, `\` escape), matched on the canonical tool name
    toolsets: tuple[str, ...] = ()     # exact names
    mcp_servers: tuple[str, ...] = ()  # exact names
    commands: tuple[str, ...] = ()     # globs on the normalized command text
    conditions: tuple[tuple[str, str], ...] = ()  # (fact, value) equality, ADR 4.1
    # Any-of inside a field, all-of across the fields that are non-empty. An all-empty Match matches nothing.


@dataclass(frozen=True, slots=True)
class Rule:
    id: str
    label: str
    level: Level
    scope: Scope
    match: Match
    state: RuleState
    origin: Origin
    builtin: bool = False
    applied: tuple[str, ...] = ()  # what LuveBot configured, e.g. "toolset_off:browser@api_server"
    version: int = 1
    updated_by: str = ""


@dataclass(frozen=True, slots=True)
class Action:
    bot: str
    tool: str  # "terminal", "web_search", "mcp_crm_update_contact"
    toolset: str | None = None
    mcp_server: str | None = None
    command: str | None = None  # terminal or execute_code text, already redacted
    room: str | None = None
    routine: str | None = None
    facts: tuple[tuple[str, str], ...] = ()
