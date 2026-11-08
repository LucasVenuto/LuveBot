"""F6.3 (rules simulator, Hermes's own gate, backend/hermes_gate.py): the dry-run says what Hermes would do, in codes, never in Hermes's
free text, inside the Bot's scope, and never raises. `evaluate_command` is a stand-in with the shape of hermes_cli/approvals_test.py
(v0.22.2); the REAL one runs in the harness. Every invariant also runs against variants of hermes_gate.py with one defect each."""
import contextlib
import json
import re
import sys
import types
from pathlib import Path

import pytest

import backend.hermes_gate as real

SRC = Path(real.__file__).parent
ROOT = SRC.parent
CANARY = 'sk-CANARYgate0123456789abcdef'


def redact(text):
    return text.replace(CANARY, '***')


def hermes(verdict, rule=None, **extra):
    return {'command': 'x', 'env_type': 'local', 'verdict': verdict, 'exit_code': 0, 'rule': rule,
            'detail': f'free text from Hermes {CANARY}', 'normalized_variants': [f'ls {CANARY}'], **extra}


class Scope:
    """Records the Bot whose scope is open while evaluate runs."""

    def __init__(self):
        self.open, self.entered, self.seen = None, [], []

    @contextlib.contextmanager
    def __call__(self, bot):
        self.entered.append(bot)
        self.open = bot
        try:
            yield
        finally:
            self.open = None

    def evaluate(self, result):
        def evaluate(command, env_type):
            self.seen.append((self.open, command, env_type))
            return result
        return evaluate


def call(mod, bot='vendas', command='ls', env='local', **kw):  # kw: scope, evaluate, approvals_mode, redact
    """A defect that raises must read as a failed invariant, not as an error of the test."""
    try:
        return mod.dry_run(bot, command, env, redact=kw.pop('redact', redact), **kw)
    except Exception as error:  # noqa: BLE001
        raise AssertionError(f'dry_run raised {type(error).__name__}') from None


# ---- invariants ---------------------------------------------------------------------------------------------------------------

def inv_each_verdict_has_its_own_code(mod):
    for hermes_word, ours in (('allow', 'allow'), ('ask-approval', 'ask'), ('hardline-deny', 'hardline_deny'), ('user-deny', 'user_deny')):
        out = call(mod, scope=Scope(), evaluate=Scope().evaluate(hermes(hermes_word, 'a rule')))
        assert out['available'] is True and out['verdict'] == ours and out['rule'] == 'a rule', hermes_word


def inv_no_free_text_from_hermes(mod):
    out = call(mod, scope=Scope(), evaluate=Scope().evaluate(hermes('hardline-deny', f'rm -rf {CANARY}')))
    text = json.dumps(out)
    assert CANARY not in text and 'free text' not in text and 'normalized' not in text and 'detail' not in text
    assert set(out) == {'available', 'verdict', 'rule', 'env_type', 'caveats'} and out['rule'] == 'rm -rf ***'
    assert len(call(mod, scope=Scope(), evaluate=Scope().evaluate(hermes('ask-approval', 'x' * 500)))['rule']) == 160
    assert call(mod, scope=Scope(), evaluate=Scope().evaluate(hermes('allow')))['rule'] is None


def inv_runs_inside_the_bots_scope(mod):
    scope = Scope()
    call(mod, bot='suporte', command='git status', env='ssh', scope=scope, evaluate=scope.evaluate(hermes('allow')))
    assert scope.entered == ['suporte'] and scope.seen == [('suporte', 'git status', 'ssh')]


def inv_it_never_raises_and_never_guesses(mod):
    def boom(command, env_type):
        raise RuntimeError(f'cannot read {CANARY}')
    for evaluate in (boom, lambda c, e: None, lambda c, e: {'verdict': 'brand-new-verdict'}, lambda c, e: {}):
        out = call(mod, scope=Scope(), evaluate=evaluate)
        assert out == {'available': False, 'reason': 'unreadable'}, out

    def broken_scope(bot):
        raise RuntimeError(CANARY)
    out = call(mod, scope=broken_scope, evaluate=Scope().evaluate(hermes('allow')))
    assert out == {'available': False, 'reason': 'unreadable'} and CANARY not in json.dumps(out)


def inv_an_old_hermes_says_so(mod):
    saved = {k: sys.modules.get(k) for k in ('hermes_cli.approvals_test',)}
    sys.modules['hermes_cli.approvals_test'] = None  # an import of it raises ImportError
    try:
        out = call(mod, scope=Scope())
    finally:
        for k, v in saved.items():
            sys.modules.pop(k, None) if v is None else sys.modules.__setitem__(k, v)
    assert out == {'available': False, 'reason': 'hermes_without_dry_run'}


