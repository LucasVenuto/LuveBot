"""T1.4: the pure rules engine (ADR-002 section 8, decisions R-1..R-13).

Every invariant is a function `inv_<name>(m)` over a rules MODULE `m`. It runs against the real `backend.rules`
(must pass) and again against variants of the module with ONE deliberate defect each (must go red): the variant is the
real source with one exact text replacement, loaded as its own package, so tests construct every object through `m`.
"""
from __future__ import annotations

import ast
import importlib
import itertools
import math
from pathlib import Path
import shutil
import sys

import pytest

import backend.rules as real

SRC = Path(real.__file__).parent
NOW = 1000.0


# ---------------------------------------------------------------------------------------------------------------------
# builders (everything is built through the module under test)
# ---------------------------------------------------------------------------------------------------------------------
def rule(m, id, level, *, tools=(), toolsets=(), servers=(), commands=(), conditions=(), scope=None, state=None,
         origin=None, applied=()):
    return m.Rule(id=id, label=id, level=level, scope=scope or m.Scope(m.ScopeKind.GLOBAL),
                  match=m.Match(tools=tuple(tools), toolsets=tuple(toolsets), mcp_servers=tuple(servers),
                                commands=tuple(commands), conditions=tuple(conditions)),
                  state=state or m.RuleState.ACTIVE, origin=origin or m.Origin.HUMAN, applied=tuple(applied))


def action(m, tool="terminal", **kw):
    kw.setdefault("bot", "vendas")
    return m.Action(tool=tool, **kw)


def human(m):
    return m.Actor(m.ActorKind.HUMAN, "basic:harness-human")


def live(m, *, surfaces=("api_server", "telegram"), tools=None, mcp=(), mode="manual", cron_mode="deny", unattended="deny",
         allowlist=(), fallback=None, deny=(), hook=None, soul=(False, None), room=None, backend="local", read_at=NOW, surface=None):
    if tools is None:
        tools = {s: {"terminal", "web"} for s in surfaces if s != "room"}
    platform_tools = tuple(m.PlatformTools(p, frozenset(t)) for p, t in tools.items())
    return m.LiveState(
        profile="vendas", surfaces=tuple(surfaces), platform_tools=platform_tools, mcp=tuple(mcp),
        approvals=m.ApprovalsState(mode, tuple(deny), cron_mode, unattended, 60, "luvebot", fallback, frozenset(allowlist)),
        hook=hook or m.HookState(True, 5.0, "d1", "0.2.0"), soul=m.SoulState(*soul),  # the current hook (S1 needs >= 0.2.0)
        room_policy=None if room is None else m.RoomPolicyState(frozenset(room[0]), room[1]), terminal_backend=backend,
        read_at=read_at, approval_surface=surface)


def seal(m, r, st, expected="d1", now=NOW, ids="present", problems=()):
    """The compiled table is assumed to contain the rule unless a test says otherwise (ids=None or a set)."""
    ids = frozenset({r.id}) if ids == "present" else ids
    return m.compute_seal(r, st, expected_hook_digest=expected, now=now, hook_rule_ids=ids, hook_problems=problems)


def codes(result):
    return {p.code for p in result.problems}


def must_raise(m, code, fn, *args, **kw):
    try:
        fn(*args, **kw)
    except m.RuleError as error:
        assert error.args[0] == code, f"expected {code}, got {error.args[0]}"
        return
    raise AssertionError(f"expected RuleError({code})")


SCOPES = lambda m: [m.Scope(m.ScopeKind.GLOBAL), m.Scope(m.ScopeKind.BOT, "vendas"), m.Scope(m.ScopeKind.ROOM, "sala"),
                    m.Scope(m.ScopeKind.ROUTINE, "job")]
WIDE = lambda m: action(m, "send_email", room="sala", routine="job")


# ---------------------------------------------------------------------------------------------------------------------
# the 15 invariants of ADR section 8
# ---------------------------------------------------------------------------------------------------------------------
def inv_ask_beats_allow(m):
    L = m.Level
    for low in (L.ALLOW, L.EXPLICIT):
        for s_low, s_ask in itertools.product(SCOPES(m), repeat=2):
            d = m.evaluate([rule(m, "low", low, tools=["send_*"], scope=s_low),
                            rule(m, "ask", L.ASK, tools=["send_email"], scope=s_ask)], WIDE(m))
            assert (d.effect, d.winner, d.reason) == (L.ASK, "ask", m.ReasonCode.ASK_BEATS_ALLOW), (low, s_low, s_ask)


def inv_stricter_wins(m):
    L = m.Level
    for strict in (L.BLOCK, L.HANDBACK):
        for s_strict, s_ask in itertools.product(SCOPES(m), repeat=2):
            d = m.evaluate([rule(m, "ask", L.ASK, tools=["send_email"], scope=s_ask),
                            rule(m, "strict", strict, tools=["send_email"], scope=s_strict)], WIDE(m))
            assert (d.effect, d.winner, d.reason) == (strict, "strict", m.ReasonCode.STRICTER_WINS), (strict, s_strict, s_ask)
    d = m.evaluate([rule(m, "h", L.HANDBACK, tools=["x"]), rule(m, "b", L.BLOCK, tools=["x"])], action(m, "x"))
    assert d.effect is L.BLOCK and d.winner == "b"
    # nothing matches -> allow; a rule of another Bot / room / routine does not apply
    other = [rule(m, "o1", L.BLOCK, tools=["x"], scope=m.Scope(m.ScopeKind.BOT, "outro")),
             rule(m, "o2", L.BLOCK, tools=["x"], scope=m.Scope(m.ScopeKind.ROOM, "outra")),
             rule(m, "o3", L.BLOCK, tools=["x"], scope=m.Scope(m.ScopeKind.ROUTINE, "outro"))]
    assert m.evaluate(other, action(m, "x", room="sala", routine="job")).effect is L.ALLOW


def inv_order_independent(m):
    L = m.Level
    rules = [rule(m, "a", L.ALLOW, tools=["send_*"]), rule(m, "b", L.ASK, tools=["send_email"], scope=m.Scope(m.ScopeKind.ROOM, "sala")),
             rule(m, "c", L.BLOCK, tools=["send_email"], scope=m.Scope(m.ScopeKind.BOT, "vendas")),
             rule(m, "d", L.HANDBACK, tools=["send_email"]), rule(m, "e", L.EXPLICIT, tools=["send_email"]),
             *m.builtin_rules()]
    base_decision = m.evaluate(rules, WIDE(m))
    kw = dict(version=1, toolset_tools={}, mcp_server_tools={})
    base_table = m.compile_hook_table(rules, **kw)
    assert base_decision.effect is L.BLOCK and base_decision.winner == "c"
    for order in itertools.islice(itertools.permutations(rules[:6]), 0, None, 7):
        shuffled = list(order) + rules[6:]
        assert m.evaluate(shuffled, WIDE(m)) == base_decision
        table = m.compile_hook_table(shuffled, **kw)
        assert table.digest == base_table.digest and table.entries == base_table.entries
    assert m.evaluate(list(reversed(rules)), WIDE(m)) == base_decision


def inv_draft_has_no_effect(m):
    L = m.Level
    S = m.RuleState
    for state in (S.DRAFT, S.SUGGESTION, S.ARCHIVED):
        r = rule(m, "r", L.BLOCK, tools=["send_email"], state=state)
        d = m.evaluate([r], action(m, "send_email"))
        assert d.effect is L.ALLOW and d.hits == () and d.reason is m.ReasonCode.DEFAULT_ALLOW, state
        assert m.compile_hook_table([r], version=1, toolset_tools={}, mcp_server_tools={}).entries == (), state
    active = rule(m, "r", L.BLOCK, tools=["send_email"])
    assert m.evaluate([active], action(m, "send_email")).effect is L.BLOCK
    assert len(m.compile_hook_table([active], version=1, toolset_tools={}, mcp_server_tools={}).entries) == 1


def inv_always_allow_is_draft(m):
    L = m.Level
    a = action(m, "send_email", command=None, facts=(("recipient", "internal"),))
    for level in (L.ALLOW, L.EXPLICIT):
        d = m.draft_from_always_allow(a, label="x", level=level, rule_id="aa-1")
        assert d.state is m.RuleState.DRAFT and d.origin is m.Origin.ALWAYS_ALLOW and not d.builtin
        assert d.scope == m.Scope(m.ScopeKind.BOT, "vendas") and d.level is level
        assert m.evaluate([d], a).hits == ()  # a draft decides nothing...
        assert m.compile_hook_table([d], version=1, toolset_tools={}, mcp_server_tools={}).entries == ()  # ...and is not enforced
    for level in (L.ASK, L.HANDBACK, L.BLOCK):
        must_raise(m, "bad_level", m.draft_from_always_allow, a, label="x", level=level, rule_id="aa-2")
    must_raise(m, "reserved_id", m.draft_from_always_allow, a, label="x", rule_id="builtin.mine")
    must_raise(m, "bad_id", m.draft_from_always_allow, a, label="x", rule_id="")
    # the draft is exactly this tool, this command and these facts: once activated by a human it does not widen
    c = action(m, "terminal", command="ls *.tmp")
    d = m.draft_from_always_allow(c, label="x", rule_id="aa-3")
    live_rule = m.activate(d, actor=human(m), now_version=2)
    assert m.evaluate([live_rule], c).effect is L.ALLOW and m.evaluate([live_rule], c).hits
    assert m.evaluate([live_rule], action(m, "terminal", command="ls other.tmp")).hits == ()
    assert m.evaluate([live_rule], action(m, "terminal", command="ls *.tmp; whoami")).hits == ()


def inv_agent_cannot_activate(m):
    L = m.Level
    draft = rule(m, "r", L.ALLOW, tools=["x"], state=m.RuleState.DRAFT)
    for kind in (m.ActorKind.AGENT, m.ActorKind.SYSTEM):
        must_raise(m, "human_required", m.activate, draft, actor=m.Actor(kind, "bot:vendas"), now_version=2)
        must_raise(m, "human_required", m.archive, draft, actor=m.Actor(kind, "x"))
    must_raise(m, "human_required", m.activate, draft, actor=m.Actor(m.ActorKind.HUMAN, "bot:vendas"), now_version=2)
    must_raise(m, "human_required", m.activate, draft, actor="human", now_version=2)
    must_raise(m, "human_required", m.activate, draft, actor=None, now_version=2)
    for level in L:
        s = m.propose_from_agent("proposta", level, m.Scope(m.ScopeKind.GLOBAL), m.Match(tools=("x",)), bot="vendas", rule_id="s-" + level.value)
        assert s.state is m.RuleState.SUGGESTION and s.origin is m.Origin.BOT_SUGGESTION and not s.builtin
        assert m.evaluate([s], action(m, "x")).hits == ()
        must_raise(m, "not_a_draft", m.activate, s, actor=human(m), now_version=2)  # a suggestion cannot jump to active
        must_raise(m, "human_required", m.draft_from_suggestion, s, actor=m.Actor(m.ActorKind.AGENT, "bot:vendas"))
    s = m.propose_from_agent("p", L.BLOCK, m.Scope(m.ScopeKind.GLOBAL), m.Match(tools=("x",)), bot="vendas", rule_id="s-ok")
    d = m.draft_from_suggestion(s, actor=human(m))
    assert d.state is m.RuleState.DRAFT
    a = m.activate(d, actor=human(m), now_version=d.version + 1)
    assert a.state is m.RuleState.ACTIVE and a.updated_by == "basic:harness-human"
    must_raise(m, "stale_version", m.activate, d, actor=human(m), now_version=d.version)
    must_raise(m, "reserved_id", m.propose_from_agent, "p", L.ALLOW, m.Scope(m.ScopeKind.GLOBAL), m.Match(tools=("x",)), bot="b", rule_id="builtin.delete_permanent")


