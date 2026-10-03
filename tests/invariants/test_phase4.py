"""T4.5: costs and caps, the budget executor, the cost watcher, routines and activity (contract v0.2) and red team 7.

Part 1 runs the REAL backend modules in-process against a scratch SQLite and a fake cron, and the same files with ONE deliberate
defect each (a mutation must turn its invariant red). Part 2 is the REAL harness: real Hermes cron jobs and sessions, the
dashboard's own watcher thread; only the model is fake and spend is written the way Hermes writes it (SessionDB).
"""
import importlib
import itertools
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import time
from datetime import datetime, timezone

import pytest

from support import STATE, plugin
from test_bots import DB, audit_rows, csrf, error_of, post
from test_plugin import PREFIX, no_secret
from test_runs import get

BACKEND = Path(plugin().__file__).parents[1] / 'backend'
NEEDED = ['__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'budget.py', 'cost_watcher.py', 'executor.py', 'costs.py', 'routines.py', 'activity.py']
_counter = itertools.count()


# ---------------------------------------------------------------------------------------------------------------------
# Part 1: the modules themselves, with mutations
# ---------------------------------------------------------------------------------------------------------------------
class Pkg:
    """The copied backend package: modules by attribute."""

    def __init__(self, name):
        self.name = name

    def __getattr__(self, module):
        return importlib.import_module(f'{self.name}.{module}')


def load(tmp_path, edit=None):
    pkg = tmp_path / f'ppkg{next(_counter)}'
    pkg.mkdir()
    for name in NEEDED:
        shutil.copy(BACKEND / name, pkg / name)
    if edit:
        hits = [f for f in pkg.glob('*.py') if f.read_text().count(edit[0]) == 1]
        assert len(hits) == 1, edit[0]
        hits[0].write_text(hits[0].read_text().replace(*edit))
    sys.path.insert(0, str(pkg.parent))
    try:
        for name in NEEDED:
            if name != '__init__.py':
                importlib.import_module(f'{pkg.name}.{name[:-3]}')
        return Pkg(pkg.name)
    finally:
        sys.path.remove(str(pkg.parent))


class Clock:
    now = datetime(2026, 1, 31, 12, tzinfo=timezone.utc)

    def __call__(self):
        return self.now


class FakeCron:
    """Stands in for Hermes cron: jobs with state and paused_reason, exactly the fields the executor reads."""

    def __init__(self, jobs):
        self.jobs = {j['id']: dict(j) for j in jobs}
        self.calls = []

    def list_jobs(self, bot):
        return [dict(j) for j in self.jobs.values()]

    def pause(self, bot, job_id, reason):
        self.calls.append(('pause', job_id, reason))
        self.jobs[job_id].update(state='paused', enabled=False, paused_reason=reason)

    def resume(self, bot, job_id):
        self.calls.append(('resume', job_id))
        self.jobs[job_id].update(state='scheduled', enabled=True, paused_reason=None)


class FakeRuns:
    """The executor's runs: which are open, and a stop that is True only when Hermes would confirm the end."""

    def __init__(self, open_runs=('r1',), confirm=True):
        self.open_runs, self.confirm, self.calls = list(open_runs), confirm, []

    def open(self, bot):
        return list(self.open_runs)

    def stop(self, bot, run_id):
        self.calls.append((bot, run_id))
        if isinstance(self.confirm, BaseException):
            raise self.confirm
        return self.confirm


def job(job_id, state='scheduled', reason=None):
    return {'id': job_id, 'state': state, 'enabled': state == 'scheduled', 'paused_reason': reason}


def session(session_id, usd, **kw):
    return {'id': session_id, 'actual_usd': usd, 'estimated_usd': None, 'started_at': 1.0, 'model': 'm', **kw}


def rig(m, tmp, jobs):
    db = tmp / 'p.db'
    audit = m.audit.AuditLog(db)
    budget = m.budget.Budget(db, audit=audit, clock=Clock(), stop_percent=90)
    cron = FakeCron(jobs)
    runs = FakeRuns()
    executor = m.executor.Executor(db, budget, audit, cron, runs)
    return db, budget, cron, executor, runs


def inv_rt7_a_breach_pauses_for_real(m, tmp):
    db, budget, cron, executor, runs = rig(m, tmp, [job('j1'), job('j2', 'paused', 'luvebot:user'), job('j3'), job('j4', 'paused', 'luvebot:budget')])
    budget.set_limit('bot', 'vendas', 'day', 1000, actor='basic:harness-human')
    rows = {'vendas': [session('s1', 9.5)]}
    first = m.cost_watcher.run_pass(budget, ['vendas'], lambda bot: rows[bot])
    assert first['heartbeat'] and first['recorded_cents'] == 950
    for decision in first['decisions']:
        executor.handle(decision)
    # the Bot's cron jobs are paused, with our reason; the one a person paused keeps its own
    assert {j: cron.jobs[j]['state'] for j in cron.jobs} == {'j1': 'paused', 'j2': 'paused', 'j3': 'paused', 'j4': 'paused'}
    assert cron.jobs['j1']['paused_reason'] == cron.jobs['j3']['paused_reason'] == 'luvebot:budget' and cron.jobs['j2']['paused_reason'] == 'luvebot:user'
    assert runs.calls == [('vendas', 'r1')]                                                   # the active runs were stopped
    # new work is refused, and the alerts were recorded once
    assert budget.check_new_run('vendas')['reason'] == 'bot_paused'
    conn = sqlite3.connect(db)
    alerts = [r[0] for r in conn.execute("SELECT target FROM audit_log WHERE action='budget.alert' AND detail='result'")]
    steps = conn.execute("SELECT count(*) FROM audit_log WHERE action='budget.executor.step' AND detail='result'").fetchone()[0]
    conn.close()
    assert len(alerts) == 2 and steps >= 3                                                    # 50% and 80% crossed; two pauses + the stop (+ the estop note)
    # a replayed pass counts nothing and alerts nothing new
    again = m.cost_watcher.run_pass(budget, ['vendas'], lambda bot: rows[bot])
    assert again['recorded_cents'] == 0 and not again['decisions']
    # someone resumes a job in the Hermes dashboard: the next pass (the periodic evaluation) pauses it again
    cron.resume('vendas', 'j1')
    executor.handle(budget.evaluate('vendas'))
    assert cron.jobs['j1']['state'] == 'paused' and cron.jobs['j1']['paused_reason'] == 'luvebot:budget'
    # only a human lifts the pause, and only when the cause is gone; the executor does not resume on its own
    with pytest.raises(ValueError):
        budget.resume('vendas', actor='bot:vendas', origin='agent', human=False)
    assert executor.resume('vendas') == {'resumed': [], 'kept': []} and cron.jobs['j1']['state'] == 'paused'
    assert budget.resume('vendas', actor='basic:harness-human', human=True)['breaches']       # still over the stop line: stays paused
    assert executor.resume('vendas')['resumed'] == [] and cron.jobs['j1']['state'] == 'paused'
    budget.set_limit('bot', 'vendas', 'day', 5000, actor='basic:harness-human')
    cron.resume('vendas', 'j1')                                                                # the cause is gone, the pause is not:
    executor.handle(budget.evaluate('vendas'))                                                 # still paused until a person resumes
    assert cron.jobs['j1']['state'] == 'paused' and cron.jobs['j1']['paused_reason'] == 'luvebot:budget'
    assert not budget.resume('vendas', actor='basic:harness-human', human=True)['breaches']
    cron.resume('vendas', 'j3')
    cron.pause('vendas', 'j3', 'luvebot:user')                                                # a person took this one over after we paused it
    done = executor.resume('vendas')
    assert sorted(done['resumed']) == ['j1', 'j4'] and done['kept'] == ['j3']                 # only what the budget paused, still under its reason
    assert cron.jobs['j2']['state'] == 'paused' and cron.jobs['j3']['state'] == 'paused' and cron.jobs['j4']['state'] == 'scheduled'


def inv_watcher_counts_each_cent_once_and_fails_closed(m, tmp):
    db, budget, cron, executor, runs = rig(m, tmp, [])
    cents = m.cost_watcher.cents_of
    assert cents(0.001, None) == 1 and cents(1.001, None) == 101 and cents(None, 0.5) == 50 and cents(0.5, 9.9) == 50   # ceil; actual wins
    assert cents(None, None) is None and cents(0, None) == 0
    rows = {'vendas': [session('cron_ab12_20260101_000000', 1.0), session('s2', None), session('s3', 0.5)]}
    first = m.cost_watcher.run_pass(budget, ['vendas'], lambda bot: rows[bot])
    assert first['recorded_cents'] == 150 and first['unpriced'] == 1 and first['heartbeat']
    rows['vendas'][0]['actual_usd'] = 1.4                                                      # the session grew: only the difference counts
    grown = m.cost_watcher.run_pass(budget, ['vendas'], lambda bot: rows[bot])
    assert grown['recorded_cents'] == 40
    rows['vendas'][0]['actual_usd'] = 0.2                                                      # a cost that goes down is never refunded
    assert m.cost_watcher.run_pass(budget, ['vendas'], lambda bot: rows[bot])['recorded_cents'] == 0
    conn = sqlite3.connect(db)
    assert conn.execute('SELECT sum(cents) FROM budget_spend').fetchone()[0] == 190
    assert conn.execute("SELECT routine FROM budget_spend WHERE cents=100").fetchone()[0] == 'ab12'   # the routine comes from the session id
    conn.close()
    # a Bot that cannot be read withholds the heartbeat: after watcher_max_age the Budget refuses new work
    budget.set_limit('bot', 'vendas', 'day', 100000, actor='basic:harness-human')
    Clock.now = datetime(2026, 1, 31, 13, tzinfo=timezone.utc)
    try:
        def boom(bot):
            raise OSError('state.db unreadable')
        failed = m.cost_watcher.run_pass(budget, ['vendas'], boom)
        assert failed['errors'] == ['vendas'] and not failed['heartbeat']
        assert budget.check_new_run('vendas')['reason'] == 'watcher_stale'
    finally:
        Clock.now = datetime(2026, 1, 31, 12, tzinfo=timezone.utc)


def inv_routines_are_reduced_and_never_take_a_client_dict(m, tmp):
    r = m.routines
    raw = {'id': 'abc123', 'name': 'Daily', 'prompt': 'secret instruction', 'schedule': {'kind': 'cron', 'expr': '0 8 * * *'},
           'hermes_home': '/root/.hermes/profiles/x', 'base_url': 'http://x', 'script': 'run.sh', 'workdir': '/w', 'state': 'paused',
           'enabled': False, 'paused_reason': 'luvebot:budget', 'last_error': 'boom'}
    shown = r.view('vendas', raw, cap={'period': 'day', 'cents': 100}, spend_cents=5)
    assert shown['paused_reason'] == 'budget' and shown['has_script'] is True and shown['state'] == 'paused'
    blob = json.dumps(shown)
    assert not any(k in blob for k in ('hermes_home', '/root/.hermes', 'base_url', 'run.sh', '/w"', 'secret instruction'))
    assert r.paused_reason({**raw, 'paused_reason': 'luvebot:user'}) == 'user' and r.paused_reason({**raw, 'state': 'scheduled'}) is None
    for body in ({'name': 'x', 'hermes_home': '/tmp'}, {'prompt': 'x', 'id': 'other'}, {'name': 'x', 'script': 'rm -rf /'}, {'workdir': '/'},
                 {'enabled': True}, {'schedule': '* * * * *'}):
        with pytest.raises(m.api_errors.PluginError) as refused:
            r.validate_patch(body)
        assert refused.value.status == 422, body
    assert r.validate_patch({'name': ' New ', 'skills': ['a'], 'no_agent': False}) == {'name': 'New', 'skills': ['a'], 'no_agent': False}
    with pytest.raises(m.api_errors.PluginError):
        r.validate_patch({})
    bot, fields, start = r.validate_create({'bot': 'vendas', 'name': 'n', 'schedule': 'every 1h', 'prompt': 'p'})
    assert (bot, start, fields['schedule']) == ('vendas', False, 'every 1h')                 # created paused unless start: true
    with pytest.raises(m.api_errors.PluginError):
        r.validate_create({'bot': 'vendas', 'schedule': 'every 1h', 'prompt': 'p', 'script': 'x'})
    chunk, nxt = r.page(list(range(5)), 2, None)
    assert chunk == [0, 1] and nxt == '2' and r.page(list(range(5)), 2, nxt)[0] == [2, 3] and r.page(list(range(5)), 2, '4') == ([4], None)
    for bad in ('-1', 'x', '1.5', '99999999999'):
        with pytest.raises(m.api_errors.PluginError) as refused:
            r.page([1], 1, bad)
        assert refused.value.status == 400


def inv_costs_count_unpriced_sessions_and_activity_pages_honestly(m, tmp):
    rows = {'vendas': [session('s1', 1.0, started_at=100.0, model='a'), session('s2', None, started_at=100.0, model='b'),
                       session('old', 5.0, started_at=1.0)],
            'default': [session('s3', 0.5, started_at=100.0, model='a', input_tokens=3, output_tokens=4)]}
    totals, groups = m.costs.aggregate(rows, start=50.0, group='model')
    assert totals == {'spend_cents': 150, 'unpriced_sessions': 1}                              # unpriced is counted, not zero; old is out of the period
    assert [(g['key'], g['spend_cents'], g['sessions']) for g in groups] == [('a', 150, 2), ('b', 0, 1)] and groups[0]['tokens'] == 7
    assert m.costs.aggregate(rows, start=50.0, group='bot')[1][0]['key'] == 'vendas'
    for bad in (('week', 'bot'), ('day', 'zone')):
        with pytest.raises(m.api_errors.PluginError):
            m.costs.validate(*bad)
    a = m.activity
    items = [{'id': f'run:r{i}', 'kind': 'run', 'bot': 'vendas', 'origin': 'message', 'status': 'running', 'started_at': float(i), 'cost_cents': i,
              'title': 't', 'links': {}} for i in range(5)]
    page, nxt = a.build(items, tab='running', limit=2)
    assert [i['id'] for i in page] == ['run:r4', 'run:r3'] and nxt == '2'
    assert a.build(items, tab='running', limit=2, cursor=nxt)[0][0]['id'] == 'run:r2'
    assert a.build(items, tab='done') == ([], None) and len(a.build(items, tab='running', min_cost_cents=3)[0]) == 2
    for bad in ({'tab': 'x'}, {'tab': 'running', 'cursor': '-3'}, {'tab': 'running', 'origin': 'nope'}):
        with pytest.raises(m.api_errors.PluginError) as refused:
            a.build(items, **bad)
        assert refused.value.status == 400
    task = a.task_item({'id': 't1', 'title': 'x', 'assignee': 'vendas', 'created_by': 'default', 'status': 'running', 'started_at': 1, 'completed_at': None})
    assert task['origin'] == 'handoff' and task['status'] == 'running' and a.valid_id(task['id']) and not a.valid_id('../x')


def inv_s08_a_stop_is_audited_before_the_call_and_counts_only_when_confirmed(m, tmp):
    db, budget, cron, executor, runs = rig(m, tmp, [])
    budget.on_breach('vendas')
    runs.confirm = False                                                                         # Hermes refused, or the run did not end
    out = executor.apply('vendas')
    assert out['stopped'] == 0 and out['failed'] == ['stop_run:r1']                              # not "applied": the plan stays pending
    conn = sqlite3.connect(db)
    rows = conn.execute("SELECT detail, outcome FROM audit_log WHERE action='budget.executor.step' AND target='vendas' ORDER BY id").fetchall()
    conn.close()
    assert rows[0] == ('intent', 'ok')                                                           # the attempt was on record before the result
    # a call that raises is still an audited attempt, and still not applied
    runs.confirm = RuntimeError('transport')
    assert executor.apply('vendas')['failed'] == ['stop_run:r1'] and len(runs.calls) == 2
    # once Hermes confirms, it counts, and the next pass has nothing to retry
    runs.confirm, runs.open_runs = True, ['r1']
    done = executor.apply('vendas')
    assert done['stopped'] == 1 and done['failed'] == []
    # an unavailable audit log means no stop at all (the effect never runs without its intent)
    class Dead:
        def act(self, *a, **k):
            raise m.audit.AuditUnavailable()
    quiet = FakeRuns()
    m.executor.Executor(db, budget, Dead(), FakeCron([]), quiet).apply('vendas')
    assert quiet.calls == []


def inv_s01_a_routine_whose_own_cap_is_reached_is_not_given_back(m, tmp):
    db, budget, cron, executor, runs = rig(m, tmp, [job('rtn1'), job('rtn2')])
    budget.set_limit('routine', 'rtn1', 'day', 100, actor='basic:harness-human')
    budget.record_spend('e1', 'vendas', 95, routine='rtn1')                                       # 95 of 100: past the 90 percent stop line
    assert budget.routines_over_cap() == {'rtn1'}
    budget.on_breach('vendas')
    executor.apply('vendas')
    assert cron.jobs['rtn1']['state'] == cron.jobs['rtn2']['state'] == 'paused'
    budget.heartbeat()
    assert not budget.resume('vendas', actor='basic:harness-human', human=True)['breaches']       # the Bot's pause is lifted...
    done = executor.resume('vendas')
    assert done['resumed'] == ['rtn2'] and done['kept'] == ['rtn1'] and cron.jobs['rtn1']['state'] == 'paused'   # ...the capped routine stays
    budget.set_limit('routine', 'rtn1', 'day', 100000, actor='basic:harness-human')               # cause gone: the next resume gives it back
    assert budget.routines_over_cap() == set() and executor.resume('vendas')['resumed'] == ['rtn1']


def inv_s03_a_cap_below_what_was_spent_pauses_without_new_spend(m, tmp):
    db, budget, cron, executor, runs = rig(m, tmp, [job('j1')])
    budget.record_spend('e1', 'vendas', 500)                                                      # spent before any cap existed
    assert budget.evaluate('vendas')['plan'] is None
    budget.set_limit('bot', 'vendas', 'day', 100, actor='basic:harness-human')                    # a cap far below the spend
    decision = budget.evaluate('vendas')                                                          # no new spend arrives: still found
    assert decision['plan'] and decision['breaches'] and decision['reason'] == 'bot_paused'
    executor.handle(decision)
    assert cron.jobs['j1']['state'] == 'paused' and runs.calls == [('vendas', 'r1')]
    budget.set_limit('bot', 'default', 'day', 0, actor='basic:harness-human')                      # a zero cap blocks a Bot that never spent
    assert budget.evaluate('default')['plan']
    assert budget.evaluate('somebody-else')['plan'] is None                                       # and only the Bots a cap touches


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    # invariant 7 and the executor
    ('rt7_a_breach_pauses_for_real', 'RT7: the pause step is skipped', '                if job.get("enabled") is False or state == "paused":',
     '                if True:'),
    ('rt7_a_breach_pauses_for_real', 'RT7: a breach raises no alert', '        self.alert(decision)\n', ''),
    ('rt7_a_breach_pauses_for_real', 'RT7: a paused Bot whose cause is gone gets no plan', '"plan": self._plan(bot) if paused else None,', '"plan": None,'),
    ('rt7_a_breach_pauses_for_real', 'RT7: the active runs are not stopped', '                open_runs = list(self.runs.open(bot))', '                open_runs = []'),
    ('rt7_a_breach_pauses_for_real', 'RT7: resume lifts every paused job, not only ours',
     'if job is not None and job.get("state") == "paused" and job.get("paused_reason") == REASON:', 'if job is not None and job.get("state") == "paused":'),
    ('rt7_a_breach_pauses_for_real', 'RT7: the executor resumes jobs while the Bot is still paused',
     '        if bot in self.paused_bots():\n            return {"resumed": [], "kept": []}\n', ''),
    ('rt7_a_breach_pauses_for_real', 'RT7: a job paused by a person is paused again under our reason',
     '                    if job.get("paused_reason") == REASON:', '                    if False:'),
    # T4.7: S08, S01, S03
    ('s08_a_stop_is_audited_before_the_call_and_counts_only_when_confirmed', 'S08: the stop is called before it is audited',
     'confirmed = self._step(bot, "stop_run", {"run": run_id}, lambda r=run_id: self.runs.stop(bot, r))',
     'confirmed = self.runs.stop(bot, run_id)\n                    self._step(bot, "stop_run", {"run": run_id}, lambda: None)'),
    ('s08_a_stop_is_audited_before_the_call_and_counts_only_when_confirmed', 'S08: an unconfirmed stop counts as applied',
     '                if confirmed:\n                    out["stopped"] += 1', '                if True:\n                    out["stopped"] += 1'),
    ('s01_a_routine_whose_own_cap_is_reached_is_not_given_back', 'S01: a capped routine is resumed with its Bot', '                if job_id in capped:', '                if False:'),
    ('s01_a_routine_whose_own_cap_is_reached_is_not_given_back', 'S01: routines_over_cap sees no routine caps', "SELECT * FROM budget_limits WHERE scope='routine'", "SELECT * FROM budget_limits WHERE scope='none'"),
    ('s03_a_cap_below_what_was_spent_pauses_without_new_spend', 'S03: the periodic evaluation records no pause', '            return self._decision(conn, bot, routine, watcher=False)\n\n    def routines_over_cap',
     '            return dict(self._decision(conn, bot, routine, watcher=False), plan=None, plans=[], reason=None)\n\n    def routines_over_cap'),
    # the watcher
    ('watcher_counts_each_cent_once_and_fails_closed', 'watcher: a session is counted from zero every pass',
     '                delta = cumulative - (seen[0] if seen else 0)', '                delta = cumulative'),
    ('watcher_counts_each_cent_once_and_fails_closed', 'watcher: heartbeat even when a Bot could not be read', '    heartbeat = not errors', '    heartbeat = True'),
    ('watcher_counts_each_cent_once_and_fails_closed', 'watcher: cents are rounded down', 'return min(MAX_CENTS, int(math.ceil(usd * 100)))',
     'return min(MAX_CENTS, int(usd * 100))'),
    ('watcher_counts_each_cent_once_and_fails_closed', 'watcher: an unpriced session is counted as zero cents',
     '    return None if actual_usd is None and estimated_usd is None else 0', '    return 0'),
    # routines, costs, activity
    ('routines_are_reduced_and_never_take_a_client_dict', 'routines: a client key outside the allowlist is forwarded', '    extra = set(body) - allowed\n',
     '    extra = set()\n'),
    ('routines_are_reduced_and_never_take_a_client_dict', 'routines: the job record is returned whole', '    return {\n        "id": job.get("id"), "bot": bot,',
     '    return {**job,\n        "id": job.get("id"), "bot": bot,'),
    ('routines_are_reduced_and_never_take_a_client_dict', 'routines: a bad cursor becomes offset zero', '        if offset < 0 or not re.fullmatch(r"[0-9]{1,9}", str(cursor if cursor is not None else "0")):\n            raise ValueError',
     '        if False:\n            raise ValueError'),
    ('costs_count_unpriced_sessions_and_activity_pages_honestly', 'costs: unpriced sessions are not counted', '            if cents is None:\n                unpriced += 1\n',
     '            if cents is None:\n                pass\n'),
    ('costs_count_unpriced_sessions_and_activity_pages_honestly', 'activity: the cursor is not validated', '        if offset < 0 or (cursor is not None and not re.fullmatch(r"[0-9]{1,9}", cursor)):\n            raise ValueError',
     '        if False:\n            raise ValueError'),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_modules(tmp_path, name):
    INVARIANTS[name](load(tmp_path), tmp_path)


def test_every_invariant_has_a_mutation():
    assert {m[0] for m in MUTATIONS} == set(INVARIANTS)


RESULTS = []


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path, invariant, label, old, new):
    variant = load(tmp_path, (old, new))
    try:
        INVARIANTS[invariant](variant, tmp_path)
    except BaseException as error:  # noqa: BLE001  (red = the invariant noticed)
        RESULTS.append((invariant, label, 'RED: ' + type(error).__name__))
        return
    RESULTS.append((invariant, label, 'SURVIVED'))
    pytest.fail(f'mutation survived: {invariant} / {label}')


