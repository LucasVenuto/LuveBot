"""luvebot.db corruption (docs/bugs/luvebot-db-corrupcao.md, Lume's reproduction): our connect helpers must never drop SQLite's
POSIX locks. A process holds BEGIN IMMEDIATE; after it runs each helper (backend/dbfile.py prepare, hook_store.connect, AuditLog),
ANOTHER process must still get "database is locked". Closing any descriptor of the file in the holder would hand that process
the write lock in the middle of our transaction.

Mutation (test_the_mutation_is_caught): the os.open + os.close of the old helpers put back into prepare -> the other process gets
the write lock: red. A short stress (3 processes x 3 writers + a thread looping on our real helpers) must end integrity "ok".
No harness: real SQLite, real processes, well under a minute.
"""
import importlib.util
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import time

import pytest

from backend import dbfile, hook_store
from backend.audit import AuditLog

REPO = Path(__file__).resolve().parents[3]
CHILD = """
import sqlite3, sys
c = sqlite3.connect(sys.argv[1], timeout=0, isolation_level=None)
try:
    c.execute("BEGIN IMMEDIATE")
    c.execute("ROLLBACK")
    print("GOT_WRITE_LOCK")
except sqlite3.OperationalError:
    print("LOCKED")
"""
HELPERS = {
    'dbfile.prepare': lambda db: dbfile.prepare(db),
    'hook_store.connect': lambda db: hook_store.connect(db).close(),
    'AuditLog': lambda db: AuditLog(db, timeout=0.05),
}
MUTANT_OLD = "    if stat.S_IMODE(st.st_mode) != 0o600:\n        os.chmod(path, 0o600)"
MUTANT_NEW = "    os.close(os.open(path, os.O_RDWR | os.O_NOFOLLOW))  # the old helpers' check\n" + MUTANT_OLD


def other_process(db):
    return subprocess.run([sys.executable, '-c', CHILD, str(db)], capture_output=True, text=True, timeout=30).stdout.strip()


def after_helper(db, helper):
    """What another process sees after THIS process, holding the write lock, ran `helper`."""
    hold = sqlite3.connect(db, isolation_level=None)
    try:
        hold.execute('BEGIN IMMEDIATE')
        hold.execute('INSERT INTO t VALUES (1)')
        assert other_process(db) == 'LOCKED'         # the baseline: our transaction holds the file
        try:
            helper(db)
        except Exception:  # noqa: BLE001  (succeeding or failing on the lock both fine: what counts is the other process)
            pass
        return other_process(db)
    finally:
        hold.execute('ROLLBACK')
        hold.close()


@pytest.fixture
def db(tmp_path):
    path = tmp_path / 'luvebot' / 'luvebot.db'
    hook_store.connect(path).close()
    AuditLog(path)                                    # schemas in place before the lock is taken
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS t(x)')
    return path


@pytest.mark.parametrize('name', sorted(HELPERS))
def test_our_connect_helpers_never_drop_sqlite_locks(db, name):
    assert after_helper(db, HELPERS[name]) == 'LOCKED', f'{name} dropped the lock of a transaction in this process'


def mutant():
    source = Path(dbfile.__file__).read_text()
    assert source.count(MUTANT_OLD) == 1
    spec = importlib.util.spec_from_loader('dbfile_mutant', loader=None)
    module = importlib.util.module_from_spec(spec)
    exec(compile(source.replace(MUTANT_OLD, MUTANT_NEW), 'dbfile_mutant', 'exec'), module.__dict__)
    return module


def test_the_mutation_is_caught(db, monkeypatch):
    monkeypatch.setattr(dbfile, 'prepare', mutant().prepare)
    for name in sorted(HELPERS):
        assert after_helper(db, HELPERS[name]) == 'GOT_WRITE_LOCK', f'mutation survived through {name}'


def test_prepare_keeps_the_file_safe_without_opening_it(tmp_path):
    fresh = tmp_path / 'new' / 'luvebot.db'
    dbfile.prepare(fresh, fix_dir_mode=True)
    assert stat.S_IMODE(fresh.stat().st_mode) == 0o600 and stat.S_IMODE(fresh.parent.stat().st_mode) == 0o700
    loose = tmp_path / 'new' / 'loose.db'
    loose.write_bytes(b'')
    os.chmod(loose, 0o644)
    dbfile.prepare(loose)
    assert stat.S_IMODE(loose.stat().st_mode) == 0o600
    target = tmp_path / 'elsewhere.db'
    target.write_bytes(b'')
    os.symlink(target, tmp_path / 'new' / 'link.db')
    os.mkfifo(tmp_path / 'new' / 'fifo.db')
    os.symlink(tmp_path / 'new', tmp_path / 'linked-dir')
    for bad in (tmp_path / 'new' / 'link.db', tmp_path / 'new' / 'fifo.db', tmp_path / 'linked-dir' / 'luvebot.db'):
        with pytest.raises(OSError):
            dbfile.prepare(bad)


STRESS = """
import os, random, sqlite3, sys, threading, time
sys.path.insert(0, sys.argv[1])
from backend import hook_store
from backend.audit import AuditLog
db, stop_at, seed = sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
seen = []
def writer(n):
    rnd = random.Random(seed + n)
    while time.time() < stop_at:
        try:
            c = sqlite3.connect(db, timeout=5)
            c.execute("BEGIN IMMEDIATE")
            for _ in range(20):
                c.execute("INSERT OR REPLACE INTO s(id, v) VALUES (?, ?)", (rnd.randrange(400), os.urandom(rnd.randrange(500, 6000))))
            c.execute("DELETE FROM s WHERE id % 7 = ?", (rnd.randrange(7),))
            c.commit(); c.close()
        except sqlite3.DatabaseError as e:
            if "malformed" in str(e) or "not a database" in str(e):
                seen.append(str(e)); return
def helpers():   # what the dashboard and the gateway do on every request and heartbeat
    while time.time() < stop_at:
        try:
            hook_store.connect(db).close()
            AuditLog(db, timeout=5)
        except Exception as e:
            if "malformed" in str(e):
                seen.append(str(e)); return
threads = [threading.Thread(target=writer, args=(n,)) for n in range(3)] + [threading.Thread(target=helpers)]
[t.start() for t in threads]; [t.join() for t in threads]
print("MALFORMED" if seen else "CLEAN")
"""


def test_a_short_stress_with_our_real_helpers_stays_intact(tmp_path):
    db = tmp_path / 'luvebot' / 'luvebot.db'
    hook_store.connect(db).close()
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS s(id INTEGER PRIMARY KEY, v BLOB)')
    stop_at = time.time() + 6
    procs = [subprocess.Popen([sys.executable, '-c', STRESS, str(REPO), str(db), str(stop_at), str(n * 10)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for n in range(3)]
    outputs = [p.communicate(timeout=120) for p in procs]
    assert all(out.strip().endswith('CLEAN') for out, _err in outputs), outputs
    assert sqlite3.connect(db).execute('PRAGMA integrity_check').fetchall() == [('ok',)]
