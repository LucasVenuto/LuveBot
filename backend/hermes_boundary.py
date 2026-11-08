"""The boundary between LuveBot and Hermes's config backend (contract v0.10 section 1, P-1).

Hermes `main` sends every read and write of a profile's `config.yaml` through a `ConfigBackend`. When the backend cannot serve, a READ raises `ConfigBackendUnavailable`, a
`SystemExit` on purpose (so the many `except Exception` readers do not fail open); a refused WRITE raises `ConfigWriteError` (`config_key_locked`, `config_value_invalid`,
`config_write_failed`). LuveBot reads and writes no `config.yaml` itself, so it inherits the backend; what it needs is the HANDLING: a `SystemExit` crossing a thread or a task is
re-raised by asyncio into the event loop (and ignored for good in a plain thread), and our readers all say `except Exception`.

Nothing here imports Hermes: the classes exist only on main, so they are recognized BY NAME through the class's MRO, and the same code is right on v0.22.5, where nothing ever matches.
The config outage becomes `config_backend_unavailable`. A plain `SystemExit` (a helper that calls `sys.exit()`) becomes `hermes_exited` in a THREAD of ours (an AnyIO worker, a thread target):
there it cannot stop the process, it only ends the thread, and a request that waits for it is left alive and mute (contract 1.4, A-133 revised); in the event loop's own thread it is never
swallowed. `KeyboardInterrupt`, `GeneratorExit` and `asyncio.CancelledError` are never matched, converted or swallowed. Nothing from the exception is copied out (not its text, which a remote backend can fill with a URL, not `locked_by`, not its arguments): the converted
error carries no cause and no context, and the log line names the CLASS only."""
import asyncio
import functools
import inspect
import logging
import re
import time

_UNAVAILABLE, _WRITE = 'ConfigBackendUnavailable', 'ConfigWriteError'
CONVERTED = ('config_backend_unavailable', 'hermes_exited')   # the codes of the two errors the boundary makes out of a SystemExit: a thread that ends its unit of work on one of them is not broken
WRITE_CODES = ('config_key_locked', 'config_value_invalid', 'config_write_failed')
_KEY = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}')   # a dotted config key; anything else (a hostile text, a URL) is never echoed
log = logging.getLogger('luvebot.boundary')
LOG_EVERY_S = 60.0   # one line per class per minute: a Hermes that stays out for an hour must not write a line per request
_logged = {}


def _named(error, name):
    return any(cls.__name__ == name for cls in type(error).__mro__)


def is_config_unavailable(error):
    """True for `ConfigBackendUnavailable` and its subclasses, which are `SystemExit`s: an object that is named so but is not a `SystemExit` is not it."""
    return isinstance(error, SystemExit) and _named(error, _UNAVAILABLE)


CAUSE_DEPTH = 4   # how far down a chain of `raise ... from ...` the refusal is looked for


def config_write_refusal(error):
    """-> (code, key | None) for a refused config write, else None. The refusal is the error itself or the CAUSE of one: a write that goes through a Hermes ROUTE (V6 `update_config`, the approval wait) reaches
    us as an HTTPException (Hermes's `http_failure` maps a lock to 403 and an invalid value to 400 or 413) raised `from` the ConfigWriteError, so the chain of causes is read, at most CAUSE_DEPTH deep.
    It never raises: it is read inside an `except` clause, and a hostile `code`, `path` or `__cause__` (a property that raises) is just not a refusal."""
    for _ in range(CAUSE_DEPTH):
        try:
            found = _write_refusal(error)
            if found is not None:
                return found
            error = error.__cause__
        except Exception:  # noqa: BLE001
            return None
        if error is None:
            return None
    return None


