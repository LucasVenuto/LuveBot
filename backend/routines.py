"""Routines (contract v0.2 section 3): a Hermes cron job as the UI sees it. Pure shaping and validation, no Hermes imports.

The browser never gets `hermes_home`, `base_url`, `script` or `workdir` (a boolean `has_script` instead), and a client body is
never forwarded as a dict: only the allowlists below, key by key (A-26).
"""
import re

from .api_errors import PluginError
from .cost_watcher import cents_of

REASONS = {"luvebot:budget": "budget", "luvebot:user": "user"}
CREATE_KEYS = {"bot", "name", "schedule", "prompt", "skills", "model", "deliver", "no_agent", "enabled_toolsets", "start"}
PATCH_KEYS = {"name", "prompt", "skills", "model", "deliver", "no_agent", "enabled_toolsets"}
_JOB_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")


def valid_id(value):
    return isinstance(value, str) and _JOB_ID.fullmatch(value) is not None


def paused_reason(job):
    return REASONS.get(job.get("paused_reason"), "user") if job.get("state") == "paused" else None


def view(bot, job, *, cap=None, spend_cents=0, redact=lambda text: text):
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    return {
        "id": job.get("id"), "bot": bot, "name": job.get("name"),
        "schedule": {"kind": schedule.get("kind"), "expr": schedule.get("expr") or schedule.get("display") or job.get("schedule_display"),
                     "tz": schedule.get("tz")},
        "next_run_at": job.get("next_run_at"), "last_run_at": job.get("last_run_at"), "last_status": job.get("last_status"),
        "last_error": redact(job["last_error"]) if job.get("last_error") else None,
        "state": {"paused": "paused", "completed": "completed", "error": "completed"}.get(job.get("state"), "scheduled"), "enabled": bool(job.get("enabled")), "paused_reason": paused_reason(job),
        "deliver": job.get("deliver"), "skills": list(job.get("skills") or []), "model": job.get("model"),
        "no_agent": bool(job.get("no_agent")), "has_script": bool(job.get("script")), "cap": cap, "spend_cents": spend_cents,
        "scheduler_heartbeat_age_s": job.get("scheduler_heartbeat_age_s"),
    }


def detail(job, redact=lambda text: text):
    return {"instruction": redact(job.get("prompt") or ""), "input_source": "script" if job.get("script") else "prompt",
            "delivery_summary": job.get("deliver") or "local"}


def run_view(row, now):
    ended = row.get("ended_at")
    started = row.get("started_at")
    actual, estimated = row.get("actual_cost_usd"), row.get("estimated_cost_usd")
    cents = cents_of(actual, estimated)
    active = ended is None and (now - (row.get("last_active") or started or 0)) < 300
    positive = lambda value: isinstance(value, (int, float)) and value > 0  # noqa: E731
    return {"session_id": row.get("id"), "kind": "session", "started_at": started, "ended_at": ended,
            "status": "running" if active else ("error" if row.get("end_reason") in ("error", "failed") else "success"),
            "duration_s": None if started is None or ended is None else max(0, ended - started),
            "cost_cents": cents, "cost_kind": "actual" if positive(actual) else "estimated" if positive(estimated) else "unknown",
            "tokens": (row.get("input_tokens") or 0) + (row.get("output_tokens") or 0), "is_active": bool(active)}


def _bad(field):
    return PluginError("invalid_field", f"Invalid value for {field}.", 422)


def _text(value, field, *, maximum=4000, optional=True):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise _bad(field)
    return value.strip()


def _strings(value, field):
    if not isinstance(value, list) or len(value) > 50 or any(not isinstance(v, str) or not v.strip() or len(v) > 128 for v in value):
        raise _bad(field)
    return [v.strip() for v in value]


def _fields(body, allowed):
    if not isinstance(body, dict):
        raise PluginError("bad_request", "Invalid request body.", 400)
    extra = set(body) - allowed
    if extra:
        raise PluginError("invalid_field", "Unsupported field: " + ", ".join(sorted(map(str, extra)))[:200] + ".", 422)
    out = {}
    if "name" in body:
        out["name"] = _text(body["name"], "name", maximum=200, optional=False)
    if "prompt" in body:
        out["prompt"] = _text(body["prompt"], "prompt", maximum=20000, optional=False)
    if "model" in body:
        out["model"] = _text(body["model"], "model", maximum=200)
    if "deliver" in body:
        out["deliver"] = _text(body["deliver"], "deliver", maximum=200, optional=False)
    if "skills" in body:
        out["skills"] = _strings(body["skills"], "skills")
    if "enabled_toolsets" in body:
        out["enabled_toolsets"] = _strings(body["enabled_toolsets"], "enabled_toolsets")
    if "no_agent" in body:
        if not isinstance(body["no_agent"], bool):
            raise _bad("no_agent")
        out["no_agent"] = body["no_agent"]
    return out


def validate_patch(body):
    out = _fields(body, PATCH_KEYS)
    if not out:
        raise PluginError("bad_request", "Nothing to change.", 400)
    return out


def validate_create(body):
    """-> (bot, fields for create_job, start). Routines are created paused unless `start: true`."""
    out = _fields(body, CREATE_KEYS)
    bot = body.get("bot")
    if not isinstance(bot, str):
        raise _bad("bot")
    schedule = _text(body.get("schedule"), "schedule", maximum=200, optional=False)
    if "prompt" not in out and not out.get("no_agent"):
        raise _bad("prompt")
    start = body.get("start", False)
    if not isinstance(start, bool):
        raise _bad("start")
    return bot, {**out, "schedule": schedule}, start


def duplicate_fields(job):
    """The allowlisted fields of a stored job, for a new paused copy."""
    keys = ("prompt", "model", "deliver", "skills", "enabled_toolsets", "no_agent")
    fields = {k: job.get(k) for k in keys if job.get(k) not in (None, [], "")}
    fields["name"] = f"{job.get('name') or 'Routine'} (copy)"
    schedule = job.get("schedule") if isinstance(job.get("schedule"), dict) else {}
    fields["schedule"] = schedule.get("expr") or schedule.get("display") or job.get("schedule_display")
    return fields


def page(items, limit, cursor):
    """Offset paging over a list: opaque numeric cursor. -> (page, next_cursor). Raises 400 on a bad cursor."""
    try:
        offset = 0 if cursor is None else int(cursor)
        if offset < 0 or not re.fullmatch(r"[0-9]{1,9}", str(cursor if cursor is not None else "0")):
            raise ValueError
    except ValueError:
        raise PluginError("bad_request", "Invalid paging parameters.", 400) from None
    chunk = items[offset:offset + limit]
    return chunk, (str(offset + limit) if offset + limit < len(items) else None)
