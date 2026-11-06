"""Stdlib audit store. Inject a dedicated directory, secrets and Hermes redactor.

Only identifiers enter metadata; payloads are hashed and callback results/errors
are never serialized. The host user can rewrite and rehash the whole database:
this is tamper-evident, not tamper-proof (threat model R4).
"""

import logging
import time
import base64
import csv
from datetime import datetime, timezone
import hashlib
import io
import inspect
import json
from pathlib import Path
import re
import sqlite3
import threading
import uuid

from . import dbfile


COLUMNS = ("id", "ts", "actor", "origin_kind", "origin_ref", "bot", "action",
           "target", "outcome", "digest", "detail", "prev_hash", "hash")
GENESIS = "0" * 64
SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    actor TEXT NOT NULL,
    origin_kind TEXT NOT NULL CHECK(origin_kind IN ('ui','system','agent','hermes_hook')),
    origin_ref TEXT,
    bot TEXT,
    action TEXT NOT NULL,
    target TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('ok','denied','error')),
    digest TEXT,
    detail TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_replace BEFORE INSERT ON audit_log
WHEN EXISTS(SELECT 1 FROM audit_log WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
"""


class _Transient(Exception):
    pass


class AuditUnavailable(RuntimeError):
    """Router maps this static error to 503 audit_unavailable."""

    def __init__(self):
        super().__init__("audit_unavailable")


class ActionDenied(Exception):
    """A caller's explicit denial; recorded as denied, then re-raised."""


def _canonical(row):
    return json.dumps({key: row[key] for key in COLUMNS if key not in ("prev_hash", "hash")},
                      sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _hash(row):
    return hashlib.sha256((row["prev_hash"] + _canonical(row)).encode("utf-8")).hexdigest()


class AuditLog:
    def __init__(self, path=None, *, secrets=(), redact=None, timeout=5):
        self.path = Path(path or Path.home() / ".hermes/luvebot/luvebot.db")
        self.secrets = tuple(sorted({s for s in secrets if isinstance(s, str) and s},
                                    key=len, reverse=True))
        self.redact = redact
        self.timeout = timeout
        try:
            dbfile.prepare(self.path, fix_dir_mode=True)  # no descriptor on the live file (it would drop SQLite's locks)
            conn = self._connect()
            try:
                dbfile.configure(conn, self.path)        # the write-ahead log, once per process and file (ADR-008)
                dbfile.ensure(conn, self.path, SCHEMA)   # once per process and file; a dropped trigger or table runs it again
            finally:
                conn.close()
        except (OSError, sqlite3.Error) as error:
            if dbfile.damaged(error):
                raise  # a damaged luvebot.db says so (SafeRoute: luvebot_db_unavailable), never "audit unavailable"
            raise AuditUnavailable() from None

    def _connect(self):
        conn = dbfile.connect(self.path, timeout=self.timeout)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA recursive_triggers=ON")
        conn.execute("PRAGMA synchronous=FULL")
        return conn

    def journal_mode(self):
        """'wal' or 'delete' (or what SQLite says): what GET /health shows as plugin.db.journal_mode."""
        conn = self._connect()
        try:
            return str(conn.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        finally:
            conn.close()

    def _identifier(self, value, *, optional=False):
        if value is None and optional:
            return None
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.:@/\-]{1,256}", value):
            raise ValueError("audit metadata must be an identifier")
        text = value
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        # Supplement known values; heuristics do not replace injecting .env secrets.
        text = re.sub(r"(?:sk-|ghp_|github_pat_)[A-Za-z0-9_\-]{16,}", "[REDACTED]", text)
        text = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[REDACTED]", text)
        if self.redact is not None:
            try:
                text = self.redact(text)
                if not isinstance(text, str):
                    raise TypeError
            except Exception:
                raise AuditUnavailable() from None
        for secret in self.secrets:
            text = text.replace(secret, "[REDACTED]")
        return text[:256]

    TRANSIENT_RETRIES = 3  # SQLITE_IOERR under a loaded container disk: the failed attempt rolled back, so trying again is safe

    def _append(self, metadata, outcome, detail):
        for attempt in range(self.TRANSIENT_RETRIES):
            try:
                return self._append_once(metadata, outcome, detail)
            except _Transient:
                time.sleep(0.05 * (attempt + 1))
        return self._append_once(metadata, outcome, detail, final=True)

    def _append_once(self, metadata, outcome, detail, final=False):
        conn = None
        try:
            conn = self._connect()
            conn.execute("BEGIN IMMEDIATE")
            tip = conn.execute("SELECT id, hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
            seq = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='audit_log'").fetchone()
            row = dict(metadata, id=(seq[0] if seq else 0) + 1,
                       ts=datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z"),
                       outcome=outcome, detail=detail, prev_hash=tip["hash"] if tip else GENESIS)
            row["hash"] = _hash(row)
            conn.execute(f"INSERT INTO audit_log ({','.join(COLUMNS)}) VALUES ({','.join('?' for _ in COLUMNS)})",
                         tuple(row[key] for key in COLUMNS))
            conn.commit()
            return row["id"]
        except (sqlite3.Error, OSError) as error:
            # Diagnosable without leaking: the class and the SQLite/OS message ("database is locked", "disk I/O error"), never a value.
            logging.getLogger("luvebot.audit").warning("audit append failed: %s: %s", type(error).__name__, str(error)[:100])
            if dbfile.damaged(error):
                raise  # the file itself is damaged: luvebot_db_unavailable, not a lock to retry or "audit unavailable"
            if not final and isinstance(error, sqlite3.OperationalError) and "disk I/O error" in str(error):
                raise _Transient() from None  # only this error is retried: a lock, a trigger or a full disk still fails closed at once
            raise AuditUnavailable() from None
        finally:
            if conn is not None:
                conn.close()

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        """Commit intent before fn; commit result even when fn raises.

        origin is a kind string or {kind, ref}. An absent ref gets a UUID shared
        by both rows. Callback exceptions are re-raised unchanged, never logged.
        A post-effect write failure raises AuditUnavailable: intent remains durable.
        This synchronous wrapper must run in the dashboard threadpool.
        """
        if isinstance(origin, str):
            origin = {"kind": origin}
        if not isinstance(origin, dict) or set(origin) - {"kind", "ref"}:
            raise ValueError("invalid audit origin")
        kind = origin.get("kind")
        if kind not in ("ui", "system", "agent", "hermes_hook"):
            raise ValueError("invalid audit origin")
        digest = None
        if payload is not None:
            try:
                raw = payload if isinstance(payload, bytes) else (
                    payload.encode("utf-8") if isinstance(payload, str) else
                    json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                               allow_nan=False).encode("utf-8"))
                digest = hashlib.sha256(raw).hexdigest()
            except (TypeError, ValueError):
                raise ValueError("invalid audit payload") from None
        metadata = dict(actor=self._identifier(actor), action=self._identifier(action),
                        target=self._identifier(target, optional=True), origin_kind=kind,
                        origin_ref=self._identifier(origin.get("ref") or uuid.uuid4().hex),
                        bot=self._identifier(bot, optional=True), digest=digest)
        self._append(metadata, "ok", "intent")
        try:
            result = fn()
            if inspect.isawaitable(result):
                if inspect.iscoroutine(result):
                    result.close()
                raise TypeError("audit act requires a synchronous callback")
        except BaseException as exc:
            self._append(metadata, "denied" if isinstance(exc, ActionDenied) else "error", "result")
            raise
        self._append(metadata, "ok", "result")
        return result

    @staticmethod
    def _walk(conn, proven=None):
        """-> (result, tip). `proven` is the (id, hash) of a row an earlier pass vouched for: the walk starts after it (the cost is the new
        rows) and its `rows` counts that prefix too. `tip` is the (id, hash) of the last row this pass proved, None after a break."""
        previous, expected, count = (proven[1], proven[0] + 1, proven[0]) if proven else (GENESIS, 1, 0)
        records = (conn.execute("SELECT * FROM audit_log WHERE id >= ? ORDER BY id", (expected,)) if proven
                   else conn.execute("SELECT * FROM audit_log ORDER BY id"))   # a full pass takes every row: an id below 1 is a break too
        for record in records:
            row = dict(record)
            count += 1
            if row["id"] != expected:
                return {"ok": False, "rows": count, "first_break": expected}, None
            try:
                intact = row["prev_hash"] == previous and row["hash"] == _hash(row)
            except (TypeError, ValueError, UnicodeError):
                intact = False
            if not intact:
                return {"ok": False, "rows": count, "first_break": row["id"]}, None
            previous, expected = row["hash"], row["id"] + 1
        seq = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='audit_log'").fetchone()
        if seq and seq[0] != expected - 1:
            return {"ok": False, "rows": count, "first_break": expected}, None
        return {"ok": True, "rows": count, "first_break": None}, ((expected - 1, previous) if expected > 1 else None)

    @classmethod
    def _verify(cls, conn):
        return cls._walk(conn)[0]

    def verify_from(self, proven=None):
        """-> (result, tip): the chain proved from `proven` to the end, whose cost is the rows added since. A proven row that is gone
        or whose stored hash changed starts over from the first row. `result` is what `verify()` says."""
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            if proven is not None:
                row = conn.execute("SELECT hash FROM audit_log WHERE id=?", (proven[0],)).fetchone()
                if row is None or row[0] != proven[1]:
                    proven = None
            return self._walk(conn, proven)
        finally:
            conn.close()

    def verify(self):
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            return self._verify(conn)
        finally:
            conn.close()

    def page(self, *, limit=50, cursor=None, bot=None, actor=None, actions=(),
             outcome=None, from_ts=None, to_ts=None, q=None):
        """Descending keyset pagination; new writes cannot move an existing cursor."""
        if type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError("invalid audit limit")
        before = through = None
        if cursor is not None:
            try:
                before, through = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
                if any(type(n) is not int or n < 1 for n in (before, through)) or before > through:
                    raise ValueError
            except (ValueError, TypeError, UnicodeError):
                raise ValueError("invalid audit cursor") from None
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            if through is None:
                through = conn.execute("SELECT COALESCE(MAX(id),0) FROM audit_log").fetchone()[0]
            clauses, values = ["id <= ?"], [through]
            if before is not None:
                clauses.append("id < ?")
                values.append(before)
            for column, value, operator in (("bot", bot, "="), ("actor", actor, "="),
                                            ("outcome", outcome, "="), ("ts", from_ts, ">="),
                                            ("ts", to_ts, "<=")):
                if value is not None:
                    clauses.append(f"{column} {operator} ?")
                    values.append(value)
            if actions:
                clauses.append(f"action IN ({','.join('?' for _ in actions)})")
                values.extend(actions)
            if q is not None:
                clauses.append("(instr(action, ?) > 0 OR instr(target, ?) > 0 OR instr(detail, ?) > 0)")
                values.extend([q] * 3)
            records = conn.execute("SELECT * FROM audit_log WHERE " + " AND ".join(clauses)
                                   + " ORDER BY id DESC LIMIT ?", values + [limit + 1]).fetchall()
            events = [dict(row) for row in records[:limit]]
            next_cursor = None
            if len(records) > limit:
                next_cursor = base64.urlsafe_b64encode(json.dumps([events[-1]["id"], through]).encode()).decode()
            verification = self._verify(conn)
            return {"events": events, "next_cursor": next_cursor,
                    "chain": {"ok": verification["ok"],
                              "checked_through": verification["rows"] if verification["ok"]
                              else verification["first_break"] - 1,
                              "first_break": verification["first_break"]}}
        finally:
            conn.close()

    def export(self, format, *, actor, origin, **pagination):
        """Return one audited JSON/CSV page; follow next_cursor for the remainder."""
        if format not in ("json", "csv"):
            raise ValueError("invalid audit export format")
        page = self.act(actor, "audit.export", None, origin, lambda: self.page(**pagination))
        if format == "json":
            content = json.dumps(page["events"], ensure_ascii=False, separators=(",", ":"))
        else:
            output = io.StringIO(newline="")
            writer = csv.DictWriter(output, fieldnames=COLUMNS)
            writer.writeheader()
            # Neutralize spreadsheet formulas in exported, untrusted identifiers.
            for row in page["events"]:
                writer.writerow({k: "'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@", "\t", "\r"))
                                 else v for k, v in row.items()})
            content = output.getvalue()
        return {"content": content, "next_cursor": page["next_cursor"], "chain": page["chain"]}


