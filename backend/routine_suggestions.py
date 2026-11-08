"""Routine suggestions from Hermes (contract v0.10 section 2): what a person is shown and whether LuveBot may create it. Pure shaping, no Hermes imports.

A record is `{id, title, description, source, job_spec, dedup_key, status, created_at}` in the profile's `cron/suggestions.json`, and EVERYTHING in it is text a model or a skill wrote: it is
cut, cleaned of control characters, redacted, and only ever shown as plain text. `job_spec` can carry fields LuveBot's Routines never show (`script`, `workdir`, `provider`, `base_url`, a delivery
target), so a suggestion is `supported` only when every key of it is one LuveBot's own create path knows, that path accepts it, and it delivers nowhere outside LuveBot. The verdict is
computed here, once, for the list and for accept alike.
"""
import hashlib
import json
import logging
import math
import re
import threading
import time
import unicodedata

from . import dbfile, routines
from .api_errors import PluginError
from .audit import AuditUnavailable
from .hermes_boundary import convert

ID = re.compile(r"[0-9a-f]{12}")                       # the 12-hex id only: Hermes's lookup also takes a 1-based index or a title, and LuveBot never passes those
SOURCES = ("catalog", "blueprint", "usage", "integration")
SPEC_KEYS = ("name", "schedule", "prompt", "skills", "model", "deliver", "no_agent", "enabled_toolsets")   # the display subset of a job spec
ACCEPTED_KEYS = routines.CREATE_KEYS - {"start", "template", "bot"}                                           # what the stored spec may carry, no more
TITLE_MAX, DESCRIPTION_MAX, PROMPT_MAX, LINE_MAX, LIST_MAX = 120, 600, 4096, 200, 20                         # characters; the prompt in UTF-8 bytes
PENDING_MAX = 5                                        # Hermes's ceiling (A-136): shown, never raised
_LOOKED_AT = 65536                                     # characters of a text that ever reach the redactor: a hostile megabyte is cut before, not after
_FIELD = re.compile(r"[A-Za-z0-9_.-]{1,40}")           # a key NAME of the stored spec that is safe to say aloud; anything else is "other"
_BIDI = frozenset(chr(c) for c in (*range(0x202A, 0x202F), *range(0x2066, 0x206A), 0x200E, 0x200F, 0x061C))


def _clean(text, line):
    """No control character (but newline and tab), no lone surrogate (it cannot be encoded in the response) and no bidi override; one line collapses its whitespace."""
    kept = "".join(c for c in text if c in "\n\t" or (unicodedata.category(c) not in ("Cc", "Cs") and c not in _BIDI))
    return " ".join(kept.split()) if line else kept


def _shape(value, limit, redact, *, line=False, utf8=False):
    """-> (shown, truncated): `value` redacted whole (never a secret cut in half), cleaned, then cut to `limit` characters (or UTF-8 bytes)."""
    if not isinstance(value, str):
        return "", False
    shown = _clean(redact(value[:_LOOKED_AT]), line)
    size = len(shown.encode("utf-8", "ignore")) if utf8 else len(shown)
    cut = len(value) > _LOOKED_AT or size > limit
    if cut:
        shown = shown.encode("utf-8", "ignore")[:limit].decode("utf-8", "ignore") if utf8 else shown[:limit]
    return shown, cut


def _names(value, redact):
    if not isinstance(value, list):
        return None
    return [_shape(v, 128, redact, line=True)[0] for v in value[:LIST_MAX] if isinstance(v, str)]


def _display(job_spec, redact):
    """-> (spec, prompt_cut): the keys of SPEC_KEYS that are there, each as plain bounded data; a value that is not the shape of its key is left out."""
    spec, prompt_cut = {}, False
    for key in SPEC_KEYS:
        if key not in job_spec:
            continue
        value = job_spec[key]
        if key == "prompt":
            shown, prompt_cut = _shape(value, PROMPT_MAX, redact, utf8=True)
            if isinstance(value, str):
                spec[key] = shown
        elif key in ("name", "schedule", "model", "deliver"):
            if isinstance(value, str):
                spec[key] = _shape(value, LINE_MAX, redact, line=True)[0]
        elif key == "no_agent":
            spec[key] = bool(value)
        else:
            shown = _names(value, redact)
            if shown is not None:
                spec[key] = shown
    return spec, prompt_cut


def _field(name):
    return name if _FIELD.fullmatch(name) else "other"


def _verdict(bot, job_spec, too_large):
    """-> (why_not | None, field names | None). The first reason that holds, in the contract's order."""
    if not isinstance(job_spec, dict):
        return "invalid_spec", None
    odd = sorted(str(k) for k in job_spec if k not in ACCEPTED_KEYS)
    if odd:
        return "unsupported_fields", [_field(k) for k in odd[:LIST_MAX]]          # the NAMES, never the values
    deliver = job_spec.get("deliver")
    if isinstance(deliver, str) and deliver != "local":
        return "delivery_outside", None                                           # a model-written spec could send results outside LuveBot without a tool call: never created from here
    if job_spec.get("no_agent"):
        return "no_agent", None
    try:
        routines.validate_create({"bot": bot, **job_spec})
    except PluginError:
        return "invalid_spec", None
    if too_large:
        return "too_large", None
    return None, None


