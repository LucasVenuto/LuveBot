"""Contract v0.6 Part D: how long a Bot waits for a person (backend/bot_controls.py, backend/bots.py create_in_hermes).
- The write is Hermes's own `update_config`, ALWAYS with the Bot's profile (without it Hermes writes the default profile's config):
  only that Bot's `approvals.timeout` changes; `approvals.mode` and every other key, and the default profile, stay equal.
- JSON integers from the fixed list only: 3600.0, true, "3600", 7, 31536001 and -1 are 422.
- Audited before Hermes is called (audit down: nothing written); re-read with Hermes's reader: a clamp or a lost write is 502.
- "All Bots": one write per Bot; a failure is reported for that Bot and undoes nothing (A-95).
- A Bot made by the assistant waits 1 h (a step of create_in_hermes); a failure at that step rolls the profile back.
Hermes is a stand-in here that keeps the semantics we rely on (config_env.py update_config: `body.profile or profile`, deep merge;
approval_context.py `_get_approval_timeout`: default 300, clamped); the harness runs the real one (test_approval_timeout_real).
Every check also runs against bot_controls.py / bots.py with one defect each: each must go red.
"""
import asyncio
import contextlib
import contextvars
import copy
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


def load(edit=None, module='bot_controls'):
    name = f'timeout_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if edit:
        source = (BACKEND / f'{module}.py').read_text()
        assert source.count(edit[0]) == 1, edit[0]
        mutated = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{module}', loader=None))
        mutated.__package__ = name
        sys.modules[mutated.__name__] = mutated
        exec(compile(source.replace(*edit), str(BACKEND / f'{module}.py'), 'exec'), mutated.__dict__)
    return importlib.import_module(f'{name}.bot_controls'), importlib.import_module(f'{name}.bots')


def merge(base, incoming):
    for key, value in incoming.items():
        base[key] = merge(base.get(key, {}), value) if isinstance(value, dict) and isinstance(base.get(key), dict) else value
    return base


@pytest.fixture
def hermes(monkeypatch):
    state = {'configs': {'default': {'approvals': {'mode': 'manual', 'timeout': 300}, 'model': {'default': 'm0'}},
                         'vendas': {'approvals': {'mode': 'smart'}, 'model': {'default': 'm1'}, 'platform_hints': {'x': 1}},
                         'outro': {}},
             'clamp': None, 'lost': False, 'broken': set(), 'events': [], 'deleted': []}

    @contextlib.contextmanager
    def scope(bot):
        token = PROFILE.set(bot)
        try:
            yield
        finally:
            PROFILE.reset(token)

    def raw():
        return copy.deepcopy(state['configs'].get(PROFILE.get(), {}))

    def timeout():
        value = int((raw().get('approvals') or {}).get('timeout', 300))
        return min(value, state['clamp']) if state['clamp'] else value

    class Model:
        def __init__(self, **fields):
            self.__dict__.update(fields)

    class ConfigUpdate(Model):
        def __init__(self, config, profile=None):
            super().__init__(config=config, profile=profile)

    async def update_config(body, profile=None, preserve_language=False):
        target = body.profile or profile or 'default'
        state['events'].append(('update_config', target))
        if target in state['broken']:
            raise RuntimeError('disk full /secret/path')
        if not state['lost']:
            merge(state['configs'].setdefault(target, {}), copy.deepcopy(body.config))
        return {'ok': True}

    async def create_profile(body):
        state['configs'][body.name] = {}

    async def nothing(*_a, **_kw):
        return None

    async def delete_profile(name):
        state['deleted'].append(name)
        state['configs'].pop(name, None)

    modules = {
        'hermes_cli': {}, 'hermes_cli.web_routers': {}, 'tools': {}, 'agent': {},
        'agent.secret_scope': {'current_secret_scope': lambda: None, 'get_secret': lambda *a: None},   # imported by hermes_client
        'hermes_cli.profiles': {'list_profile_names': lambda: list(state['configs'])},
        'hermes_cli.web_server_profiles': {'_config_profile_scope': scope},
        'hermes_cli.config': {'read_raw_config': raw, 'load_config': raw},
        'tools.approval_context': {'_get_approval_timeout': timeout},
        'hermes_cli.web_models': {'ConfigUpdate': ConfigUpdate, 'EnvVarUpdate': Model, 'ProfileCreate': Model,
                                  'ProfileDescriptionUpdate': Model, 'ProfileModelUpdate': Model, 'ProfileSoulUpdate': Model},
        'hermes_cli.web_routers.config_env': {'update_config': update_config, 'set_env_var': nothing},
        'hermes_cli.web_routers.profiles': {'create_profile_endpoint': create_profile, 'update_profile_soul': nothing,
                                            'update_profile_description_endpoint': nothing,
                                            'update_profile_model_endpoint': nothing, 'delete_profile_endpoint': delete_profile},
    }
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    sys.modules['hermes_cli.web_routers'].config_env = sys.modules['hermes_cli.web_routers.config_env']
    sys.modules['hermes_cli.web_routers'].profiles = sys.modules['hermes_cli.web_routers.profiles']
    return state


