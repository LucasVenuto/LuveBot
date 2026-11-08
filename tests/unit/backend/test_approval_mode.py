"""`/bots` carries `approval_mode` per Bot (luvebot | channel | free), read from the approval surface in the same pass as the rest of the Bot, so the screen
needs no extra read per Bot for the "Livre" chip. Additive (contract v0.9). When it cannot be read the field is ABSENT, never a guess. backend/bots.py
`bot_object` runs for real; the plugin's reader is checked on its own source; mutations: a default for the missing value, a guess when unreadable.
`approval_applied` (applied | pending | hook_outdated | hook_not_live; absent when it cannot be worked out) says whether the live hook runs that configured mode
yet, from the hook view the same pass already builds: the chip reads "Livre, esperando o hook" instead of promising a Bot that still asks."""
import ast
import importlib
import importlib.util
import itertools
import sys
import types
import urllib.request
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
ROOT = BACKEND.parent
_n = itertools.count()
INFO = {'name': 'vendas', 'is_default': False, 'description': '', 'provider': 'p', 'model': 'm'}


class HermesError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def load(edit=None):
    name = f'am_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    client = types.ModuleType(f'{name}.hermes_client')
    client.HermesError, client.MAX_RESPONSE_BYTES, client.PROFILE_NAME = HermesError, 1024 * 1024, __import__('re').compile(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}')
    client._NoRedirect = type('_NoRedirect', (urllib.request.HTTPRedirectHandler,), {})
    client.HermesClient = type('HermesClient', (), {'__init__': lambda self, profile: None})
    client.feature_states = lambda caps, ok: {}
    sys.modules[client.__name__] = client
    if not edit:
        return importlib.import_module(f'{name}.bots'), importlib.import_module(f'{name}.hook_store')
    source = (BACKEND / 'bots.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.bots', loader=None))
    mod.__package__ = name
    sys.modules[mod.__name__] = mod
    exec(compile(source.replace(*edit), str(BACKEND / 'bots.py'), 'exec'), mod.__dict__)
    return mod, importlib.import_module(f'{name}.hook_store')


def bot(bots, **live):
    return bots.bot_object(INFO, {}, ({}, False), live)


def inv_applied_is_a_known_reason_or_absent(bots, hook_store):
    for reason in ('applied', 'pending', 'hook_outdated', 'hook_not_live'):
        assert bot(bots, approval_mode='free', approval_applied=reason)['approval_applied'] == reason
    for unreadable in (None, '', 'live', 'APPLIED', 7, ['applied']):
        assert 'approval_applied' not in bot(bots, approval_mode='free', approval_applied=unreadable), unreadable
    assert 'approval_applied' not in bot(bots, approval_applied='applied')                      # never without the mode it is about
    assert 'approval_applied' not in bot(bots, approval_mode='bogus', approval_applied='applied')
    assert 'approval_applied' not in bot(bots)


def inv_the_field_is_the_mode_or_absent(bots, hook_store):
    for mode in ('luvebot', 'channel', 'free'):
        assert bot(bots, approval_mode=mode)['approval_mode'] == mode
    for unreadable in (None, '', 'FREE', 'auto', 7, ['free']):
        assert 'approval_mode' not in bot(bots, approval_mode=unreadable), unreadable
    assert 'approval_mode' not in bot(bots)                                         # a live read that did not carry it: absent, not "luvebot"
    assert 'approval_mode' not in bots.bot_object(INFO, {}, ({}, False))
    assert tuple(bots.APPROVAL_MODES) == tuple(hook_store.SURFACE_MODES)           # the two lists cannot drift


def reader():
    """`_approval_surface` of the plugin, run on its own with a stand-in for the stored row."""
    tree = ast.parse((ROOT / 'dashboard' / 'plugin_api.py').read_text())
    source = next(ast.get_source_segment((ROOT / 'dashboard' / 'plugin_api.py').read_text(), n) for n in tree.body
                  if isinstance(n, ast.FunctionDef) and n.name == '_approval_surface')
    return source


def check_reader(source):
    modes = ('luvebot', 'channel', 'free')

    def run(read):
        space = {'hook_store': types.SimpleNamespace(read_surface=read, SURFACE_MODES=modes)}
        exec(source, space)
        return space['_approval_surface']('db', 'vendas')
    for mode in modes:
        assert run(lambda path, name, m=mode: {'mode': m, 'digest': 'd1', 'approvers': []}) == {'mode': mode, 'digest': 'd1'}
    assert run(lambda path, name: (_ for _ in ()).throw(OSError('locked'))) is None           # unreadable: no answer
    assert run(lambda path, name: {'mode': 'weird', 'digest': None}) is None and run(lambda path, name: {}) is None


