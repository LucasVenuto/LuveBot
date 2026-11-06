"""Contract v0.6 Part A (backend/skills.py): skills per Bot, the matrix, the global on/off, SKILL.md as text.
Hermes is a stand-in that keeps the semantics we rely on (f8489405): get_skills lists the WHOLE catalog with `enabled` from the
GLOBAL list only; get_disabled_skills(config, platform) = global + platform_disabled.<platform> minus the essential skills;
toggle_skill writes the global list of `body.profile or profile` (the default profile without one) and drops essential names;
get_skill_content raises a 404 HTTPException for a missing skill. The harness runs the real ones.
Every check also runs against skills.py with one defect each: each must go red.
"""
import asyncio
import contextlib
import contextvars
import copy
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
PROFILE = contextvars.ContextVar('profile', default='default')
KEY = 'sk-' + 'a1b2c3d4e5f6' * 3
ESSENTIAL = {'hermes-agent'}


def redact(text):
    return text.replace(KEY, 'sk-***')


def load(edit=None):
    name = f'skills_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.skills')
    source = (BACKEND / 'skills.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.skills', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'skills.py'), 'exec'), module.__dict__)
    return module


class HTTPException(Exception):
    def __init__(self, status_code, detail):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


@pytest.fixture
def hermes(monkeypatch):
    catalog = {'pesquisa': {'description': 'Busca na web ' + KEY, 'category': 'research'},
               'resumo': {'description': 'x' * 900, 'category': None},
               'hermes-agent': {'description': 'essencial', 'category': 'core'},
               'x y': {'description': 'nome fora da regra', 'category': None},
               KEY: {'description': 'nome que parece chave', 'category': None}}
    state = {'configs': {'default': {'skills': {'disabled': []}},
                         'vendas': {'model': 'm', 'skills': {'disabled': ['resumo'], 'platform_disabled': {'telegram': ['pesquisa']}}},
                         'quebrado': None},
             'only_in': {'pesquisa': {'default', 'vendas'}, 'resumo': {'vendas'}, 'hermes-agent': {'default', 'vendas'},
                         'x y': {'vendas'}, KEY: {'vendas'}},
             'noop': False, 'events': []}

    @contextlib.contextmanager
    def scope(bot):
        token = PROFILE.set(bot)
        try:
            yield
        finally:
            PROFILE.reset(token)

    def load_config():
        config = state['configs'][PROFILE.get()]
        if config is None:
            raise OSError('unreadable /root/.hermes/profiles/quebrado/config.yaml')
        return copy.deepcopy(config)

    def names(values):
        return {values} if isinstance(values, str) else set(values or [])

    def get_disabled_skills(config, platform=None):
        section = config.get('skills') or {}
        disabled = names(section.get('disabled'))
        if platform is not None:
            disabled |= names((section.get('platform_disabled') or {}).get(platform))
        return disabled - ESSENTIAL

    async def get_skills(profile=None):
        with scope(profile or 'default'):
            disabled = get_disabled_skills(load_config())
            bot = PROFILE.get()
        return [{'name': n, **catalog[n], 'enabled': n not in disabled, 'usage': 3, 'provenance': 'bundled'}
                for n in catalog if bot in state['only_in'][n]]

    async def toggle_skill(body, profile=None):
        target = body.profile or profile or 'default'
        state['events'].append(('toggle_skill', target, body.name, body.enabled))
        if state['noop']:
            return {'ok': True}
        section = state['configs'][target].setdefault('skills', {})
        disabled = names(section.get('disabled'))
        disabled = disabled - {body.name} if body.enabled else disabled | {body.name}
        section['disabled'] = sorted(disabled - ESSENTIAL)
        return {'ok': True, 'name': body.name, 'enabled': body.enabled}

    async def get_skill_content(name, profile=None):
        if profile not in state['only_in'].get(name, ()):
            raise HTTPException(404, f"Skill '{name}' not found.")
        body = '# ' + name + '\nuse a chave ' + KEY + '\n' + ('y' * 300 * 1024 if name == 'resumo' else '')
        return {'name': name, 'content': body, 'path': f'/root/.hermes/profiles/{profile}/skills/{name}/SKILL.md'}

    class SkillToggle:
        def __init__(self, name, enabled, profile=None):
            self.name, self.enabled, self.profile = name, enabled, profile

    modules = {
        'agent': {}, 'agent.skill_utils': {'ESSENTIAL_SKILLS': ESSENTIAL}, 'hermes_cli': {}, 'hermes_cli.web_routers': {},
        'hermes_cli.config': {'load_config': load_config},
        'hermes_cli.skills_config': {'get_disabled_skills': get_disabled_skills},
        'hermes_cli.web_models': {'SkillToggle': SkillToggle},
        'hermes_cli.web_routers.skills': {'get_skills': get_skills, 'toggle_skill': toggle_skill, 'get_skill_content': get_skill_content},
        'hermes_cli.web_server_profiles': {'_profile_scope': scope},
    }
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    return state


