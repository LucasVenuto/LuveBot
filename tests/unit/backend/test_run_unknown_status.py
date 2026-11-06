"""F4 second opinion of the Architect, part B: a run Hermes lost (`unknown`) is OPEN, and the Bot waits for a person: `waiting_approval` with
`status_reason` `run_unknown`; a pending clarify (the hook's `waiting` rows of kind clarify) is `waiting_approval` / `question`. What STOPS
runs (the budget executor, `stop_active`) never sees a run Hermes cannot stop. backend/bots.py `bot_object` and backend/runs.py `RunIndex`
run for real (stubbed Hermes client only); every invariant also runs against variants with one defect each."""
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


class HermesError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def load(module, edit=None):
    """A fresh copy of the backend package with Hermes's client stubbed; `module` ('bots' or 'runs'), optionally with one edit."""
    name = f'unk_backend_{next(_n)}'
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
        return importlib.import_module(f'{name}.{module}')
    source = (BACKEND / f'{module}.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    mod = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{module}', loader=None))
    mod.__package__ = name
    sys.modules[mod.__name__] = mod
    exec(compile(source.replace(*edit), str(BACKEND / f'{module}.py'), 'exec'), mod.__dict__)
    return mod


INFO = {'name': 'vendas', 'is_default': False, 'description': '', 'provider': 'p', 'model': 'm'}


def status_of(bots, runs=(), waiting=None, **live):
    bot = bots.bot_object(INFO, {}, ({}, live.pop('offline', False)), {'open_runs': list(runs), 'waiting': waiting, **live})
    return bot['status'], bot['status_reason'], bot['status_basis'], bot['current_task']


def run(run_id, status, started='2026-10-20T10:00:00Z'):
    return {'run_id': run_id, 'last_status': status, 'started_at': started}


def question(kind='clarify'):
    return {'id': 1, 'ts': 1.0, 'kind': kind, 'prompt': 'Posso apagar?', 'session_id': 's1', 'request_id': 'q' * 32}


# ---- invariants of bot_object -----------------------------------------------------------------------------------------------------

def inv_a_lost_run_makes_the_bot_wait_for_a_person(bots, runs):
    status, reason, basis, task = status_of(bots, [run('r1', 'running', '2026-10-20T11:00:00Z'), run('r2', 'unknown', '2026-10-20T10:00:00Z')])
    assert (status, reason, basis) == ('waiting_approval', 'run_unknown', 'run')
    assert task['id'] == 'r2' and task['since'] == '2026-10-20T10:00:00Z'        # the card is about the LOST run, not the newest one
    assert status_of(bots, [run('r2', 'unknown')])[:2] == ('waiting_approval', 'run_unknown')


def inv_what_the_bot_waits_on_names_its_reason(bots, runs):
    """Contract v0.9 1.8, the first that applies: an approval (no reason), a lost run, a question, an input."""
    assert status_of(bots, [], [question()]) == ('waiting_approval', 'question', None, None)
    assert status_of(bots, [run('r1', 'running')], [question()])[:2] == ('waiting_approval', 'question')
    assert status_of(bots, [], [question('sudo')]) == ('waiting_approval', 'input', None, None)         # a password the Bot waits on
    assert status_of(bots, [], [question('other')])[:2] == ('waiting_approval', 'input')                # a human input of a kind we do not know
    assert status_of(bots, [], [question('approval')])[:2] == ('waiting_approval', None)                # an approval outside the inbox: no reason
    for hostile in ('unknown', '', None, 7):                    # only the closed list of kinds counts (backend/waiting.py makes them)
        assert status_of(bots, [], [question(hostile)])[:2] == ('idle', None), hostile
    assert status_of(bots, [], [question(), 'junk', None, 7, {}])[:2] == ('waiting_approval', 'question')
    assert status_of(bots, [], ['junk', None, {}])[:2] == ('idle', None) and status_of(bots, [], None)[:2] == ('idle', None)


def inv_the_order_of_what_waits_and_what_overrides_it(bots, runs):
    lost, ask = run('r2', 'unknown'), run('r1', 'waiting_for_approval')
    assert status_of(bots, [ask, lost], [question()])[:2] == ('waiting_approval', None)          # a run's approval: no reason, first
    assert status_of(bots, [lost], [question('approval')])[:2] == ('waiting_approval', None)     # so is one outside the inbox
    assert status_of(bots, [lost], [question('clarify'), question('sudo')])[:2] == ('waiting_approval', 'run_unknown')
    assert status_of(bots, [], [question('sudo'), question('clarify')])[:2] == ('waiting_approval', 'question')   # a question before an input
    assert status_of(bots, [run('r1', 'running')], [question('sudo')])[:2] == ('waiting_approval', 'input')       # an input before working
    assert status_of(bots, [lost], [question()], offline=True)[0] == 'offline'
    paused = status_of(bots, [lost], [question()], pause_state={'paused': True, 'reason_kind': 'user', 'scope': 'luvebot_only'})
    assert paused[:2] == ('paused', 'user')
    assert status_of(bots, [run('r1', 'running')], [])[:2] == ('working', None)
    assert status_of(bots, [run('r1', 'queued')], [])[:2] == ('working', None)


