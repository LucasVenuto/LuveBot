"""SQLite side of the LuveBot hook (ADR-003): the compiled HookTable per profile, the hook's heartbeat and what it did.

Standard library only, no Hermes import: this module is loaded BOTH by the dashboard backend and by the root plugin
inside the Hermes gateway process, and both talk to the one database at the root of the fleet
(`<root>/luvebot/luvebot.db`, ADR-002 sections 5.2 and 6). The tables here are owned by the hook; the audit log is
not touched.
"""
import hashlib
import json
import re
import sqlite3
import time

from . import dbfile

SCHEMA = """
CREATE TABLE IF NOT EXISTS hook_tables (
    profile TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL, table_json TEXT NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS hook_heartbeat (
    profile TEXT NOT NULL, pid INTEGER NOT NULL, serves_api INTEGER NOT NULL, table_digest TEXT, plugin_version TEXT,
    ts REAL NOT NULL, PRIMARY KEY (profile, pid)
);
CREATE TABLE IF NOT EXISTS hook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, profile TEXT NOT NULL, tool TEXT NOT NULL, rule_id TEXT,
    verdict TEXT NOT NULL, message TEXT, task_id TEXT, session_id TEXT, tool_call_id TEXT, command TEXT
);
CREATE INDEX IF NOT EXISTS hook_events_profile ON hook_events (profile, ts);
CREATE TABLE IF NOT EXISTS approval_surface (
    profile TEXT PRIMARY KEY, mode TEXT NOT NULL, approvers_json TEXT NOT NULL, digest TEXT NOT NULL, updated_at REAL NOT NULL,
    updated_by TEXT NOT NULL
);
"""
# D-025: where a person approves an action the hook asks about. `luvebot` (the default, and what any problem falls back to) or
# `channel`: in a private chat of a supported platform, with a person LuveBot names as approver, the approval goes to the chat.
SURFACE_MODES = ("luvebot", "channel")
CHANNEL_APPROVAL_PLATFORMS = ("telegram",)   # one where only the private chat's own participant can press the button
APPROVER = re.compile(r"(telegram):([0-9]{1,20})")
MAX_APPROVERS = 20
HEARTBEAT_TTL = 120.0      # a beat older than this is not "live" (ADR-002 3.3)
BEAT_KEEP = 24 * 3600.0    # beats of dead processes are pruned after a day
EVENT_KEEP = 7 * 24 * 3600.0


def connect(path):
    """Connection to the fleet database; creates the 0700 directory and the 0600 file the way the audit log does."""
    path = dbfile.prepare(path)  # never a descriptor on the live file: closing one drops SQLite's locks (dbfile.py)
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if "surface_digest" not in {r["name"] for r in conn.execute("PRAGMA table_info(hook_heartbeat)")}:
        try:
            conn.execute("ALTER TABLE hook_heartbeat ADD COLUMN surface_digest TEXT")  # D-025; older rows read as NULL
            conn.commit()
        except sqlite3.OperationalError:
            pass  # another process added it first
    return conn


def put_table(path, profile, table, *, now=None):
    """Store the compiled HookTable (`table.to_json()`) for a profile. The plugin reads it on its next call."""
    conn = connect(path)
    try:
        conn.execute("INSERT OR REPLACE INTO hook_tables (profile, version, digest, table_json, updated_at) VALUES (?,?,?,?,?)",
                     (profile, table.version, table.digest, table.to_json(), time.time() if now is None else now))
        conn.commit()
    finally:
        conn.close()


def table_digest(path, profile):
    conn = connect(path)
    try:
        row = conn.execute("SELECT digest FROM hook_tables WHERE profile=?", (profile,)).fetchone()
        return row["digest"] if row else None
    finally:
        conn.close()


def read_table(path, profile):
    """(digest, table_json) or None."""
    conn = connect(path)
    try:
        row = conn.execute("SELECT digest, table_json FROM hook_tables WHERE profile=?", (profile,)).fetchone()
        return (row["digest"], row["table_json"]) if row else None
    finally:
        conn.close()


def beat(path, profile, pid, serves_api, digest, plugin_version, *, surface_digest=None, now=None):
    now = time.time() if now is None else now
    conn = connect(path)
    try:
        conn.execute("INSERT OR REPLACE INTO hook_heartbeat (profile, pid, serves_api, table_digest, plugin_version, surface_digest, ts)"
                     " VALUES (?,?,?,?,?,?,?)", (profile, pid, 1 if serves_api else 0, digest, plugin_version, surface_digest, now))
        conn.execute("DELETE FROM hook_heartbeat WHERE ts < ?", (now - BEAT_KEEP,))
        conn.execute("DELETE FROM hook_events WHERE ts < ?", (now - EVENT_KEEP,))
        conn.commit()
    finally:
        conn.close()


