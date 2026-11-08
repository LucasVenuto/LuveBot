"""P1-3 (contract v0.10 section 1.2 item 5): the THREADS that read Hermes. Python ignores a `SystemExit` raised in a thread (the thread just ends, silently), and Hermes's config outage IS one, so a
watcher or a worker that touched the config during an outage used to disappear without a word. Now:
* `hermes_boundary.thread_target(fn)`: the converted outage, and since P1-8 a plain `sys.exit` (converted to `hermes_exited`), end ONE unit of work cleanly (the boundary already logged it, by class); anything else is raised as before;
* the approvals watcher: an outage skips ONE poll (its `_follow`, its state read, its settle, the read of the Bot's wait) and the watcher goes on, captures the next request and ends with the run;
  a plain exit is a skipped poll too (P1-8), a KeyboardInterrupt still propagates, and the slot is freed either way;
* plan_quota's worker: the outage is `unreadable` (the existing word), the flight is freed;
* the other targets are wired by a STATIC scan: every `threading.Thread` of the plugin and the backend has a target that goes through the boundary, or is one of the four whose own body guards it.
Mutations: one line of each place changed -> red."""
import ast
import importlib
import importlib.util
import itertools
import json
import logging
from pathlib import Path
import re
import sqlite3
import sys
import textwrap
import threading
import types

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
_n = itertools.count()


class ConfigBackendUnavailable(SystemExit):
    pass


def package():
    """The real backend package under its own name, with `hermes_client` and `hermes_api` stubbed (they import Hermes): a HermesError that carries its code, an ApiClient to be set per test."""
    name = f'th_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    client = types.ModuleType(f'{name}.hermes_client')

    class HermesError(Exception):
        def __init__(self, code):
            self.code = code
            super().__init__(code)
    client.HermesError = HermesError
    api = types.ModuleType(f'{name}.hermes_api')
    api.ApiClient, api.safe_id = None, lambda value: value
    sys.modules[client.__name__], sys.modules[api.__name__] = client, api
    return name, HermesError


def variant(name, module, edits=()):
    """`module` of the package, from its source with `edits` applied (anchors must occur once); the real one when there are none."""
    if not edits:
        return importlib.import_module(f'{name}.{module}')
    source = (BACKEND / f'{module}.py').read_text()
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    loaded = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.{module}', loader=None))
    loaded.__package__ = name
    sys.modules[loaded.__name__] = loaded
    exec(compile(source, str(BACKEND / f'{module}.py'), 'exec'), loaded.__dict__)
    return loaded


def outcome(fn):
    try:
        return 'returned', fn()
    except BaseException as error:  # noqa: BLE001
        return 'raised', error


# ---- thread_target -----------------------------------------------------------------------------------------------------------------------------
def thread_target_checks(boundary):
    def raiser(error):
        def fn(*args):
            raise error
        return fn
    assert outcome(lambda: boundary.thread_target(raiser(ConfigBackendUnavailable('https://u:SECRET@cfg/x')))()) == ('returned', None)     # ends the unit of work, quietly
    assert outcome(lambda: boundary.thread_target(raiser(SystemExit(3)))()) == ('returned', None)                                  # P1-8: a plain exit ends the unit of work the same way (the boundary logged its class)
    for error in (KeyboardInterrupt(), GeneratorExit()):                                                                              # anything else that is not an Exception is raised untouched
        kind, got = outcome(lambda: boundary.thread_target(raiser(error))())
        assert kind == 'raised' and got is error
    kind, got = outcome(lambda: boundary.thread_target(raiser(KeyError('k')))())
    assert kind == 'raised' and type(got) is KeyError
    assert boundary.thread_target(lambda a, b=1: a + b)(2, b=5) == 7 and boundary.thread_target(lambda: 1).__name__ == '<lambda>'
    seen = []                                                                                                                         # and in a REAL thread: nothing reaches the excepthook for the outage
    old_hook, threading.excepthook = threading.excepthook, lambda args: seen.append(args.exc_type)
    try:
        for error in (ConfigBackendUnavailable('x'), SystemExit(3), KeyError('k')):
            thread = threading.Thread(target=boundary.thread_target(raiser(error)))
            thread.start()
            thread.join()
    finally:
        threading.excepthook = old_hook
    assert seen == [KeyError], seen


def test_the_target_of_a_thread_ends_one_unit_of_work_on_the_outage_and_nothing_else():
    name, _ = package()
    thread_target_checks(importlib.import_module(f'{name}.hermes_boundary'))


