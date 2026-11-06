"""Contract v0.8 section 8 (backend/inactivity.py + bot_controls cron pause helpers): fixed clock, a stand-in cron with Hermes's
pause/resume semantics. 8 days away with `days: 7` -> the running routines are paused with `luvebot:inactivity`; an already-paused
or completed one is untouched; a visit does NOT resume; the resume touches only what this paused; ON/shorter is tightening and
OFF/longer is loosening. Every check also runs with one defect each: each must go red.
"""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
DAY = 86400.0
T0 = 1_800_000_000.0


def load(edit=None):
    name = f'inact_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if edit:
        target, old, new = edit
        source = (BACKEND / f'{target}.py').read_text()
        assert source.count(old) == 1, old
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{target}', loader=None))
        module.__package__ = name
        sys.modules[module.__name__] = module
        exec(compile(source.replace(old, new), str(BACKEND / f'{target}.py'), 'exec'), module.__dict__)
    return importlib.import_module(f'{name}.inactivity')


class Cron:
    def __init__(self):
        self.jobs = {'vendas': [{'id': 'j1', 'enabled': True, 'state': 'scheduled'},
                                {'id': 'j2', 'enabled': True, 'state': 'paused', 'paused_reason': 'luvebot:user'},
                                {'id': 'j3', 'enabled': True, 'state': 'completed'}],
                     'default': [{'id': 'j4', 'enabled': True, 'state': 'scheduled'}]}

    def list_jobs(self, bot):
        return [dict(j) for j in self.jobs.get(bot, [])]

    def _job(self, bot, job_id):
        return next(j for j in self.jobs[bot] if j['id'] == job_id)

    def pause(self, bot, job_id, reason):
        self._job(bot, job_id).update(state='paused', paused_reason=reason)

    def resume(self, bot, job_id):
        job = self._job(bot, job_id)
        job.update(state='scheduled')
        job.pop('paused_reason', None)

    def states(self):
        return {j['id']: (j['state'], j.get('paused_reason')) for jobs in self.jobs.values() for j in jobs}


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append((actor, action))
        return fn()


def code_of(fn, *args):
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)


@pytest.fixture(autouse=True)
def hermes_imports(monkeypatch):
    """What bot_controls's imports reach at load (hermes_client); nothing here is called."""
    modules = {'agent': {}, 'agent.secret_scope': {'current_secret_scope': lambda: None, 'get_secret': lambda *a: None},
               'hermes_cli': {}, 'hermes_cli.profiles': {'list_profile_names': lambda: []},
               'hermes_cli.web_server_profiles': {'_config_profile_scope': None}}
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)


def checks(ina, tmp_path):
    for bad in (3.0, True, 5, '7', -1):
        assert code_of(ina.validate, {'days': bad}) == 'invalid_field', bad
    assert code_of(ina.validate, {}) == 'bad_request' and ina.validate({'days': None}) is None and ina.validate({'days': 7}) == 7
    assert [ina.loosens(a, b) for a, b in ((None, 7), (7, 3), (7, None), (7, 14), (None, None))] == [False, False, True, True, False]

    db, cron, audit, bots = tmp_path / f'i{next(_n)}.db', Cron(), Audit(), ['vendas', 'default']
    assert ina.check(db, audit, bots, cron, now=T0 + 400 * DAY) == 0                      # off (the default): never pauses
    ina.set_days(audit, 'ana', db, 7, now=T0)
    ina.touch(db, 'ana', now=T0 + DAY, clock=lambda: 0.0)
    assert ina.check(db, audit, bots, cron, now=T0 + 7.5 * DAY) == 0                      # 6.5 days away: nothing yet
    assert ina.check(db, audit, bots, cron, now=T0 + 9 * DAY) == 2                        # 8 days away: j1 and j4
    assert cron.states() == {'j1': ('paused', 'luvebot:inactivity'), 'j2': ('paused', 'luvebot:user'),
                             'j3': ('completed', None), 'j4': ('paused', 'luvebot:inactivity')}
    assert ('system', 'routines.inactivity_pause') in audit.rows
    assert ina.status(db)['paused']['count'] == 2 and ina.status(db)['days'] == 7
    ina.touch(db, 'ana', now=T0 + 9.5 * DAY, clock=lambda: 1000.0)                        # the person comes back...
    assert ina.check(db, audit, bots, cron, now=T0 + 9.6 * DAY) == 0                      # ...and nothing resumes by itself
    assert cron.states()['j1'] == ('paused', 'luvebot:inactivity') and ina.status(db)['paused'] is not None
    assert ina.resume(audit, 'ana', db, bots, cron) == {'resumed': 2, 'held': 0}           # "Retomar": only what this paused
    assert cron.states() == {'j1': ('scheduled', None), 'j2': ('paused', 'luvebot:user'), 'j3': ('completed', None),
                             'j4': ('scheduled', None)}
    assert ina.status(db)['paused'] is None and ('ana', 'routines.inactivity_resume') in audit.rows


def test_inactivity_pause(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ('inactivity', "    if now - max(seen or 0, set_at) <= days * 86400:\n        return 0",
     "    if now - max(seen or 0, set_at) <= days * 86400:\n        return sum(len(bot_controls._cron_jobs_resume(path, b, cron, REASON)) for b in bots)"),
    ('bot_controls', "        if job['id'] in ours and job.get('state') == 'paused' and job.get('paused_reason') == reason:",
     "        if job.get('state') == 'paused':"),
    ('bot_controls', "        if job.get('enabled') is not False and job.get('state') not in ('paused', 'completed'):\n            _sql(path, f'INSERT",
     "        if job.get('enabled') is not False and job.get('state') != 'completed':\n            _sql(path, f'INSERT"),
    ('inactivity', "    if now - max(seen or 0, set_at) <= days * 86400:", "    if now - max(seen or 0, set_at) <= 0:"),
    ('inactivity', "    return before is not None and (after is None or after > before)", "    return after is None"),
], ids=['auto_resume_on_a_visit', 'resume_every_paused_job', 'already_paused_taken_over', 'no_waiting', 'longer_is_tightening'])
def test_each_mutation_is_caught(tmp_path, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), tmp_path)
