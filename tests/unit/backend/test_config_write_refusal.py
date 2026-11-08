"""P1-4 (contract v0.10 section 1.2, "A refused write"): a write Hermes's config backend REFUSES is told as what it is, never as "Hermes is unavailable".
* `SafeRoute`: `ConfigLockedError` (`config_key_locked`) -> 409 with `details.key` (a dotted key, only when it looks like one), `ConfigValueError` (`config_value_invalid`) -> 422, `ConfigWriteError`
  (`config_write_failed`) -> 502, each in our words and with no text of the exception; any other error is as before (`hermes_unreachable`); the classes are stand-ins, recognized by NAME;
* the places that used to say "could not change" or `hermes_error` for ANY failure let a refusal through (the voice switch) or name it (the batch of approval waits);
* Pages `terminal.cwd` (`set_own_workspace`): a write refused up front sets nothing; a final check that fails puts the previous value back, and when THAT restore is refused too the answer stays the
  original one (never the restore's refusal), the folder the key still names stays, and the message says the previous setting was not put back; the audit result row says `error` in every refusal.
Mutations: one line of each changed -> red."""
import ast
import contextlib
import importlib
import re
import sqlite3
import sys
import textwrap
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_applied as applied  # noqa: E402
import test_config_boundary_threads as threads  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
HOSTILE = 'https://admin:s3cr3t@config.internal/v1?token=abc  \n<script>'


class ConfigWriteError(Exception):
    def __init__(self, code, path=None, text=HOSTILE):
        super().__init__(text)
        self.code, self.path = code, path


class ConfigLockedError(ConfigWriteError):
    pass


class ConfigValueError(ConfigWriteError):
    pass


class HTTPException(Exception):
    """The stand-in of fastapi's: what a Hermes ROUTE raises when a write is refused (`http_failure`: a lock is 403, an invalid value 400 or 413), `raise HTTPException(...) from the_refusal`."""
    def __init__(self, status_code, detail='Hermes text s3cr3t'):
        super().__init__(detail)
        self.status_code, self.detail = status_code, detail


def through_a_route(status, refusal):
    """What Hermes `main`'s `http_failure` does (_common.py#L124): `raise HTTPException(...) from exc` ONLY for the lock (403) and the invalid value (400 or 413); every other error, the GENERIC ConfigWriteError
    included, leaves as a plain `raise HTTPException(...)` inside the `except`, so its only link to the cause is `__context__` (A-172)."""
    try:
        try:
            raise refusal
        except Exception as caught:
            if isinstance(caught, (ConfigLockedError, ConfigValueError)):
                raise HTTPException(status) from caught
            raise HTTPException(status)
    except HTTPException as error:
        return error


def context_only(status, refusal):
    """The same, for ANY refusal, even a lock: a plain `raise` in the `except` with no `from`. Its only link is `__context__`, which says what was being handled, never what caused this."""
    try:
        try:
            raise refusal
        except Exception:
            raise HTTPException(status)
    except HTTPException as error:
        return error


class ConfigWriteErrorLookalike(Exception):
    code, path = 'config_key_locked', 'terminal.cwd'


def real_table():
    """The error table of backend/hermes_client.py as written (the message and status of every code), without importing Hermes."""
    text = (ROOT / 'backend' / 'hermes_client.py').read_text()
    start = text.index('_MESSAGES = {') + len('_MESSAGES = ')
    return ast.literal_eval(text[start:text.index('\n}\n', start) + 2])


TABLE = real_table()


class HermesError(Exception):
    def __init__(self, code):
        self.code = code
        self.status, self.message = TABLE[code]
        super().__init__(self.message)


# ---- the table and SafeRoute ----------------------------------------------------------------------------------------------------------------------
def test_the_error_table_has_the_three_words_of_the_contract():
    assert TABLE['config_key_locked'] == (409, 'An administrator locked this setting in Hermes, so LuveBot cannot change it.')
    assert TABLE['config_value_invalid'] == (422, 'Hermes cannot store this value.')
    assert TABLE['config_write_failed'] == (502, 'Hermes refused to store this setting.')


