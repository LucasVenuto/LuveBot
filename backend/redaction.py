"""P-3 (A-237): Hermes's redactor, run so that a text cannot freeze the panel. The ONLY caller of `redact_sensitive_text` for text an author wrote.

Why: the redactor of Hermes v0.22.5 has patterns that are quadratic or cubic in the text (a repeated `-----BEGIN PRIVATE KEY-----`; `a.token` repeated
then ` k=v`: 2 KiB take 2 s, 4 KiB over 15 s; a few assignment forms), each with its own formula, and `re` holds the GIL: a gate by formula is a fast path
at best. The one defence that does not depend on what is inside the redactor is a DEADLINE on a process that can be killed (and nothing of ours reimplements
the redactor: what is masked is what Hermes masks).

* A text of at most IN_PROCESS_BYTES runs in this process (the worst shape of that size costs 3 to 7 ms).
* A longer one goes to ONE persistent child (spawn, pipes, no port, an environment cut to HERMES_HOME, PATH and PYTHONPATH) that imports `agent.redact`
  once. Calls are serialized by a lock. The registry of registered values (per process) is applied HERE, before the text goes, so the child loses nothing.
* A call has a deadline, BASE_S + PER_BYTE_S per byte, at most MAX_S, and never more than what is left of the budget of the request. When it passes the
  child is killed, the next call starts another, and the answer is PLACEHOLDER: a fixed string, nothing of the text.
* A request has a budget, BUDGET_S of time, the child's AND this process's together (the short calls are timed too): once it is spent every further
  text of the request, the short ones included, is PLACEHOLDER at once and nothing is called. `request_budget()` is opened once by the route and once by
  a pass of an index refresh. A call made ON the event loop also draws on a smaller one, LOOP_S per request: the loop is what every
  other request of the panel waits for (the child protects the GIL, not the loop), so what a request may hold it for is capped on its own.
* A caller with no budget open (a frame of a stream, a thread of ours) draws on ONE budget shared by all of them and renewed every WINDOW_S: not on a fresh
  BUDGET_S per text, which made twenty hostile frames cost twenty deadlines. A stream has a `Window` of its own, so a hostile stream does not spend the
  budget of the others.
* The child is told what the plugins of Hermes registered with the redactor in THIS process (`register_redaction_patterns` fills a dict of the interpreter
  that loaded the plugin, and the child never loads plugins): before a text goes, if that registry changed since the child was told, the child gets it.
* A child that cannot start (or import `agent.redact`) leaves PLACEHOLDER for every text over the threshold for RETRY_S, and `problem()` says so.

`set_worker_factory` is the seam of the tests: a factory returns an object with `redact(text, mode, deadline_s)` and optionally `kill()`; None gives the real one back."""
import asyncio
import contextlib
import contextvars
import importlib.util
import inspect
import json
import logging
import os
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

PLACEHOLDER = chr(0xAB) + 'not shown' + chr(0xBB)          # fixed: nothing of the text
IN_PROCESS_BYTES = 256
BASE_S, PER_BYTE_S, MAX_S = 0.25, 1.5e-6, 2.5
BUDGET_S = 3.0
LOOP_S = 0.5                                               # of the budget, what a request may hold the event loop for
WINDOW_S = 10.0                                            # how long a shared or a stream budget lasts before it is renewed
START_S, RETRY_S = 10.0, 30.0                              # time to start and import in the child; how long to leave it alone after it failed
MESSAGE = 'The check that hides secrets is not available right now.'
MODES = ('default', 'file')
_CODES = {'default': 0, 'file': 1}
_PATTERNS = 2                                              # the code of the frame that carries the registry of the plugins' patterns
_BUDGET = contextvars.ContextVar('luvebot_redaction_budget', default=None)
_STATS = {'timeouts': 0}
_STATE = {'worker': None, 'down_until': 0.0, 'factory': None}
_LOCK = threading.Lock()
_AMBIENT = {'budget': None, 'since': 0.0}
_AMBIENT_LOCK = threading.Lock()
_FUNCTIONS = {}
_log = logging.getLogger('luvebot.redaction')


