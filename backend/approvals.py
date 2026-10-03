"""Human decisions on approvals (ADR-002 5.3, 5.5, 5.6; contract v0.1 sections 1, 2, 4 and 6).

This is the ONLY module that answers a Hermes approval. The rules it enforces, each with a test and a mutation:

* RT 4  only a verified human can decide: `resolve` takes an engine `Actor` of kind HUMAN, built by the route from the
        dashboard session and never from request content; any other caller is refused before anything is read or sent.
* RT 5  "Always allow" decides THIS request once and saves a DRAFT rule (engine `draft_from_always_allow`): the native
        `session` / `always` choices are never sent, and a draft has no effect until a human activates it.
* RT 9  one decision per request: the stored digest must match, the request must be pending and unexpired, and the claim
        is a single atomic UPDATE; a similar action is a different request with a different digest and needs its own.

Pure persistence and rules: no Hermes imports (the native call is injected as `dispatch`), so it can be tested alone.
"""
import hashlib
import json
import math
import re
import time
import uuid
from datetime import datetime, timezone

from . import hook_store, rules, rules_store
from .api_errors import PluginError
from .audit import ActionDenied, AuditLog

SCHEMA = """
CREATE TABLE IF NOT EXISTS approvals (
    request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, source TEXT NOT NULL, bot TEXT NOT NULL, surface TEXT NOT NULL,
    mechanism TEXT NOT NULL, tool TEXT, rule_id TEXT, hook_event_id INTEGER, command_redacted TEXT NOT NULL,
    description TEXT NOT NULL, pattern_keys TEXT NOT NULL, allowed_choices TEXT NOT NULL, digest TEXT NOT NULL,
    action_class_hash TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, status TEXT NOT NULL,
    decided_by TEXT, decided_choice TEXT, decided_at REAL, consumed_at REAL, reason TEXT,
    details_unavailable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at);
CREATE INDEX IF NOT EXISTS approvals_run ON approvals (run_id);
"""
TTL = 300.0                    # how long a request may wait for a human; Hermes may withdraw it earlier (then: stale)
CHOICES = ('once', 'deny')     # the only decisions LuveBot ever sends (H7): never session, never always
STATUSES = ('pending', 'decided', 'consumed', 'expired', 'stale')
HOOK_PREFIX = 'plugin_rule:luvebot:'
MAX_BATCH = 50
_HEX = re.compile(r'[0-9a-f]{64}')
_SAFE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}')


class ApprovalRefused(PluginError, ActionDenied):
    """A decision refused by a check: recorded as denied in the audit, answered with the contract error."""


# --------------------------------------------------------------------------------------------------------------------
# digests (ADR-002 5.5, contract v0.1 section 4)
# --------------------------------------------------------------------------------------------------------------------
def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def run_digest(bot, run_id, request_id, tool, command, description, pattern_keys, choices):
    """SHA-256 of the canonical JSON of what the human reviews, exactly as stored and shown (A-14): the Bot and the tool too (C1)."""
    return hashlib.sha256(_canonical({'bot': bot, 'run_id': run_id, 'request_id': request_id, 'tool': tool, 'command': command,
                                      'description': description, 'pattern_keys': list(pattern_keys), 'choices': list(choices)})).hexdigest()


def action_class_hash(bot, mechanism, key):
    """Batch grouping key: {bot, mechanism, pattern_key or tool_name}; never a substitute for a request digest."""
    return hashlib.sha256(_canonical({'bot': bot, 'mechanism': mechanism, 'key': key})).hexdigest()


# --------------------------------------------------------------------------------------------------------------------
# storage
# --------------------------------------------------------------------------------------------------------------------
def connect(path):
    conn = rules_store.connect(path)
    conn.executescript(SCHEMA)
    have = {r['name'] for r in conn.execute('PRAGMA table_info(approvals)')}
    if 'details_unavailable' not in have:  # a database from before C1
        conn.execute('ALTER TABLE approvals ADD COLUMN details_unavailable INTEGER NOT NULL DEFAULT 0')
        conn.commit()
    if 'reason_steer' not in have:  # b3: what became of a deny reason sent to the run (a database from before it)
        conn.execute('ALTER TABLE approvals ADD COLUMN reason_steer TEXT')
        conn.commit()
    return conn


