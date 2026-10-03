"""Invariant 7 fails closed (Lume's side finding, docs/bugs/luvebot-db-corrupcao.md): is_paused and has_limits (now in backend/budget.py,
re-exported by runs) used to
answer False on ANY SQLite error, so an unreadable luvebot.db read as "not paused" and "no cap", and the gates let work start.
Now a missing table still means "nothing paused / no cap" (a fresh database), and any other error raises BudgetUnavailable
(503 budget_unavailable). Real SQLite; mutation: the old `except sqlite3.Error: return False` back -> red.
"""
import importlib.util
import os
from pathlib import Path
import sqlite3

import pytest

from backend import budget
from backend.budget import BudgetUnavailable

OLD = """    except sqlite3.OperationalError as error:
        if str(error).startswith('no such table'):
            return False
        raise BudgetUnavailable() from None
    except sqlite3.Error as error:
        if dbfile.damaged(error):
            raise  # a damaged luvebot.db: luvebot_db_unavailable (SafeRoute); the gates refuse all the same
        raise BudgetUnavailable() from None"""
MUTANT = """    except sqlite3.Error:
        return False"""


def checks(module, tmp_path):
    fresh = tmp_path / 'fresh.db'
    sqlite3.connect(fresh).close()
    assert module.is_paused(fresh, 'vendas') is False and module.has_limits(fresh) is False          # no table yet: nothing set
    set_ = tmp_path / 'set.db'
    with sqlite3.connect(set_) as conn:
        conn.execute('CREATE TABLE budget_pauses (bot TEXT PRIMARY KEY)')
        conn.execute('CREATE TABLE budget_limits (scope TEXT, ref TEXT, period TEXT, cents INTEGER)')
        conn.execute("INSERT INTO budget_pauses VALUES ('vendas')")
        conn.execute("INSERT INTO budget_limits VALUES ('bot', 'vendas', 'day', 100)")
    assert module.is_paused(set_, 'vendas') is True and module.is_paused(set_, 'default') is False and module.has_limits(set_) is True
    garbage = tmp_path / 'garbage.db'
    garbage.write_bytes(b'this is not a database, a corrupt page or a half-copied backup' * 200)
    unreadable = tmp_path / 'unreadable.db'
    with sqlite3.connect(unreadable) as conn:
        conn.execute('CREATE TABLE budget_pauses (bot TEXT PRIMARY KEY)')
    os.chmod(unreadable, 0)
    try:
        for read in (lambda p: module.is_paused(p, 'vendas'), module.has_limits):
            for bad in (unreadable, tmp_path / 'missing' / 'luvebot.db'):      # cannot be read: the budget is unavailable
                with pytest.raises(BudgetUnavailable):
                    read(bad)
            with pytest.raises(sqlite3.DatabaseError) as damaged:                # a damaged file says so (luvebot_db_unavailable)
                read(garbage)
            assert not isinstance(damaged.value, sqlite3.OperationalError)
    finally:
        os.chmod(unreadable, 0o600)


@pytest.mark.skipif(os.geteuid() == 0, reason='root reads a mode-0 file')
def test_budget_reads_fail_closed(tmp_path):
    checks(budget, tmp_path)


@pytest.mark.skipif(os.geteuid() == 0, reason='root reads a mode-0 file')
def test_the_mutation_is_caught(tmp_path):
    source = Path(budget.__file__).read_text()
    assert source.count(OLD) == 1
    spec = importlib.util.spec_from_loader('backend.budget_mutant', loader=None)
    mutant = importlib.util.module_from_spec(spec)
    mutant.__package__ = 'backend'                      # its relative imports resolve to the real backend package
    exec(compile(source.replace(OLD, MUTANT), 'backend/budget_mutant.py', 'exec'), mutant.__dict__)
    with pytest.raises(pytest.fail.Exception):          # the mutant answers False where BudgetUnavailable is due
        checks(mutant, tmp_path)
