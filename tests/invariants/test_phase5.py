"""T5.4: rooms over the native Group Chat, handoffs, map and search (contract v0.3) and red team 10 and 11.

Part 1 runs the REAL backend modules in-process and the same files with ONE deliberate defect each (a mutation must turn its
invariant red). Part 2 is the REAL harness: real Group Chat, real Kanban, real hook in a worker; only the model is fake.
"""
import importlib
import itertools
import json
from pathlib import Path
import shutil
import sys

import pytest

from support import plugin

BACKEND = Path(plugin().__file__).parents[1] / 'backend'
NEEDED = ['__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'rooms.py', 'handoffs.py', 'search.py', 'rules.py', 'rules_types.py', 'rules_builtin.py']
_counter = itertools.count()


# ---------------------------------------------------------------------------------------------------------------------
# Part 1
# ---------------------------------------------------------------------------------------------------------------------
class Pkg:
    def __init__(self, name):
        self.name = name

    def __getattr__(self, module):
        return importlib.import_module(f'{self.name}.{module}')


def load(tmp_path, edit=None):
    pkg = tmp_path / f'qpkg{next(_counter)}'
    pkg.mkdir()
    for name in NEEDED:
        shutil.copy(BACKEND / name, pkg / name)
    if edit:
        hits = [f for f in pkg.glob('*.py') if f.read_text().count(edit[0]) == 1]
        assert len(hits) == 1, edit[0]
        hits[0].write_text(hits[0].read_text().replace(*edit))
    sys.path.insert(0, str(pkg.parent))
    try:
        for name in NEEDED:
            if name != '__init__.py':
                importlib.import_module(f'{pkg.name}.{name[:-3]}')
        return Pkg(pkg.name)
    finally:
        sys.path.remove(str(pkg.parent))


MEMBERS = [{'member_id': 'm1', 'bot': 'vendas', 'handle': 'Vendas'}, {'member_id': 'm2', 'bot': 'default', 'handle': 'Ops'},
           {'member_id': 'm3', 'bot': 'fin', 'handle': 'fin.ai'}]


def refuses(m, code, fn, *args, **kw):
    try:
        fn(*args, **kw)
    except m.api_errors.PluginError as error:
        assert error.code == code, f'expected {code}, got {error.code}'
        return error
    raise AssertionError(f'expected {code}')


def inv_rt10_a_message_to_a_non_member_is_refused_before_it_is_sent(m, tmp):
    r = m.rooms
    # a handle that is not a member is refused, whatever else the text says (Hermes would wake everyone instead)
    for text in ('@ghost do X', 'hello @vendas and @ghost', '@GHOST', 'ask @ops then @nobody.else:1 please'):
        error = refuses(m, 'not_a_member', r.check_send, text, MEMBERS)
        assert error.status == 422 and error.extra['details']['handles']
    assert refuses(m, 'not_a_member', r.check_send, '@ghost', MEMBERS).extra['details']['handles'] == ['ghost']
    # members are matched like Hermes does (case-insensitive, dots and colons in the handle)
    targets, stored = r.check_send('@VENDAS and @FIN.AI go', MEMBERS)
    assert [t['bot'] for t in targets] == ['vendas', 'fin'] and stored == '@VENDAS and @FIN.AI go'
    assert [t['bot'] for t in r.check_send('@all report', MEMBERS)[0]] == ['vendas', 'default', 'fin']
    assert [t['bot'] for t in r.check_send('@Everyone report', MEMBERS)[0]] == ['vendas', 'default', 'fin']
    assert len(r.check_send('no mention at all', MEMBERS)[0]) == 3
    # a coordinator takes the un-mentioned message and the stored text shows it
    targets, stored = r.check_send('no mention at all', MEMBERS, 'ops')
    assert [t['bot'] for t in targets] == ['default'] and stored == '@ops no mention at all'
    # cost: more than one target needs confirmation; the details say how much
    assert r.needs_confirmation(r.check_send('@all', MEMBERS)[0]) and not r.needs_confirmation(r.check_send('@vendas', MEMBERS)[0])
    assert r.cost_details(MEMBERS) == {'targets': ['Vendas', 'Ops', 'fin.ai'], 'max_rounds': 3, 'max_member_messages': 10}
    for bad in ('', '   ', 'x' * (64 * 1024 + 1), None):
        refuses(m, 'invalid_field', r.check_send, bad, MEMBERS)
    # a roster cannot reserve @all, repeat a handle, or name an owner who is not a member
    base = {'name': 'Sala', 'members': [{'bot': 'vendas'}, {'bot': 'default'}]}
    assert r.validate_create(base)['members'][0]['handle'] == 'vendas'
    for body in ({**base, 'members': [{'bot': 'vendas', 'handle': 'all'}, {'bot': 'default'}]},
                 {**base, 'members': [{'bot': 'vendas', 'handle': 'x'}, {'bot': 'default', 'handle': 'X'}]},
                 {**base, 'members': [{'bot': 'vendas'}]}, {**base, 'members': [{'bot': 'vendas'}, {'bot': 'vendas'}]},
                 {**base, 'owner': 'ghost'}, {**base, 'actor': 'someone'}):
        with pytest.raises(m.api_errors.PluginError):
            r.validate_create(body)
    with pytest.raises(m.api_errors.PluginError):
        r.validate_message({'text': 'x', 'event_id': 'e1', 'actor': 'bot:vendas'})            # no route accepts an actor in the body


def inv_rt11_a_handoff_is_bounded_by_both_bots(m, tmp):
    R = m.rules
    block = lambda bot, tool: R.Rule(f'r-{bot}-{tool}', 'no', R.Level.BLOCK, R.Scope(R.ScopeKind.BOT, bot), R.Match(tools=(tool,)),  # noqa: E731
                                     R.RuleState.ACTIVE, R.Origin.HUMAN, version=2, updated_by='h')
    ask = lambda bot, tool: R.Rule(f'a-{bot}-{tool}', 'ask', R.Level.ASK, R.Scope(R.ScopeKind.BOT, bot), R.Match(tools=(tool,)),  # noqa: E731
                                   R.RuleState.ACTIVE, R.Origin.HUMAN, version=2, updated_by='h')
    custom = [block('vendas', 'send_email'), block('default', 'web_search'), ask('default', 'make_report')]
    rules_for = lambda bot: [*R.builtin_rules(), *[r for r in custom if r.scope.ref == bot]]  # noqa: E731
    h = m.handoffs
    ev = lambda origin, dest, *tools: h.evaluate(rules_for, origin, dest, [{'tool': t} for t in tools])  # noqa: E731
    # origin blocked on a tool, destination allowed: refused (the laundering case)
    out = ev('vendas', 'fin', 'send_email')
    assert out['effect'] is R.Level.BLOCK and out['blocking'] == ['r-vendas-send_email'] and h.column_for(out['effect']) == 'refuse'
    # origin allowed, destination blocked: refused
    assert ev('fin', 'default', 'web_search')['effect'] is R.Level.BLOCK
    # an ask on either side lands in triage, a human promotes it
    assert h.column_for(ev('vendas', 'default', 'make_report')['effect']) == 'triage'
    assert h.column_for(ev('default', 'vendas', 'make_report')['effect']) == 'triage'
    # nothing in the way: ready; the worst of several actions decides
    assert h.column_for(ev('fin', 'vendas', 'web_search')['effect']) == 'ready' and h.column_for(ev('fin', 'vendas')['effect']) == 'ready'
    assert ev('vendas', 'default', 'make_report', 'send_email')['effect'] is R.Level.BLOCK
    # both Bots of a handoff in a room must be members of it
    members = [{'bot': 'vendas'}, {'bot': 'default'}]
    h.check_room(members, 'vendas', 'default', 'room-1')
    for pair in (('vendas', 'fin'), ('fin', 'vendas'), ('fin', 'ops')):
        refuses(m, 'not_a_member', h.check_room, members, pair[0], pair[1], 'room-1')
    for body in ({'from': 'a', 'to': 'a', 'title': 't'}, {'from': 'a', 'to': 'b'}, {'from': 'a', 'to': 'b', 'title': 't', 'created_by': 'c'},
                 {'from': 'a', 'to': 'b', 'title': 't', 'requested': [{'tool': ''}]}):
        with pytest.raises(m.api_errors.PluginError):
            h.validate_create(body)


def inv_map_search_and_handoff_rows_are_honest(m, tmp):
    h, s = m.handoffs, m.search
    rows = [{'id': 'h1', 'from_bot': 'a', 'to_bot': 'b', 'created_at': 1000.0, 'state': 'completed'},
            {'id': 'h2', 'from_bot': 'a', 'to_bot': 'b', 'created_at': 2000.0, 'state': 'running'},
            {'id': 'h3', 'from_bot': 'b', 'to_bot': 'a', 'created_at': 10.0, 'state': 'open'}]
    edges = h.edges(rows, since=500.0)
    assert [(e['from'], e['to'], e['count'], e['live']) for e in edges] == [('a', 'b', 2, True)]   # the old one is outside the window
    assert edges[0]['handoff_ids'] == ['h1', 'h2'] and edges[0]['last_at'] == 2000.0
    assert h.task_state('triage') == 'needs_review' and h.task_state('done') == 'completed' and h.task_state('archived') == 'cancelled'
    assert s.validate('  hello ', None, 8) == ('hello', s.DEFAULT_TYPES) and s.validate('x', 'messages,bots', 5)[1] == ('messages', 'bots')
    for bad in (('', None, 8), ('x' * 201, None, 8), ('x', 'nope', 8), ('x', None, 0), ('x', None, 26)):
        with pytest.raises(m.api_errors.PluginError):
            s.validate(*bad)
    assert 'files' not in s.DEFAULT_TYPES
    assert s.query_digest('abc')['len'] == 3 and 'abc' not in json.dumps(s.query_digest('abc'))
    hit = s.hit('vendas', {'session_id': 's1', 'snippet': 'the key is sk-SECRET', 'title': 'Group: room-9', 'session_started': 5}, lambda t: t.replace('sk-SECRET', '[redacted]'))
    assert 'SECRET' not in hit['snippet'] and hit['links'] == {'room_id': 'room-9'}
    assert [x['id'] for x in s.substring([{'id': 1, 'name': 'Vendas Brasil'}, {'id': 2, 'name': 'Ops'}], 'brasil', ('name',), 5)] == [1]
    assert [x['at'] for x in s.interleave([{'at': 1}, {'at': 3}, {'at': 2}], 2)] == [3, 2]


def inv_s09_handoffs_are_ingested_with_a_cursor_and_every_transition_is_audited(m, tmp):
    h, db = m.handoffs, tmp / 'h.db'
    audit = m.audit.AuditLog(db)
    tasks = [{'id': 't1', 'title': 'x', 'assignee': 'b', 'created_by': 'a', 'status': 'ready', 'created_at': 1000}]
    count = lambda action: __import__('sqlite3').connect(db).execute("SELECT count(*) FROM audit_log WHERE action=? AND detail='result'", (action,)).fetchone()[0]  # noqa: E731
    assert h.ingest(db, audit, ['a', 'b'], lambda: tasks) == ['t1']
    assert h.ingest(db, audit, ['a', 'b'], lambda: tasks) == []                                  # the second pass adds nothing
    assert count('handoff.created') == 1 and count('handoff.unrecorded') == 1                    # no hook row for it: the alert, once
    tasks.append({'id': 't2', 'title': 'y', 'assignee': 'a', 'created_by': 'b', 'status': 'ready', 'created_at': 2000})
    tasks.append({'id': 'old', 'title': 'z', 'assignee': 'b', 'created_by': 'a', 'status': 'ready', 'created_at': 5})   # behind the cursor
    assert h.ingest(db, audit, ['a', 'b'], lambda: tasks) == ['t2']
    tasks.append({'id': 'human', 'title': 'h', 'assignee': 'b', 'created_by': 'dashboard', 'status': 'ready', 'created_at': 3000})
    assert h.ingest(db, audit, ['a', 'b'], lambda: tasks) == []                                  # a person's task is not a handoff between Bots
    # transitions are persisted by the watcher, each one audited; reading a handoff changes nothing
    status = {'t1': 'running', 't2': 'ready'}
    read = lambda task_id: {'status': status[task_id]}  # noqa: E731
    first = h.listing(db)
    assert sorted(h.sync(db, audit, read)) == sorted(r['id'] for r in first if r['task_id'] == 't1') and count('handoff.state') == 1
    status['t1'] = 'done'
    assert len(h.sync(db, audit, read)) == 1 and count('handoff.completed') == 1
    assert h.sync(db, audit, read) == [] and count('handoff.completed') == 1                      # a finished handoff is not touched again
    status['t1'] = 'running'                                                                       # even if its task is reopened
    assert h.sync(db, audit, read) == []
    status['t2'] = 'archived'
    h.sync(db, audit, read)
    assert count('handoff.cancelled') == 1


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    ('rt10_a_message_to_a_non_member_is_refused_before_it_is_sent', 'RT10: an unknown handle is ignored (Hermes then wakes everyone)',
     '    if unknown:\n        raise PluginError("not_a_member"', '    if False:\n        raise PluginError("not_a_member"'),
    ('rt10_a_message_to_a_non_member_is_refused_before_it_is_sent', 'RT10: a handle is matched case-sensitively',
     '    by_handle = {m["handle"].casefold(): m for m in members}\n    named = mentioned(text)', '    by_handle = {m["handle"]: m for m in members}\n    named = mentioned(text)'),
    ('rt10_a_message_to_a_non_member_is_refused_before_it_is_sent', 'RT10: several targets need no confirmation', '    return len(targets) > 1', '    return False'),
    ('rt10_a_message_to_a_non_member_is_refused_before_it_is_sent', 'RT10: an actor may ride in the message body',
     '    _strict(body, {"text", "event_id", "thread_id", "confirm_cost"}, {"text", "event_id"})',
     '    _strict(body, {"text", "event_id", "thread_id", "confirm_cost", "actor"}, {"text", "event_id"})'),
    ('rt10_a_message_to_a_non_member_is_refused_before_it_is_sent', 'RT10: the coordinator is ignored',
     '    elif not named:\n        stored = f"@{coordinator} {text}"', '    elif False:\n        stored = f"@{coordinator} {text}"'),
    ('rt11_a_handoff_is_bounded_by_both_bots', 'RT11: only the destination is evaluated',
     'for side, bot in (("origin", origin), ("destination", destination)):', 'for side, bot in (("origin", destination), ("destination", destination)):'),
    ('rt11_a_handoff_is_bounded_by_both_bots', 'RT11: the best answer wins instead of the worst', '    return max(effects, key=lambda e: rules.RANK[e], default=rules.Level.ALLOW)',
     '    return min(effects, key=lambda e: rules.RANK[e], default=rules.Level.ALLOW)'),
    ('rt11_a_handoff_is_bounded_by_both_bots', 'RT11: an ask goes straight to ready',
     '    return "triage" if effect in (rules.Level.ASK, rules.Level.HANDBACK) else "ready"', '    return "ready"'),
    ('rt11_a_handoff_is_bounded_by_both_bots', 'RT11: a handoff in a room needs no membership', '    if origin not in bots or destination not in bots:', '    if False:'),
    ('s09_handoffs_are_ingested_with_a_cursor_and_every_transition_is_audited', 'S09: tasks behind the cursor are read again',
     '        if created < cursor - OVERLAP or task["id"] in known', '        if task["id"] in known'),
    ('s09_handoffs_are_ingested_with_a_cursor_and_every_transition_is_audited', 'S09: a known task is ingested again',
     'or task["id"] in known or origin not in names', 'or origin not in names'),
    ('s09_handoffs_are_ingested_with_a_cursor_and_every_transition_is_audited', 'S09: a completion is audited under another name',
     'action = "handoff.completed" if fresh == "completed" else', 'action = "handoff.state" if fresh == "completed" else'),
    ('s09_handoffs_are_ingested_with_a_cursor_and_every_transition_is_audited', 'S09: a finished handoff is synced again',
     '        if row["state"] in ("completed", "cancelled"):\n            continue', '        if False:\n            continue'),
    ('map_search_and_handoff_rows_are_honest', 'map: the window is ignored', '        if row["created_at"] < since:\n            continue\n', ''),
    ('map_search_and_handoff_rows_are_honest', 'search: snippets are not redacted', '"snippet": redact(str(snippet))[:300]', '"snippet": str(snippet)[:300]'),
    ('map_search_and_handoff_rows_are_honest', 'search: hits are not ordered by recency', '    return sorted(hits, key=lambda h: -(h.get("at") or 0))[:limit]', '    return list(hits)[:limit]'),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_modules(tmp_path, name):
    INVARIANTS[name](load(tmp_path), tmp_path)


def test_every_invariant_has_a_mutation():
    assert {m[0] for m in MUTATIONS} == set(INVARIANTS)


RESULTS = []


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path, invariant, label, old, new):
    variant = load(tmp_path, (old, new))
    try:
        INVARIANTS[invariant](variant, tmp_path)
    except BaseException as error:  # noqa: BLE001  (red = the invariant noticed)
        RESULTS.append((invariant, label, 'RED: ' + type(error).__name__))
        return
    RESULTS.append((invariant, label, 'SURVIVED'))
    pytest.fail(f'mutation survived: {invariant} / {label}')


