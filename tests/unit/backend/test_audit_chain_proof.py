"""Perf item 1: GET /health no longer hashes the whole audit log on every call (measured 170 ms at 20 000 rows, 1.1 s at 100 000, holding a
read lock that made every writer wait 205 to 815 ms). It checks the rows added since the last proof; the full pass from row 1 runs on the
first call, after a break, and from the background watcher every FULL_EVERY seconds.

Pinned here, against real SQLite:
* a call after a proof hashes only the new rows (counted through `_hash`), and a call with none hashes nothing;
* a new row that does not verify is found at once, and the alarm does not clear: after a break every call walks the whole chain again;
* an edit of a row BEFORE the proof is found by the full pass (the watcher, when due), not by the cheap call: the stated ceiling;
* a proven row that changed or is gone starts over from the first row (a deleted tail is a break through the sequence check);
* `verify()` and `page()` keep their answers (no new key); mutations of the code that does this are red.
Review R-14 (Prumo): the lock covers the whole walk (a result computed before a break cannot hide it), `full_at()` says the age of the last
full pass, and a call does the full pass itself when the watcher is more than 2 x FULL_EVERY late.
"""
import importlib.util
from pathlib import Path
import sqlite3
import threading
import time

import pytest

import backend.audit as audit_module
from backend.audit import AuditLog, ChainProof

SOURCE = Path(audit_module.__file__)


def make(tmp_path, count):
    log = AuditLog(tmp_path / "private" / "luvebot.db")
    add(log, count)
    return log


def add(log, count):
    for _ in range(count):
        log.act("human", "run.stop", "run_1", {"kind": "ui", "ref": "req_1"}, lambda: None, bot="vendas")


def tamper(log, sql, *args, drop=("audit_no_update",)):
    with sqlite3.connect(log.path) as conn:
        for trigger in drop:
            conn.execute(f"DROP TRIGGER {trigger}")
        conn.execute(sql, args)


def counting(monkeypatch):
    module = audit_module                                                      # looked up now: a mutation swaps it
    calls = []
    real = module._hash
    monkeypatch.setattr(module, "_hash", lambda row: calls.append(row["id"]) or real(row))
    return calls


def clock():
    now = [0.0]
    return now, lambda: now[0]


def test_the_first_call_walks_everything_and_an_empty_log_is_ok(tmp_path, monkeypatch):
    log = make(tmp_path, 0)
    assert ChainProof().check(log) == {"ok": True, "rows": 0, "first_break": None}
    add(log, 12)
    calls = counting(monkeypatch)
    assert ChainProof().check(log) == {"ok": True, "rows": 24, "first_break": None}       # act() writes an intent and a result row
    assert len(calls) == 24


def test_a_call_after_a_proof_hashes_only_the_new_rows(tmp_path, monkeypatch):
    log, proof = make(tmp_path, 15), ChainProof()
    proof.check(log)
    calls = counting(monkeypatch)
    assert proof.check(log) == {"ok": True, "rows": 30, "first_break": None}
    assert calls == []                                                          # nothing new: nothing hashed
    add(log, 3)
    calls.clear()                                                               # writing a row hashes it too: count only the check
    assert proof.check(log) == {"ok": True, "rows": 36, "first_break": None}
    assert calls == [31, 32, 33, 34, 35, 36]                                    # only what was added, in order


def test_a_new_row_that_does_not_verify_is_found_at_once_and_the_alarm_stays(tmp_path, monkeypatch):
    log, proof = make(tmp_path, 10), ChainProof()
    proof.check(log)
    add(log, 2)
    tamper(log, "UPDATE audit_log SET target='edited' WHERE id=22")
    first = proof.check(log)
    assert first["ok"] is False and first["first_break"] == 22
    calls = counting(monkeypatch)
    again = proof.check(log)                                                    # after a break there is no proof to start from
    assert again["ok"] is False and again["first_break"] == 22
    assert calls[0] == 1 and calls[-1] == 22                                    # the whole chain again, up to the break


def test_an_edit_before_the_proof_is_found_by_the_full_pass_not_by_the_cheap_call(tmp_path):
    now, tick = clock()
    log, proof = make(tmp_path, 10), ChainProof(tick)
    assert proof.check(log)["ok"] is True
    tamper(log, "UPDATE audit_log SET target='edited' WHERE id=5")
    add(log, 1)
    assert proof.check(log)["ok"] is True                                       # the stated ceiling: an old row is the full pass's
    assert proof.due() is False
    proof.watch(log)                                                            # not due: the watcher does nothing
    assert proof.check(log)["ok"] is True
    now[0] += ChainProof.FULL_EVERY + 1
    assert proof.due() is True
    proof.watch(log)                                                            # due: the full pass finds it
    assert proof.check(log) == {"ok": False, "rows": 5, "first_break": 5}
    assert proof.due() is False


