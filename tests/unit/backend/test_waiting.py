"""F6-B "Bot esperando você" (backend/waiting.py, backend/activity.py `waiting_item`, the `/waiting` route): the hook's `waiting` rows become
the items a person sees, once, with the platform of the session; text the agent wrote is redacted and plain; an unreadable source is never
"nobody waits". `hook_store.waiting` and SessionDB are stand-ins here (the real hook writes the rows: tests/unit/backend/test_hook_0_5.py,
the real Hermes in the harness). Every invariant also runs against variants of waiting.py with one defect each."""
import json
import re
import types
from pathlib import Path

import pytest

import backend.activity as activity
import backend.waiting as real

SRC = Path(real.__file__).parent
ROOT = SRC.parent
CANARY = 'sk-CANARYwait0123456789abcdef'
R1, R2, R3, R4, R5, R6 = (c * 32 for c in 'abcdef')


def redact(text):
    return text.replace(CANARY, '***')


def row(request_id, kind, session='s1', ts=100.0, prompt='p'):
    return {'id': 1, 'ts': ts, 'kind': kind, 'prompt': prompt, 'session_id': session, 'request_id': request_id}


class Db:
    def __init__(self, sources, boom=(), ended=()):
        self.sources, self.boom, self.ended, self.closed, self.asked = sources, set(boom), set(ended), False, []

    def get_session(self, sid):
        self.asked.append(sid)
        if sid in self.boom:
            raise RuntimeError(CANARY)
        return None if sid not in self.sources else {'id': sid, 'source': self.sources[sid], 'ended_at': 99.0 if sid in self.ended else None}

    def close(self):
        self.closed = True


def sources_of(**by_session):
    """`session_of` stand-in: a platform string, or (platform, ended), or nothing (an unknown session)."""
    def of(sid):
        found = by_session.get(sid)
        return None if found is None else found if isinstance(found, tuple) else (found, False)
    return of


# ---- invariants ---------------------------------------------------------------------------------------------------------------

def inv_the_inbox_is_not_shown_twice_and_nothing_else_is_hidden(mod):
    rows = [row(R1, 'approval', 's-api'), row(R2, 'approval', 's-tg'), row(R3, 'approval', 's-unreadable'), row(R4, 'clarify', 's-api'),
            row(R5, 'sudo', 's-api'), row(R6, 'weird', 's-cli'), row('g' * 32, 'approval', None),
            row('h' * 32, 'clarify', 's-over'), row('i' * 32, 'approval', 's-tg-over')]
    out = mod.derive(rows, sources_of(**{'s-api': 'api_server', 's-tg': 'telegram', 's-cli': 'cli', 's-over': ('cli', True), 's-tg-over': ('telegram', True)}), redact)
    by_id = {i['request_id']: i for i in out}
    assert R1 not in by_id                                                                  # the run's approval: the inbox has it
    assert by_id[R2]['kind'] == 'approval' and by_id[R2]['platform'] == 'telegram'          # elsewhere: exactly what the inbox does not show
    assert by_id[R3]['platform'] is None                                                    # unreadable session: a wait is never hidden by a guess
    assert by_id['g' * 32]['platform'] is None and by_id['g' * 32]['session_id'] is None
    assert by_id[R4]['platform'] == 'api_server' and by_id[R5]['platform'] == 'api_server'  # clarify and sudo always stay
    assert by_id[R6]['kind'] == 'other'                                                     # a kind we do not know stays, as `other`
    assert 'h' * 32 not in by_id and 'i' * 32 not in by_id                                  # a session that has ended: nobody waits on it any more
    assert [i['request_id'] for i in out] == [R2, R3, R4, R5, R6, 'g' * 32]                 # the order Hermes's reader gave (newest first) is kept


def inv_the_agents_text_is_redacted_cut_and_only_a_questions(mod):
    secret_at_the_cut = 'q' * 290 + CANARY + 'tail'
    items = {i['kind']: i for i in mod.derive([row(R1, 'clarify', prompt=secret_at_the_cut), row(R2, 'sudo', prompt=f'sudo {CANARY}'),
                                               row(R3, 'approval', 's-tg', prompt=f'rm -rf {CANARY}')], sources_of(**{'s-tg': 'telegram'}), redact)}
    assert 'sk-CANARY' not in json.dumps(list(items.values()))                              # redacted BEFORE the cut: no half a secret
    assert len(items['clarify']['prompt']) <= 300
    assert len(mod.derive([row(R1, 'clarify', prompt='z' * 900)], sources_of(), redact)[0]['prompt']) == 300      # and it is cut
    assert items['sudo']['prompt'] is None and items['approval']['prompt'] is None          # a command is not shown
    assert [i['prompt'] for i in mod.derive([row(R1, 'clarify', prompt=None), row(R2, 'clarify', prompt=7), row(R3, 'clarify', prompt='')],
                                            sources_of(), redact)] == [None, None, None]