def route_answer(raises, edits=()):
    """What SafeRoute answers when the handler raises `raises`: (code, message, status, extra)."""
    name, _ = applied.package()
    text = API
    for old, new in edits:                                   # a refusal is read in two clauses now (an exception, an HTTPException): a mutation of the shared text changes both
        assert 1 <= text.count(old) <= 2, old
        text = text.replace(old, new)
    body = re.search(r'class SafeRoute\(APIRoute\):.*?(?=\n\ndef _unexpected)', text, re.S).group(0)

    class APIRoute:
        original = None
        path = '/bots/{bot}'

        def get_route_handler(self):
            return type(self).original

    ns = {'APIRoute': APIRoute, '_SERVED': [False], 'time': __import__('time'), '_foreign_request': lambda r: None, '_identity': lambda r: None,
          '_error': lambda code, message, status, extra=None: (code, message, status, extra), 'hermes_compat': types.SimpleNamespace(), 'run_in_threadpool': None,
          '_EPOCH': [0], '_HEADERS': {}, 'HermesError': HermesError, 'PluginError': type('PluginError', (Exception,), {}), 'BudgetUnavailable': type('BudgetUnavailable', (Exception,), {}),
          'AuditUnavailable': type('AuditUnavailable', (Exception,), {}), 'RequestValidationError': type('RequestValidationError', (Exception,), {}),
          'HTTPException': HTTPException, 'sqlite3': sqlite3, '_unexpected': lambda *a: None, 'redaction': types.SimpleNamespace(budgeted=lambda handler: handler),
          'hermes_boundary': importlib.import_module(f'{name}.hermes_boundary')}
    exec(compile(textwrap.dedent(body), 'saferoute', 'exec'), ns)

    async def original(req):
        raise raises
    APIRoute.original = staticmethod(original)
    handler = ns['SafeRoute']().get_route_handler()
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(handler(types.SimpleNamespace(method='POST', query_params={}, url=None)))
    finally:
        loop.close()