BOTS_INVARIANTS = {n[4:]: f for n, f in sorted(globals().items()) if n.startswith('inv_')}

APPROVAL_LINE = "    elif any(r['last_status'] == 'waiting_for_approval' for r in runs) or any(w['kind'] == 'approval' for w in waits):\n        status = 'waiting_approval'"
LOST_LINE = "    elif any(r['last_status'] == 'unknown' for r in runs):"
QUESTION_LINE = "    elif any(w['kind'] == 'clarify' for w in waits):"
INPUT_LINE = "    elif waits:  # a sudo password"
BOTS_MUTATIONS = [
    ('a_lost_run_makes_the_bot_wait_for_a_person', 'an unknown run is not a wait', LOST_LINE, "    elif False:"),
    ('a_lost_run_makes_the_bot_wait_for_a_person', 'the reason is dropped', "status, reason = 'waiting_approval', 'run_unknown'", "status = 'waiting_approval'"),
    ('a_lost_run_makes_the_bot_wait_for_a_person', 'the card is the newest run', "focus = next((r for r in runs if r['last_status'] == 'unknown'), runs[0]) if reason == 'run_unknown' else runs[0]", "focus = runs[0]"),
    ('what_the_bot_waits_on_names_its_reason', 'a question is not a wait', QUESTION_LINE, "    elif False:"),
    ('what_the_bot_waits_on_names_its_reason', 'a question has no reason', "status, reason = 'waiting_approval', 'question'", "status = 'waiting_approval'"),
    ('what_the_bot_waits_on_names_its_reason', 'a sudo is a question', "status, reason = 'waiting_approval', 'input'", "status, reason = 'waiting_approval', 'question'"),
    ('what_the_bot_waits_on_names_its_reason', 'an input is not a wait', INPUT_LINE, "    elif False:  # a sudo password"),
    ('what_the_bot_waits_on_names_its_reason', 'an approval elsewhere is not a wait', "or any(w['kind'] == 'approval' for w in waits):", ":"),
    ('what_the_bot_waits_on_names_its_reason', 'a junk row counts', "if isinstance(w, dict) and w.get('kind') in ('clarify', 'sudo', 'approval', 'other')]", "if w]"),
    ('what_the_bot_waits_on_names_its_reason', 'a kind outside the list counts', "w.get('kind') in ('clarify', 'sudo', 'approval', 'other')]", "w.get('kind') is not None]"),
    ('the_order_of_what_waits_and_what_overrides_it', 'a lost run beats an approval elsewhere', "or any(w['kind'] == 'approval' for w in waits):\n        status = 'waiting_approval'  # an approval waiting: a run's, or one outside LuveBot's inbox (Telegram, CLI, Desktop); no reason\n" + LOST_LINE,
     ":\n        status = 'waiting_approval'\n" + LOST_LINE + "  # x\n        status, reason = 'waiting_approval', 'run_unknown'\n    elif any(w['kind'] == 'approval' for w in waits):\n        status = 'waiting_approval'\n    elif False:"),
    ('the_order_of_what_waits_and_what_overrides_it', 'an input beats a question', QUESTION_LINE + "  # F6-B", "    elif any(w['kind'] in ('sudo', 'other') for w in waits):\n        status, reason = 'waiting_approval', 'input'\n" + QUESTION_LINE + "  # F6-B"),
    ('the_order_of_what_waits_and_what_overrides_it', 'a question beats a lost run', LOST_LINE + "  # F4: Hermes lost this run's owner; only a person can free the conversation\n        status, reason = 'waiting_approval', 'run_unknown'\n" + QUESTION_LINE,
     "    elif any(w['kind'] == 'clarify' for w in waits):\n        status, reason = 'waiting_approval', 'question'\n" + LOST_LINE + "  # F4: Hermes lost this run's owner; only a person can free the conversation\n        status, reason = 'waiting_approval', 'run_unknown'\n    elif False:"),
    ('the_order_of_what_waits_and_what_overrides_it', 'the wait beats a pause', "    elif pause.get('paused'):", "    elif False:"),
    ('the_order_of_what_waits_and_what_overrides_it', 'a lost run counts as work', "    elif runs or ((workers or sessions) and False):", "    elif False:"),
]


def hide_other_modules():  # the two invariant tables share this file: pick the Bot-status ones by name
    return {k: v for k, v in BOTS_INVARIANTS.items()}