def test_zz_print_the_mutation_table():
    print('\n| invariant | mutation | result |\n|---|---|---|')
    for row in RESULTS:
        print('| ' + ' | '.join(row) + ' |')


# ---------------------------------------------------------------------------------------------------------------------
# Part 2: the real harness
# ---------------------------------------------------------------------------------------------------------------------
import sqlite3  # noqa: E402
import time  # noqa: E402

from support import DASHBOARD  # noqa: E402
from test_bots import DB, audit_rows, csrf, error_of, post  # noqa: E402
from test_hook import REPO, forget, load_plugin, loopback_request, run_async, wait_for, wait_live  # noqa: E402
from test_phase4 import clean_budget, delete  # noqa: E402
from test_plugin import PREFIX  # noqa: E402
from test_rules_api import activate_rule, clean_rules, create as create_rule  # noqa: E402,F401  (clean_rules cleans what a test activated)
from test_runs import get  # noqa: E402

MODULE_ROUTES = [('GET', '/rooms'), ('POST', '/rooms'), ('GET', '/rooms/{room_id}'), ('PATCH', '/rooms/{room_id}'), ('DELETE', '/rooms/{room_id}'),
                 ('GET', '/rooms/{room_id}/log'), ('POST', '/rooms/{room_id}/messages'), ('POST', '/rooms/{room_id}/stop'),
                 ('POST', '/rooms/{room_id}/tasks/{task_id}/retry'), ('POST', '/handoffs'), ('GET', '/handoffs'), ('GET', '/handoffs/{handoff_id}'),
                 ('POST', '/handoffs/{handoff_id}/promote'), ('POST', '/handoffs/{handoff_id}/cancel'), ('GET', '/map'), ('GET', '/search')]
