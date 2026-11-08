"""Red team (Lume, P1-10 and the P1-4 attack, 30/10) of the committed P1-8 (`convert` turns a plain SystemExit in a thread into `hermes_exited`) and P1-4 (a refused config write is told as what it is).

What holds (tests that pass, pinning it): a plain exit in a worker, in a thread target and through `asyncio.run` inside the worker becomes `hermes_exited` with no cause/context/text/code; in the
event loop's thread it is untouched; KeyboardInterrupt / GeneratorExit / CancelledError are never matched; a gather child in a worker does not take its sibling down; a SystemExit SUBCLASS under another
name is a plain exit (`hermes_exited`, never the outage); `thread_target` swallows only the two converted codes; `config_write_refusal` takes only the three codes.

What does not (xfail strict: red the day it is fixed, then flip to a plain test):
  F-P14-1 (Medium)  `skills.toggle` still answers a refused config write (`skills.disabled` locked by an administrator) as the bare `hermes_error`; the toggle is also step 2 of the SK-2 creation (contract v0.11 3.2.4);
  F-P14-2 (Low)     `bots.create_in_hermes` answers a locked `approvals.timeout` (its `approval_timeout` step) as `hermes_error` after creating and rolling back the profile: every attempt, forever, with no word of why;
  F-P18-1 (Info)    `convert` refuses an `async def` at wrap time for the reason that its SystemExit would come out unconverted, and lets a generator function, an async generator function and an object whose
                    `__call__` is async through: the same hole, a wrapper that protects nothing;
  F-P14-3 (Info)    `config_write_refusal` can raise (a hostile `code` or `path` attribute): it runs inside SafeRoute's own `except Exception`, so the exception would leave the handler."""
import asyncio
import inspect
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_applied as applied  # noqa: E402
import test_config_write_refusal as refusal  # noqa: E402
from test_approval_timeout import Audit as TimeoutAudit, hermes as timeout_hermes, load as timeout_load  # noqa: E402,F401
from test_skills import Audit as SkillsAudit, hermes as skills_hermes, load as skills_load, redact as skills_redact  # noqa: E402,F401

ConfigBackendUnavailable = applied.ConfigBackendUnavailable
ConfigLockedError, ConfigValueError, ConfigWriteError = refusal.ConfigLockedError, refusal.ConfigValueError, refusal.ConfigWriteError


def boundary(edits=()):
    name, error = applied.package()
    import importlib
    if edits:
        import test_config_boundary_threads as threads
        return threads.variant(threads.package()[0], 'hermes_boundary', edits), error
    return importlib.import_module(f'{name}.hermes_boundary'), error


class WeirdExit(SystemExit):                                       # a SystemExit under any other name
    pass


class ConfigBackendDown(SystemExit):                               # a lookalike: not the name the boundary matches
    pass


# ======================================================================== P1-8: what holds ================================================================================
def run_in_worker(fn, *args):
    """`fn` in a plain thread (no event loop), the way an AnyIO worker runs it: -> ('ok', value) | ('raised', exception)."""
    box = []
    thread = __import__('threading').Thread(target=lambda: box.append(_catch(fn, *args)))
    thread.start()
    thread.join()
    return box[0]


def _catch(fn, *args):
    try:
        return 'ok', fn(*args)
    except BaseException as error:  # noqa: BLE001
        return 'raised', error


@pytest.mark.parametrize('make', [lambda: SystemExit(3), lambda: SystemExit(0), lambda: SystemExit(None), lambda: SystemExit('SECRET-TEXT sk-proj-abc'), lambda: SystemExit(object()), lambda: WeirdExit(2),
                                  lambda: ConfigBackendDown('down')], ids=['3', '0', 'None', 'text', 'object', 'subclass-other-name', 'lookalike-name'])
