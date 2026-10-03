"""Sessions and runs (contract section 5, no SSE): the rules around the proxy.

Hermes routes used (all at commit f8489405, through /p/<profile>/):
  POST /api/sessions          https://github.com/NousResearch/hermes-agent/blob/f8489405/gateway/platforms/api_server.py#L3129
  POST /v1/runs               https://github.com/NousResearch/hermes-agent/blob/f8489405/gateway/platforms/api_server_runs.py#L620
  GET  /v1/runs/{run_id}      .../api_server_runs.py#L1057
  POST /v1/runs/{run_id}/stop .../api_server_runs.py#L1253
"""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import os
import re
import sqlite3

from .api_errors import PluginError
from .audit import ActionDenied
from .budget import has_limits, is_paused  # noqa: F401  (they live with the Budget's tables; imported from here by bot_controls and plugin_api)
from .hermes_api import safe_id

KNOWN = ('started', 'waiting_for_approval', 'stopping', 'completed', 'failed', 'cancelled')
# Hermes also reports queued, running and interrupted (api_server_runs.py: _set_run_status callers); the contract
# folds them into "unknown" with status_raw, but tracking must still tell them apart from an ended run.
OPEN = {'queued', 'started', 'running', 'waiting_for_approval', 'stopping'}
ENDED = {'completed', 'failed', 'cancelled', 'interrupted', 'lost'}
STALE_AFTER = timedelta(hours=24)
MAX_OPEN_CHECKED = 5
_SCHEMA = """
CREATE TABLE IF NOT EXISTS run_index (
    run_id TEXT PRIMARY KEY, bot TEXT NOT NULL, session_id TEXT, actor TEXT NOT NULL,
    started_at TEXT NOT NULL, last_status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_index_bot ON run_index (bot, started_at);
CREATE TABLE IF NOT EXISTS run_digest_key (id INTEGER PRIMARY KEY CHECK (id = 1), key BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS chat_dedupe (
    client_message_id TEXT PRIMARY KEY, bot TEXT NOT NULL, session_id TEXT NOT NULL, ts TEXT NOT NULL
);
"""


class RunRefused(PluginError, ActionDenied):
    """A new run refused by the Budget: recorded as denied in the audit, answered with the contract error."""


class RunIndex:
    """run_id -> bot, so a run cannot be addressed through another Bot (threat T3), and the Bot status can be derived."""

    def __init__(self, path):
        self.path = path
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
            # v0.4 A-46: when a run ended, for "unread". Runs that ended before the column existed stay NULL (read).
            have = {row[1] for row in conn.execute('PRAGMA table_info(run_index)')}
            if 'ended_at' not in have:
                conn.execute('ALTER TABLE run_index ADD COLUMN ended_at TEXT')
            if 'prompt_sha' not in have:  # v0.2 section 2: which stored message is this run's (a keyed digest, never the text)
                conn.execute('ALTER TABLE run_index ADD COLUMN prompt_sha TEXT')
            # One random key per database (0600, like the rest of it), made once; never returned by a route or logged.
            conn.execute('INSERT OR IGNORE INTO run_digest_key (id, key) VALUES (1, ?)', (os.urandom(32),))
            conn.commit()
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def _exec(self, sql, args=(), *, fetch=None):
        conn = self._connect()
        try:
            cursor = conn.execute(sql, args)
            conn.commit()
            return cursor.fetchall() if fetch else None
        finally:
            conn.close()

    def add(self, run_id, bot, session_id, actor, status, prompt_sha=None):
        now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        self._exec('INSERT OR IGNORE INTO run_index (run_id, bot, session_id, actor, started_at, last_status, prompt_sha) '
                   'VALUES (?,?,?,?,?,?,?)', (run_id, bot, session_id, actor, now, status, prompt_sha))

    def prompt_digest(self, text):
        """HMAC-SHA256, with this database's own key, of the exact text sent to Hermes for a run (Hermes stores it as the
        person's message). The run's activity title is the stored message with the same digest; the key makes the digest
        useless as a dictionary of what people typed ('Olá' cannot be looked up), and the text itself is never kept here."""
        return self.keyed_digest(text.encode('utf-8'))

    def keyed_digest(self, data):
        """HMAC-SHA256 of bytes with this database's own key (also the audit target of an attachment, ADR-005)."""
        if getattr(self, '_key', None) is None:
            self._key = self._exec('SELECT key FROM run_digest_key WHERE id = 1', fetch=True)[0]['key']
        return hmac.new(self._key, data, hashlib.sha256).hexdigest()

    def owns(self, bot, run_id):
        return bool(self._exec('SELECT 1 FROM run_index WHERE run_id=? AND bot=?', (run_id, bot), fetch=True))

    def claim_message(self, client_message_id, bot, session_id):
        """Retries of one chat message are idempotent on our side (contract 5): False if this id was already used in 24 h."""
        now = datetime.now(timezone.utc)
        stamp = lambda moment: moment.isoformat(timespec='seconds').replace('+00:00', 'Z')
        conn = self._connect()
        try:
            conn.execute('DELETE FROM chat_dedupe WHERE ts<?', (stamp(now - STALE_AFTER),))
            claimed = conn.execute('INSERT OR IGNORE INTO chat_dedupe VALUES (?,?,?,?)',
                                   (client_message_id, bot, session_id, stamp(now))).rowcount == 1
            conn.commit()
            return claimed
        finally:
            conn.close()

    def release_message(self, client_message_id):
        self._exec('DELETE FROM chat_dedupe WHERE client_message_id=?', (client_message_id,))

    def set_status(self, run_id, status):
        ended = datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z') if status in ENDED else None
        self._exec('UPDATE run_index SET last_status=?, ended_at=COALESCE(ended_at, ?) WHERE run_id=?', (status, ended, run_id))

    def status(self, run_id):
        rows = self._exec('SELECT last_status FROM run_index WHERE run_id=?', (run_id,), fetch=True)
        return rows[0]['last_status'] if rows else None

    def started_at(self, run_id):
        rows = self._exec('SELECT started_at FROM run_index WHERE run_id=?', (run_id,), fetch=True)
        return rows[0]['started_at'] if rows else None

    def open_runs(self, bot):
        """Newest first; runs older than 24 h are not trusted to still be running."""
        since = (datetime.now(timezone.utc) - STALE_AFTER).isoformat(timespec='seconds').replace('+00:00', 'Z')
        marks = ','.join('?' for _ in OPEN)
        rows = self._exec(f'SELECT run_id, last_status, started_at FROM run_index WHERE bot=? AND started_at>=? '
                          f'AND last_status IN ({marks}) ORDER BY started_at DESC LIMIT ?',
                          (bot, since, *sorted(OPEN), MAX_OPEN_CHECKED), fetch=True)
        return [dict(row) for row in rows]


