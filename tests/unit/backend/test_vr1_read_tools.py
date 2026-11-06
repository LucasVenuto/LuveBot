"""VR-1 (decided by the Architect 06/11): the file READ tools get the `path` fact that `write_file` and `patch` have, so that a rule "ask" with a path condition can cover a read under a root.

Backend only: the hook does not extract anything, it calls `workspace.path_facts` and loads the backend of the plugin directory, so there is no new hook version and no "update the hook" per Bot. What changes: `workspace.READ_TOOLS = ('read_file', 'search_files')` answers tags (the same resolver, the same
normaliser as a write), `rules.READ_TOOLS` names them and `rules.ADAPTERS` (the table the validation `path_condition_needs_file_tools` reads, by exact name) lists them for the `path` family. `PATH_TOOLS` does NOT widen (the review card of a WRITE and its pin mean exactly write_file and patch). As for the writes, a class suggestion
no longer offers a read tool (a rule for it would cover every path). And `search_files` with no `path` (it searches the task's cwd) is `unresolved`, which a restrictive rule matches and a permissive one does not.

The end-to-end proofs run the real hook of the plugin over a made-up Hermes (test_hook_0_6.py's rig); each guard has a defect of one line that turns its proof red."""
import importlib
import itertools
import shutil
import sys
from pathlib import Path

import pytest

from test_hook_0_6 import WORKSPACE, World, load_workspace, setup, test_the_two_lists_of_file_tools_are_one, verdict  # noqa: F401
from test_hook_free_mode import rig  # noqa: F401

import backend.rules as real
import backend.workspace as real_workspace

SRC = Path(real.__file__).parent


def reads(tmp_path, monkeypatch, *, rule=True):
    """The hook of Bot `p` with ONE ask rule: the file read tools under `workspace:pages`."""
    world, call, plugin, store, db = setup(tmp_path, monkeypatch, rules=False)
    import luvebot_backend.rules as R
    if rule:
        ask = R.Rule(id='r_reads', label='r', level=R.Level.ASK, scope=R.Scope(R.ScopeKind.GLOBAL),
                     match=R.Match(tools=('read_file', 'search_files'), conditions=(('path:under', 'workspace:pages'),)), state=R.RuleState.ACTIVE, origin=R.Origin.HUMAN)
        store.put_table(db, 'p', R.compile_hook_table([*R.builtin_rules(), ask], version=1, toolset_tools={}, mcp_server_tools={}))
    return world, call, plugin


# ---- end to end: what asks and what does not --------------------------------------------------------------------------------------------------------------
def test_a_read_under_the_root_asks_and_one_outside_does_not(tmp_path, monkeypatch):
    world, call, _plugin = reads(tmp_path, monkeypatch)
    assert verdict(call, 'read_file', path=str(world.root / 'pages' / 'a.md')) == 'approve'
    assert verdict(call, 'read_file', path='pages/sub/b.md') == 'approve', 'a relative path is resolved by Hermes against the task cwd'
    assert verdict(call, 'read_file', path='shortcut/a.md') == 'approve', 'a link INTO pages/ is the file it points at'
    assert verdict(call, 'read_file', path=str(world.root / 'outside' / 'a.md')) is None
    assert verdict(call, 'read_file', path='pages/escape/a.md') is None, 'a link OUT of pages/ is outside'
    assert verdict(call, 'search_files', pattern='x', path='pages') == 'approve' and verdict(call, 'search_files', pattern='x', path='outside') is None
    assert verdict(call, 'write_file', path=str(world.root / 'pages' / 'a.md'), content='x') is None, 'the rule names the read tools: a write is not what it says'


