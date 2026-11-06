"""Contract v0.9 section 1.9: linking a request to the hook's event on a canonical Hermes (v0.22.3+), where `pattern_keys` never arrives. The key is read
from `pattern_keys` (older Hermes) OR from the WHOLE `description` (`luvebot:ask:<rule>#<event>.<nonce>`), one strict parse; any other shape names no row and the
request is `details_unavailable`: Approve is refused (C1), Deny stands (it cannot cause an action), and an `ask` rule on a canonical Hermes with a hook before
0.8.0 is sealed `broken` with `hook_outdated`. Each check also runs against a variant with one defect: each must go red."""
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
_n = itertools.count()
NONCE = 'a1b2c3d4e5f60718'
RULE = 'builtin.sensitive_access.commands'


def load(edit=None, which='approvals'):
    name = f'lk_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    if edit:
        source = (BACKEND / f'{which}.py').read_text()
        assert source.count(edit[0]) == 1, edit[0]
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{which}', loader=None))
        module.__package__ = name
        sys.modules[f'{name}.{which}'] = module
        exec(compile(source.replace(*edit), str(BACKEND / f'{which}.py'), 'exec'), module.__dict__)
    return {m: importlib.import_module(f'{name}.{m}') for m in ('approvals', 'hook_store', 'rules')}