def budget_gate(budget, path, bot):
    """Invariant 7: a paused or capped Bot gets no new run. Raises RunRefused (audited as denied)."""
    from .bot_controls import work_gate
    work_gate(path, bot)  # v0.4 B3: a Bot paused by a person (or everything paused) gets no new run either
    decision = budget.check_new_run(bot)
    if decision['allowed']:
        return
    reason = decision['reason']
    if reason == 'bot_paused':
        raise RunRefused('bot_paused', 'This Bot is paused; resume it before starting new work.', 409)
    if reason == 'budget_exceeded':
        raise RunRefused('budget_exceeded', 'The spending cap for this Bot was reached.', 409)
    # watcher_stale: nothing refreshes spend yet (Phase 4). With no cap configured there is nothing to enforce;
    # with a cap configured an unverifiable budget fails closed.
    if reason == 'watcher_stale' and not has_limits(path):
        return
    raise RunRefused('budget_unavailable', 'The budget could not be verified, so no new work was started.', 503)


def _text(value, field, maximum, *, optional=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise PluginError('invalid_field', f'Invalid value for {field}.', 422)
    return value


def validate_session_body(body):
    if not isinstance(body, dict) or set(body) - {'title'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    title = _text(body.get('title'), 'title', 200, optional=True)
    return {} if title is None else {'title': title}


def _page_ref(value):
    """v0.5 7.2: optional `page: {slug}`; the slug itself is checked against the workspace by backend/pages.py."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'slug'} or not isinstance(value['slug'], str):
        raise PluginError('bad_request', 'Malformed request body.', 400)
    return value['slug']


def validate_run_body(body):
    if not isinstance(body, dict) or set(body) - {'input', 'session_id', 'instructions', 'idempotency_key', 'page'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    out = {'input': _text(body.get('input'), 'input', 50_000), 'page': _page_ref(body.get('page'))}
    session_id = body.get('session_id')
    if session_id is not None and safe_id(session_id) is None:
        raise PluginError('invalid_field', 'Invalid value for session_id.', 422)
    out['session_id'] = session_id
    out['instructions'] = _text(body.get('instructions'), 'instructions', 20_000, optional=True)
    key = body.get('idempotency_key')
    if key is not None and not (isinstance(key, str) and re.fullmatch(r'[\x21-\x7e]{1,255}', key)):
        raise PluginError('invalid_field', 'Invalid value for idempotency_key.', 422)
    out['idempotency_key'] = key
    return out


def validate_chat_body(body):
    if not isinstance(body, dict) or set(body) - {'input', 'client_message_id', 'page'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    out = {'input': _text(body.get('input'), 'input', 50_000), 'page': _page_ref(body.get('page'))}
    cid = body.get('client_message_id')
    if cid is not None and not (isinstance(cid, str) and re.fullmatch(r'[A-Za-z0-9_-]{8,64}', cid)):
        raise PluginError('invalid_field', 'Invalid value for client_message_id.', 422)
    out['client_message_id'] = cid
    return out


def contract_status(raw):
    """(status, status_raw|None): anything outside the contract list is "unknown" with the original kept."""
    if raw in KNOWN:
        return raw, None
    return 'unknown', raw if isinstance(raw, str) and len(raw) <= 64 and raw.isprintable() else None


def upstream_error(status, *, on_404, on_409=None):
    """HTTP status from Hermes -> our error. Upstream text is never forwarded."""
    mapping = {400: ('bad_request', 'Hermes rejected the request.', 400), 404: on_404,
               429: ('rate_limited', 'Hermes is busy; try again shortly.', 429)}
    if status == 409 and on_409:
        mapping[409] = on_409
    code, message, http = mapping.get(status, ('hermes_error', 'Hermes returned an unexpected response.', 502))
    return PluginError(code, message, http)