def test_the_watcher_runs_the_full_pass_from_the_first_row(tmp_path, monkeypatch):
    now, tick = clock()
    log, proof = make(tmp_path, 10), ChainProof(tick)
    assert proof.due() is True                                                  # never ran: due
    calls = counting(monkeypatch)
    proof.watch(log)
    assert len(calls) == 20 and proof.due() is False
    calls.clear()
    proof.watch(log)
    assert calls == []
    now[0] += ChainProof.FULL_EVERY + 1
    proof.watch(log)
    assert len(calls) == 20


def test_a_proven_row_that_changed_or_is_gone_starts_over(tmp_path):
    log, proof = make(tmp_path, 10), ChainProof()
    proof.check(log)
    tamper(log, "UPDATE audit_log SET hash=? WHERE id=20", "0" * 64)            # the row the proof stands on
    assert proof.check(log) == {"ok": False, "rows": 20, "first_break": 20}
    log = make(tmp_path / "second", 10)
    proof = ChainProof()
    proof.check(log)
    tamper(log, "DELETE FROM audit_log WHERE id>=19", drop=("audit_no_delete",))   # the tail, with the proven row
    got = proof.check(log)
    assert got["ok"] is False and got["first_break"] == 19


def test_the_lock_covers_the_whole_walk_so_an_old_result_cannot_hide_a_break(tmp_path, monkeypatch):
    """A starts a walk and stalls; B (a call that sees a break) must wait for A, never finish first and then be overwritten by A's result.
    Nothing here waits a FIXED time (a thread that starves on a loaded machine would pass for "still waiting" with no lock at all): B's wait is SEEN (it finds the lock taken), or its walk is
    SEEN (it did not wait); the order is read from when each WALK ended, not from which thread got to append first."""
    log, proof = make(tmp_path, 5), ChainProof()
    proof.check(log)
    started, release, contended, walked, results = threading.Event(), threading.Event(), threading.Event(), [], {}
    real = AuditLog.verify_from

    class Spy:
        """The proof's own lock, which says when someone finds it taken."""
        def __init__(self, inner):
            self.inner = inner

        def __enter__(self):
            if not self.inner.acquire(blocking=False):
                contended.set()
                self.inner.acquire()
            return self

        def __exit__(self, *exc):
            self.inner.release()

    def walk(self, tip):
        name = threading.current_thread().name
        out = real(self, tip)
        if name == "a":
            started.set()
            release.wait(60)                                                    # a net so a broken test cannot hang; the test releases it by condition
        walked.append(name)                                                     # when this walk ENDED
        return out
    proof._lock = Spy(proof._lock)
    monkeypatch.setattr(AuditLog, "verify_from", walk)
    a = threading.Thread(name="a", target=lambda: results.update(a=proof.check(log)), daemon=True)
    b = threading.Thread(name="b", target=lambda: results.update(b=proof.check(log)), daemon=True)
    try:
        a.start()
        assert started.wait(60)
        b.start()
        deadline = time.monotonic() + 60
        while not (contended.is_set() or "b" in walked) and time.monotonic() < deadline:
            time.sleep(0.005)                                                   # until B either queues behind A's lock or walks at once: a condition, not a duration
        assert contended.is_set() and walked == []                              # B waits for A's whole walk
    finally:
        release.set()                                                           # a failing check must not leave A parked (the mutation makes it fail here, on purpose)
    a.join(60)
    b.join(60)
    assert not a.is_alive() and not b.is_alive()
    assert walked == ["a", "b"] and results["a"]["ok"] and results["b"]["ok"]


def test_a_break_found_after_a_slow_ok_walk_is_not_overwritten(tmp_path):
    """The order the lock makes impossible to get wrong: ok, then tamper, then the break; the tip stays None until a full pass is clean."""
    log, proof = make(tmp_path, 5), ChainProof()
    assert proof.check(log)["ok"] is True
    add(log, 1)
    tamper(log, "UPDATE audit_log SET target='edited' WHERE id=11")
    assert proof.check(log)["ok"] is False
    assert proof.check(log)["ok"] is False                                      # still false: the break was not erased by anything older