def test_zz_print_the_mutation_table():
    print('\n| invariant | mutation | result |\n|---|---|---|')
    for row in RESULTS:
        print('| ' + ' | '.join(row) + ' |')


# ---------------------------------------------------------------------------------------------------------------------
# Part 2: the real harness
# ---------------------------------------------------------------------------------------------------------------------
from support import DASHBOARD  # noqa: E402
from test_hook import loopback_request, run_async, wait_for  # noqa: E402

HOME = Path('/root/.hermes/profiles/vendas')
BUDGET_TABLES = ('budget_limits', 'budget_pauses', 'budget_reservations', 'budget_alerts', 'budget_spend', 'budget_cost_cursor',
                 'budget_exec_jobs', 'budget_exec_state')
MODULE_ROUTES = [('GET', '/costs'), ('GET', '/budget'), ('PUT', '/budget/limits'), ('POST', '/bots/{bot}/budget/resume'),
                 ('GET', '/routines'), ('POST', '/routines'), ('GET', '/routines/{job_id}'), ('PATCH', '/routines/{job_id}'),
                 ('DELETE', '/routines/{job_id}'), ('GET', '/routines/{job_id}/runs'), ('POST', '/routines/{job_id}/duplicate'),
                 ('POST', '/routines/{job_id}/pause'), ('POST', '/routines/{job_id}/resume'), ('POST', '/routines/{job_id}/test'),
                 ('GET', '/activity')]


