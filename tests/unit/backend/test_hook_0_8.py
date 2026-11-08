"""Hook 0.8.0 (contract v0.9 1.9): the message of an APPROVE verdict carries the call: `<table message>#<event id>.<nonce>`, nonce 16 hex, per call.

Hermes >= 0.22.3 (session authority) copies neither pattern_keys nor our rule_key into the request, only this message (its `description`), so the call id and the
nonce travel there too; the same tail as the rule_key. The table's message, its digest and the hook's own row are unchanged; a block is untouched; a call whose row
could not be written carries no id (LuveBot then shows the request as details_unavailable). Real hook and SQLite; the backend reads what the hook sent.
Mutations: one line of the hook changed -> red."""
import re
import sqlite3

import pytest

from test_hook_free_mode import ASKED, IDS, STOPPED, rig

RULE_MESSAGE = re.compile(r'luvebot:ask:[A-Za-z0-9_.:-]{1,128}')
TAIL = re.compile(r'#([0-9]{1,17})\.([0-9a-f]{16})')


def ask(plugin, tool='terminal', command='chmod 600 /tmp/x'):
    return plugin._make_hook('p')(tool, {'command': command}, **IDS)


def rows(db):
    conn = sqlite3.connect(db)
    try:
        return conn.execute("SELECT id, message, verdict FROM hook_events WHERE verdict='approve' ORDER BY id").fetchall()
    finally:
        conn.close()


def check_an_approve_carries_the_call(tmp_path, edit=None):
    plugin, store, db = rig(tmp_path, edit)
    first, second = ask(plugin), ask(plugin, command='rm -r /tmp/x')
    seen = []
    for answer, (event, table_message, _) in zip((first, second), rows(db)):
        assert answer['action'] == 'approve'
        base, hash_, tail = answer['message'].partition('#')
        assert RULE_MESSAGE.fullmatch(base) and base == table_message and TAIL.fullmatch('#' + tail), answer['message']   # the table's text, then the call
        found = TAIL.fullmatch('#' + tail)
        assert int(found.group(1)) == event                                                                              # the id of the hook's own row
        assert answer['rule_key'].endswith('#' + tail)                                                                   # the same tail as the key Hermes used to copy
        assert '#' not in table_message                                                                                  # the row (and the table's digest) keep the plain message
        seen.append(found.group(2))
    assert seen[0] != seen[1]                                                                                            # per call


def test_an_approve_carries_the_call_id_and_a_nonce_per_call(tmp_path):
    check_an_approve_carries_the_call(tmp_path)


def test_the_backend_reads_what_the_hook_sent(tmp_path):
    plugin, store, db = rig(tmp_path)
    import luvebot_backend.approvals as approvals
    answer = ask(plugin)
    rule, event = approvals._hook_key([], answer['message'])                                                  # no pattern_keys, as on Hermes >= 0.22.3
    assert event == rows(db)[0][0] and rule == answer['rule_key'][len('luvebot:'):].rpartition('#')[0]


def test_a_block_is_untouched_and_so_is_an_allowed_call(tmp_path):
    plugin, store, db = rig(tmp_path)
    call = plugin._make_hook('p')
    for tool, args in STOPPED.values():
        answer = call(tool, args, **IDS)
        if answer is not None:
            assert answer['action'] == 'block' and '#' not in answer['message'], answer
    assert call('terminal', {'command': 'ls -la /tmp'}, **IDS) is None


def test_a_call_whose_row_was_not_written_carries_no_id(tmp_path, monkeypatch):
    plugin, store, db = rig(tmp_path)
    monkeypatch.setattr(plugin, '_record', lambda *a, **k: None)
    answer = ask(plugin)
    assert answer['action'] == 'approve' and '#' not in answer['message'] and RULE_MESSAGE.fullmatch(answer['message'])
    assert re.fullmatch(r'luvebot:[A-Za-z0-9_.:-]+#[0-9a-f]{32}', answer['rule_key'])                                    # unique all the same, tied to nothing


