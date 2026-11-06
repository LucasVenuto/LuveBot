"""A denial LuveBot made on a `details_unavailable` request must not read as a decision made OUTSIDE LuveBot (a false `approval.out_of_band` alarm).
The observer in the hook reports Hermes's `post_approval_response` with the request's key (`plugin_rule:luvebot:<rule>#<id>.<nonce>`) and `out_of_band` looks
LuveBot's own claimed row up by that key. (1) A request whose message carries the link but whose row was not found (another Bot's, already tied) still keeps its
own key, the one Hermes will report. (2) A request with NO link at all (a hook before 0.8.0, `luvebot:rules_unavailable`, a lost row) has no key to look up:
a narrow fallback accepts a denial LuveBot itself claimed a moment ago for the same rule and choice. A decision Hermes reports that LuveBot never made still alarms."""
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sqlite3
import sys
import time

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
RULE = 'builtin.sensitive_access.commands'
NONCE = '0123456789abcdef'


def load(edit=None):
    name = f'oob_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    if edit:
        source = (BACKEND / 'approvals.py').read_text()
        assert source.count(edit[0]) == 1, edit[0]
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.approvals', loader=None))
        module.__package__ = name
        sys.modules[f'{name}.approvals'] = module
        exec(compile(source.replace(*edit), str(BACKEND / 'approvals.py'), 'exec'), module.__dict__)
    return {m: importlib.import_module(f'{name}.{m}') for m in ('approvals', 'hook_store', 'rules')}


def event_of(m, path, bot, rule=RULE):
    return m['hook_store'].record_event(path, bot, 'terminal', rule, 'approve', f'luvebot:ask:{rule}', 't1', 's1', 'call1', 'chmod 600 /tmp/x')


def ask(m, path, description, request_id):
    data = {'request_id': request_id, 'command': '<terminal> (plugin approval rule)', 'description': description, 'choices': ['once', 'deny']}
    return m['approvals'].record_request(path, 'vendas', f'run_{request_id}', 'api_server', data)


def deny(m, path, row):
    actor = m['rules'].Actor(m['rules'].ActorKind.HUMAN, 'maria')
    m['approvals'].resolve(path, lambda *_a: True, actor, row['request_id'], digest=row['digest'], choice='deny')


def checks(m, tmp_path):
    path, ap = tmp_path / 'luvebot.db', m['approvals']
    key = lambda rule, event: f'{ap.HOOK_PREFIX}{rule}#{event}.{NONCE}'  # noqa: E731
    # (1) the message carries the link, the row is another Bot's: unavailable, and the request keeps ITS key
    foreign = event_of(m, path, 'suporte')
    row = ask(m, path, f'luvebot:ask:{RULE}#{foreign}.{NONCE}', 'req1')
    assert row['details_unavailable'] == 1 and json.loads(row['pattern_keys']) == [key(RULE, foreign)]
    deny(m, path, row)
    assert ap.out_of_band(path, 'vendas', key(RULE, foreign), 'deny') is False             # LuveBot's own denial: no alarm
    assert ap.out_of_band(path, 'vendas', key(RULE, foreign), 'once') is True              # an approval Hermes reports that LuveBot never made: alarm
    # (2) no link at all (a hook before 0.8.0): the key Hermes reports is one LuveBot never saw
    old = ask(m, path, f'luvebot:ask:{RULE}', 'req2')
    assert old['details_unavailable'] == 1 and json.loads(old['pattern_keys']) == []
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'deny') is True                  # nobody denied it yet: a decision from outside
    deny(m, path, old)
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'deny') is False                 # LuveBot denied it a moment ago, same rule and choice
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'once') is True                  # Hermes says it was APPROVED: not what LuveBot did
    assert ap.out_of_band(path, 'suporte', key(RULE, 777), 'deny') is True                 # another Bot's decision
    assert ap.out_of_band(path, 'vendas', key('another.rule', 777), 'deny') is True        # another rule's
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'deny', now=time.time() + 59) is False   # inside the 60 s window
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'deny', now=time.time() + 70) is True     # past it: not "a moment ago"
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'deny', now=10 ** 10) is True             # long ago
    # a `once` Hermes reports inside the window STILL alarms, even if some row of that request were decided `once` (LuveBot never approves blind; an old build might have):
    conn = sqlite3.connect(path)
    conn.execute("UPDATE approvals SET decided_choice='once' WHERE request_id=?", (old['request_id'],))
    conn.commit()
    conn.close()
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'once') is True
    assert ap.out_of_band(path, 'vendas', key(RULE, 777), 'deny') is True          # and a deny Hermes reports is not explained by a row decided `once`
    conn = sqlite3.connect(path)
    conn.execute("UPDATE approvals SET decided_choice='deny' WHERE request_id=?", (old['request_id'],))
    conn.commit()
    conn.close()
    other = ask(m, path, 'luvebot:rules_unavailable', 'req3')                              # no key to know at all, and the rule is not the key's
    deny(m, path, other)
    assert ap.out_of_band(path, 'vendas', f'{ap.HOOK_PREFIX}rules_unavailable#{"a" * 32}', 'deny') is False
    # a plain linked request (the row found): by key, as before
    event = event_of(m, path, 'vendas', 'r.linked')
    linked = ask(m, path, f'luvebot:ask:r.linked#{event}.{NONCE}', 'req4')
    assert linked['details_unavailable'] == 0
    assert ap.out_of_band(path, 'vendas', key('r.linked', event), 'deny') is True          # not decided yet
    deny(m, path, linked)
    assert ap.out_of_band(path, 'vendas', key('r.linked', event), 'deny') is False


def test_a_denial_made_in_the_inbox_is_never_out_of_band(tmp_path):
    checks(load(), tmp_path)


MUTATIONS = [
    ('the key is dropped for a row not found', "            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}.{nonce}']\n",
     "            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}.{nonce}'] if event is not None else []\n"),
    ('no fallback for a request with no key', "    if blind:  # a request LuveBot could not tie to a key, denied here a moment ago\n        return False\n", "    pass\n"),
    ('the fallback explains any choice, not only a denial', "blind = choice == 'deny' and conn.execute(", "blind = conn.execute("),
    ('the window is five minutes again', "OWN_DENIAL_S = 60.0", "OWN_DENIAL_S = 300.0"),
    ('the fallback ignores the choice', "AND decided_choice=? AND rule_id=?", "AND (decided_choice=? OR 1) AND rule_id=?"),
    ('the fallback ignores the Bot', "WHERE bot=? AND details_unavailable=1", "WHERE (bot=? OR 1) AND details_unavailable=1"),
    ('the fallback ignores the rule', "AND rule_id=? AND decided_at >= ?", "AND (rule_id=? OR 1) AND decided_at >= ?"),
    ('the fallback has no time limit', "AND decided_at >= ? LIMIT 1", "AND (decided_at >= ? OR 1) LIMIT 1"),
    ('the fallback explains any denial', "WHERE bot=? AND details_unavailable=1 AND pattern_keys='[]'", "WHERE bot=? AND details_unavailable IN (0, 1) AND pattern_keys IS NOT NULL"),
]


@pytest.mark.parametrize('label,old,new', MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_each_mutation_is_caught(label, old, new, tmp_path):
    with pytest.raises(Exception):  # noqa: B017
        checks(load((old, new)), tmp_path)