MADE_ROOMS, MADE_HANDOFFS = [], []


def patch_json(browser, path, body):
    return browser.request.patch(DASHBOARD + PREFIX + path, data=body, headers={'X-LuveBot-CSRF': csrf(browser)})


@pytest.fixture(autouse=True)
def tidy_phase5(human_browser):
    clean_budget()
    for name in ('vendas', 'default'):
        wait_live(human_browser, name)                                                          # a rule activated by an earlier test reloads the table
    yield
    clean_budget()
    for room_id, name in MADE_ROOMS:
        delete(human_browser, f'/rooms/{room_id}', {'confirm_name': name})
    MADE_ROOMS.clear()
    for handoff_id in MADE_HANDOFFS:
        post(human_browser, f'/handoffs/{handoff_id}/cancel', {})
    MADE_HANDOFFS.clear()
    conn = sqlite3.connect(DB)
    for table in ('handoffs', 'rooms_meta'):
        try:
            conn.execute(f'DELETE FROM {table}')
        except sqlite3.OperationalError:
            pass
    conn.execute("DELETE FROM hook_events WHERE verdict='handoff'")
    conn.commit()
    conn.close()


def make_room(browser, name='t54 room', bots=('vendas', 'default'), **extra):
    response = post(browser, '/rooms', {'name': name, 'members': [{'bot': b} for b in bots], **extra})
    assert response.status == 201, response.text()
    room = response.json()['room']
    MADE_ROOMS.append((room['id'], name))
    return room