def saferoute_checks(edits=()):
    locked = route_answer(ConfigLockedError('config_key_locked', 'terminal.cwd'), edits)
    assert locked == ('config_key_locked', TABLE['config_key_locked'][1], 409, {'details': {'key': 'terminal.cwd'}}), locked
    assert route_answer(ConfigLockedError('config_key_locked', ['approvals', 'timeout']), edits)[3] == {'details': {'key': 'approvals.timeout'}}
    for path in (HOSTILE, 'https://u:p@h/x', None, 7):                                          # a key that does not look like one is never echoed: the lock is still told
        answer = route_answer(ConfigLockedError('config_key_locked', path), edits)
        assert answer[0] == 'config_key_locked' and answer[2] == 409 and answer[3] is None, answer
    assert route_answer(ConfigValueError('config_value_invalid', 'terminal.cwd'), edits) == ('config_value_invalid', 'Hermes cannot store this value.', 422, None)     # no key for a value
    assert route_answer(ConfigWriteError('config_write_failed'), edits) == ('config_write_failed', 'Hermes refused to store this setting.', 502, None)
    for answer in (route_answer(ConfigLockedError('config_key_locked', 'a.b'), edits), route_answer(ConfigWriteError('config_write_failed'), edits)):
        assert 's3cr3t' not in repr(answer) and 'config.internal' not in repr(answer) and '<script>' not in repr(answer), answer       # none of the exception's text
    for other in (ConfigWriteError('something_else'), ConfigWriteError(None), ConfigWriteErrorLookalike(), RuntimeError('x')):          # anything else is as before
        assert route_answer(other, edits)[0] == 'hermes_unreachable', other
    # through a Hermes ROUTE (V6 `update_config`, the approval wait): an HTTPException whose cause is the refusal says the same thing (Forja's C1 on `main`)
    locked = route_answer(through_a_route(403, ConfigLockedError('config_key_locked', 'voice.client_direct')), edits)
    assert locked == ('config_key_locked', TABLE['config_key_locked'][1], 409, {'details': {'key': 'voice.client_direct'}}), locked
    for status in (400, 413):
        assert route_answer(through_a_route(status, ConfigValueError('config_value_invalid', 'terminal.cwd')), edits) == ('config_value_invalid', 'Hermes cannot store this value.', 422, None), status
    assert route_answer(through_a_route(500, ConfigWriteError('config_write_failed')), edits)[:3] == ('hermes_error', 'Hermes returned an unexpected response.', 502)       # the GENERIC refusal chains with no `from`: a route cannot tell it (A-172)
    for status in (403, 400, 413, 500):                                                                             # a lock or a value that is only in `__context__`: never 409 or 422, never "an administrator locked it"
        for refusal in (ConfigLockedError('config_key_locked', 'voice.client_direct'), ConfigValueError('config_value_invalid', 'terminal.cwd'), ConfigWriteError('config_write_failed')):
            assert route_answer(context_only(status, refusal), edits)[:3] == ('hermes_error', 'Hermes returned an unexpected response.', 502), (status, refusal)
    deep = HTTPException(500)
    deep.__cause__ = RuntimeError('wrapper')
    deep.__cause__.__cause__ = ConfigLockedError('config_key_locked', 'approvals.timeout')
    assert route_answer(deep, edits)[:3] == ('config_key_locked', TABLE['config_key_locked'][1], 409)                       # a wrapper in between
    for plain in (HTTPException(403), HTTPException(500), through_a_route(403, RuntimeError('boom s3cr3t')), through_a_route(403, ConfigWriteError('something_else')), through_a_route(403, ConfigWriteErrorLookalike())):
        assert route_answer(plain, edits)[:3] == ('hermes_error', 'Hermes returned an unexpected response.', 502), plain               # no refusal in the chain: as before
    assert route_answer(HTTPException(401), edits)[:3] == ('unauthorized', 'A dashboard session is required.', 401)
    far = HTTPException(500)
    node = far
    for _ in range(6):                                                                                              # the refusal too far down a chain is not looked for (the chain is bounded)
        node.__cause__ = RuntimeError('wrapper')
        node = node.__cause__
    node.__cause__ = ConfigLockedError('config_key_locked', 'a.b')
    assert route_answer(far, edits)[0] == 'hermes_error'
    cycle = HTTPException(500)
    cycle.__cause__ = RuntimeError('x')
    cycle.__cause__.__cause__ = cycle
    assert route_answer(cycle, edits)[0] == 'hermes_error'                                                          # a cycle ends
    hostile = HTTPException(500)

    class Hostile(Exception):
        @property
        def __cause__(self):
            raise RuntimeError('SECRET')
    hostile.__cause__ = Hostile('x')
    assert route_answer(hostile, edits)[0] == 'hermes_error'
    for answer in (locked, route_answer(through_a_route(500, ConfigWriteError('config_write_failed')), edits)):
        assert 's3cr3t' not in repr(answer) and 'Hermes text' not in repr(answer), answer                           # none of Hermes's text


def test_safe_route_tells_a_refused_write_as_what_it_is():
    saferoute_checks()


