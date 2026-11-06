"""ADR-010: ONE budget watcher per luvebot.db. The dashboard and the gateway can both host the app (and so both start the watcher); a lease row in the database says which process
runs the pass. Every decision is one BEGIN IMMEDIATE, in the DATABASE's clock (two processes on one host cannot disagree about it), and everything fails toward RUNNING: a lease that
cannot be read or written never stops the watcher (invariant 7 outranks tidiness: a duplicate watcher is cosmetic since the Budget counts atomically, a watcher that does not run is not).
Only a lease that was READ, held by another process with a fresh beat, keeps this one out. A pass that finished renews it; a pass that threw gives it up, so a broken owner cannot keep the
other out for ever. A dashboard takes the lease from a gateway (the process people look at), and only while the gateway's beat is fresh: with no dashboard the gateway keeps it."""
import logging
import os
import socket
import sqlite3
import uuid
from contextlib import contextmanager

from . import dbfile

EXPIRES_S = 90          # three passes of 30 s: an owner that died without giving it up
KINDS = ('dashboard', 'gateway')
PROCESS = uuid.uuid4().hex   # this process, for as long as it lives
SCHEMA = """
CREATE TABLE IF NOT EXISTS watcher_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, kind TEXT, host TEXT, pid INTEGER, beat INTEGER NOT NULL);
"""
_NOW = "CAST(strftime('%s','now') AS INTEGER)"   # the database's clock, in seconds


def kind_of(app, proven=True):
    """'gateway' when the app is hosted by the gateway (`app.state.gateway_runner`, Hermes's own switch between its two lifespans); 'dashboard' when it is not AND this process is PROVEN to
    serve (the lifespan ran, or a request reached it): an importer that only loaded `hermes_cli.web_server` has no `gateway_runner` either, and must not pass for a dashboard and steal a
    gateway's lease; None when it cannot be read or is not proven: then the lease is a plain one, with no preference. Asked on EVERY pass: the gateway sets `gateway_runner` after the import
    in which its first pass runs, so a kind kept from the first pass would call the gateway a dashboard for ever."""
    try:
        state = getattr(app, 'state', None)
        if state is None:
            return None
        if getattr(state, 'gateway_runner', None) is not None:
            return 'gateway'
        return 'dashboard' if proven else None
    except Exception:  # noqa: BLE001
        return None


class Lease:
    def __init__(self, path, *, kind=None, owner=PROCESS, expires=EXPIRES_S):
        self.path, self.kind, self.owner, self.expires = path, kind if kind in KINDS else None, owner, expires

    def set_kind(self, kind):
        self.kind = kind if kind in KINDS else None

    @contextmanager
    def _tx(self):
        if not os.path.exists(self.path):
            raise OSError('no database yet')  # the lease NEVER creates luvebot.db (sqlite3.connect would, with the umask's mode): the pass does, with its own 0600 care; until then it runs
        dbfile.prepare(self.path)  # an existing file only: the directory is not a link, the file is a regular 0600 one
        conn = dbfile.connect(self.path, timeout=5)
        try:
            dbfile.ensure(conn, self.path, SCHEMA)
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        finally:
            conn.close()

    def enter(self):
        """Start of a tick: True when this process runs the pass. Never raises; any failure to read or write the lease is True."""
        try:
            before = None
            with self._tx() as conn:
                now = conn.execute(f'SELECT {_NOW}').fetchone()[0]
                row = conn.execute('SELECT owner, kind, beat FROM watcher_lease WHERE id=1').fetchone()
                if row is not None and row[0] != self.owner:
                    age = now - row[2]
                    if 0 <= age <= self.expires and not (row[1] == 'gateway' and self.kind == 'dashboard'):
                        return False  # another process holds it, and its beat is fresh; a beat in the FUTURE (a clock that stepped back, a database moved from a machine ahead) is not fresh: the lease fails toward RUNNING
                    before = (row[1], age)
                conn.execute('INSERT INTO watcher_lease (id, owner, kind, host, pid, beat) VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET '
                             'owner=excluded.owner, kind=excluded.kind, host=excluded.host, pid=excluded.pid, beat=excluded.beat',
                             (self.owner, self.kind, socket.gethostname()[:64], os.getpid(), now))
            if before is not None:
                logging.getLogger('luvebot.budget').warning('watcher lease changed hands: this %s process took it (the old owner was %s, last beat %ss ago)',
                                                            self.kind or 'unknown', before[0] or 'unknown', before[1])
            return True
        except Exception:  # noqa: BLE001  (unreadable, locked, a write that failed: the watcher runs)
            return True

    def renew(self):
        """End of a pass that FINISHED. Never raises."""
        try:
            with self._tx() as conn:
                conn.execute(f'UPDATE watcher_lease SET beat={_NOW} WHERE id=1 AND owner=?', (self.owner,))
        except Exception:  # noqa: BLE001
            pass

    def release(self):
        """A pass that threw: give the lease up (only if it is still this process's), so the other process takes over on its next tick. Never raises."""
        try:
            with self._tx() as conn:
                conn.execute('DELETE FROM watcher_lease WHERE id=1 AND owner=?', (self.owner,))
        except Exception:  # noqa: BLE001
            pass


def view(path, owner=PROCESS, expires=EXPIRES_S):
    """For /health: {held: true | false | null, owner_kind}. `held` is whether THIS process holds a fresh lease; false when another does; null when nobody does or it cannot be read.
    Never a pid, a host or an owner id."""
    try:
        conn = sqlite3.connect(f'file:{path}?mode=ro', uri=True, timeout=5)
        try:
            row = conn.execute(f'SELECT owner, kind, {_NOW} - beat FROM watcher_lease WHERE id=1').fetchone()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return {'held': None, 'owner_kind': None}
    if row is None or not 0 <= row[2] <= expires:  # nobody holds a FRESH lease: a stale beat, or one from the future (the same rule as `enter`)
        return {'held': None, 'owner_kind': None}
    return {'held': row[0] == owner, 'owner_kind': row[1] if row[1] in KINDS else None}
