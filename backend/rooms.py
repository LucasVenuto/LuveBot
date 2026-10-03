"""Rooms (contract v0.3 section 3): the checked send and the LuveBot metadata around Hermes's native Group Chat. Pure + SQLite.

Hermes `resolve_mentions` ignores a handle that is not a member and, when NO member is mentioned, wakes EVERYONE
(gateway/hosted_room_discussion.py `default_all=True`), and `groups.send` checks nothing about handles. The refusal is therefore
ours, before the send (red team 10): `check_send` returns the targets, or raises `not_a_member`, or asks for cost confirmation.
"""
import re
import sqlite3
import uuid

from .api_errors import PluginError

MENTION = re.compile(r"@([A-Za-z0-9][A-Za-z0-9._:-]*)", re.IGNORECASE)  # the same pattern as Hermes (_MENTION_RE)
RESERVED = {"all", "everyone"}
MAX_TEXT_BYTES = 64 * 1024
MAX_ROUNDS, MAX_MEMBER_MESSAGES = 3, 10
SCHEMA = """
CREATE TABLE IF NOT EXISTS rooms_meta (
    room_id TEXT PRIMARY KEY, goal TEXT, owner TEXT, coordinator TEXT, created_by TEXT NOT NULL, created_at REAL NOT NULL
);
"""
_HANDLE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")


def connect(path):
    conn = sqlite3.connect(path, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def new_room_id():
    return "room-" + uuid.uuid4().hex[:20]


def valid_id(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def mentioned(text):
    """Handles named in a text, in order of appearance, lower-cased, without repeats."""
    seen = []
    for match in MENTION.finditer(text or ""):
        handle = match.group(1).casefold()
        if handle not in seen:
            seen.append(handle)
    return seen


def check_send(text, members, coordinator=None):
    """-> (targets, stored_text). `members` = [{handle, bot, member_id}]. Raises 422 not_a_member / 422 invalid_field.
    A text with no mention goes to the coordinator when the room has one (the text is prefixed so the transcript shows it),
    otherwise Hermes's default applies: everyone."""
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > MAX_TEXT_BYTES:
        raise PluginError("invalid_field", "Send a message of up to 64 KiB.", 422)
    by_handle = {m["handle"].casefold(): m for m in members}
    named = mentioned(text)
    unknown = [h for h in named if h not in by_handle and h not in RESERVED]
    if unknown:
        raise PluginError("not_a_member", "Some mentioned handles are not members of this room; nothing was sent.", 422,
                          {"details": {"handles": unknown}})
    stored = text
    if any(h in RESERVED for h in named) or (not named and not coordinator):
        targets = list(members)
    elif not named:
        stored = f"@{coordinator} {text}"
        targets = [by_handle[coordinator.casefold()]]
    else:
        targets = [by_handle[h] for h in named if h in by_handle]
    return targets, stored


def needs_confirmation(targets):
    return len(targets) > 1


def cost_details(targets):
    return {"targets": [t["handle"] for t in targets], "max_rounds": MAX_ROUNDS, "max_member_messages": MAX_MEMBER_MESSAGES}


# ---- metadata -------------------------------------------------------------------------------------------------------
def put_meta(path, room_id, *, goal, owner, coordinator, actor, now):
    conn = connect(path)
    try:
        conn.execute("INSERT INTO rooms_meta VALUES(?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET goal=excluded.goal, "
                     "owner=excluded.owner, coordinator=excluded.coordinator", (room_id, goal, owner, coordinator, actor, now))
        conn.commit()
    finally:
        conn.close()


def get_meta(path, room_id):
    conn = connect(path)
    try:
        row = conn.execute("SELECT goal, owner, coordinator FROM rooms_meta WHERE room_id=?", (room_id,)).fetchone()
        return {"goal": row["goal"], "owner": row["owner"], "coordinator": row["coordinator"]} if row else {"goal": None, "owner": None, "coordinator": None}
    finally:
        conn.close()


# ---- bodies ----------------------------------------------------------------------------------------------------------
def _bad(field):
    return PluginError("invalid_field", f"Invalid value for {field}.", 422)


def _strict(body, allowed, required=()):
    if not isinstance(body, dict) or set(body) - set(allowed) or not set(required) <= set(body):
        raise PluginError("bad_request", "Invalid request body.", 400)
    return body


def _text(value, field, maximum, *, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise _bad(field)
    return value.strip()


def validate_create(body):
    """-> dict(name, members=[{bot, handle, display_name}], goal, owner, coordinator, kickoff). The handle defaults to the Bot name."""
    _strict(body, {"name", "members", "goal", "owner", "coordinator", "kickoff"}, {"name", "members"})
    members = body["members"]
    if not isinstance(members, list) or not 2 <= len(members) <= 6:
        raise PluginError("invalid_field", "A room has 2 to 6 members.", 422)
    clean, handles, bots = [], set(RESERVED), set()
    for raw in members:
        _strict(raw, {"bot", "handle", "display_name"}, {"bot"})
        bot = _text(raw["bot"], "bot", 128)
        handle = _text(raw.get("handle", bot), "handle", 64)
        if _HANDLE.fullmatch(handle) is None or handle.casefold() in handles or bot in bots:
            raise _bad("handle")
        display = _text(raw.get("display_name"), "display_name", 120, optional=True)
        handles.add(handle.casefold())
        bots.add(bot)
        clean.append({"bot": bot, "handle": handle, "display_name": display})
    owner, coordinator = body.get("owner"), body.get("coordinator")
    known = {m["handle"].casefold() for m in clean}
    for value in (owner, coordinator):
        if value is not None and (not isinstance(value, str) or value.casefold() not in known):
            raise PluginError("not_a_member", "The owner and the coordinator must be members of the room.", 422)
    kickoff = body.get("kickoff", False)
    if not isinstance(kickoff, bool):
        raise _bad("kickoff")
    return {"name": _text(body["name"], "name", 200), "members": clean, "goal": _text(body.get("goal"), "goal", 2000, optional=True),
            "owner": owner, "coordinator": coordinator, "kickoff": kickoff}


def validate_patch(body, members):
    _strict(body, {"name", "goal", "owner", "coordinator"})
    out = {}
    if "name" in body:
        out["name"] = _text(body["name"], "name", 200)
    if "goal" in body:
        out["goal"] = _text(body["goal"], "goal", 2000, optional=True)
    known = {m["handle"].casefold() for m in members}
    for field in ("owner", "coordinator"):
        if field in body:
            if body[field] is not None and (not isinstance(body[field], str) or body[field].casefold() not in known):
                raise PluginError("not_a_member", "The owner and the coordinator must be members of the room.", 422)
            out[field] = body[field]
    if not out:
        raise PluginError("bad_request", "Nothing to change.", 400)
    return out


def validate_message(body):
    _strict(body, {"text", "event_id", "thread_id", "confirm_cost"}, {"text", "event_id"})
    event_id = body["event_id"]
    if not valid_id(event_id):
        raise _bad("event_id")
    confirm = body.get("confirm_cost", False)
    if not isinstance(confirm, bool):
        raise _bad("confirm_cost")
    thread = body.get("thread_id")
    if thread is not None and not valid_id(thread):
        raise _bad("thread_id")
    return body["text"], event_id, thread, confirm


def members_view(room):
    """Hermes room row -> [{member_id, bot, handle, display_name}]."""
    out = []
    for m in room.get("members") or []:
        out.append({"member_id": m.get("member_id"), "bot": m.get("profile"), "handle": m.get("handle"), "display_name": m.get("display_name") or None})
    return out