def test_a_read_with_no_path_or_a_path_that_cannot_be_said_is_unresolved_so_it_asks(tmp_path, monkeypatch):
    world, call, _plugin = reads(tmp_path, monkeypatch)
    for args in ({}, {'path': None}, {'path': ''}, {'path': '   '}, {'path': 5}, {'path': ['pages']}):
        assert verdict(call, 'read_file', **args) == 'approve', args
        assert verdict(call, 'search_files', pattern='x', **args) == 'approve', ('search_files', args)        # a search with no path looks in the cwd: it may be a protected folder
    world.container, world.calls[:] = 'docker', []                                                       # a sandbox: the host cannot say where it lands
    assert verdict(call, 'read_file', path='outside/a.md') == 'approve' and verdict(call, 'search_files', pattern='x', path='outside') == 'approve'
    assert world.calls == [], "Hermes's resolver is not even asked for a path of a container"


def test_the_path_of_a_read_is_the_path_whatever_else_the_arguments_say(tmp_path, monkeypatch):
    world, call, _plugin = reads(tmp_path, monkeypatch)
    assert verdict(call, 'read_file', path='outside/a.md', mode='patch') is None, 'a read is not parsed as a patch (a `mode` is not its business)'
    assert verdict(call, 'read_file', path='pages/a.md', mode='patch') == 'approve'
    assert verdict(call, 'search_files', pattern='x', path='pages', patch='*** Begin Patch') == 'approve'


def test_a_table_without_a_read_rule_never_calls_the_resolver_for_a_read(tmp_path, monkeypatch):
    world, call, _plugin = reads(tmp_path, monkeypatch, rule=False)
    assert verdict(call, 'read_file', path='pages/a.md') is None and verdict(call, 'search_files', pattern='x') is None
    assert world.calls == [], 'a Bot with no path rule never pays for the resolver'
    assert verdict(call, 'terminal', command='cat pages/a.md') in (None, 'approve', 'block') and world.calls == [], 'a tool with no adapter leaves the fact out'


def test_a_tool_with_no_adapter_has_no_facts_and_the_two_modules_say_the_same_tools(tmp_path, monkeypatch):
    _world, _call, _plugin = reads(tmp_path, monkeypatch)
    from luvebot_backend import workspace
    for tool in ('terminal', 'web_search', 'execute_code', 'delegate_task', 'kanban_create', 'read_file_x'):
        assert workspace.path_facts(tool, {'path': 'pages/a.md', 'command': 'cat pages/a.md'}, 't', lambda: {}) is None, tool
    assert workspace.path_facts('read_file', {'path': 'pages/a.md'}, 't', lambda: {}) not in (None, [])
    (tmp_path / 'pin').mkdir()
    test_the_two_lists_of_file_tools_are_one(tmp_path / 'pin', monkeypatch)                  # the pin of the write tools, seen through the same module


def test_a_read_has_no_review_card_and_the_write_tools_are_unchanged(tmp_path, monkeypatch):
    _world, _call, plugin = reads(tmp_path, monkeypatch)
    assert plugin._review_detail('read_file', {'path': 'pages/a.md'}, 't', {}) is None and plugin._review_detail('search_files', {'path': 'pages'}, 't', {}) is None
    assert real_workspace.PATH_TOOLS == real.PATH_TOOLS == ('write_file', 'patch'), 'PATH_TOOLS does not widen'
    assert real_workspace.READ_TOOLS == real.READ_TOOLS == ('read_file', 'search_files'), 'the two modules say the same'
    assert set(real.ADAPTERS) == {'write_file', 'patch', 'read_file', 'search_files', 'kanban_create', 'cronjob_manage'}



# ---- the validation of a rule -----------------------------------------------------------------------------------------------------------------------------
def rule_of(m, tools=(), conditions=(), toolsets=(), commands=(), level=None):
    return m.Rule(id='r1', label='r', level=level or m.Level.ASK, scope=m.Scope(m.ScopeKind.GLOBAL),
                  match=m.Match(tools=tuple(tools), toolsets=tuple(toolsets), commands=tuple(commands), conditions=tuple(conditions)), state=m.RuleState.DRAFT, origin=m.Origin.HUMAN)


