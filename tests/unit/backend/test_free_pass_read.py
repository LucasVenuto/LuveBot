"""Reads of the 0.5.0 rows (docs/propostas/hook-0.5-free-pass-e-espera.md, approved): `free_pass` for GET /bots/{bot}/free-passes with
`audited` computed against the REAL chained audit log, `waiting` for "the Bot is waiting for you", the 5000-row cap (H-1) and the static
guard that every production read of `hook_events` names its verdict (H-3)."""
import ast
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import time

import pytest

import backend.free_pass as free_pass
import backend.hook_store as store
from backend.audit import AuditLog

REPO = Path(__file__).resolve().parents[2].parent


def put(db, verdict, *, profile="vendas", tool="terminal", rule="builtin.sensitive_access.commands", command="chmod 600 /tmp/x", ts=None,
        request=None, session="s1", message="m"):
    return store.record_event(db, profile, tool, rule, verdict, message, "", session, request or "", command, now=ts)


def surface(db, mode, *, before="luvebot", ref=True, approvers=(), bot="vendas", fail=False, during=None):
    """One audited approval-surface change, as the route writes it (the payload is only hashed in the log)."""
    origin = {"kind": "ui", "ref": f"surface.{mode}.{'a1' * 16}"} if ref is True else {"kind": "ui"} if ref is False else {"kind": "ui", "ref": ref}

    def effect():
        if during is not None:
            during()
        if fail:
            raise RuntimeError("refused")
    try:
        AuditLog(db).act("basic:ceo", "bot.approval_surface", bot, origin, effect, bot=bot,
                         payload={"from": before, "mode": mode, "approvers": list(approvers)})
    except RuntimeError:
        pass


def intent_only(db, mode, *, bot="vendas"):
    """An intent row with no result row (the dashboard died between them): the log is append-only, so write just the first half."""
    AuditLog(db)._append(dict(actor="basic:ceo", action="bot.approval_surface", target=bot, origin_kind="ui",
                              origin_ref=f"surface.{mode}.{'c3' * 16}", bot=bot, digest=None), "ok", "intent")


def after():
    return time.time() + 0.001


def test_free_passes_come_newest_first_in_pages_with_an_epoch_cursor(tmp_path):
    db = tmp_path / "f.db"
    for i in range(5):
        put(db, "free_pass", command=f"chmod 600 /tmp/{i}", ts=1000.0 + i)
    put(db, "approve", ts=1100.0)
    put(db, "block", ts=1101.0)
    put(db, "free_pass", profile="other", ts=1102.0)
    first = free_pass.read(db, "vendas", limit=2)
    assert [i["command"] for i in first["free_passes"]] == ["chmod 600 /tmp/4", "chmod 600 /tmp/3"] and first["next_before"] == 1003.0
    second = free_pass.read(db, "vendas", limit=2, before=first["next_before"])
    assert [i["command"] for i in second["free_passes"]] == ["chmod 600 /tmp/2", "chmod 600 /tmp/1"] and second["next_before"] == 1001.0
    last = free_pass.read(db, "vendas", limit=2, before=second["next_before"])
    assert [i["command"] for i in last["free_passes"]] == ["chmod 600 /tmp/0"] and last["next_before"] is None
    exact = free_pass.read(db, "vendas", limit=5)
    assert len(exact["free_passes"]) == 5 and exact["next_before"] is None                   # a full page that is also the last one
    assert free_pass.read(db, "nobody") == {"free_passes": [], "next_before": None}
    assert free_pass.read(db, "vendas", before=1000.0) == {"free_passes": [], "next_before": None}   # strictly before


def test_an_item_is_what_contract_v0_9_says_and_nothing_more(tmp_path):
    db = tmp_path / "f.db"
    put(db, "free_pass", ts=1760000000.0, session="s9", message="luvebot:rule")
    (item,) = free_pass.read(db, "vendas")["free_passes"]
    assert set(item) == {"at", "tool", "rule_id", "command", "audited"}          # no session, no rule key, no hook row id, no message
    assert item["at"] == 1760000000.0 and item["audited"] is False and item["tool"] == "terminal"


def test_audited_follows_the_chain_a_person_turned_the_livre_on(tmp_path):
    db = tmp_path / "f.db"
    put(db, "free_pass", ts=time.time() - 60)             # before anybody turned it on: no record
    surface(db, "free")
    put(db, "free_pass", ts=after())                       # after a recorded turn-on
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [True, False]          # newest first
    surface(db, "luvebot", before="free")                  # the owner left the Livre ...
    put(db, "free_pass", ts=after())                       # ... and a pass after that has no turn-on behind it
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [False, True, False]
    surface(db, "free")
    put(db, "free_pass", ts=after())
    assert free_pass.read(db, "vendas")["free_passes"][0]["audited"] is True