def _write_refusal(error):
    """The reading behind `config_write_refusal`. An `Exception` whose MRO names `ConfigWriteError` and whose `code` is one of WRITE_CODES (any other code stays a plain
    error). For `config_key_locked` the key is the exception's `path` (a dotted name, or a list of its parts), and only when it looks like one."""
    if not isinstance(error, Exception) or not _named(error, _WRITE):
        return None
    code = getattr(error, 'code', None)
    if code not in WRITE_CODES:
        return None
    key = None
    if code == 'config_key_locked':
        try:
            path = getattr(error, 'path', None)
            if isinstance(path, (list, tuple)) and all(isinstance(part, str) for part in path):
                path = '.'.join(path)
            key = path if isinstance(path, str) and _KEY.fullmatch(path) else None
        except Exception:  # noqa: BLE001  (a `path` that raises: the lock is still a lock, only its key is not told)
            key = None
    return code, key


def _note(error):
    name, now = type(error).__name__, time.monotonic()
    if now - _logged.get(name, -LOG_EVERY_S) >= LOG_EVERY_S:
        _logged[name] = now
        log.warning('hermes config backend unavailable: %s' if is_config_unavailable(error) else 'hermes stopped an operation with %s', name)   # the class only: the exit code and the text are never logged


def _on_loop():
    """True in the thread that runs an event loop: a `SystemExit` there is the host's to handle, never ours to swallow."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _unavailable():
    from .hermes_client import HermesError   # here, not at the top: that module imports Hermes, and the matching above must work without it
    return HermesError('config_backend_unavailable')


def _exited():
    from .hermes_client import HermesError
    return HermesError('hermes_exited')


def convert(fn):
    """`fn` (a sync callable) with the config outage turned into `HermesError('config_backend_unavailable')`, and any other `SystemExit` into `HermesError('hermes_exited')`: ordinary
    `Exception`s that travel through every `except Exception`, gather and task. The second is only for a thread (a worker, a thread target): in the event loop's own thread a plain exit is
    raised untouched. `KeyboardInterrupt`, `GeneratorExit` and `CancelledError` are always raised untouched. Refuses (TypeError, at wrap time) an `async def`, a generator function, an async generator function and an
    object whose `__call__` is one of them: calling those only makes a coroutine or a generator, which this would hand back unrun, so the outage would come out of the caller's `await` or loop
    unconverted; a coroutine goes through `guarded`."""
    if any(inspect.iscoroutinefunction(f) or inspect.isgeneratorfunction(f) or inspect.isasyncgenfunction(f) for f in (fn, getattr(fn, '__call__', None))):
        raise TypeError('convert() wraps a sync callable that returns its result; a coroutine goes through guarded(), and a generator runs its body outside the call')

    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except SystemExit as error:
            outage = is_config_unavailable(error)
            if not outage and _on_loop():
                raise
            _note(error)
        raise _unavailable() if outage else _exited()   # outside the except: no cause, no context, nothing of the original
    return wrapped


def thread_target(fn):
    """`convert(fn)` for the TARGET of a thread. Python ignores a `SystemExit` in a thread (it just ends, silently), and a converted `HermesError` would end it with a traceback on stderr: here the
    converted outage or exit ends this one unit of work cleanly (the boundary has already logged it, by class), and anything else is raised as it always was."""
    run = convert(fn)

    @functools.wraps(fn)
    def target(*args, **kwargs):
        try:
            return run(*args, **kwargs)
        except Exception as error:  # noqa: BLE001
            if getattr(error, 'code', None) not in CONVERTED:
                raise
    return target


async def guarded(awaitable):
    """The same for a coroutine: the one handed to `ensure_future` or to a Flight, where a `SystemExit` would be re-raised by asyncio into the event loop."""
    try:
        return await awaitable
    except SystemExit as stop:
        if not is_config_unavailable(stop):
            raise
        _note(stop)
    raise _unavailable()


async def run_in_threadpool(fn, *args, **kwargs):
    """starlette's `run_in_threadpool` on `convert(fn)`: the conversion happens IN the worker thread, before the exception can cross into the task that awaits it."""
    from starlette.concurrency import run_in_threadpool as pool   # here, so this module imports (and is tested) without starlette
    return await pool(convert(fn), *args, **kwargs)
