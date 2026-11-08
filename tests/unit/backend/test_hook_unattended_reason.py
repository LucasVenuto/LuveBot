"""F3 (Hermes main, v0.23): `hermes -z` is an unattended turn that Hermes counts as yolo (`_yolo_active()` folds in
gateway.session_finite.unattended_turn(), tools/approval.py on main). The hook blocks an `ask` nobody would be asked about (ADR-002
4.4) and says why: a real /yolo says "turn it off"; an unattended turn has nothing to turn off, so it says `unattended` and where the
Bot can be asked instead. Real hook, real built-in table, in process; Hermes's approval state is a stand-in with main's shape.
Mutations: the unattended case read as yolo again, or the words not told apart -> red."""
import sys
import types

import pytest

from test_hook_free_mode import ASKED, IDS, action, answers, rig

CHMOD = ('terminal', {'command': 'chmod 600 /tmp/x'})


def hermes_state(monkeypatch, *, frozen=False, session=False, unattended=False, mode='manual', with_session_finite=True, finite_raises=False):
    """`tools.approval` as main has it: `_yolo_active()` is the frozen CLI yolo, the session /yolo, or an unattended turn."""
    approval = types.ModuleType('tools.approval')
    approval._YOLO_MODE_FROZEN = frozen
    approval.is_current_session_yolo_enabled = lambda: session

    def yolo_active():
        if frozen or session:
            return True
        return bool(sys.modules['gateway.session_finite'].unattended_turn()) if with_session_finite else False
    approval._yolo_active = yolo_active
    approval._presence = lambda _callback=None: (None, False, True, False)      # a person is present: no unattended-approve case
    approval._unattended_contexts = lambda: []
    context = types.ModuleType('tools.approval_context')
    context._get_approval_mode = lambda: mode
    package = types.ModuleType('tools')
    package.approval, package.approval_context = approval, context
    monkeypatch.setitem(sys.modules, 'tools', package)
    monkeypatch.setitem(sys.modules, 'tools.approval', approval)
    monkeypatch.setitem(sys.modules, 'tools.approval_context', context)
    if with_session_finite:
        finite = types.ModuleType('gateway.session_finite')

        def unattended_turn():
            if finite_raises:
                raise RuntimeError('unreadable')
            return unattended
        finite.unattended_turn = unattended_turn
        monkeypatch.setitem(sys.modules, 'gateway', types.ModuleType('gateway'))
        monkeypatch.setitem(sys.modules, 'gateway.session_finite', finite)
    else:
        monkeypatch.delitem(sys.modules, 'gateway.session_finite', raising=False)


@pytest.mark.parametrize('state,why', [
    (dict(session=True), 'yolo'), (dict(frozen=True), 'yolo'),                       # a real /yolo or --yolo: the owner can turn it off
    (dict(unattended=True), 'unattended'),                                           # `hermes -z`: nothing to turn off
    (dict(unattended=True, session=True), 'yolo'), (dict(unattended=True, frozen=True), 'yolo'),   # a real yolo is said first
    (dict(session=True, with_session_finite=False), 'yolo'),                         # a Hermes without that module: only ever yolo
    (dict(unattended=True, with_session_finite=False), None),                        # (and there `-z` is not yolo at all)
    (dict(session=True, finite_raises=True), 'yolo'),                                # unreadable: the older, cautious wording
    (dict(mode='off'), 'approvals_off'), (dict(mode='off', unattended=True), 'unattended'),   # yolo is judged before mode off
    ({}, None),
])
def test_the_bypass_reason_tells_an_unattended_turn_from_a_yolo(tmp_path, monkeypatch, state, why):
    plugin, _store, _db = rig(tmp_path, real_bypass=True)
    hermes_state(monkeypatch, **state)
    assert plugin._approvals_bypassed() == why


def test_an_ask_in_an_unattended_turn_is_blocked_with_its_own_words(tmp_path, monkeypatch):
    plugin, _store, _db = rig(tmp_path, real_bypass=True)
    call = plugin._make_hook('p')
    hermes_state(monkeypatch, unattended=True)
    blocked = {k: call(tool, args, **IDS) for k, (tool, args) in ASKED.items()}
    for name, answer in blocked.items():
        assert action(answer) == 'block' and 'luvebot:approvals_bypassed:unattended:' in answer['message'], (name, answer)
        assert 'sem ninguém para aprovar' in answer['message'] and 'numa conversa com o Bot' in answer['message']
        assert '/yolo' not in answer['message'] and 'approvals.mode off' not in answer['message']
    hermes_state(monkeypatch, session=True)
    said = call(*CHMOD, **IDS)['message']
    assert 'approvals_bypassed:yolo:' in said and 'sem /yolo nem approvals.mode off' in said     # the yolo words are unchanged
    hermes_state(monkeypatch)
    assert action(call(*CHMOD, **IDS)) == 'approve'                                              # an attended turn still asks


def test_a_free_bot_is_not_blocked_in_an_unattended_turn_either(tmp_path, monkeypatch):
    plugin, _store, db = rig(tmp_path, real_bypass=True)
    _store.put_surface(db, 'p', 'free', [], 'basic:ceo')
    hermes_state(monkeypatch, unattended=True)
    assert answers(plugin._make_hook('p'), ASKED) == dict.fromkeys(ASKED)


MUTATIONS = [
    ('unattended read as yolo again', '            return "unattended" if _only_unattended_turn(approval) else "yolo"', '            return "yolo"'),
    ('every yolo read as unattended', '            return "unattended" if _only_unattended_turn(approval) else "yolo"', '            return "unattended"'),
    ('a real yolo hidden by an unattended turn', '        return not (getattr(approval, "_YOLO_MODE_FROZEN", False) or approval.is_current_session_yolo_enabled())',
     '        return True'),
    ('the unattended words are the yolo words', '    if why == "unattended":', '    if False:'),
]


@pytest.mark.parametrize('label,old,new', MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_the_mutations_are_caught(tmp_path, monkeypatch, label, old, new):
    plugin, _store, _db = rig(tmp_path, edit=(old, new), real_bypass=True)   # outside `raises`: the anchor must still match
    call = plugin._make_hook('p')
    with pytest.raises(AssertionError):
        for state, why in ((dict(unattended=True), 'unattended'), (dict(session=True), 'yolo'), (dict(unattended=True, session=True), 'yolo')):
            hermes_state(monkeypatch, **state)
            assert plugin._approvals_bypassed() == why
            answer = call(*CHMOD, **IDS)
            assert f'approvals_bypassed:{why}:' in answer['message']
            assert ('sem ninguém para aprovar' in answer['message']) == (why == 'unattended')