def view(bot, record, redact=lambda text: text):
    """The item of GET /routine-suggestions for one Hermes record, or None for a record that cannot be acted on (not an object, not pending, no 12-hex id)."""
    if not isinstance(record, dict) or record.get("status") not in (None, "pending"):
        return None
    sid = record.get("id")
    if not (isinstance(sid, str) and ID.fullmatch(sid)):
        return None
    title, title_cut = _shape(record.get("title"), TITLE_MAX, redact, line=True)
    description, description_cut = _shape(record.get("description"), DESCRIPTION_MAX, redact)
    job_spec = record.get("job_spec")
    spec, prompt_cut = _display(job_spec, redact) if isinstance(job_spec, dict) else ({}, False)
    why, fields = _verdict(bot, job_spec, title_cut or description_cut or prompt_cut)
    source = record.get("source")
    created = record.get("created_at")
    if isinstance(created, str):
        created = _shape(created, 40, redact, line=True)[0]
    elif isinstance(created, bool) or not (isinstance(created, (int, float)) and math.isfinite(created)):
        created = None
    item = {"bot": bot, "id": sid, "title": title, "description": description, "source": source if source in SOURCES else "other", "created_at": created, "spec": spec,
            "supported": why is None, "truncated": {"title": title_cut, "description": description_cut, "prompt": prompt_cut}}
    if why is not None:
        item["why_not"] = why
        if fields:
            item["fields"] = fields
    return item


def _order(item):
    created = item["created_at"]
    if isinstance(created, (int, float)):
        return (0, created, "")
    return (1, 0, created) if isinstance(created, str) else (2, 0, "")   # a time, then a text, then none: oldest first


def items_of(bot, records, redact=lambda text: text):
    """The pending suggestions of one Bot, oldest first, at most PENDING_MAX; a record that is not usable is left out, never guessed."""
    if not isinstance(records, list):
        return []
    items = [item for item in (view(bot, record, redact) for record in records) if item is not None]
    return sorted(items, key=_order)[:PENDING_MAX]


# ---- accept and dismiss (contract v0.10 2.1) ----------------------------------------------------------------------------------------------------------
# LuveBot never calls Hermes's `accept_suggestion`: it creates the job ACTIVE from a spec a model wrote. It validates the spec with its own rules, creates the routine through its own create path,
# PAUSED, and only then marks Hermes's record accepted with the module's own setter. Everything below is synchronous: the caller runs it in the thread pool.
_ACCEPTS = "CREATE TABLE IF NOT EXISTS suggestion_accepts (bot TEXT NOT NULL, suggestion_id TEXT NOT NULL, job_id TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY (bot, suggestion_id))"
_STRIPES = tuple(threading.Lock() for _ in range(64))   # one lock per (bot, id), by stripe: two clicks on the same suggestion never make two jobs (a stripe shared by two others only makes them wait)
PAUSED_REASON = "Created paused; awaiting operator approval."
log = logging.getLogger("luvebot.suggestions")


def _stripe(bot, suggestion_id):
    return _STRIPES[hash((bot, suggestion_id)) % len(_STRIPES)]


def _not_pending():
    return PluginError("suggestion_not_pending", "This suggestion is not pending any more.", 409)


def accepted_ids(path, bot):
    """{suggestion id: job id} of the suggestions of this Bot that LuveBot already turned into a routine."""
    conn = dbfile.connect(path)
    try:
        conn.execute(_ACCEPTS)
        return dict(conn.execute("SELECT suggestion_id, job_id FROM suggestion_accepts WHERE bot=?", (bot,)))
    finally:
        conn.close()


def _remember(path, bot, suggestion_id, job_id):
    conn = dbfile.connect(path)
    try:
        with conn:
            conn.execute(_ACCEPTS)
            conn.execute("INSERT OR IGNORE INTO suggestion_accepts VALUES (?,?,?,?)", (bot, suggestion_id, job_id, time.time()))
    finally:
        conn.close()


