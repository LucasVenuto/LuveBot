"""P-3 (A-237): backend/redaction.py runs Hermes's redactor so that a text cannot freeze the panel. Every invariant below is also run against variants of the module with one
defect each (every one must go red). The redactor of Hermes is a made-up `agent.redact` (a package in a temporary folder, put where `find_spec` and the child look for it):
it hangs on a text that holds HANG, masks SECRET, returns its own environment for `ENV:`, and is broken in the child when a flag file says so. The worker seam
(`set_worker_factory`) puts a stand-in in the place of the child for what is about the rules; what is about the process (the deadline, the kill, the environment, the
import, the pipes) runs the real child. The proofs against the REAL redactor, the five hostile shapes at 4 KiB, 64 KiB and 1 MiB, are the Forja's, in the harness."""
import ast
import asyncio
import contextvars
import importlib
import importlib.util
import itertools
import logging
import os
import sys
import textwrap
import threading
import time
import types
from pathlib import Path

import pytest

import backend.redaction as real

SOURCE = Path(real.__file__)
HOSTILE = 'HANG'
_n = itertools.count()
FAKE_AGENT = textwrap.dedent('''
    import os, sys, time
    from pathlib import Path
    if sys.argv[-1:] == ['--child']:
        if Path(__file__).with_name('child-broken').exists():
            raise ImportError('broken in the child')
        if Path(__file__).with_name('child-noisy').exists():
            print('a stray line on stdout', flush=True)
        if Path(__file__).with_name('child-slow').exists():
            time.sleep(2.5)
    def redact_sensitive_text(text, *, force=False, code_file=False, file_read=False, secret_file=False, redact_url_credentials=False):
        if 'HANG' in text:
            time.sleep(3600)
        if text.startswith('ENV:'):
            return ','.join(sorted(os.environ))
        if text.startswith('PATH0:'):
            return sys.path[0]
        out = text.replace('SECRET', 'SENTINEL' if file_read and secret_file else 'SE...ET')
        for patterns in _PLUGIN_PREFIX_PATTERNS.values():
            for pattern in patterns:
                out = out.replace(pattern, '[plugin]')
        return out
    _PLUGIN_PREFIX_PATTERNS = {}
    def register_redaction_patterns(patterns, source="plugin"):
        if sys.argv[-1:] == ['--child'] and Path(__file__).with_name('child-no-register').exists():
            raise RuntimeError('this child cannot register')
        _PLUGIN_PREFIX_PATTERNS.setdefault(source, []).extend(patterns)
        return len(patterns)
    def redact_registered_vault_values(text):
        return text.replace('REGISTRYVALUE', '[registered]')
''')


@pytest.fixture
def agent(tmp_path_factory, monkeypatch):
    """The made-up Hermes: its folder on the import path (and in sys.modules, over any other stand-in of `agent`), the state of the real module clean."""
    clean(real)                                                                      # no child, and no warm-up, left by an earlier test of any file
    root = tmp_path_factory.mktemp('agent')
    (root / 'agent').mkdir()
    (root / 'agent' / '__init__.py').write_text('')
    (root / 'agent' / 'redact.py').write_text(FAKE_AGENT)
    for name in [n for n in sys.modules if n == 'agent' or n.startswith('agent.')]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.syspath_prepend(str(root))
    importlib.invalidate_caches()
    yield root / 'agent'
    clean(real)
    for name in [n for n in sys.modules if n == 'agent' or n.startswith('agent.')]:
        sys.modules.pop(name, None)


def seed(m):
    """A shared budget that does not run out and does not renew, for the tests that are not about it: the callers with no budget share ONE, and a test makes several calls."""
    m._AMBIENT.update(budget=m._Budget(120.0), since=time.monotonic() + 1e6)


def settle(m, limit=30.0):
    """Wait for a warm-up thread that is still starting a child. Forgetting it is the bug: it takes the lock AFTER a clean and installs a child made under the environment of that moment, which the next test then reuses (the
    child of a test that had set HERMES_HOME answered 'LC_CTYPE,PATH,PYTHONPATH,...': found by the Maestro in the whole suite, a loaded machine; it only needs the thread to be late)."""
    end = time.monotonic() + limit
    while m._STATE.get('warming') and time.monotonic() < end:
        time.sleep(0.005)


def clean(m):
    settle(m)
    m.set_worker_factory(None)
    m._FUNCTIONS.clear()
    m._STATS['timeouts'] = 0
    m._STATE.update(down_until=0.0, warming=False)
    m._AMBIENT.update(budget=None, since=0.0)