class Audit:
    def __init__(self, state, unavailable):
        self.state, self.unavailable, self.down = state, unavailable, False

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        if self.down:
            raise self.unavailable()
        self.state['events'].append(('intent', action, target, payload))
        return fn()


def code_of(fn, *args):
    """The result, or the error's code: a defect shows as a failed assertion, never as an unexpected exception."""
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)


def checks(controls, bots, hermes):
    configs, events = hermes['configs'], hermes['events']
    for seconds in controls.APPROVAL_TIMEOUTS:
        assert code_of(controls.validate_approval_timeout, {'seconds': seconds}) == seconds
    for bad in (3600.0, True, '3600', 7, 31536001, -1, None):
        assert code_of(controls.validate_approval_timeout, {'seconds': bad}) == 'invalid_field', bad
    for bad in ({}, {'seconds': 3600, 'x': 1}, [3600], None):
        assert code_of(controls.validate_approval_timeout, bad) == 'bad_request', bad

    audit = Audit(hermes, sys.modules[controls.__package__ + '.audit'].AuditUnavailable)
    before = copy.deepcopy(configs)
    assert code_of(controls.set_approval_timeout, audit, 'ana', 'vendas', 3600, 'req_1') == {'seconds': 3600, 'effective': 3600}
    expected = copy.deepcopy(before['vendas'])
    expected['approvals']['timeout'] = 3600
    assert configs['vendas'] == expected                                   # only approvals.timeout changed; approvals.mode kept
    assert configs['default'] == before['default'] and configs['outro'] == before['outro']
    assert events == [('intent', 'approval.timeout.set', 'vendas', {'from': 300, 'to': 3600}), ('update_config', 'vendas')]
    assert controls.approval_timeout('vendas') == {'seconds': 3600, 'source': 'profile', 'run_budget_seconds': None}
    assert controls.approval_timeout('outro') == {'seconds': 300, 'source': 'hermes_default', 'run_budget_seconds': None}
    for value, shown in ((5400, 5400), (90.0, 90), (True, None), (0, None), ('5400', None)):   # F8 (A-94)
        configs['outro']['agent'] = {'run_budget_seconds': value}
        assert controls.approval_timeout('outro')['run_budget_seconds'] == shown, value
    configs['outro'].pop('agent')

    hermes['clamp'] = 1800                                                 # Hermes keeps less than asked: never a claimed success
    assert code_of(controls.set_approval_timeout, audit, 'ana', 'vendas', 14400, 'req_2') == 'hermes_error'
    hermes['clamp'], hermes['lost'] = None, True                           # the write did not land
    assert code_of(controls.set_approval_timeout, audit, 'ana', 'vendas', 900, 'req_3') == 'hermes_error'
    hermes['lost'] = False

    audit.down, snapshot = True, copy.deepcopy(configs)                    # audit down: Hermes is never called
    assert code_of(controls.set_approval_timeout, audit, 'ana', 'outro', 900, 'req_4') == 'AuditUnavailable'
    assert configs == snapshot
    assert controls.set_approval_timeout_all(audit, 'ana', ['outro'], 900, 'req_5') == {'results': [{'bot': 'outro', 'error': 'audit_unavailable'}]}
    audit.down = False

    hermes['broken'] = {'vendas'}                                          # all Bots: one failure undoes nothing, no Hermes text
    result = controls.set_approval_timeout_all(audit, 'ana', ['default', 'vendas', 'outro'], 1800, 'req_6')
    assert result == {'results': [{'bot': 'default', 'seconds': 1800}, {'bot': 'vendas', 'error': 'hermes_error'},
                                  {'bot': 'outro', 'seconds': 1800}]}
    assert configs['default']['approvals'] == {'mode': 'manual', 'timeout': 1800} and configs['vendas']['approvals']['timeout'] == 14400  # the clamped write above stays on disk
    hermes['broken'] = set()

    meta = types.SimpleNamespace(path='db', upsert=lambda *a: None, set_template=lambda *a: None, delete=lambda *a: None)
    bots.hook = types.SimpleNamespace(install_hook=lambda *a: None, verify_installed=lambda *a: None, forget=lambda *a: None,
                                      HookError=type('HookError', (Exception,), {}))
    bots._markdown_hint = lambda name: None
    default_before = copy.deepcopy(configs['default'])
    assert code_of(bots.create_in_hermes, 'novo', None, {}, None, meta) is True     # a NEW Bot waits 1 h, in its own profile only
    assert configs['novo'] == {'approvals': {'timeout': 3600}} and configs['default'] == default_before
    hermes['broken'] = {'falho'}                                           # that step fails: the new profile is rolled back
    assert code_of(bots.create_in_hermes, 'falho', None, {}, None, meta) == 'hermes_error'
    assert 'falho' in hermes['deleted'] and 'falho' not in configs
    hermes['broken'] = set()


