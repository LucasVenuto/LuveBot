"""AA-1 (docs/contracts/plugin-api-v0.11.md section 11, A-255): `exact` in the API of a rule, computed by the engine (`rules.exact`, `rules.has_wildcard`) and carried by `rules_store.api_dict`.

True when the rule covers ONE thing: it names a tool, no pattern of its tools or commands holds an unescaped wildcard, no `path` condition is a tree (`under`) or a glob with a `*` or `?`, and a tool that carries a command comes with the command. The "Always allow" draft
(tool and command escaped) is exact; the same draft edited with a `*` is not: so the screen can say "covers only this exact command" or "covers MORE than you approved" from the server, never from its own reading of a pattern.

Every invariant is a function `inv_<name>(m)` over a rules MODULE: it must hold on the real `backend.rules` and go red on variants of the module with ONE defect each (the real source with one exact replacement, as test_rules_paths.py does)."""
from __future__ import annotations

import importlib
import itertools
from pathlib import Path
import shutil
import sys

import pytest

import backend.rules as real
import backend.rules_store as store

SRC = Path(real.__file__).parent
BS = chr(92)


def match(m, tools=(), commands=(), conditions=()):
    return m.Match(tools=tuple(tools), commands=tuple(commands), conditions=tuple(conditions))


def rule(m, **kw):
    return m.Rule(id='r1', label='r', level=m.Level.ALLOW, scope=m.Scope(m.ScopeKind.BOT, 'vendas'), match=match(m, **kw), state=m.RuleState.DRAFT, origin=m.Origin.HUMAN)


# ---- the draft of "Always allow": exact, whatever the command holds ---------------------------------------------------------------------------------------------------
def inv_the_draft_of_always_allow_is_exact_and_the_same_draft_edited_is_not(m):
    for command in ('ls -la', 'rm -rf /tmp/x', 'echo "a * b ? c"', 'grep "*.py" src', 'find . -name "?.md"'):                  # the commands a draft can be made of (a bare glob word or a backslash is not canonical: no draft, the person is asked each time)
        draft = m.draft_from_always_allow(m.Action(bot='vendas', tool='terminal', command=command), label='x', rule_id='r1')
        assert m.exact(draft.match) is True, (command, draft.match.commands)                   # the wildcards of the command are ESCAPED in the draft: it covers that text and no other
        edited = m.Match(tools=draft.match.tools, commands=(draft.match.commands[0].replace(BS + '*', '*').replace(BS + '?', '?') if ('*' in command or '?' in command) else draft.match.commands[0] + '*',),
                         conditions=draft.match.conditions)
        assert m.exact(edited) is False, (command, edited.commands)                              # one escape taken out, or a `*` added: it covers more than the person saw
    web = m.draft_from_always_allow(m.Action(bot='vendas', tool='web_search'), label='x', rule_id='r2')
    assert web.match.commands == () and m.exact(web.match) is True, 'a tool with no command: the draft names the tool and nothing else'
    path = m.draft_from_always_allow(m.Action(bot='vendas', tool='write_file', facts=(('path', 'workspace:notas/a.md'),)), label='x', rule_id='r3')
    assert path.match.conditions and m.exact(path.match) is True


def inv_a_wildcard_of_the_tools_or_the_commands_is_not_exact(m):
    for tools in (('terminal',), ('web_search',), ('mcp_crm_update_contact',), ('a' + BS + '*b',), ('a' + BS + '?b',), ('a' + BS + BS + 'b',)):
        assert m.exact(match(m, tools=tools, commands=('ls',))) is True, tools
    for tools in (('*',), ('terminal*',), ('mcp_*',), ('web_searc?',), ('terminal', '*'), (BS + BS + '*',)):
        assert m.exact(match(m, tools=tools, commands=('ls',))) is False, tools
    for commands in (('rm *',), ('r?',), ('*',), ('ls', 'rm *'), ('a' + BS + BS + '*',)):
        assert m.exact(match(m, tools=('terminal',), commands=commands)) is False, commands
    for commands in (('rm ' + BS + '*',), ('say ' + BS + '?',), ('a' + BS + BS + 'b',), ('lone' + BS,)):          # an escaped wildcard is a literal; a lone backslash at the end is one too
        assert m.exact(match(m, tools=('terminal',), commands=commands)) is True, commands


def inv_a_rule_that_names_no_tool_is_not_exact(m):
    assert m.exact(match(m)) is False
    assert m.exact(match(m, commands=('ls',))) is False and m.exact(m.Match(toolsets=('browser',))) is False and m.exact(m.Match(mcp_servers=('crm',))) is False
    assert m.exact(match(m, tools=('web_search',))) is True


