"""Back up, check and restore LuveBot's own database (~/.hermes/luvebot/luvebot.db). Python standard library only.

  python3 backup_luvebot.py [--db PATH] [--dest DIR]   a checked backup, safe with the dashboard and the gateway running
  python3 backup_luvebot.py --check FILE               is this backup sound? (run it before every restore)
  python3 backup_luvebot.py --restore FILE [--db PATH] put a checked backup in place (dashboard AND gateway stopped first)

Why not `cp`: a file copy taken while the dashboard or the gateway writes can catch a half-written page and is corrupt from
the start. SQLite's own backup API copies a consistent snapshot. Every copy is checked with PRAGMA integrity_check, and only
a copy that answers "ok" is kept (mode 0600, date in the name). A copy of a damaged database is refused and deleted.

A restore never mixes files: the current database and its -journal, -wal and -shm are moved aside (not deleted) with a
`.before-restore-<time>` suffix, so a leftover journal can never be replayed into the restored file.
Exit codes: 0 done, 2 the database or backup is not sound (nothing kept or changed), 3 the database is in use.
"""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import sqlite3
import stat
import sys

SIDE_FILES = ('-journal', '-wal', '-shm')


def default_db():
    return Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes') / 'luvebot' / 'luvebot.db'


def check(path):
    """(ok, detail) of a backup or database file: a regular SQLite file of LuveBot whose integrity_check answers ok."""
    path = Path(path)
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return False, 'not a regular file'
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=30)
        try:
            rows = [r[0] for r in conn.execute('PRAGMA integrity_check').fetchall()]
            if rows != ['ok']:
                return False, 'integrity_check: ' + '; '.join(str(r) for r in rows[:3])
            if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").fetchone() is None:
                return False, 'not a LuveBot database (no audit_log table)'
        finally:
            conn.close()
    except (OSError, sqlite3.Error) as error:
        return False, f'{type(error).__name__}: {error}'
    return True, 'ok'


def _sqlite_copy(source, target):
    """SQLite's backup API: a consistent snapshot even while others write. `target` must not exist yet."""
    os.close(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600))  # a new file, 0600 from the start
    src = sqlite3.connect(f'file:{source}?mode=ro', uri=True, timeout=30)
    try:
        dst = sqlite3.connect(target)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def backup(db, dest):
    db, dest = Path(db), Path(dest)
    if not db.is_file():
        return fail(f'no database at {db}')
    dest.mkdir(mode=0o700, parents=True, exist_ok=True)
    final = dest / f"luvebot-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}.db"
    partial = dest / ('.' + final.name + '.partial')
    try:
        _sqlite_copy(db, partial)
        ok, detail = check(partial)
    except (OSError, sqlite3.Error) as error:
        ok, detail = False, f'{type(error).__name__}: {error}'
    if not ok:
        partial.unlink(missing_ok=True)
        return fail(f'the copy is not sound ({detail}). Nothing was kept. The live database may be damaged: '
                    'keep the dashboard and the gateway stopped and restore the newest backup that passes --check.')
    os.replace(partial, final)
    print(f'backup ok: {final}')
    return 0


def in_use(db):
    """True when another process holds the database (a reader or a writer): the dashboard or a gateway is still running."""
    conn = sqlite3.connect(db, timeout=0, isolation_level=None)
    try:
        conn.execute('BEGIN EXCLUSIVE')
        conn.execute('ROLLBACK')
        return False
    except sqlite3.OperationalError:
        return True
    finally:
        conn.close()


def restore(backup_file, db):
    backup_file, db = Path(backup_file), Path(db)
    ok, detail = check(backup_file)
    if not ok:
        return fail(f'{backup_file} is not a sound backup ({detail}); nothing was changed.')
    if db.exists() and in_use(db):
        print('the database is in use: stop the dashboard and every gateway, then run --restore again.', file=sys.stderr)
        return 3
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    incoming = db.with_name('.' + db.name + '.restoring')
    incoming.unlink(missing_ok=True)
    _sqlite_copy(backup_file, incoming)
    ok, detail = check(incoming)
    if not ok:
        incoming.unlink(missing_ok=True)
        return fail(f'the restored copy is not sound ({detail}); nothing was changed.')
    moved = []
    for suffix in ('',) + SIDE_FILES:  # the database and every side file go aside together: no old journal meets the new file
        current = Path(str(db) + suffix)
        if current.exists():
            aside = Path(f'{current}.before-restore-{stamp}')
            os.replace(current, aside)
            moved.append(aside.name)
    os.replace(incoming, db)
    print(f'restored {backup_file} -> {db}' + (f' (previous files kept: {", ".join(moved)})' if moved else ''))
    return 0


def fail(message):
    print('error: ' + message, file=sys.stderr)
    return 2


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--db', default=None, help='the live database (default: $HERMES_HOME/luvebot/luvebot.db)')
    parser.add_argument('--dest', default=None, help='where backups go (default: next to the database, in backups/)')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', metavar='FILE')
    mode.add_argument('--restore', metavar='FILE')
    args = parser.parse_args(argv)
    db = Path(args.db) if args.db else default_db()
    if args.check:
        ok, detail = check(args.check)
        print(f'{args.check}: {detail}', file=sys.stdout if ok else sys.stderr)
        return 0 if ok else 2
    if args.restore:
        return restore(args.restore, db)
    return backup(db, Path(args.dest) if args.dest else db.parent / 'backups')


if __name__ == '__main__':
    sys.exit(main())