def inv_what_it_cannot_see_is_said(mod):
    local = call(mod, env='local', scope=Scope(), evaluate=Scope().evaluate(hermes('allow')))
    docker = call(mod, env='docker', scope=Scope(), evaluate=Scope().evaluate(hermes('allow')))
    assert local['caveats'] == ['session_yolo_not_seen']
    assert docker['caveats'] == ['session_yolo_not_seen', 'docker_host_access_not_seen'] and docker['env_type'] == 'docker'
    assert call(mod, env=None, scope=Scope(), evaluate=Scope().evaluate(hermes('allow')))['env_type'] == 'local'


def inv_approvals_off_is_said_when_an_allow_is_only_that(mod):
    """C-1: Hermes answers `allow` in step 5 when `approvals.mode` is off; without this the screen would say "Hermes would not ask"."""
    allow = Scope().evaluate(hermes('allow'))
    off = call(mod, scope=Scope(), evaluate=allow, approvals_mode='off')
    assert off['caveats'] == ['session_yolo_not_seen', 'approvals_off']
    assert call(mod, env='docker', scope=Scope(), evaluate=allow, approvals_mode='off')['caveats'] == [
        'session_yolo_not_seen', 'approvals_off', 'docker_host_access_not_seen']
    for mode in ('manual', 'smart', None):
        assert 'approvals_off' not in call(mod, scope=Scope(), evaluate=allow, approvals_mode=mode)['caveats'], mode
    for word in ('user-deny', 'hardline-deny', 'ask-approval'):  # these fire before the bypass (or need it off): not an "only because off"
        assert 'approvals_off' not in call(mod, scope=Scope(), evaluate=Scope().evaluate(hermes(word, 'r')), approvals_mode='off')['caveats'], word


def inv_the_command_is_capped(mod):
    """C-2: at most 4096 characters go to Hermes; above that the simulator answers without asking it."""
    scope = Scope()
    edge = call(mod, command='x' * 4096, scope=scope, evaluate=scope.evaluate(hermes('allow')))
    assert edge['available'] is True and len(scope.seen) == 1
    scope = Scope()
    over = call(mod, command='x' * 4097, scope=scope, evaluate=scope.evaluate(hermes('allow')))
    assert over == {'available': False, 'reason': 'command_too_long'} and scope.seen == [] and scope.entered == []
    assert mod.applies('terminal', 'x' * 4097) is True  # the engine still simulates it; only Hermes is not asked


def inv_the_command_is_never_logged_or_returned(mod):
    import logging
    records = []

    class Catch(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage() + ' ' + str(record.args) + ' ' + str(record.exc_info))
    secret = f'curl -H "Authorization: {CANARY}" https://x.test'
    root, handler = logging.getLogger(), Catch()
    root.addHandler(handler)
    level, root.level = root.level, logging.DEBUG
    try:
        def boom(command, env_type):
            raise RuntimeError(command)
        outs = [call(mod, command=secret, scope=Scope(), evaluate=Scope().evaluate(hermes('ask-approval', 'a rule'))),
                call(mod, command=secret, scope=Scope(), evaluate=boom),
                call(mod, command=secret, scope=Scope(), evaluate=Scope().evaluate({'verdict': 'new'})),
                call(mod, command=secret + 'x' * 5000, scope=Scope(), evaluate=Scope().evaluate(hermes('allow')))]
    finally:
        root.removeHandler(handler)
        root.level = level
    assert CANARY not in json.dumps(outs) and 'curl' not in json.dumps(outs)
    assert not [r for r in records if CANARY in r or 'curl' in r], records


def inv_only_a_shell_command_is_evaluated(mod):
    assert mod.applies('terminal', 'ls -la') is True
    for tool, command in (('web_search', 'ls'), ('execute_code', 'print(1)'), ('terminal', ''), ('terminal', '  \n'), ('terminal', None),
                          ('terminal', 7), ('mcp_x', 'rm -rf /')):
        assert mod.applies(tool, command) is False, (tool, command)