def inv_a_tool_that_carries_a_command_is_exact_only_with_the_command(m):
    for tool in ('terminal', 'execute_code', 'Terminal', ' terminal '):
        assert m.exact(match(m, tools=(tool,))) is False, tool                                  # every call of it
        assert m.exact(match(m, tools=(tool,), commands=('ls',))) is True, tool
    assert m.exact(match(m, tools=('web_search',))) is True and m.exact(match(m, tools=('kanban_create',))) is True


def inv_a_path_tree_or_glob_is_not_exact_and_an_equality_is(m):
    eq, under, glob = 'path', 'path:under', 'path:glob'
    assert m.exact(match(m, tools=('write_file',), conditions=((eq, 'workspace:notas/a.md'),))) is True
    assert m.exact(match(m, tools=('write_file',), conditions=((glob, 'workspace:notas/a.md'),))) is True, 'a glob with nothing to expand names one file'
    assert m.exact(match(m, tools=('write_file',), conditions=((under, 'workspace:notas'),))) is False, 'a folder is every file below it'
    for value in ('workspace:notas/*.md', 'workspace:notas/a?.md', 'workspace:**/a.md', 'abs:/home/*/x'):
        assert m.exact(match(m, tools=('write_file',), conditions=((glob, value),))) is False, value
    assert m.exact(match(m, tools=('write_file',), conditions=((eq, 'workspace:notas/a.md'), (under, 'workspace:x')))) is False, 'one wide condition is enough'


def inv_an_equality_on_another_fact_never_widens(m):
    assert m.exact(match(m, tools=('kanban_create',), conditions=(('recipient:eq', 'bot:vendas'),))) is True
    assert m.exact(match(m, tools=('terminal',), commands=('ls',), conditions=(('cwd', '/tmp/*'),))) is True, 'a fact is compared for equality: the `*` in it is a character'
    assert m.exact(match(m, tools=('terminal',), commands=('ls',), conditions=(('PATH:UNDER', 'workspace:x'),))) is False, 'a key is read as the engine reads it (folded)'


def inv_every_builtin_rule_is_judged_and_the_wide_ones_are_not_exact(m):
    rules = m.builtin_rules() if hasattr(m, 'builtin_rules') else []
    assert rules, 'the premise: the built-in rules are there'
    answers = [m.exact(r.match) for r in rules]
    assert all(type(a) is bool for a in answers) and not all(answers) and any(m.has_wildcard(p) for r in rules for p in (*r.match.tools, *r.match.commands))


