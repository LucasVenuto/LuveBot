"""The cost watcher (contract v0.2 section 6, A-30, A-33): turns the Hermes sessions table into unique incremental spend for
`Budget.record_spend`, and tells the Budget "a complete, current snapshot was consumed" only after a pass that read every Bot.

Pure of Hermes: `read_sessions(bot) -> [{id, actual_usd, estimated_usd, ...}]` is injected, so the logic runs alone in tests.
Idempotent: a per-session cursor in LuveBot's own database remembers the cumulative cents already counted; a replayed pass adds
nothing and a session is never counted twice.
"""
import hashlib
import math
import re
import sqlite3
from decimal import Decimal, InvalidOperation

from .budget import MAX_CENTS

SCHEMA = """
CREATE TABLE IF NOT EXISTS budget_cost_cursor (session_id TEXT PRIMARY KEY, bot TEXT NOT NULL, cents INTEGER NOT NULL);
"""
_CRON = re.compile(r"cron_([A-Za-z0-9][A-Za-z0-9.-]*)_\d{8}_\d{6}")


def cents_of(actual_usd, estimated_usd):
    """A-30: ceil(usd * 100) of the cumulative cost, never under-counting; the actual cost wins over the estimate when positive.
    -> int cents, or None when the session has no price at all (the caller counts it as unpriced, not as zero)."""
    for value in (actual_usd, estimated_usd):
        if value is None:
            continue
        try:
            usd = Decimal(str(value))
        except InvalidOperation:
            continue
        if usd.is_finite() and usd > 0:
            return min(MAX_CENTS, int(math.ceil(usd * 100)))
    return None if actual_usd is None and estimated_usd is None else 0


def routine_of(session_id):
    """The cron job a session belongs to (`cron_<job>_<YYYYmmdd_HHMMSS>`), else None."""
    match = _CRON.fullmatch(session_id or "")
    return match.group(1) if match else None


def event_id(session_id, cumulative):
    return f"s_{hashlib.sha256(session_id.encode()).hexdigest()[:16]}.c{cumulative}"


def _connect(path):
    conn = sqlite3.connect(path, timeout=5)
    conn.executescript(SCHEMA)
    return conn


def run_pass(budget, bots, read_sessions):
    """One watcher pass. -> {plans, recorded_cents, unpriced, errors, heartbeat}. A Bot that cannot be read is an error and
    withholds the heartbeat (fail closed after `watcher_max_age`); the other Bots are still counted."""
    plans, recorded, unpriced, errors = [], 0, 0, []
    conn = _connect(budget.path)
    try:
        for bot in bots:
            try:
                sessions = read_sessions(bot)
            except Exception:
                errors.append(bot)
                continue
            for row in sessions:
                session_id = row.get("id")
                if not isinstance(session_id, str) or not session_id:
                    continue
                cumulative = cents_of(row.get("actual_usd"), row.get("estimated_usd"))
                if cumulative is None:
                    unpriced += 1
                    continue
                seen = conn.execute("SELECT cents FROM budget_cost_cursor WHERE session_id=?", (session_id,)).fetchone()
                delta = cumulative - (seen[0] if seen else 0)
                if delta <= 0:
                    continue  # nothing new; a cost that went down is never refunded
                try:
                    decision = budget.record_spend(event_id(session_id, cumulative), bot, delta, routine=routine_of(session_id))
                except Exception:
                    errors.append(bot)
                    break
                conn.execute("INSERT INTO budget_cost_cursor VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET cents=excluded.cents",
                             (session_id, bot, cumulative))
                conn.commit()
                recorded += delta
                if decision.get("plan") or decision.get("plans") or decision.get("alerts"):
                    plans.append(decision)
    finally:
        conn.close()
    heartbeat = not errors
    if heartbeat:
        budget.heartbeat()
    return {"decisions": plans, "recorded_cents": recorded, "unpriced": unpriced, "errors": errors, "heartbeat": heartbeat}
