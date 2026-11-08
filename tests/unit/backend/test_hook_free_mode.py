"""Free mode (`approval_surface.mode == "free"`, hook 0.4.0): the owner chose that this Bot is not asked. Deterministic, with the REAL
hermes-plugin hook and the REAL built-in table, in process (no Hermes, no harness; the kanban origin is a stand-in for Hermes's DB).

What is pinned (invariants 6 and 8; the CEO's criterion):
* a free Bot's own `approve`s (chmod, rm -r, pip install, a non-canonical command) answer None: nothing is asked, with or without /yolo;
* Block and Handback still stop (chpasswd, make_payment), free or not;
* only the row `free` frees: a `channel` Bot, a row that does not verify, or one that cannot be read, still asks;
* a handoff keeps the restrictions of its ORIGIN: a guarded origin's approve is asked (and blocked under /yolo) even at a free
  destination; a free origin's own approve is not; an origin that cannot be checked is asked about (fail closed);
* the hook's own failure path (rules_unavailable) is unchanged.
Mutations (test_the_mutations_are_caught): the plugin's source with one line changed -> the same scenarios turn red.
"""
import contextlib
import importlib.util
from pathlib import Path
import sqlite3
import sys
import types

import pytest

REPO = Path(__file__).resolve().parents[3]
PLUGIN = REPO / 'hermes-plugin' / '__init__.py'
IDS = dict(task_id='t', session_id='s', tool_call_id='c')
ASKED = {'chmod': ('terminal', {'command': 'chmod 600 /tmp/x'}), 'rm -r': ('terminal', {'command': 'rm -r /tmp/x'}),
         'pip install': ('terminal', {'command': 'pip install cowsay'}),
         'non canonical': ('terminal', {'command': "'ls' -la"})}                    # an executable that is not a plain word
STOPPED = {'chpasswd': ('terminal', {'command': 'chpasswd --help'}), 'make_payment': ('make_payment', {})}   # Handback / Block rules
_n = iter(range(10 ** 6))


def _load(name, path, text=None, **kw):
    spec = importlib.util.spec_from_file_location(name, path, **kw)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def rig(tmp_path, edit=None, *, real_bypass=False):
    """The plugin as a gateway loads it (`edit` = (old, new): the mutation), on a fresh luvebot.db with the built-in table for the
    Bot `p` (the destination) and for `guarded` (a handoff's origin). -> plugin, store, db"""
    if 'luvebot_backend' not in sys.modules:  # the plugin imports the backend under this name, as in the gateway
        _load('luvebot_backend', REPO / 'backend' / '__init__.py', submodule_search_locations=[str(REPO / 'backend')])
    import luvebot_backend.hook as backend_hook
    import luvebot_backend.hook_store as store
    text = PLUGIN.read_text()
    if edit:
        assert text.count(edit[0]) == 1, edit[0]
        text = text.replace(*edit)
    folder = tmp_path / f'plug{next(_n)}'
    folder.mkdir()
    (folder / '__init__.py').write_text(text)
    plugin = _load(f'luvebot_hook_free_under_test_{next(_n)}', folder / '__init__.py')
    db = tmp_path / f'luvebot{next(_n)}' / 'luvebot.db'
    plugin._db = lambda: db
    plugin._channel = lambda: None
    if not real_bypass:
        plugin._approvals_bypassed = lambda: None   # a normal session (no /yolo, approvals on); a test turns it on
    for profile in ('p', 'guarded'):
        store.put_table(db, profile, backend_hook.compile_expected())
    return plugin, store, db


def fake_kanban(monkeypatch, created_by, *, readable=True, origin_has_profile=True):
    """What `_origin_verdict` reads from Hermes: the running task's `created_by` (stamped by Hermes, not by tool arguments)."""
    task = types.SimpleNamespace(created_by=created_by)
    modules = {name: types.ModuleType(name) for name in ('hermes_cli', 'hermes_cli.kanban_db', 'hermes_cli.kanban_db_connect',
                                                          'hermes_cli.profiles')}

    @contextlib.contextmanager
    def connect_closing():
        yield object()

    def get_task(_conn, _task_id):
        if not readable:
            raise RuntimeError('unreadable')
        return task
    modules['hermes_cli.kanban_db'].get_task = get_task
    modules['hermes_cli.kanban_db_connect'].connect_closing = connect_closing
    modules['hermes_cli.profiles'].profile_exists = lambda name: origin_has_profile
    for short in ('kanban_db', 'kanban_db_connect', 'profiles'):
        setattr(modules['hermes_cli'], short, modules[f'hermes_cli.{short}'])
    for name, module in modules.items():
        monkeypatch.setitem(sys.modules, name, module)
    monkeypatch.setenv('HERMES_KANBAN_TASK', 'task-1')


