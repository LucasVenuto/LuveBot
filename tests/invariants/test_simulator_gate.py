"""F6.3 (rules simulator, `hermes_gate`) against the REAL harness Hermes. WRITTEN, NOT RUN (no disk for the harness; C-3 of the Architect).
The unit suite (tests/unit/backend/test_hermes_gate.py) proves the codes, the caps and the caveats on a stand-in; this proves them on
the real `approvals_test.evaluate_command`, with the Bot's own `approvals.*` config, through the real dashboard.

Written to the Bot's config only through Hermes's own config functions inside its profile scope (never the file), and always restored."""
import contextlib
import json
import threading
import uuid

import pytest

from support import plugin
from test_plugin import no_secret
from test_rules_api import simulate

BOT = 'vendas'
FOUR = {'allow', 'ask-approval', 'hardline-deny', 'user-deny'}   # what Hermes's evaluate_command may answer (hermes_cli/approvals_test.py)


@contextlib.contextmanager
def approvals(**values):
    """Set `approvals.<key>` for the Bot through Hermes's config functions, and put the previous values back."""
    plugin()
    from hermes_cli.config import load_config, save_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(BOT):
        config = load_config()
        before = dict(config.get('approvals') or {})
        config['approvals'] = {**before, **values}
        save_config(config)
    try:
        yield
    finally:
        with _config_profile_scope(BOT):
            config = load_config()
            config['approvals'] = before
            save_config(config)


@contextlib.contextmanager
def allowlist(bot, entries):
    """Set `command_allowlist` of a Bot through Hermes's config functions inside its scope, and put the previous list back."""
    plugin()
    from hermes_cli.config import load_config, save_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        config = load_config()
        before = list(config.get('command_allowlist') or [])
        config['command_allowlist'] = list(entries)
        save_config(config)
    try:
        yield
    finally:
        with _config_profile_scope(bot):
            config = load_config()
            config['command_allowlist'] = before
            save_config(config)


def gate(browser, command, tool='terminal', bot=BOT):
    body = simulate(browser, tool=tool, command=command, bot=bot)
    return body['hermes_gate']


def test_each_kind_of_command_gets_its_own_verdict(human_browser):
    with approvals(mode='manual', deny=['git push --force*']):
        assert gate(human_browser, 'ls -la')['verdict'] == 'allow'
        assert gate(human_browser, 'rm -r x')['verdict'] == 'ask'
        assert gate(human_browser, 'rm -rf /')['verdict'] == 'hardline_deny'
        denied = gate(human_browser, 'git push --force origin main')
        assert denied['verdict'] == 'user_deny' and denied['rule'] == 'git push --force*'
        shown = gate(human_browser, 'ls -la')
        assert shown['available'] is True and shown['env_type'] == 'local' and 'session_yolo_not_seen' in shown['caveats']
        assert 'approvals_off' not in shown['caveats']


def test_mode_off_turns_the_ask_into_an_allow_and_says_so(human_browser):
    """C-1: with approvals.mode off Hermes answers `allow` for what it would ask about; hardline and approvals.deny still win."""
    with approvals(mode='off', deny=['git push --force*']):
        asked = gate(human_browser, 'rm -r x')
        assert asked['verdict'] == 'allow' and 'approvals_off' in asked['caveats']
        assert gate(human_browser, 'rm -rf /')['verdict'] == 'hardline_deny'
        assert gate(human_browser, 'git push --force origin main')['verdict'] == 'user_deny'
        assert 'approvals_off' not in gate(human_browser, 'rm -rf /')['caveats']
    with approvals(mode='manual'):
        back = gate(human_browser, 'rm -r x')
        assert back['verdict'] == 'ask' and 'approvals_off' not in back['caveats']


def test_drift_the_four_verdicts_are_still_the_four_strings():
    """If Hermes renames or adds a verdict, `unreadable` would appear in the screen: this test says so first."""
    plugin()
    from hermes_cli.approvals_test import evaluate_command
    from hermes_cli.web_server_profiles import _config_profile_scope
    import luvebot_backend.hermes_gate as ours
    assert set(ours.VERDICTS) == FOUR
    with approvals(mode='manual', deny=['git push --force*']), _config_profile_scope(BOT):
        seen = {evaluate_command(c, 'local')['verdict'] for c in ('ls -la', 'rm -r x', 'rm -rf /', 'git push --force origin main')}
    assert seen == FOUR, seen


