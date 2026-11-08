"""Perf item 4, the data side of GET /bots and GET /rooms, against real SQLite.

* `bot_controls.unread` counts in the database, over the new index `run_index_ended (bot, last_status, ended_at)`; it used to load EVERY completed run
  of the Bot and parse each date in Python on every poll (10 ms per Bot at 10 000 runs, 50 to 70 ms at worst). Its answer is the old one: a property
  test against the old code over random runs and marks, including the edges (a run that ended exactly at the mark, a mark in fractions of a second, a
  Bot with no mark, runs of another Bot, runs not completed, runs without an end);
* `rooms.metas` and `handoffs.open_counts` answer the whole list of rooms in one query each (it used to open the database twice per room); a room with
  nothing is zero and empty, as before. One difference, on purpose: a room's open handoffs are all counted (the old count looked only at the newest 101).
Mutations: one line of the code changed -> red."""
import contextlib
import importlib.util
from pathlib import Path
import random
import re
import sqlite3
import sys
import time
import types

import pytest


def _stub(name, **attrs):
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module


# `runs` and `bot_controls` import three Hermes modules when they load: stand-ins just for that import, removed again after it
_installed = [name for name in ("agent", "hermes_cli", "agent.secret_scope", "hermes_cli.profiles", "hermes_cli.web_server_profiles") if name not in sys.modules]
for _name, _attrs in (("agent", {}), ("hermes_cli", {}), ("agent.secret_scope", {"current_secret_scope": lambda: None, "get_secret": lambda *a: None}),
                      ("hermes_cli.profiles", {"list_profile_names": lambda: []}),
                      ("hermes_cli.web_server_profiles", {"_config_profile_scope": lambda p: contextlib.nullcontext()})):
    if _name in _installed:
        _stub(_name, **_attrs)

from backend import bot_controls, handoffs, rooms, runs  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

for _name in _installed:
    sys.modules.pop(_name, None)

BACKEND = Path(bot_controls.__file__).parent


def iso(epoch):
    """`ended_at` as `RunIndex.set_status` writes it: microseconds, one fixed UTC form (a test that wrote whole seconds hid the same-second bug)."""
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def old_unread(path, bot, routine_results):
    """The code this replaced, kept here as the reference."""
    conn = bot_controls._db(path)
    try:
        marks = conn.execute("SELECT read_through FROM bot_read_state WHERE bot=?", (bot,)).fetchall()
        ends = conn.execute("SELECT ended_at FROM run_index WHERE bot=? AND last_status='completed' AND ended_at IS NOT NULL", (bot,)).fetchall()
    finally:
        conn.close()
    since = marks[0][0] if marks else 0.0
    replies = sum(datetime.fromisoformat(r[0].replace("Z", "+00:00")).timestamp() > since for r in ends)
    return {"count": replies + (routine_results or 0), "replies": replies, "routine_results": routine_results, "since": since}


def fill(db, rows, mark=None):
    runs.RunIndex(db)
    conn = bot_controls._db(db)
    try:
        conn.executemany("INSERT INTO run_index (run_id, bot, session_id, actor, started_at, last_status, ended_at) VALUES (?,?,?,?,?,?,?)", rows)
        if mark is not None:
            conn.execute("INSERT OR REPLACE INTO bot_read_state (bot, read_through, updated_at, updated_by) VALUES ('vendas', ?, 0, 'x')", (mark,))
        conn.commit()
    finally:
        conn.close()


def test_unread_gives_the_old_answer_on_random_runs_and_marks(tmp_path):
    rng = random.Random(11)
    base = 1_790_000_000
    for trial in range(40):
        db = tmp_path / f"t{trial}" / "luvebot.db"
        db.parent.mkdir()
        rows = []
        for i in range(rng.randint(0, 60)):
            ended = base + rng.randint(-30, 30) + rng.choice([0, 0, 0.2, 0.5, 0.999999])
            rows.append((f"r{i}", rng.choice(["vendas", "vendas", "suporte"]), "s", "dashboard", iso(base - 100),
                         rng.choice(["completed", "completed", "failed", "working"]), rng.choice([iso(ended), iso(ended), None])))
        edge = [base, base + 0.5, base - 0.5, base + 0.999, base - 0.001, base + 1, 0.0, base + 1e-7, base - 29.5, base + 0.2, base + 0.999999]
        mark = rng.choice([None, *edge])
        fill(db, rows, mark)
        for routine in (None, 0, 3):
            assert bot_controls.unread(db, "vendas", routine) == old_unread(db, "vendas", routine), (trial, mark)


