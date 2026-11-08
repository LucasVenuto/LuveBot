"""ADR-008: `luvebot.db` runs in WAL (readers and the writer stop blocking each other: an audit write waited 205 to 815 ms behind a /health
read, 4 to 8 ms in WAL), without ever failing because of it, and with what that asks of the code around it.

Pinned, against real SQLite:
* `dbfile.configure` turns the write-ahead log on ONCE per process and file, sets `journal_size_limit`, never raises, and a refusal leaves the
  rollback journal in place (honestly: `AuditLog.journal_mode()`, which GET /health shows, says which one runs);
* `AuditLog` AND `hook_store.connect` both do it (the gateway may open the file first), and the mode lives in the file, so the other process
  only reads it;
* `dbfile.prepare` checks and chmods `-wal`, `-shm` and `-journal` by path when they exist (a regular file, never a link) and never creates them;
* static guards over the sources: nothing opens, copies or reads the database or its side files (closing any descriptor of them in the process
  drops SQLite's locks: docs/bugs/luvebot-db-corrupcao.md), no plain `BEGIN` outside the listed read-only places (in WAL a plain BEGIN that reads
  and then writes fails at once, no timeout helps), and every `sqlite3.connect` carries a timeout (the 5 s busy timeout);
* mutations of the code that does this are red.
No timing test: it varies with the load (ADR-008 section 4.8)."""
import ast
import contextlib
import importlib.util
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys

import pytest

import backend.audit as audit_module
import backend.dbfile as dbfile
import backend.hook_store as hook_store
from backend.audit import AuditLog

REPO = Path(__file__).resolve().parents[3]
BACKEND = REPO / "backend"


def mode_of(path):
    with contextlib.closing(sqlite3.connect(path)) as conn:
        return conn.execute("PRAGMA journal_mode").fetchone()[0]


@pytest.fixture(autouse=True)
def fresh_modes():
    """Every test is 'a new process': the once-per-file memory is cleared before and after."""
    dbfile._MODES.clear()
    yield
    dbfile._MODES.clear()


def traced(path):
    seen = []
    conn = sqlite3.connect(path)
    conn.set_trace_callback(seen.append)
    return conn, seen