def inv_builtin_immutable(m):
    built = m.builtin_rules()
    assert len(built) == 9 and all(b.builtin and b.state is m.RuleState.ACTIVE and b.origin is m.Origin.BUILTIN
                                   and b.scope == m.Scope(m.ScopeKind.GLOBAL) and not m.validate_rule(b) for b in built)
    for b in built:
        must_raise(m, "builtin_immutable", m.activate, b, actor=human(m), now_version=b.version + 1)
        must_raise(m, "builtin_immutable", m.archive, b, actor=human(m))
        must_raise(m, "builtin_immutable", m.draft_from_suggestion, b, actor=human(m))
    forged = m.Rule("builtin.sneaky", "x", m.Level.ALLOW, m.Scope(m.ScopeKind.GLOBAL), m.Match(tools=("x",)),
                    m.RuleState.DRAFT, m.Origin.HUMAN)
    assert {p.code for p in m.validate_rule(forged)} == {"reserved_id"}
    # an allow never beats a builtin (ADR 4.1), whatever its scope
    allow = rule(m, "allow-all", m.Level.ALLOW, tools=["*"], scope=m.Scope(m.ScopeKind.ROUTINE, "job"))
    d = m.evaluate([allow, *built], action(m, "files_delete", routine="job"))
    assert d.effect is m.Level.ASK and d.winner == "builtin.delete_permanent"


def inv_conditions_fail_closed(m):
    L = m.Level
    cond = (("recipient", "external"),)
    for level in (L.ASK, L.HANDBACK, L.BLOCK):
        r = rule(m, "r", level, tools=["send_email"], conditions=cond)
        assert m.evaluate([r], action(m, "send_email")).effect is level                                   # fact missing: matches
        assert m.evaluate([r], action(m, "send_email", facts=(("recipient", "External "),))).effect is level  # same fact, other spelling
        assert m.evaluate([r], action(m, "send_email", facts=(("recipient", "internal"),))).effect is L.ALLOW
    for level in (L.ALLOW, L.EXPLICIT):
        r = rule(m, "r", level, tools=["send_email"], conditions=cond)
        assert m.evaluate([r], action(m, "send_email")).hits == ()                                         # fact missing: no match
        assert m.evaluate([r], action(m, "send_email", facts=(("recipient", "external"),))).hits
        assert m.evaluate([r], action(m, "send_email", facts=(("recipient", "external"), ("recipient", "internal")))).hits == ()


def inv_seal_liar(m):
    L = m.Level
    r = rule(m, "no-terminal", L.BLOCK, toolsets=["terminal"], applied=["toolset_off:terminal@api_server"])
    hook_down = m.HookState(False, None, None)
    partial = live(m, tools={"api_server": {"web"}, "telegram": {"terminal", "web"}}, hook=hook_down)
    s = seal(m, r, partial)
    assert s.seal is m.Seal.BROKEN and "uncovered_surface" in codes(s)
    assert any(p.code == "uncovered_surface" and p.detail == "telegram" for p in s.problems)
    both = live(m, tools={"api_server": {"web"}, "telegram": {"web"}}, hook=hook_down)
    assert seal(m, r, both).seal is m.Seal.LOCK
    again = live(m, tools={"api_server": {"web", "terminal"}, "telegram": {"web"}}, hook=hook_down)  # someone turned it back on
    s = seal(m, r, again)
    assert s.seal is m.Seal.BROKEN and {"toolset_still_enabled", "applied_drift"} <= codes(s)
    # a surface nobody reported is not assumed covered
    unknown = live(m, surfaces=("api_server", "telegram"), tools={"api_server": {"web"}}, hook=hook_down)
    assert seal(m, r, unknown).seal is m.Seal.BROKEN


def inv_seal_cli_trap(m):
    r = rule(m, "no-terminal", m.Level.BLOCK, toolsets=["terminal"])
    hook_down = m.HookState(False, None, None)
    st = live(m, surfaces=("api_server",), tools={"cli": {"web"}, "api_server": {"terminal", "web"}}, hook=hook_down)
    s = seal(m, r, st)
    assert s.seal is m.Seal.BROKEN and {"toolset_still_enabled", "uncovered_surface"} <= codes(s)
    only_cli = live(m, surfaces=("api_server",), tools={"cli": {"web"}}, hook=hook_down)
    assert seal(m, r, only_cli).seal is m.Seal.BROKEN
    assert seal(m, r, live(m, surfaces=("api_server",), tools={"cli": {"terminal"}, "api_server": {"web"}}, hook=hook_down)).seal is m.Seal.LOCK


def inv_seal_room_policy(m):
    r = rule(m, "no-terminal", m.Level.BLOCK, toolsets=["terminal"])
    hook_down = m.HookState(False, None, None)
    st = live(m, surfaces=("api_server", "room"), tools={"api_server": {"web"}}, room=({"bot_room", "terminal"}, "manual"), hook=hook_down)
    s = seal(m, r, st)
    assert s.seal is m.Seal.BROKEN and {"room_policy", "uncovered_surface"} <= codes(s)
    ok = live(m, surfaces=("api_server", "room"), tools={"api_server": {"web"}}, room=({"bot_room"}, "manual"), hook=hook_down)
    assert seal(m, r, ok).seal is m.Seal.LOCK
    unknown = live(m, surfaces=("api_server", "room"), tools={"api_server": {"web"}}, room=None, hook=hook_down)
    assert seal(m, r, unknown).seal is m.Seal.BROKEN


def inv_seal_hand_bypasses(m):
    L = m.Level
    ask = rule(m, "ask-mail", L.ASK, tools=["send_email"])
    cmd = rule(m, "ask-cmd", L.ASK, commands=["deploy *"])
    assert seal(m, ask, live(m)).seal is m.Seal.HAND and seal(m, cmd, live(m)).seal is m.Seal.HAND
    cases = [("approvals_off", ask, live(m, mode="off")), ("approvals_off", ask, live(m, mode="unheard-of")),
             ("smart_mode", cmd, live(m, mode="smart")),
             ("allowlist_covers", ask, live(m, allowlist=["plugin_rule:ask-mail"])),
             ("allowlist_covers", cmd, live(m, allowlist=["deploy *"])),
             ("cron_auto_approve", ask, live(m, surfaces=("api_server", "cron"), cron_mode="approve")),
             ("unattended_auto_approve", ask, live(m, surfaces=("api_server", "webhook"), unattended="approve")),
             ("room_policy", ask, live(m, surfaces=("api_server", "room"), room=({"bot_room"}, "off"))),
             ("transport_fallback_builtin", ask, live(m, fallback="builtin"))]
    for code, r, st in cases:
        s = seal(m, r, st)
        assert s.seal is m.Seal.BROKEN and code in codes(s), code
    # smart mode matters to command rules only (ADR 3.3: "only M8")
    assert seal(m, ask, live(m, mode="smart")).seal is m.Seal.HAND
    # without the hook an ask rule on a tool has no real mechanism
    assert seal(m, ask, live(m, hook=m.HookState(False, None, None))).seal is m.Seal.BROKEN
    # MCP trust is a real approval for a whole server, and says so (where it is not a channel's own prompt: S1)
    server = m.McpServerState("crm", True, "untrusted", None, ())
    r = rule(m, "ask-crm", L.ASK, servers=["crm"])
    s = seal(m, r, live(m, surfaces=("api_server",), mcp=[server], hook=m.HookState(False, None, None)))
    assert s.seal is m.Seal.HAND and "writes_only" in s.qualifiers
    s = seal(m, r, live(m, mcp=[server], hook=m.HookState(False, None, None)))   # + telegram, no live hook to block it there
    assert s.seal is m.Seal.BROKEN and "channel_approval_outside" in codes(s)
    s = seal(m, r, live(m, mcp=[m.McpServerState("crm", True, "trusted", None, ())], hook=m.HookState(False, None, None)))
    assert s.seal is m.Seal.BROKEN


def inv_seal_hook_stale(m):
    r = rule(m, "block-mail", m.Level.BLOCK, tools=["send_email"])
    assert seal(m, r, live(m)).seal is m.Seal.LOCK
    for hook, code in ((m.HookState(True, 500.0, "d1"), "hook_stale"), (m.HookState(True, None, "d1"), "hook_stale"),
                       (m.HookState(True, math.nan, "d1"), "hook_stale"), (m.HookState(True, 5.0, "other"), "hook_digest_mismatch"),
                       (m.HookState(True, 5.0, None), "hook_digest_mismatch"), (m.HookState(False, 5.0, "d1"), "hook_missing")):
        s = seal(m, r, live(m, hook=hook))
        assert s.seal is m.Seal.BROKEN and code in codes(s), (hook, code)
    assert seal(m, r, live(m), expected=None).seal is m.Seal.BROKEN
    # the age was measured at read_at: a snapshot that is itself old is stale
    s = seal(m, r, live(m), now=NOW + 500)
    assert s.seal is m.Seal.BROKEN and "hook_stale" in codes(s)
    assert seal(m, r, live(m, hook=m.HookState(True, 100.0, "d1"))).seal is m.Seal.LOCK


BAD_TABLES = ["", "not json", "[]", "{}", '{"version":1}', "null", '{"version":true,"digest":"x","entries":[],"problems":[]}',
              '{"version":-1,"digest":"x","entries":[],"problems":[]}', '{"version":1,"digest":"x","entries":[],"problems":[],"extra":1}',
              '{"version":1,"digest":"x","entries":[],"problems":[]}',  # digest does not match
              '{"version":NaN,"digest":"x","entries":[],"problems":[]}', "[" * 2000]