@pytest.fixture(scope='module')
def real_bots():
    return load('bots')


@pytest.mark.parametrize('name', sorted(BOTS_INVARIANTS))
def test_bot_status_invariant_holds_on_the_real_module(real_bots, name):
    BOTS_INVARIANTS[name](real_bots, None)


def test_every_bot_status_invariant_has_a_mutation():
    assert {inv for inv, *_ in BOTS_MUTATIONS} == set(BOTS_INVARIANTS)


@pytest.mark.parametrize('invariant,label,old,new', BOTS_MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in BOTS_MUTATIONS])
def test_each_bot_status_mutation_turns_its_invariant_red(invariant, label, old, new):
    bots = load('bots', (old, new))                 # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        BOTS_INVARIANTS[invariant](bots, None)


# ---- RunIndex: unknown is open, but never to what stops runs -------------------------------------------------------------------------

def seed(runs_mod, tmp_path):
    index = runs_mod.RunIndex(str(tmp_path / 'luvebot.db'))
    for run_id, status in (('r-run', 'running'), ('r-queued', 'queued'), ('r-unknown', 'unknown'), ('r-done', 'completed'), ('r-lost', 'lost')):
        index.add(run_id, 'vendas', 's1', 'actor', status)
    index.add('r-other', 'suporte', 's2', 'actor', 'unknown')
    return index


def check_open_runs(runs_mod, tmp_path):
    index = seed(runs_mod, tmp_path)
    assert 'unknown' in runs_mod.OPEN and 'unknown' not in runs_mod.ENDED
    shown = {r['run_id'] for r in index.open_runs('vendas')}
    assert shown == {'r-run', 'r-queued', 'r-unknown'}                       # the Bot status sees the lost run
    stoppable = {r['run_id'] for r in index.open_runs('vendas', stoppable=True)}
    assert stoppable == {'r-run', 'r-queued'}                                # the executor and stop_active do not: Hermes refuses to stop it
    assert {r['run_id'] for r in index.open_runs('suporte')} == {'r-other'} and index.open_runs('suporte', stoppable=True) == []
    index.set_status('r-unknown', 'unknown')
    assert index._exec('SELECT ended_at FROM run_index WHERE run_id=?', ('r-unknown',), fetch=True)[0]['ended_at'] is None
    index.set_status('r-unknown', 'completed')                               # once a person resolves it and the run ends, it leaves both lists
    assert {r['run_id'] for r in index.open_runs('vendas')} == {'r-run', 'r-queued'}


RUNS_MUTATIONS = [
    ('unknown is not open', "'stopping', 'unknown'}", "'stopping'}"),
    ('unknown is ended', "ENDED = {'completed', 'failed', 'cancelled', 'interrupted', 'lost'}", "ENDED = {'completed', 'failed', 'cancelled', 'interrupted', 'lost', 'unknown'}"),
    ('the executor sees the lost run', "wanted = sorted(OPEN - {'unknown'} if stoppable else OPEN)", "wanted = sorted(OPEN)"),
    ('the Bot status loses the lost run', "wanted = sorted(OPEN - {'unknown'} if stoppable else OPEN)", "wanted = sorted(OPEN - {'unknown'})"),
    ('stoppable leaves out a running run', "wanted = sorted(OPEN - {'unknown'} if stoppable else OPEN)", "wanted = sorted({'queued'} if stoppable else OPEN)"),
]


def test_open_runs_on_the_real_index(tmp_path):
    check_open_runs(load('runs'), tmp_path)


@pytest.mark.parametrize('label,old,new', RUNS_MUTATIONS, ids=[m[0] for m in RUNS_MUTATIONS])
def test_each_run_index_mutation_turns_it_red(tmp_path, label, old, new):
    runs_mod = load('runs', (old, new))
    with pytest.raises(AssertionError):
        check_open_runs(runs_mod, tmp_path)


# ---- the wiring in the dashboard (it needs Hermes to run, so it is read) -------------------------------------------------------------