def test_a_plain_exit_in_a_thread_is_hermes_exited_and_carries_nothing_of_the_original(make):
    bd, HermesError = boundary()

    def work():
        raise make()
    kind, error = run_in_worker(bd.convert(work))
    assert kind == 'raised' and isinstance(error, HermesError) and error.code == 'hermes_exited', (kind, error)
    assert error.__cause__ is None and error.__context__ is None and error.__suppress_context__ is False
    assert 'SECRET' not in repr(error) and 'SECRET' not in str(error) and 'sk-proj' not in repr(vars(error))


def test_a_plain_exit_through_asyncio_run_inside_the_worker_is_converted_too():
    """The backend's sync wrappers run Hermes's async routes with `asyncio.run` in the worker (skills, voice, pages, bot_controls): the exit crosses a private loop and must still come out converted."""
    bd, HermesError = boundary()

    async def route():
        raise SystemExit(7)
    kind, error = run_in_worker(bd.convert(lambda: asyncio.run(route())))
    assert kind == 'raised' and isinstance(error, HermesError) and error.code == 'hermes_exited'
    async def outage():
        raise ConfigBackendUnavailable(1)
    kind, error = run_in_worker(bd.convert(lambda: asyncio.run(outage())))
    assert kind == 'raised' and error.code == 'config_backend_unavailable'


def test_in_the_loops_own_thread_a_plain_exit_is_untouched_and_the_outage_is_not():
    bd, HermesError = boundary()

    async def main():
        plain = SystemExit(5)
        with pytest.raises(SystemExit) as got:
            bd.convert(lambda: (_ for _ in ()).throw(plain))()
        assert got.value is plain
        with pytest.raises(HermesError) as outage:
            bd.convert(lambda: (_ for _ in ()).throw(ConfigBackendUnavailable(1)))()
        assert outage.value.code == 'config_backend_unavailable'
    asyncio.run(main())


@pytest.mark.parametrize('make', [KeyboardInterrupt, GeneratorExit, asyncio.CancelledError], ids=['KeyboardInterrupt', 'GeneratorExit', 'CancelledError'])
def test_the_three_that_are_never_ours_pass_through_the_same_object(make):
    bd, _ = boundary()
    sent = make()

    def work():
        raise sent
    kind, error = run_in_worker(bd.convert(work))
    assert kind == 'raised' and error is sent
    kind, error = run_in_worker(bd.thread_target(work))
    assert kind == 'raised' and error is sent


def test_a_gather_child_in_a_worker_that_exits_does_not_take_the_sibling_or_the_loop_down():
    bd, HermesError = boundary()
    sibling_done = []

    async def main():
        loop = asyncio.get_running_loop()

        def exits():
            raise SystemExit(4)

        def fine():
            import time
            time.sleep(0.05)
            sibling_done.append(1)
            return 'fine'
        run = lambda fn: loop.run_in_executor(None, bd.convert(fn))                                        # the conversion is in the worker, as `run_in_threadpool` does it
        results = await asyncio.gather(run(exits), run(fine), return_exceptions=True)
        assert isinstance(results[0], HermesError) and results[0].code == 'hermes_exited' and results[1] == 'fine'
        with pytest.raises(HermesError):
            await asyncio.gather(run(exits), run(fine))                                                    # without return_exceptions: an ordinary exception, the loop goes on
        assert await loop.run_in_executor(None, bd.convert(lambda: 'still serving')) == 'still serving'
    asyncio.run(main())
    assert sibling_done


def test_thread_target_swallows_only_the_two_converted_codes():
    bd, HermesError = boundary()
    seen = []
    assert run_in_worker(bd.thread_target(lambda: (_ for _ in ()).throw(SystemExit(2)))) == ('ok', None)
    assert run_in_worker(bd.thread_target(lambda: (_ for _ in ()).throw(ConfigBackendUnavailable(1)))) == ('ok', None)
    for other in (HermesError('hermes_unreachable'), RuntimeError('boom'), ValueError('x')):
        kind, error = run_in_worker(bd.thread_target(lambda other=other: (_ for _ in ()).throw(other)))
        assert kind == 'raised' and error is other, other
    assert not seen