THREAD_MUTATIONS = {
    'every exception is swallowed': ("            if getattr(error, 'code', None) not in CONVERTED:\n                raise\n", '            pass\n'),
    'the outage is raised': ("            if getattr(error, 'code', None) not in CONVERTED:\n                raise\n", '            raise\n'),
    'a stopped operation is raised': ("            if getattr(error, 'code', None) not in CONVERTED:\n                raise\n", "            if getattr(error, 'code', None) != 'config_backend_unavailable':\n                raise\n"),
    'no conversion': ('    run = convert(fn)\n', '    run = fn\n'),
}


@pytest.mark.parametrize('label', sorted(THREAD_MUTATIONS))
def test_each_thread_target_mutation_is_caught(label):
    name, _ = package()
    boundary = variant(name, 'hermes_boundary', [THREAD_MUTATIONS[label]])
    with pytest.raises(BaseException):  # noqa: B017
        thread_target_checks(boundary)


# ---- the approvals watcher ---------------------------------------------------------------------------------------------------------------------
def ask(request_id):
    return ['event: approval.request', 'data: ' + json.dumps({'request_id': request_id, 'command': 'chmod 600 x', 'description': 'd', 'pattern_keys': ['k'], 'choices': ['once', 'deny']}), '']


DONE = ['event: run.completed', 'data: ' + json.dumps({'output': 'ok'}), '']
OUTAGE = 'outage'


class Hermes:
    """`streams`: one entry per connection: a list of lines, OUTAGE (the call raises Hermes's config outage), or None (cannot open). `states`: the answers of GET /v1/runs/{id} in turn (the last repeats)."""
    def __init__(self, streams, states=('running',)):
        self.streams, self.states, self.slept = list(streams), list(states), []

    def client(self, _bot):
        hermes = self

        class Stream:
            def __init__(self, items):
                self.items = items

            def lines(self, _limit):
                yield from self.items

            def abort(self):
                pass

        class Client:
            def open_stream(self, method, path, **_kw):
                items = hermes.streams.pop(0) if hermes.streams else None
                if items == OUTAGE:
                    raise ConfigBackendUnavailable('https://u:SECRET@cfg/x')
                if isinstance(items, BaseException):
                    raise items
                return (200, Stream(items)) if items is not None else (404, None)

            def call(self, method, path, body=None, **_kw):
                state = hermes.states.pop(0) if len(hermes.states) > 1 else hermes.states[0]
                if state == OUTAGE:
                    raise ConfigBackendUnavailable('x')
                return (404, None) if state == 404 else (200, {'status': state})
        return Client()


def watch(name, tmp_path, hermes, edits=(), *, ttl=None, settle=None, follow=None):
    native = variant(name, 'approvals_native', edits)
    approvals = importlib.import_module(f'{name}.approvals')
    db = tmp_path / f'w{next(_n)}.db'
    approvals.connect(db).close()
    saved = {key: getattr(native, key) for key in ('ApiClient', 'settle_reasons', '_follow', 'approvals')}   # the module is shared by the scenarios of one test: each puts back what it changed
    native.ApiClient = hermes.client
    native.settle_reasons = settle or (lambda *_a: None)
    if follow is not None:
        native._follow = follow
    if ttl is not None:
        native.approvals = types.SimpleNamespace(ttl=ttl, TTL_SLACK=0, record_request=approvals.record_request, expire_run=approvals.expire_run)
    native._active.add('run_1')

    def sleep(seconds):
        hermes.slept.append(seconds)
        if len(hermes.slept) > 40:
            raise RuntimeError('the watcher is looping: a test that never ends is a failed test')   # an Exception: the watcher ends with it, and the assertions below say what was wrong
    try:
        result = outcome(lambda: native._watch(db, 'vendas', 'run_1', lambda text: text, clock=lambda: 0.0, sleep=sleep))
    finally:
        for key, value in saved.items():
            setattr(native, key, value)
    conn = sqlite3.connect(db)
    try:
        requests = [r[0] for r in conn.execute('SELECT request_id FROM approvals ORDER BY request_id')]
    finally:
        conn.close()
    assert 'run_1' not in native._active                                          # the slot is freed, whatever happened
    return result, requests