def log_of(browser, room_id, since=0):
    response = get(browser, f'/rooms/{room_id}/log?since_seq={since}&limit=200')
    assert response.status == 200, response.text()
    return response.json()['events']


def send(browser, room_id, text, **extra):
    return post(browser, f'/rooms/{room_id}/messages', {'text': text, 'event_id': 'e-' + str(time.time_ns()), **extra})


def test_the_routes_are_in_the_router_so_the_401_sweep_covers_them():
    from test_plugin import routes
    found = set(routes())
    for method, path in MODULE_ROUTES:
        assert (method, PREFIX + path) in found, (method, path)


def test_a_room_is_a_native_group_chat_created_listed_renamed_and_disbanded_through_us(human_browser):
    room = make_room(human_browser, goal='ship the report', coordinator='default')
    assert [m['handle'] for m in room['members']] == ['vendas', 'default'] and room['goal'] == 'ship the report' and room['coordinator'] == 'default'
    assert any(r['id'] == room['id'] for r in get(human_browser, '/rooms').json()['rooms'])
    assert get(human_browser, f"/rooms/{room['id']}").json()['room']['driver']['running'] is True
    renamed = patch_json(human_browser, f"/rooms/{room['id']}", {'name': 't54 renamed', 'owner': 'vendas'})
    assert renamed.status == 200 and renamed.json()['room']['name'] == 't54 renamed' and renamed.json()['room']['owner'] == 'vendas'
    MADE_ROOMS[-1] = (room['id'], 't54 renamed')
    assert 'room.renamed' in [e['kind'] for e in log_of(human_browser, room['id'])]
    assert patch_json(human_browser, f"/rooms/{room['id']}", {'members': []}).status == 400            # the roster is frozen at creation
    assert patch_json(human_browser, f"/rooms/{room['id']}", {'owner': 'ghost'}).status == 422
    assert delete(human_browser, f"/rooms/{room['id']}", {'confirm_name': 'wrong'}).status == 422
    assert get(human_browser, '/rooms/room-nope').status == 404
    assert post(human_browser, '/rooms', {'name': 'x', 'members': [{'bot': 'vendas'}]}).status == 422
    assert post(human_browser, '/rooms', {'name': 'x', 'members': [{'bot': 'vendas'}, {'bot': 'ghost-bot'}]}).status in (404, 422)
    assert [r[1] for r in audit_rows('room.create')[-2:]] == ['ok', 'ok']