def inv_each_item_has_the_shape_of_the_contract_and_bad_rows_are_skipped(mod):
    good = row(R1, 'clarify', 's-x', ts=12)
    out = mod.derive([good, 'junk', None, 7, {}, row('bad id', 'clarify'), row(R2, 'clarify', session='../etc'), dict(good, request_id=5)],
                     sources_of(**{'s-x': 'cli'}), redact)
    assert [i['request_id'] for i in out] == [R1, R2]
    assert out[0] == {'request_id': R1, 'kind': 'clarify', 'since': 12.0, 'session_id': 's-x', 'platform': 'cli', 'prompt': 'p'}
    assert mod.session_facts('vendas', ['s-x'], db_of=lambda b: Db({'s-x': 'Weird Source!'})) == {'s-x': ('other', False)}   # a platform is a slug
    assert out[1]['session_id'] is None and out[1]['platform'] is None                      # a session id that is not an id is not looked up
    many = [row(f'{n:032x}', 'clarify') for n in range(80)]
    assert len(mod.derive(many, sources_of(), redact)) == 50 and mod.derive(None, sources_of(), redact) == []


def inv_unreadable_is_never_nobody_waits(mod):
    def boom(path, bot):
        raise RuntimeError(CANARY)
    assert mod.read('p', 'vendas', redact, reader=boom) is None
    assert mod.read('p', 'vendas', redact, reader=lambda p, b: [row(R1, 'clarify')], db_of=lambda b: Db({'s1': 'api_server'}))[0]['request_id'] == R1
    # the store of sessions cannot be opened: the waits stay, with no platform (an approval is not dropped by a guess)
    def no_store(bot):
        raise OSError(CANARY)
    out = mod.read('p', 'vendas', redact, reader=lambda p, b: [row(R1, 'approval', 's-api'), row(R2, 'clarify')], db_of=no_store)
    assert [(i['request_id'], i['platform']) for i in out] == [(R1, None), (R2, None)]
    # one session that cannot be read does not hide the others
    db = Db({'s-tg': 'telegram', 's-old': 'cli'}, boom=['s-bad'], ended=['s-old'])
    out = mod.read('p', 'vendas', redact, reader=lambda p, b: [row(R1, 'approval', 's-bad'), row(R2, 'approval', 's-tg'), row(R3, 'clarify', 's-old')],
                   db_of=lambda b: db)
    assert [(i['request_id'], i['platform']) for i in out] == [(R1, None), (R2, 'telegram')]   # the bad one kept, the ended one dropped
    assert CANARY not in json.dumps(out)


def inv_one_store_open_per_read_and_it_is_closed(mod):
    db, opened = Db({'s1': 'api_server', 's2': 'cli'}), []
    mod.read('p', 'vendas', redact, reader=lambda p, b: [row(R1, 'clarify', 's1'), row(R2, 'clarify', 's2'), row(R3, 'clarify', 's1')],
             db_of=lambda b: opened.append(b) or db)
    assert opened == ['vendas'] and sorted(db.asked) == ['s1', 's2'] and db.closed is True   # once, each session once, closed
    assert mod.read('p', 'vendas', redact, reader=lambda p, b: [], db_of=lambda b: opened.append(b) or db) == [] and opened == ['vendas']  # nothing waits: no store opened


def inv_a_luvebot_without_the_hook_rows_says_nothing_waits_but_does_not_break(mod):
    import backend.hook_store as store
    saved = store.__dict__.pop('waiting')
    try:
        assert mod.read('p', 'vendas', redact) == []
    finally:
        store.waiting = saved


INVARIANTS = {n[4:]: f for n, f in sorted(globals().items()) if n.startswith('inv_')}

