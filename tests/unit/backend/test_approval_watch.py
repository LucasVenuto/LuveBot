"""A run's approval watcher lives as long as the run (the fixed 3600 s stopped it on any run longer than an hour: later approval
requests never reached the inbox and a deny reason never settled). It ends on the terminal event, or when the stream ends and
Hermes says the run ended; a stream that drops while the run lives is reopened with backoff; only a high safety ceiling stops it
otherwise, and that leaves an audit row and a log line. One watcher per run. Hermes is scripted here; the clock is injected.
Mutations: the fixed ceiling back; no reconnection; the backoff never starting over; the ceiling reached in silence.
"""
import importlib
import importlib.util
import itertools
import json
import logging
from pathlib import Path
import sqlite3
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
HOUR = 3600.0


def load(edit=None):
    name = f'watch_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    api = types.ModuleType(f'{name}.hermes_api')
    api.ApiClient, api.safe_id = None, lambda value: value
    client = types.ModuleType(f'{name}.hermes_client')
    client.HermesError = type('HermesError', (Exception,), {})
    sys.modules[api.__name__], sys.modules[client.__name__] = api, client
    approvals = importlib.import_module(f'{name}.approvals')
    if not edit:
        return approvals, importlib.import_module(f'{name}.approvals_native')
    source = (BACKEND / 'approvals_native.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    native = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.approvals_native', loader=None))
    native.__package__ = name
    sys.modules[native.__name__] = native
    exec(compile(source.replace(*edit), str(BACKEND / 'approvals_native.py'), 'exec'), native.__dict__)
    return approvals, native


def ask(request_id):
    return ['event: approval.request', 'data: ' + json.dumps({'request_id': request_id, 'command': 'chmod 600 x', 'description': 'd',
                                                               'pattern_keys': ['k'], 'choices': ['once', 'deny']}), '']


DONE = ['event: run.completed', 'data: ' + json.dumps({'output': 'ok'}), '']


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class Hermes:
    """`streams`: one entry per connection, a list of items: a line (str) or a number (advance the clock that many seconds), or
    None for a stream that cannot open. `states`: GET /v1/runs/{id} answers in turn (the last one repeats)."""
    def __init__(self, clock, streams, states=('running',)):
        self.clock, self.streams, self.states, self.opened, self.slept = clock, list(streams), list(states), 0, []

    def client(self, _bot):
        hermes = self

        class Stream:
            def __init__(self, items):
                self.items = items

            def lines(self, _limit):
                for item in self.items:
                    if isinstance(item, (int, float)):
                        hermes.clock.now += item
                        yield ': keepalive'
                    else:
                        yield item

            def abort(self):
                pass

        class Client:
            def open_stream(self, method, path, **_kw):
                hermes.opened += 1
                items = hermes.streams.pop(0) if hermes.streams else None
                return (200, Stream(items)) if items is not None else (404, None)

            def call(self, method, path, body=None, **_kw):
                state = hermes.states.pop(0) if len(hermes.states) > 1 else hermes.states[0]
                return (404, None) if state == 404 else (200, {'status': state})
        return Client()


def watch(approvals, native, tmp_path, hermes):
    db = tmp_path / f'watch{next(_n)}.db'
    approvals.connect(db).close()
    native.ApiClient = hermes.client
    native.settle_reasons = lambda *_a: None
    native._active.add('run_1')
    native._watch(db, 'vendas', 'run_1', lambda text: text, clock=hermes.clock, sleep=hermes.slept.append)
    conn = sqlite3.connect(db)
    try:
        requests = [r[0] for r in conn.execute('SELECT request_id FROM approvals ORDER BY request_id')]
        ceiling = conn.execute("SELECT count(*) FROM audit_log WHERE action='approval.watch.ceiling' AND detail='result'").fetchone()[0]
    except sqlite3.OperationalError:
        ceiling = 0
    finally:
        conn.close()
    assert 'run_1' not in native._active                                         # the slot is freed, whatever happened
    return requests, ceiling