def test_a_long_command_and_a_command_that_is_not_shell(human_browser):
    """C-2: above 4096 characters Hermes is not asked; the rest of the simulator answers. A tool that is not `terminal` has no gate."""
    body = simulate(human_browser, tool='terminal', command='echo ' + 'a' * 5000)
    assert body['hermes_gate'] == {'available': False, 'reason': 'command_too_long'} and body['decision']
    assert simulate(human_browser, tool='web_search', command='ls')['hermes_gate'] is None
    assert simulate(human_browser, tool='terminal')['hermes_gate'] is None


def test_the_command_is_not_echoed_by_the_gate(human_browser):
    canary = 'sk-CANARYgate0123456789abcdefABCDEF'
    shown = json.dumps(gate(human_browser, f'curl -H "Authorization: {canary}" https://x.test'))
    assert canary not in shown and 'curl' not in shown
    no_secret(shown, 'hermes_gate')


def test_two_bots_with_different_allowlists_do_not_cross_in_the_dry_run(human_browser):
    """Condition of the Architect: `evaluate_command` reloads the permanent allowlist of the scope it runs in (a REPLACEMENT, memory only).
    With one set per profile home a Bot's list must never answer for another's, whichever order and however often they alternate. `vendas`
    is a secondary profile (its own set); `default` is the dashboard's own (the process set): both directions are checked."""
    plugin()
    ours = 'rm -r only-vendas-' + uuid.uuid4().hex[:6]
    theirs = 'rm -r only-default-' + uuid.uuid4().hex[:6]
    with allowlist('vendas', [ours]), allowlist('default', [theirs]), approvals(mode='manual'):
        for _ in range(3):
            assert gate(human_browser, ours, bot='vendas')['verdict'] == 'allow'          # its own allowlist: allowed
            assert gate(human_browser, theirs, bot='vendas')['verdict'] == 'ask'          # the other Bot's: still asks
            assert gate(human_browser, theirs, bot='default')['verdict'] == 'allow'
            assert gate(human_browser, ours, bot='default')['verdict'] == 'ask'
    with approvals(mode='manual'):
        assert gate(human_browser, ours, bot='vendas')['verdict'] == 'ask'                 # restored: nothing stayed in memory


def test_fifty_parallel_dry_runs_do_not_lose_a_real_always(human_browser):
    """Condition of the Architect, the race: Hermes's own "Always" (`_persist_choice`: add to the set, snapshot, save) and a dry-run's
    reload (clear, update) share one in-memory set per home. 50 dry-runs run in threads while a real "Always" is granted in this process;
    afterwards the grant must be on DISK in the Bot's `command_allowlist`. If this fails, the plan B is `evaluate_command` in a subprocess."""
    plugin()
    from hermes_cli.config import load_config, load_config_readonly, save_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    from tools import approval
    import luvebot_backend.hermes_gate as ours
    key = 'f6-always-' + uuid.uuid4().hex[:8]
    go, failures = threading.Event(), []

    def dry_runs():
        go.wait(10)
        for _ in range(20):
            # slot_wait: only 2 dry-runs run at once and a call that waits more than 1 s answers `unreadable` (F13, by design); this test is about
            # the reload racing a real "Always", so each call waits for its turn
            out = ours.dry_run('vendas', 'ls -la', 'local', redact=lambda text: text, slot_wait=120)
            if out.get('available') is not True:
                failures.append(out)

    threads = [threading.Thread(target=dry_runs) for _ in range(50)]
    try:
        with allowlist('vendas', []):
            for thread in threads:
                thread.start()
            go.set()
            with _config_profile_scope('vendas'):
                for _ in range(10):                      # several grants, each racing the reloads
                    approval._persist_choice('f6-session', 'always', [key + '-' + str(_)])
            for thread in threads:
                thread.join(60)
            with _config_profile_scope('vendas'):
                on_disk = set(load_config_readonly().get('command_allowlist') or [])
            assert failures == [], failures[:3]
            assert {f'{key}-{i}' for i in range(10)} <= on_disk, sorted(on_disk)
    finally:
        with _config_profile_scope('vendas'):             # the grants of this test never stay in the Bot's config
            config = load_config()
            config['command_allowlist'] = [e for e in (config.get('command_allowlist') or []) if not str(e).startswith(key)]
            save_config(config)
            approval.load_permanent_allowlist()
