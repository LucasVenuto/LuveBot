"""A request waits for a human as long as HERMES does for that Bot: the profile's `approvals.timeout`, read with Hermes's own
`_get_approval_timeout` under the profile's config scope, plus a small slack so LuveBot never says "expired" before Hermes denies.
The fixed 300 s marked a request expired too early on a Bot set to wait longer. Unreadable: Hermes's default, 300 (+ slack).
Hermes's two modules are stubbed here (the real reader and clamp are Hermes's; the harness reads a real profile).
Mutations: the fixed TTL back; the profile scope dropped (the default profile's value is read); the slack dropped.
"""
import contextlib
import contextvars
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
PROFILE = contextvars.ContextVar('profile', default='default')
TIMEOUTS = {'default': 300, 'longo': 900}


def load(edit=None):
    name = f'ttl_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.approvals')
    source = (BACKEND / 'approvals.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.approvals', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'approvals.py'), 'exec'), module.__dict__)
    return module


@pytest.fixture
def hermes(monkeypatch):
    """Hermes's profile scope and its approval-timeout reader, as far as `ttl` uses them."""
    state = {'broken': False}

    @contextlib.contextmanager
    def scope(bot):
        token = PROFILE.set(bot)
        try:
            yield
        finally:
            PROFILE.reset(token)

    def timeout():
        if state['broken']:
            raise OSError('config unreadable')
        return TIMEOUTS.get(PROFILE.get(), 300)                     # a profile with no value: Hermes's default
    profiles = types.ModuleType('hermes_cli.web_server_profiles')
    profiles._config_profile_scope = scope
    context = types.ModuleType('tools.approval_context')
    context._get_approval_timeout = timeout
    for name, module in (('hermes_cli', types.ModuleType('hermes_cli')), ('hermes_cli.web_server_profiles', profiles),
                         ('tools', types.ModuleType('tools')), ('tools.approval_context', context)):
        monkeypatch.setitem(sys.modules, name, module)
    return state


def expires_in(approvals, tmp_path, bot):
    db = tmp_path / f'ttl{next(_n)}.db'
    row = approvals.record_request(db, bot, 'run_1', 'run', {'request_id': f'req_{next(_n)}', 'command': 'ls', 'description': 'd',
                                                            'pattern_keys': ['k'], 'choices': ['once', 'deny']}, now=1000.0)
    return row['expires_at'] - row['created_at']


def checks(approvals, tmp_path, hermes):
    slack = approvals.TTL_SLACK
    assert 0 < slack <= 60                                                           # a small slack, never a second timeout
    assert expires_in(approvals, tmp_path, 'longo') == 900 + slack                   # the Bot waits 900 s: so does LuveBot
    assert expires_in(approvals, tmp_path, 'vendas') == 300 + slack                  # no value in that profile: Hermes's 300
    hermes['broken'] = True
    assert expires_in(approvals, tmp_path, 'longo') == 300 + slack                   # unreadable: the reserve, never shorter
    hermes['broken'] = False


def test_a_request_waits_as_long_as_hermes_does_for_that_bot(tmp_path, hermes):
    checks(load(), tmp_path, hermes)


def test_without_hermes_the_reserve_holds(tmp_path, monkeypatch):
    for name in ('tools.approval_context', 'hermes_cli.web_server_profiles'):
        monkeypatch.setitem(sys.modules, name, None)                                 # import fails: Hermes absent
    approvals = load()
    assert expires_in(approvals, tmp_path, 'longo') == approvals.TTL + approvals.TTL_SLACK


@pytest.mark.parametrize('edit', [
    ("now, now + ttl(bot), 'pending'", "now, now + TTL, 'pending'"),
    ("        with _config_profile_scope(bot):\n            seconds = float(_get_approval_timeout())", "        seconds = float(_get_approval_timeout())"),
    ("        return max(seconds, 0.0) + TTL_SLACK", "        return max(seconds, 0.0)"),
], ids=['fixed_ttl', 'profile_scope_dropped', 'no_slack'])
def test_each_mutation_is_caught(tmp_path, hermes, edit):
    approvals = load(edit)
    with pytest.raises(AssertionError):
        checks(approvals, tmp_path, hermes)