def test_a_run_that_ended_exactly_at_the_mark_is_not_unread_and_one_second_later_is(tmp_path):
    db = tmp_path / "luvebot.db"
    mark = 1_790_000_000
    fill(db, [("a", "vendas", "s", "d", iso(mark - 9), "completed", iso(mark)), ("b", "vendas", "s", "d", iso(mark - 9), "completed", iso(mark + 1))], mark)
    assert bot_controls.unread(db, "vendas", None)["replies"] == 1
    assert bot_controls.unread(db, "vendas", 4) == {"count": 5, "replies": 1, "routine_results": 4, "since": float(mark)}
    fill_mark = mark + 0.5                                                                  # a mark in the middle of a second
    conn = bot_controls._db(db)
    conn.execute("UPDATE bot_read_state SET read_through=?", (fill_mark,))
    conn.commit()
    conn.close()
    assert bot_controls.unread(db, "vendas", None)["replies"] == 1 == old_unread(db, "vendas", None)["replies"]


def test_a_run_that_ends_in_the_same_second_as_the_mark_but_after_it_is_unread(tmp_path):
    """The Forja's finding: `ended_at` has microseconds, the floor of the mark had whole seconds, so text order put every end of the mark's own
    second below the floor and a reply that finished 0.2 s after the mark never counted."""
    db = tmp_path / "luvebot.db"
    second = 1_790_000_000
    rows = [("after", "vendas", "s", "d", iso(second - 9), "completed", iso(second + 0.5)),            # same second, after the mark
            ("late", "vendas", "s", "d", iso(second - 9), "completed", iso(second + 0.999999)),
            ("at", "vendas", "s", "d", iso(second - 9), "completed", iso(second + 0.3)),                # exactly at the mark: read
            ("before", "vendas", "s", "d", iso(second - 9), "completed", iso(second + 0.299999)),       # same second, before the mark: read
            ("early", "vendas", "s", "d", iso(second - 9), "completed", iso(second + 0.0))]
    fill(db, rows, second + 0.3)
    assert bot_controls.unread(db, "vendas", None)["replies"] == 2
    conn = bot_controls._db(db)                                                                     # a mark on the whole second: 0.2 s later is unread
    conn.execute("UPDATE bot_read_state SET read_through=?", (float(second),))
    conn.commit()
    conn.close()
    assert bot_controls.unread(db, "vendas", None)["replies"] == 4                                  # everything after the second's first instant, not "early"


