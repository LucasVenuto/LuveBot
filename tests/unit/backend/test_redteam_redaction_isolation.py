"""Red team (Lume, 31/10) of P-3 / A-237: `backend/redaction.py`, Hermes's redactor run in a child process with a deadline and a budget per request.
Two kinds of double: a WORKER stand-in (`set_worker_factory`, the seam the module gives: instant, deterministic, it can block until it is killed) for the clock (deadline, budget, kill, who waits for whom); and a stand-in
for HERMES itself (a package `agent.redact` written in a temporary folder and put on the path) so that the REAL child runs: a real process, real pipes, a real kill, the real environment it is given.
HELD (plain tests): a call that passes its deadline answers the fixed placeholder at the deadline and the next call works; 200 hostile lines of 512 characters in one request cost the budget and not 200 times the work, the rest
  is the placeholder and never the text; the same for 200 pages of 16 KiB; the short calls are charged to the same budget; the real child gets an environment cut to HERMES_HOME, PATH and PYTHONPATH and runs in the
  temporary folder; it is killed (not left behind) when it passes its deadline or allocates; a lone surrogate, a NUL and one line of 1 MiB cross the pipe whole; a worker that fails never puts the text in a log; one
  hostile reader that keeps asking does not make everybody else's long texts the placeholder (25 of 25 are redacted, with a child that takes 0 or 0.4 s to start): the lock hands over and a waiter waits up to what is left
  of its own budget; it costs the others LATENCY (a call waits for the hostile one's deadline, up to about 1 s), the class of R-14, bounded by the budget of 3 s.
OPEN (`xfail(strict=True, raises=AssertionError)`):
  F-P3-1 (Alta, for the panel) nothing of what runs on the EVENT LOOP is protected: 9 handlers of plugin_api.py call the redactor from `async def` without a thread, and the frames of an SSE stream come after the handler
     returned, so outside any budget: each hostile frame blocks the loop for its whole deadline (0.26 s for 4 KiB) and 20 of them cost 5 s, a stream of them keeps the loop at 100% (the dashboard's other requests wait);
  F-P3-2 (Alta) the child does not have what the parent has: the patterns that Hermes PLUGINS register (`register_redaction_patterns`, the "redaction pack") live in a module-level registry of the interpreter, so a
     text of at most 256 bytes is masked by them and the same text inside a longer one is NOT (a company token format masked in a title, shown in the note);
  F-P3-3 (Info) the child runs `python backend/redaction.py`: the directory of the script is the first entry of its `sys.path`, so a module of the plugin shadows a module of Hermes or of the standard library of the same
     name (today only `skills` is a name that Hermes also has; none is imported by the redactor): `-P` (Python 3.11+) closes it."""
import ast
import importlib
import logging
import os
import sys
import tempfile
import textwrap
import threading
import time
from pathlib import Path

import pytest

import backend.redaction as redaction

ROOT = Path(__file__).resolve().parents[3]
KEY = 'sk-' + 'a1b2c3d4e5f6' * 2 + 'ZqXw'
SENTINEL = chr(0xAB) + 'redacted' + chr(0xBB)

STUB = textwrap.dedent('''
    import os, re, sys, time
    _PLUGIN_PREFIX_PATTERNS = {}
    def register_redaction_patterns(patterns, source='plugin'):
        _PLUGIN_PREFIX_PATTERNS.setdefault(source, []).extend(patterns)
        return len(patterns)
    def redact_registered_vault_values(text):
        return text
    _KEY = re.compile(r"(?<![A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{10,})(?![A-Za-z0-9_-])")
    def redact_sensitive_text(text, *, force=False, code_file=False, file_read=False, secret_file=False, redact_url_credentials=False):
        if text.startswith('PROBE-ENV'):
            return repr(sorted(os.environ)) + '|' + os.getcwd() + '|' + sys.path[0] + '|' + str(os.getpid())
        if text.startswith('HOG'):
            blocks = []
            while len(blocks) < 40:
                blocks.append(bytearray(10_000_000))
                time.sleep(0.01)
            time.sleep(60)
        if text.startswith('HANG'):
            time.sleep(60)
        if text.startswith('SLOW'):
            time.sleep(0.005)
        out = _KEY.sub('\\u00abredacted\\u00bb', text)
        for patterns in _PLUGIN_PREFIX_PATTERNS.values():
            for pattern in patterns:
                out = re.sub(pattern, '\\u00abplugin\\u00bb', out)
        return out
''')