def inv_a_stuck_detector_cannot_take_the_whole_pool(mod):
    """Review 2, F13: Hermes's detectors are regular expressions over a person's text, in this process; a stuck one cannot be killed. At most
    MAX_CONCURRENT run at once and a call that cannot get a slot says `unreadable` quickly, so the threads of the dashboard are not all taken."""
    import threading
    import time as _time
    release, running, peak, lock = threading.Event(), [0], [0], threading.Lock()

    def stuck(command, env_type):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        release.wait(5)
        with lock:
            running[0] -= 1
        return {'verdict': 'allow', 'rule': None}
    results = []

    def one():
        results.append(mod.dry_run('vendas', 'ls', 'local', redact=redact, scope=Scope(), evaluate=stuck, slot_wait=0.05))
    threads = [threading.Thread(target=one) for _ in range(8)]
    start = _time.monotonic()
    for t in threads:
        t.start()
    _time.sleep(0.4)
    assert _time.monotonic() - start < 2 and peak[0] <= mod.MAX_CONCURRENT == 2, peak[0]
    refused = [r for r in results if r == {'available': False, 'reason': 'unreadable'}]
    assert len(refused) == 8 - mod.MAX_CONCURRENT, results                              # the others did not wait behind the stuck ones
    release.set()
    for t in threads:
        t.join(5)
    assert sum(1 for r in results if r.get('available')) == mod.MAX_CONCURRENT
    again = mod.dry_run('vendas', 'ls', 'local', redact=redact, scope=Scope(), evaluate=lambda c, e: {'verdict': 'allow', 'rule': None})
    assert again['available'] is True and peak[0] <= 2                                   # and the slots come back when a detector returns (or raises)

    def boom(command, env_type):
        raise RuntimeError('boom')
    for _ in range(mod.MAX_CONCURRENT + 3):
        assert call(mod, evaluate=boom, scope=Scope()) == {'available': False, 'reason': 'unreadable'}
    assert call(mod, evaluate=Scope().evaluate({'verdict': 'allow', 'rule': None}), scope=Scope())['available'] is True   # a failure gave its slot back


INVARIANTS = {n[4:]: f for n, f in sorted(globals().items()) if n.startswith('inv_')}

MUTATIONS = [
    ('each_verdict_has_its_own_code', 'an ask is shown as allow', "'ask-approval': 'ask'", "'ask-approval': 'allow'"),
    ('each_verdict_has_its_own_code', 'a user deny is shown as an ask', "'user-deny': 'user_deny'", "'user-deny': 'ask'"),
    ('each_verdict_has_its_own_code', 'a hardline is shown as an ask', "'hardline-deny': 'hardline_deny'", "'hardline-deny': 'ask'"),
    ('no_free_text_from_hermes', 'the detail goes out', "'env_type': env,", "'env_type': env, 'detail': result.get('detail'),"),
    ('no_free_text_from_hermes', 'the variants go out', "'env_type': env,", "'env_type': env, 'normalized_variants': result.get('normalized_variants'),"),
    ('no_free_text_from_hermes', 'the rule is not redacted', "rule = redact(str(result.get('rule') or ''))[:160] or None", "rule = str(result.get('rule') or '')[:160] or None"),
    ('no_free_text_from_hermes', 'the rule is not cut', "[:160] or None", " or None"),
    ('runs_inside_the_bots_scope', 'evaluated outside the scope', "        with scope(bot):\n            result = evaluate(command, env_type)",
     "        with scope(bot):\n            pass\n        result = evaluate(command, env_type)"),
    ('runs_inside_the_bots_scope', 'the wrong Bot', "with scope(bot):", "with scope('default'):"),
    ('it_never_raises_and_never_guesses', 'an unknown verdict becomes an allow', "VERDICTS[result['verdict']]", "VERDICTS.get(result['verdict'], 'allow')"),
    ('it_never_raises_and_never_guesses', 'a failure is not caught', "    except Exception:  # noqa: BLE001  (the class may name a path or carry the command: nothing of it is returned)\n        return {'available': False, 'reason': 'unreadable'}",
     "    except ZeroDivisionError:\n        return {'available': False, 'reason': 'unreadable'}"),
    ('it_never_raises_and_never_guesses', 'the error text is returned', "    except Exception:  # noqa: BLE001  (the class may name a path or carry the command: nothing of it is returned)\n        return {'available': False, 'reason': 'unreadable'}",
     "    except Exception as error:\n        return {'available': False, 'reason': str(error)}"),
    ('an_old_hermes_says_so', 'it is called unreadable', "'reason': 'hermes_without_dry_run'", "'reason': 'unreadable'"),
    ('what_it_cannot_see_is_said', 'the yolo caveat is dropped', "['session_yolo_not_seen'] + ", "[] + "),
    ('what_it_cannot_see_is_said', 'the docker caveat is dropped', "(['docker_host_access_not_seen'] if env == 'docker' else [])", "[]"),
    ('approvals_off_is_said_when_an_allow_is_only_that', 'the caveat is dropped', "(['approvals_off'] if verdict == 'allow' and approvals_mode == 'off' else [])", '[]'),
    ('approvals_off_is_said_when_an_allow_is_only_that', 'it is also said for a deny', "verdict == 'allow' and approvals_mode == 'off'", "approvals_mode == 'off'"),
    ('approvals_off_is_said_when_an_allow_is_only_that', 'any mode counts', "verdict == 'allow' and approvals_mode == 'off'", "verdict == 'allow' and approvals_mode != 'manual'"),
    ('the_command_is_capped', 'no cap', "    if len(command) > MAX_COMMAND:\n        return {'available': False, 'reason': 'command_too_long'}\n", ''),
    ('the_command_is_capped', 'off by one', 'if len(command) > MAX_COMMAND:', 'if len(command) >= MAX_COMMAND:'),
    ('the_command_is_capped', 'the cap is 16384', 'MAX_COMMAND = 4096', 'MAX_COMMAND = 16384'),
    ('the_command_is_capped', 'Hermes is asked anyway', "        return {'available': False, 'reason': 'command_too_long'}\n", "        evaluate and None\n"),
    ('the_command_is_never_logged_or_returned', 'the failure is logged with the command',
     "    except Exception:  # noqa: BLE001  (the class may name a path or carry the command: nothing of it is returned)\n        return {'available': False, 'reason': 'unreadable'}",
     "    except Exception:  # noqa: BLE001\n        import logging\n        logging.getLogger('x').warning('dry-run failed for %s', command)\n        return {'available': False, 'reason': 'unreadable'}"),
    ('the_command_is_never_logged_or_returned', 'the command is echoed', "{'available': True, 'verdict': verdict,", "{'available': True, 'command': command, 'verdict': verdict,"),
    ('a_stuck_detector_cannot_take_the_whole_pool', 'no limit on the detectors at once', "    if not _slots.acquire(timeout=SLOT_WAIT if slot_wait is None else slot_wait):\n        return {'available': False, 'reason': 'unreadable'}",
     "    if False:\n        return None"),
    ('a_stuck_detector_cannot_take_the_whole_pool', 'a slot is never given back', "    finally:\n        _slots.release()\n", "    finally:\n        pass\n"),
    ('a_stuck_detector_cannot_take_the_whole_pool', 'the wait is not bounded', "timeout=SLOT_WAIT if slot_wait is None else slot_wait", "timeout=None"),
    ('only_a_shell_command_is_evaluated', 'every tool is evaluated', "return tool in SHELL_TOOLS and isinstance", "return True and isinstance"),
    ('only_a_shell_command_is_evaluated', 'a blank command is evaluated', "and bool(command.strip())", ""),
]


