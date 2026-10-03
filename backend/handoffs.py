"""Handoffs (contract v0.3 section 4, red team 11, Portao 5): a Kanban task with assignee = destination and created_by = origin.

Policy (4.1): a handoff is bounded by BOTH Bots. For every declared action the effective decision is the most restrictive of the
origin's and the destination's rules (`block > handback > ask > explicit > allow`, ADR-002 4.1). Pure + SQLite; the Kanban and
the audit are the caller's.
"""
import hashlib
import re
import sqlite3
import time
import uuid

from . import rules
from .api_errors import PluginError

SCHEMA = """
CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY, from_bot TEXT NOT NULL, to_bot TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, title_sha TEXT NOT NULL,
    room_id TEXT, source TEXT NOT NULL, effect TEXT NOT NULL, state TEXT NOT NULL, needs_review INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL, actor TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_pair ON handoffs (from_bot, to_bot, created_at);
CREATE TABLE IF NOT EXISTS handoff_cursor (id INTEGER PRIMARY KEY CHECK(id=1), seen_at REAL NOT NULL);
"""
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")


def connect(path):
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def title_sha(title):
    return hashlib.sha256((title or "").encode()).hexdigest()


def worst(effects):
    return max(effects, key=lambda e: rules.RANK[e], default=rules.Level.ALLOW)


def evaluate(rules_for, origin, destination, requested):
    """-> {effect, blocking: [rule ids], by_action: [...]}. `rules_for(bot)` -> that Bot's effective rules. Both sides are
    evaluated for each declared action; nothing declared evaluates to allow (the run-time hook is the real guard, A-40)."""
    effects, blocking, by_action = [], [], []
    for item in requested:
        pair = {}
        for side, bot in (("origin", origin), ("destination", destination)):
            action = rules.Action(bot=bot, tool=item["tool"], toolset=item.get("toolset"), mcp_server=item.get("mcp_server"), command=item.get("command"))
            decision = rules.evaluate(rules_for(bot), action)
            pair[side] = decision.effect
            effects.append(decision.effect)
            if decision.effect is rules.Level.BLOCK:
                blocking += [h.rule_id for h in decision.hits if h.level is rules.Level.BLOCK]
        by_action.append({"tool": item["tool"], "origin": pair["origin"].value, "destination": pair["destination"].value})
    return {"effect": worst(effects), "blocking": sorted(set(blocking)), "by_action": by_action}


def column_for(effect):
    """block -> refuse; ask/handback -> triage (a human promotes it); allow/explicit -> ready."""
    if effect is rules.Level.BLOCK:
        return "refuse"
    return "triage" if effect in (rules.Level.ASK, rules.Level.HANDBACK) else "ready"


def _bad(field):
    return PluginError("invalid_field", f"Invalid value for {field}.", 422)


def validate_create(body):
    if not isinstance(body, dict) or set(body) - {"from", "to", "title", "body", "room_id", "requested", "priority", "skills"} \
            or not {"from", "to", "title"} <= set(body):
        raise PluginError("bad_request", "Invalid request body.", 400)
    origin, destination, title = body["from"], body["to"], body["title"]
    if not all(isinstance(v, str) and v for v in (origin, destination)) or origin == destination:
        raise _bad("from/to")
    if not isinstance(title, str) or not title.strip() or len(title) > 300:
        raise _bad("title")
    text = body.get("body")
    if text is not None and (not isinstance(text, str) or len(text) > 20000):
        raise _bad("body")
    room = body.get("room_id")
    if room is not None and (not isinstance(room, str) or _ID.fullmatch(room) is None):
        raise _bad("room_id")
    priority = body.get("priority", 0)
    if type(priority) is not int or not -10 <= priority <= 10:
        raise _bad("priority")
    skills = body.get("skills")
    if skills is not None and (not isinstance(skills, list) or len(skills) > 20 or any(not isinstance(s, str) or not s or len(s) > 128 for s in skills)):
        raise _bad("skills")
    requested = []
    for item in body.get("requested") or []:
        if not isinstance(item, dict) or set(item) - {"tool", "toolset", "mcp_server", "command"} or not isinstance(item.get("tool"), str) or not item["tool"]:
            raise _bad("requested")
        for key in ("toolset", "mcp_server", "command"):
            if item.get(key) is not None and (not isinstance(item[key], str) or len(item[key]) > 2000):
                raise _bad("requested")
        requested.append({k: item.get(k) for k in ("tool", "toolset", "mcp_server", "command")})
    if len(requested) > 20:
        raise _bad("requested")
    return {"from": origin, "to": destination, "title": title.strip(), "body": text, "room_id": room, "requested": requested,
            "priority": priority, "skills": skills}


def check_room(members, origin, destination, room_id):
    """Both Bots must be members of the room a handoff belongs to (red team 10 for handoffs)."""
    bots = {m["bot"] for m in members}
    if origin not in bots or destination not in bots:
        raise PluginError("not_a_member", "Both Bots of a handoff in a room must be members of that room.", 422)


def new_id():
    return "ho-" + uuid.uuid4().hex[:16]


def insert(path, *, handoff_id, origin, destination, task_id, title, room_id, source, effect, state, needs_review, actor, now=None):
    conn = connect(path)
    try:
        conn.execute("INSERT OR IGNORE INTO handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                     (handoff_id, origin, destination, task_id, title_sha(title), room_id, source, effect, state, 1 if needs_review else 0,
                      time.time() if now is None else now, actor))
        conn.commit()
    finally:
        conn.close()


def view(row):
    return {"id": row["id"], "from": row["from_bot"], "to": row["to_bot"], "task_id": row["task_id"], "room_id": row["room_id"],
            "source": row["source"], "effect": row["effect"], "state": row["state"], "needs_review": bool(row["needs_review"]),
            "created_at": row["created_at"]}