def answers(call, calls):
    return {name: call(tool, args, **IDS) for name, (tool, args) in calls.items()}


def action(answer):
    return None if answer is None else answer['action']


def scenarios(plugin, store, db, monkeypatch):
    call = plugin._make_hook('p')
    monkeypatch.delenv('HERMES_KANBAN_TASK', raising=False)

    # control: not free (the default, then `luvebot` stored): every one is asked, and the stops stop
    normal = answers(call, ASKED)
    assert {k: action(v) for k, v in normal.items()} == dict.fromkeys(ASKED, 'approve'), normal
    stopped = answers(call, STOPPED)
    assert {k: action(v) for k, v in stopped.items()} == dict.fromkeys(STOPPED, 'block'), stopped

    # free: nothing of the Bot's own is asked; Block and Handback are untouched
    store.put_surface(db, 'p', 'free', [], 'basic:ceo')
    assert answers(call, ASKED) == dict.fromkeys(ASKED), 'free: the hook must answer None for its own asks'
    assert answers(call, STOPPED) == stopped, 'free: a block stays the rule\'s own block, word for word'

    # the same under /yolo: a free Bot is not blocked for being asked, a guarded one is (ADR-002 4.4)
    plugin._approvals_bypassed = lambda: 'yolo'
    assert answers(call, ASKED) == dict.fromkeys(ASKED), 'free + /yolo: nothing to ask, nothing to block'
    assert {k: action(v) for k, v in answers(call, STOPPED).items()} == dict.fromkeys(STOPPED, 'block')
    store.put_surface(db, 'p', 'luvebot', [], 'basic:ceo')
    blocked = answers(call, ASKED)
    assert all(action(v) == 'block' and 'approvals_bypassed:yolo' in v['message'] for v in blocked.values()), blocked
    plugin._approvals_bypassed = lambda: None

    # only `free` frees: a channel Bot asks; so does a row that does not verify, and one that cannot be read
    store.put_surface(db, 'p', 'channel', ['telegram:42'], 'basic:ceo')
    assert all(action(v) == 'approve' for v in answers(call, ASKED).values()), 'channel is not free'
    store.put_surface(db, 'p', 'free', [], 'basic:ceo')
    conn = sqlite3.connect(db)
    conn.execute("UPDATE approval_surface SET approvers_json='[\"telegram:7\"]'")      # its digest no longer matches
    conn.commit()
    assert all(action(v) == 'approve' for v in answers(call, ASKED).values()), 'a tampered row reads as luvebot, which asks'
    conn.execute("UPDATE approval_surface SET mode='both'")
    conn.commit()
    assert all(action(v) == 'approve' for v in answers(call, ASKED).values()), 'an unknown mode reads as luvebot'
    conn.close()
    store.put_surface(db, 'p', 'free', [], 'basic:ceo')
    real_read = store.read_surface
    store.read_surface = lambda *_a, **_k: (_ for _ in ()).throw(sqlite3.OperationalError('database is locked'))
    try:
        assert all(action(v) == 'approve' for v in answers(call, ASKED).values()), 'an unreadable surface is not free'
    finally:
        store.read_surface = real_read
    assert answers(call, ASKED) == dict.fromkeys(ASKED)                                  # and free again once it reads

    # a handoff keeps the restrictions of its origin (the task's `created_by`, from Hermes)
    fake_kanban(monkeypatch, 'guarded')
    origin = answers(call, ASKED)
    assert all(action(v) == 'approve' and v['message'].startswith('luvebot:origin:guarded:') for v in origin.values()), origin
    plugin._approvals_bypassed = lambda: 'yolo'
    assert all(action(v) == 'block' and 'approvals_bypassed:yolo' in v['message'] for v in answers(call, ASKED).values())
    plugin._approvals_bypassed = lambda: None
    store.put_surface(db, 'guarded', 'free', [], 'basic:ceo')                           # the origin is free too: its asks go away
    assert answers(call, ASKED) == dict.fromkeys(ASKED), 'a free origin\'s own approve is not asked'
    assert {k: action(v) for k, v in answers(call, STOPPED).items()} == dict.fromkeys(STOPPED, 'block')
    conn = sqlite3.connect(db)
    conn.execute("UPDATE approval_surface SET approvers_json='[\"telegram:7\"]' WHERE profile='guarded'")
    conn.commit()
    conn.close()
    assert all(action(v) == 'approve' for v in answers(call, ASKED).values()), 'a tampered origin row is not free'

    # an origin that cannot be checked is asked about, even at a free destination (fail closed, contract v0.3 4.1)
    fake_kanban(monkeypatch, 'ghost', origin_has_profile=True)                          # a Bot with no table: not a human author
    assert all(action(v) == 'approve' and 'origin_unverifiable' in v['message'] for v in answers(call, ASKED).values())
    fake_kanban(monkeypatch, 'guarded', readable=False)
    assert all(action(v) == 'approve' and 'origin_unreadable' in v['message'] for v in answers(call, ASKED).values())
    monkeypatch.delenv('HERMES_KANBAN_TASK')

    # the hook's own failure path is unchanged: a table it cannot read asks (free does not make a failure into a pass)
    store.put_surface(db, 'p', 'free', [], 'basic:ceo')
    real_table = plugin._table
    plugin._table = lambda profile: (_ for _ in ()).throw(LookupError('no table'))
    try:
        assert all(action(v) == 'approve' and v['message'] == 'luvebot:rules_unavailable' for v in answers(call, ASKED).values())
    finally:
        plugin._table = real_table