def put(browser, path, body):
    return browser.request.put(DASHBOARD + PREFIX + path, data=body, headers={'X-LuveBot-CSRF': csrf(browser)})


def patch(browser, path, body):
    return browser.request.patch(DASHBOARD + PREFIX + path, data=body, headers={'X-LuveBot-CSRF': csrf(browser)})


def delete(browser, path, body):
    return browser.request.delete(DASHBOARD + PREFIX + path, data=body, headers={'X-LuveBot-CSRF': csrf(browser)})


def clean_budget():
    conn = sqlite3.connect(DB)
    for table in BUDGET_TABLES:
        try:
            conn.execute(f'DELETE FROM {table}')
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()


@pytest.fixture(autouse=True)
def clean(human_browser):
    clean_budget()
    made = []
    yield made
    for job_id in made:
        delete(human_browser, f'/routines/{job_id}', {'confirm_name': next((n for i, n in made_names.items() if i == job_id), '')})
    clean_budget()
    conn = sqlite3.connect(HOME / 'state.db')
    conn.execute("DELETE FROM sessions WHERE id LIKE 'cron_t45%'")
    for session_id in SEEDED:
        conn.execute('DELETE FROM sessions WHERE id=?', (session_id,))
    conn.commit()
    conn.close()
    SEEDED.clear()