class Audit:
    def __init__(self, state, unavailable):
        self.state, self.unavailable, self.down = state, unavailable, False

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        if self.down:
            raise self.unavailable()
        self.state['events'].append(('intent', action, target))
        try:
            result = fn()
        except Exception:
            self.state['events'].append(('result', 'error'))
            raise
        self.state['events'].append(('result', 'ok'))
        return result


def code_of(fn, *args):
    """The result, or the error's code: a defect shows as a failed assertion, never as an unexpected exception."""
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)


def checks(skills, hermes):
    configs, events = hermes['configs'], hermes['events']
    assert skills.feature() == 'ok'
    listed = code_of(skills.bot_skills, 'vendas', redact)
    assert isinstance(listed, dict), listed
    assert listed['platforms'] == ['api_server', 'telegram'] and listed['notes']['fail_open'] is True
    by = {s['name']: s for s in listed['skills']}
    assert by['pesquisa']['enabled'] == {'all': True, 'api_server': True, 'telegram': False} and by['pesquisa']['state'] == 'partial'
    assert by['resumo']['state'] == 'off' and len(by['resumo']['description']) == skills.DESCRIPTION_MAX
    assert by['hermes-agent']['essential'] is True and by['hermes-agent']['toggle'] is False and by['hermes-agent']['state'] == 'on'
    assert by['x y']['toggle'] is False and by['pesquisa']['toggle'] is True
    assert by['sk-***']['toggle'] is False                                      # a name that looks like a key: shown redacted, read-only
    assert KEY not in json.dumps(listed)
    assert code_of(skills.bot_skills, 'default', redact)['platforms'] == ['api_server']

    for body in ({'enabled': 1}, {}, {'enabled': True, 'x': 1}, [True], {'enabled': 'true'}):
        assert code_of(skills.validate_toggle, body) == 'bad_request', body
    audit = Audit(hermes, importlib.import_module(skills.__package__ + '.audit').AuditUnavailable)
    default_before = copy.deepcopy(configs['default'])
    answer = code_of(skills.toggle, audit, 'ana', 'vendas', 'resumo', True, 'req_1', redact)
    assert isinstance(answer, dict), answer
    assert answer['skill']['state'] == 'on' and answer['notice'] == 'on_applies_to_new_conversations' and answer['still_off_on'] == []
    assert events == [('intent', 'skill.enable', 'vendas:resumo'), ('toggle_skill', 'vendas', 'resumo', True), ('result', 'ok')]
    assert 'resumo' not in configs['vendas']['skills']['disabled'] and configs['default'] == default_before
    events.clear()
    answer = code_of(skills.toggle, audit, 'ana', 'vendas', 'pesquisa', True, 'req_2', redact)
    assert isinstance(answer, dict), answer
    assert answer['still_off_on'] == ['telegram'] and answer['skill']['state'] == 'partial'    # Hermes's truth, not a failure
    answer = code_of(skills.toggle, audit, 'ana', 'vendas', 'pesquisa', False, 'req_3', redact)
    assert isinstance(answer, dict), answer
    assert answer['skill']['state'] == 'off' and answer['notice'] is None and answer['still_off_on'] == []
    events.clear()
    snapshot = copy.deepcopy(configs)
    for skill, enabled, code in (('hermes-agent', False, 'skill_essential'), ('nao-existe', True, 'skill_not_found'),
                                 ('../x', False, 'skill_not_found'), ('resumo', True, 'skill_not_found')):
        bot = 'default' if skill == 'resumo' else 'vendas'                      # resumo does not exist in default
        assert code_of(skills.toggle, audit, 'ana', bot, skill, enabled, 'req_4', redact) == code, skill
    assert events == [] and configs == snapshot                                 # refused before the audit and before Hermes

    hermes['noop'] = True                                                       # Hermes accepts but does not write: 502, audited as error
    assert code_of(skills.toggle, audit, 'ana', 'vendas', 'pesquisa', True, 'req_5', redact) == 'hermes_error'
    assert events[-1] == ('result', 'error')
    hermes['noop'] = False
    events.clear()
    audit.down = True                                                           # audit down: Hermes is never called
    assert code_of(skills.toggle, audit, 'ana', 'vendas', 'pesquisa', True, 'req_6', redact) == 'AuditUnavailable'
    assert events == [] and configs == snapshot
    audit.down = False

    grid = code_of(skills.matrix, ['default', 'vendas', 'quebrado'], redact)
    assert isinstance(grid, dict), grid
    assert grid['bots'] == [{'bot': 'default'}, {'bot': 'vendas'}, {'bot': 'quebrado', 'error': 'unreadable'}]
    cells = {(c['bot'], c['skill']): c['state'] for c in grid['cells']}
    assert cells[('default', 'resumo')] == 'absent' and cells[('vendas', 'pesquisa')] == 'off' and cells[('default', 'pesquisa')] == 'on'
    assert not any(c['bot'] == 'quebrado' for c in grid['cells']) and KEY not in json.dumps(grid)
    assert grid['truncated'] == {'bots': False, 'skills': False}               # F6: nothing was cut here
    many = code_of(skills.matrix, ['default'] * (skills.MATRIX_BOTS + 1), redact)
    assert many['truncated']['bots'] is True and len(many['bots']) == skills.MATRIX_BOTS    # the 51st Bot is dropped AND the answer says so

    text = code_of(skills.content, 'vendas', 'pesquisa', redact)
    assert isinstance(text, dict) and isinstance(big := code_of(skills.content, 'vendas', 'resumo', redact), dict), text
    assert text['redacted'] is True and KEY not in text['content'] and 'path' not in text and text['truncated'] is False
    assert big['truncated'] is True and len(big['content'].encode()) <= skills.CONTENT_MAX
    assert code_of(skills.content, 'default', 'resumo', redact) == 'skill_not_found'
    assert code_of(skills.content, 'vendas', '../../etc', redact) == 'skill_not_found'


