"""Two watchers (two processes) on one luvebot.db must never count the same stretch of a session twice (threat-model section 8, item 22). The cursor read, the delta, the spend and
the cursor write are ONE BEGIN IMMEDIATE (`Budget.record_session_spend`): the delta is the snapshot minus the cursor read INSIDE, a delta <= 0 is skipped, the cursor never goes back.
The race is replayed by letting the other watcher's whole pass slip in just before the first transaction of this one (after its own look at the cursor): in either order of snapshots the
total must be the real spend (150 cents). Mutations of budget.py and cost_watcher.py are red."""
from contextlib import contextmanager
import importlib
import importlib.util
import itertools
from pathlib import Path
import sqlite3
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()


def load(edits=()):
    name = f'cc_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    for which, old, new in edits:
        source = (BACKEND / f'{which}.py').read_text()
        assert source.count(old) == 1, old
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{which}', loader=None))
        module.__package__ = name
        sys.modules[f'{name}.{which}'] = module
        exec(compile(source.replace(old, new), str(BACKEND / f'{which}.py'), 'exec'), module.__dict__)
    return {m: importlib.import_module(f'{name}.{m}') for m in ('budget', 'cost_watcher', 'audit')}


def session(cents):
    return [{'id': 'sess_one', 'actual_usd': cents / 100}]


def total(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT COALESCE(SUM(cents), 0) FROM budget_spend").fetchone()[0], conn.execute("SELECT cents FROM budget_cost_cursor").fetchone()[0]
    finally:
        conn.close()


def slip_in_before_the_first_transaction(budget, other_pass):
    """The other watcher finishes its whole pass after THIS one looked at the cursor and before its first transaction begins."""
    real, state = budget._transaction, {'done': False}

    @contextmanager
    def transaction():
        if not state['done']:
            state['done'] = True
            other_pass()
        with real() as conn:
            yield conn
    budget._transaction = transaction


def interleaved(m, tmp_path, mine, theirs):
    path = tmp_path / 'luvebot.db'
    audit = m['audit'].AuditLog(path)
    first, second = m['budget'].Budget(path, audit=audit), m['budget'].Budget(path, audit=audit)
    other = lambda: m['cost_watcher'].run_pass(second, ['vendas'], lambda bot: session(theirs))  # noqa: E731
    slip_in_before_the_first_transaction(first, other)
    m['cost_watcher'].run_pass(first, ['vendas'], lambda bot: session(mine))
    return total(path)


def checks(m, tmp_path):
    assert interleaved(m, tmp_path / 'a', mine=150, theirs=100) == (150, 150)  # the newer snapshot looked first, the older one was counted before it: only the difference is added
    assert interleaved(m, tmp_path / 'b', mine=100, theirs=150) == (150, 150)  # the older snapshot looked first, the newer one counted before it: nothing is added, the cursor stays
    path = tmp_path / 'c' / 'luvebot.db'
    audit = m['audit'].AuditLog(path)
    budget = m['budget'].Budget(path, audit=audit)
    for cents, expect, recorded in ((100, (100, 100), 100), (100, (100, 100), 0), (60, (100, 100), 0), (130, (130, 130), 30)):   # a replay adds nothing; a cost that went down is never refunded
        result = m['cost_watcher'].run_pass(budget, ['vendas'], lambda bot, c=cents: session(c))
        assert total(path) == expect and result['recorded_cents'] == recorded, cents
    conn = sqlite3.connect(path)
    asked = conn.execute("SELECT COUNT(*) FROM audit_log WHERE action='budget.spend' AND detail='intent'").fetchone()[0]
    conn.close()
    assert asked == 2                                                                                 # only the two passes that had something new reached the Budget (and its audit)


@pytest.fixture(autouse=True)
def quiet(tmp_path):
    for sub in 'abc':
        (tmp_path / sub).mkdir()


def test_two_watchers_count_a_session_once(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ('budget', "                seen = conn.execute(\"SELECT cents FROM budget_cost_cursor WHERE session_id=?\", (session_id,)).fetchone()\n                delta = cumulative - (seen[0] if seen else 0)\n",
     "                seen = None\n                delta = cumulative\n"),
    ('budget', "                if delta <= 0:\n                    return None\n", "                if False:\n                    return None\n"),
    ('budget', "                    counted = delta\n", "                    counted = cumulative\n"),
    ('cost_watcher', "                if cumulative - (seen[0] if seen else 0) <= 0:\n                    continue", "                if False:\n                    continue"),
], ids=['cursor_not_read_inside', 'no_skip_on_delta_zero', 'whole_cumulative_counted', 'no_look_at_the_cursor'])
def test_each_mutation_is_caught(tmp_path, edit):
    with pytest.raises(Exception):  # noqa: B017
        checks(load([edit]), tmp_path)


def test_a_cursor_read_before_the_transaction_loses_the_race(tmp_path):
    """The mutation the Architect asked for: the cursor is read OUTSIDE the transaction (before BEGIN IMMEDIATE), as the old pass did."""
    old = "        def record():\n            with self._transaction() as conn:\n                seen = conn.execute(\"SELECT cents FROM budget_cost_cursor WHERE session_id=?\", (session_id,)).fetchone()\n"
    new = ("        def record():\n            early = self._connect()\n            seen_early = early.execute(\"SELECT cents FROM budget_cost_cursor WHERE session_id=?\", (session_id,)).fetchone()\n            early.close()\n"
           "            with self._transaction() as conn:\n                seen = seen_early\n")
    source = (BACKEND / 'budget.py').read_text()
    assert source.count(old) == 2 or source.count(old) == 1
    with pytest.raises(Exception):  # noqa: B017
        checks(load([('budget', old, new)]), tmp_path)