def _iso(ts):
    return None if ts is None else datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def view(row):
    """The Approval of the contract: stored, redacted content only; no session keys, no credentials."""
    return {'request_id': row['request_id'], 'bot': row['bot'], 'surface': row['surface'], 'mechanism': row['mechanism'],
            'source': row['source'], 'run_id': row['run_id'], 'tool': row['tool'], 'rule_id': row['rule_id'],
            'digest': row['digest'], 'command_redacted': row['command_redacted'], 'description': row['description'],
            'pattern_keys': json.loads(row['pattern_keys']), 'allowed_choices': json.loads(row['allowed_choices']),
            'action_class_hash': row['action_class_hash'], 'created_at': _iso(row['created_at']),
            'expires_at': _iso(row['expires_at']), 'status': row['status'], 'decided_by': row['decided_by'],
            'decided_choice': row['decided_choice'], 'consumed_at': _iso(row['consumed_at']), 'reason': row['reason'],
            # b3: a deny reason reached the Bot only when Hermes accepted it AND the run COMPLETED without it pending; None while it is
            # accepted and the run still goes on, or when the run failed or was cancelled (unknown); False otherwise
            'reason_delivered': reason_delivered(row['reason_steer'] if 'reason_steer' in row.keys() else None),
            # C1: a hook approval whose tool and command LuveBot could not tie to this exact request cannot be decided
            'details_unavailable': bool(row['details_unavailable']),
            # M1: what "Always allow" would draft: this command, or (nothing to narrow it by) every use of the tool
            'draft_scope': 'command' if row['command_redacted'] else 'tool'}


REASON_STATES = ('accepted', 'refused', 'delivered', 'not_delivered', 'unknown')


def reason_delivered(state):
    return True if state == 'delivered' else None if state in ('accepted', 'unknown') else False


def set_reason_steer(path, request_id, state, *, only_from=None):
    """Record what became of a deny reason sent to the run as a steer. `only_from` settles only a row still in that state."""
    if state not in REASON_STATES:
        raise ValueError('reason state')
    conn = connect(path)
    try:
        sql, args = 'UPDATE approvals SET reason_steer=? WHERE request_id=?', [state, request_id]
        if only_from is not None:
            sql, args = sql + ' AND reason_steer=?', args + [only_from]
        conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


def reasons_waiting(path, run_id):
    """Request ids of this run whose deny reason Hermes accepted as a steer and that are not settled yet."""
    conn = connect(path)
    try:
        return [r['request_id'] for r in conn.execute("SELECT request_id FROM approvals WHERE run_id=? AND reason_steer='accepted'",
                                                      (run_id,))]
    finally:
        conn.close()


def expire(conn, now):
    conn.execute("UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at <= ?", (now,))
    conn.commit()


def expire_run(path, run_id):
    """The run ended: whatever it was still waiting for can no longer be answered."""
    conn = connect(path)
    try:
        conn.execute("UPDATE approvals SET status='expired' WHERE run_id=? AND status='pending'", (run_id,))
        conn.commit()
    finally:
        conn.close()


def _pattern_keys(data):
    keys = data.get('pattern_keys')
    if not isinstance(keys, list):
        keys = [data.get('pattern_key')] if data.get('pattern_key') else []
    return [str(k)[:200] for k in keys[:20] if isinstance(k, str)]


_KEY_NONCE = re.compile(r'[0-9a-f]{8,64}')
_KEY_EVENT = re.compile(r'[0-9]{1,17}')  # ASCII only: str.isdigit() takes '١٢' and int() reads it as 12


def _hook_key(keys):
    """-> (rule_id, hook_event_id | None) from the key our hook sent as rule_key: "plugin_rule:luvebot:<rule>#<event id>.<nonce>" (hook
    0.2.0; the random nonce keeps the key unique if the database is recreated and ids restart) or "...#<event id>" (hook 0.1.0, until it
    is reinstalled). The event id is the row the hook wrote for THIS call; Hermes copies the key into the request, so the match is
    exact (C1), never "the first unlinked row of the same rule". A tail in any other shape names no row."""
    for key in keys:
        if key.startswith(HOOK_PREFIX):
            rule, _, tail = key[len(HOOK_PREFIX):].rpartition('#')
            event, dot, nonce = tail.partition('.')
            ok = rule and _KEY_EVENT.fullmatch(event) and (not dot or _KEY_NONCE.fullmatch(nonce))
            return (rule, int(event)) if ok else (key[len(HOOK_PREFIX):], None)
    return None, None


def _hook_event(conn, bot, rule_id, event_id):
    """What the hook recorded for this very call (T3.0c findings 2 and 3): Hermes shows only a placeholder command for a hook approval,
    so the real tool and the redacted command come from the hook's own row, found by the id it put in the key."""
    if rule_id is None or event_id is None:
        return None
    row = conn.execute("SELECT * FROM hook_events WHERE id=? AND profile=? AND verdict='approve' "
                       "AND id NOT IN (SELECT hook_event_id FROM approvals WHERE hook_event_id IS NOT NULL)", (event_id, bot)).fetchone()
    return row if row is not None and (row['rule_id'] or 'noncanonical') == rule_id else None