def platform_checks(skills, hermes):
    """F7: platform names come from config KEYS: only `[a-z0-9_-]{1,32}`, at most 20, and anything else is `other` (a token never leaves)."""
    token = 'ghp_' + 'Ab3' * 12
    many = {f'p{n:02d}': [] for n in range(25)}
    hermes['configs']['vendas']['skills']['platform_disabled'] = {'telegram': ['pesquisa'], token: ['resumo'], 'Maiusculas': [], **many}
    listed = code_of(skills.bot_skills, 'vendas', redact)
    assert isinstance(listed, dict), listed
    assert 'ghp_' not in json.dumps(listed) and 'Maiusculas' not in json.dumps(listed)          # not a name: never shown
    assert listed['platforms'][0] == 'api_server' and listed['platforms'][-1] == 'other' and len(listed['platforms']) == 1 + skills.PLATFORMS_MAX + 1
    assert all(skills.PLATFORM.fullmatch(p) for p in listed['platforms'][1:-1])
    resumo = next(s for s in listed['skills'] if s['name'] == 'resumo')
    assert resumo['enabled']['other'] is False                                                    # a skill one of the odd keys turns off is never shown `on` there
    assert set(resumo['enabled']) == set(listed['platforms']) | {'all'}


def test_platform_names_are_bounded_and_shaped(hermes):
    platform_checks(load(), hermes)


@pytest.mark.parametrize('old,new', [
    ("PLATFORM = re.compile(r'[a-z0-9_-]{1,32}')", "PLATFORM = re.compile(r'.*')"),
    ("PLATFORMS_MAX = 20", "PLATFORMS_MAX = 2000"),
    ("(['other'] if odd and 'other' not in named else [])", "[]"),
    ("set().union(*(get_disabled_skills(config, k) for k in odd if isinstance(k, str)))", "set()"),
], ids=['any_shape', 'no_cap', 'no_other', 'odd_keys_not_counted'])
def test_each_platform_mutation_is_caught(hermes, old, new):
    with pytest.raises(Exception):   # noqa: B017
        platform_checks(load((old, new)), hermes)


def test_skills_state_is_real_and_toggled_through_hermes(hermes):
    checks(load(), hermes)


def test_without_hermes_skills_is_unavailable(hermes, monkeypatch):
    monkeypatch.setitem(sys.modules, 'hermes_cli.web_routers.skills', None)
    skills = load()
    assert skills.feature() == 'unavailable'
    assert code_of(skills.bot_skills, 'vendas', redact) == 'capability_missing'


@pytest.mark.parametrize('edit', [
    ("redact(str(entry.get('description') or ''))[:DESCRIPTION_MAX]", "str(entry.get('description') or '')[:DESCRIPTION_MAX]"),
    ("**{p: name not in off[p] for p in platforms}", "**{p: bool(skill.get('enabled')) for p in platforms}"),
    ("        if after['enabled']['all'] is not enabled:\n            raise _hermes_error()\n", ""),
    ("    platforms, after = audit.act(", "    effect()\n    platforms, after = audit.act("),
    ("    if entry['essential'] and not enabled:", "    if False:"),
    ("SkillToggle(name=skill, enabled=enabled, profile=bot), profile=bot)", "SkillToggle(name=skill, enabled=enabled))"),
    ("    shown = redact(text)", "    shown = text"),
    ("            rows.append({'bot': bot, 'error': 'unreadable'})\n", ""),
], ids=['description_unredacted', 'hermes_enabled_for_every_platform', 'answer_from_the_body', 'hermes_before_the_audit',
        'essential_turned_off', 'profile_dropped', 'content_unredacted', 'unreadable_bot_hidden'])
def test_each_mutation_is_caught(hermes, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), hermes)
