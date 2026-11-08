"""The cost watcher (contract v0.2 section 6, A-30, A-33): turns the Hermes sessions table into unique incremental spend for
`Budget.record_session_spend`, and tells the Budget "a complete, current snapshot was consumed" only after a pass that read every Bot.

Pure of Hermes: `read_sessions(bot) -> [{id, actual_usd, estimated_usd, ...}]` is injected, so the logic runs alone in tests.
Idempotent: a per-session cursor in LuveBot's own database remembers the cumulative cents already counted; a replayed pass adds
nothing and a session is never counted twice.
"""
import hashlib
import math
import re
from decimal import Decimal, InvalidOperation

from .budget import MAX_CENTS
from . import dbfile

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
    return dbfile.connect(path)  # the cursor table is the Budget's (it writes it: Budget.record_session_spend), created with its schema


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
                if cumulative - (seen[0] if seen else 0) <= 0:
                    continue  # nothing new (a look only: the cursor only grows, so a stale read is never above the truth); a cost that went down is never refunded
                try:  # the cursor is read again, the spend and the cursor written, in ONE transaction of the Budget: two watchers cannot count the same stretch
                    done = budget.record_session_spend(event_id(session_id, cumulative), session_id, bot, cumulative, routine=routine_of(session_id))
                except Exception:
                    errors.append(bot)
                    break
                if done is None:
                    continue  # the other watcher counted it between the look and the transaction
                decision, delta = done
                recorded += delta
                if decision.get("plan") or decision.get("plans") or decision.get("alerts"):
                    plans.append(decision)
    finally:
        conn.close()
    heartbeat = not errors
    if heartbeat:
        budget.heartbeat()
    return {"decisions": plans, "recorded_cents": recorded, "unpriced": unpriced, "errors": errors, "heartbeat": heartbeat}
