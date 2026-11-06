"""Rule suggestions (contract plugin-api v0.8, section 5; spec 4.10 "Bots podem propor regras, mas só você aprova").

Built only from LuveBot's own approvals: the same action class of the same Bot approved "uma vez" 3 or more times in 7 days,
with no denial of it in those 7 days, is suggested as a rule. The suggestion carries a DRAFT preview made by the same engine
call as "Sempre permitir…" (rules.draft_from_always_allow); nothing is saved or applied here: the person opens the editor
prefilled and saves a draft through the existing rule routes (invariant 6 holds as written). "Ignorar" hides a class for 30 days.
"""
import re
import time

from . import approvals, rules, rules_store
from .api_errors import PluginError

WINDOW = 7 * 86400
MIN_ONCE = 3
DISMISS_FOR = 30 * 86400
_HASH = re.compile(r'[0-9a-f]{64}')
_SCHEMA = ('CREATE TABLE IF NOT EXISTS suggestion_dismissals (bot TEXT NOT NULL, action_class_hash TEXT NOT NULL, '
           'until REAL NOT NULL, PRIMARY KEY (bot, action_class_hash))')


def rule_suggestions(path, *, now=None):
    now = time.time() if now is None else now
    since = now - WINDOW
    conn = approvals.connect(path)
    try:
        conn.execute(_SCHEMA)
        rows = conn.execute(
            "SELECT a.bot, a.action_class_hash, count(*) AS n, max(a.decided_at) AS last FROM approvals a "
            "WHERE a.decided_choice = 'once' AND a.decided_at >= ? "
            "AND NOT EXISTS (SELECT 1 FROM approvals d WHERE d.bot = a.bot AND d.action_class_hash = a.action_class_hash "
            "                AND d.decided_choice = 'deny' AND d.decided_at >= ?) "
            "AND NOT EXISTS (SELECT 1 FROM suggestion_dismissals s WHERE s.bot = a.bot "
            "                AND s.action_class_hash = a.action_class_hash AND s.until > ?) "
            "GROUP BY a.bot, a.action_class_hash HAVING count(*) >= ? ORDER BY last DESC",
            (since, since, now, MIN_ONCE)).fetchall()
        out = []
        for row in rows:
            latest = conn.execute("SELECT tool, command_redacted FROM approvals WHERE bot = ? AND action_class_hash = ? "
                                  "AND decided_choice = 'once' ORDER BY decided_at DESC LIMIT 1",
                                  (row['bot'], row['action_class_hash'])).fetchone()
            tool = latest['tool'] or 'terminal'
            if tool in rules.ADAPTERS:  # a rule for it would cover EVERY path or recipient (the class mixes them): the card's "Sempre permitir" names the one it knows
                continue
            out.append({'kind': 'rule', 'bot': row['bot'], 'action_class': row['action_class_hash'], 'count': row['n'],
                        'action': {'tool': tool, 'command': latest['command_redacted'] or None},
                        'whole_tool': not latest['command_redacted'],  # no command to scope it: the rule allows the tool EVERY time, and the screen must say so
                        'draft_preview': _preview(row['bot'], latest)})
        return out
    finally:
        conn.close()


def _preview(bot, latest):
    """The draft "Sempre permitir…" would make for this action; None when the action cannot become a rule (not canonical)."""
    action = rules.Action(bot=bot, tool=latest['tool'] or 'terminal', command=latest['command_redacted'] or None)
    try:
        rule = rules.draft_from_always_allow(action, label=f'{bot}: permitir {latest["tool"] or "terminal"}',
                                             rule_id='sg-preview')
    except rules.RuleError:
        return None
    return rules_store.api_dict(rule)


def validate_dismiss(body):
    if not isinstance(body, dict) or set(body) != {'bot', 'action_class'}:
        raise PluginError('bad_request', 'Send {"bot", "action_class"}.', 400)
    if not isinstance(body['action_class'], str) or not _HASH.fullmatch(body['action_class']):
        raise PluginError('invalid_field', 'Invalid value for action_class.', 422)
    return body['bot'], body['action_class']


def dismiss(audit, actor, path, bot, action_class, *, now=None):
    """"Ignorar": hides that class of that Bot for 30 days (audited)."""
    until = (time.time() if now is None else now) + DISMISS_FOR

    def effect():
        conn = approvals.connect(path)
        try:
            with conn:
                conn.execute(_SCHEMA)
                conn.execute('INSERT OR REPLACE INTO suggestion_dismissals VALUES (?,?,?)', (bot, action_class, until))
        finally:
            conn.close()
    audit.act(actor, 'suggestion.dismiss', f'{bot}:{action_class[:16]}', 'ui', effect, bot=bot)
    return {'until': until}