def check_wiring(source):
    live = source.split('async def _live(', 1)[1].split('\nasync def ', 1)[0].split('\ndef ', 1)[0]
    assert 'run_in_threadpool(_approval_surface, path, name)' in live and 'run_in_threadpool(_hook_view, path, name, True)' in live   # the same gather
    assert "'approval_mode': approval_mode" in live and "'approval_applied': approval_applied" in live
    assert 'approval_surface.applied_from_view(surface' in live and 'except Exception:' in live                  # no second read; a failure is absence
    assert "hook_view.pop('surface_digest', None)" in live and "hook_view.pop('read_failed', False)" in live     # the two private keys never reach `hook`


MUTATIONS_APPLIED = [
    ('any text accepted as the reason', "live.get('approval_applied') in APPROVAL_APPLIED", "live.get('approval_applied')"),
    ('applied without the mode it is about', "if live.get('approval_mode') in APPROVAL_MODES and live.get('approval_applied') in APPROVAL_APPLIED else {})",
     "if live.get('approval_applied') in APPROVAL_APPLIED else {})"),
]

MUTATIONS = [
    ('a default for the missing value', "**({'approval_mode': live['approval_mode']} if live.get('approval_mode') in APPROVAL_MODES else {})",
     "'approval_mode': live.get('approval_mode') or 'luvebot'"),
    ('any text accepted', "if live.get('approval_mode') in APPROVAL_MODES else {})", "if live.get('approval_mode') else {})"),
]


def test_the_field_on_the_real_module():
    inv_the_field_is_the_mode_or_absent(*load())
    inv_applied_is_a_known_reason_or_absent(*load())


def test_the_two_lists_equal_the_sources():
    bots, hook_store = load()
    approval_surface = importlib.import_module(bots.__package__ + '.approval_surface')
    assert set(bots.APPROVAL_APPLIED) == {'applied', 'pending', 'hook_outdated', 'hook_not_live'}
    src = (BACKEND / 'approval_surface.py').read_text()
    assert all(f'return "{reason}"' in src for reason in bots.APPROVAL_APPLIED)                  # nothing the engine can answer is missing from the list


@pytest.mark.parametrize('label,old,new', MUTATIONS_APPLIED, ids=[m[0] for m in MUTATIONS_APPLIED])
def test_each_applied_mutation_turns_it_red(label, old, new):
    with pytest.raises(AssertionError):
        inv_applied_is_a_known_reason_or_absent(*load((old, new)))


@pytest.mark.parametrize('label,old,new', MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_each_mutation_turns_it_red(label, old, new):
    with pytest.raises(AssertionError):
        inv_the_field_is_the_mode_or_absent(*load((old, new)))


def test_the_plugin_reader_answers_the_mode_or_nothing():
    check_reader(reader())
    source = reader()
    for old, new in (("    except Exception:  # noqa: BLE001\n        return None\n", "    except Exception:  # noqa: BLE001\n        return {'mode': 'luvebot', 'digest': None}\n"),
                     ("return {'mode': mode, 'digest': digest} if mode in hook_store.SURFACE_MODES else None", "return {'mode': mode, 'digest': digest}")):
        assert old in source, old
        with pytest.raises(AssertionError):
            check_reader(source.replace(old, new))


def test_the_hook_state_gives_the_surface_digest_only_when_asked():
    source = (BACKEND / 'hook.py').read_text()
    assert 'def hook_state(path, profile, *, now=None, with_surface=False):' in source
    assert "    if with_surface:" in source and "view['surface_digest'] = beat.get('surface_digest') if beat else None" in source
    assert "'table_digest': beat['table_digest'] if beat else None}\n    if with_surface:" in source        # the key set of the hook route's answer is unchanged
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    assert "hook.hook_state(path, name, with_surface=private)" in api and "'hook': await run_in_threadpool(_hook_view, meta.path, name)" in api


def test_the_reader_runs_in_the_same_pass_as_the_rest_of_the_bot():
    source = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    check_wiring(source)
    with pytest.raises(AssertionError):
        check_wiring(source.replace('run_in_threadpool(_approval_surface, path, name))', 'run_in_threadpool(_hook_view, path, name))'))
    with pytest.raises(AssertionError):                                                                      # a second read instead of the hook view of the pass
        check_wiring(source.replace('approval_surface.applied_from_view(surface', 'approval_surface.applied_reason(surface'))
    with pytest.raises(AssertionError):                                                                      # the private keys would reach `hook`
        check_wiring(source.replace("hook_view.pop('surface_digest', None)", "hook_view.get('surface_digest', None)"))