def test_the_run_index_writes_the_end_with_microseconds_the_count_compares_with(tmp_path):
    """The real writer, with a clock 0.2 s after the mark: the reply counts. Pins the form `unread` assumes (a change to whole seconds goes red)."""
    db = tmp_path / "luvebot.db"
    mark = 1_790_000_000.0

    class Later(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromtimestamp(mark + 0.2, tz)

    index = runs.RunIndex(db)
    index.add("run1", "vendas", "s", "d", "running")
    real, runs.datetime = runs.datetime, Later
    try:
        index.set_status("run1", "completed")
    finally:
        runs.datetime = real
    conn = bot_controls._db(db)
    conn.execute("INSERT INTO bot_read_state (bot, read_through, updated_at, updated_by) VALUES ('vendas', ?, 0, 'x')", (mark,))
    conn.commit()
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z", conn.execute("SELECT ended_at FROM run_index").fetchone()[0])
    conn.close()
    assert bot_controls.unread(db, "vendas", None)["replies"] == 1 == old_unread(db, "vendas", None)["replies"]


def test_the_count_uses_the_new_index(tmp_path):
    db = tmp_path / "luvebot.db"
    fill(db, [("a", "vendas", "s", "d", iso(1), "completed", iso(2))])
    with contextlib.closing(sqlite3.connect(db)) as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        plan = " ".join(str(r) for r in conn.execute(
            "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM run_index WHERE bot='vendas' AND last_status='completed' AND ended_at IS NOT NULL AND ended_at > '2026'"))
    assert "run_index_ended" in names and "run_index_ended" in plan, plan


def test_an_old_database_without_the_index_gets_it_when_the_run_index_opens(tmp_path):
    db = tmp_path / "luvebot.db"
    with contextlib.closing(sqlite3.connect(db)) as conn:                                      # what 0.2 made: the table with the columns, no index on them
        conn.executescript("CREATE TABLE run_index (run_id TEXT PRIMARY KEY, bot TEXT NOT NULL, session_id TEXT, actor TEXT NOT NULL, "
                           "started_at TEXT NOT NULL, last_status TEXT NOT NULL, ended_at TEXT, prompt_sha TEXT); "
                           "CREATE INDEX run_index_bot ON run_index (bot, started_at);")
        conn.commit()
    runs.RunIndex(db)
    with contextlib.closing(sqlite3.connect(db)) as conn:
        assert "run_index_ended" in {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}


# ---- rooms ---------------------------------------------------------------------------------------------------------------------------
def make_rooms(db):
    conn = rooms.connect(db)
    conn.executemany("INSERT INTO rooms_meta (room_id, goal, owner, coordinator, created_by, created_at) VALUES (?,?,?,?,?,?)",
                     [("r1", "ship it", "ceo", "vendas", "ceo", 1.0), ("r2", None, "ceo", None, "ceo", 2.0)])
    conn.commit()
    conn.close()
    conn = handoffs.connect(db)
    rows = [(f"h{i}", "a", "b", f"t{i}", "sha", "r1", "room", "allow", state, 0, float(i), "x")
            for i, state in enumerate(["open", "running", "needs_review", "completed", "cancelled", "open"])]
    rows += [("hx", "a", "b", "tx", "sha", "r2", "room", "allow", "completed", 0, 1.0, "x"), ("hy", "a", "b", "ty", "sha", None, "kanban", "allow", "open", 0, 1.0, "x")]
    conn.executemany("INSERT INTO handoffs (id, from_bot, to_bot, task_id, title_sha, room_id, source, effect, state, needs_review, created_at, actor) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    conn.commit()
    conn.close()


def test_the_metas_of_many_rooms_come_in_one_query_and_an_unknown_room_is_empty(tmp_path):
    db = tmp_path / "luvebot.db"
    make_rooms(db)
    got = rooms.metas(db, ["r1", "r2", "nope", "r1", 5, None])
    assert got == {"r1": {"goal": "ship it", "owner": "ceo", "coordinator": "vendas"}, "r2": {"goal": None, "owner": "ceo", "coordinator": None},
                   "nope": {"goal": None, "owner": None, "coordinator": None}}
    assert all(got[i] == rooms.get_meta(db, i) for i in got)                                  # the same as asking one at a time
    assert rooms.metas(db, []) == {}


def test_the_open_handoffs_of_many_rooms_come_in_one_query(tmp_path):
    db = tmp_path / "luvebot.db"
    make_rooms(db)
    assert handoffs.open_counts(db, ["r1", "r2", "none"]) == {"r1": 4, "r2": 0, "none": 0}   # open x2, running, needs_review; completed and cancelled do not count
    assert handoffs.open_counts(db, []) == {}
    old = len([r for r in handoffs.listing(db, room="r1", limit=100) if r["state"] in ("open", "running", "needs_review")])
    assert old == handoffs.open_counts(db, ["r1"])["r1"]                                      # what the list showed before, for a room of this size


def test_all_the_open_handoffs_of_a_room_count_not_only_the_newest_hundred_and_one(tmp_path):
    db = tmp_path / "luvebot.db"
    rooms.connect(db).close()
    conn = handoffs.connect(db)
    conn.executemany("INSERT INTO handoffs (id, from_bot, to_bot, task_id, title_sha, room_id, source, effect, state, needs_review, created_at, actor) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [(f"h{i}", "a", "b", f"t{i}", "s", "r1", "room", "allow", "open", 0, float(i), "x") for i in range(130)])
    conn.commit()
    conn.close()
    assert handoffs.open_counts(db, ["r1"])["r1"] == 130


def test_the_schema_of_rooms_and_handoffs_runs_once(tmp_path, monkeypatch):
    db = tmp_path / "luvebot.db"
    rooms.connect(db).close()
    handoffs.connect(db).close()
    seen = []
    real = sqlite3.connect

    def spy(*a, **k):
        conn = real(*a, **k)
        conn.set_trace_callback(seen.append)
        return conn
    monkeypatch.setattr(sqlite3, "connect", spy)
    rooms.connect(db).close()
    handoffs.connect(db).close()
    assert [s for s in seen if s.lstrip().upper().startswith("CREATE")] == []


# ---- mutations ----------------------------------------------------------------------------------------------------------------------------
def load(name, edits):
    path = BACKEND / f"{name}.py"
    source = path.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader(f"backend.{name}_under_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "backend"
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


def mutate_unread(monkeypatch, edits):
    monkeypatch.setattr(bot_controls, "unread", load("bot_controls", edits).unread)


MUTATIONS = {
    "a run that ended at the mark is unread": (lambda mp: mutate_unread(mp, [("last_status='completed' AND ended_at IS NOT NULL AND ended_at > ?", "last_status='completed' AND ended_at IS NOT NULL AND ended_at >= ?")]),
                                               test_a_run_that_ended_exactly_at_the_mark_is_not_unread_and_one_second_later_is),
    "the floor of the mark is whole seconds": (lambda mp: mutate_unread(mp, [("isoformat(timespec='microseconds').replace('+00:00', 'Z')", "strftime('%Y-%m-%dT%H:%M:%SZ')")]),
                                               test_a_run_that_ends_in_the_same_second_as_the_mark_but_after_it_is_unread),
    "the floor of the mark is whole seconds (real writer)": (lambda mp: mutate_unread(mp, [("isoformat(timespec='microseconds').replace('+00:00', 'Z')", "strftime('%Y-%m-%dT%H:%M:%SZ')")]),
                                                              test_the_run_index_writes_the_end_with_microseconds_the_count_compares_with),
    "the floor of the mark is one second late": (lambda mp: mutate_unread(mp, [("datetime.fromtimestamp(since, timezone.utc).isoformat", "datetime.fromtimestamp(since + 1, timezone.utc).isoformat")]),
                                                           test_a_run_that_ends_in_the_same_second_as_the_mark_but_after_it_is_unread),
    "runs that did not complete count": (lambda mp: mutate_unread(mp, [("last_status='completed' AND ended_at IS NOT NULL AND ended_at > ?", "ended_at IS NOT NULL AND ended_at > ?")]),
                                         test_unread_gives_the_old_answer_on_random_runs_and_marks),
    "another Bot's runs count": (lambda mp: mutate_unread(mp, [("WHERE bot=? AND last_status", "WHERE ? IS NOT NULL AND last_status")]),
                                 test_unread_gives_the_old_answer_on_random_runs_and_marks),
    "the mark is not read": (lambda mp: mutate_unread(mp, [("since = marks[0][0] if marks else 0.0", "since = 0.0")]),
                             test_unread_gives_the_old_answer_on_random_runs_and_marks),
    "only open handoffs of one state": (lambda mp: monkeypatch_open_states(mp), test_the_open_handoffs_of_many_rooms_come_in_one_query),
}


def monkeypatch_open_states(monkeypatch):
    monkeypatch.setattr(handoffs, "OPEN_STATES", ("open",))


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    apply, check = MUTATIONS[label]
    apply(monkeypatch)
    with pytest.raises(AssertionError):
        check(tmp_path)