made_names = {}
SEEDED = []


def new_routine(browser, made, name, *, start=True, bot='vendas'):
    response = post(browser, '/routines', {'bot': bot, 'name': name, 'schedule': 'every 1h', 'prompt': 'say hello', 'start': start})
    assert response.status == 201, response.text()
    routine = response.json()['routine']
    made.append(routine['id'])
    made_names[routine['id']] = name
    return routine


def seed_session(session_id, usd, *, started=None):
    from hermes_state import SessionDB
    SEEDED.append(session_id)
    db = SessionDB(HOME / 'state.db')
    try:
        db.create_session(session_id, 'cron')
        db.update_token_counts(session_id, input_tokens=10, output_tokens=5, model='fake-harness', actual_cost_usd=usd)
        db.flush_token_counts()
    finally:
        db.close()
    conn = sqlite3.connect(HOME / 'state.db')
    conn.execute('UPDATE sessions SET started_at=COALESCE(?, started_at), ended_at=COALESCE(?, started_at + 5) WHERE id=?',
                 (started, None, session_id))
    conn.commit()
    conn.close()


def routines_of(browser, **query):
    params = '&'.join(f'{k}={v}' for k, v in {'limit': 100, **query}.items())
    response = get(browser, '/routines?' + params)
    assert response.status == 200, response.text()
    return response.json()['routines']


