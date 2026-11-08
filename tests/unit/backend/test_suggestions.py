"""Contract v0.8 section 5 (backend/suggestions.py): a rule is suggested after the same action class of the same Bot was approved
"uma vez" 3 times in 7 days with no denial; never after a denial; older approvals do not count; "Ignorar" hides it for 30 days;
the preview is a DRAFT from the "Sempre permitir" engine call and nothing is written to the rules. Mutations: denials counted as
approvals; the 7-day window dropped; the dismissal ignored."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sqlite3
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
NOW = 1_800_000_000.0
DAY = 86400.0


def load(edit=None):
    name = f'sugg_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.suggestions')
    source = (BACKEND / 'suggestions.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.suggestions', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'suggestions.py'), 'exec'), module.__dict__)
    return module


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append(action)
        return fn()


def decide(sg, db, bot, key, choice, at, command='git push', tool='terminal'):
    approvals = sys.modules[sg.__package__ + '.approvals']
    conn = approvals.connect(db)
    with conn:
        conn.execute('INSERT INTO approvals (request_id, run_id, source, bot, surface, mechanism, tool, command_redacted, description, '
                     'pattern_keys, allowed_choices, digest, action_class_hash, created_at, expires_at, status, decided_by, '
                     "decided_choice, decided_at) VALUES (?,?,'run',?,'run','pattern',?,?,'d','[]','[]','x',?,?,?,'consumed','ana',?,?)",
                     (f'req_{next(_n)}', 'run_1', bot, tool, command, approvals.action_class_hash(bot, 'pattern', key), at, at + 300, choice, at))
    conn.close()
    return approvals.action_class_hash(bot, 'pattern', key)


def checks(sg, tmp_path):
    db = tmp_path / f's{next(_n)}.db'
    push = [decide(sg, db, 'vendas', 'git push', 'once', NOW - d * DAY) for d in (1, 2, 3)][0]
    for d in (1, 2, 3, 4):
        decide(sg, db, 'vendas', 'rm', 'once', NOW - d * DAY, 'rm x')
    decide(sg, db, 'vendas', 'rm', 'deny', NOW - 0.5 * DAY, 'rm x')                       # a denial: no suggestion for rm
    for d in (1, 2, 10):
        decide(sg, db, 'vendas', 'curl', 'once', NOW - d * DAY, 'curl x')                 # only 2 inside the 7 days
    for d in (1, 2):
        decide(sg, db, 'suporte', 'git push', 'once', NOW - d * DAY)                     # another Bot: counted apart
    found = sg.rule_suggestions(db, now=NOW)
    assert [(s['bot'], s['action_class'], s['count']) for s in found] == [('vendas', push, 3)]
    preview = found[0]['draft_preview']
    assert preview is not None and preview['state'] == 'draft' and found[0]['action'] == {'tool': 'terminal', 'command': 'git push'}
    assert found[0]['whole_tool'] is False                                                   # it names a command
    rules_store = sys.modules[sg.__package__ + '.rules_store']
    conn = rules_store.connect(db)
    try:                                                                                     # a preview writes no rule
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'rule%'")]
        assert all(conn.execute(f'SELECT count(*) FROM {t}').fetchone()[0] == 0 for t in tables)
    finally:
        conn.close()
    audit = Audit()
    assert sg.validate_dismiss({'bot': 'vendas', 'action_class': push}) == ('vendas', push)
    for bad in ({'bot': 'vendas'}, {'bot': 'vendas', 'action_class': 'x' * 64}):
        try:
            sg.validate_dismiss(bad)
            raise AssertionError('accepted ' + repr(bad))
        except sg.PluginError:
            pass
    sg.dismiss(audit, 'ana', db, 'vendas', push, now=NOW)
    assert sg.rule_suggestions(db, now=NOW) == [] and audit.rows == ['suggestion.dismiss']   # hidden for 30 days
    for d in (0.1, 0.2, 0.3):
        decide(sg, db, 'vendas', 'git push', 'once', NOW + 31 * DAY - d * DAY)
    assert [s['action_class'] for s in sg.rule_suggestions(db, now=NOW + 31 * DAY)] == [push]   # back after 30 days


def scope_checks(sg, tmp_path):
    """M2 (red team, 29/10): an action with no command must never become "allow the whole tool" without saying so."""
    db = tmp_path / f's{next(_n)}.db'
    for tool in ('write_file', 'patch', 'kanban_create', 'cronjob_manage'):                  # tools with a path or recipient adapter: 3 DIFFERENT pages/recipients, one class
        for d in (1, 2, 3):
            decide(sg, db, 'vendas', 'k_' + tool, 'once', NOW - d * DAY, '', tool)
    assert sg.rule_suggestions(db, now=NOW) == []                                           # no suggestion would be honest: it cannot name the path or the recipient
    web = [decide(sg, db, 'vendas', 'k_web', 'once', NOW - d * DAY, '', 'web_search') for d in (1, 2, 3)][0]
    found = sg.rule_suggestions(db, now=NOW)
    assert [(s['action_class'], s['action']) for s in found] == [(web, {'tool': 'web_search', 'command': None})]
    assert found[0]['whole_tool'] is True                                                   # the screen says "every time the Bot uses web_search"


def test_rule_suggestions(tmp_path):
    checks(load(), tmp_path)


def test_a_toolwide_suggestion_says_so_and_path_tools_are_not_suggested(tmp_path):
    scope_checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ("            if tool in rules.ADAPTERS:", "            if False:"),
    ("                        'whole_tool': not latest['command_redacted'],", "                        'whole_tool': False,"),
], ids=['path_tools_suggested', 'whole_tool_not_said'])
def test_each_scope_mutation_is_caught(tmp_path, edit):
    with pytest.raises(AssertionError):
        scope_checks(load(edit), tmp_path)


@pytest.mark.parametrize('edit', [
    ("                AND d.decided_choice = 'deny' AND d.decided_at >= ?) ", "                AND d.decided_choice = 'never' AND d.decided_at >= ?) "),
    ("WHERE a.decided_choice = 'once' AND a.decided_at >= ? ", "WHERE a.decided_choice = 'once' AND a.decided_at >= ? - 1e12 "),
    ("                AND s.action_class_hash = a.action_class_hash AND s.until > ?) ",
     "                AND s.action_class_hash = a.action_class_hash AND s.until > ? + 1e12) "),
], ids=['denials_counted', 'no_window', 'dismissal_ignored'])
def test_each_mutation_is_caught(tmp_path, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), tmp_path)