MUTATIONS = [
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'the run approval is shown twice', "        if kind == 'approval' and platform == 'api_server':\n            continue  # the inbox already shows this one\n", ""),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'every approval is dropped', "if kind == 'approval' and platform == 'api_server':", "if kind == 'approval':"),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'an unreadable platform hides an approval', "if kind == 'approval' and platform == 'api_server':", "if kind == 'approval' and platform != 'telegram':"),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'a clarify of an api run is dropped', "if kind == 'approval' and platform == 'api_server':", "if platform == 'api_server':"),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'a kind we do not know is dropped', "kind = row.get('kind') if row.get('kind') in KINDS else 'other'", "kind = row.get('kind') if row.get('kind') in KINDS else None\n        if kind is None:\n            continue"),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'a hostile kind is passed through', "kind = row.get('kind') if row.get('kind') in KINDS else 'other'", "kind = row.get('kind')"),
    ('the_agents_text_is_redacted_cut_and_only_a_questions', 'cut before redacting', "(redact(prompt)[:MAX_PROMPT] or None)", "(redact(prompt[:MAX_PROMPT]) or None)"),
    ('the_agents_text_is_redacted_cut_and_only_a_questions', 'not redacted', "(redact(prompt)[:MAX_PROMPT] or None)", "(prompt[:MAX_PROMPT] or None)"),
    ('the_agents_text_is_redacted_cut_and_only_a_questions', 'not cut', "(redact(prompt)[:MAX_PROMPT] or None)", "(redact(prompt) or None)"),
    ('the_agents_text_is_redacted_cut_and_only_a_questions', 'a command is shown', "if kind == 'clarify' and isinstance(prompt, str) else None", "if isinstance(prompt, str) else None"),
    ('each_item_has_the_shape_of_the_contract_and_bad_rows_are_skipped', 'a bad request id is kept', "or not _ID.fullmatch(row['request_id']):", "or False:"),
    ('each_item_has_the_shape_of_the_contract_and_bad_rows_are_skipped', 'a path-like session is looked up', "if isinstance(row.get('session_id'), str) and _ID.fullmatch(row['session_id']) else None", "if isinstance(row.get('session_id'), str) else None"),
    ('each_item_has_the_shape_of_the_contract_and_bad_rows_are_skipped', 'no ceiling', "        if len(out) >= MAX_ITEMS:\n            break\n", ""),
    ('each_item_has_the_shape_of_the_contract_and_bad_rows_are_skipped', 'a weird platform is passed through', "(source if _SLUG.fullmatch(source) else 'other')", "source"),
    ('unreadable_is_never_nobody_waits', 'unreadable reads as nobody waits', "    except Exception:  # noqa: BLE001\n        return None\n", "    except Exception:  # noqa: BLE001\n        return []\n"),
    ('unreadable_is_never_nobody_waits', 'no store, no waits', "    except Exception:  # noqa: BLE001\n        return {sid: (None, False) for sid in ids}", "    except Exception:  # noqa: BLE001\n        raise"),
    ('unreadable_is_never_nobody_waits', 'an unreadable session counts as ended', "isinstance(row, dict) and row.get('ended_at') is not None)", "not isinstance(row, dict) or row.get('ended_at') is not None)"),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'an ended session is kept', "        if ended:\n            continue  # the session is over: nobody is waiting on it any more\n", ""),
    ('the_inbox_is_not_shown_twice_and_nothing_else_is_hidden', 'every session counts as ended', "(session_of(session) or (None, False)) if session else (None, False)", "(None, True)"),
    ('unreadable_is_never_nobody_waits', 'one bad session hides the rest', "            except Exception:  # noqa: BLE001\n                row = None", "            except Exception:  # noqa: BLE001\n                raise"),
    ('one_store_open_per_read_and_it_is_closed', 'one open per session', "        db = db_of(bot)\n    except Exception:  # noqa: BLE001\n        return {sid: (None, False) for sid in ids}\n    found = {}\n    try:\n        for sid in ids:\n            try:\n                row = db.get_session(sid)",
     "        db = db_of(bot)\n    except Exception:  # noqa: BLE001\n        return {sid: (None, False) for sid in ids}\n    found = {}\n    try:\n        for sid in ids:\n            try:\n                row = db_of(bot).get_session(sid)"),
    ('one_store_open_per_read_and_it_is_closed', 'never closed', "            db.close()\n        except Exception:  # noqa: BLE001\n            pass\n    return found", "            pass\n        except Exception:  # noqa: BLE001\n            pass\n    return found"),
    ('one_store_open_per_read_and_it_is_closed', 'the store is opened with nothing to look up', "    if not ids:\n        return {}\n", ""),
    ('a_luvebot_without_the_hook_rows_says_nothing_waits_but_does_not_break', 'a missing reader is unreadable', "            if reader is None:\n                return []\n", "            if reader is None:\n                return None\n"),
]


def variant(old, new):
    text = (SRC / 'waiting.py').read_text()
    assert text.count(old) == 1, old
    mod = types.ModuleType('backend.waiting_variant')
    mod.__package__ = 'backend'
    exec(compile(text.replace(old, new), 'waiting_variant', 'exec'), mod.__dict__)
    return mod


