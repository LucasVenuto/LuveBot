"""SQLite persistence of rules (contract v0.1 section 5, logical table `rules`) and their JSON shape.

Only stored facts: a seal is never saved (it is recomputed from the live state at every read). Stdlib only; the pure engine
`rules.py` owns every decision about what a rule means or how its state may change.
"""
import hashlib
import json
import sqlite3
import time

from . import dbfile, hook_store
from .rules import Match, Origin, Level, Rule, RuleError, RuleState, Scope, ScopeKind

SCHEMA = """
CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY, bot TEXT, state TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT NOT NULL,
    updated_at REAL NOT NULL, rule_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_bot ON rules (bot, state);
"""


def connect(path):
    conn = hook_store.connect(path)
    dbfile.ensure(conn, path, SCHEMA)
    return conn


def rule_to_dict(rule):
    """JSON shape of contract section 3: enum values, tuples as arrays."""
    m = rule.match
    return {'id': rule.id, 'label': rule.label, 'level': rule.level.value,
            'scope': {'kind': rule.scope.kind.value, 'ref': rule.scope.ref},
            'match': {'tools': list(m.tools), 'toolsets': list(m.toolsets), 'mcp_servers': list(m.mcp_servers),
                      'commands': list(m.commands), 'conditions': [list(c) for c in m.conditions]},
            'state': rule.state.value, 'origin': rule.origin.value, 'builtin': rule.builtin, 'applied': list(rule.applied),
            'version': rule.version, 'updated_by': rule.updated_by}


def conditions_to_api(conditions):
    """The API form of a rule's conditions: `{fact, op, value}`, the path operator read out of its key (`path:under` -> fact `path`, op
    `under`); any other fact is an equality (`eq`). STORAGE and the activation digest keep the plain (fact, value) pairs, unchanged."""
    from .rules import RECIPIENT_FACT, fact_of, path_op
    return [{'fact': 'path', 'op': path_op(k), 'value': v} if path_op(k) else
            {'fact': RECIPIENT_FACT, 'op': 'eq', 'value': v} if fact_of(k) == RECIPIENT_FACT else {'fact': k, 'op': 'eq', 'value': v} for k, v in conditions]


def api_dict(rule):
    """rule_to_dict for the API: the conditions change shape, and `exact` (AA-1) and `covers` (AA-1b) are added."""
    from .rules import covers, exact
    out = rule_to_dict(rule)
    out['match'] = {**out['match'], 'conditions': conditions_to_api(rule.match.conditions)}
    out['exact'] = exact(rule.match)   # AA-1 (A-255): true when nothing of the match is a wildcard, a tree or a missing command; the screen says what the rule covers from THIS, never from its own reading of the pattern
    out['covers'] = covers(rule.match)   # AA-1b (A-286): what the rule covers, from the engine, beside `exact` (which stays a boolean for any screen that tests `if (rule.exact)`)
    return out


def rule_from_dict(data):
    """Strict inverse of rule_to_dict; anything off raises RuleError("bad_rule") (a stored row is never half-trusted)."""
    try:
        m, s = data['match'], data['scope']
        return Rule(id=data['id'], label=data['label'], level=Level(data['level']),
                    scope=Scope(ScopeKind(s['kind']), s['ref']),
                    match=Match(tuple(m['tools']), tuple(m['toolsets']), tuple(m['mcp_servers']), tuple(m['commands']),
                                tuple((str(a), str(b)) for a, b in m['conditions'])),
                    state=RuleState(data['state']), origin=Origin(data['origin']), builtin=bool(data['builtin']),
                    applied=tuple(data['applied']), version=int(data['version']), updated_by=data['updated_by'])
    except (KeyError, TypeError, ValueError):
        raise RuleError('bad_rule') from None


class StoreRefused(Exception):
    """M4: the store will not write an ACTIVE rule that no human activation vouches for, nor replace an active one."""


def activation_digest(rule):
    """Digest of the rule exactly as it becomes ACTIVE; the `rule.activate` audit row carries it (see rules_service)."""
    raw = json.dumps(rule_to_dict(rule), sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def _guard(conn, rule):
    row = conn.execute('SELECT state FROM rules WHERE id=?', (rule.id,)).fetchone()
    if row is not None and row['state'] == RuleState.ACTIVE.value and rule.state is not RuleState.ARCHIVED:
        raise StoreRefused('an active rule can only be archived')
    if rule.state is RuleState.ACTIVE:
        try:
            intent = conn.execute("SELECT 1 FROM audit_log WHERE action='rule.activate' AND target=? AND digest=? LIMIT 1",
                                  (rule.id, activation_digest(rule))).fetchone()
        except sqlite3.OperationalError:
            intent = None
        if intent is None:
            raise StoreRefused('no audited human activation for this rule')


def save(path, rule, *, bot=None, now=None):
    """Insert or replace a rule by id. `bot` is the Bot the rule belongs to (None for global). An ACTIVE rule needs its audit
    intent row first and an active one is never replaced except by archiving it (M4)."""
    conn = connect(path)
    try:
        _guard(conn, rule)
        conn.execute('INSERT OR REPLACE INTO rules (id, bot, state, version, updated_by, updated_at, rule_json) VALUES (?,?,?,?,?,?,?)',
                     (rule.id, bot, rule.state.value, rule.version, rule.updated_by, time.time() if now is None else now,
                      json.dumps(rule_to_dict(rule), sort_keys=True, separators=(',', ':'))))
        conn.commit()
    finally:
        conn.close()


def load(path, *, bot=None, states=None):
    """Stored rules, oldest first. `bot` limits to that Bot's rules plus global ones."""
    conn = connect(path)
    try:
        sql, args = 'SELECT rule_json, state FROM rules', []
        where = []
        if bot is not None:
            where.append('(bot = ? OR bot IS NULL)')
            args.append(bot)
        if states:
            where.append('state IN (%s)' % ','.join('?' for _ in states))
            args += list(states)
        if where:
            sql += ' WHERE ' + ' AND '.join(where)
        return [rule_from_dict(json.loads(r['rule_json'])) for r in conn.execute(sql + ' ORDER BY updated_at, id', args)]
    finally:
        conn.close()
