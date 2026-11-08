"""Contract v0.4 (B1, B2, B3, B4, B6, B7): history, unread, pause, introduction, SOUL and where "working" comes from.

Hermes code used, all at commit f8489405, all IN the dashboard process (invariant 4: writes only through Hermes's functions):
  sessions   SessionDB.list_sessions_rich (hermes_state_sessions.py#L1317), `_is_active` (web_routers/sessions.py#L132),
             `get_session_messages` (web_routers/sessions.py#L642, inline_images flag #L645). The list ROUTE is not called: it
             auto-archives on a GET (#L177).
  ESTOP      agent/estop.py: candidates #L36, engage #L64, disengage #L77 (removes EVERY visible sentinel), get_state #L89.
  SOUL       web_routers/profiles.py: get #L991, put #L1006, description #L1028.
  Kanban     plugins/kanban/dashboard/plugin_api.py `list_active_workers` #L908.
Every text that leaves here is redacted by the caller's `redact` and capped.
"""
from datetime import datetime, timezone
import asyncio
import contextlib
import hashlib
import json
import os
import re
import sqlite3
import threading
import time

from .api_errors import PluginError
from . import dbfile, hermes_boundary, reactions, skill_teach, tool_masks
from .audit import AuditUnavailable
from .runs import RunRefused, is_paused  # runs.budget_gate imports work_gate lazily (no cycle at load)

INTRO_MARKER = '[luvebot:intro]'
SOUL_BEGIN, SOUL_END = '<!-- luvebot:rules:begin -->', '<!-- luvebot:rules:end -->'
SOUL_MAX = 64 * 1024
USER, ALL = 'luvebot:user:', 'luvebot:all:'
# One lock for every pause change and every check that work may start: a pause cannot land between the check and the start.
# ponytail: process lock; the dashboard is one process (no new listener, invariant 3).
LOCK = threading.RLock()
_SCHEMA = """
CREATE TABLE IF NOT EXISTS bot_read_state (bot TEXT PRIMARY KEY, read_through REAL NOT NULL, updated_at REAL NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bot_user_pause (bot TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS bot_user_jobs (bot TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY (bot, job_id));
CREATE TABLE IF NOT EXISTS inactivity_jobs (bot TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY (bot, job_id));
"""


def _db(path):
    conn = dbfile.connect(path)
    conn.row_factory = sqlite3.Row
    dbfile.ensure(conn, path, _SCHEMA)
    return conn


def _sql(path, sql, args=()):
    conn = _db(path)
    try:
        rows = conn.execute(sql, args).fetchall()
        conn.commit()
        return rows
    finally:
        conn.close()


def as_shown(text, redact):
    """The text as the browser gets it: inline images become [image] even inside plain text, and a secret becomes asterisks."""
    text = text if isinstance(text, str) else ''
    return redact(re.sub(r'data:image/[\w.+-]+;base64,[A-Za-z0-9+/=\r\n]+', '[image]', text))


def capped(text, redact, size):
    """(redacted text, truncated). Inline images become [image] even inside plain text."""
    raw = as_shown(text, redact).encode('utf-8')
    return raw[:size].decode('utf-8', 'ignore'), len(raw) > size


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def offset_of(cursor):
    if cursor is None:
        return 0
    if not isinstance(cursor, str) or not re.fullmatch(r'[0-9]{1,9}', cursor):
        raise PluginError('bad_request', 'Invalid cursor.', 400)
    return int(cursor)


# ---- B1 history -------------------------------------------------------------------------------------------------------
def _session_db(bot):
    from .hermes_cron import _session_db as opener
    return opener(bot)


def session_rows(bot, *, limit, offset=0, source=None, q=None, every_source=False):
    from hermes_cli.web_routers.sessions import _is_active
    exclude = None if every_source else ['bot_room'] if source == 'cron' else ['bot_room', 'cron']
    db = _session_db(bot)
    try:
        rows = db.list_sessions_rich(limit=limit, offset=offset, source=source, exclude_sources=exclude, search_query=q,
                                     order_by_last_active=True, compact_rows=True)
    finally:
        db.close()
    now = time.time()
    return [{**row, 'is_active': _is_active(row, now)} for row in rows]


def session_view(row, redact, intro_session=None):
    source = row.get('source') or 'unknown'
    kind = ('introduction' if row.get('id') == intro_session else 'routine' if source == 'cron' else
            'conversation' if source in ('api_server', 'cli', 'web', 'unknown') else 'channel')
    view = {k: row.get(k) for k in ('id', 'started_at', 'last_active', 'ended_at', 'message_count')}
    view.update(title=capped(row.get('title'), redact, 512)[0] or None, source=capped(source, redact, 64)[0],
                is_active=bool(row.get('is_active')), kind=kind)
    return view


