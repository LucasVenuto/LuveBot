"""P1-1 (contract v0.10 section 1): `backend/hermes_boundary.py`, the boundary between LuveBot and Hermes's config backend. The classes of Hermes main (`ConfigBackendUnavailable`, a SystemExit on
purpose; `ConfigWriteError` and its subclasses) are stand-ins here, recognized the way the module does it: BY NAME through the MRO, with no Hermes import.
* `is_config_unavailable`: a SystemExit (or a subclass) named ConfigBackendUnavailable, and nothing else: not a plain `sys.exit()`, not KeyboardInterrupt, GeneratorExit or CancelledError, not an
  Exception that only carries the name, not a lookalike name;
* `convert` / `guarded` / `run_in_threadpool`: the outage becomes `HermesError('config_backend_unavailable')` and, in a THREAD, any other SystemExit becomes `HermesError('hermes_exited')` (P1-8, A-133 revised):
  ordinary Exceptions with NO cause, NO context and none of the original's text or code; in the event loop's own thread a plain exit, and anywhere a KeyboardInterrupt, GeneratorExit or CancelledError, are
  re-raised untouched (the same object); the conversion happens IN the worker thread, so the loop survives;
* `config_write_refusal`: (code, key | None) for the three Hermes codes only, the key only when it looks like a dotted key (never a hostile text or a URL).
Mutations: match any SystemExit; never match; match by `startswith`; keep the cause; keep the context (and with it the text); no conversion in the pool; any write code; any key echoed."""
import asyncio
import functools
import importlib
import importlib.util
import itertools
import logging
from pathlib import Path
import sys
import threading
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
HOSTILE = 'https://admin:s3cr3t@config.internal/v1?token=abc  \n<script>'


class ConfigBackendUnavailable(SystemExit):
    pass


class RemoteUnavailable(ConfigBackendUnavailable):          # a subclass: matched through the MRO
    pass


class ConfigBackendUnavailableLookalike(SystemExit):        # the same prefix, another class
    pass


NotAnExit = type('ConfigBackendUnavailable', (Exception,), {})   # named so, but not a SystemExit


class ConfigWriteError(Exception):
    def __init__(self, code, path=None, text=HOSTILE):
        super().__init__(text)
        self.code, self.path = code, path


class ConfigLockedError(ConfigWriteError):
    pass


class ConfigValueError(ConfigWriteError):
    pass


class ConfigWriteErrorLookalike(Exception):
    code, path = 'config_key_locked', 'terminal.cwd'


def load(old=None, new=None):
    """The real backend under its own package name; `hermes_client` stubbed (it imports Hermes) with a HermesError like the real one's; `old`/`new` edit the source of hermes_boundary."""
    name = f'hb_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    client = types.ModuleType(f'{name}.hermes_client')

    class HermesError(Exception):
        def __init__(self, code):
            self.code = code
            super().__init__('hermes error')
    client.HermesError = HermesError
    sys.modules[client.__name__] = client
    if old is None:
        return importlib.import_module(f'{name}.hermes_boundary'), HermesError
    source = (BACKEND / 'hermes_boundary.py').read_text()
    assert source.count(old) == 1, old
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.hermes_boundary', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(old, new), str(BACKEND / 'hermes_boundary.py'), 'exec'), module.__dict__)
    return module, HermesError


def with_pool_stand_in(fn):
    """`fn()` with a stand-in for `starlette.concurrency.run_in_threadpool` in sys.modules (the unit venv has no starlette: a unit test never depends on it, the r24 rule; the product imports it
    when it is called, which is right). The stand-in runs the callable in a worker thread like the real one, and a SystemExit raised there reaches the awaiting task the same way
    (a future's exception), so the mutation that does not convert in the worker still goes red."""
    async def stand_in(func, *args, **kwargs):
        return await asyncio.get_running_loop().run_in_executor(None, functools.partial(func, *args, **kwargs))
    concurrency = types.ModuleType('starlette.concurrency')
    concurrency.run_in_threadpool = stand_in
    saved = {name: sys.modules.get(name) for name in ('starlette', 'starlette.concurrency')}
    sys.modules['starlette'], sys.modules['starlette.concurrency'] = types.ModuleType('starlette'), concurrency
    try:
        return fn()
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def outcome(fn):
    """What a call ends in, whatever it raises (a defect must show as a failed assertion, never as a SystemExit loose in the test run)."""
    try:
        return 'returned', fn()
    except BaseException as error:  # noqa: BLE001
        return 'raised', error


def run(coro):
    return outcome(lambda: asyncio.run(coro))