def test_the_version_is_0_8_0(tmp_path):
    plugin, store, db = rig(tmp_path)
    assert plugin.PLUGIN_VERSION == '0.8.8'


MUTATIONS = {
    'the message has no call': ('                answer = f"{verdict.message}#{tail}"\n', '                answer = verdict.message\n'),
    'the nonce is the long one': ('                tail = f"{event_id}.{uuid.uuid4().hex[:16]}"\n', '                tail = f"{event_id}.{uuid.uuid4().hex}"\n'),
    'the nonce is fixed': ('                tail = f"{event_id}.{uuid.uuid4().hex[:16]}"\n', '                tail = f"{event_id}.0123456789abcdef"\n'),
    'the message carries another id': ('                answer = f"{verdict.message}#{tail}"\n', '                answer = f"{verdict.message}#0.{tail.partition(\'.\')[2]}"\n'),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_turns_its_test_red(label, tmp_path):
    with pytest.raises(AssertionError):
        check_an_approve_carries_the_call(tmp_path, MUTATIONS[label])


# ---- every form of the message of an approve carries the call (contract v0.9 1.9: the closed grammar the Box reads) ---------------------------------
def test_every_approve_form_carries_the_call_and_rules_unavailable_does_not(tmp_path, monkeypatch):
    from test_hook_free_mode import fake_kanban
    plugin, store, db = rig(tmp_path)
    call = plugin._make_hook('p')
    chmod = ('terminal', {'command': 'chmod 600 /tmp/x'})
    # (what the hook says is the case, the form of the message, the rule of the key: the ask's own, or `noncanonical` for the two origin failures)
    forms = {
        'ask': (lambda: None, r'luvebot:ask:(?P<rule>[A-Za-z0-9_.:-]+)', None),
        # the destination asks nothing (free), so the ORIGIN's own ask is what reaches a person: `luvebot:origin:<origin>:<its message>`
        'origin ask': (lambda: (store.put_surface(db, 'p', 'free', [], 'basic:ceo'), fake_kanban(monkeypatch, 'guarded')),
                       r'luvebot:origin:guarded:luvebot:ask:(?P<rule>[A-Za-z0-9_.:-]+)', None),
        'origin unverifiable': (lambda: fake_kanban(monkeypatch, 'ghost', origin_has_profile=True), r'luvebot:origin_unverifiable:ghost', 'noncanonical'),
        'origin unreadable': (lambda: fake_kanban(monkeypatch, 'guarded', readable=False), r'luvebot:origin_unreadable', 'noncanonical'),
    }
    for label, (setup, form, key_rule) in forms.items():
        setup()
        answer = call(*chmod, **IDS)
        row = rows(db)[-1]
        found = re.fullmatch(rf'({form})#(?P<id>[0-9]+)\.(?P<nonce>[0-9a-f]{{16}})', answer['message'])
        assert answer['action'] == 'approve' and found, (label, answer)
        assert int(found.group('id')) == row[0] and row[1] == found.group(1), label                           # the id of this call's own row, which keeps the plain message
        rule = key_rule or found.group('rule')
        assert answer['rule_key'] == f"luvebot:{rule}#{found.group('id')}.{found.group('nonce')}", (label, answer)   # the key the old hook sent
    monkeypatch.delenv('HERMES_KANBAN_TASK', raising=False)
    # the one that stays unlinked by design: no row, a key with a random part only
    real_table = plugin._table
    plugin._table = lambda profile: (_ for _ in ()).throw(LookupError('no table'))
    try:
        answer = call(*chmod, **IDS)
    finally:
        plugin._table = real_table
    assert answer['message'] == 'luvebot:rules_unavailable' and re.fullmatch(r'luvebot:rules_unavailable#[0-9a-f]{32}', answer['rule_key'])
