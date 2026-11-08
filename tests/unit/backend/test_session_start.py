"""Contract v0.9 section 10 (backend/session_start.py + the RunIndex looks it uses): a first message can start its conversation in the same request.
The decisions, on a real SQLite index and a scripted Hermes: a refusal of a gate sends NO session creation; the sender's own session is never
replaced; a repeat with the same idempotency key reuses the SAME conversation; a `client_message_id` already claimed is a 409 and creates NO session
(and names the first attempt's session); nothing is written by the looks. The route wiring is checked on the source. Mutations: the session made before
the gates; the sender's session replaced; the key not remembered; the duplicate not looked at; the looks writing."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import re
import sqlite3
import sys
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
_n = itertools.count()


@pytest.fixture(autouse=True)
def hermes_imports(monkeypatch):
    """What runs.py's imports reach at load (hermes_client); nothing here is called."""
    modules = {'agent': {}, 'agent.secret_scope': {'current_secret_scope': lambda: None, 'get_secret': lambda *a: None},
               'hermes_cli': {}, 'hermes_cli.profiles': {'list_profile_names': lambda: []},
               'hermes_cli.web_server_profiles': {'_config_profile_scope': None}}
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)


def load(edit=None, which='session_start'):
    name = f'ss_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    if not edit:
        return importlib.import_module(f'{name}.session_start'), importlib.import_module(f'{name}.runs')
    source = (BACKEND / f'{which}.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{which}', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    sys.modules[f'{name}.{which}'] = module
    exec(compile(source.replace(*edit), str(BACKEND / f'{which}.py'), 'exec'), module.__dict__)
    other = 'runs' if which == 'session_start' else 'session_start'
    return (module, importlib.import_module(f'{name}.runs')) if which == 'session_start' else (importlib.import_module(f'{name}.session_start'), module)


class Hermes:
    """What the routes' effects touch: the gates, and the call that makes a session. `events` keeps the order they happened in."""
    def __init__(self, refuse=False):
        self.events, self.refuse, self.made = [], refuse, 0

    def gates(self):
        self.events.append('gates')
        if self.refuse:
            raise RuntimeError('budget_exceeded')

    def create(self):
        self.made += 1
        self.events.append('create')
        return f's_new{self.made}'


def index_of(runs, tmp_path):
    return runs.RunIndex(tmp_path / 'luvebot.db')


YES = lambda session_id: True


def refused(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    raise AssertionError('not refused')


# ---- A: POST /runs ---------------------------------------------------------------------------------------------------------
def test_an_absent_session_is_made_after_the_gates_and_used(tmp_path):
    ss, runs = load()
    hermes = Hermes()
    assert ss.for_run(index_of(runs, tmp_path), 'vendas', None, None, hermes.gates, hermes.create) == 's_new1'
    assert hermes.events == ['gates', 'create']


def test_a_refused_gate_makes_no_session(tmp_path):
    ss, runs = load()
    hermes = Hermes(refuse=True)
    assert str(refused(lambda: ss.for_run(index_of(runs, tmp_path), 'vendas', 'key-1', None, hermes.gates, hermes.create))) == 'budget_exceeded'
    assert hermes.made == 0 and hermes.events == ['gates']


def test_the_senders_own_session_is_never_replaced(tmp_path):
    ss, runs = load()
    hermes = Hermes()
    assert ss.for_run(index_of(runs, tmp_path), 'vendas', 'key-1', 's_mine', hermes.gates, hermes.create) == 's_mine'
    assert hermes.made == 0                                                # and the gates still ran
    assert hermes.events == ['gates']


def test_a_repeat_with_the_same_key_reuses_the_same_conversation(tmp_path):
    ss, runs = load()
    index, hermes = index_of(runs, tmp_path), Hermes()
    first = ss.for_run(index, 'vendas', 'key-1', None, hermes.gates, hermes.create)
    again = ss.for_run(index, 'vendas', 'key-1', None, hermes.gates, hermes.create)
    other_key = ss.for_run(index, 'vendas', 'key-2', None, hermes.gates, hermes.create)
    other_bot = ss.for_run(index, 'suporte', 'key-1', None, hermes.gates, hermes.create)
    assert first == again == 's_new1' and hermes.made == 3 and len({first, other_key, other_bot}) == 3
    assert 'key-1' not in (tmp_path / 'luvebot.db').read_bytes().decode('latin-1')         # only a keyed digest is kept


def test_a_remembered_conversation_expires_after_24_hours(tmp_path):
    ss, runs = load()
    index, hermes = index_of(runs, tmp_path), Hermes()
    ss.for_run(index, 'vendas', 'key-1', None, hermes.gates, hermes.create)
    conn = sqlite3.connect(tmp_path / 'luvebot.db')
    with conn:
        conn.execute("UPDATE run_new_sessions SET ts = '2000-01-01T00:00:00Z'")
    conn.close()
    assert ss.for_run(index, 'vendas', 'key-1', None, hermes.gates, hermes.create) == 's_new2'


def test_racing_repeats_keep_the_first_stored_conversation(tmp_path):
    ss, runs = load()
    index = index_of(runs, tmp_path)
    assert index.remember_session('key-1', 'vendas', 's_a') == 's_a'
    assert index.remember_session('key-1', 'vendas', 's_b') == 's_a'      # the twin that lost keeps the stored one (its own stays empty)


# ---- B: POST /chat/stream --------------------------------------------------------------------------------------------------------
def test_a_claimed_message_is_409_before_any_session_is_made(tmp_path):
    ss, runs = load()
    index, hermes = index_of(runs, tmp_path), Hermes()
    first = ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, YES)
    assert index.claim_message('msg-aaaaaaaa', 'vendas', first) is True      # what the turn does atomically once the session exists
    made = hermes.made
    error = refused(lambda: ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, YES))
    assert (error.code, error.status, error.extra) == ('duplicate', 409, {'details': {'session_id': first}})
    assert hermes.made == made                                             # NO session was created for the second send