SAFEROUTE_MUTATIONS = {
    'the cause of an HTTPException is not read': [("                refusal = hermes_boundary.config_write_refusal(error)\n                if refusal is not None:  # a write Hermes's config backend refused, through a Hermes ROUTE", "                refusal = None\n                if refusal is not None:  # a write Hermes's config backend refused, through a Hermes ROUTE")],
    'an HTTPException with a refusal is the generic answer': [("                if refusal is not None:  # a write Hermes's config backend refused, through a Hermes ROUTE", "                if False:  # a write Hermes's config backend refused, through a Hermes ROUTE")],
    'a 401 is read as a refusal': [("                if error.status_code == 401:\n                    return _error('unauthorized', 'A dashboard session is required.', 401)\n                refusal =", "                refusal =")],
    'the clause is gone': [('                refusal = hermes_boundary.config_write_refusal(error)\n', '                refusal = None\n')],
    'the status is the old one': [('                    return _error(code, refused.message, refused.status,', '                    return _error(code, refused.message, 503,')],
    'the key is always sent': [("{'details': {'key': key}} if key else None)", "{'details': {'key': key}})")],
    'the exception text is sent': [('return _error(code, refused.message, refused.status,', 'return _error(code, str(error), refused.status,')],
    'the code is the generic one': [('return _error(code, refused.message, refused.status,', "return _error('hermes_unreachable', refused.message, refused.status,")],
}


@pytest.mark.parametrize('label', sorted(SAFEROUTE_MUTATIONS))
def test_each_saferoute_mutation_is_caught(label):
    assert all(1 <= API.count(old) <= 2 for old, _ in SAFEROUTE_MUTATIONS[label]), label        # an anchor that moved fails HERE
    with pytest.raises(AssertionError):
        saferoute_checks(SAFEROUTE_MUTATIONS[label])


# ---- the voice switch and the batch of waits -------------------------------------------------------------------------------------------------------
def audit_rows(path):
    conn = sqlite3.connect(path)
    try:
        return [(action, outcome) for action, outcome in conn.execute('SELECT action, outcome FROM audit_log ORDER BY id')]
    finally:
        conn.close()


def voice_checks(tmp_path, edits=()):
    name, _ = threads.package()
    voice = threads.variant(name, 'voice', edits)
    audit = importlib.import_module(f'{name}.audit').AuditLog(tmp_path / f'v{next(threads._n)}.db')

    class Hermes:
        def __init__(self, raises):
            self.raises, self.value = raises, True

        def client_direct(self, bot):
            return self.value

        def client_direct_off(self, bot):
            raise self.raises
    for refusal in (ConfigLockedError('config_key_locked', 'voice.client_direct'), ConfigValueError('config_value_invalid'), ConfigWriteError('config_write_failed')):
        with pytest.raises(type(refusal)) as got:
            voice.client_direct_off(audit, Hermes(refusal), 'actor', 'vendas', 'req_1')
        assert got.value is refusal                                                              # the refusal itself: SafeRoute says which
    for other in (RuntimeError('boom'), ConfigWriteError('something_else'), ConfigWriteErrorLookalike()):
        with pytest.raises(Exception) as got:
            voice.client_direct_off(audit, Hermes(other), 'actor', 'vendas', 'req_2')
        assert type(got.value).__name__ == 'PluginError' and got.value.code == 'hermes_error' and got.value.status == 502, got.value      # as before
    assert [row for row in audit_rows(audit.path) if row[0] == 'voice.client_direct.set'][-1][1] == 'error'                                    # the result row says error


def test_the_voice_switch_lets_a_refusal_through(tmp_path):
    voice_checks(tmp_path)


VOICE_MUTATIONS = {
    'a refusal is told as could-not-change': [('            if hermes_boundary.config_write_refusal(error) is not None:\n                raise', '            if False:\n                raise')],
    'every error goes through': [('            if hermes_boundary.config_write_refusal(error) is not None:\n                raise', '            if True:\n                raise')],
}


@pytest.mark.parametrize('label', sorted(VOICE_MUTATIONS))
def test_each_voice_mutation_is_caught(label, tmp_path):
    threads.variant(threads.package()[0], 'voice', VOICE_MUTATIONS[label])
    with pytest.raises(BaseException):  # noqa: B017
        voice_checks(tmp_path, VOICE_MUTATIONS[label])


