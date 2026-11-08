"""A `kanban_create` a LuveBot rule BLOCKED leaves the hook's `handoff` row (written before the rules decide) and then a `block` row of the SAME call, and no task. The
`handoff` row must not count as evidence of a delegation: `handoffs.ingest` marks a task `recorded` (no `handoff.unrecorded` alarm) only with a handoff row of a call that
was not blocked. Before the fix, a task later created with the same assignee and title by a path the hook does not see (the terminal, a script) read as recorded:
the blocked attempt hid the bypass. Mutations of handoffs.py are red."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
NOW = 1_800_000_000.0


def load(edit=None):
    name = f'ho_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules[name] = pkg
    spec.loader.exec_module(pkg)
    if edit:
        source = (BACKEND / 'handoffs.py').read_text()
        assert source.count(edit[0]) == 1, edit[0]
        module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.handoffs', loader=None))
        module.__package__ = name
        sys.modules[f'{name}.handoffs'] = module
        exec(compile(source.replace(*edit), str(BACKEND / 'handoffs.py'), 'exec'), module.__dict__)
    return importlib.import_module(f'{name}.handoffs'), importlib.import_module(f'{name}.hook_store')


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append((action, (payload or {}).get('task_id')))
        return fn()


def hook_calls(hs, db, call_id, title, verdict):
    """What the hook writes for one kanban_create: the `handoff` row first, then the verdict row (a `block`, or an `approve` a person decides)."""
    import hashlib
    message = f"suporte|{hashlib.sha256(title.encode()).hexdigest()}"
    hs.record_event(db, 'vendas', 'kanban_create', None, 'handoff', message, 't', 's', call_id, None)
    hs.record_event(db, 'vendas', 'kanban_create', 'r1', verdict, 'luvebot:block:r1', 't', 's', call_id, None)


def task(task_id, title):
    return {'id': task_id, 'title': title, 'created_by': 'vendas', 'assignee': 'suporte', 'created_at': NOW, 'status': 'ready'}


def checks(modules, tmp_path):
    handoffs, hs = modules
    db = tmp_path / 'luvebot.db'
    names = ['vendas', 'suporte']
    hook_calls(hs, db, 'call_blocked', 'Cobrar o cliente', 'block')          # a rule blocked it: no task came of it
    hook_calls(hs, db, 'call_asked', 'Revisar o contrato', 'approve')       # a person approved it: the task did come
    audit = Audit()
    done = handoffs.ingest(db, audit, names, lambda: [task('t_bypass', 'Cobrar o cliente'), task('t_real', 'Revisar o contrato')], now=NOW)
    assert sorted(done) == ['t_bypass', 't_real']
    assert ('handoff.unrecorded', 't_bypass') in audit.rows                  # the blocked attempt is no evidence for a task made behind the hook's back
    assert ('handoff.unrecorded', 't_real') not in audit.rows               # the approved call is


def test_a_blocked_half_is_no_evidence_of_a_delegation(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('old,new', [
    ("AND NOT (tool_call_id <> '' AND EXISTS ", "AND NOT (1=0 AND EXISTS "),
    ("AND b.tool=h.tool ", "AND b.tool='nothing' "),
    ("b.profile=h.profile AND b.verdict='block'", "b.profile=h.profile AND b.verdict='approve'"),
    ("AND b.tool_call_id=h.tool_call_id", "AND b.tool_call_id<>h.tool_call_id"),
], ids=['blocked_half_counts', 'another_tool_matches_nothing', 'only_an_approve_hides_it', 'another_call_hides_it'])
def test_each_mutation_is_caught(tmp_path, old, new):
    with pytest.raises(Exception):  # noqa: B017
        checks(load((old, new)), tmp_path)


def test_a_half_without_a_call_id_is_kept_as_it_was(tmp_path):
    """The pairing needs the call id; a row without one is not guessed about (the old behaviour: it counts)."""
    handoffs, hs = load()
    db = tmp_path / 'luvebot.db'
    hook_calls(hs, db, '', 'Sem id', 'block')
    audit = Audit()
    handoffs.ingest(db, audit, ['vendas', 'suporte'], lambda: [task('t_x', 'Sem id')], now=NOW)
    assert ('handoff.unrecorded', 't_x') not in audit.rows