def variant(tmp_path_factory, old, new):
    """The module with one defect, in a file of its own (its child is `python <that file> --child`)."""
    text = SOURCE.read_text()
    assert text.count(old) == 1, old
    folder = tmp_path_factory.mktemp('redactionvariant')
    (folder / 'redaction.py').write_text(text.replace(old, new))
    spec = importlib.util.spec_from_file_location(f'redaction_variant{next(_n)}', folder / 'redaction.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Worker:
    """A stand-in for the child: it writes down what it was asked and answers what `answer` says (a function of the text), or blocks for ever when `hang`."""
    def __init__(self, log, answer=lambda text: text, hang=False, fail=None):
        self.log, self.answer, self.hang, self.fail, self.killed = log, answer, hang, fail, False
        self.stop = threading.Event()

    def redact(self, text, mode, deadline_s):
        self.log.append((text, mode, deadline_s))
        if self.hang:
            self.stop.wait(30)
        if self.fail is not None:
            raise self.fail
        return self.answer(text)

    def kill(self):
        self.killed = True
        self.stop.set()


def factory_of(log, workers, **kwargs):
    def make():
        workers.append(Worker(log, **kwargs))
        return workers[-1]
    return make


def beat_during(fn):
    """(what fn returned, the longest gap of a thread that sleeps 5 ms, the same gap measured before)"""
    def gaps_of(run):
        gaps, stop = [], threading.Event()

        def beat():
            last = time.perf_counter()
            while not stop.is_set():
                time.sleep(0.005)
                now = time.perf_counter()
                gaps.append(now - last)
                last = now
        thread = threading.Thread(target=beat)
        thread.start()
        time.sleep(0.05)
        gaps.clear()
        out = run()
        stop.set()
        thread.join()
        return out, max(gaps or [0])
    _, idle = gaps_of(lambda: time.sleep(0.3))
    out, gap = gaps_of(fn)
    return out, gap, idle


def inv_a_short_text_runs_in_the_process_and_a_long_one_goes_to_the_worker(m, agent):
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers))
    assert m.isolated_redact('um SECRET curto') == 'um SE...ET curto' and not workers
    assert m.isolated_redact('a' * 250 + 'SECRET') == 'a' * 250 + 'SE...ET' and not workers                         # 256 bytes: in the process
    assert m.isolated_redact('a' * 251 + 'SECRET') == 'a' * 251 + 'SECRET' and len(log) == 1                         # 257: the worker (the stand-in answers the text as it is)
    assert m.isolated_redact('\u00e9' * 200) == '\u00e9' * 200 and len(log) == 2                                       # 200 characters, 400 bytes: bytes count


def inv_the_registry_and_the_deadline_go_with_a_long_text(m, agent):
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers))
    m.isolated_redact('x' * 300 + ' REGISTRYVALUE', 'file')
    assert log[-1][0] == 'x' * 300 + ' [registered]' and log[-1][1] == 'file'                                              # the registry of the process is applied here, before the text goes
    m.isolated_redact('x' * 100_000)
    m.isolated_redact('x' * 4_000_000)
    m.isolated_redact('x' * 300)
    assert abs(log[-3][2] - 0.4) < 0.01 and log[-2][2] == 2.5 and abs(log[-1][2] - 0.25) < 0.01, [entry[2] for entry in log]      # 0.25 s plus 1.5 us a byte, at most 2.5 s


def inv_a_deadline_kills_the_worker_and_the_answer_is_the_placeholder(m, agent, caplog):
    log, workers = [], []
    made = factory_of(log, workers, hang=True)
    m.set_worker_factory(made)
    text = 'TOPSECRET' + 'x' * 300
    with caplog.at_level(logging.WARNING, logger='luvebot.redaction'):
        started = time.perf_counter()
        (answer, gap, idle) = beat_during(lambda: m.isolated_redact(text))
        took = time.perf_counter() - started
    assert answer == m.PLACEHOLDER and 0.2 < 0.25 + 0.5 and took < 1.5, (answer, took)
    assert workers[0].killed and m.timeouts() == 1 and gap < max(0.05, 6 * idle), (gap, idle)                       # killed; counted; the others did not wait
    assert 'TOPSECRET' not in caplog.text and 'deadline' in caplog.text and '309 bytes' in caplog.text, caplog.text     # the class and the size, never the text
    workers[0].hang = False
    m.set_worker_factory(factory_of(log, workers))
    assert m.isolated_redact('y' * 300) == 'y' * 300 and workers[-1] is not workers[0]                             # the next call starts another and works
    assert m.PLACEHOLDER == chr(0xAB) + 'not shown' + chr(0xBB) and 'TOPSECRET' not in m.PLACEHOLDER


def inv_a_worker_that_returns_after_its_deadline_is_dropped_not_reused(m, agent):
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers, hang=True))
    assert m.isolated_redact('x' * 300) == m.PLACEHOLDER
    assert len(workers) == 1
    time.sleep(0.3)                                                 # the warm-up of the next one has run (the factory is called again, not the dropped worker)
    assert m.isolated_redact('x' * 300) == m.PLACEHOLDER and len(workers) == 2 and workers[0] is not workers[1]


class Ticks:
    """The clock of the module under test, moved only by the test: a hostile name costs 0.02 s of THIS clock, so the budget is spent by COUNT (15 calls of a budget of 0.3 s) whatever the load of the machine. The real clock is the wide net, never the measure."""

    def __init__(self, real_time):
        self.now, self.real = 0.0, real_time

    def perf_counter(self):
        return self.now

    monotonic = perf_counter

    def advance(self, seconds):
        self.now += seconds

    def __getattr__(self, name):
        return getattr(self.real, name)


