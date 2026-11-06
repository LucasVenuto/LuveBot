"""Threads (contract plugin-api v0.8, section 4; spec 4.7): a NEW conversation of the same Bot, linked to one message of another.

Not Hermes's fork (it ENDS the source session): nothing is copied and the parent is never touched. The quote is read FROM HERMES
by (session, message id), never from the browser; what the person types is only the reply. LuveBot keeps the link
(`threads`), the rest is the child session's own messages.
"""
import sqlite3
import time
from datetime import datetime, timezone

from . import bot_controls
from .api_errors import PluginError
from .hermes_api import safe_id
from .runs import validate_chat_body
from . import dbfile

EXCERPT = 2000
MAX_LISTED = 200
_SCHEMA = ('CREATE TABLE IF NOT EXISTS threads (child_session TEXT PRIMARY KEY, bot TEXT NOT NULL, parent_session TEXT NOT NULL, '
           'parent_message_id INTEGER NOT NULL, created_by TEXT NOT NULL, created_at REAL NOT NULL);'
           'CREATE INDEX IF NOT EXISTS threads_parent ON threads (bot, parent_session)')
_NO_MESSAGE = ('message_not_found', 'Message not found.', 404)


def _db(path):
    conn = dbfile.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


def validate(body):
    """-> (parent session id, parent message id, chat fields with only the person's reply as input)."""
    if not isinstance(body, dict) or set(body) != {'session_id', 'message_id', 'input'}:
        raise PluginError('bad_request', 'Send {"session_id", "message_id", "input"}.', 400)
    session_id, message_id = body['session_id'], body['message_id']
    if not isinstance(session_id, str) or safe_id(session_id) is None:
        raise PluginError('session_not_found', 'Session not found.', 404)
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 1:
        raise PluginError('invalid_field', 'Invalid value for message_id.', 422)
    return session_id, message_id, validate_chat_body({'input': body['input']})


def _message(bot, session_id, message_id):
    """The message row Hermes holds for this id in this conversation (or its resume tip), else None."""
    tip = bot_controls.owned_session(bot, session_id)  # 404 session_not_found: not this Bot's, or a room's
    db = bot_controls._session_db(bot)
    try:
        around = getattr(db, 'get_messages_around', None)
        if around is None:  # an older Hermes: no single-message read, so no quote we could trust
            raise PluginError('capability_missing', 'This Hermes cannot read one message, so threads are off.', 409, {'feature': 'threads'})
        for sid in dict.fromkeys((tip, session_id)):
            for row in around(sid, message_id, 0).get('window') or ():
                if row.get('id') == message_id:
                    return row
        return None
    finally:
        db.close()


def quote(bot, session_id, message_id, redact, *, now=None, intro_session=None):
    """The line that opens the thread, built from what Hermes holds (never from the request): the message's author, its UTC hour (with
    the date when it is not from today) and its redacted text up to 2,000 characters. Only a person's or the Bot's visible message can
    be answered in a thread. The excerpt becomes text of the PERSON's turn in a session with no history, so it must not be able to close
    its own quotation: `»` (and `«`) inside it become `›` (`‹`), after the redaction and before the cut."""
    row = _message(bot, session_id, message_id)
    view = bot_controls.message_view(row, redact, intro_session is not None and session_id == intro_session) if row else None   # LuveBot's own hidden turn is not a message to answer
    if view is None or view['role'] not in ('user', 'assistant') or view.get('display_kind'):
        raise PluginError(*_NO_MESSAGE)
    at = view.get('at')
    hour = ''
    if isinstance(at, (int, float)) and not isinstance(at, bool):
        moment = datetime.fromtimestamp(at, timezone.utc)
        day = '' if moment.date() == (now or datetime.now(timezone.utc)).date() else f'{moment:%Y-%m-%d} '
        hour = f' ({day}{moment:%H:%M} UTC)'
    author = f'de {bot}' if view['role'] == 'assistant' else 'da pessoa'
    excerpt = view['text'].replace('\u00bb', '\u203a').replace('\u00ab', '\u2039')[:EXCERPT]
    return f'[Respondendo à mensagem {author}{hour}: «{excerpt}»]'