def inv_hook_fail_closed(m):
    good = m.compile_hook_table([rule(m, "r", m.Level.ASK, tools=["x"])], version=1, toolset_tools={}, mcp_server_tools={}).to_json()
    bad = list(BAD_TABLES) + [good[: len(good) // 2], good.replace('"approve"', '"allow"'), good.replace('"strict":true', '"strict":1'),
                              good.replace('"rule_id":"r"', '"rule_id":5'), good.replace('"tools":["x"]', '"tools":["x",1]')]
    for text in bad:
        must_raise(m, "bad_table", m.HookTable.from_json, text)
    for junk in (None, 5, b"{}", ["x"]):
        must_raise(m, "bad_table", m.HookTable.from_json, junk)
    must_raise(m, "bad_table", m.hook_verdict, None, tool="x", command=None)
    assert m.HookTable.from_json(good).entries[0].rule_id == "r"


def inv_table_roundtrip(m):
    L = m.Level
    rules = [*m.builtin_rules(), rule(m, "a", L.ASK, toolsets=["web"]), rule(m, "b", L.BLOCK, servers=["crm"], tools=["mcp_crm_delete*"]),
             rule(m, "c", L.BLOCK, toolsets=["ghost"], conditions=[("k", "v")])]
    t = m.compile_hook_table(rules, version=7, toolset_tools={"web": ("web_search", "web_fetch")},
                             mcp_server_tools={"crm": ("mcp_crm_update", "mcp_crm_delete_contact")})
    assert m.HookTable.from_json(t.to_json()) == t and t.digest == m._table_digest(t.entries)
    assert t.to_json() == m.HookTable.from_json(t.to_json()).to_json()
    entry = {e.rule_id: e for e in t.entries}
    assert entry["a"].tools == ("web_fetch", "web_search") and entry["a"].verdict == "approve" and entry["a"].strict
    assert entry["b"].tools == ("mcp_crm_delete_contact",) and entry["b"].verdict == "block" and not entry["b"].strict
    assert "c" not in entry and {"unknown_toolset", "empty_expansion", "condition_not_enforceable"} <= {p.code for p in t.problems}
    flipped = m.HookTable(t.version, t.digest, tuple(m.replace(e, strict=not e.strict) if e.rule_id == "a" else e for e in t.entries))
    assert m._table_digest(flipped.entries) != t.digest


INVARIANTS = {name[4:]: fn for name, fn in globals().items() if name.startswith("inv_")}


# ---------------------------------------------------------------------------------------------------------------------
# beyond the 15: spelling, commands, hook semantics, honesty of the seal, purity
# ---------------------------------------------------------------------------------------------------------------------
def inv_canonical_names(m):
    L = m.Level
    r = rule(m, "no-mail", L.BLOCK, tools=["Send_Email"], toolsets=["Web"])
    for spelling in ("send_email", "SEND_EMAIL", "Send_Email", "ｓｅnd_email"):  # case, full-width compatibility form
        assert m.evaluate([r], action(m, spelling, toolset="WEB")).effect is L.BLOCK, spelling
    assert m.canon_name("Send_Email") == ("send_email", True)
    assert m.canon_name("send_email") == m.canon_name("SEND_EMAIL")
    # also the servers and facts
    srv = rule(m, "srv", L.BLOCK, servers=["CRM"])
    assert m.evaluate([srv], action(m, "t", mcp_server="crm")).effect is L.BLOCK


def inv_noncanonical_asks(m):
    L = m.Level
    allow_all = rule(m, "allow-all", L.ALLOW, tools=["*"])
    odd = ["send_email\x00", "send\u200b_email", "send email", " send_email", "send_email\r", "déjà", "", "\u202esend_email",
           "x" * 200, "tool\u2028name"]
    for name in odd:
        d = m.evaluate([allow_all], action(m, name))
        assert d.effect is L.ASK and d.reason is m.ReasonCode.NONCANONICAL_ACTION and d.winner is None, repr(name)
    # a restrictive rule written for the plain name still catches the odd spelling (and is cited)
    block = rule(m, "block", L.BLOCK, tools=["send_email"])
    for name in ("send_email\x00", "send\u200b_email", " send_email\t"):
        d = m.evaluate([allow_all, block], action(m, name))
        assert d.effect is L.BLOCK and d.winner == "block", repr(name)
    # command text
    for command in ("ls\x00", "ls\u200b", "ls \x1b[0m", "a" * 20000):
        assert m.evaluate([allow_all], action(m, "terminal", command=command)).effect is L.ASK, repr(command)[:20]
    assert m.evaluate([allow_all], action(m, "terminal", command="ls -la\n\tpwd")).effect is L.ALLOW
    # garbage in the arguments never raises and never allows
    for bad in (None, "x", 3):
        assert m.evaluate([allow_all], bad).effect is L.ASK
    assert m.evaluate(None, action(m, "x")).effect is L.ASK
    assert m.evaluate([None, "x", allow_all], action(m, "x")).effect is L.ALLOW


def inv_allow_needs_clean_spelling(m):
    allow = rule(m, "allow-all", m.Level.ALLOW, tools=["*"])
    assert m.evaluate([allow], action(m, "ok")).hits
    assert m.evaluate([allow], action(m, "o\u200bk")).hits == ()


def inv_command_segments(m):
    L = m.Level
    allow = rule(m, "allow-git", L.ALLOW, commands=["git status*"])
    assert m.evaluate([allow], action(m, "terminal", command="git status -s")).hits
    for chained in ("git status; echo x", "git status && echo x", "git status | tee f", "git status\necho x", "git status `echo x`",
                    "git status $(echo x)", "git status & echo x"):
        assert m.evaluate([allow], action(m, "terminal", command=chained)).hits == (), chained
    assert m.evaluate([allow], action(m, "terminal", command="git status ; git status -s")).hits


def inv_command_wrappers(m):
    L = m.Level
    block = rule(m, "no-rm", L.BLOCK, commands=["rm *-r*"])
    for command in ("rm -rf /tmp/x", "RM  -RF /tmp/x", "sudo rm -rf /tmp/x", "env FOO=1 rm -rf /tmp/x", "/bin/rm -rf /tmp/x",
                    "echo hi; rm -rf /tmp/x", "echo hi && rm -rf /tmp/x", "sh -c 'rm -rf /tmp/x'", "bash -lc \"echo a; rm -rf /tmp/x\"",
                    "nohup sudo -n rm -rf /tmp/x", "rm\t-rf\n/tmp/x",
                    # wrappers with option / value arguments, interpreters, find-exec, quoting and backslash spellings
                    "timeout 5 rm -rf /tmp/x", "nice -n 10 rm -rf /tmp/x", "ionice -c 3 rm -rf /tmp/x", "setsid rm -rf /tmp/x",
                    "busybox rm -rf /tmp/x", "flock /tmp/l rm -rf /tmp/x", "watch rm -rf /tmp/x", "unbuffer rm -rf /tmp/x",
                    "find /tmp -name x -exec rm -rf {} \\;", "find /tmp -execdir rm -rf {} +", "eval 'rm -rf /tmp/x'",
                    "su -c 'rm -rf /tmp/x'", 'r"m" -rf /tmp/x', "r\\m -rf /tmp/x", "'rm' -rf /tmp/x", "r''m -rf /tmp/x"):
        assert m.evaluate([block], action(m, "terminal", command=command)).effect is L.BLOCK, command
    assert m.evaluate([block], action(m, "terminal", command="ls -la")).effect is L.ALLOW
    assert m.evaluate([block], action(m, "terminal", command=None)).effect is L.ALLOW
    table = m.compile_hook_table([block], version=1, toolset_tools={}, mcp_server_tools={})
    for command in ("rm -rf /tmp/x", "sudo rm -rf /tmp/x", "echo a; rm -rf /tmp/x"):
        assert m.hook_verdict(table, tool="terminal", command=command).action == "block", command
    assert m.hook_verdict(table, tool="terminal", command="ls").action == "none"


def inv_always_allow_command_is_literal(m):
    c = action(m, "terminal", command="ls *.tmp")
    d = m.draft_from_always_allow(c, label="x", rule_id="aa")
    assert d.match.commands == ("ls \\*.tmp",)
    assert m.glob_match("a\\*b", "a*b") and not m.glob_match("a\\*b", "aXb")


def inv_hook_block_beats_approve(m):
    L = m.Level
    rules = [rule(m, "a-ask", L.ASK, tools=["send_email"]), rule(m, "z-block", L.BLOCK, tools=["send_*"]),
             rule(m, "b-ask", L.ASK, tools=["send_email"]), rule(m, "m-hand", L.HANDBACK, tools=["send_email"])]
    t = m.compile_hook_table(rules, version=1, toolset_tools={}, mcp_server_tools={})
    v = m.hook_verdict(t, tool="send_email", command=None)
    assert (v.action, v.rule_id, v.strict) == ("block", "m-hand", False)  # block beats approve; ids break ties
    asks = m.compile_hook_table([rules[0], rules[2]], version=1, toolset_tools={}, mcp_server_tools={})
    v = m.hook_verdict(asks, tool="SEND_EMAIL", command=None)
    assert (v.action, v.rule_id, v.strict, v.message) == ("approve", "a-ask", True, "luvebot:ask:a-ask")
    assert m.hook_verdict(asks, tool="other", command=None) == m.HookVerdict("none", None, None, False)
    assert m.hook_verdict(m.compile_hook_table([], version=1, toolset_tools={}, mcp_server_tools={}), tool="x", command=None).action == "none"
    assert m.hook_verdict(asks, tool="other\x00", command=None).action == "approve"   # unknown spelling is asked about


def inv_hook_ask_is_strict(m):
    t = m.compile_hook_table([rule(m, "a", m.Level.ASK, tools=["x"]), rule(m, "b", m.Level.HANDBACK, tools=["y"]),
                              rule(m, "c", m.Level.BLOCK, tools=["z"])], version=1, toolset_tools={}, mcp_server_tools={})
    got = {e.rule_id: (e.verdict, e.strict, e.message) for e in t.entries}
    assert got == {"a": ("approve", True, "luvebot:ask:a"), "b": ("block", False, "luvebot:handback:b"), "c": ("block", False, "luvebot:block:c")}


def inv_hook_expansion_reports(m):
    L = m.Level
    t = m.compile_hook_table([rule(m, "r", L.BLOCK, toolsets=["web", "ghost"]), rule(m, "s", L.BLOCK, toolsets=["web"], tools=["mail_*"]),
                              rule(m, "w", L.BLOCK, tools=["x"], scope=m.Scope(m.ScopeKind.ROOM, "sala")),
                              rule(m, "o", L.BLOCK, conditions=[("k", "v")])],
                             version=1, toolset_tools={"web": ("web_search",)}, mcp_server_tools={})
    got = {e.rule_id: e for e in t.entries}
    assert got["r"].tools == ("web_search",) and ("unknown_toolset", "ghost") in {(p.code, p.detail) for p in t.problems}
    assert "s" not in got and ("empty_expansion", "s") in {(p.code, p.detail) for p in t.problems}   # never "matches everything"
    assert got["w"].tools == ("x",) and ("scope_widened", "w") in {(p.code, p.detail) for p in t.problems}
    assert got["o"].tools == ("*",)
    must_raise(m, "duplicate_rule_id", m.compile_hook_table, [rule(m, "d", L.BLOCK, tools=["x"]), rule(m, "d", L.BLOCK, tools=["y"])],
               version=1, toolset_tools={}, mcp_server_tools={})


def inv_seal_is_honest(m):
    L = m.Level
    S = m.Seal
    # a seal never coexists with a problem
    block = rule(m, "b", L.BLOCK, tools=["send_email"])
    assert seal(m, block, live(m)).seal is S.LOCK
    assert seal(m, block, live(m, hook=m.HookState(False, None, None))).seal is S.BROKEN
    hand = rule(m, "h", L.HANDBACK, tools=["send_email"])
    s = seal(m, hand, live(m))
    assert s.seal is S.LOCK and "handback" in s.qualifiers
    # drafts, suggestions and allow have nothing to seal
    assert seal(m, rule(m, "d", L.BLOCK, tools=["x"], state=m.RuleState.DRAFT), live(m)).seal is S.NONE
    assert seal(m, rule(m, "a", L.ALLOW, tools=["x"]), live(m)).seal is S.NONE
    # explicit is guidance, and only when it is really written down
    explicit = rule(m, "e", L.EXPLICIT, tools=["send_email"])
    assert seal(m, explicit, live(m)).seal is S.BROKEN and "soul_block_missing" in codes(seal(m, explicit, live(m)))
    assert seal(m, explicit, live(m, soul=(True, "h1"))).seal is S.NOTE
    # command rules: Hermes's own deny list is a real block only when the glob is there
    cmd = rule(m, "c", L.BLOCK, commands=["shutdown *"])
    no_hook = m.HookState(False, None, None)
    s = seal(m, cmd, live(m, deny=["shutdown *"], hook=no_hook))
    assert s.seal is S.LOCK and "pattern" in s.qualifiers
    assert seal(m, cmd, live(m, deny=[], hook=no_hook)).seal is S.BROKEN
    # a rule that matches nothing, and unknown surfaces, are never sealed
    assert seal(m, rule(m, "n", L.BLOCK), live(m)).seal is S.BROKEN
    assert seal(m, block, live(m, surfaces=())).seal is S.BROKEN
    # MCP: off is a block for the next session
    srv = rule(m, "m", L.BLOCK, servers=["crm"])
    on = m.McpServerState("crm", True, "trusted", None, ())
    off = m.McpServerState("crm", False, "trusted", None, ())
    assert seal(m, srv, live(m, mcp=[off], hook=no_hook)).seal is S.LOCK and "next_session" in seal(m, srv, live(m, mcp=[off], hook=no_hook)).qualifiers
    s = seal(m, srv, live(m, mcp=[on], hook=no_hook))
    assert s.seal is S.BROKEN and "mcp_still_enabled" in codes(s)
    # Q: the qualifiers that keep an approval honest
    ask = rule(m, "q", L.ASK, tools=["send_email"], conditions=[("k", "v")])
    s = seal(m, ask, live(m, surfaces=("api_server", "telegram", "cron")))
    assert s.seal is S.HAND and {"yolo_session_invisible", "channels_block", "routine_block", "condition_ignored"} <= set(s.qualifiers)
    # drift: what LuveBot configured and Hermes no longer says
    drift = rule(m, "dr", L.BLOCK, tools=["send_email"], applied=["approvals_deny:send *", "hook:old", "mcp_off:crm"])
    assert seal(m, drift, live(m)).seal is S.BROKEN and "applied_drift" in codes(seal(m, drift, live(m)))
    assert not m.validate_rule(drift)


def inv_simulate_is_enforcement(m):
    L = m.Level
    rules = [rule(m, "allow", L.ALLOW, tools=["send_*"]), rule(m, "ask", L.ASK, tools=["send_email"]), rule(m, "blk", L.BLOCK, tools=["nope"])]
    st = live(m)
    table = m.compile_hook_table(rules, version=1, toolset_tools={}, mcp_server_tools={})
    sim = m.simulate(rules, st, action(m, "send_email"), expected_hook_digest="d1", now=NOW, hook_table=table)
    assert sim.decision == m.evaluate(rules, action(m, "send_email"))
    assert [r for r, _ in sim.seals] == ["ask", "allow"]
    assert dict(sim.seals)["ask"] == seal(m, rules[1], st) and dict(sim.seals)["allow"].seal is m.Seal.NONE
    assert sim.effective_mechanisms == (m.MechanismId.HOOK_APPROVE,)
    broken = m.simulate(rules, live(m, hook=m.HookState(False, None, None)), action(m, "send_email"), expected_hook_digest="d1", now=NOW, hook_table=table)
    assert broken.effective_mechanisms == () and dict(broken.seals)["ask"].seal is m.Seal.BROKEN
    assert m.simulate(rules, st, action(m, "other"), expected_hook_digest="d1", now=NOW, hook_table=table).effective_mechanisms == ()


def inv_validate_rule(m):
    L = m.Level
    ok = rule(m, "ok-1", L.ASK, tools=["send_*"])
    assert m.validate_rule(ok) == ()
    bad = {
        "empty_match": rule(m, "e", L.ASK),
        "bad_id": rule(m, "has space", L.ASK, tools=["x"]),
        "bad_glob": rule(m, "g", L.ASK, tools=["x\u200b"]),
        "scope_ref": rule(m, "s", L.ASK, tools=["x"], scope=m.Scope(m.ScopeKind.BOT, None)),
        "builtin_mismatch": rule(m, "b", L.ASK, tools=["x"], origin=m.Origin.BUILTIN),
        "level_origin_mismatch": rule(m, "l", L.BLOCK, tools=["x"], origin=m.Origin.ALWAYS_ALLOW),
        "malformed": "not a rule",
    }
    for code, r in bad.items():
        assert code in {p.code for p in m.validate_rule(r)}, code
    must_raise(m, "invalid_rule", m.activate, rule(m, "e", L.ASK, state=m.RuleState.DRAFT), actor=human(m), now_version=2)
    assert m.validate_rule(rule(m, "x" * 100, L.ASK, tools=["x"]))


def inv_module_is_pure(m):
    """Stdlib only, siblings only, no I/O, no clock, no randomness, no Hermes: a pure engine cannot approve anything."""
    tree = ast.parse(Path(m.__file__).read_text())
    allowed = {"__future__", "collections.abc", "dataclasses", "fnmatch", "hashlib", "json", "math", "re", "unicodedata"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert {a.name for a in node.names} <= allowed, [a.name for a in node.names]
        if isinstance(node, ast.ImportFrom):
            assert node.level == 1 or node.module in allowed, node.module
            if node.level == 1:
                assert node.module in ("rules_types", "rules_builtin"), node.module
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in {"open", "print", "eval", "exec", "compile", "__import__", "input", "breakpoint"}, node.func.id
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    forbidden = {"subprocess", "socket", "os", "sys", "time", "random", "datetime", "logging", "sqlite3", "requests", "http", "urllib"}
    assert not used & forbidden, used & forbidden


def inv_nothing_activates_without_a_human(m):
    """Fuzz the whole public surface with every non-human actor: nothing may come out ACTIVE except builtin_rules()."""
    L = m.Level
    outputs = []
    base = [rule(m, "r", lvl, tools=["x"], state=st) for lvl in L for st in m.RuleState]
    agents = [m.Actor(k, i) for k in (m.ActorKind.AGENT, m.ActorKind.SYSTEM) for i in ("bot:vendas", "system", "", "dashboard")]
    agents += [m.Actor(m.ActorKind.HUMAN, "bot:vendas"), m.Actor(m.ActorKind.HUMAN, ""), m.Actor(m.ActorKind.HUMAN, "system")]
    for r, actor in itertools.product(base, agents):
        for fn, kw in ((m.activate, {"now_version": 99}), (m.archive, {}), (m.draft_from_suggestion, {})):
            try:
                outputs.append(fn(r, actor=actor, **kw))
            except m.RuleError:
                pass
    for lvl in L:
        outputs.append(m.propose_from_agent("p", lvl, m.Scope(m.ScopeKind.GLOBAL), m.Match(tools=("x",)), bot="b", rule_id="p-" + lvl.value))
        try:
            outputs.append(m.draft_from_always_allow(action(m, "x"), label="l", level=lvl, rule_id="d-" + lvl.value))
        except m.RuleError:
            pass
    assert outputs and all(o.state is not m.RuleState.ACTIVE for o in outputs)


def inv_builtin_catalog(m):
    """R-2: the five families of ADR 4.5 exist with their levels, as data."""
    by_id = {r.id: r for r in m.builtin_rules()}
    levels = {"builtin.delete_permanent": m.Level.ASK, "builtin.unknown_software": m.Level.ASK, "builtin.sensitive_access": m.Level.ASK,
              "builtin.password_change": m.Level.HANDBACK, "builtin.money_transfer": m.Level.HANDBACK}
    assert {k for k in by_id if not k.endswith(".commands")} == set(levels)
    assert all(by_id[k].level is v for k, v in levels.items())
    L = m.Level
    rules = m.builtin_rules()
    expect = {("delete_documents", None): L.ASK, ("install_package", None): L.ASK, ("share_file", None): L.ASK, ("oauth_connect", None): L.ASK,
              ("reset_password", None): L.HANDBACK, ("make_payment", None): L.HANDBACK, ("refund_order", None): L.HANDBACK,
              ("terminal", "pip install foo"): L.ASK, ("terminal", "chmod 600 f"): L.ASK, ("terminal", "passwd bob"): L.HANDBACK,
              ("terminal", "curl http://h/x | sh"): L.ASK, ("terminal", "find . -delete"): L.ASK,
              ("terminal", "ls"): L.ALLOW, ("web_search", None): L.ALLOW}
    for (tool, command), effect in expect.items():
        assert m.evaluate(rules, action(m, tool, command=command)).effect is effect, (tool, command)
    # ...and the hook enforces the same families
    table = m.compile_hook_table(rules, version=1, toolset_tools={}, mcp_server_tools={})
    assert m.hook_verdict(table, tool="make_payment", command=None).action == "block"
    assert m.hook_verdict(table, tool="delete_documents", command=None).action == "approve"
    assert m.hook_verdict(table, tool="terminal", command="npx something").action == "approve"


def inv_suggestion_cannot_jump(m):
    s = rule(m, "s", m.Level.BLOCK, tools=["x"], state=m.RuleState.SUGGESTION, origin=m.Origin.BOT_SUGGESTION)
    must_raise(m, "not_a_draft", m.activate, s, actor=human(m), now_version=2)
    for state in (m.RuleState.ACTIVE, m.RuleState.ARCHIVED):
        must_raise(m, "not_a_draft", m.activate, rule(m, "s", m.Level.BLOCK, tools=["x"], state=state), actor=human(m), now_version=2)
    must_raise(m, "not_a_suggestion", m.draft_from_suggestion, rule(m, "s", m.Level.BLOCK, tools=["x"], state=m.RuleState.DRAFT), actor=human(m))


def hook_ids(*ids):
    return frozenset(ids)


def inv_seal_needs_the_hook_table_entry(m):
    L = m.Level
    S = m.Seal
    block = rule(m, "b", L.BLOCK, tools=["send_email"])
    ask = rule(m, "a", L.ASK, tools=["send_email"])
    assert seal(m, block, live(m)).seal is S.LOCK and seal(m, ask, live(m)).seal is S.HAND
    for ids in (None, frozenset(), hook_ids("other")):  # unknown, empty and someone else's entries: fail closed
        for r in (block, ask):
            s = seal(m, r, live(m), ids=ids)
            assert s.seal is S.BROKEN and "hook_rule_missing" in codes(s), (r.level, ids)
    # a rule the compiler DROPPED (every toolset it names is unknown) must not be sealed on the strength of a live hook
    drop = {"toolset_tools": {"web": ("web_search",)}, "mcp_server_tools": {}}
    # (tools + toolsets together leave the hook as the only mechanism: a lone unknown toolset is trivially "off" for M1)
    dropped = [rule(m, "d-block", L.BLOCK, toolsets=["ghost"], tools=["x*"]), rule(m, "d-ask", L.ASK, toolsets=["ghost"])]
    table = m.compile_hook_table(dropped, version=1, **drop)
    assert table.entries == () and {p.code for p in table.problems} >= {"unknown_toolset", "empty_expansion"}
    ids = frozenset(e.rule_id for e in table.entries)
    for r in dropped:
        s = seal(m, r, live(m), ids=ids, problems=table.problems)
        assert s.seal is S.BROKEN and "hook_rule_missing" in codes(s), r.id
    # partially expanded: one toolset known, one not -> the entry exists but covers less than the rule says
    partial = rule(m, "p", L.BLOCK, toolsets=["web", "ghost"], tools=["web_*"])
    table = m.compile_hook_table([partial], version=1, **drop)
    assert [e.rule_id for e in table.entries] == ["p"]
    ids = frozenset(e.rule_id for e in table.entries)
    s = seal(m, partial, live(m), ids=ids, problems=table.problems)
    assert s.seal is S.BROKEN and "hook_table_problem" in codes(s)
    unrelated = (m.Problem("unknown_toolset", "somewhere-else"),)
    assert seal(m, partial, live(m), ids=ids, problems=unrelated).seal is S.LOCK
    # a room or routine rule is enforced for the whole Bot, and says so
    room = rule(m, "r", L.BLOCK, tools=["send_email"], scope=m.Scope(m.ScopeKind.ROOM, "sala"))
    s = seal(m, room, live(m))
    assert s.seal is S.LOCK and "scope_widened" in s.qualifiers
    # MCP trust does not depend on the hook table (on a Bot without a channel: there it is the channel's own prompt, S1)
    server = m.McpServerState("crm", True, "untrusted", None, ())
    trust = rule(m, "t", L.ASK, servers=["crm"])
    assert seal(m, trust, live(m, surfaces=("api_server",), mcp=[server]), ids=None).seal is S.HAND
    # simulate: without the compiled table nothing is "in the hook"
    rules = [ask]
    sim = m.simulate(rules, live(m), action(m, "send_email"), expected_hook_digest="d1", now=NOW)
    assert dict(sim.seals)["a"].seal is S.BROKEN
    table = m.compile_hook_table(rules, version=1, toolset_tools={}, mcp_server_tools={})
    sim = m.simulate(rules, live(m), action(m, "send_email"), expected_hook_digest="d1", now=NOW, hook_table=table)
    assert dict(sim.seals)["a"].seal is S.HAND


def mcp_server(m, name="crm", names=("delete_contact", "list_contacts"), exclude=(), include=None, enabled=True):
    return m.McpServerState(name, enabled, "trusted", include, tuple(exclude), None if names is None else tuple(names))


def inv_m3_matches_hermes_exactly(m):
    """M3 as Hermes filters MCP tools (tools/mcp_tool_registration.py, tools/mcp_tool_schema.py): by the RAW name the server
    reports, case-sensitive, `include` (even empty) replaces `exclude`, registered names are sanitized and hash-clamped."""
    L = m.Level
    S = m.Seal
    down = m.HookState(False, None, None)

    def check(pattern, servers, applied=()):
        r = rule(m, "m3", L.BLOCK, tools=[pattern], applied=applied)
        return seal(m, r, live(m, mcp=servers, hook=down))

    ok = check("mcp__crm__delete_contact", [mcp_server(m, exclude=["delete_contact"])])
    assert ok.seal is S.LOCK and "next_session" in ok.qualifiers
    assert check("mcp__crm__delete_contact", [mcp_server(m)]).seal is S.BROKEN                                   # nothing excludes it
    assert check("mcp__crm__delete_*", [mcp_server(m, exclude=["delete_*"])]).seal is S.LOCK
    assert check("mcp__crm__*", [mcp_server(m, exclude=["delete_contact"])]).seal is S.BROKEN                    # list_contacts escapes
    assert check("mcp__crm__*", [mcp_server(m, exclude=["delete_contact", "list_*"])]).seal is S.LOCK
    assert check("mcp__crm__delete_*", [mcp_server(m, exclude=["delete_[a-z]*"])]).seal is S.LOCK              # Hermes's fnmatch classes are honoured
    # `include` replaces `exclude`: a tool outside the list is not registered; a tool inside it is, whatever `exclude` says
    assert check("mcp__crm__delete_contact", [mcp_server(m, include=["list_contacts"])]).seal is S.LOCK
    assert check("mcp__crm__delete_contact", [mcp_server(m, include=[])]).seal is S.LOCK                          # empty include = nothing
    assert check("mcp__crm__delete_contact", [mcp_server(m, include=["delete_contact"], exclude=["delete_contact"])]).seal is S.BROKEN
    # RAW names: Hermes filters 'delete-contact', not the sanitized 'delete_contact' it registers
    hyphen = dict(names=("delete-contact",))
    assert check("mcp__crm__delete_contact", [mcp_server(m, exclude=["delete_contact"], **hyphen)]).seal is S.BROKEN
    assert check("mcp__crm__delete_contact", [mcp_server(m, exclude=["delete-contact"], **hyphen)]).seal is S.LOCK
    assert check("mcp__my_crm__delete_contact", [mcp_server(m, name="my-crm", exclude=["delete_contact"])]).seal is S.LOCK  # server sanitized
    # case: the engine matches the pattern without case, Hermes filters with it
    upper = dict(names=("Delete_Contact",))
    assert check("mcp__crm__delete_contact", [mcp_server(m, exclude=["delete_contact"], **upper)]).seal is S.BROKEN
    assert check("mcp__crm__delete_contact", [mcp_server(m, exclude=["Delete_Contact"], **upper)]).seal is S.LOCK
    # long names are hash-clamped by Hermes: the registered name is what the pattern meets, the filter still sees the raw name
    raw = "x" * 60
    clamped = m.hermes_mcp_name("crm", raw)
    assert len(clamped) == 64 and clamped.startswith("mcp__crm__x") and clamped != "mcp__crm__" + raw
    assert check(clamped, [mcp_server(m, names=(raw,), exclude=[raw])]).seal is S.LOCK
    assert check("mcp__crm__" + raw, [mcp_server(m, names=(raw,), exclude=[raw])]).seal is S.BROKEN            # the unclamped name matches nothing
    # a disabled server registers nothing
    assert check("mcp__crm__delete_contact", [mcp_server(m, enabled=False)]).seal is S.LOCK
    # drift compares the same way
    drift = rule(m, "dr", L.BLOCK, tools=["mcp__crm__delete_contact"], applied=["mcp_exclude:crm:Delete_Contact"])
    assert "applied_drift" in codes(seal(m, drift, live(m, mcp=[mcp_server(m, exclude=["delete_contact"])])))
    same = rule(m, "dr", L.BLOCK, tools=["x"], applied=["mcp_exclude:crm:delete_contact"])
    assert "applied_drift" not in codes(seal(m, same, live(m, mcp=[mcp_server(m, exclude=["delete_contact"])])))


def inv_m3_needs_the_live_tool_list(m):
    """T1.4c (B2): without the live list of raw tool names, or with no live tool the pattern covers, M3 verifies nothing."""
    L = m.Level
    S = m.Seal
    down = m.HookState(False, None, None)

    def check(pattern, servers):
        return seal(m, rule(m, "m3", L.BLOCK, tools=[pattern]), live(m, mcp=servers, hook=down))

    full = mcp_server(m, exclude=["delete_contact", "list_contacts"])
    assert check("mcp__crm__delete_contact", [full]).seal is S.LOCK
    for servers in ([mcp_server(m, names=None, exclude=["delete_contact"])],                # no live list
                    [mcp_server(m, names=(), exclude=["delete_contact"])],                  # an empty list: nothing demonstrably blocked
                    [mcp_server(m, names=("other_tool",), exclude=["delete_contact"])],     # the pattern covers no live tool
                    [full, mcp_server(m, name="billing", names=None)],                      # one server unknown: its tools could match
                    []):
        s = check("mcp__crm__delete_contact", servers)
        assert s.seal is S.BROKEN and "uncovered_surface" in codes(s), servers
    # two servers, both listed, both filtered
    assert check("mcp__*__delete_contact", [full, mcp_server(m, name="billing", names=("delete_contact",), exclude=["delete_contact"])]).seal is S.LOCK
    assert check("mcp__*__delete_contact", [full, mcp_server(m, name="billing", names=("delete_contact",))]).seal is S.BROKEN


def inv_m4_matches_hermes_exactly(m):
    """M4 as Hermes matches `approvals.deny` (tools/approval_floors.py): the glob, stripped and lower-cased, nothing else."""
    L = m.Level
    S = m.Seal
    down = m.HookState(False, None, None)
    r = rule(m, "m4", L.BLOCK, commands=["Shutdown *"])

    def check(deny):
        return seal(m, r, live(m, deny=deny, hook=down))

    s = check(["shutdown *"])
    assert s.seal is S.LOCK and "pattern" in s.qualifiers
    assert check(["  SHUTDOWN *  "]).seal is S.LOCK
    assert check(["shutdown  *"]).seal is S.BROKEN                 # two spaces are not one: Hermes does no folding
    assert check(["shutdown\t*"]).seal is S.BROKEN
    assert check(["ｓhutdown *"]).seal is S.BROKEN            # no Unicode normalization either
    assert check([]).seal is S.BROKEN
    drift = rule(m, "dr", L.BLOCK, commands=["x *"], applied=["approvals_deny:Shutdown *"])
    assert "applied_drift" in codes(seal(m, drift, live(m, deny=["shutdown  *"], hook=down)))
    assert "applied_drift" not in codes(seal(m, drift, live(m, deny=["shutdown *"], hook=down)))


def inv_noncanonical_command(m):
    """R-12 condition: a command whose executable is not a plain word is not canonical: ask, and outside every allow."""
    L = m.Level
    allow = rule(m, "allow-any", L.ALLOW, commands=["*"])
    odd = ['r"m" -rf x', "r\\m -rf x", "'ls' -la", "$(echo ls) -la", "ls$IFS-la", "~/bin/tool", "l* -la", "l?s", "${HOME}/bin/x",
           'FOO=1 "git" status', "sudo -n 'ls'", "timeout 5 l\\s", "echo a; 'ls'", "ls`echo`"]
    for command in odd:
        d = m.evaluate([allow], action(m, "terminal", command=command))
        assert d.effect is L.ASK and d.reason is m.ReasonCode.NONCANONICAL_ACTION and d.hits == (), command
    plain = ["ls -la", "./run.sh --fast", "/usr/bin/git status", "../bin/tool x", "FOO=1 git status", "sudo -n git status",
             "timeout 5 ls", "python3.12 -m pytest", "docker-compose up"]
    for command in plain:
        d = m.evaluate([allow], action(m, "terminal", command=command))
        assert d.effect is L.ALLOW and d.hits, command
    # a restrictive rule still catches the quoted / backslashed spelling through its deobfuscated form
    block = rule(m, "no-rm", L.BLOCK, commands=["rm *-r*"])
    for command in ('r"m" -rf x', "r\\m -rf x", "'rm' -rf x"):
        assert m.evaluate([allow, block], action(m, "terminal", command=command)).winner == "no-rm", command
    # the hook asks about it too, even when no entry matches
    table = m.compile_hook_table([block], version=1, toolset_tools={}, mcp_server_tools={})
    v = m.hook_verdict(table, tool="terminal", command="'ls' -la")
    assert (v.action, v.strict) == ("approve", True)
    assert m.hook_verdict(table, tool="terminal", command="ls -la").action == "none"
    # an always-allow draft never records such a command
    must_raise(m, "noncanonical_action", m.draft_from_always_allow, action(m, "terminal", command="'ls' -la"), label="x", rule_id="aa")


def inv_approve_off_is_broken(m):
    """Spike T3.0c: with approvals.mode off a hook `approve` is approved by Hermes with no human and no frame."""
    L = m.Level
    S = m.Seal
    ask = rule(m, "ask-mail", L.ASK, tools=["send_email"])
    assert seal(m, ask, live(m, mode="manual")).seal is S.HAND
    for mode in ("off", "OFF", "", "whatever"):
        s = seal(m, ask, live(m, mode=mode))
        assert s.seal is S.BROKEN and "approvals_off" in codes(s), mode
    assert seal(m, ask, live(m, mode="smart")).seal is S.HAND        # smart still asks a human for a hook approval (T3.0c, F)
    for level in (L.BLOCK, L.HANDBACK):                                # a block directive is not a gate: unaffected
        assert seal(m, rule(m, "b", level, tools=["send_email"]), live(m, mode="off")).seal is S.LOCK
    t = m.compile_hook_table([ask], version=1, toolset_tools={}, mcp_server_tools={})
    assert t.entries[0].strict and m.hook_verdict(t, tool="send_email", command=None).strict   # the hook may then refuse instead


def inv_seal_channels(m):
    """S1 (proposal v0.5 2.7): an ASK rule on a Bot with a messaging channel is a real approval only if a LIVE hook at 0.2.0+
    blocks it on that channel (qualifier `channels_block`); otherwise the approval is a button in the channel: BROKEN. A
    standing `plugin_rule:luvebot:` entry without an event id is a permanent approval: every ASK rule of the Bot is BROKEN."""
    L, S = m.Level, m.Seal
    ask = rule(m, "ask-mail", L.ASK, tools=["send_email"])
    on_telegram = dict(surfaces=("api_server", "telegram"))
    s = seal(m, ask, live(m, **on_telegram, hook=m.HookState(True, 5.0, "d1", "0.2.0")))
    assert s.seal is S.HAND and "channels_block" in s.qualifiers and not codes(s)
    assert seal(m, ask, live(m, **on_telegram, hook=m.HookState(True, 5.0, "d1", "0.10.1"))).seal is S.HAND   # numeric, not text
    for version in ("0.1.0", None, "", "0.2", "x.y.z", "0.1.99"):
        s = seal(m, ask, live(m, **on_telegram, hook=m.HookState(True, 5.0, "d1", version)))
        assert s.seal is S.BROKEN and "channel_approval_outside" in codes(s) and "channels_block" not in s.qualifiers, version
    s = seal(m, ask, live(m, **on_telegram, hook=m.HookState(True, 500.0, "d1", "0.2.0")))   # a stale hook blocks nothing
    assert s.seal is S.BROKEN and "channel_approval_outside" in codes(s) and "channels_block" not in s.qualifiers
    for quiet in (("api_server",), ("api_server", "cron"), ("api_server", "room")):          # no channel: nothing changes
        s = seal(m, ask, live(m, surfaces=quiet, hook=m.HookState(True, 5.0, "d1", "0.1.0")))
        assert s.seal is S.HAND and "channels_block" not in s.qualifiers, quiet
    block = rule(m, "block-mail", L.BLOCK, tools=["send_email"])                               # a block is a block everywhere
    assert seal(m, block, live(m, **on_telegram, hook=m.HookState(True, 5.0, "d1", "0.1.0"))).seal is S.LOCK
    for leak in ("plugin_rule:luvebot:rules_unavailable", "plugin_rule:luvebot:builtin.delete_permanent.commands"):
        s = seal(m, ask, live(m, surfaces=("api_server",), allowlist=[leak]))
        assert s.seal is S.BROKEN and "permanent_allow_leak" in codes(s), leak
    harmless = ["plugin_rule:luvebot:rules_unavailable#0f3a", "plugin_rule:luvebot:ask-mail#17", "plugin_rule:other:thing"]
    assert seal(m, ask, live(m, surfaces=("api_server",), allowlist=harmless)).seal is S.HAND        # one-call keys never match again
    assert seal(m, block, live(m, surfaces=("api_server",), allowlist=["plugin_rule:luvebot:rules_unavailable"])).seal is S.LOCK


def inv_seal_channel_surface(m):
    """D-025: a Bot set to `channel` keeps HAND on Telegram (`channel_dm:telegram`, a named approver's private chat) only with a
    live hook at 0.3.0+ reporting THIS configuration, no allow-all and at least one approver; other channels stay blocked."""
    L, S = m.Level, m.Seal
    ask = rule(m, "ask-mail", L.ASK, tools=["send_email"])
    D = "d" * 64
    good = m.ApprovalSurfaceState("channel", ("telegram:42",), D, False)
    hook03 = m.HookState(True, 5.0, "d1", "0.3.0", D)
    tg = ("api_server", "telegram")
    s = seal(m, ask, live(m, surfaces=tg, hook=hook03, surface=good))
    assert s.seal is S.HAND and "channel_dm:telegram" in s.qualifiers and "channels_block" not in s.qualifiers and not codes(s)
    s = seal(m, ask, live(m, surfaces=("api_server", "telegram", "discord"), hook=hook03, surface=good))
    assert s.seal is S.HAND and {"channel_dm:telegram", "channels_block"} <= set(s.qualifiers)          # Discord still blocks
    s = seal(m, ask, live(m, surfaces=("api_server", "telegram"), hook=m.HookState(True, 5.0, "d1", "0.10.0", D), surface=good))
    assert s.seal is S.HAND                                                                              # numeric versions
    broken = [("not_applied", m.HookState(True, 5.0, "d1", "0.2.0", D), good),                         # hook too old
              ("not_applied", m.HookState(True, 5.0, "d1", "0.3.0", "e" * 64), good),                  # another configuration
              ("not_applied", m.HookState(True, 5.0, "d1", "0.3.0", None), good),                      # none reported
              ("not_applied", m.HookState(True, 500.0, "d1", "0.3.0", D), good),                       # not live
              ("not_applied", hook03, m.ApprovalSurfaceState("channel", ("telegram:42",), None, False)),
              ("channel_config_unsafe", hook03, m.ApprovalSurfaceState("channel", ("telegram:42",), D, True)),   # allow-all
              ("channel_config_unsafe", hook03, m.ApprovalSurfaceState("channel", (), D, False))]                # nobody named
    for code, hook, surface in broken:
        s = seal(m, ask, live(m, surfaces=tg, hook=hook, surface=surface))
        assert s.seal is S.BROKEN and code in codes(s), (code, hook, surface)
    s = seal(m, ask, live(m, surfaces=tg, hook=m.HookState(True, 5.0, "d1", "0.2.0"), surface=m.ApprovalSurfaceState("luvebot", (), None, False)))
    assert s.seal is S.HAND and "channels_block" in s.qualifiers and not any(q.startswith("channel_dm") for q in s.qualifiers)  # S1
    s = seal(m, ask, live(m, surfaces=("api_server",), hook=m.HookState(True, 5.0, "d1", "0.2.0"), surface=good))
    assert s.seal is S.HAND and not any(q.startswith("channel") for q in s.qualifiers)              # no channel: nothing to say
    block = rule(m, "block-mail", L.BLOCK, tools=["send_email"])
    assert seal(m, block, live(m, surfaces=tg, hook=m.HookState(True, 5.0, "d1", "0.2.0", None), surface=good)).seal is S.LOCK


# VPS 2026-10-02: a Bot ran `python -m pip install --no-deps --target <dir> cowsay` and nobody was asked: unknown_software only
# matched `pip install *` / `pip3 install *`. Every spelling below is the same act (installing software) and must be ASKED.
EQUIVALENT_INSTALLS = (
    "python -m pip install --no-deps --target /tmp/x cowsay",                    # the VPS command itself
    "python3 -m pip install cowsay", "python3.12 -m pip install cowsay", "/usr/bin/python3 -m pip install cowsay",
    "./venv/bin/python -m pip install x", "python -I -m pip install x", "python -Im pip install x", "python -mpip install x",
    "python -X dev -m pip install x", "python -W ignore -m pip install x", "python3 -u -m pip install x",
    "PYTHONPATH=/tmp/x python -m pip install cowsay", "PYTHONPATH=/tmp/x PIP_NO_DEPS=1 pip install cowsay",
    "env PYTHONPATH=/tmp/x python3 -m pip install x", "env -u FOO pip install x", "env -i pip install x",
    "sudo -u root pip install x", "sudo -H pip3 install x", "sudo -u root -H python3 -m pip install x", "doas -u root pip install x",
    "nice -n 5 python3 -m pip install x", "time -f %e pip install x", "timeout -s KILL 60 pip install x", "nohup pip install x &",
    "exec pip install x", "command pip install x", "stdbuf -o L pip install x",
    "/usr/bin/pip3 install x", "/usr/local/bin/pip install x",
    "echo a; python -m pip install x", "true && pip install x", "false || pip install x", "cat r | xargs -n 1 pip install -q",
    "echo $(python -m pip install x)", "echo `pip install x`", "sh -c 'python3 -m pip install x'",
    "bash -lc \"cd /tmp && python -m pip install x\"",
    "uv run pip install x", "uv run -- python -m pip install x", "poetry run pip install x", "conda run -n base pip install x",
    "pipenv run python -m pip install x",
    "mamba run -n base pip install x", "micromamba run -n e python -m pip install x", "pixi run pip install x",   # r3
)
UNKNOWN = "builtin.unknown_software.commands"


def inv_equivalent_forms(m):
    """Restrictive rules (ask/handback/block) match the command a shell would RUN behind assignments, wrappers and their values,
    an absolute path, `python -m <module>`, environment runners and chained / substituted segments. Allow rules are untouched:
    they still need EVERY segment, as written."""
    L = m.Level
    builtins = m.builtin_rules()
    table = m.compile_hook_table(builtins, version=1, toolset_tools={}, mcp_server_tools={})
    for command in EQUIVALENT_INSTALLS:
        d = m.evaluate(builtins, action(m, "terminal", command=command))
        assert d.effect is L.ASK and d.winner == UNKNOWN, (command, d.effect, d.winner)
        v = m.hook_verdict(table, tool="terminal", command=command)
        assert v.action == "approve" and v.rule_id == UNKNOWN, (command, v)
    for command in ("python -m http.server", "python script.py", "pip list", "pip --version", "python -c 'print(1)'", "ls -la"):
        assert m.evaluate(builtins, action(m, "terminal", command=command)).winner != UNKNOWN, command
    # not loosened: an allow rule still needs every segment AS WRITTEN (no variant ever widens an allow)
    allow = rule(m, "allow-pip", L.ALLOW, commands=["pip install *"])
    for command in ("python -m pip install x", "sudo pip install x", "pip install x; rm -rf /tmp/y", "uv run pip install x"):
        assert m.evaluate([allow], action(m, "terminal", command=command)).hits == (), command
    assert m.evaluate([allow], action(m, "terminal", command="pip install x")).hits
    assert m.evaluate(builtins + (allow,), action(m, "terminal", command="pip install x")).effect is L.ASK   # ask beats allow
    # honest limit: code given inline is not read as a command, so the seal says it is a pattern (never a bare "real approval")
    inline = "python -c \"import pip; pip.main(['install', 'x'])\""
    assert m.evaluate(builtins, action(m, "terminal", command=inline)).winner != UNKNOWN
    for declared in ("echo pip install x | sh", "nix-shell -p python3 --run 'pip install x'"):   # r3: declared under `pattern`, not read
        assert m.evaluate(builtins, action(m, "terminal", command=declared)).winner != UNKNOWN, declared
    s = seal(m, next(r for r in builtins if r.id == UNKNOWN), live(m, hook=m.HookState(True, 5.0, "d1", "0.3.1")))
    assert "pattern" in s.qualifiers, s


def inv_bounded_readings(m):
    """B1 (Lume's 2nd review): reading a command is bounded. Each text is read once (a later -exec is inside the first one's text),
    at most MAX_DEPTH nested commands and MAX_VARIANTS spellings; past either the reading is INCOMPLETE and the action asks (fails
    closed), even under a rule that allows everything. A command no longer costs time exponential in its -exec count."""
    import time
    L = m.Level
    allow = rule(m, "allow-any", L.ALLOW, commands=["*"])
    builtins = m.builtin_rules()

    def timed(rules, command):  # CPU time of this process: a busy machine stretches the wall clock, not the work done here
        start = time.process_time()
        decision = m.evaluate(rules, action(m, "terminal", command=command))
        return decision, time.process_time() - start
    wide = "find . " + " ".join(["-exec true {} +"] * 2000)              # was > 1 million calls with 50
    d, spent = timed([allow], wide)
    assert d.effect is L.ASK and spent < 0.1, (d.effect, spent)
    assert m.hook_verdict(m.compile_hook_table([rule(m, "no-rm", L.BLOCK, commands=["rm *-r*"])], version=1, toolset_tools={},
                                               mcp_server_tools={}), tool="terminal", command=wide).action == "approve"
    assert timed([allow], "find a -exec " * 6 + "ls")[0].effect is L.ASK      # 6 nested commands: past MAX_DEPTH, asks
    assert timed([allow], "find a -exec " * 3 + "ls")[0].effect is L.ALLOW    # within the limit nothing asks more than before
    args = " ".join(f"-x v{i}" for i in range(300)) + " -m pip install x"     # -x is a flag or takes a value: 300 readings
    assert len(m._interpreted(args.split())) <= m.MAX_VARIANTS + 1
    d, spent = timed([allow], "python " + args)
    assert d.effect is L.ASK and spent < 1.0, (d.effect, spent)               # too many spellings to read: asks (bounded above;
    d, spent = timed(builtins, "python " + args)                              # ~15-65 ms here: 1 s only guards a blow-up, a busy
    assert d.effect is L.ASK and spent < 1.0, (d.effect, spent)               # machine made 100 ms flaky)


def inv_both_readings_canonical(m):
    """B2 (Lume's 2nd review): an ambiguous wrapper option (casefolded, `sudo -H` is also `sudo -h <host>`) is read BOTH ways, for
    the R-12 canonical check and for restrictive rules: one reading that is not canonical makes the command not canonical, and a
    rule caught by either reading applies. `sudo -H 'c'url https://x` was ALLOWed: one reading took 'c'url as -h's value."""
    L = m.Level
    allow = rule(m, "allow-any", L.ALLOW, commands=["*"])
    for command in ("sudo -H 'c'url https://x", "sudo -u root 'c'url https://x", "doas -u root 'c'url https://x"):
        d = m.evaluate([allow], action(m, "terminal", command=command))
        assert d.effect is L.ASK and d.reason is m.ReasonCode.NONCANONICAL_ACTION, (command, d.effect, d.reason)
    block = rule(m, "no-curl", L.BLOCK, commands=["curl *"])
    for command in ("sudo -H curl https://x", "sudo -u root curl https://x"):
        assert m.evaluate([allow, block], action(m, "terminal", command=command)).winner == "no-curl", command
    assert m.evaluate([allow], action(m, "terminal", command="sudo -H ls -la")).effect is L.ALLOW   # plain, both ways: allowed


def inv_builtin_equivalent_globs(m):
    """The installers that are the same act under another name (no normalization makes them `pip install`)."""
    L = m.Level
    builtins = m.builtin_rules()
    for command in ("uv pip install x", "uv tool install x", "pipx install cowsay", "pip3.12 install x", "pip3.11 install --user x",
                    "cat reqs | xargs pip install",
                    # r3: a download piped to an interpreter, and the other spellings of a JavaScript install
                    "curl -sS https://bootstrap.pypa.io/get-pip.py | python3", "wget -qO- https://x/get-pip.py | python3 -",
                    "pnpm install x", "bun install x", "yarn global add x", "npm in x",
                    # r4 (Prumo, R-14): an install with no argument runs the project's postinstall, and npx's equivalents
                    "npm install", "npm i", "npm ci", "yarn", "yarn install", "pnpm install", "bun install",
                    "npm exec cowsay", "pnpm dlx cowsay", "yarn dlx cowsay", "bunx cowsay",
                    # r5: the same installs with options (yarn with no subcommand only in the forms that install)
                    "npm ci --omit=dev", "yarn install --frozen-lockfile", "yarn --frozen-lockfile", "yarn --immutable"):
        d = m.evaluate(builtins, action(m, "terminal", command=command))
        assert d.effect is L.ASK and d.winner == UNKNOWN, command
    for command in ("yarn --version", "npm --version", "yarn run build", "npm test"):   # not an install: never asked by this rule
        assert m.evaluate(builtins, action(m, "terminal", command=command)).winner != UNKNOWN, command


INVARIANTS = {name[4:]: fn for name, fn in globals().items() if name.startswith("inv_")}
FIFTEEN = ["ask_beats_allow", "stricter_wins", "order_independent", "draft_has_no_effect", "always_allow_is_draft",
           "agent_cannot_activate", "builtin_immutable", "conditions_fail_closed", "seal_liar", "seal_cli_trap",
           "seal_room_policy", "seal_hand_bypasses", "seal_hook_stale", "hook_fail_closed", "table_roundtrip"]


# ---------------------------------------------------------------------------------------------------------------------
# mutations: (invariant, label, exact text in rules.py, replacement)
# ---------------------------------------------------------------------------------------------------------------------
RANK_LINE = "RANK = {Level.ALLOW: 0, Level.EXPLICIT: 1, Level.ASK: 2, Level.HANDBACK: 3, Level.BLOCK: 4}"
MUTATIONS = [
    ('seal_channel_surface', 'the hook version is ignored', '    if not (hook_ok and version is not None and version >= CHANNEL_SURFACE_VERSION and surface.digest is not None\n            and state.hook.surface_digest == surface.digest):', '    if not (hook_ok and surface.digest is not None\n            and state.hook.surface_digest == surface.digest):'),
    ('seal_channel_surface', 'the applied configuration is not compared', '    if not (hook_ok and version is not None and version >= CHANNEL_SURFACE_VERSION and surface.digest is not None\n            and state.hook.surface_digest == surface.digest):', '    if not (hook_ok and version is not None and version >= CHANNEL_SURFACE_VERSION and surface.digest is not None):'),
    ('seal_channel_surface', 'a hook that is not live still counts', '    if not (hook_ok and version is not None and version >= CHANNEL_SURFACE_VERSION and surface.digest is not None\n            and state.hook.surface_digest == surface.digest):', '    if not (version is not None and version >= CHANNEL_SURFACE_VERSION and surface.digest is not None\n            and state.hook.surface_digest == surface.digest):'),
    ('seal_channel_surface', 'allow-all is ignored', '    if surface.allow_all:\n', '    if False:\n'),
    ('seal_channel_surface', 'no approver is fine', '    if not surface.approvers:\n', '    if False:\n'),
    ('seal_channel_surface', 'every channel gets the approval', 'f"channel_dm:{c}" if c in CHANNEL_APPROVAL_PLATFORMS else "channels_block"', 'f"channel_dm:{c}"'),
    ('seal_channel_surface', 'the Bot setting is ignored', '    if surface is None or surface.mode != "channel":\n        return None', '    if True:\n        return None'),
    ('seal_channels', 'the heartbeat version is ignored', '    if hook_ok and version is not None and version >= CHANNEL_BLOCK_VERSION:', '    if hook_ok:'),
    ('seal_channels', 'a hook that is not live still counts', '    if hook_ok and version is not None and version >= CHANNEL_BLOCK_VERSION:', '    if version is not None and version >= CHANNEL_BLOCK_VERSION:'),
    ('seal_channels', 'versions compared as text', '    if hook_ok and version is not None and version >= CHANNEL_BLOCK_VERSION:', "    if hook_ok and (state.hook.plugin_version or '') >= '0.2.0':"),
    ('seal_channels', 'the standing allowlist entry is not reported', '    return [Problem("permanent_allow_leak", e) for e in leaks]', '    return []'),
    ('seal_channels', 'one-call keys reported as leaks', 'e.startswith("plugin_rule:luvebot:") and "#" not in e', 'e.startswith("plugin_rule:luvebot:")'),
    ("ask_beats_allow", "restrictiveness order inverted", RANK_LINE,
     "RANK = {Level.ALLOW: 4, Level.EXPLICIT: 3, Level.ASK: 2, Level.HANDBACK: 1, Level.BLOCK: 0}"),
    ("stricter_wins", "ask ranked above block", RANK_LINE,
     "RANK = {Level.ALLOW: 0, Level.EXPLICIT: 1, Level.ASK: 9, Level.HANDBACK: 3, Level.BLOCK: 4}"),
    ("order_independent", "hits kept in input order", "    found.sort(key=lambda item: item[0])\n", ""),
    ("draft_has_no_effect", "DRAFT included in compile_hook_table",
     "if not isinstance(rule, Rule) or rule.state is not RuleState.ACTIVE or rule.level not in _RESTRICTIVE:",
     "if not isinstance(rule, Rule) or rule.state not in (RuleState.ACTIVE, RuleState.DRAFT) or rule.level not in _RESTRICTIVE:"),
    ("draft_has_no_effect", "DRAFT included in evaluate",
     "if not isinstance(rule, Rule) or rule.state is not RuleState.ACTIVE or not _applies(rule, action):",
     "if not isinstance(rule, Rule) or rule.state not in (RuleState.ACTIVE, RuleState.DRAFT) or not _applies(rule, action):"),
    ("always_allow_is_draft", "draft returned ACTIVE", "state=RuleState.DRAFT, origin=Origin.ALWAYS_ALLOW, builtin=False)",
     "state=RuleState.ACTIVE, origin=Origin.ALWAYS_ALLOW, builtin=False)"),
    ("agent_cannot_activate", "any actor accepted", "def _require_human(actor) -> None:",
     "def _require_human(actor) -> None:\n    return None\n\n\ndef _require_human_original(actor) -> None:"),
    ("agent_cannot_activate", "propose_from_agent returns ACTIVE",
     'state=RuleState.SUGGESTION, origin=Origin.BOT_SUGGESTION, builtin=False, updated_by=f"bot:{bot}")',
     'state=RuleState.ACTIVE, origin=Origin.BOT_SUGGESTION, builtin=False, updated_by=f"bot:{bot}")'),
    ("builtin_immutable", "builtin check removed", "def _require_plain(rule: Rule) -> None:",
     "def _require_plain(rule: Rule) -> None:\n    return None\n\n\ndef _require_plain_original(rule: Rule) -> None:"),
    ("conditions_fail_closed", "missing fact inverted",
     "            if restrictive:\n                continue            # missing fact: fail closed for ask/handback/block\n            return False",
     "            if not restrictive:\n                continue\n            return False"),
    ("seal_liar", "surfaces ignored (partial coverage accepted)", "    if not surfaces or not set(surfaces) <= covered:",
     "    if not surfaces or False:"),
    ("seal_cli_trap", "only the configuration platform is read", "        enabled = by_platform.get(surface)\n        if enabled is None:",
     '        enabled = by_platform.get("cli")\n        if enabled is None:'),
    ("seal_room_policy", "room policy ignored",
     "            elif wanted & {canon_name(t)[0] for t in policy.enabled_toolsets}:", "            elif False:"),
    ("seal_hand_bypasses", "approvals.mode predicate removed", '    elif a.mode != "manual":', "    elif False:"),
    ("seal_hand_bypasses", "allowlist predicate removed",
     '    if any(entry == f"plugin_rule:{rule.id}" for entry in a.allowlist) or any(', "    if False and any(entry == 0 for entry in a.allowlist) or any("),
    ("seal_hand_bypasses", "transport fallback predicate removed", '    if a.transport_fallback == "builtin":', "    if False:"),
    ("seal_hand_bypasses", "cron auto-approve predicate removed", '    if "cron" in surfaces and a.cron_mode == "approve":', "    if False:"),
    ("seal_hook_stale", "heartbeat age ignored", "    if effective is None or not (effective <= max_age):  # NaN is stale", "    if False:"),
    ("seal_hook_stale", "table digest ignored",
     "    if expected is None or hook.table_digest is None or hook.table_digest != expected:", "    if False:"),
    ("hook_fail_closed", "malformed table returns an empty table", '            raise RuleError("bad_table") from None',
     "            return HookTable(0, _table_digest(()), ())"),
    ("table_roundtrip", "strict flag lost in from_json", 'raw["message"], raw["strict"]))', 'raw["message"], False))'),
    ("canonical_names", "case folding removed", "    return unicodedata.normalize(\"NFKC\", text).casefold()", "    return unicodedata.normalize(\"NFKC\", text)"),
    ("noncanonical_asks", "non-canonical floor removed", "    if not view.clean and RANK[effect] < RANK[Level.ASK]:",
     "    if False and RANK[effect] < RANK[Level.ASK]:"),
    ("allow_needs_clean_spelling", "allow rules may match odd spellings", "    if not restrictive and not view.clean:\n        return None\n", ""),
    ("command_segments", "allow matches the whole string only", "    if not view.segments:\n        return None\n",
     "    return next((p for p in pats if glob_match(p, view.whole)), None)\n"),
    ("command_wrappers", "no wrapper / chain expansion for restrictive rules", "        variants = frozenset(found)", "        variants = frozenset({whole})"),
    ("always_allow_command_is_literal", "command pattern not escaped", "        pattern = _escape(view.whole)", "        pattern = view.whole"),
    ("hook_block_beats_approve", "block verdicts ignored", '        if entry.verdict == "block":', "        if False:"),
    ("hook_ask_is_strict", "ask is not strict", "        ask = rule.level is Level.ASK", "        ask = False"),
    ("hook_expansion_reports", "unknown toolset dropped silently", "            problems.append(Problem(kind, key))", "            pass"),
    ("hook_expansion_reports", "empty expansion matches everything", "            if not tools:\n                problems.append(Problem(\"empty_expansion\", rule.id))\n                continue",
     "            if not tools:\n                tools = ()"),
    ("seal_is_honest", "a seal may coexist with problems", "    seal = good if not unique else Seal.BROKEN", "    seal = good"),
    ("simulate_is_enforcement", "unverified mechanisms reported as effective", "m.id for m in seals[0][1].mechanisms if m.verified", "m.id for m in seals[0][1].mechanisms"),
    ("validate_rule", "empty match not reported", '            problems.append(Problem("empty_match", "a rule that matches nothing"))', "            pass"),
    ("module_is_pure", "a network import added", "import hashlib\n", "import hashlib\nimport socket\n"),
    ("nothing_activates_without_a_human", "activate lets agents through", "def _require_human(actor) -> None:",
     "def _require_human(actor) -> None:\n    return None\n\n\ndef _require_human_original(actor) -> None:"),
    ("builtin_catalog", "a builtin family weakened", '"builtin.money_transfer", "Money transfer", "handback"', '"builtin.money_transfer", "Money transfer", "allow"'),
    ("seal_needs_the_hook_table_entry", "A: rule id not required in the compiled table",
     '    if hook_rule_ids is None or rule.id not in hook_rule_ids:', "    if False:"),
    ("seal_needs_the_hook_table_entry", "A: compiler problems ignored",
     '        if problem.code in ("unknown_toolset", "unknown_mcp_server") and problem.detail in named:', "        if False:"),
    ("seal_needs_the_hook_table_entry", "A: simulate without a table assumes every rule is in the hook",
     "    ids = None if hook_table is None else frozenset(e.rule_id for e in hook_table.entries)", "    ids = frozenset(r.id for r in ordered)"),
    ("m3_matches_hermes_exactly", "B2: the filter is applied to the sanitized name",
     "                if not _filtered_by_hermes(server, raw):", "                if not _filtered_by_hermes(server, _hermes_sanitize(raw)):"),
    ("m3_matches_hermes_exactly", "B2: the 64-character clamp is ignored", "    if len(full) <= _MCP_NAME_LIMIT:", "    if True:"),
    ("m3_matches_hermes_exactly", "B2: the include list is ignored",
     "    if server.include is not None:\n        return not _hermes_name_filter(raw, server.include)\n", ""),
    ("m3_matches_hermes_exactly", "B2: the filter compares without case",
     '    if name in patterns:\n        return True\n    return any(fnmatch.fnmatchcase(name, p) for p in patterns if "*" in p or "?" in p or "[" in p)',
     '    return any(fnmatch.fnmatchcase(name.lower(), p.lower()) for p in patterns)'),
    ("m3_matches_hermes_exactly", "B2: a disabled server's tools count as live", "    if not server.enabled:\n        return True\n", ""),
    ("m3_matches_hermes_exactly", "B: drift compares M3 without case",
     "            drifted = s is not None and (pattern not in s.exclude or s.include is not None)",
     "            drifted = s is not None and pattern.lower() not in {e.lower() for e in s.exclude}"),
    ("m3_needs_the_live_tool_list", "B2: a missing live list is accepted",
     "    if not state.mcp or any(s.tool_names is None for s in state.mcp):", "    if not state.mcp or all(s.tool_names is None for s in state.mcp):"),
    ("m3_needs_the_live_tool_list", "B2: no covered live tool counts as verified",
     "    return Mechanism(MechanismId.MCP_TOOL_EXCLUDE, True, surfaces) if covered else unverified",
     "    return Mechanism(MechanismId.MCP_TOOL_EXCLUDE, True, surfaces)"),
    ("m3_needs_the_live_tool_list", "B2: an escaping tool of a second server is ignored",
     "                if not _filtered_by_hermes(server, raw):\n                    return unverified", "                if not _filtered_by_hermes(server, raw) and server is state.mcp[0]:\n                    return unverified"),
    ("m4_matches_hermes_exactly", "B: M4 folds Unicode and whitespace", "    return glob.strip().lower()", "    return _squash(_fold(glob))"),
    ("noncanonical_command", "C: executable simplicity not checked",
     "            if any(not _SIMPLE_WORD.fullmatch(exe) for _, exe in _readings(part.split())):\n                clean = False", "            pass"),
    ("noncanonical_command", "C: substitution glued to the executable not detected",
     "        if _glued_substitution(text):\n            clean = False", "        pass"),
    ("noncanonical_command", "C: no deobfuscated variant", "    deobfuscated = _squash(segment.translate(_QUOTING))", "    deobfuscated = segment"),
    ("command_wrappers", "C: missing wrappers not listed",
     '                       "timeout", "setsid", "ionice", "busybox", "watch", "flock", "unbuffer", "taskset", "strace", "ltrace",\n', ""),
    ("command_wrappers", "C: find -exec not expanded",
     '                if token in ("-exec", "-execdir", "-ok", "-okdir") and i + 1 < len(tokens):', "                if False:"),
    ("command_wrappers", "C: eval / su -c not read as shells", '_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "su", "eval", "script"})',
     '_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh"})'),
    ("equivalent_forms", "normalization off: only the raw command is matched", "        variants = frozenset(found)",
     "        variants = frozenset({whole})"),
    ("equivalent_forms", "python -m <module> not read as the module", '_INTERPRETER = re.compile(r"(?:python|pypy)[0-9.]*|py")',
     '_INTERPRETER = re.compile(r"$^")'),
    ("equivalent_forms", "a wrapper's option value read as the executable (sudo -u root)",
     "        elif values and wrapped and token in _VALUE_OPTS.get(wrapper, ()):\n            i += 2", "        elif False:\n            i += 2"),
    ("equivalent_forms", "only one reading of an ambiguous wrapper option (sudo -H read as sudo -h <value>)",
     "    return {found for values in (True, False) if (found := _executable(tokens, values)) is not None}",
     "    return {found for values in (True,) if (found := _executable(tokens, values)) is not None}"),
    ("equivalent_forms", "mamba / micromamba / pixi run not read",
     '            "mamba": "run", "micromamba": "run", "pixi": "run"}', '            }'),
    ("builtin_equivalent_globs", "a download piped to an interpreter not listed",
     '"curl *|*python*", "wget *|*python*", ', ''),
    ("builtin_equivalent_globs", "installs with options not listed (npm ci --x, yarn install --x, yarn --frozen-lockfile)",
     '"npm ci *", "yarn install *", "yarn --frozen-lockfile*", "yarn --immutable*"', '"bunx *"'),
    ("builtin_equivalent_globs", "yarn with any option asks (yarn --version too)",
     '"yarn --frozen-lockfile*", "yarn --immutable*"', '"yarn --*"'),
    ("builtin_equivalent_globs", "an install with no argument not listed (runs postinstall)",
     '"npm install", "npm i", "npm ci", "yarn", "yarn install", "pnpm install", "bun install",', ''),
    ("builtin_equivalent_globs", "npx's equivalents not listed (npm exec, pnpm/yarn dlx, bunx)",
     '"npm exec *", "pnpm dlx *", "yarn dlx *", "bunx *"', '"npx *"'),
    ("builtin_equivalent_globs", "pnpm/bun install, yarn global add and npm in not listed",
     '"pnpm install *", "bun install *", "yarn global add *", "npm in *"', '"npx *"'),
    ("equivalent_forms", "environment runners not read (uv run / poetry run)",
     "            elif _RUNNERS.get(head) and len(rest) > 1 and rest[1] == _RUNNERS[head]:", "            elif False:"),
    ("equivalent_forms", "the seal of an ask by command claims more than a pattern (no 'pattern' qualifier)",
     '    if m.commands:\n        # Invariant 8: a command is matched by PATTERN', '    if False:\n        # Invariant 8: a command is matched by PATTERN'),
    ("bounded_readings", "no ceiling on the spellings of one segment",
     "        if len(out) > MAX_VARIANTS:\n            return out, False", "        if False:\n            return out, False"),
    ("bounded_readings", "no depth limit on nested commands",
     "        if nested and depth >= MAX_DEPTH:\n            complete = False\n            continue", "        if False:\n            complete = False\n            continue"),
    ("bounded_readings", "the interpreter reading has no ceiling",
     "    while pending and len(out) <= MAX_VARIANTS:", "    while pending:"),
    ("both_readings_canonical", "a single reading of an ambiguous wrapper option",
     "    return {found for values in (True, False) if (found := _executable(tokens, values)) is not None}",
     "    return {found for values in (True,) if (found := _executable(tokens, values)) is not None}"),
    ("builtin_equivalent_globs", "only pip / pip3 install listed",
     '     ("pip install *", "pip3 install *", "pip* install *", "pip* install", "python* -m pip install *", "uv pip install *", "uv tool install *",\n      "pipx install *", "pipx run *", "uv tool run *", "uvx *", "get-pip*", "npm install *", "npm i *", "npm add *",\n      "yarn add *", "pnpm add *", "bun add *", "npx *",',
     '     ("pip install *", "pip3 install *", "npm install *", "npx *",'),
    ("approve_off_is_broken", "approvals.mode predicate removed", '    elif a.mode != "manual":', "    elif False:"),
    ("approve_off_is_broken", "approve of an ask rule not strict", "        ask = rule.level is Level.ASK", "        ask = False"),
    ("suggestion_cannot_jump", "a suggestion may be activated", "    if rule.state is not RuleState.DRAFT:\n        raise RuleError(\"not_a_draft\")",
     "    if rule.state is RuleState.ACTIVE:\n        raise RuleError(\"not_a_draft\")"),
]
# builtin_catalog mutates rules_builtin.py, not rules.py
FILE_OF = {"builtin_catalog": "rules_builtin.py", "builtin_equivalent_globs": "rules_builtin.py"}
RESULTS: list[tuple[str, str, str]] = []
_counter = itertools.count()


def load_variant(tmp_path_factory, invariant, old, new):
    filename = FILE_OF.get(invariant, "rules.py")
    source = (SRC / filename).read_text()
    assert source.count(old) == 1, f"mutation target must appear exactly once in {filename}: {old[:50]!r}"
    pkg = tmp_path_factory.mktemp("mut") / f"mutpkg{next(_counter)}"
    pkg.mkdir()
    (pkg / "__init__.py").write_text("")
    for name in ("rules.py", "rules_types.py", "rules_builtin.py"):
        shutil.copy(SRC / name, pkg / name)
    (pkg / filename).write_text(source.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f"{pkg.name}.rules")
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize("name", sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_the_fifteen_of_the_adr_exist_and_each_has_a_mutation():
    assert set(FIFTEEN) <= set(INVARIANTS)
    mutated = {inv for inv, *_ in MUTATIONS}
    assert set(INVARIANTS) <= mutated, set(INVARIANTS) - mutated
    assert mutated <= set(INVARIANTS)


@pytest.mark.parametrize("invariant,label,old,new", MUTATIONS, ids=[f"{i}|{l}" for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, invariant, old, new)
    try:
        INVARIANTS[invariant](variant)
    except Exception as error:  # noqa: BLE001  (red = the invariant noticed; any failure of the check counts)
        RESULTS.append((invariant, label, "RED: " + type(error).__name__))
        return
    RESULTS.append((invariant, label, "SURVIVED"))
    pytest.fail(f"mutation survived: {invariant} / {label}")


def test_zz_print_the_mutation_table(capsys):
    with capsys.disabled():
        print("\n| invariant | mutation | result |\n|---|---|---|")
        for inv, label, result in RESULTS:
            print(f"| {inv} | {label} | {result} |")


# ---------------------------------------------------------------------------------------------------------------------
# plain unit tests (no mutation): edges worth pinning
# ---------------------------------------------------------------------------------------------------------------------
def test_glob_matcher_is_linear_on_adversarial_patterns():
    import time as _t  # the test may use a clock; the module may not
    start = _t.process_time()  # CPU time, not the wall clock a busy machine stretches
    assert not real.glob_match("*a" * 40 + "b", "a" * 5000)
    assert not real.glob_match("*" * 200 + "x", "y" * 5000)
    assert _t.process_time() - start < 2.0


def test_glob_semantics():
    g = real.glob_match
    assert g("*", "") and g("a*", "abc") and g("*c", "abc") and g("a?c", "abc") and not g("a?c", "ac")
    assert g("rm *-r*", "rm -rf x") and not g("rm *-r*", "rmdir -r x")
    assert g("a\\?b", "a?b") and not g("a\\?b", "axb") and g("a\\\\b", "a\\b")
    assert g("[a]", "[a]") and not g("[a]", "a")  # no character classes: brackets are literal


def test_scope_applicability_and_narrowest_citation():
    L = real.Level
    S = real.Scope
    SK = real.ScopeKind
    rules = [rule(real, "g", L.ASK, tools=["x"]), rule(real, "r", L.ASK, tools=["x"], scope=S(SK.ROOM, "sala")),
             rule(real, "b", L.ASK, tools=["x"], scope=S(SK.BOT, "vendas")), rule(real, "j", L.ASK, tools=["x"], scope=S(SK.ROUTINE, "job"))]
    d = real.evaluate(rules, action(real, "x", room="sala", routine="job"))
    assert [h.rule_id for h in d.hits] == ["j", "b", "r", "g"] and d.winner == "j"
    assert [h.rule_id for h in real.evaluate(rules, action(real, "x")).hits] == ["b", "g"]
    assert real.evaluate([rule(real, "n", L.BLOCK, tools=["x"], scope=S(SK.BOT, None))], action(real, "x")).effect is L.ALLOW


def test_toolset_and_server_rules_use_the_facts_the_caller_gives():
    L = real.Level
    r = rule(real, "t", L.BLOCK, toolsets=["browser"], tools=["browser_*"])
    assert real.evaluate([r], action(real, "browser_open", toolset="browser")).effect is L.BLOCK
    assert real.evaluate([r], action(real, "browser_open", toolset="other")).effect is L.ALLOW
    assert real.evaluate([r], action(real, "other", toolset="browser")).effect is L.ALLOW   # all-of across fields
    assert real.evaluate([rule(real, "s", L.BLOCK, servers=["crm"])], action(real, "mcp_crm_x", mcp_server="CRM")).effect is L.BLOCK


def test_all_empty_match_matches_nothing_and_never_hooks():
    r = rule(real, "e", real.Level.BLOCK)
    assert real.evaluate([r], action(real, "x")).effect is real.Level.ALLOW
    assert real.compile_hook_table([r], version=1, toolset_tools={}, mcp_server_tools={}).entries == ()


def test_the_rules_are_never_mutated():
    rules = [*real.builtin_rules(), rule(real, "a", real.Level.ASK, tools=["x"])]
    snapshot = repr(rules)
    act = action(real, "x", command="rm -rf /tmp/x")
    real.evaluate(rules, act)
    real.compile_hook_table(rules, version=1, toolset_tools={}, mcp_server_tools={})
    real.simulate(rules, live(real), act, expected_hook_digest="d1", now=NOW)
    assert repr(rules) == snapshot


def test_decisions_are_plain_data_and_hashable():
    d = real.evaluate(real.builtin_rules(), action(real, "files_delete"))
    assert hash(d) == hash(real.evaluate(real.builtin_rules(), action(real, "files_delete")))
    assert d.hits and all(isinstance(h.matched_on, tuple) for h in d.hits)



def test_d025_the_seal_and_the_hook_agree_on_the_platforms():
    import backend.hook_store as store
    assert real.CHANNEL_APPROVAL_PLATFORMS == store.CHANNEL_APPROVAL_PLATFORMS == ("telegram",)