def inv_the_budget_is_the_time_of_the_child_and_of_the_process_together(m, agent):
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers))
    calls = []
    ticks = Ticks(m.time)

    def slow(text):
        calls.append(text)
        ticks.advance(0.02)
        return text
    m._FUNCTIONS.update({'default': slow, 'file': slow})
    started = time.perf_counter()
    m.time = ticks
    try:
        with m.request_budget(0.3):
            answers = [m.isolated_redact(f'nome {i}') for i in range(100)]
            spent_calls = len(calls)
            assert m.isolated_redact('x' * 300) == m.PLACEHOLDER and not log                                       # a long text after it: the placeholder, no worker
    finally:
        m.time = ticks.real
    took = time.perf_counter() - started
    assert 14 <= spent_calls <= 16 and answers.count(m.PLACEHOLDER) == 100 - spent_calls, (spent_calls, answers.count(m.PLACEHOLDER))   # 100 hostile names cost the budget (0.3 s / 0.02 s a name), not 2 s
    assert took < 5.0, took                                                                                         # the wide net: a real clock only says the loop did not hang
    assert answers[0] == 'nome 0'
    assert m.isolated_redact('depois') == 'depois'                                                                  # outside a budget every call has its own
    with m.request_budget(5.0) as outer:
        with m.request_budget(0.01) as inner:
            assert inner is outer                                                                                   # a pass of the index refresh inside a request joins it
    seen = []
    with m.request_budget(0.0):                                                                                     # a worker thread of the request sees the same budget
        contextvars.copy_context().run(lambda: seen.append(m.isolated_redact('x')))
    assert seen == [m.PLACEHOLDER]


def inv_the_budget_caps_every_deadline(m, agent):
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers, hang=True))
    started = time.perf_counter()
    with m.request_budget(0.1):                              # less than the 0.25 s a call of this size would be given
        assert m.isolated_redact('x' * 300) == m.PLACEHOLDER
    assert time.perf_counter() - started < 0.2, time.perf_counter() - started
    started = time.perf_counter()
    with m.request_budget(0.5):
        answers = [m.isolated_redact('x' * 300) for _ in range(5)]
    assert answers == [m.PLACEHOLDER] * 5 and time.perf_counter() - started < 0.5 + 0.8, time.perf_counter() - started    # five hangs cost the budget (and the starts), not 5 x 0.25 s each
    log.clear()
    waiting = []
    holder = threading.Thread(target=lambda: contextvars.copy_context().run(lambda: _in_budget(m, 0.4)))      # one call holds the child for its whole deadline, 0.25 s ...
    holder.start()
    time.sleep(0.05)
    with m.request_budget(0.3):                                                                                # ... and this one waits for it with a budget of 0.3 s
        waiting.append(m.isolated_redact('y' * 300))
    holder.join(10)
    assert waiting == [m.PLACEHOLDER]
    assert len(log) == 1 or log[1][2] < 0.15, [entry[2] for entry in log]                                      # what it waited is taken from its deadline (0.25 s would be a second hang on top)


def _in_budget(m, seconds):
    with m.request_budget(seconds):
        m.isolated_redact('x' * 300)


def inv_a_worker_that_cannot_start_leaves_the_placeholder_and_says_so(m, agent, monkeypatch):
    starts = []

    def broken():
        starts.append(1)
        raise RuntimeError('cannot spawn')
    m.set_worker_factory(broken)
    assert m.problem() is None
    assert m.isolated_redact('x' * 300) == m.PLACEHOLDER and m.problem() == 'redactor_unavailable'
    assert m.isolated_redact('um SECRET curto') == 'um SE...ET curto'                                                 # short texts do not need it
    assert m.isolated_redact('y' * 300) == m.PLACEHOLDER and len(starts) == 1                                       # left alone for a while
    now = time.monotonic()
    monkeypatch.setattr(m.time, 'monotonic', lambda: now + m.RETRY_S + 1)
    log = []
    m.set_worker_factory(factory_of(log, []))
    assert m.isolated_redact('z' * 300) == 'z' * 300 and m.problem() is None                                       # and tried again after it
    m.set_worker_factory(lambda: (_ for _ in ()).throw(TimeoutError('not in the time it had')))
    assert m.isolated_redact('x' * 300) == m.PLACEHOLDER and m.problem() is None                                    # a start that only ran out of its time is not a broken one


def inv_a_worker_that_fails_is_the_placeholder_and_never_the_text(m, agent, caplog):
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers, fail=ValueError('TOPSECRET in the message')))
    with caplog.at_level(logging.WARNING, logger='luvebot.redaction'):
        assert m.isolated_redact('x' * 300) == m.PLACEHOLDER
    assert workers[0].killed and m.timeouts() == 0 and 'ValueError' in caplog.text and 'TOPSECRET' not in caplog.text
    m.set_worker_factory(factory_of(log, workers, answer=lambda text: 3))
    assert m.isolated_redact('x' * 300) == m.PLACEHOLDER                                                            # an answer that is not a string is no answer


def inv_the_types_and_the_modes(m, agent):
    assert m.isolated_redact(None) is None and m.isolated_redact('') == '' and m.isolated_redact(12) == '12'
    with pytest.raises(ValueError):
        m.isolated_redact('x', 'raw')
    log = []
    m.set_worker_factory(factory_of(log, []))
    assert m.isolated_redact('SECRET', 'file') == 'SENTINEL'                                                        # a mode is a mask of the redactor of this process too (A-228)