def variant(old, new):
    text = (SRC / 'hermes_gate.py').read_text()
    assert text.count(old) == 1, old
    mod = types.ModuleType('hermes_gate_variant')
    exec(compile(text.replace(old, new), 'hermes_gate_variant', 'exec'), mod.__dict__)
    return mod


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert {inv for inv, *_ in MUTATIONS} == set(INVARIANTS)


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(invariant, label, old, new):
    mod = variant(old, new)                       # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](mod)


# ---- it only looks (invariants 4 and 6) -------------------------------------------------------------------------------------------

def test_the_module_does_not_log_at_all():
    code = (SRC / 'hermes_gate.py').read_text().split('"""', 2)[2]
    assert not re.search(r'logging|logger|print\(|warnings', code)


def test_the_docstring_tells_the_truth_about_the_allowlist_reload():
    """The Architect's condition: not "writes nothing", but what really happens (a reload of the Bot's permanent allowlist, memory only)."""
    doc = (SRC / 'hermes_gate.py').read_text().split('"""', 2)[1]
    assert 'writes nothing' not in doc
    assert 'load_permanent_allowlist' in doc and 'RELOADS' in doc and 'Memory only' in doc and 'subprocess' in doc


def test_the_dry_run_only_calls_the_official_function():
    """No approval is resolved, no allowlist or config is written, no Hermes internals are reached around the official dry-run."""
    code = (SRC / 'hermes_gate.py').read_text().split('"""', 2)[2]
    assert 'from hermes_cli.approvals_test import evaluate_command' in code
    assert not re.search(r'from tools|import tools|load_permanent|save_permanent|_persist|resolve_|approvals_native|/approval|set_config|state\.db|\.write|open\(', code)


def test_the_simulator_route_reports_the_gate_next_to_our_verdict():
    """The route adds `hermes_gate` to the simulator answer, only for a shell command, with the Bot's own terminal backend and our redactor."""
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    assert api.count('hermes_gate.dry_run(') == 1 and "'hermes_gate': gate" in api
    assert ('hermes_gate.dry_run(action.bot, action.command, state.terminal_backend, redact=_REDACT, approvals_mode=state.approvals.mode) '
            'if hermes_gate.applies(action.tool, action.command) else None') in api