def inv_a_path_condition_goes_with_the_file_tools_read_or_write(m):
    under = (('path:under', 'workspace:pages'),)
    for tools in (('read_file',), ('search_files',), ('read_file', 'search_files'), ('read_file', 'write_file'), ('search_files', 'patch'), ('write_file',), ('patch',), ('write_file', 'patch', 'read_file', 'search_files')):
        assert m.validate_rule(rule_of(m, tools, under)) == (), tools
    for conditions in ((('path', 'workspace:pages/a.md'),), (('path:glob', 'workspace:pages/*.md'),), (('path:under', 'abs:/srv/notes'),)):
        assert m.validate_rule(rule_of(m, ('read_file',), conditions)) == (), conditions
    bad = {'a tool with no adapter': dict(tools=('terminal',)), 'a glob over names': dict(tools=('read_*',)), 'a read tool and another with no adapter': dict(tools=('read_file', 'terminal')), 'a toolset': dict(tools=('read_file',), toolsets=('files',)),
           'a command': dict(tools=('read_file',), commands=('cat *',)), 'no tool': dict(tools=()), 'a recipient tool': dict(tools=('kanban_create',)), 'a case variant': dict(tools=('Read_File',))}
    for label, kw in bad.items():
        assert {p.code for p in m.validate_rule(rule_of(m, conditions=under, **kw))} == {'path_condition_needs_file_tools'}, label
    mixed = m.validate_rule(rule_of(m, ('read_file',), (('recipient:eq', 'bot:vendas'),)))
    assert {p.code for p in mixed} == {'condition_needs_adapter_tools'}, 'a read tool has the path adapter and no other: a recipient condition on it is refused'
    assert 'read_file' in next(p.detail for p in m.validate_rule(rule_of(m, ('terminal',), under)) if p.code == 'path_condition_needs_file_tools'), 'the sentence names the tools it takes'


def inv_the_tuples_and_the_adapters_say_what_they_said(m):
    assert m.READ_TOOLS == ('read_file', 'search_files') and m.PATH_TOOLS == ('write_file', 'patch')
    assert set(m.ADAPTERS) == {'write_file', 'patch', 'read_file', 'search_files', 'kanban_create', 'cronjob_manage'} and all(m.ADAPTERS[t] == ('path',) for t in ('write_file', 'patch', 'read_file', 'search_files'))
    assert all(m.ADAPTERS[t] == ('recipient',) for t in ('kanban_create', 'cronjob_manage'))


RULES_SOURCE = (SRC / 'rules.py').read_text()
INVARIANTS = {'a_path_condition_goes_with_the_file_tools_read_or_write': inv_a_path_condition_goes_with_the_file_tools_read_or_write, 'the_tuples_and_the_adapters_say_what_they_said': inv_the_tuples_and_the_adapters_say_what_they_said}
RULES_MUTATIONS = [
    ('a_path_condition_goes_with_the_file_tools_read_or_write', 'the read tools have no adapter', ' "read_file": ("path",), "search_files": ("path",),', ''),
    ('a_path_condition_goes_with_the_file_tools_read_or_write', 'search_files has no adapter', ' "search_files": ("path",),', ''),
    ('a_path_condition_goes_with_the_file_tools_read_or_write', 'a read tool has the recipient adapter', '"read_file": ("path",),', '"read_file": ("path", "recipient"),'),
    ('a_path_condition_goes_with_the_file_tools_read_or_write', 'the sentence does not say the read tools', "write_file, patch, read_file and/or search_files, by exact name", "write_file and/or patch, by exact name"),
    ('the_tuples_and_the_adapters_say_what_they_said', 'the adapters lose a read tool', ' "read_file": ("path",), "search_files": ("path",),', ' "read_file": ("path",),'),
    ('the_tuples_and_the_adapters_say_what_they_said', 'PATH_TOOLS widens', 'PATH_TOOLS = ("write_file", "patch") ', 'PATH_TOOLS = ("write_file", "patch", "read_file") '),
    ('the_tuples_and_the_adapters_say_what_they_said', 'search_files is not a read tool', 'READ_TOOLS = ("read_file", "search_files") ', 'READ_TOOLS = ("read_file",) '),
    ('the_tuples_and_the_adapters_say_what_they_said', 'a recipient tool loses its adapter', '"cronjob_manage": ("recipient",)}', '"cronjob_manage": ("path",)}'),
]
_n = itertools.count()