def record(path, bot, child, parent_session, parent_message_id, actor):
    conn = _db(path)
    try:
        with conn:
            conn.execute('INSERT INTO threads VALUES (?,?,?,?,?,?)', (child, bot, parent_session, parent_message_id, actor, time.time()))
    finally:
        conn.close()


def hidden(path, bot):
    """Child sessions of this Bot: a thread is opened from its message, never listed among the conversations."""
    conn = _db(path)
    try:
        return {r[0] for r in conn.execute('SELECT child_session FROM threads WHERE bot = ?', (bot,))}
    finally:
        conn.close()


# ponytail: process memory keyed by the child's message count; Hermes's own count moves on every message, so a new one recomputes.
# A rewind that leaves the count equal would show the old number until the next message; cleared whole past 4,000 threads.
_COUNTS = {}


def _activity(db, bot, child, redact):
    """(replies, last_at) of one child session: the visible messages of the person and of the Bot. Read from Hermes only when its
    message count changed since the last call. (None, None) when unreadable: unknown is shown as unknown, never as zero."""
    if db is None:
        return None, None
    try:
        info = db.get_session(child)
        count = info.get('message_count') if isinstance(info, dict) else None
        hit = _COUNTS.get((bot, child))
        if isinstance(count, int) and hit and hit[0] == count:
            return hit[1], hit[2]
        shown = [v for row in db.get_messages(child) if (v := bot_controls.message_view(row, redact)) and v['role'] in ('user', 'assistant')
                 and not v.get('display_kind')]
        stamps = [v['at'] for v in shown if isinstance(v.get('at'), (int, float)) and not isinstance(v.get('at'), bool)]
        replies, last_at = len(shown), max(stamps) if stamps else None
        if isinstance(count, int):
            if len(_COUNTS) >= 4000:
                _COUNTS.clear()
            _COUNTS[(bot, child)] = (count, replies, last_at)
        return replies, last_at
    except Exception:  # noqa: BLE001
        return None, None


def listing(path, bot, session_ids, redact):
    """-> (`[{message_id, child_session, replies, last_at}]`, truncated) for the "N respostas" badges of one conversation (its id and
    its tip). More than 200 threads cut the list and say so."""
    marks = ','.join('?' * len(session_ids))
    conn = _db(path)
    try:
        rows = conn.execute(f'SELECT child_session, parent_message_id FROM threads WHERE bot = ? AND parent_session IN ({marks}) '
                            'ORDER BY created_at LIMIT ?', (bot, *session_ids, MAX_LISTED + 1)).fetchall()
    finally:
        conn.close()
    truncated, rows = len(rows) > MAX_LISTED, rows[:MAX_LISTED]
    try:
        db = bot_controls._session_db(bot) if rows else None
    except Exception:  # noqa: BLE001
        db = None
    try:
        out = []
        for row in rows:
            replies, last_at = _activity(db, bot, row['child_session'], redact)
            out.append({'message_id': row['parent_message_id'], 'child_session': row['child_session'], 'replies': replies, 'last_at': last_at})
    finally:
        if db is not None:
            db.close()
    return out, truncated


def sessions_page(bot, hidden_ids, *, limit, offset, source, q):
    """The conversation list WITHOUT the threads, filtered before the page is cut: -> (rows, next_cursor). Reads Hermes in chunks of
    `limit + 1` until the page is full and one more visible row proves there is a next one (its position is the next cursor)."""
    out, cursor, at = [], None, offset
    while cursor is None:
        rows = bot_controls.session_rows(bot, limit=limit + 1, offset=at, source=source, q=q)
        for i, row in enumerate(rows):
            if row.get('source') == 'bot_room' or row.get('id') in hidden_ids:
                continue
            if len(out) == limit:
                cursor = str(at + i)
                break
            out.append(row)
        if len(rows) < limit + 1:
            break
        at += len(rows)
    return out, cursor