def refused(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    raise AssertionError('not refused')


def ask_event(m, path, bot='vendas', rule=RULE):
    return m['hook_store'].record_event(path, bot, 'terminal', rule, 'approve', f'luvebot:ask:{rule}' if rule else 'luvebot:origin_unreadable', 't1', 's1', 'call1', 'chmod 600 /tmp/x')


def request(m, path, description, *, bot='vendas', request_id='req1'):
    """What a canonical Hermes sends: a prompt_id (mapped to request_id by the SSE transform), the placeholder command, the hook's message as the description."""
    data = {'request_id': request_id, 'command': '<terminal> (plugin approval rule)', 'description': description, 'choices': ['once', 'deny', 'session', 'always']}
    return m['approvals'].record_request(path, bot, f'run_{request_id}', 'api_server', data)


def human(m):
    return m['rules'].Actor(m['rules'].ActorKind.HUMAN, 'maria')


def link_checks(m, tmp_path):
    path = tmp_path / 'luvebot.db'
    event = ask_event(m, path)
    good = request(m, path, f'luvebot:ask:{RULE}#{event}.{NONCE}')
    assert (good['mechanism'], good['rule_id'], good['tool'], good['command_redacted'], good['details_unavailable']) == ('hook_approve', RULE, 'terminal', 'chmod 600 /tmp/x', 0)
    # the key in pattern_keys (an older Hermes) keeps working, whatever the description says
    event2 = ask_event(m, path)
    old = m['approvals'].record_request(path, 'vendas', 'run_old', 'api_server', {'request_id': 'req_old', 'description': 'x', 'choices': ['once', 'deny'],
                                                                              'pattern_keys': [f'{m["approvals"].HOOK_PREFIX}{RULE}#{event2}.{NONCE}']})
    assert old['mechanism'] == 'hook_approve' and old['details_unavailable'] == 0 and old['command_redacted'] == 'chmod 600 /tmp/x'
    bad = {}
    event3 = ask_event(m, path)
    for label, description, bot in (('cut', f'luvebot:ask:{RULE}#{event3}', 'vendas'),                              # no nonce: cut short
                                    ('cut_in_the_nonce', f'luvebot:ask:{RULE}#{event3}.{NONCE[:4]}', 'vendas'),
                                    ('extra_text', f'luvebot:ask:{RULE}#{event3}.{NONCE} (please approve)', 'vendas'),
                                    ('another_rule', f'luvebot:ask:other.rule#{event3}.{NONCE}', 'vendas'),
                                    ('no_link', f'luvebot:ask:{RULE}', 'vendas'),                                    # a hook before 0.8.0
                                    ('another_bot', f'luvebot:ask:{RULE}#{event3}.{NONCE}', 'suporte'),
                                    ('already_linked', f'luvebot:ask:{RULE}#{event}.{NONCE}', 'vendas')):
        row = request(m, path, description, bot=bot, request_id='req_' + label)
        bad[label] = row
        assert row['details_unavailable'] == 1 and row['command_redacted'] == '' and row['tool'] is None, label     # never the placeholder as the command
        assert row['mechanism'] == 'hook_approve' and row['hook_event_id'] is None, label
    assert bad['no_link']['rule_id'] == RULE and bad['another_bot']['rule_id'] == RULE
    plain = request(m, path, 'recursive delete', request_id='req_plain')                                           # Hermes's own command gate: untouched
    assert plain['mechanism'] == 'command_gate' and plain['details_unavailable'] == 0
    long = request(m, path, 'luvebot:ask:' + 'x' * 200, request_id='req_long')                                     # our namespace, a message that is none of the hook's: never a plain gate
    assert (long['mechanism'], long['details_unavailable'], long['command_redacted']) == ('hook_approve', 1, '')


def blind_checks(m, tmp_path):
    path = tmp_path / 'luvebot.db'
    ap = m['approvals']
    sent = []

    def dispatch(bot, run_id, choice, request_id):
        sent.append((choice, request_id))
        return True
    blind = request(m, path, f'luvebot:ask:{RULE}', request_id='req_blind')
    assert blind['details_unavailable'] == 1
    for choice in tuple(c for c in m['approvals'].CHOICES if c != 'deny'):
        error = refused(lambda: ap.resolve(path, dispatch, human(m), 'req_blind', digest=blind['digest'], choice=choice))
        assert error.code == 'details_unavailable', choice
    assert sent == [] and ap.get(path, 'req_blind')['status'] == 'pending'                                        # nothing approved, nothing sent
    view, _draft, _extras = ap.resolve(path, dispatch, human(m), 'req_blind', digest=blind['digest'], choice='deny')
    assert view['status'] == 'consumed' and sent == [('deny', 'req_blind')]                                        # the denial stands: the Bot stops waiting
    other = request(m, path, f'luvebot:ask:{RULE}', request_id='req_blind2')
    assert refused(lambda: ap.check_pending(path, 'req_blind2', other['digest'], choice='once')).code == 'details_unavailable'
    assert refused(lambda: ap.check_pending(path, 'req_blind2', other['digest'])).code == 'details_unavailable'
    assert ap.check_pending(path, 'req_blind2', other['digest'], choice='deny')['request_id'] == 'req_blind2'     # a batch of denials passes


def seal_checks(m, _tmp_path):
    rules = m['rules']
    state = lambda authority, version: types.SimpleNamespace(session_authority=authority, hook=types.SimpleNamespace(plugin_version=version))  # noqa: E731
    ask, block = types.SimpleNamespace(level=rules.Level.ASK), types.SimpleNamespace(level=rules.Level.BLOCK)
    assert rules.LINKED_APPROVAL_VERSION == (0, 8, 0)
    for version in ('0.7.0', '0.6.0', None, 'unknown'):                                                          # an older hook, or one nobody can read
        found = rules._linked_problems(ask, state(True, version))
        assert [p.code for p in found] == ['hook_outdated'], version
    assert rules._linked_problems(ask, state(True, '0.8.0')) == [] and rules._linked_problems(ask, state(True, '0.9.1')) == []
    assert rules._linked_problems(ask, state(False, '0.7.0')) == []                                              # an older Hermes: pattern_keys still arrive
    assert rules._linked_problems(block, state(True, '0.7.0')) == []                                              # only an `ask` makes a request


def forms_checks(m, tmp_path):
    """Each of the hook's four messages (+ `#<event>.<nonce>`) ties ITS row and rebuilds the key the old Hermes copied; the table keeps the message alone."""
    path = tmp_path / 'luvebot.db'
    prefix = m['approvals'].HOOK_PREFIX
    cases = (('luvebot:ask:R.x', 'R.x'), ('luvebot:origin_unreadable', None), ('luvebot:origin_unverifiable', None), ('luvebot:origin_unverifiable:ana-bot_2', None),
             ('luvebot:origin:vendas:luvebot:ask:R.x', 'R.x'))
    for n, (base, rule) in enumerate(cases):
        event = ask_event(m, path, rule=rule)                                  # the row of that call: rule NULL for a verdict with no rule
        row = request(m, path, f'{base}#{event}.{NONCE}', request_id=f'req_f{n}')
        assert (row['details_unavailable'], row['hook_event_id'], row['mechanism'], row['description']) == (0, event, 'hook_approve', base), base
        assert json.loads(row['pattern_keys']) == [f'{prefix}{rule or "noncanonical"}#{event}.{NONCE}'], base
        assert row['command_redacted'] == 'chmod 600 /tmp/x' and row['tool'] == 'terminal'
    ev_rule, ev_nc, foreign = ask_event(m, path, rule='R'), ask_event(m, path, rule=None), ask_event(m, path, bot='suporte', rule=None)
    bad = {'cut': f'luvebot:origin_unreadable#{ev_nc}', 'extra': f'luvebot:origin_unverifiable#{ev_nc}.{NONCE} x',
           'origin_with_a_space': f'luvebot:origin:a b:luvebot:ask:R#{ev_rule}.{NONCE}', 'origin_with_a_colon': f'luvebot:origin:a:b:luvebot:ask:R#{ev_rule}.{NONCE}',
           'origin_too_long': f'luvebot:origin_unverifiable:{"a" * 65}#{ev_nc}.{NONCE}', 'origin_unverifiable_no_link': 'luvebot:origin_unverifiable:ana',
           'rules_unavailable': 'luvebot:rules_unavailable', 'a_new_message': f'luvebot:something_new#{ev_nc}.{NONCE}',
           'arabic_digit': f'luvebot:origin_unreadable#\u0661\u0662.{NONCE}', 'upper_nonce': f'luvebot:origin_unreadable#{ev_nc}.{NONCE.upper()}',
           'another_bots_row': f'luvebot:origin_unreadable#{foreign}.{NONCE}'}                 # parses, but the row is another Bot's: no row, and no key that points at it
    for label, description in bad.items():
        row = request(m, path, description, request_id='req_b_' + label)
        assert row['details_unavailable'] == 1 and row['hook_event_id'] is None and row['mechanism'] == 'hook_approve' and row['command_redacted'] == '', label
        keep = [f'{prefix}noncanonical#{foreign}.{NONCE}'] if label == 'another_bots_row' else []      # it parses: the key is the request's own (out_of_band finds a denial by it)
        assert json.loads(row['pattern_keys']) == keep, label
    assert request(m, path, f'luvebot:origin_unreadable#{foreign}.{NONCE}', request_id='req_b_again')['description'] == 'luvebot:origin_unreadable'   # the suffix is never shown


CHECKS = {'link': link_checks, 'forms': forms_checks, 'blind': blind_checks, 'seal': seal_checks}
MUTATIONS = [
    ('link', 'the description is ignored', "    link = _link_of(description)\n    if link:\n        return link[0], int(link[1])", "    link = None\n    if link:\n        return link[0], int(link[1])", 'approvals'),
    ('link', 'a prefix is enough', "#(?P<event>[0-9]{{1,17}})\\.(?P<nonce>[0-9a-f]{{8,64}})', re.ASCII)", "#(?P<event>[0-9]{{1,17}})\\.(?P<nonce>[0-9a-f]{{8,64}}).*', re.ASCII)", 'approvals'),
    ('link', 'the nonce is optional', "#(?P<event>[0-9]{{1,17}})\\.(?P<nonce>[0-9a-f]{{8,64}})'", "#(?P<event>[0-9]{{1,17}})(?:\\.(?P<nonce>[0-9a-f]{{8,64}}))?'", 'approvals'),
    ('link', 'a short nonce passes', "(?P<nonce>[0-9a-f]{{8,64}})'", "(?P<nonce>[0-9a-f]{{1,64}})'", 'approvals'),
    ('forms', 'any origin passes', "_RULE, _ORIGIN = r'[A-Za-z0-9_.:-]{1,128}', r'[A-Za-z0-9_-]{1,64}'", "_RULE, _ORIGIN = r'[A-Za-z0-9_.:-]{1,128}', r'.{1,64}'", 'approvals'),
    ('forms', 'an origin of any length passes', "r'[A-Za-z0-9_-]{1,64}'\n", "r'[A-Za-z0-9_-]+'\n", 'approvals'),
    ('link', 'no link is a plain gate', "        return (named.group(1) if named else 'noncanonical'), None", "        return None, None", 'approvals'),
    ('link', 'the description is not passed', "_hook_key(keys, data.get('description'))", "_hook_key(keys)", 'approvals'),
    ('forms', 'only the ask form is linked', "f'luvebot:origin:{_ORIGIN}:luvebot:ask:(?P<rule2>{_RULE})')", "f'luvebot:origin:{_ORIGIN}:luvebot:ask:(?P<rule2>{_RULE})' if False else 'luvebot:never')", 'approvals'),
    ('forms', 'a verdict with no rule names its rule', "found.group('rule') or found.group('rule2') or 'noncanonical'", "found.group('rule') or found.group('rule2') or 'origin'", 'approvals'),
    ('forms', 'the inner rule is not the key rule', "found.group('rule') or found.group('rule2') or", "found.group('rule') or", 'approvals'),
    ('forms', 'the key is dropped for a row not found', "            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}.{nonce}']\n",
     "            keys = [f'{HOOK_PREFIX}{rule_key}#{event_no}.{nonce}'] if event is not None else []\n", 'approvals'),
    ('blind', 'a denial is blocked too', "        if row['details_unavailable'] and choice != 'deny':  # C1: never APPROVED blind", "        if row['details_unavailable']:  # C1: never APPROVED blind", 'approvals'),
    ('blind', 'an approval gets through', "        if row['details_unavailable'] and choice != 'deny':  # C1: never APPROVED blind", "        if False:  # C1: never APPROVED blind", 'approvals'),
    ('blind', 'the batch blocks a denial', "    if row['details_unavailable'] and choice != 'deny':  # C1 amended", "    if row['details_unavailable']:  # C1 amended", 'approvals'),
    ('seal', 'any version passes', "not (version is not None and version >= LINKED_APPROVAL_VERSION)", "False", 'rules'),
    ('seal', 'an unknown version passes', "not (version is not None and version >= LINKED_APPROVAL_VERSION)", "(version is not None and version < LINKED_APPROVAL_VERSION)", 'rules'),
    ('seal', 'no authority needed', "rule.level is Level.ASK and state.session_authority and", "rule.level is Level.ASK and", 'rules'),
    ('seal', 'every level', "rule.level is Level.ASK and state.session_authority and", "state.session_authority and", 'rules'),
]


@pytest.mark.parametrize('name', sorted(CHECKS))
def test_the_check_holds_on_the_real_modules(name, tmp_path):
    CHECKS[name](load(), tmp_path)


def test_every_check_has_a_mutation():
    assert set(CHECKS) == {name for name, *_ in MUTATIONS}


@pytest.mark.parametrize('name,label,old,new,which', MUTATIONS, ids=[f'{n}|{l}' for n, l, *_ in MUTATIONS])
def test_each_mutation_is_caught(name, label, old, new, which, tmp_path):
    with pytest.raises(Exception):  # noqa: B017  (a variant may fail with another error than the assertion: red all the same)
        CHECKS[name](load((old, new), which), tmp_path)


def test_the_seal_and_the_live_state_are_wired():
    rules, live = (BACKEND / 'rules.py').read_text(), (BACKEND / 'live_state.py').read_text()
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    assert '+ _linked_problems(rule, state)\n    hook_ok' in rules and 'session_authority: bool = False' in rules
    assert 'session_authority=canonical.authority(bot)' in live
    assert "approvals.check_pending(meta.path, i['request_id'], i['digest'], choice=i.get('choice'))" in api
    assert json.dumps(rules).count('LINKED_APPROVAL_VERSION = (0, 8, 0)') == 1