def watcher_checks(name, tmp_path, edits=()):
    # the outage on the first connection: that poll is skipped, the next one captures the request and the run's end ends the watcher
    hermes = Hermes([OUTAGE, ask('req_1') + DONE])
    result, requests = watch(name, tmp_path, hermes, edits)
    assert result == ('returned', None) and requests == ['req_1'] and len(hermes.slept) == 1, (result, requests, hermes.slept)
    # the outage in the middle of a connection (the stream ends without a terminal event), then in the state read: skipped, and the watcher goes on to the end
    hermes = Hermes([ask('req_a'), ask('req_b') + DONE], states=(OUTAGE, 'running'))
    result, requests = watch(name, tmp_path, hermes, edits)
    assert result == ('returned', None) and requests == ['req_a', 'req_b'], (result, requests)
    # the outage while the ended run is settled: the reasons stay as they were, the watcher ends in order
    def settle(*_a):
        raise ConfigBackendUnavailable('x')
    hermes = Hermes([[]], states=('completed',))
    result, requests = watch(name, tmp_path, hermes, edits, settle=settle)
    assert result == ('returned', None), result
    # the outage in the read of the Bot's wait (the ceiling): the floor is used, the watcher still runs
    def ttl(bot):
        raise ConfigBackendUnavailable('x')
    hermes = Hermes([ask('req_c') + DONE])
    result, requests = watch(name, tmp_path, hermes, edits, ttl=ttl)
    assert result == ('returned', None) and requests == ['req_c'], (result, requests)
    # a HermesError that is NOT the outage, coming out of the follow, is not a skipped poll: the watcher stops with its log line, as for any other failure
    hermes_error = importlib.import_module(f'{name}.hermes_client').HermesError

    def broken_follow(*_a):
        raise hermes_error('hermes_error')
    hermes = Hermes([[]], states=('running',))
    result, requests = watch(name, tmp_path, hermes, edits, follow=broken_follow)
    assert result == ('returned', None) and len(hermes.slept) == 0, (result, hermes.slept)
    # P1-8: a plain exit (a helper that calls sys.exit()) in the follow is `hermes_exited`, a skipped poll too: the watcher is neither dead nor silent
    hermes = Hermes([SystemExit(3), ask('req_x') + DONE])
    result, requests = watch(name, tmp_path, hermes, edits)
    assert result == ('returned', None) and requests == ['req_x'] and len(hermes.slept) == 1, (result, requests, hermes.slept)
    # anything else that is not an Exception is NOT swallowed: it propagates, with the slot freed
    hermes = Hermes([KeyboardInterrupt()])
    kind, got = watch(name, tmp_path, hermes, edits)[0]
    assert kind == 'raised' and type(got) is KeyboardInterrupt, (kind, got)
    # any other failure keeps the old behaviour: the watcher says it stopped
    hermes = Hermes([KeyError('k')], states=('completed',))
    assert watch(name, tmp_path, hermes, edits)[0][0] == 'returned' and len(hermes.slept) == 0


def test_the_approvals_watcher_skips_one_poll_on_the_outage_and_goes_on(tmp_path, caplog):
    caplog.set_level(logging.WARNING)
    name, _ = package()
    watcher_checks(name, tmp_path)


WATCHER_MUTATIONS = {
    'the follow is not converted': [('convert(_follow)(path, bot, run_id, redact, clock, deadline)', '_follow(path, bot, run_id, redact, clock, deadline)')],
    'a converted follow ends the watcher': [("                if error.code not in CONVERTED:\n                    raise\n                ended, frames = False, 0", "                raise\n                ended, frames = False, 0")],
    'every HermesError is a skipped poll': [("                if error.code not in CONVERTED:\n                    raise\n                ended, frames = False, 0", "                ended, frames = False, 0")],
    'a stopped call ends the watcher': [("                if error.code not in CONVERTED:\n", "                if error.code != 'config_backend_unavailable':\n")],
    'the state read is not converted': [("convert(ApiClient(bot).call)('GET', f'/v1/runs/{run_id}')", "ApiClient(bot).call('GET', f'/v1/runs/{run_id}')")],
    'the settle is not converted': [('        convert(settle_reasons)(path, bot, run_id)', '        settle_reasons(path, bot, run_id)')],
    'the ceiling is not converted': [('            ceiling = convert(watch_ceiling)(bot)', '            ceiling = watch_ceiling(bot)')],
    'no floor when the ceiling cannot be read': [('            ceiling = WATCH_FLOOR  # the wait of this Bot', '            raise  # the wait of this Bot')],
}


@pytest.mark.parametrize('label', sorted(WATCHER_MUTATIONS))
def test_each_watcher_mutation_is_caught(label, tmp_path, caplog):
    caplog.set_level(logging.WARNING)
    name, _ = package()
    variant(name, 'approvals_native', WATCHER_MUTATIONS[label])                      # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        watcher_checks(name, tmp_path, WATCHER_MUTATIONS[label])