def test_a_refused_gate_makes_no_chat_session_and_the_looks_write_nothing(tmp_path):
    ss, runs = load()
    index = index_of(runs, tmp_path)
    hermes = Hermes(refuse=True)
    refused(lambda: ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, YES))
    assert hermes.made == 0
    before = (tmp_path / 'luvebot.db').read_bytes()
    assert index.claimed_session('msg-aaaaaaaa') is None and index.session_for_key('key-1', 'vendas') is None
    assert (tmp_path / 'luvebot.db').read_bytes() == before                # a look is a read


def test_no_client_message_id_just_makes_the_session(tmp_path):
    ss, runs = load()
    hermes = Hermes()
    assert ss.for_chat(index_of(runs, tmp_path), None, hermes.gates, hermes.create, YES) == 's_new1'


def test_an_old_claim_is_not_a_duplicate(tmp_path):
    ss, runs = load()
    index, hermes = index_of(runs, tmp_path), Hermes()
    index.claim_message('msg-aaaaaaaa', 'vendas', 's_old')
    conn = sqlite3.connect(tmp_path / 'luvebot.db')
    with conn:
        conn.execute("UPDATE chat_dedupe SET ts = '2000-01-01T00:00:00Z'")
    conn.close()
    assert ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, YES) == 's_new1'


# ---- the routes' wiring (static; the HTTP behaviour is the harness's) ------------------------------------------------------
def function(source, name):
    return re.search(rf'(?:async )?def {name}\(.*?(?=\n(?:@router|def |async def |class )|\Z)', source, re.S).group(0)


def check_wiring(source):
    run = function(source, 'create_run')
    assert 'session_start.for_run(index, name, fields[\'idempotency_key\'], fields[\'session_id\'], gates, lambda: _new_session(name))' in run
    assert "payload={**fields, 'session_created': True} if new_session else fields" in run and "'run.create'" in run
    assert "'session_id': session_id}}" in run.replace(' ', '') or "'session_id': session_id}" in run                    # the response carries the session
    assert "{'session_id': session_id} if new_session" in run                                                            # a queued answer names it too
    assert 'hook.hook_gate(' in run and 'budget_gate(' in run
    new = function(source, 'chat_stream_new')
    assert "@router.post('/bots/{bot}/chat/stream')" in source
    assert "session_start.for_chat(index, fields['client_message_id'], gates, lambda: _new_session(name), owns)" in new
    assert "'session.create'" in new and "payload={'via': 'chat'}" in new and '_chat_turn(' in new
    assert "validate_chat_body(" in new and '_require_csrf(' in new and "_require_feature(name, 'session_chat_stream')" in new
    assert 'hook.hook_gate(' in new and 'budget_gate(' in new
    assert 'session_id' not in function(source, 'validate_chat_body') if 'def validate_chat_body' in source else True
    chat = function(source, '_chat_turn')
    assert 'queued_extra' in chat
    assert '/fork' not in new and '/fork' not in run


def test_route_wiring():
    check_wiring((ROOT / 'dashboard' / 'plugin_api.py').read_text())


def test_chat_body_without_a_session_rejects_session_id():
    runs_source = (BACKEND / 'runs.py').read_text()
    body = function(runs_source, 'validate_chat_body')
    assert "set(body) - {'input', 'client_message_id', 'page'}" in body      # a session_id in the body is an unknown key: 400


# ---- mutations -------------------------------------------------------------------------------------------------------------------
def scenario_order(ss, runs, tmp):
    hermes = Hermes(refuse=True)
    refused(lambda: ss.for_run(index_of(runs, tmp), 'vendas', 'k', None, hermes.gates, hermes.create))
    assert hermes.made == 0
    hermes = Hermes(refuse=True)
    refused(lambda: ss.for_chat(index_of(runs, tmp), 'msg-aaaaaaaa', hermes.gates, hermes.create, YES))
    assert hermes.made == 0