def checks(boundary, HermesError):
    unavailable = [ConfigBackendUnavailable(HOSTILE), RemoteUnavailable(HOSTILE)]
    others = [SystemExit(3), SystemExit(), KeyboardInterrupt(), GeneratorExit(), asyncio.CancelledError(), ConfigBackendUnavailableLookalike(HOSTILE), NotAnExit(HOSTILE),
              RuntimeError('x'), None, 'ConfigBackendUnavailable']
    assert [boundary.is_config_unavailable(e) for e in unavailable] == [True, True]
    assert [boundary.is_config_unavailable(e) for e in others] == [False] * len(others), [boundary.is_config_unavailable(e) for e in others]

    # convert: the outage becomes an ordinary Exception with nothing of the original
    def boom(error):
        def fn(*args, **kwargs):
            raise error
        return fn
    for error in unavailable:
        kind, got = outcome(lambda: boundary.convert(boom(error))())
        assert kind == 'raised' and type(got) is HermesError and got.code == 'config_backend_unavailable', (kind, got)
        assert not isinstance(got, SystemExit) and got.__cause__ is None and got.__context__ is None and got.__suppress_context__ is False
        assert HOSTILE not in str(got) and 's3cr3t' not in repr(got) and not got.args[1:], got.args       # none of the original's text
    for error in (SystemExit(3), SystemExit(), ConfigBackendUnavailableLookalike(HOSTILE)):          # a plain exit in a THREAD: Hermes stopped the operation (A-133 revised), nothing of it copied out
        kind, got = outcome(lambda: boundary.convert(boom(error))())
        assert kind == 'raised' and type(got) is HermesError and got.code == 'hermes_exited', (kind, got)
        assert not isinstance(got, SystemExit) and got.__cause__ is None and got.__context__ is None and got.__suppress_context__ is False
        assert HOSTILE not in str(got) and '3' not in repr(got) and got.args == ('hermes error',), got.args            # no exit code, no text
    for error in (KeyboardInterrupt(), GeneratorExit(), asyncio.CancelledError(), NotAnExit(HOSTILE)):  # anything else is the same object, untouched
        kind, got = outcome(lambda: boundary.convert(boom(error))())
        assert kind == 'raised' and got is error, (kind, got)

    async def on_the_loop(error):
        return boundary.convert(boom(error))()
    kind, got = run(on_the_loop(SystemExit(3)))
    assert kind == 'raised' and type(got) is SystemExit and got.code == 3, (kind, got)               # in the event loop's own thread a plain exit is NOT ours to swallow
    kind, got = run(on_the_loop(ConfigBackendUnavailable(HOSTILE)))
    assert kind == 'raised' and type(got) is HermesError and got.code == 'config_backend_unavailable', (kind, got)   # the outage is converted wherever it happens

    lines = []                                                                                       # the log carries the CLASS only: never the exit code or the text
    handler = type('Collect', (logging.Handler,), {'emit': lambda self, record: lines.append(record.getMessage())})()
    boundary.log.addHandler(handler)
    try:
        boundary._logged.clear()
        for error in (SystemExit(HOSTILE), ConfigBackendUnavailable(HOSTILE), ConfigBackendUnavailableLookalike(HOSTILE)):
            outcome(lambda: boundary.convert(boom(error))())
    finally:
        boundary.log.removeHandler(handler)
    assert len(lines) == 3 and 'SystemExit' in lines[0] and 'ConfigBackendUnavailable' in lines[1] and not any(HOSTILE in line or 's3cr3t' in line for line in lines), lines
    assert boundary.convert(lambda a, b=2: a + b)(1, b=5) == 6                                       # arguments and results pass through
    assert boundary.convert(lambda: 1).__name__ == '<lambda>'

    # guarded: the same, for a coroutine
    async def raising(error):
        raise error

    async def fine():
        return 7
    assert run(boundary.guarded(fine())) == ('returned', 7)
    for error in unavailable:
        kind, got = run(boundary.guarded(raising(error)))
        assert kind == 'raised' and type(got) is HermesError and got.code == 'config_backend_unavailable' and got.__cause__ is None and got.__context__ is None, (kind, got)
        assert HOSTILE not in str(got)
    for error in others[:7]:
        kind, got = run(boundary.guarded(raising(error)))
        assert kind == 'raised' and (got is error or isinstance(got, type(error))), (kind, got)      # asyncio.run may wrap a CancelledError: it is never turned into the outage
        assert not (kind == 'raised' and type(got) is HermesError)

    # run_in_threadpool: converted IN the worker thread, so a task that awaits it gets an ordinary error and the loop keeps going
    where = []

    def in_thread(error):
        def fn():
            where.append(threading.current_thread() is not threading.main_thread())
            raise error
        return fn

    async def scenario():
        results = []
        for error in unavailable + [SystemExit(3), KeyboardInterrupt()]:
            try:
                await boundary.run_in_threadpool(in_thread(error))
            except BaseException as caught:  # noqa: BLE001
                results.append(caught)
        alive = await boundary.run_in_threadpool(lambda: 'still serving')                            # the loop is alive after the outage
        return results, alive
    kind, got = with_pool_stand_in(lambda: run(scenario()))
    assert kind == 'returned', (kind, got)
    results, alive = got
    assert alive == 'still serving' and all(where), where
    assert [type(r) for r in results[:3]] == [HermesError] * 3 and [r.code for r in results[:3]] == ['config_backend_unavailable'] * 2 + ['hermes_exited'], results     # a plain exit in the worker is an answer, not a mute dashboard
    assert type(results[3]) is KeyboardInterrupt, results                                            # and a KeyboardInterrupt is never converted

    # config_write_refusal
    refusal = boundary.config_write_refusal
    assert refusal(ConfigLockedError('config_key_locked', 'terminal.cwd')) == ('config_key_locked', 'terminal.cwd')
    assert refusal(ConfigLockedError('config_key_locked', ['approvals', 'timeout'])) == ('config_key_locked', 'approvals.timeout')
    assert refusal(ConfigValueError('config_value_invalid', 'terminal.cwd')) == ('config_value_invalid', None)      # the key is told only for a locked key
    assert refusal(ConfigWriteError('config_write_failed')) == ('config_write_failed', None)
    for path in (HOSTILE, 'a b', 'x\ny', '', '.hidden', 'a' * 129, 7, None, ['a', 3], 'https://u:p@h/x'):
        assert refusal(ConfigLockedError('config_key_locked', path)) == ('config_key_locked', None), path             # never a hostile text or a URL echoed
    for error in (ConfigWriteError('something_else'), ConfigWriteError(None), ConfigWriteErrorLookalike(), RuntimeError('x'), SystemExit(1), KeyboardInterrupt(), None, 'x'):
        assert refusal(error) is None, error
    assert 'config_write_failed' in boundary.WRITE_CODES and len(boundary.WRITE_CODES) == 3