# ---- plan_quota's worker -----------------------------------------------------------------------------------------------------------------------
def quota_checks(name, edits=()):
    quota = variant(name, 'plan_quota', edits)

    def run(fetch):
        done = threading.Event()
        quota._flight['a'] = done
        quota._failed.pop('a', None)
        result = outcome(lambda: quota._run('a', fetch, done))
        return result, quota._failed.get('a'), 'a' in quota._flight, done.is_set()

    def outage(bot):
        raise ConfigBackendUnavailable('https://u:SECRET@cfg/x')

    def plain_exit(bot):
        raise SystemExit(3)
    assert run(outage) == (('returned', None), 'unreadable', False, True)                                # `unreadable`, the flight freed, the waiter released
    assert run(plain_exit) == (('returned', None), 'unreadable', False, True)                           # P1-8: a plain exit is the same: this one fetch failed, the thread is not dead and not silent

    def interrupt(bot):
        raise KeyboardInterrupt()
    kind, got = run(interrupt)[0]
    assert kind == 'raised' and type(got) is KeyboardInterrupt                                           # anything else that is not an Exception still propagates (the `finally` ran: below)
    assert run(interrupt)[2:] == (False, True)
    assert run(lambda bot: [])[1:3] == (None, False)                                                     # a quota that is there is as before


def test_the_quota_worker_reads_the_outage_as_unreadable():
    quota_checks(package()[0])


@pytest.mark.parametrize('label,edits', [
    ('the fetch is not converted', [('        providers = convert(fetch)(bot)', '        providers = fetch(bot)')]),
    ('the import is gone: nothing converts', [('from .hermes_boundary import convert\n', 'convert = lambda fn: fn\n')]),
], ids=['not converted', 'no conversion at all'])
def test_each_quota_mutation_is_caught(label, edits):
    name, _ = package()
    variant(name, 'plan_quota', edits)
    with pytest.raises(BaseException):  # noqa: B017
        quota_checks(name, edits)


# ---- the static scan of every thread and the reader's clause -----------------------------------------------------------------------------------
ALLOWED_TARGETS = {('dashboard/plugin_api.py', '_background_loop'), ('backend/approvals_native.py', '_watch'), ('backend/plan_quota.py', '_run'), ('dashboard/plugin_api.py', 'reader'),
                   ('backend/redaction.py', 'call'), ('backend/redaction.py', 'warm_up'), ('backend/redaction.py', 'ready')}   # (file, name): each guards ITSELF: the tick (P1-2), the watcher, the quota worker, the stream reader's own clause below, the three of the redaction child (test_redaction.py reads their clauses)
OFF_LOOP = {'Thread': 'target', 'Timer': 'function'}   # the `threading` classes that run a function on a thread of their own, and the keyword that names it (both take it as the second positional)


class Target:
    """What a site runs: the file it is in and the AST node of the function (None for a Thread subclass, whose `run` is not a name we can follow)."""
    def __init__(self, rel, node):
        self.rel, self.node = rel, node


def _threading_names(tree):
    """-> (names of the `threading` module, {local name: class}) from `import threading [as th]` and `from threading import Thread [as T]`."""
    modules, classes = set(), {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules |= {a.asname or a.name for a in node.names if a.name == 'threading'}
        elif isinstance(node, ast.ImportFrom) and node.module == 'threading':
            classes.update({a.asname or a.name: a.name for a in node.names if a.name in OFF_LOOP})
    return modules, classes


def thread_sites(files):
    """[(file, line, Target)]: every place the tree starts a function off the event loop, however it spells it: threading.Thread / Timer (module, alias or `from` import), a subclass of one,
    asyncio.to_thread and loop.run_in_executor."""
    found = []
    for rel, text in files.items():
        tree = ast.parse(text)
        modules, classes = _threading_names(tree)

        def off_loop(expr):
            if isinstance(expr, ast.Name):
                return classes.get(expr.id)
            if isinstance(expr, ast.Attribute) and isinstance(expr.value, ast.Name) and expr.value.id in modules and expr.attr in OFF_LOOP:
                return expr.attr
            return None
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and any(off_loop(base) for base in node.bases):
                found.append((rel, node.lineno, Target(rel, None)))
            elif isinstance(node, ast.Call):
                kind, name = off_loop(node.func), (node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, 'id', ''))
                if kind:
                    target = next((k.value for k in node.keywords if k.arg == OFF_LOOP[kind]), node.args[1] if len(node.args) > 1 else None)
                elif name == 'to_thread' and node.args:
                    target = node.args[0]
                elif name == 'run_in_executor' and len(node.args) > 1:
                    target = node.args[1]
                else:
                    continue
                found.append((rel, node.lineno, Target(rel, target)))
    return found