def record_request(path, bot, run_id, surface, data, *, now=None):
    """Store a native `approval.request` (already transformed and redacted) and return its row as a dict. Idempotent: the
    watcher and the stream proxy may both see the same frame; the first stored row, and its digest, wins."""
    now = time.time() if now is None else now
    request_id, run_id = data.get('request_id'), run_id
    if not (isinstance(request_id, str) and _SAFE.fullmatch(request_id) and isinstance(run_id, str) and _SAFE.fullmatch(run_id)):
        raise ValueError('unusable approval request')
    conn = connect(path)
    try:
        found = conn.execute('SELECT * FROM approvals WHERE request_id=?', (request_id,)).fetchone()
        if found:
            return dict(found)
        keys = _pattern_keys(data)
        choices = [c for c in (data.get('choices') or []) if isinstance(c, str)][:8]
        rule_id, event_id = _hook_key(keys)
        event = _hook_event(conn, bot, rule_id, event_id)
        mechanism = 'hook_approve' if rule_id else 'command_gate'
        unavailable = mechanism == 'hook_approve' and event is None
        tool = event['tool'] if event else ('terminal' if mechanism == 'command_gate' else None)
        command = (event['command'] or '') if event else ('' if unavailable else str(data.get('command') or '')[:2000])
        description = str(data.get('description') or '')[:1000]
        digest = run_digest(bot, run_id, request_id, tool, command, description, keys, choices)
        values = (request_id, run_id, 'run', bot, surface, mechanism, tool, rule_id, event['id'] if event else None, command,
                  description, json.dumps(keys), json.dumps(choices), digest,
                  action_class_hash(bot, mechanism, (HOOK_PREFIX + rule_id) if rule_id else (keys[0] if keys else (tool or ''))), now, now + TTL, 'pending', 1 if unavailable else 0)

        def insert():
            conn.execute('INSERT OR IGNORE INTO approvals (request_id, run_id, source, bot, surface, mechanism, tool, rule_id, hook_event_id,'
                         ' command_redacted, description, pattern_keys, allowed_choices, digest, action_class_hash, created_at,'
                         ' expires_at, status, details_unavailable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', values)
            conn.commit()

        AuditLog(path).act('system', 'approval.requested', request_id, {'kind': 'system'}, insert, bot=bot)
        return dict(conn.execute('SELECT * FROM approvals WHERE request_id=?', (request_id,)).fetchone())
    finally:
        conn.close()



DECISIONS = ('once', 'session', 'always', 'deny')   # what a person (or Hermes's smart approver, `smart_*`) decides; not timeouts
_CLAIMED = ('decided', 'consumed', 'stale')


def out_of_band(path, bot, key, choice):
    """ADR-002 R-9, contract v0.1 A-20 (red team gap G4.2): detect, never prevent. True when `choice`, which Hermes reports for the
    request carrying our hook's `key`, is a DECISION LuveBot did not make. LuveBot claims its row ('decided', with the choice) and
    commits that BEFORE it calls Hermes (`resolve`), so its own answer is always found here. A timeout or a withdrawn prompt is not
    a decision."""
    choice = str(choice or '')
    if not (isinstance(key, str) and key.startswith(HOOK_PREFIX)) or not (choice in DECISIONS or choice.startswith('smart_')):
        return False
    conn = connect(path)
    try:
        rows = conn.execute('SELECT pattern_keys, status, decided_choice FROM approvals WHERE bot=? AND instr(pattern_keys, ?) > 0',
                            (bot, json.dumps(key))).fetchall()
    finally:
        conn.close()
    return not any(r['status'] in _CLAIMED and r['decided_choice'] == choice and key in json.loads(r['pattern_keys']) for r in rows)


def get(path, request_id, *, now=None):
    conn = connect(path)
    try:
        expire(conn, time.time() if now is None else now)
        row = conn.execute('SELECT * FROM approvals WHERE request_id=?', (request_id,)).fetchone()
        return None if row is None else dict(row)
    finally:
        conn.close()


def _cursor(cursor):
    """M3: "<created_at>:<request_id>" or a 400; whatever a client sends, it never becomes a server error."""
    created, _, rid = cursor.partition(':')
    try:
        stamp = float(created)
    except ValueError:
        stamp = None
    if stamp is None or not math.isfinite(stamp) or not _SAFE.fullmatch(rid):
        raise PluginError('bad_request', 'Invalid paging parameters.', 400)
    return stamp, rid