def settle(limit=30.0):
    """A warm-up thread still starting a child would install it after the reset below and the next test would reuse a child made under another environment (see `settle` in test_redaction.py)."""
    end = time.monotonic() + limit
    while redaction._STATE.get('warming') and time.monotonic() < end:
        time.sleep(0.005)


@pytest.fixture
def hermes(tmp_path, monkeypatch):
    """A stand-in for Hermes (`agent.redact`) on the path of this process AND of the real child (the child gets the parent of the package from `find_spec`)."""
    package = tmp_path / 'hermes_stand_in' / 'agent'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    (package / 'redact.py').write_text(STUB)
    for name in [n for n in sys.modules if n == 'agent' or n.startswith('agent.')]:
        monkeypatch.delitem(sys.modules, name)
    monkeypatch.syspath_prepend(str(tmp_path / 'hermes_stand_in'))
    importlib.invalidate_caches()
    redaction._FUNCTIONS.clear()
    settle()
    redaction.set_worker_factory(None)
    redaction._STATE['warming'] = False
    redaction._AMBIENT.update(budget=None, since=0.0)                                                       # the shared budget of the callers with no budget is a window of 10 s: a test starts with none, or it runs in what an earlier one left
    yield tmp_path / 'hermes_stand_in'
    settle()
    redaction.set_worker_factory(None)
    redaction._AMBIENT.update(budget=None, since=0.0)
    redaction._FUNCTIONS.clear()
    time.sleep(0.05)


class Worker:
    """A worker stand-in: `delay` seconds per long text, a text that starts with HOSTILE blocks until the worker is killed (a regex that holds the process)."""
    def __init__(self, delay=0.0):
        self.delay, self.stopped, self.calls = delay, threading.Event(), 0

    def redact(self, text, mode, deadline_s):
        self.calls += 1
        if text.startswith('HOSTILE'):
            self.stopped.wait(60)
            raise RuntimeError('killed')
        time.sleep(self.delay)
        return text.replace(KEY, SENTINEL)

    def kill(self):
        self.stopped.set()


def with_workers(**kwargs):
    made = []

    def factory():
        made.append(Worker(**kwargs))
        return made[-1]
    redaction.set_worker_factory(factory)
    return made