def test_full_at_says_when_the_last_full_pass_ended(tmp_path):
    now, tick = clock()
    wall = [1000.0]
    log, proof = make(tmp_path, 3), ChainProof(tick, lambda: wall[0])
    assert proof.full_at() is None
    proof.check(log)
    assert proof.full_at() == 1000.0
    wall[0] = 1500.0
    proof.check(log)                                                            # a cheap call is not a full pass
    assert proof.full_at() == 1000.0
    proof.check(log, full=True)
    assert proof.full_at() == 1500.0


def test_a_call_does_the_full_pass_itself_when_the_watcher_is_more_than_twice_late(tmp_path, monkeypatch):
    now, tick = clock()
    log, proof = make(tmp_path, 10), ChainProof(tick)
    proof.check(log)
    tamper(log, "UPDATE audit_log SET target='edited' WHERE id=5")
    now[0] += 2 * ChainProof.FULL_EVERY - 1                                     # late, but not twice late: the cheap call
    assert proof.check(log)["ok"] is True
    now[0] += 2                                                                 # the watcher is dead: the call walks everything
    assert proof.check(log) == {"ok": False, "rows": 5, "first_break": 5}


def test_verify_and_page_keep_their_answers(tmp_path):
    log = make(tmp_path, 4)
    assert log.verify() == {"ok": True, "rows": 8, "first_break": None}
    assert set(log.page()["chain"]) == {"ok", "checked_through", "first_break"}
    assert log.page()["chain"]["checked_through"] == 8
    result, tip = log.verify_from(None)
    assert result == log.verify() and tip[0] == 8 and len(tip[1]) == 64


# ---- mutations of the code under test: each must turn a test above red --------------------------------------------------------
def load(edits):
    source = SOURCE.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader("backend.audit_under_test", loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__package__ = "backend"                                              # for `from . import dbfile`
    exec(compile(source, str(SOURCE), "exec"), module.__dict__)
    return module


MUTATIONS = {
    "the proof is never used (the whole log every call)": (
        [("            tip = None if full else self._tip\n", "            tip = None\n")], test_a_call_after_a_proof_hashes_only_the_new_rows),
    "a changed proven row is trusted": (
        [("                if row is None or row[0] != proven[1]:\n", "                if row is None:\n")], test_a_proven_row_that_changed_or_is_gone_starts_over),
    "the full pass is never due": (
        [("        return self._full_at is None or self._clock() - self._full_at > self.FULL_EVERY\n", "        return False\n")],
        test_an_edit_before_the_proof_is_found_by_the_full_pass_not_by_the_cheap_call),
    "a break keeps the proof": (
        [("            result, self._tip = audit.verify_from(tip)   # None after a break: the next call walks the whole chain again\n",
          "            result, new = audit.verify_from(tip)\n            self._tip = new or tip\n")],
        test_a_new_row_that_does_not_verify_is_found_at_once_and_the_alarm_stays),
    "the lock does not cover the walk": (
        [("        with self._lock:  # the whole walk: no result computed before a break can overwrite it\n", "        with threading.Lock():\n")],
        test_the_lock_covers_the_whole_walk_so_an_old_result_cannot_hide_a_break),
    "a late watcher is never replaced": (
        [("            if self._full_at is not None and self._clock() - self._full_at > 2 * self.FULL_EVERY:\n                full = True\n", "")],
        test_a_call_does_the_full_pass_itself_when_the_watcher_is_more_than_twice_late),
    "full_at is never recorded": (
        [("                self._full_at, self._full_epoch = self._clock(), self._wall()\n", "                self._full_at = self._clock()\n")],
        test_full_at_says_when_the_last_full_pass_ended),
    "new rows are not checked": (
        [("        records = (conn.execute(\"SELECT * FROM audit_log WHERE id >= ? ORDER BY id\", (expected,)) if proven\n",
          "        records = (conn.execute(\"SELECT * FROM audit_log WHERE id < 0 ORDER BY id\", ()) if proven\n")],
        test_a_new_row_that_does_not_verify_is_found_at_once_and_the_alarm_stays),
}


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    edits, check = MUTATIONS[label]
    mutated = load(edits)
    monkeypatch.setattr(audit_module, "ChainProof", mutated.ChainProof)
    monkeypatch.setattr(audit_module, "AuditLog", mutated.AuditLog)
    monkeypatch.setitem(check.__globals__, "ChainProof", mutated.ChainProof)
    monkeypatch.setitem(check.__globals__, "AuditLog", mutated.AuditLog)
    monkeypatch.setitem(check.__globals__, "audit_module", mutated)
    with pytest.raises(AssertionError):
        check(tmp_path, monkeypatch) if "monkeypatch" in check.__code__.co_varnames[:check.__code__.co_argcount] else check(tmp_path)