def inv_calls_are_serialized(m, agent):
    state = {'now': 0, 'most': 0}
    lock = threading.Lock()

    class Slow(Worker):
        def redact(self, text, mode, deadline_s):
            self.log.append(text)
            with lock:
                state['now'] += 1
                state['most'] = max(state['most'], state['now'])
            time.sleep(0.05)
            with lock:
                state['now'] -= 1
            return text
    log = []
    m.set_worker_factory(lambda: Slow(log))
    threads = [threading.Thread(target=lambda: m.isolated_redact('x' * 300)) for _ in range(4)]
    [t.start() for t in threads]
    [t.join(10) for t in threads]
    assert len(log) == 4 and state['most'] == 1, state                                                              # one child, one call at a time


def inv_the_real_child_redacts_in_both_modes_with_a_cut_environment(m, agent, monkeypatch):
    monkeypatch.setenv('SECRET_TEST_ENV', 'must not reach the child')
    monkeypatch.setenv('HERMES_HOME', str(agent.parent / 'home'))
    clean(m)                                                                                                        # the child below is made HERE, under this environment: none reused from an earlier test
    long = 'x' * 300 + ' SECRET REGISTRYVALUE'
    assert m.isolated_redact(long) == 'x' * 300 + ' SE...ET [registered]'
    assert m.isolated_redact(long, 'file') == 'x' * 300 + ' SENTINEL [registered]'
    names = m.isolated_redact('ENV:' + 'x' * 300).split(',') if False else None
    answer = m.isolated_redact('ENV:' + 'x' * 300)
    assert 'SECRET_TEST_ENV' not in answer and 'HOME' not in answer.split(',') and 'PATH' in answer.split(',') and 'HERMES_HOME' in answer.split(','), answer


def inv_the_real_child_that_never_returns_is_killed_on_time_and_the_next_call_works(m, agent):
    m.isolated_redact('x' * 300)                                                                                    # started and warm
    child = m._STATE['worker'].process
    answer, gap, idle = beat_during(lambda: m.isolated_redact(HOSTILE + 'x' * 300))
    assert answer == m.PLACEHOLDER and m.timeouts() == 1 and gap < max(0.05, 6 * idle), (answer, m.timeouts(), gap, idle)
    assert child.poll() is not None, 'the child that went past its deadline is still running'                       # it is dead, not forgotten
    time.sleep(1.5)
    assert m.isolated_redact('y' * 300 + ' SECRET') == 'y' * 300 + ' SE...ET'                                         # a new child, the same answer as before


def inv_a_start_that_runs_out_of_the_budget_is_cut_and_is_not_a_broken_one(m, agent):
    (agent / 'child-slow').write_text('')                                                                           # the child needs 2.5 s to import the redactor
    started = time.perf_counter()
    with m.request_budget(0.5):
        assert m.isolated_redact('x' * 300) == m.PLACEHOLDER
    assert time.perf_counter() - started < 1.5 and m.problem() is None, (time.perf_counter() - started, m.problem())     # the request did not wait for it, and it is not "unavailable"


def inv_a_child_that_cannot_import_or_that_prints_leaves_the_placeholder(m, agent):
    (agent / 'child-broken').write_text('')
    assert m.isolated_redact('x' * 300) == m.PLACEHOLDER and m.problem() == 'redactor_unavailable'
    assert m.isolated_redact('um SECRET curto') == 'um SE...ET curto'
    (agent / 'child-broken').unlink()
    clean(m)
    (agent / 'child-noisy').write_text('')                                                                          # a stray print in the child is never taken for a frame
    assert m.isolated_redact('x' * 300 + ' SECRET') == 'x' * 300 + ' SE...ET'


def inv_a_route_handler_starts_the_child_and_runs_inside_one_budget_that_it_closes(m, agent):
    seen = []

    async def handler(request):
        seen.append(m._BUDGET.get())
        if request == 'boom':
            raise RuntimeError('boom')
        return request

    def drive(coroutine):                                           # in THIS context (asyncio.run would copy it, and a budget left open would not show)
        try:
            coroutine.send(None)
        except StopIteration as stop:
            return stop.value
    assert drive(m.budgeted(handler)('answer')) == 'answer' and m._BUDGET.get() is None
    with pytest.raises(RuntimeError):
        drive(m.budgeted(handler)('boom'))
    assert len(seen) == 2 and all(budget is not None for budget in seen) and m._BUDGET.get() is None, seen
    with m.request_budget(1.0) as outer:                            # a handler inside a budget (the index refresh of a route) joins it
        drive(m.budgeted(handler)('again'))
    assert seen[-1] is outer
    waited = time.monotonic() + 6
    while m._STATE['worker'] is None and time.monotonic() < waited:
        time.sleep(0.05)
    assert m._STATE['worker'] is not None, 'a route did not start the redaction child'