def test_the_log_names_the_class_only_and_at_most_once_a_minute_per_class(caplog):
    bd, _ = boundary()
    caplog.set_level('WARNING', logger='luvebot.boundary')

    def work():
        raise SystemExit('SECRET-TEXT sk-proj-abcdefghijklmnop')
    for _ in range(5):
        run_in_worker(bd.convert(work))
    text = ' '.join(r.getMessage() for r in caplog.records)
    assert 'SECRET' not in text and 'sk-proj' not in text and len(caplog.records) == 1 and 'SystemExit' in text


# ======================================================================== P1-8 findings =================================================================================
def _gen():
    yield 1
    raise SystemExit(9)


async def _agen():
    yield 1
    raise SystemExit(9)


class AsyncCallable:
    async def __call__(self):
        raise SystemExit(9)


@pytest.mark.parametrize('fn', [_gen, _agen, AsyncCallable()], ids=['generator function', 'async generator function', 'async __call__'])
def test_convert_refuses_what_it_cannot_protect(fn):
    convert_refuses(fn)


def convert_refuses(fn, edits=()):
    bd, _ = boundary(edits)
    with pytest.raises(TypeError):
        bd.convert(fn)
    assert bd.convert(lambda: 1)() == 1 and bd.convert(len)([1, 2]) == 2 and bd.convert(AsyncFree())() == 7     # a plain callable, a builtin and an object with a sync __call__ are wrapped as before


class AsyncFree:
    def __call__(self):
        return 7


def test_convert_does_refuse_an_async_def_today():
    bd, _ = boundary()

    async def coro():
        pass
    with pytest.raises(TypeError):
        bd.convert(coro)
    with pytest.raises(TypeError):
        bd.convert(__import__('functools').partial(coro))


# ======================================================================== P1-4 =========================================================================================
@pytest.mark.parametrize('attribute', ['code', 'path'])
def test_config_write_refusal_never_raises(attribute):
    refusal_never_raises(attribute)


def refusal_never_raises(attribute, edits=()):
    bd, _ = boundary(edits)

    def boom(self):
        raise RuntimeError('SECRET-TEXT')

    class Hostile(ConfigWriteError):
        def __init__(self):
            Exception.__init__(self, 'x')                                  # the stand-in's own __init__ assigns code and path: here one of them is a property that raises
            if attribute == 'path':
                self.code = 'config_key_locked'
    setattr(Hostile, attribute, property(boom))
    if attribute == 'code':
        Hostile.path = 'a.b'
    error = Hostile()
    try:
        got = bd.config_write_refusal(error)
    except Exception as raised:  # noqa: BLE001
        raise AssertionError('config_write_refusal raised') from raised
    # a `code` that raises is not a refusal; a `path` that raises is still the LOCK it says it is, only its key is not told
    assert got == (('config_key_locked', None) if attribute == 'path' else None), got


def test_the_refusal_of_a_write_keeps_to_its_three_codes_and_a_dotted_key():
    bd, _ = boundary()
    assert bd.config_write_refusal(ConfigLockedError('config_key_locked', 'terminal.cwd')) == ('config_key_locked', 'terminal.cwd')
    assert bd.config_write_refusal(ConfigLockedError('config_key_locked', ['a', 'b'])) == ('config_key_locked', 'a.b')
    for bad_key in ('a b', 'a/b', '../x', '\n', 'x' * 129, '', 'é', 'a\nb', "a'b", 'a;b', '<script>'):
        assert bd.config_write_refusal(ConfigLockedError('config_key_locked', bad_key)) == ('config_key_locked', None), bad_key
    assert bd.config_write_refusal(ConfigValueError('config_value_invalid', 'terminal.cwd')) == ('config_value_invalid', None)       # a key only for a lock
    assert bd.config_write_refusal(ConfigWriteError('something_else')) is None