def masking(redact_sensitive_text):
    """A-228: Hermes's redactor as it must be for text that is file content (a note's). Its default mask keeps 6 characters at the head and 4 at the
    tail of a credential (a photo showed `sk-q7Z...4Uo2` under a line that said the secrets were hidden). `file_read=True` makes a credential with a known
    prefix a sentinel with no head and no tail, and `secret_file=True` keeps the assignment passes that `file_read` alone would skip (it implies `code_file`),
    masking them the same way. The signature is read ONCE, here. A Hermes that does not take BOTH words gets `force=True` alone: v0.20.5 has `file_read` and not
    `secret_file`, and there `file_read` alone skips the assignment passes, which leaves `KEY=value` raw, worse than the default mask. What reaches a person is
    never the raw text: no function, no redactor; an error of the redactor is not caught here."""
    if not callable(redact_sensitive_text):
        raise TypeError('the redactor must be a function')
    try:
        words = inspect.signature(redact_sensitive_text).parameters
    except (TypeError, ValueError):
        words = ()
    if 'file_read' in words and 'secret_file' in words:
        return lambda text: redact_sensitive_text(text, force=True, file_read=True, secret_file=True)
    return lambda text: redact_sensitive_text(text, force=True)


def _functions():
    """{mode: function} over the redactor of THIS process (the child builds the same two over its own), built once."""
    if not _FUNCTIONS:
        from agent.redact import redact_sensitive_text
        _FUNCTIONS.update({'default': lambda text: redact_sensitive_text(text, force=True), 'file': masking(redact_sensitive_text)})
    return _FUNCTIONS


def _registered(text):
    """The registry of registered values (a dict per process in Hermes): applied in this process before the text goes to the child, which is born with it empty.
    A linear pass of exact substrings, no regex. A Hermes without the function has no registry."""
    try:
        from agent.redact import redact_registered_vault_values
    except ImportError:
        return text
    return redact_registered_vault_values(text)


def _plugin_patterns():
    """{source: [regex]} that the plugins of Hermes registered with the redactor in THIS process (`agent.redact._PLUGIN_PREFIX_PATTERNS`, filled by
    `register_redaction_patterns`): the interpreter that loaded the plugins holds them, and the child is another one. {} for a Hermes without the registry."""
    try:
        import agent.redact as module
        registry = getattr(module, '_PLUGIN_PREFIX_PATTERNS', None)
        if not isinstance(registry, dict):
            return {}
        return {str(source): [pattern for pattern in list(patterns) if isinstance(pattern, str)] for source, patterns in list(registry.items())}
    except Exception:  # noqa: BLE001
        return {}


class _Budget:
    def __init__(self, seconds, loop_seconds=LOOP_S):
        self.seconds, self.spent, self._lock = seconds, 0.0, threading.Lock()
        self.loop_seconds, self.loop_spent = loop_seconds, 0.0

    def left(self):
        return self.seconds - self.spent

    def charge(self, seconds, loop=False):
        with self._lock:
            self.spent += seconds
            if loop:
                self.loop_spent += seconds


class _LoopView:
    """The same budget as seen by a call made ON the event loop: what is left is the smaller of the budget and of the time the loop may still be held (LOOP_S),
    and what the call costs is charged to both."""
    def __init__(self, budget):
        self.budget = budget

    def left(self):
        return min(self.budget.left(), self.budget.loop_seconds - self.budget.loop_spent)

    def charge(self, seconds):
        self.budget.charge(seconds, loop=True)


def _on_loop():
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _ambient():
    """The budget of a caller that opened none: ONE, shared, renewed when WINDOW_S has passed since it began."""
    now = time.monotonic()
    with _AMBIENT_LOCK:
        if _AMBIENT['budget'] is None or now - _AMBIENT['since'] > WINDOW_S:
            _AMBIENT.update(budget=_Budget(BUDGET_S), since=now)
        return _AMBIENT['budget']