def inv_the_child_is_told_what_the_plugins_registered(m, agent):
    """F-P3-2: the patterns that Hermes plugins register live in the interpreter that loaded them and the child never loads plugins, so a text of 256 bytes was masked by
    them and the same text inside a longer one was not (a company's token format masked in a title, shown in the note). The child is told before it redacts, again
    when a plugin registers later, and when it cannot be told the answer is the placeholder and never the text."""
    hermes = importlib.import_module('agent.redact')
    hermes.register_redaction_patterns(['ACME-123456'], 'redaction-pack')
    assert 'ACME-123456' not in m.isolated_redact('token ACME-123456'), 'the in-process path does not apply it either: the premise'
    assert m.isolated_redact('x ' * 200 + 'token ACME-123456').endswith('token [plugin]')
    hermes.register_redaction_patterns(['BETA-777'], 'redaction-pack')                                           # a plugin that registers while the child is up
    assert m.isolated_redact('y ' * 200 + 'BETA-777').endswith('[plugin]') and 'ACME-123456' not in m.isolated_redact('z ' * 200 + 'ACME-123456')
    clean(m)                                                                                                     # a child that cannot register (an old Hermes): fail closed
    (agent / 'child-no-register').write_text('')
    out = m.isolated_redact('w ' * 200 + 'token ACME-123456')
    assert out == m.PLACEHOLDER and 'ACME-123456' not in out, out


def inv_the_child_does_not_have_the_plugin_folder_on_its_path(m, agent):
    """F-P3-3: `python redaction.py` puts the folder of the script first on the path of the child, so a module of the plugin could shadow one of Hermes of the same name (today
    `skills`): the child runs with -P."""
    first = m.isolated_redact('PATH0:' + 'x' * 300)
    assert os.path.realpath(first) != os.path.realpath(str(Path(m.__file__).parent)), first


def inv_a_caller_with_no_budget_shares_one_and_a_stream_has_a_window_of_its_own(m, agent):
    """F-P3-1 (the frames of a stream come after the handler, outside any budget): a text with no budget open draws on ONE budget shared by those callers, renewed after
    WINDOW_S, and not on a fresh BUDGET_S each (twenty hostile frames cost twenty deadlines). A `Window` is the budget of one stream: its own though the shared one is spent,
    renewed after its own interval. Counted in calls that reach the worker, which hangs until it is killed."""
    log, workers = [], []
    m._AMBIENT.update(budget=None, since=0.0)                                                                   # this one is about the shared budget: it starts with none
    m.set_worker_factory(factory_of(log, workers, hang=True))
    kept = m.BUDGET_S, m.WINDOW_S
    m.BUDGET_S, m.WINDOW_S = 0.6, 5.0                                                                          # a shared budget that does not renew while it is being spent
    try:
        hostile = 'x' * 400
        answers = [m.isolated_redact(hostile) for _ in range(12)]
        assert set(answers) == {m.PLACEHOLDER} and len(log) <= 5, len(log)                                      # 0.6 s of deadlines of about 0.25 s: 3 reach the worker, not 12
        spent = len(log)
        m.WINDOW_S = 0.3                                                                                        # now a short window: after it, the next text finds a fresh shared budget
        time.sleep(0.4)
        m.isolated_redact(hostile)
        assert len(log) > spent, 'the shared budget is never renewed'
        m.WINDOW_S = 5.0
        while m._ambient().left() > 0:                                                                          # spend the shared one again
            m.isolated_redact(hostile)
        before = len(log)
        window = m.Window(seconds=0.6, every=0.3)
        with window.open():
            for _ in range(8):
                m.isolated_redact(hostile)
        assert 1 <= len(log) - before <= 5, (len(log) - before)                                                 # its own budget, though the shared one is spent
        time.sleep(0.4)
        before = len(log)
        with window.open():
            m.isolated_redact(hostile)
        assert len(log) > before, 'a window is never renewed'
    finally:
        m.BUDGET_S, m.WINDOW_S = kept


def inv_a_call_on_the_loop_holds_it_for_loop_s_at_most(m, agent):
    """F-P3-1: the child protects the GIL and not the loop. What a request may hold the event loop for is capped on its own (LOOP_S): the same hostile texts, in the same
    budget, reach the worker a few times when they are asked on the loop and many times when they are asked in a thread."""
    log, workers = [], []
    m.set_worker_factory(factory_of(log, workers, hang=True))

    async def on_the_loop():
        with m.request_budget(2.0):
            return [m.isolated_redact('x' * 400) for _ in range(12)]
    answers = asyncio.run(on_the_loop())
    on_loop = len(log)
    del log[:]
    with m.request_budget(2.0):
        [m.isolated_redact('x' * 400) for _ in range(12)]
    in_thread = len(log)
    assert set(answers) == {m.PLACEHOLDER} and on_loop <= 3 < 5 <= in_thread, (on_loop, in_thread)