def routine_state(browser, job_id):
    return next(r for r in routines_of(browser) if r['id'] == job_id)


def test_the_routes_are_in_the_router_so_the_401_sweep_covers_them():
    from test_plugin import routes
    found = set(routes())
    for method, path in MODULE_ROUTES:
        assert (method, PREFIX + path) in found, (method, path)


def test_rt7_a_loop_that_blows_the_cap_pauses_the_bot_for_real(human_browser, clean):
    """MAESTRO.md section 6, red team 7: a loop on purpose passes the cap; the Bot's cron stays paused, a new run is refused, the
    alert fires, and only a person resumes."""
    mine = new_routine(human_browser, clean, 't45-mine')
    theirs = new_routine(human_browser, clean, 't45-theirs')
    elsewhere = new_routine(human_browser, clean, 't45-elsewhere', bot='default')                # G7.2: another Bot's routine
    assert post(human_browser, f"/routines/{theirs['id']}/pause", {}).status == 200            # a person paused this one on purpose
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    cap = put(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 500})
    assert cap.status == 200 and cap.json()['limit']['cents'] == 500, cap.text()
    for n in range(3):                                                                         # the loop: three runs of USD 1.70 each = 510 cents
        seed_session(f"cron_{mine['id']}_20260101_00000{n}", 1.7)
    paused = wait_for(lambda: routine_state(human_browser, mine['id'])['state'] == 'paused', 60, 'the executor to pause the Bot cron job')
    assert paused
    assert routine_state(human_browser, mine['id'])['paused_reason'] == 'budget'
    assert routine_state(human_browser, theirs['id'])['paused_reason'] == 'user'              # the person's pause is not ours
    assert routine_state(human_browser, elsewhere['id'])['state'] == 'scheduled'              # G7.2: only this Bot is paused
    budget = get(human_browser, '/budget').json()
    assert [p['bot'] for p in budget['paused']] == ['vendas'] and budget['watcher']['stale'] is False and budget['alerts']
    assert budget['limits'][0]['spent_cents'] == 510                                           # counted once, however many passes ran
    no_secret(json.dumps(budget), 'budget')
    # new work is refused, on every entry that starts it
    runs = post(human_browser, '/bots/vendas/runs', {'input': 'hello'})
    assert runs.status == 409 and error_of(runs)['code'] == 'bot_paused'
    chat = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'hello'})
    assert chat.status == 409 and error_of(chat)['code'] == 'bot_paused'
    resume_job = post(human_browser, f"/routines/{mine['id']}/resume", {})
    assert resume_job.status == 409 and error_of(resume_job)['code'] == 'bot_paused'          # resuming the job must not undo the pause
    assert post(human_browser, f"/routines/{mine['id']}/test", {'confirm': True}).status == 409
    assert routine_state(human_browser, mine['id'])['state'] == 'paused'
    # the alert and the steps are on the audit log
    assert any(r[1] == 'ok' for r in audit_rows('budget.alert')) and any(r[1] == 'ok' for r in audit_rows('budget.executor.step'))
    assert routine_state(human_browser, elsewhere['id'])['state'] == 'scheduled'              # still, after more passes
    # someone resumes the job in the Hermes dashboard: the next watcher pass pauses it again
    from hermes_cli.web_server_cron import _mutate_cron_for_profile
    _mutate_cron_for_profile('vendas', 'resume_job', mine['id'])
    assert wait_for(lambda: routine_state(human_browser, mine['id'])['state'] == 'paused', 60, 'the watcher pass to pause the job again')
    # only a human resumes, and not while the cause stays
    still = post(human_browser, '/bots/vendas/budget/resume', {})
    assert still.status == 409 and error_of(still)['code'] == 'budget_exceeded'
    assert put(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 100000}).status == 200
    # the cause is gone but the pause is not: until a person resumes, a job resumed behind our back is paused again
    _mutate_cron_for_profile('vendas', 'resume_job', mine['id'])
    assert wait_for(lambda: routine_state(human_browser, mine['id'])['state'] == 'paused', 60, 'the pause to hold after the cap was raised')
    lifted = post(human_browser, '/bots/vendas/budget/resume', {})
    assert lifted.status == 200 and lifted.json()['resumed'] is True, lifted.text()
    assert routine_state(human_browser, mine['id'])['state'] == 'scheduled'                    # ours is back...
    assert routine_state(human_browser, theirs['id'])['state'] == 'paused'                     # ...the person's pause stays
    ok = post(human_browser, '/bots/vendas/runs', {'input': 'hello'})
    assert ok.status in (200, 202), ok.text()