class Window:
    """A budget for the frames of ONE stream, which lives for minutes and whose frames are not requests: BUDGET_S of redactor time for every WINDOW_S of its life,
    renewed at the first frame after the window. Its own, so a hostile stream spends nothing of what another one has."""
    def __init__(self, seconds=BUDGET_S, every=WINDOW_S):
        self._seconds, self._every, self._budget, self._since = seconds, every, None, 0.0

    @contextlib.contextmanager
    def open(self):
        now = time.monotonic()
        if self._budget is None or now - self._since > self._every:
            self._budget, self._since = _Budget(self._seconds), now
        token = _BUDGET.set(self._budget)
        try:
            yield self._budget
        finally:
            try:
                _BUDGET.reset(token)
            except ValueError:      # closed from another context (the generator was finalized elsewhere): the variable of that one is not ours to reset
                pass


@contextlib.contextmanager
def request_budget(seconds=BUDGET_S):
    """The budget of redactor time of one request (or of one pass of an index refresh), in the context of whoever opens it: a worker thread
    the request starts sees the same one. Inside an open budget this joins it: a request does not get a second one."""
    current = _BUDGET.get()
    if current is not None:
        yield current
        return
    token = _BUDGET.set(_Budget(seconds))
    try:
        yield _BUDGET.get()
    finally:
        _BUDGET.reset(token)


def timeouts():
    """How many times a call passed its deadline and the child was killed, since the process started."""
    return _STATS['timeouts']


def problem():
    """'redactor_unavailable' while the child cannot start (the notes then say unavailable, like the compat gate), else None."""
    return 'redactor_unavailable' if time.monotonic() < _STATE['down_until'] else None


def set_worker_factory(factory):
    """The seam of the tests: `factory()` returns the worker (an object with `redact(text, mode, deadline_s)` and, if it can be stopped, `kill()`); None
    gives the real child back. The worker in use is dropped and the memory of a failed start is cleared."""
    with _LOCK:
        _drop(_STATE['worker'])
        _STATE.update(worker=None, factory=factory, down_until=0.0)


def isolated_redact(text, mode='default'):
    """`text` redacted by Hermes's redactor: in this process when it is short, in the child under a deadline when it is not, PLACEHOLDER when the deadline
    passed, the budget is spent or the child cannot start. `mode` is `default` (force=True) or `file` (the mask of A-228). None stays None, a value that is not
    a string is read as its string, as the redactor of Hermes does."""
    if mode not in MODES:
        raise ValueError('unknown redaction mode')
    if text is None:
        return None
    if not isinstance(text, str):
        text = str(text)
    if not text:
        return text
    budget = _BUDGET.get() or _ambient()
    if _on_loop():
        budget = _LoopView(budget)
    if budget.left() <= 0:
        return PLACEHOLDER
    started = time.perf_counter()
    try:
        size = len(text.encode('utf-8', 'surrogatepass'))
        if size <= IN_PROCESS_BYTES:
            return _functions()[mode](text)
        return _isolated(_registered(text), mode, size, budget, started)
    finally:
        budget.charge(time.perf_counter() - started)


def _left(budget, since):
    """What is left of the budget for a call that began at `since`: the time it has already spent (waiting for the child, starting it) is not the budget's yet."""
    return budget.left() - (time.perf_counter() - since)


def _deadline(size, budget, since):
    return min(MAX_S, BASE_S + PER_BYTE_S * size, _left(budget, since))