def batch_checks(tmp_path, edits=()):
    name, _ = threads.package()
    controls = threads.variant(name, 'bot_controls', edits)
    plugin_error = importlib.import_module(f'{name}.api_errors').PluginError
    errors = {'a': ConfigLockedError('config_key_locked', 'approvals.timeout'), 'b': ConfigValueError('config_value_invalid'), 'c': ConfigWriteError('config_write_failed'),
              'd': RuntimeError('boom'), 'e': ConfigWriteError('something_else'), 'f': plugin_error('hermes_error', 'x', 502)}

    def set_one(audit, actor, bot, seconds, ref):
        if bot in errors:
            raise errors[bot]
        return {'seconds': seconds}
    controls.set_approval_timeout = set_one
    got = controls.set_approval_timeout_all(None, 'actor', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 900, 'req_1')['results']
    assert got == [{'bot': 'a', 'error': 'config_key_locked'}, {'bot': 'b', 'error': 'config_value_invalid'}, {'bot': 'c', 'error': 'config_write_failed'},
                   {'bot': 'd', 'error': 'hermes_error'}, {'bot': 'e', 'error': 'hermes_error'}, {'bot': 'f', 'error': 'hermes_error'}, {'bot': 'g', 'seconds': 900}], got


def test_the_batch_of_waits_names_a_refused_write_for_that_bot(tmp_path):
    batch_checks(tmp_path)


def test_each_batch_mutation_is_caught(tmp_path):
    edits = [("results.append({'bot': bot, 'error': refusal[0] if refusal else 'hermes_error'})", "results.append({'bot': bot, 'error': 'hermes_error'})")]
    threads.variant(threads.package()[0], 'bot_controls', edits)
    with pytest.raises(AssertionError):
        batch_checks(tmp_path, edits)


# ---- Pages: terminal.cwd ---------------------------------------------------------------------------------------------------------------------------
def workspace_run(tmp_path, *, first=None, restore=None, kept='ready', previous=None, edits=()):
    """`set_own_workspace` against stand-ins for Hermes's config reader and writer. `first`: what the write of the new folder raises; `restore`: what the put-back raises; `kept`: the state the final
    check finds after the write. -> (outcome, cwd now or None, folder exists, the calls the writer got, the audit rows)."""
    name, _ = threads.package()
    pages = threads.variant(name, 'pages', edits)
    home = tmp_path / f'home{next(threads._n)}'
    home.mkdir()
    own = str(home / 'workspace')
    state = {'cwd': previous, 'written': False}
    calls = []

    def set_config_value(key, value):
        calls.append(('set', value))
        if value == own:
            if first is not None:
                raise first
            state['written'] = True
        elif restore is not None:
            raise restore
        state['cwd'] = value

    def unset_config_value(key):
        calls.append(('unset', None))
        if restore is not None:
            raise restore
        state['cwd'] = None
    config = types.ModuleType('hermes_cli.config')
    config.load_config = lambda: {'terminal': {}}
    config.read_raw_config = lambda: {'terminal': {'cwd': state['cwd']}} if state['cwd'] is not None else {}
    config.set_config_value, config.unset_config_value = set_config_value, unset_config_value
    profiles = types.ModuleType('hermes_cli.web_server_profiles')
    profiles._config_profile_scope = lambda bot: contextlib.nullcontext()
    constants = types.ModuleType('hermes_constants')
    constants.get_hermes_home = lambda: str(home)
    saved = {m: sys.modules.get(m) for m in ('hermes_cli', 'hermes_cli.config', 'hermes_cli.web_server_profiles', 'hermes_constants')}
    sys.modules.update({'hermes_cli': types.ModuleType('hermes_cli'), 'hermes_cli.config': config, 'hermes_cli.web_server_profiles': profiles, 'hermes_constants': constants})
    pages.workspace = lambda bot: (kept, None) if state['written'] else ('no_workspace', None)
    audit = importlib.import_module(f'{name}.audit').AuditLog(tmp_path / f'w{next(threads._n)}.db')
    try:
        result = threads.outcome(lambda: pages.set_own_workspace(audit, 'actor', 'vendas', 'req_1'))
    finally:
        for module, previous_module in saved.items():
            if previous_module is None:
                sys.modules.pop(module, None)
            else:
                sys.modules[module] = previous_module
    return result, state['cwd'], Path(own).is_dir(), calls, audit_rows(audit.path), own


