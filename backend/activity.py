"""Activity (contract v0.2 section 2): one merged list of LuveBot runs, routine runs, scheduled routines and Kanban tasks.

Pure shaping; each source is read per Bot by the caller and a failed source is reported in `partial`, never hidden.
Item ids are opaque to the UI: `<kind>:<native id>` here, passed back as is.
"""
import re

from .api_errors import PluginError
from .cost_watcher import cents_of, routine_of

TABS = ("running", "scheduled", "done")
ORIGINS = ("message", "routine", "webhook", "handoff")
STATUSES = ("running", "waiting_approval", "scheduled", "done", "error", "stopped", "blocked")
_RUN = {"started": "running", "running": "running", "queued": "running", "stopping": "running",
        "waiting_for_approval": "waiting_approval", "completed": "done", "failed": "error", "cancelled": "stopped",
        "interrupted": "stopped"}
_TASK = {"running": "running", "ready": "scheduled", "scheduled": "scheduled", "triage": "scheduled", "todo": "scheduled",
         "blocked": "blocked", "review": "waiting_approval", "done": "done", "archived": "done"}
_ID = re.compile(r"(run|routine_run|routine_due|task):[A-Za-z0-9][A-Za-z0-9_.:-]{0,160}")


def valid_id(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _item(kind, native, bot, title, origin, status, started, ended, cents, links):
    """title None = no human title of its own: the UI names the item by its kind, in the person's language (T11.0)."""
    return {"id": f"{kind}:{native}", "kind": kind, "bot": bot, "title": title, "origin": origin, "status": status,
            "checkpoint": None, "started_at": started, "ended_at": ended,
            "duration_s": None if started is None or ended is None else max(0, ended - started),
            "cost_cents": cents, "links": {k: v for k, v in links.items() if v is not None}}


def prompt_title(text):
    """First line the person typed: a leading server page note is skipped (A-64), an introduction instruction has no
    human title (A-49). None when there is nothing; the UI then names the run (components/labels.ts)."""
    if not isinstance(text, str) or text.startswith("[luvebot:intro]"):
        return None
    if text.startswith("[luvebot:page]"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    line = next((l.strip() for l in text.splitlines() if l.strip()), "")
    return line[:120] or None


def run_item(row, iso_to_epoch, prompts=None):
    """`prompts` = {keyed digest: text} of the person's messages in Hermes's store (RunIndex.prompt_digest); the run's own is
    the one its prompt_sha names."""
    status = _RUN.get(row["last_status"], "running" if row["last_status"] in (None, "") else "error")
    title = prompt_title((prompts or {}).get(row.get("prompt_sha")))
    return _item("run", row["run_id"], row["bot"], title, "message", status, iso_to_epoch(row["started_at"]), None, None,
                 {"run_id": row["run_id"], "session_id": row["session_id"]})


def routine_run_item(bot, session, now):
    ended = session.get("ended_at")
    active = ended is None and (now - (session.get("started_at") or 0)) < 300
    job = routine_of(session["id"])
    return _item("routine_run", session["id"], bot, session.get("title") or None, "routine",
                 "running" if active else "done", session.get("started_at"), ended,
                 cents_of(session.get("actual_usd"), session.get("estimated_usd")), {"session_id": session["id"], "job_id": job})


def due_item(bot, job):
    return _item("routine_due", job["id"], bot, job.get("name") or None, "routine", "scheduled", job.get("next_run_at") and _iso(job["next_run_at"]),
                 None, None, {"job_id": job["id"]})


def task_item(task):
    origin = "handoff" if task.get("created_by") and task.get("assignee") and task["created_by"] != task["assignee"] else "message"
    return _item("task", task["id"], task.get("assignee"), task.get("title") or None, origin, _TASK.get(task.get("status"), "scheduled"),
                 task.get("started_at"), task.get("completed_at"), None, {"task_id": task["id"]})


def _iso(value):
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except ValueError:
        return None


def tab_of(item):
    if item["status"] in ("running", "waiting_approval"):
        return "running"
    if item["status"] in ("scheduled",):
        return "scheduled"
    return "done"


def build(items, *, tab, bot=None, origin=None, status=None, since=None, until=None, min_cost_cents=None, limit=50, cursor=None):
    if tab not in TABS or (origin is not None and origin not in ORIGINS) or (status is not None and status not in STATUSES):
        raise PluginError("bad_request", "Invalid filter.", 400)
    chosen = [i for i in items if tab_of(i) == tab and (bot is None or i["bot"] == bot) and (origin is None or i["origin"] == origin)
              and (status is None or i["status"] == status)
              and (since is None or (i["started_at"] or 0) >= since) and (until is None or (i["started_at"] or 0) <= until)
              and (min_cost_cents is None or (i["cost_cents"] or 0) >= min_cost_cents)]
    chosen.sort(key=lambda i: (i["started_at"] is None, -(i["started_at"] or 0), i["id"]) if tab != "scheduled"
                else (i["started_at"] is None, i["started_at"] or 0, i["id"]))
    try:
        offset = 0 if cursor is None else int(cursor)
        if offset < 0 or (cursor is not None and not re.fullmatch(r"[0-9]{1,9}", cursor)):
            raise ValueError
    except ValueError:
        raise PluginError("bad_request", "Invalid paging parameters.", 400) from None
    page = chosen[offset:offset + limit]
    return page, (str(offset + limit) if offset + limit < len(chosen) else None)


# ---- item actions (T4.6) ---------------------------------------------------------------------------------------------
def parse_id(value):
    """-> (kind, native id). 404 activity_not_found for anything that is not an id this module could have issued."""
    if not valid_id(value):
        raise PluginError("activity_not_found", "Activity item not found.", 404)
    kind, _, native = value.partition(":")
    return kind, native


def _strict(body, allowed, required=()):
    if not isinstance(body, dict) or set(body) - set(allowed) or not set(required) <= set(body):
        raise PluginError("bad_request", "Invalid request body.", 400)
    return body


def _optional_reason(body):
    reason = body.get("reason")
    if reason is not None and (not isinstance(reason, str) or len(reason) > 500):
        raise PluginError("invalid_field", "Invalid value for reason.", 422)
    return reason.strip() if isinstance(reason, str) and reason.strip() else None


def validate_context(body):
    _strict(body, {"text", "kind"}, {"text", "kind"})
    text, kind = body["text"], body["kind"]
    if not isinstance(text, str) or not text.strip() or len(text) > 4000 or kind not in ("context", "correction"):
        raise PluginError("invalid_field", "Send a text of up to 4000 characters and a kind of context or correction.", 422)
    return text.strip(), kind


def validate_redirect(body):
    _strict(body, {"bot", "reclaim_first", "reason"}, {"bot"})
    reclaim = body.get("reclaim_first", False)
    if not isinstance(body["bot"], str) or not isinstance(reclaim, bool):
        raise PluginError("invalid_field", "Invalid redirect.", 422)
    return body["bot"], reclaim, _optional_reason(body)


def validate_stop(body):
    _strict(body, {"reason"})
    return _optional_reason(body)


def audit_payload(item_id, kind, **extra):
    """What the audit row digests: ids and kinds, never free text (a text is represented by its length and a hash)."""
    import hashlib
    out = {"item": item_id, "kind": kind}
    for key, value in extra.items():
        out[key] = value
    if "text" in out:
        text = out.pop("text")
        out["text_sha256"], out["text_len"] = hashlib.sha256(text.encode()).hexdigest(), len(text)
    return out