def test_a_refusal_is_answered_as_a_refusal_whatever_exception_class_hierarchy_carries_it():
    """SafeRoute order: HermesError, PluginError, budget, audit, validation, HTTPException, SystemExit, sqlite3.DatabaseError, THEN the generic Exception where the refusal is read. A refusal that is also one of the
    earlier classes is answered as that class: pinned so a reorder is noticed."""
    import sqlite3

    class AlsoDb(sqlite3.DatabaseError, ConfigWriteError):
        def __init__(self):
            sqlite3.DatabaseError.__init__(self, 'x')
            self.code, self.path = 'config_key_locked', 'a.b'
    assert refusal.route_answer(AlsoDb())[0] == 'luvebot_db_unavailable'


@pytest.mark.parametrize('error', [lambda: ConfigLockedError('config_key_locked', 'skills.disabled'), lambda: ConfigValueError('config_value_invalid'), lambda: ConfigWriteError('config_write_failed')],
                         ids=['locked', 'invalid', 'failed'])
def test_a_skill_toggle_the_config_backend_refuses_says_so(skills_hermes, error):
    toggle_says_the_refusal(skills_hermes, error)


def toggle_says_the_refusal(skills_hermes, error, edit=None):
    skills = skills_load(edit)

    async def refused_toggle(body, profile=None):
        raise error()
    sys.modules['hermes_cli.web_routers.skills'].toggle_skill = refused_toggle
    audit = SkillsAudit(skills_hermes, RuntimeError)
    with pytest.raises(Exception) as got:
        skills.toggle(audit, 'ana', 'vendas', 'pesquisa', False, 'req_1', skills_redact)
    assert getattr(got.value, 'code', None) in ('config_key_locked', 'config_value_invalid', 'config_write_failed') or skills_hermes_refusal(got.value), \
        f'answered as {getattr(got.value, "code", type(got.value).__name__)}'
    assert type(got.value).__name__.startswith('Config'), type(got.value)                      # the refusal ITSELF, for SafeRoute to say which (409 / 422 / 502)

    async def broken_toggle(body, profile=None):                                              # any other failure is still "Hermes returned an unexpected response", and its text never leaves
        raise RuntimeError('SECRET-TEXT')
    sys.modules['hermes_cli.web_routers.skills'].toggle_skill = broken_toggle
    with pytest.raises(Exception) as other:
        skills.toggle(audit, 'ana', 'vendas', 'pesquisa', False, 'req_2', skills_redact)
    assert getattr(other.value, 'code', None) == 'hermes_error' and 'SECRET' not in str(other.value), other.value


def skills_hermes_refusal(error):
    bd, _ = boundary()
    return bd.config_write_refusal(error) is not None


def test_creating_a_bot_whose_approval_timeout_is_locked_says_it_is_locked(timeout_hermes):
    locked_creation_says_so(timeout_hermes)


def locked_creation_says_so(timeout_hermes, edit=None):
    controls, bots = timeout_load(edit, module='bots') if edit else timeout_load()

    async def locked_update(body, profile=None, preserve_language=False):
        timeout_hermes['events'].append(('update_config', body.profile))
        raise ConfigLockedError('config_key_locked', 'approvals.timeout')
    sys.modules['hermes_cli.web_routers.config_env'].update_config = locked_update
    meta = types.SimpleNamespace(path='db', upsert=lambda *a: None, set_template=lambda *a: None, delete=lambda *a: None)
    bots.hook = types.SimpleNamespace(install_hook=lambda *a: None, verify_installed=lambda *a: None, forget=lambda *a: None, HookError=type('HookError', (Exception,), {}))
    bots._markdown_hint = lambda name: None
    with pytest.raises(Exception) as got:
        bots.create_in_hermes('travado', None, {}, None, meta)
    assert 'travado' in timeout_hermes['deleted'], 'the profile is rolled back (this part works today)'
    extra = getattr(got.value, 'extra', None) or {}
    assert getattr(got.value, 'code', None) == 'config_key_locked' or extra.get('reason') == 'config_key_locked', f'answered as {getattr(got.value, "code", None)}: no word of the lock'
    assert got.value.status == 409 and 'locked' in str(got.value) and 'rolled back' in str(got.value) and extra == {'step': 'approval_timeout', 'rolled_back': True, 'details': {'key': 'approvals.timeout'}}, (got.value.status, str(got.value), extra)

    async def broken_update(body, profile=None, preserve_language=False):                      # any other failure is as before: the step, the rollback, the generic code
        raise RuntimeError('SECRET-TEXT')
    sys.modules['hermes_cli.web_routers.config_env'].update_config = broken_update
    with pytest.raises(Exception) as other:
        bots.create_in_hermes('travado2', None, {}, None, meta)
    assert other.value.code == 'hermes_error' and other.value.status == 502 and other.value.extra['step'] == 'approval_timeout' and 'SECRET' not in str(other.value), other.value


