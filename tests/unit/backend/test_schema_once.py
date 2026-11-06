"""Perf item 3: the hot read paths no longer run CREATE/ALTER, write, or take the write lock on every call.

Measured on the Today screen (9 routes): 134 `executescript` and 233 SQLite connections, `RunIndex` writing its key row on each build,
`Budget` taking BEGIN IMMEDIATE for its constructor and for every read-only view (`/costs`: 3 + one per Bot), and the approvals list
running an UPDATE + commit every 15 s per open tab. In a rollback-journal database each of those makes the others wait.

Pinned here, from the SQL each call really sends (a trace on every connection):
* the schema of each store runs ONCE per process and file; a later construction only asks the catalog, and a file that lost a table or a
  trigger, or was replaced, gets the schema again (the audit log's append-only triggers heal);
* the Budget's read-only views (snapshot, projection, routine_spend, routines_over_cap) and an approvals list with nothing due send no
  write and no BEGIN IMMEDIATE, while expiry still happens when something is due;
* `hook_state` reads the beats and the applied digest in one connection, `unread` reads the mark and the ends in one;
* mutations of that code are red.
"""
import contextlib
import itertools
import importlib.util
from pathlib import Path
import sqlite3
import sys
import time
import types

import pytest


def _stub(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return name


# `runs` and `bot_controls` import three Hermes modules when they load: stand-ins just for that import, removed again after it
_installed = [name for name in ("agent", "hermes_cli", "agent.secret_scope", "hermes_cli.profiles", "hermes_cli.web_server_profiles")
              if name not in sys.modules]
for _name, _attrs in (("agent", {}), ("hermes_cli", {}), ("agent.secret_scope", {"current_secret_scope": lambda: None, "get_secret": lambda *a: None}),
                      ("hermes_cli.profiles", {"list_profile_names": lambda: []}),
                      ("hermes_cli.web_server_profiles", {"_config_profile_scope": lambda p: contextlib.nullcontext()})):
    if _name in _installed:
        _stub(_name, **_attrs)

import backend.approvals as approvals  # noqa: E402
import backend.dbfile as dbfile  # noqa: E402
import backend.hook_store as hook_store  # noqa: E402
from backend import bot_controls, bot_meta, budget, rules_store, runs  # noqa: E402
from backend.audit import AuditLog  # noqa: E402

for _name in _installed:
    sys.modules.pop(_name, None)

BACKEND = Path(budget.__file__).parent
WRITES = ("CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "REPLACE", "BEGIN IMMEDIATE", "DROP")


@pytest.fixture
def trace(monkeypatch):
    """Every statement of every connection opened from now on, and how many connections that is."""
    seen = {"sql": [], "connects": 0}
    real = sqlite3.connect

    def traced(*args, **kwargs):
        conn = real(*args, **kwargs)
        conn.set_trace_callback(seen["sql"].append)
        seen["connects"] += 1
        return conn
    monkeypatch.setattr(sqlite3, "connect", traced)
    return seen


def writes(seen):
    return [s for s in seen["sql"] if s.lstrip().upper().startswith(WRITES)]


def build_all(db):
    audit = AuditLog(db)
    bot_meta.BotMeta(db)
    runs.RunIndex(db)
    budget.Budget(db, audit=audit)
    hook_store.connect(db).close()
    rules_store.connect(db).close()
    approvals.connect(db).close()
    bot_controls._db(db).close()
    return audit


def test_the_schema_runs_once_per_process_and_file(tmp_path, trace):
    db = tmp_path / "luvebot" / "luvebot.db"
    audit = build_all(db)
    assert [s for s in trace["sql"] if s.lstrip().upper().startswith("CREATE")], "the first build makes the schema"
    trace["sql"].clear()
    build_all(db)
    assert writes(trace) == [], writes(trace)                                    # the second one only asks the catalog
    assert any("sqlite_master" in s for s in trace["sql"])
    assert audit.verify()["ok"] is True


def test_a_second_database_file_gets_its_own_schema(tmp_path, trace):
    build_all(tmp_path / "a" / "luvebot.db")
    trace["sql"].clear()
    build_all(tmp_path / "b" / "luvebot.db")
    assert [s for s in trace["sql"] if s.lstrip().upper().startswith("CREATE")]


def names(db):
    with sqlite3.connect(db) as conn:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}


def test_a_file_that_lost_a_trigger_or_a_table_gets_the_schema_again(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    build_all(db)
    with sqlite3.connect(db) as conn:
        conn.execute("DROP TRIGGER audit_no_delete")
        conn.execute("DROP TABLE run_index")
    assert "audit_no_delete" not in names(db) and "run_index" not in names(db)
    AuditLog(db)
    runs.RunIndex(db)
    assert {"audit_no_delete", "run_index"} <= names(db)                         # the append-only trigger heals


def test_a_replaced_database_file_gets_the_schema_again(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    build_all(db)
    for suffix in ("", "-journal"):
        Path(str(db) + suffix).unlink(missing_ok=True)
    build_all(db)
    assert {"audit_log", "run_index", "approvals", "budget_limits"} <= names(db)


def test_the_budget_views_and_an_idle_approvals_list_send_no_write(tmp_path, trace):
    db = tmp_path / "luvebot" / "luvebot.db"
    audit = build_all(db)
    bud = budget.Budget(db, audit=audit)
    trace["sql"].clear()
    bud.snapshot()
    bud.projection()
    bud.projection("vendas")
    bud.routine_spend()
    bud.routines_over_cap()
    approvals.list_approvals(db, limit=10)
    assert writes(trace) == [], writes(trace)                                    # no BEGIN IMMEDIATE, no UPDATE, no CREATE


def test_expiry_still_happens_when_something_is_due(tmp_path, trace):
    db = tmp_path / "luvebot" / "luvebot.db"
    build_all(db)
    conn = approvals.connect(db)
    conn.execute("INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, command_redacted, description, pattern_keys,"
                 " allowed_choices, digest, action_class_hash, created_at, expires_at, status) VALUES ('r1','run','hook','vendas','luvebot',"
                 "'hook','ls','d','[]','[\"once\",\"deny\"]','x','y',?,?,'pending')", (time.time() - 100, time.time() - 10))
    conn.commit()
    conn.close()
    trace["sql"].clear()
    items, _ = approvals.list_approvals(db, limit=10)
    assert [i["status"] for i in items] == ["expired"]
    assert any(s.lstrip().upper().startswith("UPDATE") for s in trace["sql"])
    trace["sql"].clear()
    approvals.list_approvals(db, limit=10)
    assert writes(trace) == []                                                   # and once expired, nothing is written again


def test_the_budget_views_keep_their_answers_and_still_fail_closed(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    audit = build_all(db)
    bud = budget.Budget(db, audit=audit)
    snap = bud.snapshot()
    assert set(snap) == {"limits", "paused", "watcher", "alerts"} and snap["paused"] == []
    with sqlite3.connect(db) as conn:
        conn.execute("DROP TABLE budget_limits")                                  # the views do not make the schema: an unreadable budget is unavailable
    with pytest.raises(budget.BudgetUnavailable):
        bud.snapshot()


def test_one_connection_for_the_hook_state_reads_and_for_unread(tmp_path, trace):
    db = tmp_path / "luvebot" / "luvebot.db"
    build_all(db)
    hook_store.beat(db, "vendas", 1234, True, "d" * 64, "0.5.0", now=time.time())
    trace["connects"] = 0
    beats, digest = hook_store.beats_and_digest(db, "vendas")
    assert trace["connects"] == 1 and beats == hook_store.beats(db, "vendas") and digest == hook_store.table_digest(db, "vendas") is None or digest is None
    runs.RunIndex(db).add("run1", "vendas", "s1", "dashboard", "completed")
    conn = sqlite3.connect(db)
    conn.execute("UPDATE run_index SET ended_at='2026-10-01T00:00:10Z' WHERE run_id='run1'")
    conn.commit()
    conn.close()
    trace["connects"] = 0
    got = bot_controls.unread(db, "vendas", 2)
    assert trace["connects"] == 1
    assert (got["replies"], got["routine_results"], got["count"], got["since"]) == (1, 2, 3, 0.0)


# ---- ADR-008 section 4.2: journal_size_limit on EVERY connection -----------------------------------------------------------------------
class Recording(sqlite3.Connection):
    """A connection that remembers what it was asked, so the statement `dbfile.connect` sends right after opening it can be seen."""
    LOG = []
    COUNT = itertools.count()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ident = next(Recording.COUNT)   # NOT id(self): CPython reuses the id of a closed connection for the next one, which collapsed 8 connections into 1

    def execute(self, sql, *args, **kwargs):
        Recording.LOG.append((self.ident, str(sql)))
        return super().execute(sql, *args, **kwargs)


def record_connections(monkeypatch):
    Recording.LOG.clear()
    real = sqlite3.connect

    def spy(database, *args, **kwargs):
        if "mode=ro" not in str(database):                            # a read-only connection cannot checkpoint: not routed through dbfile.connect
            kwargs["factory"] = Recording
        return real(database, *args, **kwargs)
    monkeypatch.setattr(sqlite3, "connect", spy)


def first_statements():
    seen = {}
    for ident, sql in Recording.LOG:
        seen.setdefault(ident, sql)
    return seen


def run_every_store(db):
    audit = build_all(db)
    bud = budget.Budget(db, audit=audit)
    bud.snapshot()
    bud.projection()
    approvals.list_approvals(db, limit=5)
    hook_store.beat(db, "vendas", 1, True, "d" * 64, "0.7.0")
    hook_store.beats_and_digest(db, "vendas")
    bot_controls.unread(db, "vendas", 0)
    runs.RunIndex(db).add("run1", "vendas", "s1", "dashboard", "completed")
    audit.verify()
    audit.journal_mode()


def test_every_connection_of_every_store_sets_the_size_limit(tmp_path, monkeypatch):
    """The limit is per connection, not in the file, and any connection may be the one that checkpoints: a connection that did not set it leaves
    the -wal at about 10 MiB after a checkpoint where one that did cuts it to about 1 MiB. So the SECOND connection of a process has it too."""
    record_connections(monkeypatch)
    run_every_store(tmp_path / "luvebot" / "luvebot.db")
    firsts = first_statements()
    assert len(firsts) >= 8, len(firsts)                                  # many connections: every one of them is checked
    assert {sql for sql in firsts.values()} == {f"PRAGMA journal_size_limit={dbfile.WAL_LIMIT}"}, {s for s in firsts.values()}
    assert dbfile.WAL_LIMIT == 64 * 1024 * 1024


# ---- mutations of the code under test: each must turn its test red ------------------------------------------------------------
def load(name, edits):
    source = (BACKEND / f"{name}.py").read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader(f"backend.{name}_under_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "backend"
    exec(compile(source, str(BACKEND / f"{name}.py"), "exec"), module.__dict__)
    return module


def mutate_dbfile(monkeypatch, edits):
    monkeypatch.setattr(dbfile, "ensure", load("dbfile", edits).ensure)


def mutate_dbfile_connect(monkeypatch, edits):
    monkeypatch.setattr(dbfile, "connect", load("dbfile", edits).connect)


def mutate_budget(monkeypatch, edits):
    monkeypatch.setattr(budget, "Budget", load("budget", edits).Budget)


def mutate_approvals(monkeypatch, edits):
    monkeypatch.setattr(approvals, "expire", load("approvals", edits).expire)


MUTATIONS = {
    "the size limit is set only on the first connection": (
        lambda mp: mutate_dbfile_connect(mp, [("    try:\n        conn.execute(f\"PRAGMA journal_size_limit={WAL_LIMIT}\")\n    except Exception:  # noqa: BLE001\n        pass\n    return conn",
                                               "    if (str(path),) not in _DONE:\n        _DONE.add((str(path),))\n        conn.execute(f\"PRAGMA journal_size_limit={WAL_LIMIT}\")\n    return conn")]),
        test_every_connection_of_every_store_sets_the_size_limit),
    "the schema runs on every call": (
        lambda mp: mutate_dbfile(mp, [("    if key in _DONE and names:\n", "    if False:\n")]), test_the_schema_runs_once_per_process_and_file),
    "the catalog is never asked, so a lost trigger stays lost": (
        lambda mp: mutate_dbfile(mp, [("        if conn.execute(f\"SELECT COUNT(*) FROM sqlite_master WHERE name IN ({marks})\", names).fetchone()[0] == len(names):\n",
                                       "        if True:\n")]), test_a_file_that_lost_a_trigger_or_a_table_gets_the_schema_again),
    "snapshot takes the write lock": (
        lambda mp: mutate_budget(mp, [("        with self._read() as conn:\n            now = self._now()\n            periods = {\"day\": now.strftime(\"%Y-%m-%d\"), \"month\": now.strftime(\"%Y-%m\")}\n            limits = []",
                                       "        with self._transaction() as conn:\n            now = self._now()\n            periods = {\"day\": now.strftime(\"%Y-%m-%d\"), \"month\": now.strftime(\"%Y-%m\")}\n            limits = []")]),
        test_the_budget_views_and_an_idle_approvals_list_send_no_write),
    "projection takes the write lock": (
        lambda mp: mutate_budget(mp, [("        with self._read() as conn:\n            now = self._now()\n            where, args =", "        with self._transaction() as conn:\n            now = self._now()\n            where, args =")]),
        test_the_budget_views_and_an_idle_approvals_list_send_no_write),
    "expiry always writes": (
        lambda mp: mutate_approvals(mp, [("    if conn.execute(\"SELECT 1 FROM approvals WHERE status='pending' AND expires_at <= ? LIMIT 1\", (now,)).fetchone() is None:\n        return\n", "")]),
        test_the_budget_views_and_an_idle_approvals_list_send_no_write),
    "expiry never writes": (
        lambda mp: mutate_approvals(mp, [("    conn.execute(\"UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at <= ?\", (now,))\n    conn.commit()\n", "    return\n")]),
        test_expiry_still_happens_when_something_is_due),
}


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    apply, check = MUTATIONS[label]
    apply(monkeypatch)
    names_ = check.__code__.co_varnames[:check.__code__.co_argcount]
    args = {"tmp_path": tmp_path, "trace": None, "monkeypatch": monkeypatch}
    if "trace" in names_:
        seen = {"sql": [], "connects": 0}
        real = sqlite3.connect

        def traced(*a, **k):
            conn = real(*a, **k)
            conn.set_trace_callback(seen["sql"].append)
            seen["connects"] += 1
            return conn
        monkeypatch.setattr(sqlite3, "connect", traced)
        args["trace"] = seen
    with pytest.raises((AssertionError, budget.BudgetUnavailable, sqlite3.Error)):
        check(**{k: args[k] for k in names_})