def test_loopback_cannot_raise_a_cap_or_resume_but_may_lower_one():
    module = plugin()
    import luvebot_backend.budget as budget_module  # noqa: F401
    audit, meta = module._stores()
    from luvebot_backend.budget import Budget
    Budget(meta.path, audit=audit).set_limit('bot', 'vendas', 'day', 1000, actor='test-human')
    body = lambda cents: json.dumps({'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': cents}).encode()  # noqa: E731
    for cents in (2000, None):                                                                  # raise, remove
        with pytest.raises(module.PluginError) as refused:
            run_async(module.put_budget_limit(loopback_request(module, 'PUT', '/budget/limits', body=body(cents))))
        assert refused.value.code == 'loopback_not_human' and refused.value.status == 403
    lowered = run_async(module.put_budget_limit(loopback_request(module, 'PUT', '/budget/limits', body=body(500))))
    assert lowered.status_code == 200
    with pytest.raises(module.PluginError) as refused:
        run_async(module.resume_bot_budget('vendas', loopback_request(module, 'POST', '/bots/vendas/budget/resume', body=b'{}')))
    assert refused.value.code == 'loopback_not_human'


def test_routine_history_has_no_limit_of_20_or_100(human_browser, clean):
    routine = new_routine(human_browser, clean, 't45-history')
    base = time.time() - 100000
    for n in range(130):
        seed_session(f"cron_{routine['id']}_20260101_{n:06d}", 0.01, started=base + n)
    seen, cursor = [], None
    for _ in range(10):
        response = get(human_browser, f"/routines/{routine['id']}/runs?limit=50" + (f'&cursor={cursor}' if cursor else ''))
        assert response.status == 200, response.text()
        body = response.json()
        seen += [r['session_id'] for r in body['runs']]
        cursor = body['next_cursor']
        if cursor is None:
            break
    assert len(seen) == 130 and len(set(seen)) == 130, len(seen)                                # no gap, no repeat, past 100
    assert seen == [f"cron_{routine['id']}_20260101_{n:06d}" for n in range(129, -1, -1)]      # newest first
    assert get(human_browser, f"/routines/{routine['id']}/runs?cursor=-1").status == 400
    assert get(human_browser, f"/routines/{routine['id']}/runs?limit=500").status == 400
    assert get(human_browser, '/routines/nope-nope/runs').status == 404