def load_rules(tmp_path_factory, old, new):
    assert RULES_SOURCE.count(old) == 1, f'the defect must apply exactly once: {old[:70]!r} ({RULES_SOURCE.count(old)})'
    pkg = tmp_path_factory.mktemp('vr1mut') / f'vr1mut{next(_n)}'
    pkg.mkdir()
    (pkg / '__init__.py').write_text('')
    for name in ('rules.py', 'rules_types.py', 'rules_builtin.py', 'unicode_invisible.py', 'unicode_invisible.json'):
        shutil.copy(SRC / name, pkg / name)
    (pkg / 'rules.py').write_text(RULES_SOURCE.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.rules')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in RULES_MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', RULES_MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in RULES_MUTATIONS])
def test_each_rules_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = load_rules(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed)
        INVARIANTS[invariant](variant)


# ---- the extraction: defects of workspace.py, each caught by the end-to-end proof that names it -------------------------------------------------------------------
WORKSPACE_MUTATIONS = {
    'the read tools have no adapter': ([("    if tool_name not in PATH_TOOLS and tool_name not in READ_TOOLS:\n", "    if tool_name not in PATH_TOOLS:\n")], test_a_read_under_the_root_asks_and_one_outside_does_not),
    'search_files is not a read tool': ([("READ_TOOLS = ('read_file', 'search_files')\n", "READ_TOOLS = ('read_file',)\n")], test_a_read_under_the_root_asks_and_one_outside_does_not),
    'read_file is not a read tool': ([("READ_TOOLS = ('read_file', 'search_files')\n", "READ_TOOLS = ('search_files',)\n")], test_a_read_under_the_root_asks_and_one_outside_does_not),
    'a read is parsed as a patch': ([("    if tool_name in READ_TOOLS or tool_name == 'write_file' or args.get('mode', 'replace') != 'patch':", "    if tool_name == 'write_file' or args.get('mode', 'replace') != 'patch':")],
                                    test_the_path_of_a_read_is_the_path_whatever_else_the_arguments_say),
    'the container check is gone': ([("        if hermes.container_backend_for_task(tid) is not None:", "        if False:")], test_a_read_with_no_path_or_a_path_that_cannot_be_said_is_unresolved_so_it_asks),
    'a missing path is a path': ([("            if not isinstance(text, str) or not text.strip():\n                tags.append(UNRESOLVED)\n                continue\n", "")], test_a_read_with_no_path_or_a_path_that_cannot_be_said_is_unresolved_so_it_asks),
    'every tool has the adapter': ([("    if tool_name not in PATH_TOOLS and tool_name not in READ_TOOLS:\n        return None\n", "")], test_a_tool_with_no_adapter_has_no_facts_and_the_two_modules_say_the_same_tools),
    'PATH_TOOLS widens': ([("PATH_TOOLS = ('write_file', 'patch')\n", "PATH_TOOLS = ('write_file', 'patch', 'read_file')\n")], test_a_tool_with_no_adapter_has_no_facts_and_the_two_modules_say_the_same_tools),
}


@pytest.mark.parametrize('label', sorted(WORKSPACE_MUTATIONS))
def test_each_workspace_mutation_turns_its_proof_red(label, tmp_path, monkeypatch):
    edits, check = WORKSPACE_MUTATIONS[label]
    (tmp_path / 'boot').mkdir()
    rig(tmp_path / 'boot')                                                                     # makes `luvebot_backend` importable
    mutated = load_workspace(edits)
    monkeypatch.setitem(sys.modules, 'luvebot_backend.workspace', mutated)
    import luvebot_backend
    monkeypatch.setattr(luvebot_backend, 'workspace', mutated, raising=False)
    (tmp_path / 'run').mkdir()
    with pytest.raises(AssertionError):
        check(tmp_path / 'run', monkeypatch)
