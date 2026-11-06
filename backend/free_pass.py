"""A2: what the `free` surface let through (rows `verdict='free_pass'` of the hook, hermes-plugin 0.5.0) for GET /bots/{bot}/free-passes.

Each row says an ask rule of the Bot matched and the owner's free mode silenced it; the hook still answers nothing and Hermes's own
prompts still apply. `audited` is computed here, at read time, never stored: true when the newest change of this Bot's approval surface
at or before the row is an audited turn-on of `free` (a chained `bot.approval_surface` pair, intent and ok result, in the audit log).
A `free_pass` with `audited: false` means the Livre ran with no record that a person turned it on: the sign of a forged `free` row in
luvebot.db (the digest of that row is unkeyed, so it detects damage, not tampering).

The audit log keeps only a digest of each payload, so the mode of a change is read from the `origin_ref` the route now writes
(`surface.<mode>.<id>`), and, for changes audited before that, from the digest of the payload without approvers (the only shape the
screen sends for `free` and `luvebot`); a change whose mode cannot be told is not a turn-on.
"""
from datetime import datetime, timezone
import hashlib
import json
import re
import sqlite3

from . import hook_store

MODES = ("luvebot", "channel", "free")
_REF = re.compile(r"surface\.(luvebot|channel|free)\.[0-9a-f]{32}")


def _digest(origin, mode):
    raw = json.dumps({"from": origin, "mode": mode, "approvers": []}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


LEGACY = {_digest(origin, mode): mode for origin in MODES for mode in MODES}   # payload with no approvers -> the mode it set


def _epoch(text):
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        return None


def surface_changes(path, bot):
    """[(epoch, mode | None)] of this Bot's audited approval-surface changes, oldest first. A change counts when its intent row has an
    ok result row (same origin_ref); `mode` is None when it cannot be told."""
    conn = hook_store.connect(path)
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT ts, origin_ref, digest, detail, outcome FROM audit_log WHERE bot=? AND action='bot.approval_surface' ORDER BY id", (bot,))]
    except sqlite3.OperationalError:  # no audit table yet: nothing was ever audited
        return []
    finally:
        conn.close()
    done = {r["origin_ref"] for r in rows if r["detail"] == "result" and r["outcome"] == "ok"}
    changes = []
    for row in rows:
        if row["detail"] != "intent" or row["outcome"] != "ok" or row["origin_ref"] not in done:
            continue
        found = _REF.fullmatch(row["origin_ref"] or "")
        at = _epoch(row["ts"])
        if at is not None:
            changes.append((at, found.group(1) if found else LEGACY.get(row["digest"])))
    return changes


def audited(changes, at):
    """True when the newest change at or before `at` is a turn-on of `free`."""
    before = [mode for when, mode in changes if when <= at]
    return bool(before) and before[-1] == "free"


def read(path, bot, *, limit=50, before=None):
    """One page, newest first, as contract v0.9 section 5 says: {free_passes: [{at (epoch), tool, rule_id, command, audited}],
    next_before (the epoch of the last row, or null)}. `command` was redacted by the hook; no rule key, no hook ids."""
    rows = hook_store.free_passes(path, bot, limit=limit + 1, before=before)
    page, more = rows[:limit], len(rows) > limit
    changes = surface_changes(path, bot) if page else []
    items = [{"at": r["ts"], "tool": r["tool"], "rule_id": r["rule_id"], "command": r["command"], "audited": audited(changes, r["ts"])}
             for r in page]
    return {"free_passes": items, "next_before": page[-1]["ts"] if more else None}