def test_a_pass_between_the_intent_and_the_result_is_still_audited(tmp_path):
    """The effect lands before the result row is appended: a call in that gap is not a forgery (the intent is the evidence)."""
    db = tmp_path / "f.db"
    surface(db, "free", during=lambda: put(db, "free_pass", ts=time.time()))
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [True]


def test_a_free_row_nobody_audited_is_the_forgery_sign(tmp_path):
    """A `free` row written straight into luvebot.db: passes, no audited turn-on of this Bot anywhere (another Bot's does not count)."""
    db = tmp_path / "f.db"
    surface(db, "free", bot="another")
    put(db, "free_pass", ts=after())
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [False]
    store.put_surface(db, "vendas", "free", [], "root")    # the forged row itself is not evidence
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [False]


def test_a_change_that_failed_or_has_no_result_is_not_a_turn_on(tmp_path):
    db = tmp_path / "f.db"
    surface(db, "free", fail=True)                         # intent ok, result error
    put(db, "free_pass", ts=after())
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [False]
    intent_only(db, "free")                                # intent ok, no result at all
    put(db, "free_pass", ts=after())
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [False, False]
    surface(db, "free")
    put(db, "free_pass", ts=after())
    assert free_pass.read(db, "vendas")["free_passes"][0]["audited"] is True