class ChainProof:
    """What GET /health keeps between calls, one per database: the last row a pass proved, so a call checks only the rows added since
    (it used to hash the whole log every time: 1.1 s at 100 000 rows, holding a read lock that made every writer wait). A FULL pass, from
    the first row, runs on the first call, after a break (so the alarm cannot clear itself), every FULL_EVERY seconds from the background
    watcher, and from a call itself when the watcher is more than 2 x FULL_EVERY late (it died): an edit of a row BEFORE the last proof is
    found by that pass, not by each call. `full_at()` says when the last full pass ended (epoch seconds, None before the first)."""
    FULL_EVERY = 600.0

    def __init__(self, clock=time.monotonic, wall=time.time):
        self._lock, self._clock, self._wall = threading.Lock(), clock, wall
        self._tip, self._full_at, self._full_epoch = None, None, None

    def check(self, audit, *, full=False):
        """-> the `verify()` result, from the last proof (or from the start when `full`, when there is none, or when the last full pass is
        2 x FULL_EVERY old). The lock covers the whole walk: a result computed before a break can never overwrite the break's."""
        with self._lock:  # the whole walk: no result computed before a break can overwrite it
            if self._full_at is not None and self._clock() - self._full_at > 2 * self.FULL_EVERY:
                full = True
            tip = None if full else self._tip
            result, self._tip = audit.verify_from(tip)   # None after a break: the next call walks the whole chain again
            if tip is None:
                self._full_at, self._full_epoch = self._clock(), self._wall()
            return result

    def due(self):
        return self._full_at is None or self._clock() - self._full_at > self.FULL_EVERY

    def full_at(self):
        return self._full_epoch

    def watch(self, audit):
        """The background watcher's turn: the full pass when it is due."""
        if self.due():
            self.check(audit, full=True)