def quietly(check, mod):
    """A defect that raises reads as a failed invariant."""
    try:
        check(mod)
    except AssertionError:
        raise
    except Exception as error:  # noqa: BLE001
        raise AssertionError(f'raised {type(error).__name__}') from None


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert {inv for inv, *_ in MUTATIONS} == set(INVARIANTS)


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(invariant, label, old, new):
    mod = variant(old, new)                          # outside pytest.raises: a mutation that does not apply is an error
    with pytest.raises(AssertionError):
        quietly(INVARIANTS[invariant], mod)


# ---- the Activity item, the lost run, and the wiring ----------------------------------------------------------------------------------

def test_a_wait_is_an_activity_item_without_actions_and_a_lost_run_is_not_an_error():
    wait = {'request_id': R1, 'kind': 'clarify', 'since': 50.0, 'session_id': 's1', 'platform': 'telegram', 'prompt': 'Posso apagar?'}
    item = activity.waiting_item('vendas', wait)
    assert item['id'] == f'waiting:{R1}' and item['kind'] == 'waiting' and item['status'] == 'waiting_approval' and item['origin'] == 'message'
    assert item['bot'] == 'vendas' and item['title'] is None and item['started_at'] == 50.0 and item['ended_at'] is None
    assert item['links'] == {'session_id': 's1'} and item['wait'] == {'kind': 'clarify', 'platform': 'telegram', 'prompt': 'Posso apagar?'}
    assert activity.tab_of(item) == 'running'
    assert not activity.valid_id(item['id'])                                   # no action path accepts it
    with pytest.raises(Exception) as error:
        activity.parse_id(item['id'])
    assert error.value.code == 'activity_not_found'
    assert activity.waiting_item('vendas', dict(wait, session_id=None))['links'] == {}
    lost = activity.run_item({'run_id': 'r1', 'bot': 'vendas', 'session_id': 's1', 'started_at': '2026-10-20T10:00:00Z', 'last_status': 'unknown',
                              'prompt_sha': None}, lambda iso: 1.0)
    assert lost['status'] == 'waiting_approval' and activity.tab_of(lost) == 'running'   # it used to fall to `error`
    gone = activity.run_item({'run_id': 'r2', 'bot': 'vendas', 'session_id': 's1', 'started_at': '2026-10-20T10:00:00Z', 'last_status': 'lost',
                              'prompt_sha': None}, lambda iso: 1.0)
    assert gone['status'] == 'stopped'                                            # a run Hermes no longer knows (a 404 after a restart): a calm stop, not a red error (F10: it said nothing of how it ended)


def run_item(run_id, session, status='running'):
    return activity.run_item({'run_id': run_id, 'bot': 'vendas', 'session_id': session, 'started_at': '2026-10-20T10:00:00Z', 'last_status': status,
                              'prompt_sha': None}, lambda iso: 1.0)


def wait_of(request_id, session, kind='clarify'):
    return {'request_id': request_id, 'kind': kind, 'since': 50.0, 'session_id': session, 'platform': 'api_server', 'prompt': None}


def check_decoration(act):
    """Contract v0.9 section 7: a wait of an OPEN run of ours decorates that run and adds no row; every other wait is its own item."""
    runs = [run_item('r-open', 's1'), run_item('r-twin', 's1', 'started'), run_item('r-done', 's3', 'completed'), run_item('r-lost', 's4', 'unknown'),
            run_item('r-ask', 's5', 'waiting_for_approval')]
    routine = act.routine_run_item('vendas', {'id': 'cron_j_1', 'started_at': 1.0, 'ended_at': None, 'title': 't'}, 2.0)
    own = act.decorate(runs + [routine], 'vendas', [wait_of(R1, 's1'), wait_of(R2, 's2'), wait_of(R3, 's3'), wait_of(R4, None), wait_of(R5, 's4'),
                                                    wait_of(R6, 's5'), wait_of('g' * 32, 'cron_j_1', 'sudo')])
    by_id = {i['id']: i for i in runs + [routine]}
    assert by_id['run:r-open']['status'] == 'waiting_approval' and by_id['run:r-twin']['status'] == 'waiting_approval'   # both runs of that session
    assert by_id['run:r-done']['status'] == 'done'                                                                       # a finished run is not decorated
    assert by_id['run:r-lost']['status'] == 'waiting_approval' and by_id['run:r-ask']['status'] == 'waiting_approval'
    assert by_id['routine_run:cron_j_1']['status'] == 'running'                                                         # only runs of ours are decorated
    assert sorted(i['id'] for i in own) == sorted(f'waiting:{r}' for r in (R2, R3, R4, 'g' * 32))                      # no run of ours: its own item
    assert all(i['kind'] == 'waiting' and i['status'] == 'waiting_approval' for i in own)
    assert act.decorate([], 'vendas', []) == [] and len(act.decorate([], 'vendas', [wait_of(R1, 's1')])) == 1