INVARIANTS = {f.__name__[4:]: f for f in (
    inv_a_short_text_runs_in_the_process_and_a_long_one_goes_to_the_worker, inv_the_registry_and_the_deadline_go_with_a_long_text,
    inv_a_deadline_kills_the_worker_and_the_answer_is_the_placeholder, inv_a_worker_that_returns_after_its_deadline_is_dropped_not_reused,
    inv_the_budget_is_the_time_of_the_child_and_of_the_process_together, inv_the_budget_caps_every_deadline,
    inv_a_worker_that_cannot_start_leaves_the_placeholder_and_says_so, inv_a_worker_that_fails_is_the_placeholder_and_never_the_text,
    inv_the_types_and_the_modes, inv_calls_are_serialized, inv_the_real_child_redacts_in_both_modes_with_a_cut_environment,
    inv_the_real_child_that_never_returns_is_killed_on_time_and_the_next_call_works, inv_a_start_that_runs_out_of_the_budget_is_cut_and_is_not_a_broken_one,
    inv_a_child_that_cannot_import_or_that_prints_leaves_the_placeholder, inv_a_route_handler_starts_the_child_and_runs_inside_one_budget_that_it_closes,
    inv_the_child_is_told_what_the_plugins_registered, inv_the_child_does_not_have_the_plugin_folder_on_its_path,
    inv_a_caller_with_no_budget_shares_one_and_a_stream_has_a_window_of_its_own, inv_a_call_on_the_loop_holds_it_for_loop_s_at_most)}
