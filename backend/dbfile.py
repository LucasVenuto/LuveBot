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
import sqlite3
import stat
import threading

_CREATE = threading.Lock()  # our own threads creating the file at the same time


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
    return path