def scenario_replaced(ss, runs, tmp):
    hermes = Hermes()
    assert ss.for_run(index_of(runs, tmp), 'vendas', 'k', 's_mine', hermes.gates, hermes.create) == 's_mine'


def scenario_reuse(ss, runs, tmp):
    hermes, index = Hermes(), index_of(runs, tmp)
    assert ss.for_run(index, 'vendas', 'k', None, hermes.gates, hermes.create) == ss.for_run(index, 'vendas', 'k', None, hermes.gates, hermes.create)


def scenario_duplicate(ss, runs, tmp):
    hermes, index = Hermes(), index_of(runs, tmp)
    first = ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, YES)
    index.claim_message('msg-aaaaaaaa', 'vendas', first)
    refused(lambda: ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, YES))
    assert hermes.made == 1


def scenario_owned(ss, runs, tmp):
    hermes, index = Hermes(), index_of(runs, tmp)
    index.claim_message('msg-aaaaaaaa', 'vendas', 's_gone')
    error = refused(lambda: ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, lambda s: False))
    assert error.status == 409 and error.extra == {}


def scenario_malformed(ss, runs, tmp):
    hermes, index = Hermes(), index_of(runs, tmp)
    index.claim_message('msg-aaaaaaaa', 'vendas', '../x y')
    error = refused(lambda: ss.for_chat(index, 'msg-aaaaaaaa', hermes.gates, hermes.create, lambda s: True))
    assert error.status == 409 and error.extra == {}


def scenario_look_writes(ss, runs, tmp):
    index = index_of(runs, tmp)
    before = (tmp / 'luvebot.db').read_bytes()
    index.claimed_session('msg-aaaaaaaa')
    index.session_for_key('k', 'vendas')
    assert (tmp / 'luvebot.db').read_bytes() == before


MUTANTS = [
    ('run: the session before the gates', 'session_start', ('    gates()\n    if session_id is not None:', '    made = create() if session_id is None else None\n    gates()\n    if session_id is not None:'), scenario_order),
    ('chat: the session before the gates', 'session_start', ('    gates()\n    known =', '    made = create()\n    gates()\n    known ='), scenario_order),
    ('the sender session replaced', 'session_start', ('    if session_id is not None:\n        return session_id\n', '    if False:\n        return session_id\n'), scenario_replaced),
    ('the key is not remembered', 'session_start', ('return index.remember_session(key, bot, made) if key else made', 'return made'), scenario_reuse),
    ('the duplicate is not looked at', 'session_start', ('if client_message_id else None\n    if known is not None:', 'if False else None\n    if known is not None:'), scenario_duplicate),
    ('a look writes', 'runs', ("rows = self._exec('SELECT session_id FROM chat_dedupe WHERE client_message_id=? AND ts>=?'",
                               "self._exec(\"INSERT OR IGNORE INTO chat_dedupe VALUES ('x', 'b', 's', '2999-01-01T00:00:00Z')\"); rows = self._exec('SELECT session_id FROM chat_dedupe WHERE client_message_id=? AND ts>=?'"),
     scenario_look_writes),
    ('the 409 names a session that is not this Bot\'s', 'session_start', ("{'details': {'session_id': known}} if safe_id(known) and owns(known) else None", "{'details': {'session_id': known}}"),
     scenario_owned),
    ('the 409 names a malformed id', 'session_start', ("{'details': {'session_id': known}} if safe_id(known) and owns(known) else None", "{'details': {'session_id': known}} if owns(known) else None"),
     scenario_malformed),
]


@pytest.mark.parametrize('label, which, edit, scenario', MUTANTS, ids=[m[0] for m in MUTANTS])
def test_mutation_is_caught(label, which, edit, scenario, tmp_path):
    ss, runs = load(edit, which)
    with pytest.raises(AssertionError):
        scenario(ss, runs, tmp_path)


def test_wiring_mutations_are_caught():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    run, new = function(api, 'create_run'), function(api, 'chat_stream_new')
    for old, new_text, where in (
            ("fields['idempotency_key'], fields['session_id'], gates", "None, fields['session_id'], gates", run),
            ("gates, lambda: _new_session(name), owns)", "gates, lambda: _new_session(name), lambda s: True)", new),
            ("payload={**fields, 'session_created': True} if new_session else fields", 'payload=fields', run),
            ("{'session_id': session_id} if new_session", '{}', run),
            ("payload={'via': 'chat'}", "payload={}", new),
            ("            budget_gate(budget, meta.path, name)\n\n        def owns", "            pass\n\n        def owns", new),
            ("    fields = validate_chat_body(", "    fields = dict(", new)):
        assert old in where, old
        with pytest.raises(AssertionError):
            check_wiring(api.replace(where, where.replace(old, new_text, 1)))