SHORT = 'a_short_text_runs_in_the_process_and_a_long_one_goes_to_the_worker'
REGISTRY = 'the_registry_and_the_deadline_go_with_a_long_text'
KILLS = 'a_deadline_kills_the_worker_and_the_answer_is_the_placeholder'
DROPS = 'a_worker_that_returns_after_its_deadline_is_dropped_not_reused'
BUDGET = 'the_budget_is_the_time_of_the_child_and_of_the_process_together'
CAPS = 'the_budget_caps_every_deadline'
DOWN = 'a_worker_that_cannot_start_leaves_the_placeholder_and_says_so'
FAILS = 'a_worker_that_fails_is_the_placeholder_and_never_the_text'
TYPES = 'the_types_and_the_modes'
SERIAL = 'calls_are_serialized'
CHILD = 'the_real_child_redacts_in_both_modes_with_a_cut_environment'
HANGS = 'the_real_child_that_never_returns_is_killed_on_time_and_the_next_call_works'
BROKEN = 'a_child_that_cannot_import_or_that_prints_leaves_the_placeholder'
SLOW = 'a_start_that_runs_out_of_the_budget_is_cut_and_is_not_a_broken_one'
ROUTE = 'a_route_handler_starts_the_child_and_runs_inside_one_budget_that_it_closes'
TOLD = 'the_child_is_told_what_the_plugins_registered'
PATHS = 'the_child_does_not_have_the_plugin_folder_on_its_path'
SHARED = 'a_caller_with_no_budget_shares_one_and_a_stream_has_a_window_of_its_own'
LOOP = 'a_call_on_the_loop_holds_it_for_loop_s_at_most'
MUTATIONS = [
    (SHORT, 'the threshold is doubled', 'IN_PROCESS_BYTES = 256\n', 'IN_PROCESS_BYTES = 512\n'),
    (SHORT, 'the size is in characters', "size = len(text.encode('utf-8', 'surrogatepass'))", 'size = len(text)'),
    (REGISTRY, 'the registry is not applied before the text goes', 'return _isolated(_registered(text), mode, size, budget, started)', 'return _isolated(text, mode, size, budget, started)'),
    (REGISTRY, 'the deadline has no cap', 'BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-6, 2.5\n', 'BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-6, 250.0\n'),
    (REGISTRY, 'a byte costs a millisecond', 'BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-6, 2.5\n', 'BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-3, 2.5\n'),
    (KILLS, 'the deadline is ten times longer', 'BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-6, 2.5\n', 'BASE_S, PER_BYTE_S, MAX_S = 25.0, 1.5e-6, 250.0\n'),
    (KILLS, 'the text comes back after the deadline', "            warm()                                          # the next child starts now, off the path of the next request\n            return PLACEHOLDER\n",
     "            warm()                                          # the next child starts now, off the path of the next request\n            return text\n"),
    (KILLS, 'the worker is not killed', "            _drop(worker)\n            _STATE['worker'] = None\n            warm()", "            _STATE['worker'] = None\n            warm()"),
    (KILLS, 'the deadline is not counted', "_STATS['timeouts'] += 1 if deadline_passed else 0", "_STATS['timeouts'] += 0"),
    (KILLS, 'the log carries the text', "_log.warning('redaction worker dropped: %s (%s, %d bytes)', 'deadline' if deadline_passed else type(box.get('error')).__name__, mode, size)",
     "_log.warning('redaction worker dropped: %s (%s, %d bytes) %s', 'deadline' if deadline_passed else type(box.get('error')).__name__, mode, size, text)"),
    (DROPS, 'a dropped worker stays', "            _STATE['worker'] = None\n            warm()", "            warm()"),
    (BUDGET, 'a spent budget still lets the short ones in', "    if budget.left() <= 0:\n        return PLACEHOLDER\n    started", "    if False:\n        return PLACEHOLDER\n    started"),
    (BUDGET, 'the time is not charged', "        budget.charge(time.perf_counter() - started)", "        pass"),
    (BUDGET, 'a budget inside a budget is a new one', "    if current is not None:\n        yield current\n        return\n", ""),
    (CAPS, 'the deadline is not capped by what is left', 'return min(MAX_S, BASE_S + PER_BYTE_S * size, _left(budget, since))', 'return min(MAX_S, BASE_S + PER_BYTE_S * size)'),
    (CAPS, 'the time already spent is not taken from what is left', 'return budget.left() - (time.perf_counter() - since)', 'return budget.left()'),
    (SLOW, 'the start of a worker is not limited by the budget', "worker = _STATE['worker'] or _start(_left(budget, since))", "worker = _STATE['worker'] or _start()"),
    (SLOW, 'a start that ran out of time is a broken one', "    except TimeoutError:\n        return None\n    except Exception as error:", "    except Exception as error:"),
    (DOWN, 'a failed start is not remembered', "_STATE['down_until'] = time.monotonic() + RETRY_S", "_STATE['down_until'] = 0.0"),
    (DOWN, 'a failed start is tried again at once', "    if time.monotonic() < _STATE['down_until'] or _deadline(size, budget, since) <= 0:", "    if _deadline(size, budget, since) <= 0:"),
    (DOWN, 'a start that ran out of time is a broken one', "    except TimeoutError:\n        return None\n    except Exception as error:", "    except Exception as error:"),
    (DOWN, 'the problem is never said', "    return 'redactor_unavailable' if time.monotonic() < _STATE['down_until'] else None", "    return None"),
    (FAILS, 'an error of the worker is a deadline', "            deadline_passed = thread.is_alive()", "            deadline_passed = True"),
    (FAILS, 'an answer that is not a string is taken', " or not isinstance(box.get('out'), str):", ":"),
    (TYPES, 'any mode is taken', "    if mode not in MODES:\n        raise ValueError('unknown redaction mode')\n", ""),
    (TYPES, 'None is read as a string', "    if text is None:\n        return None\n", ""),
    (SERIAL, 'the calls are not serialized', '\n_LOCK = threading.Lock()\n', "\n_LOCK = type('L', (), {'acquire': lambda self, timeout=None: True, 'release': lambda self: None, '__enter__': lambda self: self, '__exit__': lambda self, *a: None})()\n"),
    (CHILD, 'the child gets the whole environment', "        env = {name: os.environ[name] for name in ('HERMES_HOME', 'PATH') if name in os.environ}\n", "        env = dict(os.environ)\n"),
    (CHILD, 'the child masks the file mode as the default one', "1: masking(redact_sensitive_text)}", "1: (lambda text: redact_sensitive_text(text, force=True))}"),
    (HANGS, 'the child that went past its deadline is left running', "        try:\n            self.process.terminate()\n            self.process.wait(timeout=2)\n        except Exception:  # noqa: BLE001\n            self.process.kill()\n", "        pass\n"),
    (BROKEN, 'a child that cannot import says it started', "        pipe_out.write(struct.pack('>BI', 2, 0))", "        pipe_out.write(struct.pack('>BI', 0, 0))"),
    (BROKEN, 'a stray print can be taken for a frame', "    sys.stdout = open(os.devnull, 'w')                       # a stray print can never be taken for a frame\n", ""),
    (ROUTE, 'a route has no budget', "        with request_budget():\n            return await handler(request)\n", "        return await handler(request)\n"),
    (ROUTE, 'a route does not start the child', "        warm()\n        with request_budget():\n", "        with request_budget():\n"),
    (ROUTE, 'a route leaves its budget open', "        with request_budget():\n            return await handler(request)\n", "        request_budget().__enter__()\n        return await handler(request)\n"),
    (TOLD, 'the child is not told', "        if patterns != self.patterns:", "        if False:"),
    (TOLD, 'a registration after the first is not sent', "        if patterns != self.patterns:", "        if patterns != self.patterns and self.patterns == '{}':"),
    (TOLD, 'a child that cannot register is taken as told', "            self._ask(_PATTERNS, patterns)\n", "            try:\n                self._ask(_PATTERNS, patterns)\n            except RuntimeError:\n                pass\n"),
    (TOLD, 'the registry of the plugins is not read', "        registry = getattr(module, '_PLUGIN_PREFIX_PATTERNS', None)", "        registry = None"),
    (PATHS, 'the child has the folder of the script on its path', "[sys.executable, '-P', str(Path(__file__).resolve()), '--child']", "[sys.executable, str(Path(__file__).resolve()), '--child']"),
    (SHARED, 'every text with no budget gets a fresh one', "budget = _BUDGET.get() or _ambient()", "budget = _BUDGET.get() or _Budget(BUDGET_S)"),
    (SHARED, 'the shared budget is never renewed', "if _AMBIENT['budget'] is None or now - _AMBIENT['since'] > WINDOW_S:", "if _AMBIENT['budget'] is None:"),
    (SHARED, 'a window is the shared budget', "self._budget, self._since = _Budget(self._seconds), now", "self._budget, self._since = _ambient(), now"),
    (SHARED, 'a window is never renewed', "if self._budget is None or now - self._since > self._every:", "if self._budget is None:"),
    (LOOP, 'the loop is not capped', "    if _on_loop():\n        budget = _LoopView(budget)\n", ""),
    (LOOP, 'the cap of the loop is the whole budget', "LOOP_S = 0.5 ", "LOOP_S = 500.0 "),
    (LOOP, 'the time on the loop is not charged to the loop', "        self.budget.charge(seconds, loop=True)", "        self.budget.charge(seconds)"),
]


def test_every_invariant_has_a_mutation():
    assert {row[0] for row in MUTATIONS} == {name.removeprefix('inv_') for name in (f.__name__ for f in INVARIANTS.values())}


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name, agent, caplog, monkeypatch):
    seed(real)
    INVARIANTS[name](real, *argument_list(INVARIANTS[name], agent, caplog, monkeypatch))