def test_rt10_a_message_to_a_non_member_is_refused_and_nothing_reaches_the_room(human_browser):
    room = make_room(human_browser)
    before = log_of(human_browser, room['id'])
    audited = len(audit_rows('room.send'))
    for text in ('@ghost please do X', 'hello @vendas and @ghost'):
        refused = send(human_browser, room['id'], text, confirm_cost=True)
        assert refused.status == 422 and error_of(refused)['code'] == 'not_a_member', refused.text()
        assert error_of(refused)['details']['handles'] == ['ghost']
    time.sleep(3)
    assert log_of(human_browser, room['id']) == before                                           # no event, so no member woke up
    assert len(audit_rows('room.send')) == audited                                               # nothing was audited as an effect...
    assert [r[1] for r in audit_rows('room.send.refused')[-4:]] == ['ok', 'denied', 'ok', 'denied']   # ...the refusals were, as denied


def test_hermes_alone_would_wake_everyone_for_a_message_without_a_valid_mention(human_browser):
    """The baseline of red team 10: the trap is real. With no mention at all, Hermes runs every member."""
    room = make_room(human_browser)
    assert send(human_browser, room['id'], 'status please').status == 409                           # two targets: the cost needs confirming
    assert send(human_browser, room['id'], 'status please', confirm_cost=True).status == 202
    members = {m['member_id'] for m in room['members']}
    assert wait_for(lambda: len({(e.get('payload') or {}).get('member_id') for e in log_of(human_browser, room['id'])
                                 if e['kind'] in ('turn.started', 'message.member', 'turn.settled')} & members) == 2, 120, 'both members to take a turn')