def owned_session(bot, sid):
    """The resume tip of an exact id (never a prefix guess) that belongs to this profile and is not a room's; else 404.
    Same ownership reading as Hermes's own timeline route (web_routers/sessions.py `_timeline_session_id`)."""
    db = _session_db(bot)
    try:
        def mine(session_id):
            row = db._read_one('SELECT profile_name, source FROM sessions WHERE id = ?', (session_id,))
            return row is not None and row['profile_name'] in (None, bot) and row['source'] != 'bot_room'
        tip = db.resolve_resume_session_id(sid) if mine(sid) else None
        if tip is None or not mine(tip):
            raise PluginError('session_not_found', 'Session not found.', 404)
        return tip
    finally:
        db.close()


DELEGATION_DELIVERY = 'async_delegation_complete'  # Hermes's row for a subagent's result in an API session (gateway/wake.py#L118-L183)
_DELEGATION_COUNTS = ('task_count', 'completed_count', 'failed_count')


def delegation_metadata(raw, redact):
    """The minimum of a delegation delivery's display_metadata (hermes_state_messages.py#L414-L427): the id and four numbers,
    each checked; nothing else Hermes or a later version puts there leaves (a summary, a flag, an error text)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    if isinstance(raw.get('delegation_id'), str) and raw['delegation_id']:
        out['delegation_id'] = capped(raw['delegation_id'], redact, 128)[0]
    for key in _DELEGATION_COUNTS:
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 10_000:
            out[key] = value
    duration = raw.get('duration_seconds')
    if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 <= duration < 10 ** 7:
        out['duration_seconds'] = duration
    return out


def message_view(row, redact, intro=False, drafts=frozenset()):
    """`intro`: the row is in the Bot's INTRODUCTION session, the one LuveBot created and recorded (`intro_session_id`). LuveBot's hidden turn is recognised only there: a user row is also what a
    channel contact, or a person on another front end of the API server, typed, and a message that merely starts with the marker must stay on screen (F-SK4). `drafts`: the nonces LuveBot recorded for this
    conversation (`skill_teach.draft_nonces`); a user turn is hidden only when its first line is exactly the marker of one of them (v0.11 3.2)."""
    role = row.get('role')
    if role not in ('user', 'assistant', 'tool'):
        return None  # system rows and anything new stay out
    content = row.get('display_content') or row.get('content')
    if intro and role == 'user' and isinstance(content, str) and content.startswith(INTRO_MARKER):
        return None  # A-49: the first visible message is the Bot's own reply (only in the session LuveBot made for it)
    if role == 'user' and skill_teach.hides(content, drafts):
        # the turn LuveBot sent to ask the Bot for a skill draft (recorded nonce only): one placeholder row in its place, so the screen draws "Asked your Bot for a skill draft" after a reload too (A-175);
        # never the instruction and never the note
        return {'id': row.get('id'), 'role': 'user', 'text': '', 'at': row.get('timestamp'), 'display_kind': 'skill_draft'}
    page_ref = None
    if role == 'user' and isinstance(content, str) and content.startswith('[luvebot:page]'):  # v0.5 A-64: a chip, never the note
        first, _, content = content.partition('\n')
        content = content.lstrip('\n')
        found = re.search(r'pages/([a-z0-9][a-z0-9-]{0,63})\.md', first)
        page_ref = {'slug': found.group(1)} if found else None
    text, truncated = capped(content, redact, 32 * 1024)
    view = {'id': row.get('id'), 'role': role, 'text': text, 'at': row.get('timestamp'), 'truncated': truncated}
    if page_ref:
        view['page_ref'] = page_ref
    if row.get('tool_name'):
        view['tool_name'] = capped(row['tool_name'], redact, 128)[0]
    mark = row.get('masked')
    if isinstance(mark, dict) and mark.get('kind') in ('read', 'hidden'):   # a mask replaced the text: the screen draws its own words for the kind, and the shown path and the size only when the mask gave them (a reader of that context)
        view['masked'] = {'kind': mark['kind']}
        if isinstance(mark.get('path'), str):
            view['masked']['path'] = capped(mark['path'], redact, 512)[0]
        if type(mark.get('size')) is int and mark['size'] >= 0:
            view['masked']['size'] = mark['size']
    if row.get('display_kind') in ('steer', 'failed_turn', 'hidden', DELEGATION_DELIVERY):
        view['display_kind'] = row['display_kind']  # a delegation delivery is stored as role user: never the person's bubble (b4)
    if row.get('display_kind') == DELEGATION_DELIVERY:
        view['display_metadata'] = delegation_metadata(row.get('display_metadata'), redact)
    elif role in ('user', 'assistant') and (marks := reactions.views(row.get('display_metadata'), redact)):
        view['reactions'] = marks  # v0.8 section 4: only {emoji, author}; the rest of the record never leaves
    calls = row.get('tool_calls')
    if isinstance(calls, str):
        try:
            calls = json.loads(calls)
        except ValueError:
            calls = None
    if isinstance(calls, list):
        # names only: arguments may hold paths, tokens or pasted text (v0 6.3)
        view['tool_calls'] = [{'name': capped((c.get('function') or {}).get('name'), redact, 128)[0], 'args_summary': None}
                              for c in calls[:20] if isinstance(c, dict) and isinstance(c.get('function'), dict)]
    if '[image]' in text:
        view['images'] = [{'count': text.count('[image]')}]
    return view


def messages(bot, sid, limit, before, redact, intro_session=None, drafts_db=None, viewer=None):
    """`intro_session`: the id LuveBot recorded for this Bot's introduction (or None): only in that session is the introduction turn hidden. `drafts_db`: the LuveBot database, where the nonces of the
    skill-draft turns sent in this conversation (or its tip) are recorded: only those turns are hidden."""
    from hermes_cli.web_routers.sessions import get_session_messages
    tip = owned_session(bot, sid)
    intro = intro_session is not None and intro_session in (sid, tip)
    offset = offset_of(before)
    page = asyncio.run(get_session_messages(tip, profile=bot, limit=limit, offset=offset, order='latest',
                                            include_compacted=False, inline_images=False))
    raw = page.get('messages') or []
    drafts = skill_teach.draft_nonces(drafts_db, (sid, tip)) if drafts_db else frozenset()
    masks = tool_masks.scan(raw)   # what a tool returned is for a mask to say (backend/tool_masks.py): `viewer` is who asked
    raw = [tool_masks.mask_row(masks, row, viewer) for row in raw]
    shown = [view for row in raw if (view := message_view(row, redact, intro, drafts)) is not None]
    return {'messages': shown, 'next_cursor': str(offset + len(raw)) if len(raw) == limit else None}


# ---- B2 unread -------------------------------------------------------------------------------------------------------
def read_mark(path, bot):
    rows = _sql(path, 'SELECT read_through FROM bot_read_state WHERE bot=?', (bot,))
    return rows[0][0] if rows else 0.0


def routine_results_since(bot, since):
    db = _session_db(bot)
    try:
        return db._read_one("SELECT COUNT(*) AS n FROM sessions WHERE source='cron' AND ended_at > ?", (since,))['n']
    finally:
        db.close()


def unread(path, bot, routine_results):
    """A-46: LuveBot runs that completed, and routine runs that ended, after the mark. `routine_results` is counted by the
    caller (it reads Hermes; None when that read failed)."""
    conn = _db(path)  # one connection for the mark and the count
    try:
        marks = conn.execute('SELECT read_through FROM bot_read_state WHERE bot=?', (bot,)).fetchall()
        since = marks[0][0] if marks else 0.0
        # The count is made by the database, over run_index_ended (bot, last_status, ended_at): it used to load EVERY completed run of the Bot and
        # parse each date in Python on every poll (10 ms per Bot at 10 000 runs). `ended_at` is microseconds in one fixed UTC form
        # (RunIndex.set_status, since it was added), and so is the floor: same length, so text order is time order, and a run that ended 0.2 s
        # after a mark in the same second is after it (a floor in whole seconds put every end of the mark's own second below it).
        floor = datetime.fromtimestamp(since, timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
        replies = conn.execute("SELECT COUNT(*) FROM run_index WHERE bot=? AND last_status='completed' AND ended_at IS NOT NULL AND ended_at > ?",
                               (bot, floor)).fetchone()[0]
    finally:
        conn.close()
    return {'count': replies + (routine_results or 0), 'replies': replies, 'routine_results': routine_results, 'since': since}


def mark_read(path, audit, bot, through, actor, *, now=None):
    """Moves the mark forward only. A call that does not move it writes nothing, not even an audit row."""
    try:
        stamp = datetime.fromisoformat(through.replace('Z', '+00:00'))
        if stamp.utcoffset() is None or stamp.utcoffset().total_seconds() != 0:
            raise ValueError
        wanted = stamp.timestamp()
    except (AttributeError, TypeError, ValueError, OverflowError):
        raise PluginError('invalid_field', 'through must be an ISO-8601 UTC timestamp.', 422) from None
    now = time.time() if now is None else now
    new = min(wanted, now + 60)
    with LOCK:
        rows = _sql(path, 'SELECT read_through, updated_at FROM bot_read_state WHERE bot=?', (bot,))
        old = rows[0]['read_through'] if rows else 0.0
        if new <= old:
            return False
        if rows and now - rows[0]['updated_at'] < 1:
            raise PluginError('rate_limited', 'Marking as read is limited to once a second per Bot.', 429)
        audit.act(actor, 'bot.read', bot, 'ui', lambda: _sql(
            path, 'INSERT INTO bot_read_state VALUES (?,?,?,?) ON CONFLICT(bot) DO UPDATE SET '
                  'read_through=MAX(read_through, excluded.read_through), updated_at=excluded.updated_at, updated_by=excluded.updated_by',
            (bot, new, now, actor)), bot=bot, payload={'previous': old, 'through': new})
    return True


# ---- B3 pause --------------------------------------------------------------------------------------------------------
def _estop_in(profile):
    """HERMES_HOME scoped to `profile` for Hermes's estop functions ('default' is the fleet root). The await-safe contextvar
    scope (web_server_profiles.py#L277), not the write scope: ESTOP touches no config and no skill-module global."""
    from hermes_cli.web_routers._common import _config_profile_scope
    return _config_profile_scope(profile)


def root_state():
    from agent import estop
    with _estop_in('default'):
        return estop.get_state()


def _kind(state, ours):
    return None if state is None else ('all' if ours == ALL else 'user') if str(state.get('reason') or '').startswith(ours) else 'estop'


def fleet_view():
    return {'paused': (state := root_state()) is not None, 'reason_kind': _kind(state, ALL)}


def pause_state(path, bot, *, consistent=True):
    """{paused, reason_kind (all|estop|user|None), scope}. The root sentinel wins; then the Bot's own sentinel; then our hold.
    `consistent` (the work gate) reads under LOCK so a pause cannot land between the check and the start; a display read
    (GET /bots) passes False and does not queue the Bots behind one global lock. The reads and their failures are the same."""
    from agent import estop
    with LOCK if consistent else contextlib.nullcontext():
        root = root_state()
        if root is not None:
            return {'paused': True, 'reason_kind': _kind(root, ALL), 'scope': 'fleet'}
        if bot != 'default':
            with _estop_in(bot):
                own = estop.get_state()
            if own is not None:
                return {'paused': True, 'reason_kind': _kind(own, USER), 'scope': 'profile'}
        held = bool(_sql(path, 'SELECT 1 FROM bot_user_pause WHERE bot=?', (bot,)))
        return {'paused': held, 'reason_kind': 'user' if held else None,
                'scope': ('luvebot_only' if bot == 'default' else 'profile') if held else None}


def work_gate(path, bot):
    """Every LuveBot entry that starts work asks this first: the API Server does not check ESTOP (api_server.py#L4033)."""
    if pause_state(path, bot)['paused']:
        raise RunRefused('bot_paused', 'This Bot is paused; no new work was started.', 409)


CRON_PAUSES = {'luvebot:user': 'bot_user_jobs', 'luvebot:inactivity': 'inactivity_jobs'}  # each reason remembers its own jobs


def _cron_jobs_pause(path, bot, cron, reason='luvebot:user'):
    """`default` (A-47): its home is the fleet root, so no ESTOP; its enabled jobs are paused and remembered as ours. Also the
    inactivity pause (v0.8 section 8), with its own reason and table, so a later resume touches only what that one paused.
    -> the job ids paused now."""
    table, paused = CRON_PAUSES[reason], []
    for job in cron.list_jobs(bot):
        if job.get('enabled') is not False and job.get('state') not in ('paused', 'completed'):
            _sql(path, f'INSERT OR IGNORE INTO {table} VALUES (?,?)', (bot, job['id']))  # remembered before the effect
            cron.pause(bot, job['id'], reason)
            paused.append(job['id'])
    return paused


def _remembered(path, bot, reason):
    """The job ids this reason paused for this Bot and still remembers."""
    return [r[0] for r in _sql(path, f'SELECT job_id FROM {CRON_PAUSES[reason]} WHERE bot=?', (bot,))]


def _cron_jobs_resume(path, bot, cron, reason='luvebot:user'):
    """Resume only the jobs THIS reason paused and that are still paused by it; -> the job ids resumed."""
    table, resumed = CRON_PAUSES[reason], []
    ours = set(_remembered(path, bot, reason))
    for job in cron.list_jobs(bot):
        if job['id'] in ours and job.get('state') == 'paused' and job.get('paused_reason') == reason:
            cron.resume(bot, job['id'])
            resumed.append(job['id'])
    _sql(path, f'DELETE FROM {table} WHERE bot=?', (bot,))
    return resumed


def pause(path, bot, actor, cron=None):
    """Runs inside audit.act. Idempotent; a pause that already exists (ours or not) is kept as it is."""
    from agent import estop
    with LOCK:
        _sql(path, 'INSERT OR IGNORE INTO bot_user_pause VALUES (?,?)', (bot, time.time()))  # LuveBot refuses work even if ESTOP fails
        if bot == 'default':
            from .hermes_cron import HermesCron
            _cron_jobs_pause(path, bot, cron or HermesCron())
            return {'paused': True, 'scope': 'luvebot_only'}
        with _estop_in(bot):
            if estop.get_state() is None:
                estop.engage(reason=USER + actor)
            if estop.get_state() is None:
                raise PluginError('hermes_error', 'Hermes did not engage the pause.', 502)
        return {'paused': True, 'scope': 'profile'}


def resume(path, bot, cron=None):
    """Runs inside audit.act. Never calls disengage() while a root or foreign sentinel is visible: it removes them all."""
    from agent import estop
    with LOCK:
        if root_state() is not None:
            raise RunRefused('paused_all', 'Everything is paused; resume everything first.', 409)
        if is_paused(path, bot):
            raise RunRefused('budget_held', 'The budget holds this Bot; resume it from the budget.', 409)
        if bot == 'default':
            from .hermes_cron import HermesCron
            _cron_jobs_resume(path, bot, cron or HermesCron())
        else:
            with _estop_in(bot):
                own = estop.get_state()
                if own is not None and not str(own.get('reason') or '').startswith(USER):
                    raise RunRefused('not_ours', 'This pause was not set by LuveBot; it stays as it is.', 409)
                if own is not None:
                    estop.disengage()
                    if estop.get_state() is not None:
                        raise PluginError('hermes_error', 'Hermes did not lift the pause.', 502)
        _sql(path, 'DELETE FROM bot_user_pause WHERE bot=?', (bot,))
        return {'paused': False, 'scope': 'luvebot_only' if bot == 'default' else 'profile'}


def pause_all(actor):
    from agent import estop
    with LOCK, _estop_in('default'):
        if estop.get_state() is None:
            estop.engage(reason=ALL + actor)
        if estop.get_state() is None:
            raise PluginError('hermes_error', 'Hermes did not engage the pause.', 502)
        return {'paused': True, 'scope': 'fleet'}


def resume_all():
    """Lifts only a root sentinel of ours; Bot pauses and budget holds stay (they live elsewhere)."""
    from agent import estop
    with LOCK, _estop_in('default'):
        state = estop.get_state()
        if state is not None and not str(state.get('reason') or '').startswith(ALL):
            raise RunRefused('not_ours', 'This pause was not set by LuveBot; it stays as it is.', 409)
        if state is not None:
            estop.disengage()
            if estop.get_state() is not None:
                raise PluginError('hermes_error', 'Hermes did not lift the pause.', 502)
        return {'paused': False, 'scope': 'fleet'}


# ---- B4 introduction -------------------------------------------------------------------------------------------------
def run_estimate(bot, floor=1):
    """Cents shown before a confirmed run: the Bot's newest ended session of the last 7 days, never under `floor` (v0.2 A-33).
    An estimate, never presented as an actual cost; an unreadable store gives the floor."""
    from .cost_watcher import cents_of
    from .hermes_cron import sessions_for_cost
    try:
        ended = sorted((r for r in sessions_for_cost(bot, time.time() - 7 * 86400) if r.get('ended_at')), key=lambda r: r['ended_at'], reverse=True)
        return max(floor, next((c for r in ended if (c := cents_of(r['actual_usd'], r['estimated_usd']))), 0))
    except Exception:
        return floor


def intro_instruction(template, display):
    """Built by the server from LuveBot's own template and display data; no client text."""
    call_me = display.get('call_me')
    return (INTRO_MARKER + ' Apresente-se ao seu novo usuário em até 3 frases, no seu tom, sem usar ferramentas. Base: '
            + template['intro_prompt'] + '\nSeu nome: ' + display['label'] + ('\nChame o usuário de: ' + call_me if call_me else ''))


# ---- B6 SOUL ---------------------------------------------------------------------------------------------------------
def split_soul(content):
    """(user part, managed block, before, after). A malformed block is never "repaired" by a save."""
    begins, ends = content.count(SOUL_BEGIN), content.count(SOUL_END)
    if begins == ends == 0:
        return content, '', content, ''
    start, end = content.find(SOUL_BEGIN), content.find(SOUL_END)
    if begins != 1 or ends != 1 or start > end:
        raise PluginError('stale', 'The managed rules block of this SOUL is malformed; nothing was changed.', 409)
    end += len(SOUL_END)
    return content[:start] + content[end:], content[start:end], content[:start], content[end:]


def validate_soul(content):
    if not isinstance(content, str) or SOUL_BEGIN in content or SOUL_END in content:
        raise PluginError('invalid_field', 'The SOUL text must not contain the managed rules markers.', 422)
    if len(content.encode('utf-8')) > SOUL_MAX:
        raise PluginError('too_large', 'The SOUL text is larger than 64 KiB.', 413)
    return content


def _read_soul(bot):
    from hermes_cli.web_routers.profiles import get_profile_soul
    return asyncio.run(get_profile_soul(bot))


def soul_view(bot, redact):
    found = _read_soul(bot)
    user, block, _, _ = split_soul(found.get('content') or '')
    text, truncated = capped(user, redact, SOUL_MAX)
    # `redacted`: what the person is shown is NOT what the file holds (a secret became asterisks, an image became [image]). The digest below is the REAL text's, so saving the shown text would
    # write the asterisks over the secret: the editor must not offer it (and `update_soul` refuses it anyway).
    return {'content': text, 'expected_digest': digest(user), 'truncated': truncated, 'redacted': as_shown(user, redact) != user, 'exists': bool(found.get('exists')),
            'rules_block': {'present': bool(block), 'digest': digest(block) if block else None}}


def merge_soul(content, block, before, after):
    """Puts the block back where it was relative to the text the person did not touch; at the end otherwise."""
    if not block:
        return content
    if content.startswith(before):
        return before + block + content[len(before):]
    if after and content.endswith(after):
        return content[:len(content) - len(after)] + block + after
    return content + ('' if content.endswith('\n') or not content else '\n') + block


def update_soul(bot, content, expected, redact):
    """Runs inside audit.act. The block is kept byte for byte; a file changed since it was loaded is 409 stale; a SOUL that holds anything the browser is shown differently (a secret, an
    image) is 422 `soul_redacted` EVEN with the right digest: what the person edited is the redacted text, and writing it back would replace the secret with asterisks (data loss); a SOUL over
    64 KiB, shown cut, is 422 `soul_truncated` for the same reason (after `soul_redacted`)."""
    from hermes_cli.web_models import ProfileSoulUpdate
    from hermes_cli.web_routers.profiles import update_profile_soul
    with LOCK:
        user, block, before, after = split_soul(_read_soul(bot).get('content') or '')
        if digest(user) != expected:
            raise RunRefused('stale', 'The SOUL changed since it was loaded; reload it before saving.', 409)
        if as_shown(user, redact) != user:
            raise PluginError('soul_redacted', 'This SOUL holds text LuveBot hides (a key, a line that looks like a password, or an image), so saving it here would overwrite that text. Edit it in Hermes.', 422)
        if capped(user, redact, SOUL_MAX)[1]:  # the other flag of the same loss: a SOUL over 64 KiB is SHOWN cut (`truncated`), and saving the cut text would delete its tail
            raise PluginError('soul_truncated', 'This SOUL is longer than LuveBot shows (64 KiB), so saving it here would cut the end. Edit it in Hermes.', 422)
        asyncio.run(update_profile_soul(bot, ProfileSoulUpdate(content=merge_soul(validate_soul(content), block, before, after))))


def update_description(bot, text):
    from hermes_cli.web_models import ProfileDescriptionUpdate
    from hermes_cli.web_routers.profiles import update_profile_description_endpoint
    asyncio.run(update_profile_description_endpoint(bot, ProfileDescriptionUpdate(description=text)))


# ---- B7 where "working" comes from -----------------------------------------------------------------------------------
_CACHE, _CACHE_LOCK, _TTL = {}, threading.Lock(), 5


def _cached(key, read):
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and time.monotonic() - hit[0] < _TTL:
            return hit[1]
    try:
        value = (read(), False)
    except Exception:
        value = ([], True)  # A-50: a failed source is reported, never read as idle
    with _CACHE_LOCK:
        _CACHE[key] = (time.monotonic(), value)
    return value


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def recent_sources(bot):
    """{recent_sessions, workers, status_partial}: the newest 20 session rows of the profile (every source) and the profile's
    live Kanban workers. Gateway-wide counts of /api/status are never attributed to a Bot (A-50)."""
    sessions, sessions_failed = _cached(('sessions', bot), lambda: session_rows(bot, limit=20, every_source=True))

    def workers():
        from plugins.kanban.dashboard.plugin_api import list_active_workers
        return list_active_workers(board=None).get('workers') or []
    rows, workers_failed = _cached('workers', workers)
    mine = [w for w in rows if w.get('profile') == bot and type(w.get('worker_pid')) is int and w['worker_pid'] > 0 and _alive(w['worker_pid'])]
    return {'recent_sessions': sessions, 'workers': mine,
            'status_partial': [n for n, failed in (('sessions', sessions_failed), ('kanban', workers_failed)) if failed]}


# ---- how the Bot writes for LuveBot (T12): Hermes's own per-profile platform hint ------------------------------------
# Hermes tells every API Server agent "assume plain text, no markdown" (agent/prompt_builder.py#L807-L814, platform fixed to
# api_server in gateway/platforms/api_server.py#L2421). LuveBot renders Markdown safely, so each Bot's profile gets the
# documented override platform_hints.api_server.replace (hermes_cli/config_defaults.py#L1712,
# website/docs/developer-guide/prompt-assembly.md#L144), written through Hermes's own config writer.
MARKDOWN_HINT = (
    'You are replying inside LuveBot, a chat that renders GitHub-flavored Markdown safely: headings, bold, italic, lists, '
    'tables, code blocks and links. Use Markdown when it helps the reader; raw HTML is shown as text, never rendered. Keep '
    'answers conversational. Files: the runs endpoint does not intercept MEDIA: tags, so save files in your workspace and '
    'state the plain path; LuveBot offers the download. To suggest that the person create a new Bot, write one line of its own: '
    '[luvebot:sugerir-bot nome="<name, up to 40 characters>" papel="<what it does, up to 160 characters>"]; LuveBot shows a card '
    'the person may accept or ignore. It creates nothing: never say the Bot was created.')
HINT_MARK = 'You are replying inside LuveBot'  # every hint LuveBot wrote starts so: an older one of ours is upgraded, never the owner's
PAGES_HINT = ('Pages: documents for the person to read or edit go in {folder}/<slug>.md (create the folder if it is missing; '
              'slug: lowercase letters, digits and hyphens). LuveBot\'s Pages editor reads only that folder.')


def markdown_hint(bot):
    """The hint for THIS Bot: MARKDOWN_HINT and, only when Pages works for it, the ABSOLUTE path of its pages folder, resolved by the
    same code the Pages editor reads with (pages.workspace). The CEO's Bot, told "pages/", asked which project it meant."""
    from . import pages
    try:
        state, root = pages.workspace(bot)
    except Exception:  # noqa: BLE001  (Pages unknown: the hint does not speak of it)
        return MARKDOWN_HINT
    if state not in ('ready', 'empty'):
        return MARKDOWN_HINT
    return MARKDOWN_HINT + ' ' + PAGES_HINT.format(folder=os.path.join(root, 'pages'))


def ensure_markdown_hint(bot, audit=None, actor='system', origin='system', *, refresh_only=False):
    """-> 'present' | 'kept_user' | 'set' | 'updated' | 'absent'. Idempotent; a hint the owner wrote for api_server is never
    replaced (it is recorded and left). A hint of ours that differs (an older text, a Pages folder that moved) is rewritten.
    refresh_only (before a turn): only a hint of ours is brought up to date, quietly; none is created and nothing is recorded
    otherwise (creating a Bot and the installer's upgrade set it). With `audit` the change is audited before it is made;
    without it the caller's own audit row covers it (creating a Bot)."""
    from hermes_cli.config import load_config, set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    expected = markdown_hint(bot)
    with _config_profile_scope(bot):
        hints = load_config().get('platform_hints')
        current = hints.get('api_server') if isinstance(hints, dict) else None
        if current == {'replace': expected}:
            return 'present'
        ours = (isinstance(current, dict) and set(current) == {'replace'} and isinstance(current['replace'], str)
                and current['replace'].startswith(HINT_MARK))
        if refresh_only and not ours:
            return 'absent' if current in (None, {}, '') else 'kept_user'
        if current not in (None, {}, '') and not ours:
            if audit is not None:
                audit.act(actor, 'bot.platform_hint.kept', bot, origin, lambda: None, bot=bot)
            return 'kept_user'

        def write():
            set_config_value('platform_hints.api_server.replace', expected)
        if audit is None:
            write()
        else:
            audit.act(actor, 'bot.platform_hint.set', bot, origin, write, bot=bot, payload={'sha256': digest(expected)})
        return 'updated' if ours else 'set'


# ---- time to answer approvals (contract v0.6, Part D) ----
APPROVAL_TIMEOUTS = (300, 900, 1800, 3600, 14400)   # 5, 15, 30 min, 1 h, 4 h
NEW_BOT_APPROVAL_TIMEOUT = 3600                    # the CEO's default for a Bot made by the assistant (10.3)


def validate_approval_timeout(body):
    """{"seconds": one of APPROVAL_TIMEOUTS}, a JSON integer only: `type(v) is int`, so 3600.0, true and "3600" are 422."""
    if not isinstance(body, dict) or set(body) != {'seconds'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    seconds = body['seconds']
    if type(seconds) is not int or seconds not in APPROVAL_TIMEOUTS:
        raise PluginError('invalid_field', 'seconds must be 300, 900, 1800, 3600 or 14400.', 422)
    return seconds


def approval_timeout_update(bot, seconds):
    """The coroutine of Hermes's own PUT /api/config handler (config_env.py update_config: a strict read, then a deep merge of
    this one key under Hermes's config lock), ALWAYS scoped to the Bot's profile: without `profile` Hermes writes the default
    profile's config. LuveBot never writes config.yaml itself (invariant 4)."""
    from hermes_cli.web_models import ConfigUpdate
    from hermes_cli.web_routers.config_env import update_config
    return update_config(ConfigUpdate(config={'approvals': {'timeout': seconds}}, profile=bot), profile=bot)


def approval_timeout(bot):
    """{seconds, source, run_budget_seconds}: what Hermes waits for this Bot, read with Hermes's own reader in the profile's scope;
    source is 'profile' when the profile's file sets it, else 'hermes_default'. run_budget_seconds (A-94, cross review F8):
    the profile's `agent.run_budget_seconds`, a wall clock that can end a turn before the wait does; null when unset."""
    from hermes_cli.config import load_config, read_raw_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    from tools.approval_context import _get_approval_timeout
    with _config_profile_scope(bot):
        seconds = int(_get_approval_timeout())
        raw = read_raw_config().get('approvals')
        agent = load_config().get('agent')
    budget = agent.get('run_budget_seconds') if isinstance(agent, dict) else None
    return {'seconds': seconds, 'source': 'profile' if isinstance(raw, dict) and 'timeout' in raw else 'hermes_default',
            'run_budget_seconds': int(budget) if type(budget) in (int, float) and budget > 0 else None}


def set_approval_timeout(audit, actor, bot, seconds, origin_ref):
    """10.1: audited (intent before Hermes's write), then re-read with Hermes's reader: an effective value that differs (a clamp,
    a failed write) is a 502, never a claimed success. A longer wait is not loosening (A-92): allowed in loopback too.
    Requests already pending keep their expires_at (Hermes's own wait read the value when it started)."""
    before = approval_timeout(bot)['seconds']
    audit.act(actor, 'approval.timeout.set', bot, {'kind': 'ui', 'ref': origin_ref},
              lambda: asyncio.run(approval_timeout_update(bot, seconds)), bot=bot, payload={'from': before, 'to': seconds})
    effective = approval_timeout(bot)['seconds']
    if effective != seconds:
        raise PluginError('hermes_error', 'Hermes did not keep this wait time.', 502)
    return {'seconds': seconds, 'effective': effective}


def set_approval_timeout_all(audit, actor, bots, seconds, origin_ref):
    """10.2: one audited 10.1 per Bot; a failure is reported for that Bot and never undoes the others (A-95)."""
    results = []
    for bot in bots:
        try:
            results.append({'bot': bot, 'seconds': set_approval_timeout(audit, actor, bot, seconds, origin_ref)['seconds']})
        except PluginError as error:
            results.append({'bot': bot, 'error': error.code})
        except AuditUnavailable:
            results.append({'bot': bot, 'error': 'audit_unavailable'})
        except Exception as error:  # noqa: BLE001  (Hermes's text never leaves: our static code)
            refusal = hermes_boundary.config_write_refusal(error)
            results.append({'bot': bot, 'error': refusal[0] if refusal else 'hermes_error'})   # a refused write says which (a lock above, an invalid value), as the single route does
    return {'results': results}