def test_the_boundary_recognizes_converts_and_maps_only_what_the_contract_says():
    checks(*load())


MUTATIONS = {
    'any SystemExit is the outage': ('isinstance(error, SystemExit) and _named(error, _UNAVAILABLE)', 'isinstance(error, SystemExit)'),
    'the outage is never recognized': ('isinstance(error, SystemExit) and _named(error, _UNAVAILABLE)', 'False'),
    'recognized by startswith': ('any(cls.__name__ == name for cls in type(error).__mro__)', 'any(cls.__name__.startswith(name) for cls in type(error).__mro__)'),
    'only the class itself, not its subclasses': ('any(cls.__name__ == name for cls in type(error).__mro__)', 'type(error).__name__ == name'),
    'a name without a SystemExit is the outage': ('isinstance(error, SystemExit) and _named(error, _UNAVAILABLE)', '_named(error, _UNAVAILABLE)'),
    'convert keeps the cause': ("            _note(error)\n        raise _unavailable() if outage else _exited()   # outside the except: no cause, no context, nothing of the original\n",
                                "            raise (_unavailable() if outage else _exited()) from error\n"),
    'guarded keeps the cause': ("        _note(stop)\n    raise _unavailable()\n",
                                "        raise _unavailable() from stop\n"),
    'convert keeps the context': ("            _note(error)\n        raise _unavailable() if outage else _exited()   # outside the except: no cause, no context, nothing of the original\n",
                                  "            _note(error)\n            raise _unavailable() if outage else _exited()\n"),
    'guarded keeps the context': ("        _note(stop)\n    raise _unavailable()\n",
                                  "        _note(stop)\n        raise _unavailable()\n"),
    'no conversion in the pool': ('return await pool(convert(fn), *args, **kwargs)', 'return await pool(fn, *args, **kwargs)'),
    'a plain exit is not converted in a thread': ('            if not outage and _on_loop():\n                raise\n', '            if not outage:\n                raise\n'),
    'a plain exit is converted on the loop too': ('            if not outage and _on_loop():\n                raise\n', ''),
    'a plain exit becomes the outage': ('        raise _unavailable() if outage else _exited()', '        raise _unavailable()'),
    'a plain exit is swallowed by convert': ('        raise _unavailable() if outage else _exited()', '        if outage:\n            raise _unavailable()\n        return None'),
    'a KeyboardInterrupt is converted': ('        except SystemExit as error:\n            outage = ', '        except BaseException as error:\n            outage = '),
    'the exit text is logged': ("log.warning('hermes config backend unavailable: %s' if is_config_unavailable(error) else 'hermes stopped an operation with %s', name)",
                                "log.warning('hermes config backend unavailable: %s' if is_config_unavailable(error) else 'hermes stopped an operation with %s', error)"),
    'the exit class is not logged': ("log.warning('hermes config backend unavailable: %s' if is_config_unavailable(error) else 'hermes stopped an operation with %s', name)", "pass"),
    'every SystemExit is swallowed by guarded': ('        if not is_config_unavailable(stop):\n            raise\n', ''),
    'any write code': ('    if code not in WRITE_CODES:\n        return None\n', ''),
    'any key is echoed': ("key = path if isinstance(path, str) and _KEY.fullmatch(path) else None", "key = path if isinstance(path, str) else None"),
    'the key of every refusal': ("    if code == 'config_key_locked':\n        try:\n", "    if True:\n        try:\n"),
    'a lookalike write error': ('if not isinstance(error, Exception) or not _named(error, _WRITE):', 'if not isinstance(error, Exception):'),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_turns_the_checks_red(label):
    old, new = MUTATIONS[label]
    boundary, HermesError = load(old, new)                      # an anchor that moved fails HERE, not inside the raises below
    with pytest.raises(Exception):  # noqa: B017
        checks(boundary, HermesError)