def list_approvals(path, *, status=None, bot=None, limit=50, cursor=None, now=None):
    """Newest first. cursor = "<created_at>:<request_id>" of the last item seen. -> (views, next_cursor)"""
    conn = connect(path)
    try:
        expire(conn, time.time() if now is None else now)
        where, args = [], []
        if status:
            where.append('status = ?')
            args.append(status)
        if bot:
            where.append('bot = ?')
            args.append(bot)
        if cursor:
            created, rid = _cursor(cursor)
            where.append('(created_at < ? OR (created_at = ? AND request_id < ?))')
            args += [created, created, rid]
        sql = 'SELECT * FROM approvals' + (' WHERE ' + ' AND '.join(where) if where else '') + ' ORDER BY created_at DESC, request_id DESC LIMIT ?'
        rows = conn.execute(sql, (*args, limit + 1)).fetchall()
        page = rows[:limit]
        nxt = f"{page[-1]['created_at']!r}:{page[-1]['request_id']}" if len(rows) > limit else None
        return [view(r) for r in page], nxt
    finally:
        conn.close()


# --------------------------------------------------------------------------------------------------------------------
# validation of bodies (pure)
# --------------------------------------------------------------------------------------------------------------------
def _bad(message='Invalid request body.'):
    return PluginError('bad_request', message, 400)


def validate_resolution(body, *, with_request_id=False):
    """-> {digest, choice, reason, draft: {label, level}|None[, request_id]}. Unknown fields are refused, not ignored."""
    allowed = {'digest', 'choice', 'reason', 'draft_rule'} | ({'request_id'} if with_request_id else set())
    if not isinstance(body, dict) or set(body) - allowed or not {'digest', 'choice'} <= set(body):
        raise _bad()
    digest, choice, reason, draft = body['digest'], body['choice'], body.get('reason'), body.get('draft_rule')
    if not isinstance(digest, str) or not _HEX.fullmatch(digest) or choice not in CHOICES:
        raise _bad('A 64-character digest and a choice of "once" or "deny" are required.')
    if reason is not None and (not isinstance(reason, str) or len(reason) > 1000 or choice != 'deny'):
        raise _bad('A reason is allowed only with "deny" and at most 1000 characters.')
    if draft is not None:
        if (choice != 'once' or not isinstance(draft, dict) or set(draft) != {'label', 'level'} or not isinstance(draft['label'], str)
                or not draft['label'].strip() or len(draft['label']) > 120 or draft['level'] not in ('allow', 'explicit')):
            raise _bad('"Always allow" needs choice "once" and a draft_rule with a label and a level of "allow" or "explicit".')
        draft = {'label': draft['label'].strip(), 'level': draft['level']}
    out = {'digest': digest, 'choice': choice, 'reason': reason, 'draft': draft}
    if with_request_id:
        if not isinstance(body['request_id'], str) or not _SAFE.fullmatch(body['request_id']):
            raise _bad()
        out['request_id'] = body['request_id']
    return out


def validate_batch(body):
    if not isinstance(body, dict) or set(body) != {'items'} or not isinstance(body['items'], list) or not 1 <= len(body['items']) <= MAX_BATCH:
        raise _bad(f'Send 1 to {MAX_BATCH} items.')
    items = []
    for raw in body['items']:
        if not isinstance(raw, dict) or set(raw) - {'request_id', 'digest', 'choice', 'reason'} or 'request_id' not in raw:
            raise _bad()
        item = validate_resolution({k: v for k, v in raw.items() if k != 'request_id'})
        if not isinstance(raw['request_id'], str) or not _SAFE.fullmatch(raw['request_id']):
            raise _bad()
        items.append({**item, 'request_id': raw['request_id']})
    if len({i['request_id'] for i in items}) != len(items):
        raise _bad('Each request may appear once.')
    return items


# --------------------------------------------------------------------------------------------------------------------
# the checked resolver
# --------------------------------------------------------------------------------------------------------------------
def _stale(message='This request was already decided, expired or changed; reload before deciding.'):
    return ApprovalRefused('stale', message, 409)


def _blind():
    return ApprovalRefused('details_unavailable', 'LuveBot could not tie this request to the tool call it came from, so it cannot show '
                           'what would run and will not let anyone decide it blind. Deny it in the Hermes channel or let it expire.', 409)