class Late(threading.Thread):
    """The scheduler of a loaded machine: the warm-up thread gets the CPU a few milliseconds after it was started."""
    def run(self):
        if self.name == 'luvebot-redaction-warm':
            time.sleep(0.005)
        super().run()


def blind_clean(m):
    """What `clean` was: it forgot the warm-up (and set its flag to False over it)."""
    m.set_worker_factory(None)
    m._STATE.update(down_until=0.0, warming=False)


@pytest.mark.parametrize('cleaner,leaks', [(clean, False), (blind_clean, True)], ids=['clean waits for the warm-up', 'a clean that forgets it leaks a child into the next test'])
def test_a_warm_up_in_flight_when_a_test_ends_does_not_leave_a_child_for_the_next_one(agent, monkeypatch, cleaner, leaks):
    seed(real)
    monkeypatch.setattr(real, 'threading', types.SimpleNamespace(Thread=Late, Lock=threading.Lock, current_thread=threading.current_thread))
    found = []
    for _ in range(3):
        monkeypatch.delenv('HERMES_HOME', raising=False)
        real.warm()                                                                                                 # a kill or a route did this just before the test ended
        cleaner(real)
        time.sleep(0.05)                                                                                            # the fixtures of the next test
        monkeypatch.setenv('HERMES_HOME', str(agent.parent / 'home'))
        found.append('HERMES_HOME' in real.isolated_redact('ENV:' + 'x' * 300).split(','))
        clean(real)
    assert (not all(found)) if leaks else all(found), found


def argument_list(fn, agent, caplog, monkeypatch):
    names = fn.__code__.co_varnames[1:fn.__code__.co_argcount]
    return [{'agent': agent, 'caplog': caplog, 'monkeypatch': monkeypatch}[n] for n in names]


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i[:24]}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(invariant, label, old, new, agent, caplog, monkeypatch, tmp_path_factory):
    module = variant(tmp_path_factory, old, new)                    # outside pytest.raises: a mutation that does not apply is an error
    seed(module)
    fn = INVARIANTS[invariant]
    try:
        with pytest.raises((AssertionError, TypeError, KeyError, AttributeError, ValueError)):
            fn(module, *argument_list(fn, agent, caplog, monkeypatch))
    finally:
        clean(module)


def test_the_redactor_of_hermes_is_not_called_from_anywhere_else():
    root = SOURCE.parent
    callers = sorted(p.name for p in root.glob('*.py') if p.name != 'redaction.py' and 'redact_sensitive_text' in p.read_text(encoding='utf-8'))
    assert callers == []


THREAD_CLAUSES = {'call': 'BaseException', 'warm_up': 'BaseException', 'ready': 'Exception'}


def thread_problems(text):
    """The module starts three threads and the sweep of test_config_boundary_threads.py lets them through BY NAME (each guards itself): this reads what the names stand for.
    Every `threading.Thread` of the module runs one of the three, and each of the three has a `try` whose handler names the class a thread of ours must not die of."""
    tree = ast.parse(text)
    problems = []
    targets = [ast.unparse(next((k.value for k in n.keywords if k.arg == 'target'), None) or ast.Constant(None)) for n in ast.walk(tree)
               if isinstance(n, ast.Call) and ast.unparse(n.func) == 'threading.Thread']
    if sorted(targets) != sorted(THREAD_CLAUSES):
        problems.append(f'the threads run {sorted(targets)}, not {sorted(THREAD_CLAUSES)}')
    for name, clause in THREAD_CLAUSES.items():
        functions = [n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name]
        if len(functions) != 1 or not any(isinstance(t, ast.Try) and any(h.type is not None and ast.unparse(h.type) == clause for h in t.handlers)
                                          for t in ast.walk(functions[0])):
            problems.append(f'{name} has no `except {clause}`')
    return problems


THREAD_DEFECTS = [
    ('the call thread catches less', "            except BaseException as error:  # noqa: BLE001  (the class is logged below", "            except Exception as error:  # noqa: BLE001  (the class is logged below"),
    ('the warm-up thread can die loudly', "        except BaseException as error:  # noqa: BLE001  (a thread of ours never dies loudly: the next request starts the child again)\n            _log.warning('redaction warm-up failed (%s)', type(error).__name__)\n", ""),
    ('the start-up reader catches another class', "            except Exception:  # noqa: BLE001\n                box['status'] = -1", "            except KeyError:  # noqa: BLE001\n                box['status'] = -1"),
    ('a thread nobody allowed', "    _STATE['warming'] = True\n", "    _STATE['warming'] = True\n    threading.Thread(target=print).start()\n"),
]


def test_the_three_threads_of_the_module_guard_themselves():
    assert thread_problems(SOURCE.read_text()) == []


@pytest.mark.parametrize('label,old,new', THREAD_DEFECTS, ids=[d[0] for d in THREAD_DEFECTS])
def test_each_defect_in_a_thread_clause_is_caught(label, old, new):
    text = SOURCE.read_text()
    assert text.count(old) == 1, old
    assert thread_problems(text.replace(old, new)), label
