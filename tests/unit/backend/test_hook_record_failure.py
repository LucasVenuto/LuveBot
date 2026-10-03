"""A failed write of the hook's row must never turn a BLOCK into an approval (invariant 8; found by
corrupting luvebot.db under the hook during review). Before the fix, record_event ran inside the hook's
fail-closed `try`: when it raised (luvebot.db locked past 5 s, a full disk, a corrupt page), the hook answered
_rules_unavailable, which off a channel is APPROVE: chpasswd or make_payment, locked by a built-in block rule, became a
human approval.

Real hermes-plugin hook and real built-in table, in process (no Hermes, no harness). Mutation (test_the_mutation_is_caught): the
row written outside the guard again -> the block becomes approve: red.
"""
import importlib.util
from pathlib import Path
import re
import sqlite3
import sys

import pytest

REPO = Path(__file__).resolve().parents[3]
IDS = dict(task_id='t', session_id='s', tool_call_id='c')


def _load(name, path, **kw):
    spec = importlib.util.spec_from_file_location(name, path, **kw)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def hook(tmp_path):
    """The plugin as a gateway loads it, on a fresh luvebot.db with the built-in table, on a LuveBot surface (no channel)."""
    if 'luvebot_backend' not in sys.modules:  # the plugin imports the backend under this name, as in the gateway
        _load('luvebot_backend', REPO / 'backend' / '__init__.py', submodule_search_locations=[str(REPO / 'backend')])
    import luvebot_backend.hook as backend_hook
    import luvebot_backend.hook_store as store
    plugin = _load('luvebot_hook_under_test', REPO / 'hermes-plugin' / '__init__.py')
    db = tmp_path / 'luvebot' / 'luvebot.db'
    plugin._db = lambda: db
    plugin._channel = lambda: None
    plugin._approvals_bypassed = lambda: None   # a normal session (no /yolo, approvals on): without Hermes it would fail closed
    store.put_table(db, 'p', backend_hook.compile_expected())
    return plugin, store, plugin._make_hook('p')


def locked(*_args, **_kwargs):
    raise sqlite3.OperationalError('database is locked')


def verdicts(call):
    return {'chpasswd': call('terminal', {'command': 'chpasswd --help'}, **IDS),
            'make_payment': call('make_payment', {}, **IDS),
            'chmod': call('terminal', {'command': 'chmod 600 /tmp/x'}, **IDS)}


def test_a_failed_write_never_changes_the_verdict(hook, monkeypatch):
    _plugin, store, call = hook
    normal = verdicts(call)
    kanban = action(call('kanban_create', {'title': 'x', 'assignee': 'vendas'}, **IDS))
    assert normal['chpasswd']['action'] == 'block' and normal['make_payment']['action'] == 'block'   # built-in LOCK rules
    assert normal['chmod']['action'] == 'approve' and re.fullmatch(r'luvebot:[\w.]+#\d+\.[0-9a-f]{32}', normal['chmod']['rule_key'])
    monkeypatch.setattr(store, 'record_event', locked)                    # the row cannot be written
    failed = verdicts(call)
    assert failed['chpasswd']['action'] == 'block' and failed['make_payment']['action'] == 'block'
    assert failed['chpasswd']['message'] == normal['chpasswd']['message']
    # an ask stays an ask, under a key unique to the call and naming no row (LuveBot then shows it as details_unavailable)
    assert failed['chmod']['action'] == 'approve' and failed['chmod']['message'] == normal['chmod']['message']
    key = failed['chmod']['rule_key']
    assert re.fullmatch(r'luvebot:[\w.]+#[0-9a-f]{32}', key) and key != call('terminal', {'command': 'chmod 600 /tmp/x'}, **IDS)['rule_key']
    # the handoff row written before the verdict fails the same way: kanban_create gets the verdict it had
    assert action(call('kanban_create', {'title': 'x', 'assignee': 'vendas'}, **IDS)) == kanban


def action(answer):
    return None if answer is None else answer['action']


def test_the_mutation_is_caught(hook, monkeypatch):
    plugin, store, call = hook
    monkeypatch.setattr(plugin, '_record', lambda store_, *row: store_.record_event(plugin._db(), *row))  # no guard: the old code
    monkeypatch.setattr(store, 'record_event', locked)
    assert verdicts(call)['chpasswd']['action'] == 'approve', 'the mutation (unguarded write) survived'