def _not_found():
    return PluginError('approval_not_found', 'Approval request not found.', 404)


def require_human(actor):
    """RT 4: the type is the proof. The route builds a HUMAN Actor only from the verified dashboard session."""
    if not isinstance(actor, rules.Actor) or actor.kind is not rules.ActorKind.HUMAN or not isinstance(actor.id, str) or not actor.id.strip():
        raise ApprovalRefused('human_required', 'Only a signed-in person can decide an approval.', 403)


def check_pending(path, request_id, digest, *, run=None, now=None):
    """Read-only version of the claim's conditions, for the batch pre-validation. -> row dict. Raises 404 / stale."""
    row = get(path, request_id, now=now)
    if row is None or (run is not None and (row['bot'], row['run_id']) != run):
        raise _not_found()
    if row['details_unavailable']:
        raise _blind()
    if row['status'] != 'pending' or row['digest'] != digest:
        raise _stale()
    return row


def resolve(path, dispatch, actor, request_id, *, digest, choice, reason=None, draft=None, run=None, redact=None, now=None):
    """Decide ONE request. -> (approval view, draft rule dict | None, extras). Runs inside the route's audit.act (so the
    intent is already on record). `dispatch(bot, run_id, choice, request_id) -> bool` is the one native call."""
    require_human(actor)
    if choice not in CHOICES:
        raise _bad()
    now = time.time() if now is None else now
    conn = connect(path)
    try:
        row = conn.execute('SELECT * FROM approvals WHERE request_id=?', (request_id,)).fetchone()
        if row is None or (run is not None and (row['bot'], row['run_id']) != run):
            raise _not_found()
        if row['details_unavailable']:  # C1: never resolvable blind
            raise _blind()
        text = None if reason is None else (redact(reason) if redact else reason)[:1000]
        # Single use, exact digest, unexpired: ONE statement. Whoever changes the row first wins; the other gets stale.
        claimed = conn.execute("UPDATE approvals SET status='decided', decided_by=?, decided_choice=?, decided_at=?, reason=? "
                               "WHERE request_id=? AND digest=? AND status='pending' AND expires_at > ?",
                               (actor.id, choice, now, text, request_id, digest, now)).rowcount
        conn.commit()
        if claimed != 1:
            expire(conn, now)  # so a late request reads as expired, not as pending
            raise _stale()
        row = dict(row)
        try:
            delivered = dispatch(row['bot'], row['run_id'], choice, request_id)
        except BaseException as error:
            # M5: the answer may or may not have reached Hermes. The request stays claimed (never pending again, so nobody can
            # answer it twice) and the person is told to reread, not to decide again.
            conn.execute("UPDATE approvals SET status='stale' WHERE request_id=?", (request_id,))
            conn.commit()
            if isinstance(error, Exception):
                raise PluginError('result_unknown', 'The result is unknown: Hermes may have received your decision. Reload to see what '
                                  'happened; do not decide this request again.', 502) from None
            raise
        if not delivered:  # Hermes no longer has this request pending (timeout, restart, run ended)
            conn.execute("UPDATE approvals SET status='stale' WHERE request_id=?", (request_id,))
            conn.commit()
            raise _stale('Hermes no longer has this request pending.')
        conn.execute("UPDATE approvals SET status='consumed', consumed_at=? WHERE request_id=?", (now, request_id))
        conn.commit()
        draft_rule, extras = None, {}
        if draft is not None:
            draft_rule, error = _draft(path, row, draft)
            if error:
                extras['draft_error'] = error
        if text is not None:
            extras['reason_delivered'] = False  # R-4 is TO VERIFY: the reason stays in LuveBot and its audit, not claimed delivered
        return view(conn.execute('SELECT * FROM approvals WHERE request_id=?', (request_id,)).fetchone()), draft_rule, extras
    finally:
        conn.close()


def _draft(path, row, draft):
    """RT 5: "Always allow" = this request was decided once; the rule is a DRAFT for this Bot, never active."""
    action = rules.Action(bot=row['bot'], tool=row['tool'] or 'terminal', command=row['command_redacted'] or None)
    try:
        rule = rules.draft_from_always_allow(action, label=draft['label'], level=rules.Level(draft['level']),
                                             rule_id='aa-' + uuid.uuid4().hex[:12])
    except rules.RuleError as error:
        return None, str(error.args[0])
    try:
        rules_store.save(path, rule, bot=row['bot'])
    except Exception:  # M2: the request WAS decided and consumed; a draft that could not be saved is reported next to that fact
        return None, 'draft_not_saved'
    return rules_store.rule_to_dict(rule), None
