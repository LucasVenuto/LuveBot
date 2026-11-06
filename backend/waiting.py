"""F6-B "Bot esperando você": what a Bot waits on a PERSON for, derived from the hook's `waiting` rows (hook 0.5, `hook_store.waiting`).

Hermes tells the hook every time it blocks on a person (`on_human_input_request`: a sudo password, a clarify question, a command approval)
and once more when the wait ends. The hook only writes (`waiting` / `resolved` in `hook_events`); this module only reads. It never answers
the wait and never calls Hermes back (invariant 6). What it adds is the PLATFORM of the session (from Hermes's own SessionDB, read-only), so
the one wait LuveBot already shows is not shown twice:
  * `approval` on an `api_server` session is the run's approval: the inbox has it, it is dropped here;
  * `approval` on any other platform (Telegram, CLI, Desktop) is exactly what the inbox does NOT show: kept;
  * a session whose platform cannot be read keeps its wait (a wait is never hidden by a guess);
  * a wait whose session has ENDED (`ended_at` set) is dropped: a crashed prompt must not haunt the Bot until the 24 h cut of the hook's reader;
  * `clarify` and `sudo` always stay (a clarify of an `api_server` run also comes with its card from `pending_controls`: the screen joins
    them by `session_id`; this item is the notice outside the browser).
`prompt` is text the AGENT wrote (a clarify's question): redacted, cut, plain text, and only for clarify (the others carry a command).
"""
import re

KINDS = ('clarify', 'sudo', 'approval')
MAX_PROMPT, MAX_ITEMS = 300, 50
_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', re.ASCII)
_SLUG = re.compile(r'[a-z0-9_-]{1,32}')


def session_facts(bot, session_ids, *, db_of=None):
    """{session_id: (source slug | None, ended: bool)}. One read-only SessionDB open for all; a session that cannot be read (or a store that
    cannot be opened) is (None, False), never a guess: its wait is kept."""
    ids = sorted({s for s in session_ids if isinstance(s, str) and _ID.fullmatch(s)})
    if not ids:
        return {}
    try:
        if db_of is None:
            from .hermes_cron import _session_db as db_of
        db = db_of(bot)
    except Exception:  # noqa: BLE001
        return {sid: (None, False) for sid in ids}
    found = {}
    try:
        for sid in ids:
            try:
                row = db.get_session(sid)
            except Exception:  # noqa: BLE001
                row = None
            source = row.get('source') if isinstance(row, dict) else None
            found[sid] = ((source if _SLUG.fullmatch(source) else 'other') if isinstance(source, str) and source else None,
                          isinstance(row, dict) and row.get('ended_at') is not None)
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass
    return found


def derive(rows, session_of, redact):
    """`hook_store.waiting` rows -> the items of the contract, newest first (as given), at most MAX_ITEMS. See the module doc.
    `session_of(session_id) -> (platform | None, ended)`, or None for an unknown session."""
    out = []
    for row in rows or ():
        if not isinstance(row, dict) or not isinstance(row.get('request_id'), str) or not _ID.fullmatch(row['request_id']):
            continue
        kind = row.get('kind') if row.get('kind') in KINDS else 'other'
        session = row.get('session_id') if isinstance(row.get('session_id'), str) and _ID.fullmatch(row['session_id']) else None
        platform, ended = (session_of(session) or (None, False)) if session else (None, False)
        if ended:
            continue  # the session is over: nobody is waiting on it any more
        if kind == 'approval' and platform == 'api_server':
            continue  # the inbox already shows this one
        prompt = row.get('prompt')
        out.append({'request_id': row['request_id'], 'kind': kind, 'since': float(row.get('ts') or 0), 'session_id': session, 'platform': platform,
                    'prompt': (redact(prompt)[:MAX_PROMPT] or None) if kind == 'clarify' and isinstance(prompt, str) else None})
        if len(out) >= MAX_ITEMS:
            break
    return out


def marker(path, bot):
    """-> what changes when the hook wrote a wait or its resolution for this Bot (see hook_store.waiting_marker), for the key of /waiting's memory;
    None when it cannot be told (then nothing is kept). Never raises."""
    try:
        from . import hook_store
        return hook_store.waiting_marker(path, bot)
    except Exception:  # noqa: BLE001  (cannot be told)
        return None


def read(path, bot, redact, *, reader=None, db_of=None):
    """-> the derived items of one Bot: [] when nothing waits OR when the hook that writes the rows is not shipped (an older LuveBot);
    None when the rows cannot be read (the caller lists it as partial, never as "nobody waits"). Never raises."""
    try:
        if reader is None:
            from . import hook_store
            reader = getattr(hook_store, 'waiting', None)
            if reader is None:
                return []
        rows = reader(path, bot)
        facts = session_facts(bot, [r.get('session_id') for r in rows if isinstance(r, dict)], db_of=db_of)
        return derive(rows, facts.get, redact)
    except Exception:  # noqa: BLE001
        return None
