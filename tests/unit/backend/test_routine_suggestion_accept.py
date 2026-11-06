"""P2-2 (contract v0.10 section 2.1): accepting and dismissing a routine suggestion from Hermes.
* accept: LuveBot validates the stored spec with its own rules and creates the routine through its own create path, PAUSED (never Hermes's `accept_suggestion`, which creates the job active from a spec
  a model wrote); `start: true` starts it only if the gates of resuming a routine allow it, else it stays paused and `held` is the code; then the Hermes record is marked accepted with the module's own
  setter, best effort and converted at the source; two clicks (or a retry after the setter failed) make ONE job and return the SAME routine (`replayed`); an unsupported or not pending suggestion is a 409;
  every effect is audited with the digest of the spec and the NAMES of its fields, never its text;
* dismiss: a tightening, audited; 409 when it is not pending;
* the next list marks accepted (and leaves out) a record whose row says LuveBot already made its routine.
Mutations: one line of each changed -> red."""
import asyncio
import hashlib
import importlib
import json
import re
import sqlite3
import sys
import threading
import time
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402
import test_routine_suggestions as listing  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
SID = 'a1b2c3d4e5f6'
PROMPT = 'Summarize the week and mail the CEO. SECRET-PROMPT-TEXT'


class ConfigBackendUnavailable(SystemExit):
    pass


def setup(tmp_path, edits=()):
    name, _ = threads.package()
    m = threads.variant(name, 'routine_suggestions', edits)
    audit = importlib.import_module(f'{name}.audit').AuditLog(tmp_path / f'a{next(threads._n)}.db')
    return m, audit, audit.path, importlib.import_module(f'{name}.api_errors').PluginError, importlib.import_module(f'{name}.audit').AuditUnavailable


class FakeHermes:
    def __init__(self, records, resolve_raises=None, dismiss_returns=True, mismatch=False):
        self.records = {r['id']: dict(r) for r in records}
        self.resolved, self.dismissed, self.gets = [], [], []
        self.resolve_raises, self.dismiss_returns, self.mismatch = resolve_raises, dismiss_returns, mismatch

    def get_suggestion(self, bot, sid):
        self.gets.append((bot, sid))
        if self.mismatch:                                            # Hermes also takes an index or a title: it can hand back ANOTHER record
            return dict(next(iter(self.records.values())), id='ffffffffffff')
        found = self.records.get(sid)
        return dict(found) if found else None

    def resolve_accepted(self, bot, sid):
        raiser = self.resolve_raises
        if raiser is not None:
            error = raiser.pop(0) if isinstance(raiser, list) and raiser else (None if isinstance(raiser, list) else raiser)
            if error is not None:
                raise error
        self.resolved.append(sid)
        self.records[sid]['status'] = 'accepted'
        return True

    def dismiss_suggestion(self, bot, sid):
        self.dismissed.append(sid)
        if self.dismiss_returns:
            self.records[sid]['status'] = 'dismissed'
        return self.dismiss_returns


class FakeCron:
    def __init__(self, delay=0.0):
        self.jobs, self.created, self.delay, self.lock = {}, [], delay, threading.Lock()

    def create(self, bot, **fields):
        time.sleep(self.delay)
        with self.lock:
            job = {'id': f'job{len(self.created) + 1}', 'name': fields.get('name'), 'enabled': not fields['paused'], 'state': 'paused' if fields['paused'] else 'scheduled'}
            self.created.append((bot, fields))
            self.jobs[job['id']] = job
        return job

    def get(self, bot, job_id):
        return self.jobs.get(job_id)