def spec_digest(job_spec):
    return hashlib.sha256(json.dumps(job_spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8", "ignore")).hexdigest()


def start_of(body):
    """{start?: bool} and nothing else (a JSON boolean, default false)."""
    if not isinstance(body, dict):
        raise PluginError("bad_request", "Invalid request body.", 400)
    extra = set(body) - {"start"}
    if extra:
        raise PluginError("invalid_field", "Unsupported field: " + ", ".join(sorted(map(str, extra)))[:200] + ".", 422)
    start = body.get("start", False)
    if not isinstance(start, bool):
        raise PluginError("invalid_field", "Invalid value for start.", 422)
    return start


def _pending(hermes, bot, suggestion_id):
    """-> (record, item) of a pending suggestion, else 409. The id is the 12-hex id only (Hermes's lookup also takes an index or a title) and the record that comes back must BE that id."""
    if not ID.fullmatch(suggestion_id):
        raise _not_pending()
    record = hermes.get_suggestion(bot, suggestion_id)
    item = view(bot, record)
    if item is None or record.get("id") != suggestion_id:
        raise _not_pending()
    return record, item


def _resolve(hermes, bot, suggestion_id):
    """Mark the record accepted, best effort and converted at the source (a config outage here must not undo an answer whose job already exists): the row of `suggestion_accepts` repairs it on the next list."""
    try:
        convert(hermes.resolve_accepted)(bot, suggestion_id)
        return True
    except Exception as error:  # noqa: BLE001
        log.warning("suggestion could not be marked accepted: %s", type(error).__name__)   # the class only
        return False


def _started(job):
    return bool(job.get("enabled")) and job.get("state") != "paused"


def accept(audit, path, actor, bot, suggestion_id, start, hermes, cron, start_job):
    """POST .../accept -> {job, started, held, replayed}. Single-flight per (bot, id) and idempotent through `suggestion_accepts`: a retry after the job exists resolves the record again and returns the
    SAME routine. The routine is created paused; with `start` it is started only if `start_job` (the gates of POST /routines/{id}/resume) allows it, else it stays paused and `held` is the code."""
    from .hermes_client import HermesError   # here, not at the top: that module imports Hermes, and the shaping above must work (and be tested) without it
    if not ID.fullmatch(suggestion_id):
        raise _not_pending()
    with _stripe(bot, suggestion_id):
        done = accepted_ids(path, bot).get(suggestion_id)
        if done is not None:
            job = cron.get(bot, done)
            _resolve(hermes, bot, suggestion_id)
            if job is None:   # the person removed it since: there is nothing to return, and the record is no longer pending either
                raise _not_pending()
            return {"job": job, "started": _started(job), "held": None, "replayed": True}
        record, item = _pending(hermes, bot, suggestion_id)
        if not item["supported"]:
            raise PluginError("suggestion_not_supported", "LuveBot cannot create this suggestion; accept it in Hermes.", 409, {"details": {"why_not": item["why_not"]}})
        _bot, fields, _start, _template = routines.validate_create({"bot": bot, **record["job_spec"]})   # the same validation as POST /routines
        fields.setdefault("prompt", "")
        origin = {"kind": "ui"}

        def effect():
            job = audit.act(actor, "routine.create", None, origin, lambda: cron.create(bot, **fields, paused=True, paused_reason=PAUSED_REASON), bot=bot,
                            payload={"keys": sorted(fields), "start": False, "suggestion": True})
            _remember(path, bot, suggestion_id, job["id"])
            return job
        job = audit.act(actor, "suggestion.accept", suggestion_id, origin, effect, bot=bot, payload={"keys": sorted(fields), "spec": spec_digest(record["job_spec"])})
        _resolve(hermes, bot, suggestion_id)
        started, held = False, None
        if start:
            try:
                job = audit.act(actor, "routine.resume", job["id"], origin, lambda: convert(start_job)(job["id"]), bot=bot) or job
                started = True
            except AuditUnavailable:
                raise
            except (PluginError, HermesError) as error:
                held = error.code
            except Exception:  # noqa: BLE001  (Hermes's text never leaves: our static code)
                held = "hermes_error"
        return {"job": job, "started": started, "held": held, "replayed": False}


def dismiss(audit, actor, bot, suggestion_id, hermes):
    """POST .../dismiss: a tightening (it creates nothing and latches the `dedup_key` in Hermes), audited. 409 when it is not pending."""
    with _stripe(bot, suggestion_id):
        _pending(hermes, bot, suggestion_id)

        def effect():
            if not hermes.dismiss_suggestion(bot, suggestion_id):
                raise _not_pending()
        audit.act(actor, "suggestion.dismiss", suggestion_id, {"kind": "ui"}, effect, bot=bot)


def repaired(audit, path, bot, records, hermes):
    """The pending records of one Bot minus those LuveBot already made a routine from (its row says so): a record left pending because the setter failed is marked accepted now, audited, best effort."""
    if not isinstance(records, list):
        return records
    done = accepted_ids(path, bot)
    if not done:
        return records
    kept = []
    for record in records:
        suggestion_id = record.get("id") if isinstance(record, dict) else None
        if suggestion_id not in done:
            kept.append(record)
            continue
        try:
            audit.act("system", "suggestion.repair", suggestion_id, {"kind": "system"}, lambda: convert(hermes.resolve_accepted)(bot, suggestion_id), bot=bot)
        except Exception as error:  # noqa: BLE001
            log.warning("suggestion repair failed: %s", type(error).__name__)
    return kept