def test_the_send_is_gated_by_each_target_budget_and_the_all_mention_needs_confirmation(human_browser):
    room = make_room(human_browser)
    before = log_of(human_browser, room['id'])
    costly = send(human_browser, room['id'], '@all report')
    assert costly.status == 409 and error_of(costly)['code'] == 'cost_confirmation_required'
    assert error_of(costly)['details'] == {'targets': ['vendas', 'default'], 'max_rounds': 3, 'max_member_messages': 10}
    from luvebot_backend.audit import AuditLog
    from luvebot_backend.budget import Budget
    Budget(DB, audit=AuditLog(DB)).on_breach('default')
    paused = send(human_browser, room['id'], '@default hello')
    assert paused.status == 409 and error_of(paused)['code'] == 'bot_paused' and error_of(paused)['details'] == {'bot': 'default'}
    mixed = send(human_browser, room['id'], '@all report', confirm_cost=True)
    assert mixed.status == 409 and error_of(mixed)['code'] == 'bot_paused'                          # one paused target stops the whole send
    time.sleep(2)
    assert log_of(human_browser, room['id']) == before


def test_the_actor_is_server_side_the_room_shows_desktop_and_the_audit_the_real_person(human_browser):
    room = make_room(human_browser)
    assert send(human_browser, room['id'], '@vendas hello', actor='bot:default').status == 400   # no route accepts an actor in the body
    sent = send(human_browser, room['id'], '@vendas hello there')
    assert sent.status == 202 and sent.json()['targets'] == ['vendas'] and sent.json()['accepted'] is True
    events = [e for e in log_of(human_browser, room['id']) if e['kind'] == 'message.user']
    assert events and events[-1]['actor']['id'] == 'desktop'
    conn = sqlite3.connect(DB)
    actors = {r[0] for r in conn.execute("SELECT actor FROM audit_log WHERE action='room.send' AND target=?", (room['id'],))}
    conn.close()
    assert actors == {'basic:harness-human'}
    assert send(human_browser, room['id'], '@vendas again', thread_id='bad id!').status == 422
    stopped = post(human_browser, f"/rooms/{room['id']}/stop", {})
    assert stopped.status == 202 and stopped.json()['ok'] is True
    assert post(human_browser, f"/rooms/{room['id']}/tasks/nope/retry", {}).status == 422        # explicit confirmation required


def block_rule(browser, bot, tool, level='block'):
    rule = create_rule(browser, label=f'{level} {tool}', level=level, scope={'kind': 'bot', 'ref': bot}, match={'tools': [tool]})
    activated = activate_rule(browser, rule)['rule']
    wait_live(browser, bot)                                                                       # the new table is loaded before work is handed to that Bot
    return activated


def handoff(browser, origin, destination, *tools, **extra):
    return post(browser, '/handoffs', {'from': origin, 'to': destination, 'title': 't54 handoff ' + str(time.time_ns()),
                                       'requested': [{'tool': t} for t in tools], **extra})