def test_a_paused_routine_cannot_be_tested_and_stays_paused(human_browser, clean):
    routine = new_routine(human_browser, clean, 't45-test', start=False)                       # created paused
    assert routine['state'] == 'paused'
    assert post(human_browser, f"/routines/{routine['id']}/test", {}).status == 422             # no confirm
    refused = post(human_browser, f"/routines/{routine['id']}/test", {'confirm': True})
    assert refused.status == 409 and error_of(refused)['code'] == 'routine_paused'
    assert routine_state(human_browser, routine['id'])['state'] == 'paused'                    # Hermes trigger would have resumed it


def test_no_client_dict_reaches_the_cron_job(human_browser, clean):
    routine = new_routine(human_browser, clean, 't45-patch')
    for body in ({'name': 'x', 'hermes_home': '/tmp'}, {'script': 'rm -rf /'}, {'enabled': True}, {'schedule': '* * * * *'}, {}):
        assert patch(human_browser, f"/routines/{routine['id']}", body).status in (400, 422), body
    assert routine_state(human_browser, routine['id'])['name'] == 't45-patch'
    changed = patch(human_browser, f"/routines/{routine['id']}", {'name': 't45-patch-2'})
    assert changed.status == 200 and changed.json()['routine']['name'] == 't45-patch-2'
    made_names[routine['id']] = 't45-patch-2'
    shown = json.dumps(get(human_browser, f"/routines/{routine['id']}").json())
    assert 'hermes_home' not in shown and '/root/.hermes' not in shown
    wrong = delete(human_browser, f"/routines/{routine['id']}", {'confirm_name': 'other'})
    assert wrong.status == 422