def _isolated(text, mode, size, budget, since):
    if time.monotonic() < _STATE['down_until'] or _deadline(size, budget, since) <= 0:
        return PLACEHOLDER
    if not _LOCK.acquire(timeout=max(_left(budget, since), 0)):      # the one child is busy with another request, and what is left of the budget ran out waiting
        return PLACEHOLDER
    try:
        deadline = _deadline(size, budget, since)
        if deadline <= 0:
            return PLACEHOLDER
        worker = _STATE['worker'] or _start(_left(budget, since))
        if worker is None:
            return PLACEHOLDER
        deadline = _deadline(size, budget, since)           # the start took its part of the budget
        if deadline <= 0:
            return PLACEHOLDER
        box = {}

        def call():
            try:
                box['out'] = worker.redact(text, mode, deadline)
            except BaseException as error:  # noqa: BLE001  (the class is logged below, never the message: it may hold the text)
                box['error'] = error
        thread = threading.Thread(target=call, daemon=True, name='luvebot-redaction-call')
        thread.start()
        thread.join(deadline)
        if thread.is_alive() or 'error' in box or not isinstance(box.get('out'), str):
            deadline_passed = thread.is_alive()
            _STATS['timeouts'] += 1 if deadline_passed else 0
            _log.warning('redaction worker dropped: %s (%s, %d bytes)', 'deadline' if deadline_passed else type(box.get('error')).__name__, mode, size)
            _drop(worker)
            _STATE['worker'] = None
            warm()                                          # the next child starts now, off the path of the next request
            return PLACEHOLDER
        return box['out']
    finally:
        _LOCK.release()


def _start(limit=START_S):
    """A new worker (the factory's or the real child, which gets at most `limit` seconds to start) kept in _STATE, or None. A start that failed (the child
    could not import the redactor, or could not be spawned) is left alone for RETRY_S; one that only ran out of the time it was given is not."""
    try:
        worker = (_STATE['factory'] or (lambda: _ChildWorker(min(START_S, max(limit, 0.0)))))()
    except TimeoutError:
        return None
    except Exception as error:  # noqa: BLE001
        _STATE['down_until'] = time.monotonic() + RETRY_S
        _log.warning('redaction worker could not start (%s)', type(error).__name__)
        return None
    _STATE['worker'] = worker
    return worker


def warm():
    """Start the child in the background if there is none (the routes do it on every request, which costs a dict read once there is one, and a kill does it for
    the next one): the first long text of a request should not pay the start of a Python process. Never blocks, never raises."""
    if _STATE['worker'] is not None or _STATE.get('warming') or time.monotonic() < _STATE['down_until']:
        return

    def warm_up():
        try:
            with _LOCK:
                if _STATE['worker'] is None and time.monotonic() >= _STATE['down_until']:
                    _start()
        except BaseException as error:  # noqa: BLE001  (a thread of ours never dies loudly: the next request starts the child again)
            _log.warning('redaction warm-up failed (%s)', type(error).__name__)
        finally:
            _STATE['warming'] = False
    _STATE['warming'] = True
    threading.Thread(target=warm_up, daemon=True, name='luvebot-redaction-warm').start()


def budgeted(handler):
    """A route handler (`async def(request)`) that starts the child if there is none and answers inside one budget of redactor time: the plugin's SafeRoute wraps
    the FastAPI handler with it, so the routes do not repeat the two lines (a stream's frames come after the handler returns, outside the budget)."""
    async def run(request):
        warm()
        with request_budget():
            return await handler(request)
    return run


def _drop(worker):
    stop = getattr(worker, 'kill', None)
    if stop is not None:
        try:
            stop()
        except Exception:  # noqa: BLE001
            pass


def _agent_root():
    spec = importlib.util.find_spec('agent.redact')
    if spec is None or not spec.origin:
        raise ImportError('agent.redact')
    return str(Path(spec.origin).parent.parent)