def hostile(size, with_key=False):
    return 'HOSTILE ' + (KEY + ' ' if with_key else '') + 'a.token' * (size // 7)


# ---- the deadline and the kill (HELD) ------------------------------------------------------------------------------------------------------------------------------------------------------
def test_a_call_that_passes_its_deadline_answers_the_placeholder_at_the_deadline_and_the_next_call_works(hermes):
    made = with_workers()
    before = redaction.timeouts()
    text = hostile(1024)
    started = time.perf_counter()
    assert redaction.isolated_redact(text) == redaction.PLACEHOLDER
    took = time.perf_counter() - started
    assert redaction.BASE_S - 0.05 <= took <= redaction.BASE_S + redaction.PER_BYTE_S * 1100 + 0.4, took      # the deadline of that size, not the minute the text asked for
    assert redaction.timeouts() == before + 1 and made[0].stopped.is_set()                                  # the worker was killed
    assert redaction.isolated_redact('b ' * 200 + KEY) == ('b ' * 200 + SENTINEL)                           # the next call starts a new one and works
    assert len(made) == 2


def test_a_worker_that_fails_never_puts_the_text_in_a_log(hermes, caplog):
    class Failing(Worker):
        def redact(self, text, mode, deadline_s):
            raise RuntimeError('the text was ' + text[:40])
    redaction.set_worker_factory(Failing)
    with caplog.at_level(logging.DEBUG, logger='luvebot.redaction'):
        assert redaction.isolated_redact('x ' * 200 + KEY) == redaction.PLACEHOLDER
    assert KEY not in caplog.text and 'the text was' not in caplog.text and 'RuntimeError' in caplog.text      # the class, never the message


# ---- the budget of a request (HELD) --------------------------------------------------------------------------------------------------------------------------------------------------------
def test_200_hostile_lines_of_512_characters_in_one_request_cost_the_budget_and_the_rest_is_the_placeholder_never_the_text(hermes):
    with_workers(delay=0.03)                                                                                 # a hostile 512 characters costs about 30 ms in Hermes (measured: 22 to 58)
    lines = [f'{KEY} linha {i} ' + 'a.token' * 70 for i in range(200)]
    shown = []
    started = time.perf_counter()
    with redaction.request_budget():
        for line in lines:
            shown.append(redaction.isolated_redact(line, 'file'))
    took = time.perf_counter() - started
    assert took < redaction.BUDGET_S + 0.6, took                                                             # the budget, not 200 x 30 ms = 6 s
    placeholders = [s for s in shown if s == redaction.PLACEHOLDER]
    assert 60 <= len(placeholders) < 200 and shown[0] != redaction.PLACEHOLDER and shown[-1] == redaction.PLACEHOLDER
    assert all(KEY not in s for s in shown)                                                                  # never the key
    assert all(s != line for s, line in zip(shown, lines))                                                   # never the text as it came (a row equal to its input is a row that was not redacted)


def test_the_short_calls_are_charged_to_the_same_budget(hermes):
    with_workers()
    started = time.perf_counter()
    shown = []
    with redaction.request_budget(0.5):
        while time.perf_counter() - started < 1.5 and len(shown) < 1000:
            shown.append(redaction.isolated_redact('SLOW ' + KEY))                                           # 5 ms each, in this process
    assert redaction.PLACEHOLDER in shown and shown[0] == 'SLOW ' + SENTINEL
    assert time.perf_counter() - started < 0.5 + 0.3, 'the short calls kept going after the budget was spent'
    assert redaction.isolated_redact('SLOW ' + KEY) != redaction.PLACEHOLDER                                 # outside a budget (a new request) it works again


def test_a_page_list_of_200_hostile_pages_costs_the_budget_and_no_page_shows_the_key(hermes):
    import backend.pages as pages
    with_workers(delay=0.1)
    stat = type('S', (), {'st_size': 16384, 'st_mtime': 0})()
    redact = lambda text: redaction.isolated_redact(text)
    excerpts, started = [], time.perf_counter()
    with redaction.request_budget():
        for i in range(200):
            body = f'chave: {KEY}\n pagina {i} ' + 'a.token' * 2300
            view = pages.page_view(f'p{i}', body.encode(), stat, None, ('a', 'b'), redact)
            excerpts.append((view['excerpt'], view['title']))
    assert time.perf_counter() - started < redaction.BUDGET_S + 0.8
    assert sum(1 for e, _t in excerpts if e == redaction.PLACEHOLDER) >= 150
    assert all(KEY not in e and KEY not in t for e, t in excerpts)


# ---- the loop (OPEN) and the hostile reader (HELD) ------------------------------------------------------------------------------------------------------------------------------------------
def test_no_handler_of_the_plugin_calls_the_redactor_on_the_event_loop():
    tree = ast.parse((ROOT / 'dashboard' / 'plugin_api.py').read_text())
    on_the_loop = []
    for function in ast.walk(tree):
        if isinstance(function, ast.AsyncFunctionDef):
            for node in ast.walk(function):
                if isinstance(node, ast.Call):
                    callee = node.func.id if isinstance(node.func, ast.Name) else (node.func.attr if isinstance(node.func, ast.Attribute) else '')
                    passes = any(isinstance(a, ast.Name) and a.id in ('_REDACT',) for a in node.args)
                    if (callee in ('_REDACT',) or passes) and callee not in ('run_in_threadpool', 'start_watcher'):   # start_watcher keeps it for a thread of its own
                        on_the_loop.append((function.name, node.lineno))
    assert on_the_loop == [], on_the_loop


def test_twenty_hostile_frames_of_a_stream_cost_one_budget_and_not_twenty_deadlines(hermes):
    with_workers()
    started = time.perf_counter()
    shown = [redaction.isolated_redact(hostile(4096, with_key=True)) for _ in range(20)]                    # what `_relay` does for each frame, outside any request_budget
    assert time.perf_counter() - started < redaction.BUDGET_S + 0.5, f'{time.perf_counter() - started:.1f} s on the loop for 20 frames'
    assert all(KEY not in s for s in shown)


@pytest.mark.parametrize('start', [0.0, 0.4])
def test_one_hostile_reader_does_not_make_everybody_elses_long_text_the_placeholder(hermes, start):
    made = []

    def factory():
        time.sleep(start)                                                                                   # a real child needs 0.2 to 1 s to start and import the redactor
        made.append(Worker())
        return made[-1]
    redaction.set_worker_factory(factory)
    stop = threading.Event()

    def attacker():
        while not stop.is_set():
            with redaction.request_budget():
                redaction.isolated_redact(hostile(2048))
    thread = threading.Thread(target=attacker, daemon=True)
    thread.start()
    try:
        results = []
        for _ in range(25):
            time.sleep(0.15)
            with redaction.request_budget():
                results.append(redaction.isolated_redact('benign ' * 100 + KEY))
    finally:
        stop.set()
        thread.join(5)
    real = sum(1 for r in results if r != redaction.PLACEHOLDER)
    assert real >= 22, f'{real} of 25 benign long texts were redacted while one reader kept sending a hostile one'


# ---- the REAL child (HELD, F-P3-2 and F-P3-3 OPEN) -----------------------------------------------------------------------------------------------------------------------------------------
def real_call(text, mode='default'):
    with redaction.request_budget():
        return redaction.isolated_redact(text, mode)


def test_the_real_child_redacts_a_long_text_a_lone_surrogate_a_nul_and_one_line_of_1_mib_whole(hermes):
    long = 'x ' * 300 + KEY + ' fim'
    assert real_call(long) == 'x ' * 300 + SENTINEL + ' fim'
    odd = '\ud800' + 'a' * 300 + '\x00 ' + KEY
    assert real_call(odd) == '\ud800' + 'a' * 300 + '\x00 ' + SENTINEL                                       # the surrogate and the NUL cross the pipe
    big = 'a' * (1024 * 1024) + ' ' + KEY
    got = real_call(big)
    assert got != redaction.PLACEHOLDER and got.endswith(' ' + SENTINEL) and len(got) == len(big) - len(KEY) + len(SENTINEL)


def test_the_real_child_gets_nothing_of_the_environment_but_three_names_and_runs_in_the_temporary_folder(hermes, monkeypatch):
    monkeypatch.setenv('LUVEBOT_CANARY_TOKEN', 'x'), monkeypatch.setenv('OPENAI_API_KEY', 'y'), monkeypatch.setenv('SSH_AUTH_SOCK', 'z'), monkeypatch.setenv('HERMES_HOME', str(hermes))
    names, cwd, first, pid = real_call('PROBE-ENV ' + 'x' * 300).split('|')
    names = eval(names)                                                                                       # a list of strings the stand-in just wrote
    assert not {'LUVEBOT_CANARY_TOKEN', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'HOME', 'USER'} & set(names), names
    assert {'HERMES_HOME', 'PATH', 'PYTHONPATH'} <= set(names)
    assert os.path.realpath(cwd) == os.path.realpath(tempfile.gettempdir()) and int(pid) != os.getpid()


def test_the_directory_of_the_plugin_is_not_on_the_path_of_the_child(hermes):
    first = real_call('PROBE-ENV ' + 'x' * 300).split('|')[2]
    assert os.path.realpath(first) != os.path.realpath(ROOT / 'backend')


def test_a_pattern_a_plugin_registered_masks_a_long_text_as_it_masks_a_short_one(hermes):
    from agent.redact import register_redaction_patterns                                                      # the stand-in's, in THIS process (the child imports its own)
    register_redaction_patterns([r'ACME-[0-9]{6}'], 'redaction-pack')
    short = real_call('token ACME-123456')
    assert 'ACME-123456' not in short, 'the in-process path does not apply it either: the premise of the test'
    long = real_call('x ' * 300 + 'token ACME-123456')
    assert 'ACME-123456' not in long, 'masked in a short text, shown in a long one'


@pytest.mark.parametrize('what', ['HOG', 'HANG'])
def test_the_real_child_that_allocates_or_hangs_is_killed_at_the_deadline_and_not_left_behind(hermes, what):
    first = real_call('PROBE-ENV ' + 'x' * 300)
    old = int(first.split('|')[3])
    started = time.perf_counter()
    assert real_call(what + ' ' + 'x' * 300) == redaction.PLACEHOLDER
    assert time.perf_counter() - started < redaction.BASE_S + 0.2 + 0.4
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            os.kill(old, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        raise AssertionError(f'the child {old} is still alive after the kill')
    again = real_call('PROBE-ENV ' + 'y' * 300).split('|')
    assert int(again[3]) != old                                                                               # a new child, and it works