# ---- configure ---------------------------------------------------------------------------------------------------------------------
def test_a_new_file_is_turned_to_wal_and_the_health_mode_says_so(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    log = AuditLog(db)
    assert mode_of(db) == "wal" and log.journal_mode() == "wal"
    assert log.verify()["ok"] is True                                                        # and it works as before


def test_configure_runs_once_per_process_and_file(tmp_path):
    db = tmp_path / "a.db"
    conn, seen = traced(db)
    assert dbfile.configure(conn, db) == "wal"
    assert [s.lower() for s in seen] == ["pragma journal_mode", "pragma journal_mode=wal"]    # the size limit is per connection: `dbfile.connect`
    assert dbfile.WAL_LIMIT == 64 * 1024 * 1024
    seen.clear()
    assert dbfile.configure(conn, db) == "wal" and seen == []                                 # asked once: nothing sent the second time
    conn.close()
    other, seen2 = traced(tmp_path / "b.db")
    dbfile.configure(other, tmp_path / "b.db")
    assert seen2                                                                              # another file is its own first time
    other.close()


def test_the_gateway_opening_the_file_first_turns_wal_on_for_everyone(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    hook_store.connect(db).close()                                                            # the gateway's hook, before the dashboard exists
    assert mode_of(db) == "wal"
    dbfile._MODES.clear()                                                                     # the dashboard starts: it only finds it
    log = AuditLog(db)
    assert log.journal_mode() == "wal"


class Refusing:
    """A connection whose SQLite will not switch (a network disk, a switch refused by an open transaction): the PRAGMA answers the old mode."""

    def __init__(self, answer=("delete",), raises=False):
        self.answer, self.raises, self.seen = answer, raises, []

    def execute(self, sql):
        self.seen.append(sql)
        if self.raises and "journal_mode=WAL" in sql:
            raise sqlite3.OperationalError("database is locked")
        return types_row(self.answer)


class types_row:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


def test_a_refusal_leaves_the_rollback_journal_and_never_raises(tmp_path):
    conn = Refusing()
    assert dbfile.configure(conn, tmp_path / "x.db") == "delete"                              # honest: not wal
    assert dbfile.configure(Refusing(raises=True), tmp_path / "y.db") == "delete"             # an error on the switch: still the old mode it read, no exception
    assert dbfile.configure(Refusing(answer=None), tmp_path / "z.db") is None                 # a nonsense answer
    assert conn.seen[:2] == ["PRAGMA journal_mode", "PRAGMA journal_mode=WAL"]


def test_a_switch_refused_by_an_open_transaction_is_tried_again_on_the_next_start(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    db.parent.mkdir()
    with contextlib.closing(sqlite3.connect(db, isolation_level=None)) as first:              # a rollback-journal file, mid-transaction elsewhere
        first.execute("PRAGMA journal_mode=DELETE")
        first.execute("CREATE TABLE t (x)")
        first.execute("BEGIN IMMEDIATE")
        first.execute("INSERT INTO t VALUES (1)")
        with contextlib.closing(sqlite3.connect(db, timeout=0)) as second:
            assert dbfile.configure(second, db) in ("delete", None)                           # not wal, no exception
        first.execute("ROLLBACK")
    assert dbfile._MODES[str(db)] in ("delete", None)                                          # remembered for THIS process
    assert mode_of(db) == "delete"
    dbfile._MODES.clear()                                                                      # the next start
    AuditLog(db)
    assert mode_of(db) == "wal"


# ---- prepare: the side files ----------------------------------------------------------------------------------------------------------
def test_prepare_chmods_the_side_files_that_exist_and_never_creates_them(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    dbfile.prepare(db, fix_dir_mode=True)
    assert sorted(os.listdir(db.parent)) == ["luvebot.db"]                                    # none made
    for suffix in dbfile.SIDE_FILES:
        side = Path(str(db) + suffix)
        side.write_bytes(b"x")
        side.chmod(0o644)
    dbfile.prepare(db)
    for suffix in dbfile.SIDE_FILES:
        assert stat.S_IMODE(os.lstat(str(db) + suffix).st_mode) == 0o600, suffix
    assert sorted(os.listdir(db.parent)) == sorted(["luvebot.db", *[f"luvebot.db{s}" for s in dbfile.SIDE_FILES]])
    target = tmp_path / "elsewhere"
    target.write_bytes(b"x")
    target.chmod(0o644)
    for suffix in dbfile.SIDE_FILES:
        Path(str(db) + suffix).unlink()
        os.symlink(target, str(db) + suffix)                                                   # a link in place of a side file
        with pytest.raises(OSError):
            dbfile.prepare(db)
        assert stat.S_IMODE(target.stat().st_mode) == 0o644                                    # and its target was never chmod'ed
        os.unlink(str(db) + suffix)


def test_sqlites_own_side_files_are_born_0600_beside_a_0600_database(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    AuditLog(db)
    keep = sqlite3.connect(db)                                                                 # a live connection: -wal and -shm exist
    keep.execute("SELECT COUNT(*) FROM audit_log").fetchall()
    try:
        for suffix in ("-wal", "-shm"):
            assert stat.S_IMODE(os.lstat(str(db) + suffix).st_mode) == 0o600, suffix
        AuditLog(db)                                                                           # and prepare keeps them so
        for suffix in ("-wal", "-shm"):
            assert stat.S_IMODE(os.lstat(str(db) + suffix).st_mode) == 0o600
    finally:
        keep.close()


def test_two_processes_write_together_without_a_database_is_locked(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    AuditLog(db)
    child = ("import sys; sys.path.insert(0, %r)\n"
             "from backend import hook_store\n"
             "for i in range(30): hook_store.record_event(sys.argv[1], 'p', 'terminal', 'r', 'allow', 'm', None, None, 'c%%d' %% i, 'ls')\n"
             "print('done')\n") % str(REPO)
    procs = [subprocess.Popen([sys.executable, "-c", child, str(db)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
    log = AuditLog(db)
    for i in range(30):
        log.act("human", "run.stop", f"run_{i}", {"kind": "ui", "ref": "r"}, lambda: None, bot="vendas")
    outs = [p.communicate(timeout=60) for p in procs]
    assert all(out[0].strip() == "done" and "locked" not in out[1] for out in outs), outs
    assert log.verify()["ok"] is True and mode_of(db) == "wal"


# ---- static guards over the sources ---------------------------------------------------------------------------------------------------
OPEN_LIKE = {"open", "os.open", "shutil.copy", "shutil.copy2", "shutil.copyfile", "shutil.copyfileobj"}
DB_NAMES = re.compile(r"(?<![\w.])(path|db|db_path|dbpath)\b|self\.(path|db|db_path)\b")   # a name of ours, not `os.path` or `Path(`
SIDE_TEXT = ("-wal", "-shm", "-journal", ".db", "luvebot.db")


def database_touches(source, filename):
    """Calls in `source` that open, copy or read the database file or a side file (closing a descriptor of any of them in this process drops
    SQLite's locks: the cause of the 2026-10-03 incident). Only for modules that use sqlite3. The one allowed: dbfile.prepare's O_EXCL create."""
    tree = ast.parse(source)
    if "sqlite3" not in source:
        return []
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = ast.unparse(node.func)
        receiver = ast.unparse(node.func.value) if isinstance(node.func, ast.Attribute) else ""
        first = ast.unparse(node.args[0]) if node.args else ""
        method = node.func.attr if isinstance(node.func, ast.Attribute) else ""
        reads = method in ("read_bytes", "open", "write_bytes") and receiver != ""
        subject = first if (name in OPEN_LIKE or name.startswith("shutil.copy")) else receiver if reads else None
        if subject is None:
            continue
        text = ast.unparse(node)
        mentions = bool(DB_NAMES.search(subject)) or any(t in subject for t in SIDE_TEXT)
        if mentions and not (filename.endswith("dbfile.py") and "O_EXCL" in text and "O_CREAT" in text):
            found.append((filename, text[:80]))
    return found


def scanned_sources():
    """The tracked sources of the product (an untracked scratch file in the folder is not the product's). Without git, every file there is."""
    wanted = ["backend/*.py", "dashboard/plugin_api.py", "dashboard/plugin_entry.py", "hermes-plugin/__init__.py"]
    try:
        names = subprocess.run(["git", "ls-files", *wanted], cwd=REPO, capture_output=True, text=True, timeout=30, check=True).stdout.split()
    except Exception:  # noqa: BLE001
        names = [str(f.relative_to(REPO)) for f in [*sorted(BACKEND.glob("*.py")), REPO / "dashboard" / "plugin_api.py", REPO / "dashboard" / "plugin_entry.py",
                                                    REPO / "hermes-plugin" / "__init__.py"] if f.exists()]
    return [(name, (REPO / name).read_text()) for name in names if (REPO / name).exists()]


def test_nothing_opens_copies_or_reads_the_database_or_its_side_files():
    assert [t for name, src in scanned_sources() for t in database_touches(src, name)] == []


def test_the_scan_finds_what_it_is_for():
    for bad in ("import sqlite3\nimport os\nos.close(os.open(path, os.O_RDWR))",
                "import sqlite3\nimport shutil\nshutil.copy(db, other)",
                "import sqlite3\nfrom pathlib import Path\nPath(db_path).read_bytes()",
                "import sqlite3\nopen(str(db) + '-wal')",
                "import sqlite3\nimport os\nos.open(str(path) + '-shm', os.O_RDWR)",
                "import sqlite3\nimport os\nos.open('/x/luvebot.db-journal', os.O_RDONLY)"):
        assert database_touches(bad, "backend/x.py"), bad
    ok = "import sqlite3\nimport os\nos.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600))"
    assert database_touches(ok, "backend/dbfile.py") == [] and database_touches(ok, "backend/other.py")      # allowed only there
    assert database_touches("import os\nos.open(path, os.O_RDWR)", "backend/y.py") == []                       # not a module that uses sqlite3


PLAIN_BEGIN = {"backend/audit.py": 3, "backend/budget.py": 1}   # verify_from, verify, page; Budget._read: every one only READS


def plain_begins(source):
    return sum(1 for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Constant) and isinstance(node.value, str)
               and node.value.strip().upper() in ("BEGIN", "BEGIN DEFERRED", "BEGIN TRANSACTION"))


def test_a_plain_begin_exists_only_where_the_code_only_reads():
    got = {name: plain_begins(src) for name, src in scanned_sources() if plain_begins(src)}
    assert got == PLAIN_BEGIN, got
    assert plain_begins('c.execute("BEGIN")\nc.execute("BEGIN IMMEDIATE")') == 1                                  # the scan tells the two apart


def direct_connects(source, filename):
    """`sqlite3.connect(...)` calls that do not go through `dbfile.connect`: only dbfile itself and a read-only URI (`mode=ro`: it cannot checkpoint)."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and ast.unparse(node.func) == "sqlite3.connect" and not filename.endswith("backend/dbfile.py"):
            if "mode=ro" not in ast.unparse(node.args[0] if node.args else node):
                found.append((filename, node.lineno))
    return found


def test_every_connection_to_the_database_goes_through_dbfile_connect():
    """ADR-008 section 4.2: `journal_size_limit` must be set on EVERY connection, so no store may open its own."""
    assert [hit for name, src in scanned_sources() for hit in direct_connects(src, name)] == []
    assert direct_connects("import sqlite3\nsqlite3.connect(path, timeout=5)", "backend/x.py")                    # the scan finds a bare connect
    assert direct_connects("import sqlite3\nsqlite3.connect(f'file:{p}?mode=ro', uri=True)", "backend/x.py") == []   # a read-only one is allowed
    assert direct_connects("import sqlite3\nsqlite3.connect(path)", "backend/dbfile.py") == []


def test_every_sqlite_connection_carries_a_timeout():
    """The 5 s busy timeout of ADR-008 section 4.2 is `sqlite3.connect(..., timeout=5)`; a connection without one waits for nothing."""
    bare = []
    for name, src in scanned_sources():
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.Call) and ast.unparse(node.func) == "sqlite3.connect" and not any(k.arg == "timeout" for k in node.keywords):
                bare.append((name, node.lineno))
    assert bare == [], bare


# ---- mutations of the code under test ------------------------------------------------------------------------------------------------
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


def mutate(monkeypatch, name, edits):
    module = load(name, edits)
    if name == "dbfile":
        monkeypatch.setattr(dbfile, "configure", module.configure)
        monkeypatch.setattr(dbfile, "prepare", module.prepare)
    elif name == "audit":
        monkeypatch.setattr(audit_module, "AuditLog", module.AuditLog)
    elif name == "hook_store":
        monkeypatch.setattr(hook_store, "connect", module.connect)
    return module


def check_audit_wal(tmp_path):
    db = tmp_path / "luvebot" / "luvebot.db"
    log = audit_module.AuditLog(db)
    assert mode_of(db) == "wal" and log.journal_mode() == "wal"


MUTATIONS = {
    "WAL is never turned on": ("dbfile", [('        if mode != "wal":\n            mode = str(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]).lower()\n', "")],
                               lambda tp: check_audit_wal(tp)),
    "AuditLog does not configure": ("audit", [("                dbfile.configure(conn, self.path)        # the write-ahead log, once per process and file (ADR-008)\n", "")],
                                    lambda tp: check_audit_wal(tp)),
    "the gateway's connect does not configure": ("hook_store", [("    dbfile.configure(conn, path)                  # the write-ahead log, once per process and file: the gateway may open the file first (ADR-008)\n", "")],
                                                 lambda tp: test_the_gateway_opening_the_file_first_turns_wal_on_for_everyone(tp)),
    "prepare ignores the side files": ("dbfile", [("        if stat.S_IMODE(found.st_mode) != 0o600:\n            os.chmod(side, 0o600)\n", "        pass\n")],
                                       lambda tp: test_prepare_chmods_the_side_files_that_exist_and_never_creates_them(tp)),
    "prepare follows a side file link": ("dbfile", [('        if not stat.S_ISREG(found.st_mode):\n            raise OSError("unsafe database side file")\n', "")],
                                         lambda tp: test_prepare_chmods_the_side_files_that_exist_and_never_creates_them(tp)),
    "configure asks every time": ("dbfile", [("    if key in _MODES:\n        return _MODES[key]\n", "")],
                                  lambda tp: test_configure_runs_once_per_process_and_file(tp)),
    "a refusal raises": ("dbfile", [("    except Exception:  # noqa: BLE001  (a refusal, a locked file, an answer that makes no sense: the old journal stays, nothing raises)\n        pass\n", "    except Exception:  # noqa: BLE001\n        raise\n")],
                         lambda tp: test_a_refusal_leaves_the_rollback_journal_and_never_raises(tp)),
}


@pytest.mark.parametrize("label", sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, tmp_path, monkeypatch):
    name, edits, check = MUTATIONS[label]
    mutate(monkeypatch, name, edits)
    with pytest.raises((AssertionError, OSError, sqlite3.Error, pytest.fail.Exception)):
        check(tmp_path)


def test_a_scan_mutation_is_red(tmp_path):
    source = (BACKEND / "audit.py").read_text().replace("            dbfile.prepare(self.path, fix_dir_mode=True)", "            os.close(os.open(self.path, os.O_RDWR))\n            dbfile.prepare(self.path, fix_dir_mode=True)")
    assert database_touches(source, "backend/audit.py")