def checks(approvals, native, tmp_path, caplog):
    # a run of 3 h: a request after 2 h is still captured, and the run's end ends the watcher
    clock = Clock()
    long_run = Hermes(clock, [[HOUR, HOUR, *ask('req_late'), HOUR, *DONE]])
    assert watch(approvals, native, tmp_path, long_run) == (['req_late'], 0)
    # the stream drops while the run lives: reopened with backoff, the replayed backlog does not double the request
    clock = Clock()
    dropped = Hermes(clock, [[*ask('req_a')], None, [*ask('req_a'), *ask('req_b'), *DONE]], states=['running', 'running'])
    assert watch(approvals, native, tmp_path, dropped) == (['req_a', 'req_b'], 0)
    assert dropped.opened == 3 and dropped.slept == [0.5, 1.0]                     # a connection that read nothing: longer pause
    # connections that each read something before dropping: the pause starts over at 0.5 every time
    clock = Clock()
    flaky = Hermes(clock, [[*ask('req_c')], [*ask('req_d')], [*ask('req_e'), *DONE]], states=['running'])
    assert watch(approvals, native, tmp_path, flaky) == (['req_c', 'req_d', 'req_e'], 0) and flaky.slept == [0.5, 0.5]
    # the stream ends and Hermes says the run ended (an `interrupted` run has no terminal event): stop, no reconnection
    clock = Clock()
    interrupted = Hermes(clock, [[*ask('req_i')]], states=['interrupted'])
    assert watch(approvals, native, tmp_path, interrupted) == (['req_i'], 0) and interrupted.opened == 1
    # Hermes no longer knows the run: stop
    clock = Clock()
    gone = Hermes(clock, [[]], states=[404])
    assert watch(approvals, native, tmp_path, gone) == ([], 0) and gone.opened == 1
    # a run that never ends: only the ceiling stops it, and never in silence
    clock = Clock()
    endless = Hermes(clock, [[HOUR] * 30])
    with caplog.at_level(logging.WARNING, logger='luvebot.approvals'):
        assert watch(approvals, native, tmp_path, endless) == ([], 1)
    assert any('safety ceiling' in r.getMessage() for r in caplog.records)
    assert native.watch_ceiling('vendas') >= 6 * HOUR


def test_the_watcher_lives_as_long_as_the_run(tmp_path, caplog):
    checks(*load(), tmp_path, caplog)


def test_one_watcher_per_run():
    _approvals, native = load()
    started = []
    native.threading = types.SimpleNamespace(Thread=lambda **kw: types.SimpleNamespace(start=lambda: started.append(kw)))
    assert native.start_watcher('db', 'vendas', 'run_x', None) is True
    assert native.start_watcher('db', 'vendas', 'run_x', None) is False and len(started) == 1


def test_a_test_ceiling_can_be_forced(monkeypatch):
    _approvals, native = load()
    monkeypatch.setenv('LUVEBOT_APPROVAL_WATCH_CEILING', '5')
    assert native.watch_ceiling('vendas') == 5.0


@pytest.mark.parametrize('edit', [
    ("    return max(WATCH_FLOOR, 2 * (approvals.ttl(bot) - approvals.TTL_SLACK) + 600)", "    return 3600.0"),
    ("            sleep(backoff)\n", "            return\n"),
    ("                backoff = 0.5  # that connection worked for a while: start the pauses over\n", "                pass\n"),
    ("                AuditLog(path).act('system', 'approval.watch.ceiling', run_id, {'kind': 'system'}, lambda: None, bot=bot)\n", ""),
], ids=['fixed_ceiling', 'no_reconnection', 'no_backoff_reset', 'silent_ceiling'])
def test_each_mutation_is_caught(tmp_path, caplog, edit):
    approvals, native = load(edit)
    with pytest.raises(AssertionError):
        checks(approvals, native, tmp_path, caplog)