def workspace_checks(tmp_path, edits=()):
    # the write goes through, the check finds it: as before
    result, cwd, folder, calls, rows, own = workspace_run(tmp_path, edits=edits)
    assert result == ('returned', 'ready') and cwd == own and folder and rows[-1] == ('bot.workspace.set', 'ok'), (result, rows)
    # the write is refused up front (a lock above): nothing was set, the refusal itself goes up (SafeRoute answers 409 with the key), the audit result says error
    refusal = ConfigLockedError('config_key_locked', 'terminal.cwd')
    result, cwd, _folder, calls, rows, own = workspace_run(tmp_path, first=refusal, edits=edits)
    assert result == ('raised', refusal) and cwd is None and calls == [('set', own)] and rows[-1] == ('bot.workspace.set', 'error'), (result, calls, rows)
    # the write is kept by nobody (the check fails) and the previous state is put back: unset when there was none, the old folder when there was one; the folder made here goes
    result, cwd, folder, calls, rows, own = workspace_run(tmp_path, kept='broken', edits=edits)
    assert result[0] == 'raised' and result[1].code == 'hermes_error' and result[1].status == 502 and 'nothing was changed' in result[1].message, result
    assert cwd is None and not folder and calls == [('set', own), ('unset', None)] and rows[-1] == ('bot.workspace.set', 'error'), (cwd, folder, calls, rows)
    result, cwd, folder, calls, rows, own = workspace_run(tmp_path, kept='broken', previous='/old', edits=edits)
    assert result[0] == 'raised' and cwd == '/old' and calls == [('set', own), ('set', '/old')] and not folder, (result, cwd, calls)
    # the restore is refused too: the answer is still the ORIGINAL one (never the restore's refusal), the folder the key now names stays, and the words do not say "nothing was changed"
    for restore in (ConfigLockedError('config_key_locked', 'terminal.cwd'), ConfigWriteError('config_write_failed'), RuntimeError('boom')):
        result, cwd, folder, calls, rows, own = workspace_run(tmp_path, kept='broken', restore=restore, edits=edits)
        error = result[1]
        assert result[0] == 'raised' and type(error).__name__ == 'PluginError' and error.code == 'hermes_error' and error.status == 502, (restore, result)
        assert 'nothing was changed' not in error.message and 'would not put the previous setting back' in error.message and 's3cr3t' not in error.message, error.message
        assert cwd == own and folder and rows[-1] == ('bot.workspace.set', 'error'), (restore, cwd, folder, rows)


def test_pages_terminal_cwd_never_answers_the_restore_and_never_drops_a_folder_the_key_names(tmp_path):
    workspace_checks(tmp_path)


WORKSPACE_MUTATIONS = {
    'the restore refusal is the answer': [('            except Exception:  # noqa: BLE001  (the restore is refused too', '            except KeyError:  # noqa: BLE001  (the restore is refused too')],
    'the folder goes though the key names it': [('            if made and restored:', '            if made:')],
    'the message claims nothing changed': [("'Hermes did not keep the working folder; nothing was changed.' if restored", "'Hermes did not keep the working folder; nothing was changed.' if True")],
    'the previous value is not put back': [("                        set_config_value('terminal.cwd', previous)\n                restored = True", "                        pass\n                restored = True")],
    'a restored key is told as not restored': [('                restored = True\n', '                restored = False\n')],
    'a refused write up front is swallowed': [("            set_config_value('terminal.cwd', own)\n", "            try:\n                set_config_value('terminal.cwd', own)\n            except Exception:\n                pass\n")],
}


@pytest.mark.parametrize('label', sorted(WORKSPACE_MUTATIONS))
def test_each_workspace_mutation_is_caught(label, tmp_path):
    threads.variant(threads.package()[0], 'pages', WORKSPACE_MUTATIONS[label])        # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        workspace_checks(tmp_path, WORKSPACE_MUTATIONS[label])