def test_changes_audited_before_the_mode_went_in_the_reference_are_read_by_their_digest(tmp_path):
    """The Livre may already have been turned on with the first release of this feature: a random reference, and only the payload digest."""
    db = tmp_path / "f.db"
    surface(db, "free", ref=False)                          # from luvebot, no approvers: the only shape the screen sends
    put(db, "free_pass", ts=after())
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [True]
    surface(db, "luvebot", before="free", ref=False)
    put(db, "free_pass", ts=after())
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]][0] is False
    surface(db, "channel", before="luvebot", ref=False, approvers=["telegram:42"])   # approvers: not recognised, so not a turn-on
    surface(db, "free", before="channel", ref=False)
    put(db, "free_pass", ts=after())
    assert free_pass.read(db, "vendas")["free_passes"][0]["audited"] is True
    assert free_pass.LEGACY[hashlib.sha256(json.dumps({"from": "luvebot", "mode": "free", "approvers": []}, sort_keys=True,
                                                      separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()] == "free"


def test_the_reference_the_route_writes_is_what_the_reader_expects():
    plugin = (REPO / "dashboard" / "plugin_api.py").read_text()
    assert "'ref': f'surface.{new_mode}.{uuid4().hex}'" in plugin
    assert free_pass._REF.fullmatch("surface.free." + "0" * 32) and not free_pass._REF.fullmatch("surface.free.abc")


def test_a_database_without_an_audit_table_audits_nothing(tmp_path):
    db = tmp_path / "f.db"
    put(db, "free_pass", ts=time.time())
    assert [i["audited"] for i in free_pass.read(db, "vendas")["free_passes"]] == [False]


# ---- waiting ------------------------------------------------------------------------------------------------------------------
R1, R2, R3 = "1" * 32, "2" * 32, "3" * 32


def test_waiting_is_a_request_nobody_resolved_and_younger_than_a_day(tmp_path):
    db = tmp_path / "f.db"
    now = 10_000_000.0
    put(db, "waiting", tool="human_input:clarify", message="May I?", request=R1, ts=now - 100, session="sA", command=None)
    put(db, "waiting", tool="human_input:sudo", message="password for ls", request=R2, ts=now - 50, command=None)
    put(db, "resolved", tool="human_input:sudo", message="answered", request=R2, ts=now - 10, command=None)
    put(db, "waiting", tool="human_input:approval", message="rm -r x", request=R3, ts=now - 25 * 3600, command=None)   # never closed, old
    put(db, "waiting", tool="human_input:clarify", message="other bot", request="4" * 32, ts=now - 5, profile="other", command=None)
    got = store.waiting(db, "vendas", now=now)
    assert got == [{"id": got[0]["id"], "ts": now - 100, "kind": "clarify", "prompt": "May I?", "session_id": "sA", "request_id": R1}]
    put(db, "resolved", tool="human_input:clarify", message="timeout", request=R1, ts=now - 1, command=None)
    assert store.waiting(db, "vendas", now=now) == []
    put(db, "waiting", tool="human_input:clarify", message="newer", request="5" * 32, ts=now - 20, command=None)
    put(db, "waiting", tool="human_input:approval", message="telegram", request="6" * 32, ts=now - 10, command=None)
    assert [w["kind"] for w in store.waiting(db, "vendas", now=now)] == ["approval", "clarify"]      # newest first; approval is included


def test_a_resolved_row_of_another_bot_does_not_close_a_wait(tmp_path):
    db = tmp_path / "f.db"
    put(db, "waiting", tool="human_input:clarify", message="x", request=R1, ts=100.0, command=None)
    put(db, "resolved", tool="human_input:clarify", message="answered", request=R1, ts=101.0, profile="other", command=None)
    assert len(store.waiting(db, "vendas", now=200.0)) == 1


# ---- H-1: the cap --------------------------------------------------------------------------------------------------------------
def test_free_passes_are_capped_per_bot_and_nothing_else_is_touched(tmp_path, monkeypatch):
    db = tmp_path / "f.db"
    monkeypatch.setattr(store, "FREE_PASS_KEEP", 3)
    now = time.time()
    for i in range(6):
        put(db, "free_pass", command=f"chmod {i}", ts=now - 10 + i)
    keep = [put(db, "approve", ts=now - 20), put(db, "block", ts=now - 19), put(db, "waiting", ts=now - 18, command=None)]
    others = [put(db, "free_pass", profile="other", ts=now - 17 + i) for i in range(5)]
    store.beat(db, "vendas", 1, True, "d", "0.5.0", now=now)
    assert [r["command"] for r in store.events(db, "vendas", 50) if r["verdict"] == "free_pass"] == ["chmod 5", "chmod 4", "chmod 3"]
    assert {r["verdict"] for r in store.events(db, "vendas", 50)} == {"free_pass", "approve", "block", "waiting"}
    assert len([r for r in store.events(db, "other", 50)]) == len(others)                 # another Bot's rows wait for its own beat
    store.beat(db, "other", 2, True, "d", "0.5.0", now=now)
    assert len(store.events(db, "other", 50)) == 3


def test_the_week_old_rows_still_go(tmp_path):
    db = tmp_path / "f.db"
    now = time.time()
    put(db, "free_pass", ts=now - store.EVENT_KEEP - 5)
    keep = put(db, "free_pass", ts=now - 5)
    store.beat(db, "vendas", 1, True, "d", "0.5.0", now=now)
    assert [r["id"] for r in store.events(db, "vendas", 50)] == [keep]


# ---- H-3: every production read of hook_events names a verdict ------------------------------------------------------------------
def production_sources():
    return [*sorted((REPO / "backend").glob("*.py")), REPO / "dashboard" / "plugin_api.py", REPO / "dashboard" / "plugin_entry.py",
            REPO / "hermes-plugin" / "__init__.py"]


def selects_without_a_verdict(source):
    found = []
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            text = " ".join(node.value.split()).lower()
            if text.startswith("select") and "from hook_events" in text and "verdict" not in text:
                found.append(node.lineno)
    return found


def test_every_production_read_of_hook_events_names_its_verdict():
    offenders = {}
    for path in production_sources():
        lines = selects_without_a_verdict(path.read_text())
        if path.name == "hook_store.py":   # `events`, the one unfiltered read: for tests, and nothing in production may call it (next test)
            lines = [n for n in lines if "SELECT * FROM hook_events WHERE profile=? ORDER BY id DESC" not in path.read_text().splitlines()[n - 1]]
        if lines:
            offenders[path.name] = lines
    assert offenders == {}


def test_no_production_code_calls_the_unfiltered_events_read():
    callers = []
    for path in production_sources():
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "events" \
                    and isinstance(node.func.value, ast.Name) and node.func.value.id in ("hook_store", "store"):
                callers.append((path.name, node.lineno))
    assert callers == []


def test_the_guard_sees_an_unfiltered_select():
    """The mutation: a new read of the table with no verdict (a `waiting` row would reach a list of blocks)."""
    assert selects_without_a_verdict('conn.execute("SELECT * FROM hook_events WHERE profile=?")')
    assert selects_without_a_verdict('conn.execute("""SELECT tool, message\n   FROM hook_events WHERE profile=?""")')
    assert not selects_without_a_verdict('conn.execute("SELECT * FROM hook_events WHERE verdict=\'approve\'")')
    assert not selects_without_a_verdict('conn.execute("DELETE FROM hook_events WHERE ts < ?")')       # retention is not a read
