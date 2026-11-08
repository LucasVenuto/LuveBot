"""The one place that prepares luvebot.db before SQLite opens it (docs/bugs/luvebot-db-corrupcao.md).

The file is shared by the dashboard and every gateway process, and SQLite serialises them with POSIX advisory locks. Those
locks belong to the PROCESS: closing ANY descriptor of the file drops all of that process's locks on it, including the ones
held by SQLite connections in other threads (SQLite, "How To Corrupt An SQLite Database File", section 2.2). Another process
then writes, or rolls a live journal back, in the middle of our transaction: "database disk image is malformed".

So an existing database is never opened here. It is checked with lstat (a regular file, not a link) and its mode fixed by
path. A descriptor is opened only to CREATE the file, with O_EXCL: a file that did not exist holds no lock to drop.
"""
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading

_CREATE = threading.Lock()  # our own threads creating the file at the same time
_DONE = set()               # (path, schema hash): the schema ran in this process
SIDE_FILES = ('-wal', '-shm', '-journal')   # what SQLite keeps beside the database (ADR-008); only ever checked and chmod'ed, never opened
WAL_LIMIT = 64 * 1024 * 1024                # `journal_size_limit`: a starting value (ADR-008 section 7), not measured on the VPS
_MODES = {}                                 # path -> the journal mode this process found or got when it first configured the file
_NAMES = {}                 # schema text -> the names its CREATE ... IF NOT EXISTS statements make


CORRUPT_CODES = (11, 26)  # SQLITE_CORRUPT ("database disk image is malformed"), SQLITE_NOTADB ("file is not a database")


def damaged(error):
    """True when the FILE is damaged, by SQLite's own primary result code (not by the exception class: a trigger's RAISE(ABORT)
    is an IntegrityError, a lock or a full disk an OperationalError, and none of them is damage). Such an error is never turned
    into "audit/budget unavailable": it goes up to SafeRoute as luvebot_db_unavailable, telling the operator to check the file."""
    code = getattr(error, 'sqlite_errorcode', None)
    return isinstance(error, sqlite3.DatabaseError) and code is not None and code & 0xFF in CORRUPT_CODES


def prepare(path, *, fix_dir_mode=False):
    """Make sure `path` is a regular 0600 file in a 0700 directory that is not a link; never opens an existing file."""
    path = Path(path)
    if path.parent.is_symlink():
        raise OSError("unsafe database directory")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if fix_dir_mode:
        os.chmod(path.parent, 0o700)
    with _CREATE:
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            try:
                os.close(os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600))
            except FileExistsError:
                pass  # another process created it in between: nothing was opened, so nothing to drop
            st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode):
        raise OSError("unsafe database file")
    if stat.S_IMODE(st.st_mode) != 0o600:
        os.chmod(path, 0o600)  # by path: a chmod holds no descriptor
    for suffix in SIDE_FILES:  # ADR-008: WAL's side files exist only while someone has the database open; never created or opened here
        side = str(path) + suffix
        try:
            found = os.lstat(side)
        except FileNotFoundError:
            continue
        if not stat.S_ISREG(found.st_mode):
            raise OSError("unsafe database side file")
        if stat.S_IMODE(found.st_mode) != 0o600:
            os.chmod(side, 0o600)
    return path


def connect(path, timeout=5, **kwargs):
    """`sqlite3.connect` for every store of luvebot.db (ADR-008 section 4.2): the 5 s busy timeout and, on EVERY connection, `journal_size_limit`
    (64 MiB). That setting is per connection, not kept in the file, and whichever connection happens to checkpoint is the one it applies to: a
    connection that did not set it leaves the -wal at its full size (about 10 MiB after a checkpoint) where one that did cuts it to about 1 MiB.
    It is one PRAGMA, no I/O. A refusal (a damaged file) is left for the statement that follows to report, as before. Read-only connections
    (`mode=ro`) are not routed here: they cannot checkpoint."""
    conn = sqlite3.connect(path, timeout=timeout, **kwargs)
    try:
        conn.execute(f"PRAGMA journal_size_limit={WAL_LIMIT}")
    except Exception:  # noqa: BLE001
        pass
    return conn


def configure(conn, path):
    """Turn the write-ahead log on (ADR-008), ONCE per process and file, and never raise: readers and the writer stop blocking each other
    (an audit write waited 205 to 815 ms behind a /health read; 4 to 8 ms in WAL). The mode is kept in the file, so whichever process opens
    it first (the dashboard or a gateway) does it for all. A refusal (a network disk, a transaction that is open elsewhere) leaves the old
    rollback journal in place, honestly: the next start of this process tries again, and /health says which mode runs. `busy_timeout` is
    the 5 s every connection gets from `connect` below. `journal_size_limit` is NOT here: it belongs to each connection (see `connect`).
    -> the mode ('wal', 'delete', ...) or None when it could not be read."""
    key = str(path)
    if key in _MODES:
        return _MODES[key]
    mode = None
    try:
        mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        if mode != "wal":
            mode = str(conn.execute("PRAGMA journal_mode=WAL").fetchone()[0]).lower()
    except Exception:  # noqa: BLE001  (a refusal, a locked file, an answer that makes no sense: the old journal stays, nothing raises)
        pass
    _MODES[key] = mode
    return mode


def ensure(conn, path, schema, then=None):
    """Make the objects of `schema` (CREATE ... IF NOT EXISTS) exist ONCE per process and file, instead of on every request: running
    them takes a lock and a catalog read each time (134 times when the Today screen opens, measured). A later call only asks the catalog
    whether every name is still there, so a file that was replaced or lost a table or trigger gets the schema again. `then(conn)` (the
    column migrations, a key row) runs right after the schema, in the same cases. A schema CHANGE reaches a running process only with its
    restart, which the plugin already asks for (`plugin_restart_required`). -> True when it ran."""
    names = _NAMES.get(schema)
    if names is None:
        names = _NAMES[schema] = tuple(re.findall(r"CREATE (?:TABLE|TRIGGER|INDEX) IF NOT EXISTS (\w+)", schema))
    key = (str(path), hash(schema))
    if key in _DONE and names:
        marks = ",".join("?" for _ in names)
        if conn.execute(f"SELECT COUNT(*) FROM sqlite_master WHERE name IN ({marks})", names).fetchone()[0] == len(names):
            return False
    conn.executescript(schema)
    if then is not None:
        then(conn)
    _DONE.add(key)
    return True
