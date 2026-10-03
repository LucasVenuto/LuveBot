"""Search (contract v0.3 section 6): Hermes FTS5 per Bot for messages, substring for the rest. Pure shaping, no Hermes imports.

The query is data: never forwarded to a shell and never logged beyond its length and a hash. Hits are interleaved by recency
across profiles (A-43). A source that fails is listed in `partial`; the rest still return."""
import hashlib
import re

from .api_errors import PluginError

TYPES = ("messages", "bots", "rooms", "routines", "files", "actions")
DEFAULT_TYPES = ("messages", "bots", "rooms", "routines", "actions")
ACTIONS = (("new_bot", "New Bot"), ("new_room", "New room"), ("pause_all", "Pause all"), ("approvals", "Go to approvals"))


def validate(q, types, limit):
    if not isinstance(q, str) or not 1 <= len(q.strip()) <= 200:
        raise PluginError("bad_request", "Send a query of 1 to 200 characters.", 400)
    chosen = DEFAULT_TYPES if not types else tuple(t for t in types.split(",") if t)
    if not chosen or any(t not in TYPES for t in chosen):
        raise PluginError("bad_request", "Unknown search type.", 400)
    if not 1 <= limit <= 25:
        raise PluginError("bad_request", "Invalid limit.", 400)
    return q.strip(), chosen


def query_digest(q):
    return {"len": len(q), "sha256": hashlib.sha256(q.encode()).hexdigest()}


def substring(items, q, fields, limit):
    needle = q.casefold()
    return [i for i in items if any(needle in str(i.get(f) or "").casefold() for f in fields)][:limit]


def room_of(title):
    match = re.fullmatch(r"Group: (\S+)", title or "")
    return match.group(1) if match else None


def hit(bot, row, redact):
    snippet = row.get("snippet") or row.get("match") or ""
    return {"bot": bot, "session_id": row.get("session_id") or row.get("id"), "title": row.get("title"),
            "snippet": redact(str(snippet))[:300], "role": row.get("role"), "at": row.get("session_started") or row.get("started_at") or row.get("timestamp") or row.get("at"),
            "links": {k: v for k, v in {"room_id": room_of(row.get("title"))}.items() if v}}


def interleave(hits, limit):
    return sorted(hits, key=lambda h: -(h.get("at") or 0))[:limit]