def get(path, handoff_id):
    conn = connect(path)
    try:
        row = conn.execute("SELECT * FROM handoffs WHERE id=?", (handoff_id,)).fetchone()
        return None if row is None else dict(row)
    finally:
        conn.close()


def listing(path, *, room=None, bot=None, state=None, origin=None, destination=None, limit=50, offset=0):
    where, args = [], []
    for column, value in (("room_id", room), ("state", state), ("from_bot", origin), ("to_bot", destination)):
        if value is not None:
            where.append(f"{column}=?")
            args.append(value)
    if bot is not None:
        where.append("(from_bot=? OR to_bot=?)")
        args += [bot, bot]
    conn = connect(path)
    try:
        sql = "SELECT * FROM handoffs" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at DESC, id LIMIT ? OFFSET ?"
        return [dict(r) for r in conn.execute(sql, (*args, limit + 1, offset))]
    finally:
        conn.close()


def set_state(path, handoff_id, state, needs_review=None):
    conn = connect(path)
    try:
        conn.execute("UPDATE handoffs SET state=?, needs_review=COALESCE(?, needs_review) WHERE id=?",
                     (state, None if needs_review is None else int(needs_review), handoff_id))
        conn.commit()
    finally:
        conn.close()


def task_state(status):
    """Kanban column -> handoff state."""
    return {"triage": "needs_review", "todo": "open", "scheduled": "open", "ready": "open", "running": "running", "blocked": "open",
            "review": "running", "done": "completed", "archived": "cancelled"}.get(status, "open")


def edges(rows, *, since):
    """Map edges (4.5): one per (from, to) pair with the handoffs inside the window. `live` = a task of this pair is open now."""
    out = {}
    for row in rows:
        if row["created_at"] < since:
            continue
        edge = out.setdefault((row["from_bot"], row["to_bot"]), {"from": row["from_bot"], "to": row["to_bot"], "count": 0, "last_at": 0.0,
                                                                  "live": False, "handoff_ids": []})
        edge["count"] += 1
        edge["last_at"] = max(edge["last_at"], row["created_at"])
        edge["live"] = edge["live"] or row["state"] in ("open", "running")
        if len(edge["handoff_ids"]) < 20:
            edge["handoff_ids"].append(row["id"])
    return sorted(out.values(), key=lambda e: (e["from"], e["to"]))


# ---- the watcher side (S09): ingestion with a persisted cursor, and audited transitions --------------------------------
OVERLAP = 120.0  # seconds re-read behind the cursor, so a task committed late is not missed; known task ids dedupe


def _cursor(conn):
    row = conn.execute("SELECT seen_at FROM handoff_cursor WHERE id=1").fetchone()
    return row[0] if row else 0.0


def ingest(path, audit, names, list_tasks, *, now=None):
    """Bot-made handoffs (contract v0.3 4.4): every task whose creator is a profile gets a `handoffs` row and an audit row
    (`handoff.created`); one without the hook's `handoff.requested` row also raises `handoff.unrecorded`. Runs in the background
    watcher, never in a GET. -> [task ids ingested]."""
    conn = connect(path)
    try:
        cursor = _cursor(conn)
        known = {r[0] for r in conn.execute("SELECT task_id FROM handoffs")}
        has_events = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hook_events'").fetchone() is not None
        events = [dict(r) for r in conn.execute("SELECT profile, message FROM hook_events WHERE verdict='handoff'")] if has_events else []
    finally:
        conn.close()
    done, newest = [], cursor
    for task in list_tasks():
        created = float(task.get("created_at") or 0)
        newest = max(newest, created)
        origin, dest = task.get("created_by"), task.get("assignee")
        if created < cursor - OVERLAP or task["id"] in known or origin not in names or dest not in names or origin == dest:
            continue
        recorded = any(e["profile"] == origin and e["message"] == f"{dest}|{title_sha(task.get('title'))}" for e in events)
        handoff_id = new_id()
        audit.act("system", "handoff.created", handoff_id, {"kind": "system"},
                  lambda: insert(path, handoff_id=handoff_id, origin=origin, destination=dest, task_id=task["id"], title=task.get("title") or "",
                                 room_id=None, source="bot", effect="allow", state=task_state(task["status"]), needs_review=False, actor=origin,
                                 now=created or time.time()),
                  bot=dest, payload={"from": origin, "to": dest, "task_id": task["id"], "recorded": recorded})
        if not recorded:
            audit.act("system", "handoff.unrecorded", task["id"], {"kind": "system"}, lambda: None, bot=origin,
                      payload={"from": origin, "to": dest, "task_id": task["id"]})
        done.append(task["id"])
    conn = connect(path)
    try:
        conn.execute("INSERT INTO handoff_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seen_at=excluded.seen_at", (newest,))
        conn.commit()
    finally:
        conn.close()
    return done


def sync(path, audit, read_task):
    """Persist transitions the Kanban made (running, completed, cancelled), each one audited. A GET never does this."""
    changed = []
    for row in listing(path, limit=100):
        if row["state"] in ("completed", "cancelled"):
            continue
        task = read_task(row["task_id"])
        if task is None:
            continue
        fresh = "needs_review" if (row["state"] == "needs_review" and task["status"] == "triage") else task_state(task["status"])
        if fresh == row["state"]:
            continue
        action = "handoff.completed" if fresh == "completed" else "handoff.cancelled" if fresh == "cancelled" else "handoff.state"
        audit.act("system", action, row["id"], {"kind": "system"}, lambda r=row, f=fresh: set_state(path, r["id"], f), bot=row["to_bot"],
                  payload={"task_id": row["task_id"], "from": row["from_bot"], "to": row["to_bot"], "state": fresh})
        changed.append(row["id"])
    return changed