def _read_exact(pipe, count):
    data = b''
    while len(data) < count:
        chunk = pipe.read(count - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


class _ChildWorker:
    """The child process: `python redaction.py --child`, which reads frames (mode, length, text) and answers frames (status, length, text) on its pipes."""
    def __init__(self, timeout=START_S):
        root = _agent_root()
        env = {name: os.environ[name] for name in ('HERMES_HOME', 'PATH') if name in os.environ}
        env['PYTHONPATH'] = os.pathsep.join(part for part in (root, os.environ.get('PYTHONPATH')) if part)
        self.patterns = '{}'                                  # the registry the child has been told: none, it starts empty
        self.process = subprocess.Popen([sys.executable, '-P', str(Path(__file__).resolve()), '--child'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, env=env, cwd=tempfile.gettempdir(), close_fds=True)   # -P: the folder of this file is not on its path
        box = {}

        def ready():
            try:
                box['status'] = struct.unpack('>BI', _read_exact(self.process.stdout, 5))[0]
            except Exception:  # noqa: BLE001
                box['status'] = -1
        thread = threading.Thread(target=ready, daemon=True)
        thread.start()
        thread.join(timeout)
        if thread.is_alive():
            self.kill()
            raise TimeoutError('the redaction child did not start in time')
        if box.get('status') != 0:
            self.kill()
            raise RuntimeError('the redaction child did not start')

    def redact(self, text, mode, deadline_s):
        patterns = json.dumps(_plugin_patterns(), sort_keys=True)
        if patterns != self.patterns:                         # a plugin registered since the child was told: it learns before it redacts (a failure here is a failure of the call)
            self._ask(_PATTERNS, patterns)
            self.patterns = patterns
        return self._ask(_CODES[mode], text)

    def _ask(self, code, text):
        data = text.encode('utf-8', 'surrogatepass')
        self.process.stdin.write(struct.pack('>BI', code, len(data)) + data)
        self.process.stdin.flush()
        status, count = struct.unpack('>BI', _read_exact(self.process.stdout, 5))
        out = _read_exact(self.process.stdout, count)
        if status != 0:
            raise RuntimeError('the redaction child failed')
        return out.decode('utf-8', 'surrogatepass')

    def kill(self):
        try:
            self.process.terminate()
            self.process.wait(timeout=2)
        except Exception:  # noqa: BLE001
            self.process.kill()
        try:
            self.process.stdin.close()      # the reading end is not closed here: a thread may be blocked in it, and `close` would wait for that thread; the dead child ends the read
        except Exception:  # noqa: BLE001
            pass


def _serve():
    """The child: import the redactor once, say so (status 0) or say it could not (status 2), then answer until the pipe closes."""
    pipe_in, pipe_out = sys.stdin.buffer, sys.stdout.buffer
    sys.stdout = open(os.devnull, 'w')                       # a stray print can never be taken for a frame
    try:
        from agent.redact import redact_sensitive_text
        functions = {0: lambda text: redact_sensitive_text(text, force=True), 1: masking(redact_sensitive_text)}
    except Exception:  # noqa: BLE001
        pipe_out.write(struct.pack('>BI', 2, 0))
        pipe_out.flush()
        return
    try:
        from agent.redact import register_redaction_patterns
    except ImportError:
        register_redaction_patterns = None
    pipe_out.write(struct.pack('>BI', 0, 0))
    pipe_out.flush()
    while True:
        try:
            code, count = struct.unpack('>BI', _read_exact(pipe_in, 5))
            text = _read_exact(pipe_in, count).decode('utf-8', 'surrogatepass')
        except EOFError:
            return
        try:
            if code == _PATTERNS:                              # the registry of the plugins of the parent, {source: [regex]}: registered here the way Hermes registers them
                for source, patterns in json.loads(text).items():
                    if patterns and register_redaction_patterns is None:
                        raise RuntimeError('this Hermes cannot register patterns')
                    register_redaction_patterns(patterns, source)
                out = b''
            else:
                out = functions[code](text).encode('utf-8', 'surrogatepass')
            pipe_out.write(struct.pack('>BI', 0, len(out)) + out)
        except Exception:  # noqa: BLE001
            pipe_out.write(struct.pack('>BI', 1, 0))
        pipe_out.flush()


if __name__ == '__main__' and sys.argv[1:] == ['--child']:
    _serve()