def test_approval_timeout_only_that_key(hermes):
    checks(*load(), hermes)


@pytest.mark.parametrize('edit,module', [
    (("ConfigUpdate(config={'approvals': {'timeout': seconds}}, profile=bot), profile=bot)",
      "ConfigUpdate(config={'approvals': {'timeout': seconds}}))"), 'bot_controls'),
    (("    if type(seconds) is not int or seconds not in APPROVAL_TIMEOUTS:", "    if seconds not in APPROVAL_TIMEOUTS:"), 'bot_controls'),
    (("    if effective != seconds:\n", "    if False:\n"), 'bot_controls'),
    (("    audit.act(actor, 'approval.timeout.set'",
      "    asyncio.run(approval_timeout_update(bot, seconds))\n    audit.act(actor, 'approval.timeout.set'"), 'bot_controls'),
    (("        except AuditUnavailable:\n            results.append({'bot': bot, 'error': 'audit_unavailable'})\n", ""), 'bot_controls'),
    (("    steps.append(('approval_timeout', lambda: approval_timeout_update(name, NEW_BOT_APPROVAL_TIMEOUT)))\n", ""), 'bots'),
    (("            'run_budget_seconds': int(budget) if type(budget) in (int, float) and budget > 0 else None}",
      "            'run_budget_seconds': None}"), 'bot_controls'),
], ids=['profile_dropped', 'float_and_bool_accepted', 'answer_from_the_body', 'hermes_before_the_audit', 'audit_down_hidden',
        'new_bot_without_1h', 'f8_run_budget_hidden'])
def test_each_mutation_is_caught(hermes, edit, module):
    with pytest.raises(AssertionError):
        checks(*load(edit, module), hermes)