INVARIANTS = {name[4:]: fn for name, fn in globals().items() if name.startswith('inv_')}
SOURCE = (SRC / 'rules.py').read_text()
HAS = '    return any(token is None or token == ("one",) for token in _tokens(pattern))\n'
FIRST = '    if not match.tools or any(has_wildcard(pattern) for pattern in (*match.tools, *match.commands)):\n        return False\n'
MUTATIONS = [
    ('the_draft_of_always_allow_is_exact_and_the_same_draft_edited_is_not', 'the escape is not read', HAS, '    return any(char in pattern for char in "*?")\n'),
    ('the_draft_of_always_allow_is_exact_and_the_same_draft_edited_is_not', 'everything is exact', FIRST, '    if True:\n        return True\n'),
    ('the_draft_of_always_allow_is_exact_and_the_same_draft_edited_is_not', 'nothing is exact', "    return bool(match.commands) or not any(name in COMMAND_TOOLS for name in names)\n", "    return False\n"),
    ('every_builtin_rule_is_judged_and_the_wide_ones_are_not_exact', 'everything is exact', FIRST, '    if True:\n        return True\n'),
    ('every_builtin_rule_is_judged_and_the_wide_ones_are_not_exact', 'the built-in globs are not wildcards', HAS, '    return False\n'),
    ('a_wildcard_of_the_tools_or_the_commands_is_not_exact', 'a star is not a wildcard', HAS, '    return any(token == ("one",) for token in _tokens(pattern))\n'),
    ('a_wildcard_of_the_tools_or_the_commands_is_not_exact', 'a question mark is not a wildcard', HAS, '    return any(token is None for token in _tokens(pattern))\n'),
    ('a_wildcard_of_the_tools_or_the_commands_is_not_exact', 'the commands are not read', FIRST, '    if not match.tools or any(has_wildcard(pattern) for pattern in match.tools):\n        return False\n'),
    ('a_wildcard_of_the_tools_or_the_commands_is_not_exact', 'the tools are not read', FIRST, '    if not match.tools or any(has_wildcard(pattern) for pattern in match.commands):\n        return False\n'),
    ('a_rule_that_names_no_tool_is_not_exact', 'a rule with no tool is exact', FIRST, '    if any(has_wildcard(pattern) for pattern in (*match.tools, *match.commands)):\n        return False\n'),
    ('a_tool_that_carries_a_command_is_exact_only_with_the_command', 'a command tool with no command is exact', "    return bool(match.commands) or not any(name in COMMAND_TOOLS for name in names)\n", "    return True\n"),
    ('a_tool_that_carries_a_command_is_exact_only_with_the_command', 'the name is not folded', '"".join(token[1] for token in _tokens(pattern)).strip().casefold()', '"".join(token[1] for token in _tokens(pattern))'),
    ('a_tool_that_carries_a_command_is_exact_only_with_the_command', 'execute_code is not a command tool', 'COMMAND_TOOLS = ("terminal", "execute_code")', 'COMMAND_TOOLS = ("terminal",)'),
    ('a_path_tree_or_glob_is_not_exact_and_an_equality_is', 'a tree is exact', '        if op == "under" or (op == "glob" and any(char in value for char in "*?")):', '        if (op == "glob" and any(char in value for char in "*?")):'),
    ('a_path_tree_or_glob_is_not_exact_and_an_equality_is', 'a glob is exact', '        if op == "under" or (op == "glob" and any(char in value for char in "*?")):', '        if op == "under":'),
    ('a_path_tree_or_glob_is_not_exact_and_an_equality_is', 'every glob is wide', '        if op == "under" or (op == "glob" and any(char in value for char in "*?")):', '        if op in ("under", "glob"):'),
    ('an_equality_on_another_fact_never_widens', 'a fact with a star is wide', '        op = _path_key(key)\n        if op == "under"', '        op = "glob" if "*" in value else _path_key(key)\n        if op == "under"'),
    ('an_equality_on_another_fact_never_widens', 'the key is not folded', '        op = _path_key(key)\n        if op == "under"', '        op = {"path:under": "under", "path:glob": "glob"}.get(key)\n        if op == "under"'),
]
_counter = itertools.count()


def load_variant(tmp_path_factory, old, new):
    assert SOURCE.count(old) == 1, f'the defect must apply exactly once: {old[:70]!r} ({SOURCE.count(old)})'
    pkg = tmp_path_factory.mktemp('mut') / f'exactmut{next(_counter)}'
    pkg.mkdir()
    (pkg / '__init__.py').write_text('')
    for name in ('rules.py', 'rules_types.py', 'rules_builtin.py', 'unicode_invisible.py', 'unicode_invisible.json'):
        shutil.copy(SRC / name, pkg / name)
    (pkg / 'rules.py').write_text(SOURCE.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.rules')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed)
        INVARIANTS[invariant](variant)


# ---- the API: the field is in every rule, and it comes from the engine --------------------------------------------------------------------------------------------------
def test_the_api_of_a_rule_carries_exact_from_the_engine_and_only_that_field_is_new(monkeypatch):
    exact_rule = rule(real, tools=('terminal',), commands=('ls ' + BS + '*',))
    wide_rule = rule(real, tools=('terminal',), commands=('ls *',))
    assert store.api_dict(exact_rule)['exact'] is True and store.api_dict(wide_rule)['exact'] is False
    assert set(store.api_dict(exact_rule)) == set(store.rule_to_dict(exact_rule)) | {'exact', 'covers'}
    assert 'exact' not in store.rule_to_dict(exact_rule), 'storage and the digest of an activation are unchanged'
    monkeypatch.setattr(real, 'exact', lambda match: 'from the engine')
    assert store.api_dict(wide_rule)['exact'] == 'from the engine', 'the store computes nothing of its own'
    source = (SRC / 'rules_store.py').read_text()
    body = source[source.index('def api_dict'):source.index('def rule_from_dict')]
    assert 'has_wildcard' not in body and "'*'" not in body and '"*"' not in body


def test_the_draft_that_the_approval_answers_carries_exact():
    draft = real.draft_from_always_allow(real.Action(bot='vendas', tool='terminal', command='rm -rf *'), label='x', rule_id='r1')
    assert store.api_dict(draft)['exact'] is True and store.api_dict(draft)['match']['commands'] == ['rm -rf ' + BS + '*']