def beats(path, profile):
    """Heartbeat rows of a profile, newest first: [{pid, serves_api, table_digest, plugin_version, surface_digest, ts}]."""
    conn = connect(path)
    try:
        return [dict(r) for r in conn.execute(
            "SELECT pid, serves_api, table_digest, plugin_version, surface_digest, ts FROM hook_heartbeat WHERE profile=? ORDER BY ts DESC",
            (profile,))]
    finally:
        conn.close()


def record_event(path, profile, tool, rule_id, verdict, message, task_id, session_id, tool_call_id, command, *, now=None):
    conn = connect(path)
    try:
        cursor = conn.execute("INSERT INTO hook_events (ts, profile, tool, rule_id, verdict, message, task_id, session_id, tool_call_id, command)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (time.time() if now is None else now, profile, tool, rule_id, verdict, message, task_id, session_id, tool_call_id, command))
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def events(path, profile, limit=50):
    conn = connect(path)
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM hook_events WHERE profile=? ORDER BY id DESC LIMIT ?", (profile, limit))]
    finally:
        conn.close()


# ---- D-025: the approval surface of a profile -------------------------------------------------------------------------
ALLOW_LISTS = ("TELEGRAM_ALLOWED_USERS", "GATEWAY_ALLOWED_USERS")


def allow_set(raw):
    """An allowlist the way Hermes reads one (gateway/authz_mixin.py _coerce_allow_set): a list, a JSON list literal, or a
    comma-separated scalar. A JSON-looking value that does not parse counts as open ("*"): the posture check fails closed."""
    if raw is None:
        return set()
    if isinstance(raw, str) and raw.strip().startswith("["):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {"*"}
    if isinstance(raw, (list, tuple, set)):
        return {str(part).strip() for part in raw if str(part).strip()}
    return {part.strip() for part in str(raw).split(",") if part.strip()}


def has_wildcard(raw):
    """`*` in an allowlist means everyone to Hermes (authz_mixin.py _allows, and the "*" in allowed_ids check)."""
    return "*" in allow_set(raw)


def surface_digest(mode, approvers):
    """What the hook reports back in its heartbeat once it applies this configuration."""
    canonical = json.dumps({"mode": mode, "approvers": sorted(approvers)}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def valid_surface(mode, approvers):
    """A mode and an approver list the hook may act on. `luvebot` needs nothing; `channel` needs 1..MAX_APPROVERS distinct
    `<platform>:<numeric id>` of a supported platform."""
    if mode == "luvebot":
        return isinstance(approvers, (list, tuple)) and len(approvers) <= MAX_APPROVERS and all(
            isinstance(a, str) and APPROVER.fullmatch(a) for a in approvers)
    return (mode == "channel" and isinstance(approvers, (list, tuple)) and 0 < len(approvers) <= MAX_APPROVERS
            and len(set(approvers)) == len(approvers) and all(isinstance(a, str) and APPROVER.fullmatch(a) for a in approvers))


def put_surface(path, profile, mode, approvers, actor, *, now=None):
    if not valid_surface(mode, approvers):
        raise ValueError("invalid approval surface")
    approvers = sorted(approvers)
    conn = connect(path)
    try:
        conn.execute("INSERT OR REPLACE INTO approval_surface (profile, mode, approvers_json, digest, updated_at, updated_by) VALUES (?,?,?,?,?,?)",
                     (profile, mode, json.dumps(approvers), surface_digest(mode, approvers), time.time() if now is None else now, actor))
        conn.commit()
    finally:
        conn.close()


def read_surface(path, profile):
    """{mode, approvers, digest, updated_at, updated_by} as stored, or the default `luvebot` (digest None, never stored). A row
    that does not verify (unknown mode, bad approver, a digest that is not its own) is treated as `luvebot`: fail closed."""
    default = {"mode": "luvebot", "approvers": [], "digest": None, "updated_at": None, "updated_by": None}
    conn = connect(path)
    try:
        row = conn.execute("SELECT * FROM approval_surface WHERE profile=?", (profile,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return default
    try:
        approvers = json.loads(row["approvers_json"])
    except ValueError:
        return default
    if not valid_surface(row["mode"], approvers) or row["digest"] != surface_digest(row["mode"], approvers):
        return default
    return {"mode": row["mode"], "approvers": sorted(approvers), "digest": row["digest"], "updated_at": row["updated_at"],
            "updated_by": row["updated_by"]}