# ======================================================================== the tick, attacked at every line that can raise ==================================================
def _tick(where, exit_, pass_raises=None):
    """The REAL `_background_tick` with a lease whose `where` call raises `exit_`: -> (outcome, calls). Every place the tick calls out of its own code is a place a SystemExit can come from."""
    import logging
    import re
    import textwrap
    name, _ = applied.package()
    import importlib
    boundary = importlib.import_module(f'{name}.hermes_boundary')
    text = applied.source_of('dashboard/plugin_api.py')
    body = re.search(r'def _note_outage\(error\):.*?(?=\n\n\ndef _start_background)', text, re.S).group(0)
    calls = []

    def maybe(label):
        calls.append(label)
        if label == where:
            raise exit_

    class Lease:
        def set_kind(self, kind):
            maybe('set_kind')

        def enter(self):
            maybe('enter')
            return True

        def renew(self):
            maybe('renew')

        def release(self):
            maybe('release')
    fake = types.ModuleType('hermes_cli.web_server_profiles')
    fake.get_process_hermes_home = lambda: Path('/nonexistent-luvebot-home')
    saved = {m: sys.modules.get(m) for m in ('hermes_cli', 'hermes_cli.web_server_profiles')}
    sys.modules['hermes_cli'], sys.modules['hermes_cli.web_server_profiles'] = types.ModuleType('hermes_cli'), fake
    ns = {'hermes_compat': types.SimpleNamespace(read=lambda: (None, 'x'), read_app=lambda: None, serving=lambda *_: (None, 'x')), '_watch_pass': lambda: (maybe('pass'), (_ for _ in ()).throw(pass_raises) if pass_raises else True)[1],
          '_lease_for': lambda path: Lease(), 'logging': logging, '_SERVED': [False], '_WATCH_EVERY': 0.01, 'time': types.SimpleNamespace(monotonic=lambda: 1000.0, sleep=lambda s: None),
          'watcher_lease': types.SimpleNamespace(kind_of=lambda *a, **k: None), 'hermes_boundary': boundary, '_OUTAGE_LOGGED': {}, '_OUTAGE_EVERY_S': 600.0}
    try:
        exec(compile(textwrap.dedent(body), 'tick', 'exec'), ns)
        return applied.outcome(ns['_background_tick']), calls
    finally:
        for module, previous in saved.items():
            if previous is None:
                sys.modules.pop(module, None)
            else:
                sys.modules[module] = previous


@pytest.mark.parametrize('where', ['set_kind', 'enter', 'pass', 'renew', 'release'])
@pytest.mark.parametrize('make', [lambda: SystemExit(3), lambda: WeirdExit(1), lambda: ConfigBackendUnavailable(1)], ids=['plain', 'other-name', 'outage'])
def test_the_tick_returns_whichever_call_a_SystemExit_comes_from(where, make):
    outcome, calls = _tick(where, make())
    assert outcome == ('returned', None), (where, outcome, calls)


