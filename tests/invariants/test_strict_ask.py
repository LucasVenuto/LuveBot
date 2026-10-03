"""ADR-002 4.4 (red team RT21, risk R-11): an `ask` of LuveBot is never approved by NOBODY. Hermes's gate approves a plugin's
`approve` without asking anyone under a session /yolo (or CLI --yolo), with `approvals.mode: off`, or in an unattended context in
approve mode (tools/approval.py#L973-L1015). The hook reads those states in its own process and answers `block` instead, with a
clear reason, recorded as a block. Normal sessions are untouched (the approval still goes to a person).

Part 1 drives the REAL hook and Hermes's REAL approval module in-process (as test_hook.py does for RT15). Part 2 is a real run with
`approvals.mode: off` in the Bot's config. Mutations: in-process below, container tests/harness/mutate_v04.py strict_ask_off.
"""
import itertools
from pathlib import Path
import uuid

import pytest

from support import plugin
from test_approvals import ASK as ASK_PROMPT, MARK, settle
from test_bots import post
from test_hook import ASK, IDS, on_surface, s1_rig, session, wait_live

_n = itertools.count()
STRICT = ('            bypassed = _approvals_bypassed() if action == "approve" else None', '            bypassed = None')
ONLY_STRICT = ('            bypassed = _approvals_bypassed() if action == "approve" else None',
               '            bypassed = _approvals_bypassed() if action == "approve" and verdict.strict else None')
UNAVAILABLE = ('    why = _approvals_bypassed()\n    if why:  # ADR-002 4.4: nobody would be asked, so it is stopped',
               '    why = None\n    if why:  # ADR-002 4.4: nobody would be asked, so it is stopped')


def state(monkeypatch, tmp_path, *, mode='manual', bridge=True, env=None, **modes):
    """Hermes's approval context of a turn: its config (approvals.mode and any `<context>_mode`), the API Server's approval bridge
    (HERMES_EXEC_ASK, as the gateway sets it) and the turn's own variables (cron, single query, platform). -> the session key."""
    home = tmp_path / f'home{next(_n)}'
    home.mkdir()
    (home / 'config.yaml').write_text('approvals:\n  mode: %s\n  timeout: 5\n' % mode + ''.join(f'  {k}: {v}\n' for k, v in modes.items()))
    monkeypatch.setenv('HERMES_HOME', str(home))
    on_surface(monkeypatch, {})
    for var in ('HERMES_EXEC_ASK', 'HERMES_INTERACTIVE', 'HERMES_CRON_SESSION', 'HERMES_SINGLE_QUERY_SESSION'):
        monkeypatch.delenv(var, raising=False)
    if bridge:
        monkeypatch.setenv('HERMES_EXEC_ASK', '1')
    for var, value in (env or {}).items():
        monkeypatch.setenv(var, value)
    key = 'agent:main:api_server:rt21-' + uuid.uuid4().hex[:8]
    monkeypatch.setenv('HERMES_SESSION_KEY', key)
    return key


