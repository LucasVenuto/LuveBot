"""Costs (contract v0.2 section 4): spend by Bot, model, routine or day from the Hermes sessions table, in integer cents.

Pure: the sessions come in as arguments. The same cumulative-cost rule as the watcher (`cents_of`, A-30), so what the screen
shows is what the caps count; sessions Hermes did not price are counted as `unpriced_sessions`, never as zero (A-31).
"""
from datetime import datetime, timedelta, timezone

from .api_errors import PluginError
from .cost_watcher import cents_of, routine_of

PERIODS = ("day", "7d", "month", "30d")
GROUPS = ("bot", "model", "routine", "day")


def period_start(period, now):
    """-> epoch seconds. `now` is an aware datetime in the budget's zone, so day and month match the caps' periods."""
    if period == "day":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif period == "month":
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    elif period == "7d":
        start = now - timedelta(days=7)
    elif period == "30d":
        start = now - timedelta(days=30)
    else:
        raise PluginError("bad_request", "Unknown period.", 400)
    return start.timestamp()


def validate(period, group):
    if period not in PERIODS or group not in GROUPS:
        raise PluginError("bad_request", "Unknown period or group.", 400)


def aggregate(sessions_by_bot, *, start, group, tz=timezone.utc):
    """-> (totals, groups). A session counts when it started inside the period."""
    totals, groups, unpriced = 0, {}, 0
    for bot, rows in sorted(sessions_by_bot.items()):
        for row in rows:
            started = row.get("started_at") or 0
            if started < start:
                continue
            cents = cents_of(row.get("actual_usd"), row.get("estimated_usd"))
            if cents is None:
                unpriced += 1
            key = {"bot": bot, "model": row.get("model") or "unknown", "routine": routine_of(row.get("id")) or "none",
                   "day": datetime.fromtimestamp(started, tz).strftime("%Y-%m-%d")}[group]
            slot = groups.setdefault(key, {"key": key, "spend_cents": 0, "tokens": 0, "sessions": 0})
            slot["spend_cents"] += cents or 0
            slot["tokens"] += (row.get("input_tokens") or 0) + (row.get("output_tokens") or 0)
            slot["sessions"] += 1
            totals += cents or 0
    ordered = sorted(groups.values(), key=lambda g: (-g["spend_cents"], g["key"]))
    return {"spend_cents": totals, "unpriced_sessions": unpriced}, ordered