def test_a_failing_pass_whose_lease_release_then_exits_still_returns_and_the_next_tick_runs():
    """The `finally` gives the lease up for a pass that raised: an exit from `release()` replaces the pass's own error, and the tick still returns (mislabelled as a stopped pass, harmless)."""
    outcome, calls = _tick('release', SystemExit(1), pass_raises=RuntimeError('boom'))
    assert outcome == ('returned', None) and calls[-1] == 'release'
    outcome, calls = _tick('none', SystemExit(1))
    assert outcome == ('returned', None) and calls[-1] == 'renew'


# ======================================================================== the fixes of the four findings, each with its mutation =======================================================
BOUNDARY_MUTATIONS = {
    'a generator function is wrapped': [('inspect.iscoroutinefunction(f) or inspect.isgeneratorfunction(f) or inspect.isasyncgenfunction(f)', 'inspect.iscoroutinefunction(f) or inspect.isasyncgenfunction(f)')],
    'an async generator function is wrapped': [('inspect.iscoroutinefunction(f) or inspect.isgeneratorfunction(f) or inspect.isasyncgenfunction(f)', 'inspect.iscoroutinefunction(f) or inspect.isgeneratorfunction(f)')],
    'an async __call__ is wrapped': [("for f in (fn, getattr(fn, '__call__', None))", 'for f in (fn,)')],
    'an async def is wrapped': [('inspect.iscoroutinefunction(f) or inspect.isgeneratorfunction(f) or inspect.isasyncgenfunction(f)', 'inspect.isgeneratorfunction(f) or inspect.isasyncgenfunction(f)')],
}


async def _coro():
    raise SystemExit(9)


@pytest.mark.parametrize('label', sorted(BOUNDARY_MUTATIONS))
def test_each_convert_mutation_is_caught(label):
    edits = BOUNDARY_MUTATIONS[label]
    boundary(edits)                                                                             # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        for fn in (_coro, _gen, _agen, AsyncCallable()):                                        # the four things a call cannot protect: one of them goes through
            convert_refuses(fn, edits)


REFUSAL_MUTATIONS = {
    'config_write_refusal can raise': ('code', [('            error = error.__cause__\n        except Exception:  # noqa: BLE001\n            return None', '            error = error.__cause__\n        except KeyError:  # noqa: BLE001\n            return None')]),
    'a hostile path hides the lock': ('path', [('        except Exception:  # noqa: BLE001  (a `path` that raises', '        except KeyError:  # noqa: BLE001  (a `path` that raises')]),
}


@pytest.mark.parametrize('label', sorted(REFUSAL_MUTATIONS))
def test_each_refusal_reading_mutation_is_caught(label):
    attribute, edits = REFUSAL_MUTATIONS[label]
    boundary(edits)
    with pytest.raises(BaseException):  # noqa: B017
        refusal_never_raises(attribute, edits)


@pytest.mark.parametrize('label,edit', [
    ('the refusal is swallowed', ('if hermes_boundary.config_write_refusal(error) is not None:', 'if False:')),
    ('every failure is let through', ('if hermes_boundary.config_write_refusal(error) is not None:', 'if True:')),
])
@pytest.mark.parametrize('error', [lambda: ConfigLockedError('config_key_locked', 'skills.disabled'), lambda: ConfigWriteError('config_write_failed')], ids=['locked', 'failed'])
def test_each_skill_toggle_mutation_is_caught(skills_hermes, label, edit, error):
    skills_load(edit)                                                                           # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        toggle_says_the_refusal(skills_hermes, error, edit)


@pytest.mark.parametrize('label,edit', [
    ('the refusal is not read', ('            if refusal is not None:  # a write the config backend REFUSED', '            if False:  # a write the config backend REFUSED')),
    ('the key is not told', ("                    extra['details'] = {'key': refusal[1]}", '                    pass')),
    ('the status is the generic one', ('                status, code, message = refused.status, refused.code, refused.message', "                status, code, message = 502, refused.code, refused.message")),
])
def test_each_bot_creation_mutation_is_caught(timeout_hermes, label, edit):
    timeout_load(edit, module='bots')                                                           # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        locked_creation_says_so(timeout_hermes, edit)