def checks(module, db, store, monkeypatch, tmp_path):
    from tools import approval
    hook = module._make_hook('p')
    state(monkeypatch, tmp_path)                                               # a normal API Server turn: a person decides
    assert hook(*ASK, **IDS)['action'] == 'approve'
    key = state(monkeypatch, tmp_path)
    approval.enable_session_yolo(key)                                          # the session's /yolo
    try:
        directive = hook(*ASK, **IDS)
        assert directive['action'] == 'block' and 'approvals_bypassed:yolo' in directive['message'], directive
        assert store.events(db, 'p', 1)[0]['verdict'] == 'block'               # recorded as what it was: a block
        # counter-proof on the REAL gate: under /yolo Hermes approves a plugin approval with nobody asked
        assert approval.request_tool_approval(ASK[0], 'x', rule_key='luvebot:rt21#x').get('approved') is True
        module._db = lambda: Path('/proc/no/such/dir/x.db')                    # rules unreadable: the fail-closed answer too
        assert module._make_hook('p')(*ASK, **IDS)['action'] == 'block'
    finally:
        approval.disable_session_yolo(key)
        module._db = lambda: db
    state(monkeypatch, tmp_path, mode='off')                                   # approvals.mode: off
    directive = hook(*ASK, **IDS)
    assert directive['action'] == 'block' and 'approvals_bypassed:approvals_off' in directive['message'], directive
    for env, modes in (({'HERMES_CRON_SESSION': '1'}, {'cron_mode': 'approve'}),                    # a routine in approve mode
                       ({'HERMES_SINGLE_QUERY_SESSION': '1'}, {'single_query_mode': 'approve'}),   # hermes chat -q in approve mode
                       ({'HERMES_SESSION_PLATFORM': 'api_server'}, {'unattended_mode': 'approve'})):  # unattended platform, no bridge
        state(monkeypatch, tmp_path, bridge=False, env=env, **modes)
        directive = hook(*ASK, **IDS)
        assert directive['action'] == 'block' and 'approvals_bypassed:unattended_approve' in directive['message'], (env, directive)
    state(monkeypatch, tmp_path, bridge=False, env={'HERMES_CRON_SESSION': '1'}, cron_mode='deny')   # deny: Hermes refuses it itself
    directive = hook(*ASK, **IDS)
    assert directive['action'] == 'approve'
    assert approval.request_tool_approval(ASK[0], 'x', rule_key=directive['rule_key']).get('approved') is not True
    # an approve that is not an ask of this Bot (inherited from a handoff's origin, strict=False) is never left to /yolo either
    from luvebot_backend.rules import HookVerdict
    key = state(monkeypatch, tmp_path)
    approval.enable_session_yolo(key)
    real_origin = module._origin_verdict
    module._origin_verdict = lambda *_a: HookVerdict('approve', None, 'luvebot:origin_unverifiable:x', False)
    try:
        directive = module._make_hook('p')('web_search', {'query': 'x'}, **IDS)
        assert directive['action'] == 'block' and 'approvals_bypassed:yolo' in directive['message'], directive
    finally:
        module._origin_verdict = real_origin
        approval.disable_session_yolo(key)
    # Hermes's state cannot be read: fails closed
    state(monkeypatch, tmp_path)
    real_yolo = approval._yolo_active
    approval._yolo_active = lambda: (_ for _ in ()).throw(RuntimeError('unreadable'))
    try:
        directive = hook(*ASK, **IDS)
        assert directive['action'] == 'block' and 'approvals_bypassed:unreadable' in directive['message'], directive
    finally:
        approval._yolo_active = real_yolo


def test_an_ask_is_never_approved_by_nobody(tmp_path, monkeypatch):
    checks(*s1_rig(tmp_path), monkeypatch, tmp_path)


@pytest.mark.parametrize('edit', [STRICT, ONLY_STRICT, UNAVAILABLE], ids=['approve_not_checked', 'only_strict_checked', 'fail_closed_not_strict'])
def test_each_mutation_is_caught(tmp_path, monkeypatch, edit):
    rig = s1_rig(tmp_path, edit=edit)                                          # outside pytest.raises: the mutation must apply
    with pytest.raises(AssertionError):
        checks(*rig, monkeypatch, tmp_path)


def test_a_real_run_with_approvals_off_does_not_run_the_asked_command(human_browser):
    plugin()
    from hermes_cli.config import set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    MARK.unlink(missing_ok=True)
    with _config_profile_scope('vendas'):
        set_config_value('approvals.mode', 'off')
    try:
        wait_live(human_browser, 'vendas')
        started = post(human_browser, '/bots/vendas/runs', {'input': ASK_PROMPT, 'session_id': session(human_browser, 'vendas')})
        assert started.status == 202, started.text()
        assert settle(human_browser, started.json()['run']['id'])['status'] == 'completed'
        assert not MARK.exists(), 'with approvals off, the asked command ran with nobody asked'
    finally:
        with _config_profile_scope('vendas'):
            set_config_value('approvals.mode', 'manual')
        MARK.unlink(missing_ok=True)
