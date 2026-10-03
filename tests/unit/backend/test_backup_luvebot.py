"""scripts/backup_luvebot.py: the backup is a checked copy (never a damaged one), --check tells a sound backup from a bad one, and a
restore refuses a bad backup or a database in use and never leaves an old journal next to the restored file. Real SQLite,
the real script; each mutation must turn its test red.
"""
import importlib.util
import os
from pathlib import Path
import sqlite3
import stat

import pytest

from backend.audit import AuditLog

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts' / 'backup_luvebot.py'
MUTATIONS = {
    'backup keeps an unchecked copy': [("        ok, detail = check(partial)", "        ok, detail = True, 'ok'")],
    'restore never checks': [("    ok, detail = check(backup_file)\n", "    ok, detail = True, 'ok'\n"),
                             ("    ok, detail = check(incoming)\n", "    ok, detail = True, 'ok'\n")],
    'restore leaves the old side files': [("SIDE_FILES = ('-journal', '-wal', '-shm')", "SIDE_FILES = ()")],
}


def load(edits=()):
    source = SCRIPT.read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader('backup_luvebot_under_test', loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source, str(SCRIPT), 'exec'), module.__dict__)
    return module


def live_db(folder, rows=3000):
    db = folder / 'luvebot' / 'luvebot.db'
    AuditLog(db)                                              # the real schema, as the dashboard makes it
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, v TEXT)')
        conn.executemany('INSERT INTO filler (v) VALUES (?)', [(f'row {i} ' * 20,) for i in range(rows)])
    return db


def damage(path):
    """A page overwritten in the middle of the file: what a half-written page looks like."""
    size, page = path.stat().st_size, 4096
    with open(path, 'r+b') as f:
        f.seek(page * (size // page // 2))
        f.write(b'\xff' * 200)


def rows(path):
    return sqlite3.connect(path).execute('SELECT COUNT(*) FROM filler').fetchone()[0]


def inv_backup_is_checked(m, tmp):
    db = live_db(tmp)
    dest = tmp / 'backups'
    hold = sqlite3.connect(db, isolation_level=None)          # a writer is mid-transaction: the copy is the committed state
    hold.execute('BEGIN IMMEDIATE')
    hold.execute("INSERT INTO filler (v) VALUES ('uncommitted')")
    try:
        assert m.main(['--db', str(db), '--dest', str(dest)]) == 0
    finally:
        hold.execute('ROLLBACK')
        hold.close()
    [copy] = list(dest.iterdir())
    assert copy.name.startswith('luvebot-') and copy.suffix == '.db'
    assert stat.S_IMODE(copy.stat().st_mode) == 0o600 and stat.S_IMODE(dest.stat().st_mode) == 0o700
    assert m.check(copy) == (True, 'ok') and rows(copy) == 3000
    damage(db)                                                # a damaged database: no backup is kept, and it says so
    assert m.main(['--db', str(db), '--dest', str(dest)]) == 2
    assert list(dest.iterdir()) == [copy]                     # no new file, no .partial left behind


def inv_check_tells_good_from_bad(m, tmp):
    db = live_db(tmp)
    assert m.main(['--check', str(db)]) == 0
    other = tmp / 'other.db'
    sqlite3.connect(other).execute('CREATE TABLE t (x)').connection.commit()
    text = tmp / 'notes.txt'
    text.write_text('not a database')
    os.symlink(db, tmp / 'link.db')
    damaged = tmp / 'damaged.db'
    damaged.write_bytes(db.read_bytes())
    damage(damaged)
    for bad in (other, text, tmp / 'link.db', damaged, tmp / 'missing.db'):
        assert m.main(['--check', str(bad)]) == 2, bad


def inv_restore_refuses_a_bad_backup(m, tmp):
    db = live_db(tmp, rows=10)
    before = db.read_bytes()
    bad = tmp / 'bad.db'
    bad.write_bytes(live_db(tmp / 'b').read_bytes())
    damage(bad)
    assert m.main(['--restore', str(bad), '--db', str(db)]) == 2
    assert db.read_bytes() == before and sorted(p.name for p in db.parent.iterdir()) == ['luvebot.db']


def inv_restore_puts_a_good_backup_in_place(m, tmp):
    db = live_db(tmp, rows=10)
    good = live_db(tmp / 'good', rows=3000)
    hold = sqlite3.connect(db, isolation_level=None)          # still in use: refused, nothing moved
    hold.execute('BEGIN IMMEDIATE')
    try:
        assert m.main(['--restore', str(good), '--db', str(db)]) == 3
    finally:
        hold.execute('ROLLBACK')
        hold.close()
    assert rows(db) == 10 and sorted(p.name for p in db.parent.iterdir()) == ['luvebot.db']
    # leftovers of the broken database. SQLite drops stale ones itself when the in-use check opens the file; what is still there
    # at the swap (a file appearing after that check) must go aside with the old database, never stay next to the restored one
    m.in_use = lambda _db: False
    for suffix in ('-journal', '-wal', '-shm'):
        Path(str(db) + suffix).write_bytes(b'stale')
    assert m.main(['--restore', str(good), '--db', str(db)]) == 0
    assert rows(db) == 3000 and m.check(db) == (True, 'ok') and stat.S_IMODE(db.stat().st_mode) == 0o600
    names = sorted(p.name for p in db.parent.iterdir())
    assert not any(n in names for n in ('luvebot.db-journal', 'luvebot.db-wal', 'luvebot.db-shm')), names
    aside = {n.split('.before-restore-')[0] for n in names if '.before-restore-' in n}
    assert aside == {'luvebot.db', 'luvebot.db-journal', 'luvebot.db-wal', 'luvebot.db-shm'}, names   # all kept aside, together


INVARIANTS = {name[4:]: fn for name, fn in dict(globals()).items() if name.startswith('inv_')}
RED = {'backup keeps an unchecked copy': 'backup_is_checked', 'restore never checks': 'restore_refuses_a_bad_backup',
       'restore leaves the old side files': 'restore_puts_a_good_backup_in_place'}


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds(tmp_path, name):
    INVARIANTS[name](load(), tmp_path)


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_turns_its_invariant_red(tmp_path, label):
    with pytest.raises(AssertionError):
        INVARIANTS[RED[label]](load(MUTATIONS[label]), tmp_path)