def pause_plan(tmp_path, open_source):
    """The REAL Executor against a Bot with a running run and a lost one, where `open` is the production method (its source, exec'd)."""
    import re as _re
    import sqlite3
    import textwrap
    runs_mod = load('runs')
    package = sys.modules[runs_mod.__name__.rsplit('.', 1)[0]]
    audit_mod, executor_mod = importlib.import_module(package.__name__ + '.audit'), importlib.import_module(package.__name__ + '.executor')
    db = tmp_path / 'p.db'
    index = runs_mod.RunIndex(str(db))
    index.add('r-run', 'vendas', 's1', 'actor', 'running')
    index.add('r-lost', 'vendas', 's1', 'actor', 'unknown')
    namespace = {}
    exec(textwrap.dedent(open_source), namespace)

    class Runs:
        def __init__(self):
            self.index, self.stopped = index, []

        open = namespace['open']

        def stop(self, bot, run_id):
            self.stopped.append(run_id)
            return run_id != 'r-lost'                  # Hermes refuses to stop a run it lost (409 unknown_execution)

    class Cron:
        def list_jobs(self, bot):
            return []
    runs = Runs()
    executor = executor_mod.Executor(db, types.SimpleNamespace(), audit_mod.AuditLog(db), Cron(), runs)
    results = [executor.apply('vendas') for _ in range(3)]
    steps = sqlite3.connect(db).execute("SELECT COUNT(*) FROM audit_log WHERE action='budget.executor.step' AND detail='intent'").fetchone()[0]
    return results, runs.stopped, steps


def production_open():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    return api.split('class _BotRuns:', 1)[1].split('    def open(self, bot):', 1)[1].split('\n    def stop(', 1)[0].join(['def open(self, bot):', ''])


def test_the_pause_plan_closes_with_a_lost_run_and_never_audits_a_stop_it_cannot_make(tmp_path):
    results, stopped, steps = pause_plan(tmp_path, production_open())
    assert [r['failed'] for r in results] == [[], [], []] and [r['stopped'] for r in results] == [1, 1, 1]
    assert stopped == ['r-run'] * 3                          # the lost run is never asked to stop, so no refused attempt is audited each tick
    assert steps == 3 + 1                                    # one stop_run step per pass, plus the one-time estop note


def test_a_pause_plan_that_asks_a_lost_run_to_stop_never_closes(tmp_path):
    source = production_open().replace('stoppable=True', 'stoppable=False')
    assert source != production_open()
    results, stopped, steps = pause_plan(tmp_path, source)
    assert 'r-lost' in stopped and all(r['failed'] == ['stop_run:r-lost'] for r in results) and steps > 3 + 1   # the defect, seen: it fails and audits every tick


def test_a_lost_run_is_a_wait_in_the_activity_not_an_error():
    import backend.activity as activity
    lost = activity.run_item({'run_id': 'r1', 'bot': 'vendas', 'session_id': 's1', 'started_at': '2026-10-20T10:00:00Z', 'last_status': 'unknown',
                              'prompt_sha': None}, lambda iso: 1.0)
    assert lost['status'] == 'waiting_approval' and activity.tab_of(lost) == 'running'
    gone = activity.run_item({'run_id': 'r2', 'bot': 'vendas', 'session_id': 's1', 'started_at': '2026-10-20T10:00:00Z', 'last_status': 'lost',
                              'prompt_sha': None}, lambda iso: 1.0)
    assert gone['status'] == 'stopped'                        # a run Hermes no longer knows (a 404 after a restart): a calm stop, not a red error (F10)
    text = (BACKEND / 'activity.py').read_text()
    old = '"interrupted": "stopped", "unknown": "waiting_approval",'
    assert text.count(old) == 1
    variant = types.ModuleType('backend.activity_variant')
    variant.__package__ = 'backend'
    exec(compile(text.replace(old, '"interrupted": "stopped",'), 'activity_variant', 'exec'), variant.__dict__)
    assert variant.run_item({'run_id': 'r1', 'bot': 'v', 'session_id': 's', 'started_at': 'x', 'last_status': 'unknown', 'prompt_sha': None}, lambda i: 1.0)['status'] == 'error'


def test_what_stops_runs_never_sees_a_lost_run_and_the_status_does():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    executor = api.split('class _BotRuns:', 1)[1].split('\n    def stop(', 1)[0]
    assert 'open_runs(bot, stoppable=True)' in executor
    stop_active = api.split('def _stop_open_runs(', 1)[1].split('\nasync def ', 1)[0]
    assert 'index.open_runs(name, stoppable=True)' in stop_active
    checked = api.split('async def _open_runs_checked(', 1)[1].split('\nasync def ', 1)[0]
    assert 'stoppable' not in checked                                               # the status check keeps every open run
    assert api.count('stoppable=True') == 2


def test_the_waiting_rows_reach_the_bot_status_without_ever_reading_as_nobody_waits():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    live = api.split('async def _live(', 1)[1].split('\ndef _waiting_view(', 1)[0]
    assert 'run_in_threadpool(_waiting_view, path, name)' in live and "'waiting': waiting or []" in live
    assert "if waiting is None:\n        sources['status_partial'].append('waiting')" in live        # unreadable is listed, never "nobody waits"
    view = api.split('def _waiting_view(', 1)[1].split('\ndef ', 1)[0]
    assert 'return waiting.read(path, name, _REDACT)' in view          # the rules of "unreadable is None, unshipped is []" live in backend/waiting.py