def test_a_wait_of_an_open_run_decorates_it_and_the_rest_are_their_own_items():
    check_decoration(activity)


DECORATION_MUTATIONS = [
    ('a finished run is decorated', 'item["status"] in ("running", "waiting_approval") and', 'True and'),
    ('a wait always gets its own row', '        if runs:\n            for item in runs:', '        if False:\n            for item in runs:'),
    ('a decorated run also gets a row', '                item["status"] = "waiting_approval"\n        else:\n            own.append(waiting_item(bot, wait))', '                item["status"] = "waiting_approval"\n        own.append(waiting_item(bot, wait))'),
    ('a routine run is decorated', 'if item["kind"] == "run" and', 'if True and'),
    ('only the first run of a session is decorated', '            for item in runs:\n                item["status"] = "waiting_approval"', '            for item in runs[:1]:\n                item["status"] = "waiting_approval"'),
]


@pytest.mark.parametrize('label,old,new', DECORATION_MUTATIONS, ids=[m[0] for m in DECORATION_MUTATIONS])
def test_each_decoration_mutation_turns_it_red(label, old, new):
    text = (SRC / 'activity.py').read_text()
    assert text.count(old) == 1, old
    mod = types.ModuleType('backend.activity_variant')
    mod.__package__ = 'backend'
    exec(compile(text.replace(old, new), 'activity_variant', 'exec'), mod.__dict__)
    with pytest.raises(AssertionError):
        quietly(check_decoration, mod)


def test_the_activity_item_mutations():
    text = (SRC / 'activity.py').read_text()
    for old, new in (('"interrupted": "stopped", "unknown": "waiting_approval",', '"interrupted": "stopped",'),
                     ('"waiting_approval", wait["since"]', '"running", wait["since"]'),
                     ('item["wait"] = {"kind": wait["kind"], "platform": wait["platform"], "prompt": wait["prompt"]}', 'item["wait"] = dict(wait)')):
        assert text.count(old) == 1, old
        mod = types.ModuleType('backend.activity_variant')
        mod.__package__ = 'backend'
        exec(compile(text.replace(old, new), 'activity_variant', 'exec'), mod.__dict__)
        wait = {'request_id': R1, 'kind': 'clarify', 'since': 50.0, 'session_id': 's1', 'platform': 'cli', 'prompt': 'q'}
        with pytest.raises(AssertionError):
            item = mod.waiting_item('vendas', wait)
            assert item['status'] == 'waiting_approval' and item['wait'] == {'kind': 'clarify', 'platform': 'cli', 'prompt': 'q'}
            lost = mod.run_item({'run_id': 'r1', 'bot': 'v', 'session_id': 's', 'started_at': 'x', 'last_status': 'unknown', 'prompt_sha': None}, lambda i: 1.0)
            assert lost['status'] == 'waiting_approval'


def test_the_waiting_route_is_read_only_and_the_activity_lists_the_waits():
    api = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
    route = api.split("@router.get('/waiting')", 1)[1].split('\n# ----', 1)[0]
    assert '_identity(request)' in route and '_require_csrf' not in route and 'audit.act' not in route and 'waiting.read(meta.path, name, _REDACT)' in route.replace('run_in_threadpool(', '').replace(', meta.path', ', meta.path') or 'waiting.read, meta.path, name, _REDACT' in route
    assert "'partial': [name for name, found in zip(names, results) if found is None]" in route          # unreadable is listed, never "nobody waits"
    assert '_redact_deep(' in route
    feed = api.split('async def _activity_of(', 1)[1].split('\n# ----', 1)[0]   # one Bot's items + the shared feed of /activity and the Timeline (v0.8 section 2)
    assert 'await _activity_items(' in api.split('async def get_activity(', 1)[1].split('\n\n\n', 1)[0]
    assert "waits = await run_in_threadpool(waiting.read, path, name, _REDACT)" in feed and "partial.add('waiting')" in feed
    assert 'activity.decorate(run_items, name, waits)' in feed and 'activity.waiting_item(name, w)' not in feed


def test_nothing_in_the_waiting_path_answers_or_calls_hermes_back():
    """Invariant 6: the derivation only reads. It names no approval route, no resolver, no network call, no write."""
    code = (SRC / 'waiting.py').read_text().split('"""', 2)[2]
    assert not re.search(r'resolve|approvals|/approval|ApiClient|urllib|http|\.write|INSERT|UPDATE|DELETE|set_status|audit', code)
