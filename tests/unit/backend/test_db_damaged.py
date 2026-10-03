"""A DAMAGED luvebot.db (SQLITE_CORRUPT "malformed" or SQLITE_NOTADB "not a database", by SQLite's result code) goes up as itself, so
SafeRoute answers luvebot_db_unavailable (dashboard/plugin_api.py) and the operator is told to check the database. It is never
dressed up as "audit unavailable" or "budget unavailable", which read as a passing lock. A locked or busy database
(OperationalError) and a trigger's refusal (IntegrityError) keep those answers. Real SQLite; each mutation drops one re-raise and must turn the test red.
"""
import importlib.util
from pathlib import Path
import sqlite3

import pytest

from backend import audit as audit_module, budget as budget_module
from backend.audit import AuditLog, AuditUnavailable
from backend.budget import Budget, BudgetUnavailable

MUTATIONS = {
    'audit_init': (audit_module, "            if dbfile.damaged(error):\n                raise  # a damaged luvebot.db says so"),
    'audit_append': (audit_module, "            if dbfile.damaged(error):\n                raise  # the file itself is damaged"),
    'budget_transaction': (budget_module, "            if dbfile.damaged(error):\n                raise  # a damaged luvebot.db: luvebot_db_unavailable (SafeRoute), never"),
    'budget_read': (budget_module, "        if dbfile.damaged(error):\n            raise  # a damaged luvebot.db: luvebot_db_unavailable (SafeRoute); the gates"),
}


def damage(db):
    """Page 1 after its 100-byte header (the schema) and the start of every other page: no table survives intact."""
    size, page = db.stat().st_size, 4096
    with open(db, 'r+b') as f:
        f.seek(100)
        f.write(b'\xff' * 64)
        for n in range(1, size // page):
            f.seek(page * n)
            f.write(b'\xff' * 64)


def fill(db):
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE filler (id INTEGER PRIMARY KEY, v TEXT)')
        conn.executemany('INSERT INTO filler (v) VALUES (?)', [(f'row {i} ' * 20,) for i in range(3000)])


def damaged_db(folder):
    db = folder / 'luvebot' / 'luvebot.db'
    Budget(db, audit=AuditLog(db))
    fill(db)
    damage(db)
    return db


def check(audit_mod, budget_mod, tmp_path):
    db = damaged_db(tmp_path)
    with pytest.raises(sqlite3.DatabaseError) as raised:
        audit_mod.AuditLog(db)
    assert not isinstance(raised.value, sqlite3.OperationalError)
    with pytest.raises(sqlite3.DatabaseError):
        budget_mod.is_paused(db, 'vendas')
    with pytest.raises(sqlite3.DatabaseError):
        budget_mod.has_limits(db)


def check_append(audit_mod, tmp_path):
    db = tmp_path / 'a' / 'luvebot.db'
    log = audit_mod.AuditLog(db)
    fill(db)
    damage(db)
    with pytest.raises(sqlite3.DatabaseError) as raised:          # an action on a damaged database: nothing runs, and it says why
        log.act('human', 'run.stop', 'run_1', {'kind': 'ui'}, lambda: pytest.fail('the effect ran'))
    assert not isinstance(raised.value, sqlite3.OperationalError)


def check_transaction(budget_mod, tmp_path):
    db = tmp_path / 'b' / 'luvebot.db'
    budget = budget_mod.Budget(db, audit=AuditLog(db))
    fill(db)
    damage(db)
    with pytest.raises(sqlite3.DatabaseError) as raised:
        with budget._transaction() as conn:
            conn.execute('SELECT * FROM budget_pauses').fetchall()
    assert not isinstance(raised.value, sqlite3.OperationalError)


def test_a_damaged_database_says_so(tmp_path):
    check(audit_module, budget_module, tmp_path)
    check_append(audit_module, tmp_path)
    check_transaction(budget_module, tmp_path)


def test_a_locked_database_keeps_its_answers(tmp_path):
    db = tmp_path / 'luvebot' / 'luvebot.db'
    log = AuditLog(db, timeout=0.05)
    budget = Budget(db, audit=log, timeout=0.05)
    hold = sqlite3.connect(db, isolation_level=None)
    hold.execute('BEGIN EXCLUSIVE')                                 # locked, not damaged
    try:
        with pytest.raises(AuditUnavailable):
            log.act('human', 'run.stop', 'run_1', {'kind': 'ui'}, lambda: None)
        with pytest.raises(BudgetUnavailable):
            with budget._transaction():
                pass
    finally:
        hold.execute('ROLLBACK')
        hold.close()


def mutant(module, anchor):
    source = Path(module.__file__).read_text()
    assert source.count(anchor) == 1, anchor
    head, tail = anchor.split('\n', 1)
    spec = importlib.util.spec_from_loader(module.__name__ + '_mutant', loader=None)
    copy = importlib.util.module_from_spec(spec)
    copy.__package__ = 'backend'
    exec(compile(source.replace(anchor, head.replace('dbfile.damaged(error)', 'False') + '\n' + tail), module.__file__, 'exec'),
         copy.__dict__)
    return copy


@pytest.mark.parametrize('name', sorted(MUTATIONS))
def test_each_mutation_is_caught(tmp_path, name):
    module, anchor = MUTATIONS[name]
    copy = mutant(module, anchor)
    run = {'audit_init': lambda: check(copy, budget_module, tmp_path), 'audit_append': lambda: check_append(copy, tmp_path),
           'budget_transaction': lambda: check_transaction(copy, tmp_path), 'budget_read': lambda: check(audit_module, copy, tmp_path)}
    try:
        run[name]()
    except BaseException:  # noqa: BLE001  (red: the mutant answered "unavailable" where the damage had to show)
        return
    pytest.fail(f'mutation survived: {name}')
