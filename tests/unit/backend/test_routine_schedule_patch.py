"""Editing a routine sends `schedule` in the PATCH (the screen's edit form): the backend accepts it, validated as at creation (a text of up to 200
characters, never an object), and hands it to Hermes's own update_job (which parses it, refreshes `next_run_at` unless paused, and refuses what it cannot
read); a ValueError of Hermes is the person's input, a 422, never "Hermes is unavailable". Audited as every routine update (the keys). Mutations: the key
missing from the allowlist, the schedule not validated, the ValueError not translated."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import re
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
ROOT = BACKEND.parent
_n = itertools.count()


def load(module, edit=None):
    name = f'rsp_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.{module}')
    source = (BACKEND / f'{module}.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{module}', loader=None))
    mod.__package__ = name
    sys.modules[mod.__name__] = mod
    exec(compile(source.replace(*edit), str(BACKEND / f'{module}.py'), 'exec'), mod.__dict__)
    return mod


def code_of(fn, *args):
    try:
        fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__), getattr(error, 'status', None)
    return None


def inv_the_patch_takes_a_schedule(r):
    assert r.validate_patch({'schedule': '0 8 * * 1'}) == {'schedule': '0 8 * * 1'}                 # alone: not "Nothing to change"
    assert r.validate_patch({'schedule': '  every 2h  ', 'name': 'x'}) == {'schedule': 'every 2h', 'name': 'x'}
    for bad in ({}, {'schedule': ''}, {'schedule': '   '}, {'schedule': None}, {'schedule': {'kind': 'cron', 'expr': '0 8 * * 1'}},
                {'schedule': 7}, {'schedule': ['0 8 * * 1']}, {'schedule': 'x' * 201}):
        got = code_of(r.validate_patch, bad)
        assert got in (('invalid_field', 422), ('bad_request', 400)), (bad, got)
    assert code_of(r.validate_patch, {'schedule': {'a': 1}}) == ('invalid_field', 422)             # an object is refused, as at creation
    assert code_of(r.validate_patch, {'tools': ['x']}) == ('invalid_field', 422)                  # the allowlist is still an allowlist
    assert 'schedule' in r.PATCH_KEYS and r.PATCH_KEYS < r.CREATE_KEYS | {'name'}


def inv_a_hermes_value_error_is_a_422(c):
    calls = []
    fake = types.SimpleNamespace(_mutate_cron_for_profile=lambda bot, func, *a, **k: calls.append((bot, func, a, k)) or {'id': 'j1'})
    c._cron = lambda: fake
    cron = c.HermesCron()
    assert cron.update('vendas', 'j1', {'schedule': '0 9 * * 1'}) == {'id': 'j1'} and calls == [('vendas', 'update_job', ('j1', {'schedule': '0 9 * * 1'}), {})]

    def refuses(bot, func, *a, **k):
        raise ValueError('Invalid schedule "banana" at /root/.hermes/cron secret-token')
    c._cron = lambda: types.SimpleNamespace(_mutate_cron_for_profile=refuses)
    for call in (lambda: cron.update('vendas', 'j1', {'schedule': 'banana'}), lambda: cron.create('vendas', name='x', schedule='banana')):
        try:
            call()
        except Exception as error:  # noqa: BLE001
            assert (error.code, error.status) == ('invalid_field', 422), error
            assert 'banana' not in error.message and 'secret' not in error.message and '/root' not in error.message
        else:
            raise AssertionError('not refused')

    def broken(bot, func, *a, **k):
        raise OSError('store locked')
    c._cron = lambda: types.SimpleNamespace(_mutate_cron_for_profile=broken)
    try:
        cron.update('vendas', 'j1', {'name': 'y'})
    except OSError:
        pass                                                                                     # anything else is not ours to hide
    else:
        raise AssertionError('swallowed')


class PausedStore:
    """A stand-in for Hermes's cron store with the semantics of `cron/jobs.py#update_job` (v0.22.5 L2086-L2125) that matter here: `updates` are merged into the job;
    a schedule edit recalculates `next_run_at` ONLY when the job is not paused; `enabled`, `state` and `paused_reason` change only when `updates` carries them."""
    def __init__(self):
        self.job = {'id': 'j1', 'enabled': False, 'state': 'paused', 'paused_reason': 'luvebot:budget', 'next_run_at': None, 'schedule': {'expr': '0 8 * * 1'}}
        self.seen = []

    def _mutate_cron_for_profile(self, bot, func, job_id, updates):
        assert func == 'update_job'
        self.seen.append(dict(updates))
        job = {**self.job, **updates}
        if 'schedule' in updates and job.get('state') != 'paused':
            job['next_run_at'] = '2026-11-02T09:00:00'
        self.job = job
        return job


def inv_a_schedule_edit_never_resumes_a_paused_routine(r, c):
    """Invariant 7: a routine the cap paused stays PAUSED when its schedule is edited: LuveBot sends exactly `{schedule}` (never `enabled`, `state`,
    `paused_reason` or `next_run_at`), and the allowlist refuses any of those as a field of the PATCH."""
    store = PausedStore()
    c._cron = lambda: store
    updates = r.validate_patch({'schedule': '0 9 * * 2'})
    c.HermesCron().update('vendas', 'j1', updates)
    assert store.seen == [{'schedule': '0 9 * * 2'}]
    assert (store.job['state'], store.job['enabled'], store.job['paused_reason'], store.job['next_run_at']) == ('paused', False, 'luvebot:budget', None)
    for key, value in (('enabled', True), ('state', 'scheduled'), ('paused_reason', None), ('next_run_at', '2026-11-02T09:00:00'), ('paused_at', None), ('repeat', 3)):
        assert code_of(r.validate_patch, {'schedule': '0 9 * * 2', key: value}) == ('invalid_field', 422), key


MUTATIONS_PAUSED = [
    ('routines', 'enabled and state allowed in a patch', 'PATCH_KEYS = {"name", "schedule", "prompt"', 'PATCH_KEYS = {"name", "schedule", "enabled", "state", "next_run_at", "prompt"'),
]


MUTATIONS = [
    ('routines', 'schedule not allowed in a patch', 'PATCH_KEYS = {"name", "schedule", "prompt"', 'PATCH_KEYS = {"name", "prompt"', inv_the_patch_takes_a_schedule),
    ('routines', 'schedule not validated', 'out["schedule"] = _text(body["schedule"], "schedule", maximum=200, optional=False)', 'out["schedule"] = body["schedule"]',
     inv_the_patch_takes_a_schedule),
    ('routines', 'any length', 'out["schedule"] = _text(body["schedule"], "schedule", maximum=200, optional=False)',
     'out["schedule"] = _text(body["schedule"], "schedule", maximum=2000000, optional=False)', inv_the_patch_takes_a_schedule),
    ('hermes_cron', 'the ValueError is not translated', '    except ValueError:\n        raise PluginError(', '    except ZeroDivisionError:\n        raise PluginError(', inv_a_hermes_value_error_is_a_422),
    ('hermes_cron', 'every error is swallowed', '    except ValueError:\n        raise PluginError(', '    except Exception:\n        raise PluginError(', inv_a_hermes_value_error_is_a_422),
    ('hermes_cron', 'update not wrapped', 'return _hermes_value(lambda: _cron()._mutate_cron_for_profile(bot, "update_job", job_id, updates))',
     'return _cron()._mutate_cron_for_profile(bot, "update_job", job_id, updates)', inv_a_hermes_value_error_is_a_422),
]


def test_patch_on_the_real_module():
    inv_the_patch_takes_a_schedule(load('routines'))


def test_a_paused_routine_stays_paused_on_the_real_modules():
    inv_a_schedule_edit_never_resumes_a_paused_routine(load('routines'), load('hermes_cron'))


@pytest.mark.parametrize('module,label,old,new', MUTATIONS_PAUSED, ids=[m[1] for m in MUTATIONS_PAUSED])
def test_each_paused_mutation_turns_it_red(module, label, old, new):
    with pytest.raises(Exception):  # noqa: B017
        inv_a_schedule_edit_never_resumes_a_paused_routine(load(module, (old, new)), load('hermes_cron'))


def test_hermes_error_translation_on_the_real_module():
    inv_a_hermes_value_error_is_a_422(load('hermes_cron'))


@pytest.mark.parametrize('module,label,old,new,inv', MUTATIONS, ids=[m[1] for m in MUTATIONS])
def test_each_mutation_turns_it_red(module, label, old, new, inv):
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed: an assertion, or the PluginError / ValueError it should not have seen)
        inv(load(module, (old, new)))


def test_the_route_hands_the_schedule_to_the_official_update_and_audits_the_keys():
    source = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    route = re.search(r"@router\.patch\('/routines/\{job_id\}'\)\nasync def patch_routine.*?(?=\n@router)", source, re.S).group(0)
    assert 'routines.validate_patch(' in route and "_cron.update(bot, job['id'], updates)" in route and "'routine.update'" in route
    assert "payload={'keys': sorted(updates)}" in route                                             # `schedule` is among the audited keys