def test_free_asks_nothing_and_stops_what_must_stop(tmp_path, monkeypatch):
    scenarios(*rig(tmp_path), monkeypatch)


def test_the_hook_records_no_approve_for_a_call_nobody_was_asked_about(tmp_path, monkeypatch):
    """Free answers None for its own asks: no row says "approve" for a call nobody was asked about (the inbox would show a ghost); what it
    wrote instead is a `free_pass` row (0.5.0, tests/unit/backend/test_hook_free_pass.py); a block still leaves its row."""
    plugin, store, db = rig(tmp_path)
    call = plugin._make_hook('p')
    monkeypatch.delenv('HERMES_KANBAN_TASK', raising=False)
    store.put_surface(db, 'p', 'free', [], 'basic:ceo')
    before = len(store.events(db, 'p', 50))
    answers(call, ASKED)
    rows = store.events(db, 'p', 50)[:len(store.events(db, 'p', 50)) - before]
    assert len(rows) == len(ASKED) and {r['verdict'] for r in rows} == {'free_pass'}
    call('make_payment', {}, **IDS)
    assert store.events(db, 'p', 1)[0]['verdict'] == 'block'


MUTATIONS = [
    ('the free row is ignored (asks again)', 'if own.action == "approve" and _free(profile):', 'if False:'),
    ('free swallows the blocks too', 'if own.action == "approve" and _free(profile):', 'if _free(profile):'),
    ('free loosens a guarded origin', 'verdict.action == "approve" and _free(origin)', 'verdict.action == "approve"'),
    ('an origin that is free is still asked', 'verdict.action == "approve" and _free(origin)', 'False'),
    ('an unreadable surface counts as free',
     '        return store.read_surface(_db(), profile)["mode"] == "free"\n    except Exception:  # noqa: BLE001\n        return False',
     '        return store.read_surface(_db(), profile)["mode"] == "free"\n    except Exception:  # noqa: BLE001\n        return True'),
    ('any mode but luvebot counts as free', 'return store.read_surface(_db(), profile)["mode"] == "free"',
     'return store.read_surface(_db(), profile)["mode"] != "luvebot"'),
]


@pytest.mark.parametrize('label,old,new', MUTATIONS, ids=[m[0] for m in MUTATIONS])
def test_the_mutations_are_caught(tmp_path, monkeypatch, label, old, new):
    rigged = rig(tmp_path, edit=(old, new))      # outside `raises`: a mutation anchor that no longer matches must fail the test
    with pytest.raises(AssertionError) as red:
        scenarios(*rigged, monkeypatch)
    print(f'{label}: RED: {str(red.value).splitlines()[0][:110]}')