# ---- the chain of causes, at the boundary itself ----------------------------------------------------------------------------------------------------------
def chain(depth, refusal):
    """HTTPException -> `depth` wrappers -> the refusal: the refusal sits `depth + 1` causes down."""
    top = HTTPException(500)
    node = top
    for _ in range(depth):
        node.__cause__ = RuntimeError('wrapper')
        node = node.__cause__
    node.__cause__ = refusal
    return top


def chain_checks(edits=()):
    import test_config_boundary_threads as threads
    bd = threads.variant(threads.package()[0], 'hermes_boundary', edits) if edits else applied_boundary()
    refusal = ConfigLockedError('config_key_locked', 'voice.client_direct')
    assert bd.config_write_refusal(refusal) == ('config_key_locked', 'voice.client_direct')                       # the error itself, as before
    assert bd.config_write_refusal(through_a_route(403, refusal)) == ('config_key_locked', 'voice.client_direct')   # its effect through a Hermes route
    assert bd.config_write_refusal(chain(1, refusal)) == ('config_key_locked', 'voice.client_direct')               # a wrapper in between
    assert bd.config_write_refusal(chain(2, refusal)) == ('config_key_locked', 'voice.client_direct')               # three causes down: still looked for
    assert bd.config_write_refusal(chain(3, refusal)) is None                                                       # four down: not (the chain is bounded)
    assert bd.config_write_refusal(HTTPException(403)) is None and bd.config_write_refusal(through_a_route(403, RuntimeError('x'))) is None
    assert bd.config_write_refusal(through_a_route(500, ConfigWriteError('config_write_failed'))) is None            # the generic one has no `__cause__` through a route
    for status in (403, 400, 500):
        assert bd.config_write_refusal(context_only(status, refusal)) is None and bd.config_write_refusal(context_only(status, ConfigValueError('config_value_invalid'))) is None     # `__context__` is never read
    assert bd.config_write_refusal(through_a_route(400, ConfigValueError('config_value_invalid'))) == ('config_value_invalid', None)
    cycle = HTTPException(500)
    cycle.__cause__ = RuntimeError('x')
    cycle.__cause__.__cause__ = cycle
    assert bd.config_write_refusal(cycle) is None                                                                   # a cycle ends

    class Hostile(Exception):
        @property
        def __cause__(self):
            raise RuntimeError('SECRET')
    assert bd.config_write_refusal(Hostile('x')) is None and bd.config_write_refusal(through_a_route(500, Hostile('x'))) is None


def applied_boundary():
    import importlib
    name, _ = applied.package()
    return importlib.import_module(f'{name}.hermes_boundary')


def test_the_refusal_is_found_in_the_chain_of_causes_and_the_chain_is_bounded():
    chain_checks()


CHAIN_MUTATIONS = {
    'the cause is not read': [('            error = error.__cause__\n', '            error = None\n')],
    'the context is read': [('            error = error.__cause__\n', '            error = error.__cause__ or error.__context__\n')],
    'only the context is read': [('            error = error.__cause__\n', '            error = error.__context__\n')],
    'the chain is unbounded': [('CAUSE_DEPTH = 4', 'CAUSE_DEPTH = 400')],
    'only the first cause is read': [('CAUSE_DEPTH = 4', 'CAUSE_DEPTH = 2')],
    'the error itself is not a refusal': [('            found = _write_refusal(error)\n            if found is not None:\n                return found\n', '            found = None\n')],
}


@pytest.mark.parametrize('label', sorted(CHAIN_MUTATIONS))
def test_each_chain_mutation_is_caught(label):
    import test_config_boundary_threads as threads
    threads.variant(threads.package()[0], 'hermes_boundary', CHAIN_MUTATIONS[label])                              # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        chain_checks(CHAIN_MUTATIONS[label])