def rows(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute('SELECT action, outcome, digest FROM audit_log ORDER BY id').fetchall(), json.dumps(conn.execute('SELECT * FROM audit_log').fetchall())
    finally:
        conn.close()


def record(**fields):
    return listing.record(id=SID, job_spec={'name': 'Weekly review', 'schedule': '0 9 * * 1', 'prompt': PROMPT}, **fields)


def accept_checks(tmp_path, edits=()):
    m, audit, path, PluginError, AuditUnavailable = setup(tmp_path, edits)

    def gate_ok(job_id):
        return {'id': job_id, 'enabled': True, 'state': 'scheduled'}

    def run(hermes, cron, *, start=False, start_job=gate_ok, sid=SID):
        return m.accept(audit, path, 'basic:ana', 'vendas', sid, start, hermes, cron, start_job)

    def refused(call, code):
        try:
            call()
        except PluginError as error:
            return error
        raise AssertionError(f'no refusal, wanted {code}')

    def fresh():                                                      # every scenario below has a database of its own: the same suggestion id is accepted in several of them
        nonlocal audit, path
        audit = type(audit)(tmp_path / f'a{next(threads._n)}.db')
        path = audit.path

    # a plain accept: ONE job, PAUSED, from the validated spec; the record is marked accepted; the row is kept; the routine is the one the person gets
    hermes, cron = FakeHermes([record()]), FakeCron()
    result = run(hermes, cron)
    assert result['replayed'] is False and result['started'] is False and result['held'] is None and result['job']['id'] == 'job1', result
    assert len(cron.created) == 1 and cron.created[0][0] == 'vendas'
    fields = cron.created[0][1]
    assert fields == {'name': 'Weekly review', 'schedule': '0 9 * * 1', 'prompt': PROMPT, 'paused': True, 'paused_reason': 'Created paused; awaiting operator approval.'}, fields
    assert hermes.resolved == [SID] and m.accepted_ids(path, 'vendas') == {SID: 'job1'} and m.accepted_ids(path, 'compras') == {}
    # audited: intent and result of the accept, the routine.create of the same create path, the digest of the SPEC and the NAMES of its fields, never the text
    audited, everything = rows(path)
    assert [(a, o) for a, o, _d in audited] == [('suggestion.accept', 'ok'), ('routine.create', 'ok'), ('routine.create', 'ok'), ('suggestion.accept', 'ok')], audited
    payload = {'keys': ['name', 'prompt', 'schedule'], 'spec': m.spec_digest(record()['job_spec'])}
    assert audited[0][2] == hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest(), audited[0]
    assert 'SECRET-PROMPT-TEXT' not in everything and 'Weekly review' not in everything, everything

    # a retry after the job exists: the SAME routine, `replayed`, the record resolved again, no second job
    again = run(hermes, cron)
    assert again['replayed'] is True and again['job']['id'] == 'job1' and len(cron.created) == 1 and again['started'] is False, again

    fresh()
    # what is created is what LuveBot's own validation makes of the spec (the same one as POST /routines), not the raw text a model wrote
    hermes, cron = FakeHermes([dict(record(), job_spec={'name': '  Weekly review  ', 'schedule': ' 0 9 * * 1 ', 'prompt': '  Summarize.  ', 'skills': [' web ']})]), FakeCron()
    run(hermes, cron)
    assert cron.created[0][1] == {'name': 'Weekly review', 'schedule': '0 9 * * 1', 'prompt': 'Summarize.', 'skills': ['web'], 'paused': True, 'paused_reason': 'Created paused; awaiting operator approval.'}, cron.created
    fresh()
    # two clicks at once make one job
    hermes, cron = FakeHermes([record()]), FakeCron(delay=0.05)
    results, barrier = [], threading.Barrier(2)

    def click():
        barrier.wait()
        results.append(run(hermes, cron))
    threads_ = [threading.Thread(target=click) for _ in range(2)]
    for thread in threads_:
        thread.start()
    for thread in threads_:
        thread.join()
    assert len(cron.created) == 1 and sorted(r['replayed'] for r in results) == [False, True] and {r['job']['id'] for r in results} == {'job1'}, (cron.created, results)

    fresh()
    # the status setter fails after the job exists: the accept still answers (the job is there), the record stays pending, and the retry returns the same routine and resolves it
    hermes, cron = FakeHermes([record()], resolve_raises=[RuntimeError('boom')]), FakeCron()
    first = run(hermes, cron)
    assert first['job']['id'] == 'job1' and first['replayed'] is False and hermes.records[SID]['status'] == 'pending' and hermes.resolved == [], first
    second = run(hermes, cron)
    assert second['replayed'] is True and second['job']['id'] == 'job1' and len(cron.created) == 1 and hermes.resolved == [SID], second
    fresh()
    # and a config outage in the setter (a SystemExit on purpose) is converted at the source: it does not undo an answer whose job exists
    hermes, cron = FakeHermes([record()], resolve_raises=ConfigBackendUnavailable('https://u:SECRET@cfg/x')), FakeCron()
    assert run(hermes, cron)['job']['id'] == 'job1' and len(cron.created) == 1

    fresh()
    # the retry finds the row but the person removed the routine since: nothing to return, the record is resolved, and it is not pending any more
    hermes, cron = FakeHermes([record()]), FakeCron()
    run(hermes, cron)
    cron.jobs.clear()
    hermes.records[SID]['status'] = 'pending'
    assert refused(lambda: run(hermes, cron), 'suggestion_not_pending').code == 'suggestion_not_pending' and hermes.resolved == [SID, SID] and len(cron.created) == 1

    fresh()
    # not pending: no record, another status, or Hermes handed back ANOTHER record for this id (it also takes an index or a title)
    for hermes in (FakeHermes([]), FakeHermes([record(status='accepted')]), FakeHermes([record(status='dismissed')]), FakeHermes([record()], mismatch=True)):
        cron = FakeCron()
        error = refused(lambda: run(hermes, cron), 'suggestion_not_pending')
        assert error.code == 'suggestion_not_pending' and error.status == 409 and cron.created == [], (error.code, cron.created)
    fresh()
    # an id that is not the 12-hex id never reaches Hermes
    for bad in ('1', 'Weekly review', '../x', 'A1B2C3D4E5F6', SID + '\n', ''):
        hermes, cron = FakeHermes([record()]), FakeCron()
        assert refused(lambda: run(hermes, cron, sid=bad), 'suggestion_not_pending').code == 'suggestion_not_pending' and hermes.gets == [] and cron.created == [], bad

    fresh()
    # not supported: refused with the reason, nothing created, nothing remembered
    for spec, why in (({'name': 'x', 'schedule': '0 9 * * 1', 'prompt': 'p', 'script': 'rm -rf /'}, 'unsupported_fields'), ({'name': 'x', 'schedule': '0 9 * * 1', 'prompt': 'p', 'deliver': 'telegram:1'}, 'delivery_outside'),
                      ({'name': 'x', 'schedule': '0 9 * * 1', 'prompt': 'p', 'no_agent': True}, 'no_agent'), ({'name': 'x', 'prompt': 'p'}, 'invalid_spec')):
        hermes, cron = FakeHermes([dict(record(), job_spec=spec)]), FakeCron()
        error = refused(lambda: run(hermes, cron), 'suggestion_not_supported')
        assert error.code == 'suggestion_not_supported' and error.status == 409 and error.extra == {'details': {'why_not': why}}, (why, error.code, error.extra)
        assert cron.created == [] and m.accepted_ids(path, 'vendas').get(SID) is None and hermes.resolved == []
    hermes, cron = FakeHermes([dict(record(), title='t' * 500)]), FakeCron()
    assert refused(lambda: run(hermes, cron), 'suggestion_not_supported').extra == {'details': {'why_not': 'too_large'}}

    fresh()
    # start: only if the gates of resuming a routine allow it
    hermes, cron = FakeHermes([record()]), FakeCron()
    result = run(hermes, cron, start=True)
    assert result['started'] is True and result['held'] is None and result['job'] == {'id': 'job1', 'enabled': True, 'state': 'scheduled'}, result
    assert [a for a, _o, _d in rows(path)[0] if a == 'routine.resume'] == ['routine.resume', 'routine.resume']                       # the start is audited too (intent and result)
    for error in (PluginError('bot_paused', 'paused', 409), PluginError('budget_exceeded', 'cap', 409), PluginError('watcher_stale', 'stale', 409)):
        def held(job_id, error=error):
            raise error
        fresh()
        hermes, cron = FakeHermes([record()]), FakeCron()
        result = run(hermes, cron, start=True, start_job=held)
        assert result['started'] is False and result['held'] == error.code and result['job']['state'] == 'paused' and len(cron.created) == 1, result      # a refused start leaves it paused
        assert hermes.resolved == [SID]                                                                                                          # and the suggestion is accepted all the same
    for boom in (RuntimeError('SECRET text of Hermes'), ConfigBackendUnavailable('https://u:SECRET@cfg/x'), SystemExit(3)):
        def broken(job_id, boom=boom):
            raise boom
        fresh()
        hermes, cron = FakeHermes([record()]), FakeCron()
        result = run(hermes, cron, start=True, start_job=broken)
        assert result['started'] is False and result['held'] in ('hermes_error', 'config_backend_unavailable', 'hermes_exited') and 'SECRET' not in repr(result['held']), (boom, result)
    fresh()
    hermes, cron = FakeHermes([record()]), FakeCron()
    result = run(hermes, cron, start=False, start_job=lambda job_id: pytest.fail('a start nobody asked for'))
    assert result['started'] is False and result['job']['state'] == 'paused'
    # a retry reports the routine as it is NOW (the person may have started it since)
    fresh()
    hermes, cron = FakeHermes([record()]), FakeCron()
    run(hermes, cron)
    cron.jobs['job1'].update(enabled=True, state='scheduled')
    assert run(hermes, cron)['started'] is True

    fresh()
    # an unavailable audit is not a "held": it is raised (the intent stays durable)
    hermes, cron = FakeHermes([record()]), FakeCron()

    def audit_down(job_id):
        raise AuditUnavailable()
    with pytest.raises(BaseException):  # noqa: B017
        original = audit.act

        def act(actor, action, *args, **kwargs):
            if action == 'routine.resume':
                raise AuditUnavailable()
            return original(actor, action, *args, **kwargs)
        audit.act = act
        try:
            run(hermes, cron, start=True)
        finally:
            audit.act = original

    fresh()
    # dismiss: audited, a tightening; 409 when it is not pending or Hermes does not latch it
    hermes = FakeHermes([record()])
    assert m.dismiss(audit, 'basic:ana', 'vendas', SID, hermes) is None and hermes.dismissed == [SID]
    assert [(a, o) for a, o, _d in rows(path)[0] if a == 'suggestion.dismiss'] == [('suggestion.dismiss', 'ok'), ('suggestion.dismiss', 'ok')]
    for hermes in (FakeHermes([]), FakeHermes([record(status='accepted')]), FakeHermes([record()], mismatch=True)):
        assert refused(lambda: m.dismiss(audit, 'basic:ana', 'vendas', SID, hermes), 'suggestion_not_pending').code == 'suggestion_not_pending' and hermes.dismissed == []
    hermes = FakeHermes([record()], dismiss_returns=False)
    assert refused(lambda: m.dismiss(audit, 'basic:ana', 'vendas', SID, hermes), 'suggestion_not_pending').code == 'suggestion_not_pending'
    assert [o for a, o, _d in rows(path)[0] if a == 'suggestion.dismiss'][-1] == 'error'                                                         # the result row says error
    hermes = FakeHermes([record()])
    assert refused(lambda: m.dismiss(audit, 'basic:ana', 'vendas', '../x', hermes), 'suggestion_not_pending') and hermes.gets == []

    fresh()
    # the next list: a record whose row says LuveBot made its routine is marked accepted (audited) and left out; the others stay; a list that is not a list is returned as it is
    hermes = FakeHermes([record(), dict(record(), id='b1b2c3d4e5f6')])
    m._remember(path, 'vendas', SID, 'job9')
    kept = m.repaired(audit, path, 'vendas', [dict(r) for r in hermes.records.values()], hermes)
    assert [r['id'] for r in kept] == ['b1b2c3d4e5f6'] and hermes.resolved == [SID], (kept, hermes.resolved)
    assert [(a, o) for a, o, _d in rows(path)[0] if a == 'suggestion.repair'] == [('suggestion.repair', 'ok'), ('suggestion.repair', 'ok')]
    assert m.repaired(audit, path, 'compras', [dict(record())], hermes) == [dict(record())]                                                     # another Bot's list is not touched
    hermes = FakeHermes([record()], resolve_raises=RuntimeError('boom'))
    assert m.repaired(audit, path, 'vendas', [dict(record())], hermes) == []                                                                    # a setter that fails again: still left out, never raised
    hermes = FakeHermes([record()], resolve_raises=ConfigBackendUnavailable('x'))
    assert m.repaired(audit, path, 'vendas', [dict(record())], hermes) == []
    assert m.repaired(audit, path, 'vendas', 'not a list', hermes) == 'not a list'
    assert m.start_of({}) is False and m.start_of({'start': True}) is True and m.start_of({'start': False}) is False
    for bad, code in (({'start': 'yes'}, 'invalid_field'), ({'start': 1}, 'invalid_field'), ({'start': None}, 'invalid_field'), ({'start': True, 'x': 1}, 'invalid_field'), ([], 'bad_request'), (None, 'bad_request'), ('x', 'bad_request')):
        assert refused(lambda: m.start_of(bad), code).code == code, bad


def test_accept_and_dismiss_a_routine_suggestion(tmp_path):
    accept_checks(tmp_path)


MUTATIONS = {
    'two clicks make two jobs': ('    with _stripe(bot, suggestion_id):\n        done = accepted_ids(path, bot).get(suggestion_id)', '    if True:\n        done = accepted_ids(path, bot).get(suggestion_id)'),
    'a retry makes another job': ('        done = accepted_ids(path, bot).get(suggestion_id)\n', '        done = None\n'),
    'the row is not kept': ('            _remember(path, bot, suggestion_id, job["id"])\n', '            pass\n'),
    'the routine is created active': ('paused=True, paused_reason=PAUSED_REASON', 'paused=False, paused_reason=PAUSED_REASON'),
    'an unsupported suggestion is created': ('        if not item["supported"]:\n', '        if False:\n'),
    'the id may be an index or a title': ('    if not ID.fullmatch(suggestion_id):\n        raise _not_pending()\n    record = hermes.get_suggestion', '    record = hermes.get_suggestion'),
    'the record may be another one': ('    if item is None or record.get("id") != suggestion_id:', '    if item is None:'),
    'the setter failing fails the answer': ('        convert(hermes.resolve_accepted)(bot, suggestion_id)\n        return True\n    except Exception as error:', '        hermes.resolve_accepted(bot, suggestion_id)\n        return True\n    except KeyError as error:'),
    'the outage is not converted at the source': ('        convert(hermes.resolve_accepted)(bot, suggestion_id)\n        return True', '        hermes.resolve_accepted(bot, suggestion_id)\n        return True'),
    'the record is never resolved': ('        _resolve(hermes, bot, suggestion_id)\n        started, held = False, None', '        started, held = False, None'),
    'a retry does not resolve': ('            job = cron.get(bot, done)\n            _resolve(hermes, bot, suggestion_id)\n', '            job = cron.get(bot, done)\n'),
    'a removed routine is returned': ('            if job is None:   # the person removed it since', '            if False:   # the person removed it since'),
    'a start is not gated': ('lambda: convert(start_job)(job["id"])', 'lambda: {"id": job["id"], "enabled": True, "state": "scheduled"}'),
    'a start is never asked for': ('        if start:\n            try:', '        if True:\n            try:'),
    'a refused start is raised': ('            except (PluginError, HermesError) as error:\n                held = error.code', '            except KeyError as error:\n                held = error.code'),
    'a refused start has no code': ('                held = error.code\n', '                held = "x"\n'),
    'an unavailable audit is a held': ('            except AuditUnavailable:\n                raise\n', ''),
    'the start is not audited': ('job = audit.act(actor, "routine.resume", job["id"], origin, lambda: convert(start_job)(job["id"]), bot=bot) or job', 'job = convert(start_job)(job["id"]) or job'),
    'the accept is not audited': ('job = audit.act(actor, "suggestion.accept", suggestion_id, origin, effect, bot=bot, payload={"keys": sorted(fields), "spec": spec_digest(record["job_spec"])})', 'job = effect()'),
    'the create is not audited': ('job = audit.act(actor, "routine.create", None, origin, lambda: cron.create(bot, **fields, paused=True, paused_reason=PAUSED_REASON), bot=bot,\n                            payload={"keys": sorted(fields), "start": False, "suggestion": True})',
                                  'job = cron.create(bot, **fields, paused=True, paused_reason=PAUSED_REASON)'),
    'the audit payload holds the text': ('payload={"keys": sorted(fields), "spec": spec_digest(record["job_spec"])}', 'payload={"keys": sorted(fields), "spec": record["job_spec"]}'),
    'the stored spec is not validated': ('        _bot, fields, _start, _template = routines.validate_create({"bot": bot, **record["job_spec"]})   # the same validation as POST /routines\n',
                                         '        fields = dict(record["job_spec"])\n'),
    'dismiss is not audited': ('        audit.act(actor, "suggestion.dismiss", suggestion_id, {"kind": "ui"}, effect, bot=bot)', '        effect()'),
    'dismiss does not check pending': ('    with _stripe(bot, suggestion_id):\n        _pending(hermes, bot, suggestion_id)\n\n        def effect():', '    with _stripe(bot, suggestion_id):\n\n        def effect():'),
    'dismiss ignores Hermes saying no': ('            if not hermes.dismiss_suggestion(bot, suggestion_id):\n                raise _not_pending()', '            hermes.dismiss_suggestion(bot, suggestion_id)'),
    'the list keeps a made suggestion': ('        if suggestion_id not in done:\n            kept.append(record)\n            continue\n', '        if suggestion_id not in done:\n            kept.append(record)\n            continue\n        kept.append(record)\n'),
    'a repair that fails raises': ('        except Exception as error:  # noqa: BLE001\n            log.warning("suggestion repair failed', '        except KeyError as error:  # noqa: BLE001\n            log.warning("suggestion repair failed'),
    'a repair is not audited': ('            audit.act("system", "suggestion.repair", suggestion_id, {"kind": "system"}, lambda: convert(hermes.resolve_accepted)(bot, suggestion_id), bot=bot)', '            convert(hermes.resolve_accepted)(bot, suggestion_id)'),
    'start accepts any value': ('    if not isinstance(start, bool):\n        raise PluginError("invalid_field", "Invalid value for start.", 422)', '    pass'),
    'start accepts extra keys': ('    extra = set(body) - {"start"}\n    if extra:', '    extra = set()\n    if extra:'),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_accept_mutation_is_caught(label, tmp_path):
    old, new = MUTATIONS[label]
    setup(tmp_path, [(old, new)])                                    # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        accept_checks(tmp_path, [(old, new)])


# ---- the routes ------------------------------------------------------------------------------------------------------------------------------------
def route_source(path, name):
    return re.search(rf"@router\.post\('{re.escape(path)}'\)\nasync def {name}.*?(?=\n\n\n(?:@router|def |async def ))", API, re.S).group(0)


ACCEPT = '/bots/{bot}/routine-suggestions/{suggestion_id}/accept'
DISMISS = '/bots/{bot}/routine-suggestions/{suggestion_id}/dismiss'


def accept_route(body, *, result=None, paused=False, gate=None, edits=()):
    text = route_source(ACCEPT, 'accept_routine_suggestion')
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    deep = re.search(r"def _redact_deep\(value\):.*?(?=\n\n\nasync def _room_call)", API, re.S).group(0)
    name, _ = threads.package()
    shaping = threads.variant(name, 'routine_suggestions')
    seen = {'need': [], 'accept': None, 'resumed': [], 'gate': []}

    class PluginError(Exception):
        def __init__(self, code, message, status):
            self.code, self.status = code, status

    async def run_in_threadpool(fn, *args, **kwargs):
        return fn(*args, **kwargs)

    async def need(route='list'):
        seen['need'].append(route)

    async def json_body(request):
        return body

    def fake_accept(audit, path, actor, bot, sid, start, hermes, cron, start_job):
        seen['accept'] = (actor, bot, sid, start)
        if start:
            try:
                start_job('job1')
                seen['started'] = True
            except PluginError as error:
                seen['held'] = error.code
        return result or {'job': {'id': 'job1'}, 'started': False, 'held': None, 'replayed': False}

    class Response:
        def __init__(self, content, status_code=200, headers=None):
            self.content, self.status_code = content, status_code

    async def names():
        return ['vendas']

    async def routine_view(bot, job):
        return {'id': job['id'], 'bot': bot}
    cron = types.SimpleNamespace(resume=lambda bot, job_id: seen['resumed'].append(job_id) or {'id': job_id}, get=lambda bot, job_id: {'id': job_id, 'fresh': True})

    def start_gate(budget, path, bot, job_id):
        seen['gate'].append(job_id)
        if gate:
            raise gate
    ns = {'router': types.SimpleNamespace(post=lambda path: (lambda fn: fn)), 'Request': object, 'JSONResponse': Response, '_human': lambda request: types.SimpleNamespace(id='basic:ana'), '_json_body': json_body,
          'routine_suggestions': types.SimpleNamespace(start_of=shaping.start_of, accept=fake_accept), 'validate_profile': lambda b: b, '_names': names, 'HermesError': PluginError, '_need_suggestions': need,
          '_stores': lambda: ('audit', types.SimpleNamespace(path='db')), 'Budget': lambda path, audit=None: 'budget', 'run_in_threadpool': run_in_threadpool, 'is_paused': lambda path, bot: paused,
          'PluginError': PluginError, '_start_gate': start_gate, '_cron': cron, 'hermes_cron': 'hermes', '_routine_view': routine_view, '_REDACT': lambda text: text, '_HEADERS': {}}
    exec(deep, ns)
    exec(text, ns)
    try:
        answer = asyncio.run(ns['accept_routine_suggestion']('vendas', SID, object()))
    except Exception as error:  # noqa: BLE001  (a refusal of the shaping module or of the route: its code)
        return error.code, seen
    return (answer.status_code, answer.content), seen


def test_the_accept_route_needs_a_login_answers_201_and_starts_only_through_the_gates():
    answer, seen = accept_route({})
    assert answer == (201, {'routine': {'id': 'job1', 'bot': 'vendas'}, 'suggestion_id': SID, 'started': False}), answer          # no `held`, no `replayed` unless there is one
    assert seen['need'] == ['accept'] and seen['accept'] == ('basic:ana', 'vendas', SID, False)
    answer, _ = accept_route({'start': True}, result={'job': {'id': 'job1'}, 'started': False, 'held': 'bot_paused', 'replayed': False})
    assert answer[1]['held'] == 'bot_paused' and answer[1]['started'] is False and 'replayed' not in answer[1]
    answer, _ = accept_route({}, result={'job': {'id': 'job1'}, 'started': True, 'held': None, 'replayed': True})
    assert answer[1]['replayed'] is True and answer[1]['started'] is True and 'held' not in answer[1]
    answer, seen = accept_route({'start': True})
    assert seen['accept'][3] is True and seen['gate'] == ['job1'] and seen['resumed'] == ['job1'] and seen['started'] is True                  # the gate first, then the resume
    answer, seen = accept_route({'start': True}, paused=True)
    assert seen.get('held') == 'bot_paused' and seen['gate'] == [] and seen['resumed'] == []                                        # a Bot paused by its budget never starts a routine from here
    gate = types.SimpleNamespace()
    for bad, want in (({'start': 'yes'}, 'invalid_field'), ({'x': 1}, 'invalid_field'), ([], 'bad_request')):
        assert accept_route(bad)[0] == want, bad                                                                                    # the body is {start?: bool} and nothing else


def test_the_accept_route_is_for_a_person_and_the_dismiss_route_is_a_tightening():
    accept, dismiss = route_source(ACCEPT, 'accept_routine_suggestion'), route_source(DISMISS, 'dismiss_routine_suggestion')
    assert accept.index('_human(request)') < accept.index('_json_body(request)') < accept.index('validate_profile(bot)') < accept.index("_need_suggestions('accept')") < accept.index('run_in_threadpool(routine_suggestions.accept')
    assert '_human(' not in dismiss and '_identity(request)' in dismiss and '_require_csrf(request, credential)' in dismiss                      # session and CSRF, no login: a loopback may dismiss
    assert dismiss.index('_identity(request)') < dismiss.index("_need_suggestions('dismiss')") < dismiss.index('run_in_threadpool(routine_suggestions.dismiss')
    assert "{'dismissed': True}" in dismiss and 'accept_suggestion' not in accept + dismiss
    assert 'start_job' in accept and "is_paused(meta.path, name)" in accept and '_start_gate(budget, meta.path, name, job_id)' in accept        # the gates of resuming a routine, and the pause of the budget