def test_costs_and_activity_read_what_hermes_recorded(human_browser, clean):
    routine = new_routine(human_browser, clean, 't45-costs')
    seed_session(f"cron_{routine['id']}_20260101_000001", 2.0)
    from hermes_state import SessionDB
    db = SessionDB(HOME / 'state.db')
    db.create_session('cron_t45_unpriced', 'cron')
    db.close()
    by_routine = get(human_browser, '/costs?period=month&group=routine').json()
    assert by_routine['currency'] == 'USD' and by_routine['totals']['unpriced_sessions'] >= 1
    assert any(g['key'] == routine['id'] and g['spend_cents'] == 200 for g in by_routine['groups'])
    assert get(human_browser, '/costs?period=week').status == 400
    scheduled = get(human_browser, '/activity?tab=scheduled').json()
    assert any(i['kind'] == 'routine_due' and i['links']['job_id'] == routine['id'] for i in scheduled['items'])
    done = get(human_browser, '/activity?tab=done&limit=100').json()
    assert any(i['kind'] == 'routine_run' and i['cost_cents'] == 200 for i in done['items'])
    assert get(human_browser, '/activity?tab=nope').status == 400 and get(human_browser, '/activity?tab=done&cursor=x').status == 400


def test_one_failing_source_still_returns_the_others_with_partial(monkeypatch):
    module = plugin()
    monkeypatch.setattr(module.hermes_cron, 'kanban_tasks', lambda bot: (_ for _ in ()).throw(RuntimeError('kanban down')))
    request = loopback_request(module, 'GET', '/activity')
    response = run_async(module.get_activity(request, tab='scheduled', bot='vendas'))
    body = json.loads(response.body)
    assert body['partial'] == ['tasks'] and isinstance(body['items'], list)


def test_new_routes_need_a_session_and_a_csrf_token(human_browser):
    anonymous = human_browser.request  # logged in: the 401 sweep covers the anonymous case; here the CSRF gate of the mutations
    for method, path, body in (('PUT', '/budget/limits', {'scope': 'global', 'period': 'day', 'cents': 1}),
                               ('POST', '/bots/vendas/budget/resume', {}), ('POST', '/routines', {}),
                               ('POST', '/routines/abc/pause', {}), ('DELETE', '/routines/abc', {'confirm_name': 'x'})):
        response = anonymous.fetch(DASHBOARD + PREFIX + path, method=method, data=body)
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required', (method, path, response.status)