def test_rt11_a_handoff_is_bounded_by_both_bots(human_browser):
    block_rule(human_browser, 'vendas', 't54_send')
    block_rule(human_browser, 'default', 't54_search')
    block_rule(human_browser, 'default', 't54_report', level='ask')
    laundering = handoff(human_browser, 'vendas', 'default', 't54_send')                          # origin blocked, destination free
    assert laundering.status == 422 and error_of(laundering)['code'] == 'handoff_blocked' and error_of(laundering)['details']['rules']
    assert handoff(human_browser, 'vendas', 'default', 't54_search').status == 422                   # destination blocked
    assert [r[1] for r in audit_rows('handoff.refused')[-4:]] == ['ok', 'denied', 'ok', 'denied']
    asked = handoff(human_browser, 'vendas', 'default', 't54_report')
    assert asked.status == 201, asked.text()
    MADE_HANDOFFS.append(asked.json()['handoff']['id'])
    assert asked.json()['handoff']['needs_review'] is True and asked.json()['handoff']['task']['status'] == 'triage'
    clear = handoff(human_browser, 'default', 'vendas', 't54_free')
    assert clear.status == 201 and clear.json()['handoff']['task']['status'] in ('ready', 'running', 'done', 'todo')
    MADE_HANDOFFS.append(clear.json()['handoff']['id'])
    # a human promotes the one that waits; promoting is never ours to do
    promoted = post(human_browser, f"/handoffs/{asked.json()['handoff']['id']}/promote", {})
    assert promoted.status == 200 and promoted.json()['handoff']['needs_review'] is False
    assert post(human_browser, f"/handoffs/{asked.json()['handoff']['id']}/promote", {}).status == 409
    assert post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'vendas', 'title': 'x'}).status == 422
    assert post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'default', 'title': 'x', 'created_by': 'dashboard'}).status == 400


def test_rt11_the_worker_of_a_handoff_inherits_the_restrictions_of_its_origin_at_run_time(human_browser, tmp_path, monkeypatch):
    """H-R3: the hook of the DESTINATION also evaluates the call against the ORIGIN's table (task provenance is Hermes's, not ours)."""
    block_rule(human_browser, 'vendas', 't54_secret_tool')
    import luvebot_backend.hermes_cron as cron
    task = cron.kanban_create(title='t54 inherit', body=None, assignee='default', created_by='vendas', triage=True, idempotency_key='t54-' + str(time.time_ns()))
    plain = cron.kanban_create(title='t54 plain', body=None, assignee='default', created_by='dashboard', triage=True, idempotency_key='t54b-' + str(time.time_ns()))
    hook = load_plugin(tmp_path, DB)._make_hook('default')
    assert hook('t54_secret_tool', {}) is None                                                    # no task: only the destination applies
    monkeypatch.setenv('HERMES_KANBAN_TASK', task)
    blocked = hook('t54_secret_tool', {})
    assert blocked['action'] == 'block' and 'origin:vendas' in blocked['message']                # the origin's block follows the work
    assert hook('web_search', {'query': 'x'}) is None                                             # and only what the origin blocks
    monkeypatch.setenv('HERMES_KANBAN_TASK', plain)
    assert hook('t54_secret_tool', {}) is None                                                    # a human-made task has no origin Bot
    monkeypatch.setenv('HERMES_KANBAN_TASK', 'task-that-does-not-exist')
    assert hook('web_search', {'query': 'x'})['action'] == 'approve'                              # provenance unreadable: ask, fail closed



def test_g11_1_a_dispatched_worker_is_blocked_by_the_origin_rule(human_browser):
    """Red team 11, gap G11.1 (the real control; the creation check reads only the client's `requested` list): Hermes's OWN Kanban
    dispatcher runs the worker of a handoff from vendas to default (a separate `hermes -p default chat -q` process, with
    HERMES_KANBAN_TASK set). The tool vendas blocks is blocked in default's hook (origin:vendas) and does not run. Control: a task a
    person made for default, dispatched the same way, runs the same command (so the worker really runs tools here)."""
    import uuid
    import luvebot_backend.hermes_cron as cron
    import luvebot_backend.hook_store as store
    block_rule(human_browser, 'vendas', 'terminal')
    made = post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'default', 'title': 'g111 origin blocked ' + uuid.uuid4().hex[:6]})
    assert made.status == 201, made.text()
    MADE_HANDOFFS.append(made.json()['handoff']['id'])
    blocked_task = made.json()['task_id']
    control_task = cron.kanban_create(title='g111 control', body=None, assignee='default', created_by='dashboard', triage=False,
                                      idempotency_key='g111-' + uuid.uuid4().hex)
    ran = lambda task: Path(f'/tmp/luvebot-kanban-ran-{task}').exists()    # noqa: E731
    wait_for(lambda: ran(control_task), 240, 'the control worker to run its command (dispatcher tick + worker start)')
    block = wait_for(lambda: next((e for e in store.events(DB, 'default', 200) if e['verdict'] == 'block' and e['tool'] == 'terminal'
                                   and 'origin:vendas' in (e['message'] or '')), None), 240, "the hook's origin block in default")
    assert block and not ran(blocked_task)                                     # the origin's block followed the work, and held


@pytest.fixture
def third_bot(human_browser):
    """G11.2: a real third Bot (a Hermes profile made by Hermes's own route), so the refusal below is always exercised."""
    import uuid
    name = 'g112-' + uuid.uuid4().hex[:8]
    assert human_browser.request.post(DASHBOARD + '/api/profiles', data={'name': name}).status == 200
    wait_for(lambda: name in [b['name'] for b in get(human_browser, '/bots').json()['bots']], 60, f'{name} listed by LuveBot')
    yield name
    human_browser.request.delete(DASHBOARD + '/api/profiles/' + name)
    forget(name)