def target_ok(site):
    rel, target = site.rel, site.node
    if isinstance(target, ast.Call):
        return ast.unparse(target.func) in ('convert', 'hermes_boundary.convert', 'thread_target', 'hermes_boundary.thread_target')
    if isinstance(target, ast.Name):
        return (rel, target.id) in ALLOWED_TARGETS
    if isinstance(target, ast.Lambda) and isinstance(target.body, ast.Call) and ast.unparse(target.body.func) == '_quiet' and target.body.args:
        first = target.body.args[0]
        return isinstance(first, ast.Call) and ast.unparse(first.func) in ('convert', 'hermes_boundary.convert')
    return False


def files(edits=()):
    out = {'dashboard/plugin_api.py': API, **{f'backend/{p.name}': p.read_text() for p in sorted(BACKEND.glob('*.py'))}}
    for rel, old, new in edits:
        assert out[rel].count(old) == 1, old
        out[rel] = out[rel].replace(old, new)
    return out


def static_checks(edits=()):
    sites = thread_sites(files(edits))
    assert len(sites) >= 6, sites                                                                   # the scan sees the six threads of today
    bad = [(rel, line) for rel, line, site in sites if not target_ok(site)]
    assert bad == [], bad


def test_every_thread_target_goes_through_the_boundary_or_guards_itself():
    static_checks()


@pytest.mark.parametrize('edits', [
    [('backend/push.py', 'target=hermes_boundary.thread_target(self._send_all)', 'target=self._send_all')],
    [('dashboard/plugin_api.py', '_quiet(hermes_boundary.convert(hermes_cron.fire), bot', '_quiet(hermes_cron.fire, bot')],
    [('dashboard/plugin_api.py', "threading.Thread(target=reader, daemon=True).start()", "threading.Thread(target=reader2, daemon=True).start()")],
    [('backend/plan_quota.py', 'threading.Thread(target=_run,', 'threading.Thread(target=_other,')],
], ids=['push', 'routine test', 'stream reader renamed', 'quota worker renamed'])
def test_each_static_thread_mutation_is_caught(edits):
    with pytest.raises(AssertionError):
        static_checks(edits)


def reader_checks(text):
    """The stream reader of `_relay`, executed with stand-ins: any SystemExit (the config outage on purpose, or a plain exit) tells the relay `error`, as does an Exception; a KeyboardInterrupt
    propagates and tells nothing; a clean stream ends with `end`."""
    body = text.split('async def _relay(', 1)[1]
    source = textwrap.dedent('    def reader():' + body.split('    def reader():', 1)[1].split('    threading.Thread(target=reader', 1)[0])

    def run(items):
        pushed = []

        class Upstream:
            def lines(self, _limit):
                for item in items:
                    if isinstance(item, BaseException):
                        raise item
                    yield item
        ns = {'upstream': Upstream(), 'loop': types.SimpleNamespace(call_soon_threadsafe=lambda fn, item: pushed.append(item)), 'push': None,
              'sse_proxy': types.SimpleNamespace(MAX_LINE=1), 'hermes_boundary': importlib.import_module(f'{package()[0]}.hermes_boundary')}
        exec(source, ns)
        return outcome(ns['reader']), pushed
    assert run(['a', 'b']) == (('returned', None), [('line', 'a'), ('line', 'b'), ('end', None)])
    for error in (ConfigBackendUnavailable('https://u:SECRET@cfg/x'), SystemExit(3), KeyError('k')):
        result, pushed = run(['a', error])
        assert result == ('returned', None) and pushed == [('line', 'a'), ('error', None)], (error, result, pushed)
    result, pushed = run([KeyboardInterrupt()])
    assert result[0] == 'raised' and type(result[1]) is KeyboardInterrupt and pushed == [], (result, pushed)


def test_the_stream_reader_tells_the_relay_about_any_exit_instead_of_ending_in_silence():
    reader_checks(API)


@pytest.mark.parametrize('old,new', [
    ("        except (Exception, SystemExit):", "        except Exception:"),
    ("        except (Exception, SystemExit):", "        except BaseException:"),
    ("        except (Exception, SystemExit):", "        except KeyError:"),
], ids=['an exit is not told', 'a KeyboardInterrupt is swallowed', 'the clause is gone'])
def test_each_reader_mutation_is_caught(old, new):
    assert API.count(old) == 1, old
    with pytest.raises(AssertionError):
        reader_checks(API.replace(old, new))