def test_a_handoff_in_a_room_needs_both_bots_in_that_room(human_browser, third_bot):
    room = make_room(human_browser, bots=('vendas', 'default'))
    from_non_member = post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'default', 'title': 't54 in room', 'room_id': room['id']})
    assert from_non_member.status == 201, from_non_member.text()
    MADE_HANDOFFS.append(from_non_member.json()['handoff']['id'])
    for origin, destination in (('vendas', third_bot), (third_bot, 'vendas')):                # either end outside the room
        refused = post(human_browser, '/handoffs', {'from': origin, 'to': destination, 'title': 't54 out', 'room_id': room['id']})
        assert refused.status == 422 and error_of(refused)['code'] == 'not_a_member', refused.text()


def test_a_handoff_shows_in_kanban_room_map_and_audit_and_an_unrecorded_bot_made_one_raises_an_alert(human_browser):
    room = make_room(human_browser)
    made = post(human_browser, '/handoffs', {'from': 'vendas', 'to': 'default', 'title': 't54 everywhere', 'room_id': room['id']})
    assert made.status == 201, made.text()
    handoff_id, task_id = made.json()['handoff']['id'], made.json()['task_id']
    MADE_HANDOFFS.append(handoff_id)
    import luvebot_backend.hermes_cron as cron
    task = cron.kanban_task(task_id)
    assert task['assignee'] == 'default' and task['created_by'] == 'vendas'                       # Kanban: provenance is the origin Bot
    assert any(h['id'] == handoff_id for h in get(human_browser, f"/handoffs?room={room['id']}").json()['handoffs'])   # room timeline card
    assert get(human_browser, f"/rooms/{room['id']}").json()['room']['open_tasks'] >= 1
    edge = next(e for e in get(human_browser, '/map').json()['edges'] if (e['from'], e['to']) == ('vendas', 'default'))
    assert edge['count'] >= 1 and handoff_id in edge['handoff_ids']                                 # map
    assert [(r[1], r[2]) for r in audit_rows('handoff.created') if r[3] == handoff_id][:2] == [('ok', 'intent'), ('ok', 'result')]   # audit
    # a Bot-made handoff: the hook's `handoff.requested` row exists for one, not for the other
    import luvebot_backend.hook_store as store
    import hashlib
    # the hook writes its row BEFORE the tool creates the task (it is the "before" half), and the watcher may ingest at any moment
    store.record_event(DB, 'vendas', 'kanban_create', None, 'handoff', 'default|' + hashlib.sha256('t54 bot made'.encode()).hexdigest(), 't', 's', 'c', None)
    seen = cron.kanban_create(title='t54 bot made', body=None, assignee='default', created_by='vendas', triage=True, idempotency_key='t54c-' + str(time.time_ns()))
    lost = cron.kanban_create(title='t54 bot lost', body=None, assignee='default', created_by='vendas', triage=True, idempotency_key='t54d-' + str(time.time_ns()))
    assert get(human_browser, '/map').status == 200
    unrecorded = wait_for(lambda: [r[3] for r in audit_rows('handoff.unrecorded')] if lost in [r[3] for r in audit_rows('handoff.unrecorded')] else None, 60, 'the watcher to ingest')
    assert lost in unrecorded and seen not in unrecorded
    assert any(r[3] and r[1] == 'ok' for r in audit_rows('handoff.created'))


def test_search_is_partial_when_a_bot_fails_and_never_shows_a_planted_secret(human_browser, monkeypatch):
    secret = 'sk-' + 'a1b2c3d4e5f6' * 3
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    sent = post(human_browser, '/bots/vendas/runs', {'input': f'remember t54findme with key {secret}', 'session_id': sid})
    assert sent.status == 202, sent.text()
    hits = wait_for(lambda: [h for h in get(human_browser, '/search?q=t54findme&types=messages').json()['messages']], 90, 'the message to be searchable')
    assert hits and all(h['bot'] == 'vendas' for h in hits) and secret not in json.dumps(hits)
    assert get(human_browser, '/search?q=').status == 400 and get(human_browser, '/search?q=x&types=nope').status == 400
    module = plugin()
    real = module.hermes_cron.sessions_search

    def flaky(bot, q, limit, include_rooms):
        if bot == 'default':
            raise RuntimeError('state.db locked')
        return real(bot, q, limit, include_rooms)
    monkeypatch.setattr(module.hermes_cron, 'sessions_search', flaky)
    response = run_async(module.get_search(loopback_request(module, 'GET', '/search'), q='t54findme', types='messages', bots=None, limit=8))
    body = json.loads(response.body)
    assert body['partial'] == ['default'] and any(h['bot'] == 'vendas' for h in body['messages'])
