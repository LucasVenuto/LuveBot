"""AA-1b (docs/contracts/plugin-api-v0.11.md section 11, A-286): `covers` in the API of a rule, beside `exact` (backend/rules.py `covers`, carried by `rules_store.api_dict`).

`"wider"` when the rule is not exact, and only then; otherwise `"command"` (it names a command), `"facts"` (no command, narrowed only by a file or a recipient) or `"tool"` (every call of one tool, such as `web_search`). The screen chooses the sentence of "Always allow" from this field, never from its own reading of the pattern; `exact` stays a boolean
and does not change (a screen that tests `if (rule.exact)` must never meet a string).

Every invariant is a function `inv_<name>(m)` over a rules MODULE: it holds on the real `backend.rules` and goes red on a variant with ONE defect (the real source with one exact replacement, as test_rules_exact.py does)."""
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
VALUES = {'wider', 'command', 'facts', 'tool'}


def match(m, tools=(), commands=(), conditions=()):
    return m.Match(tools=tuple(tools), commands=tuple(commands), conditions=tuple(conditions))


def rule(m, **kw):
    return m.Rule(id='r1', label='r', level=m.Level.ALLOW, scope=m.Scope(m.ScopeKind.BOT, 'vendas'), match=match(m, **kw), state=m.RuleState.DRAFT, origin=m.Origin.HUMAN)


def draft(m, **action):
    return m.draft_from_always_allow(m.Action(bot='vendas', **action), label='x', rule_id='aa-1')


def inv_covers_is_wider_if_and_only_if_the_rule_is_not_exact(m):
    table = [match(m), match(m, commands=('ls',)), match(m, tools=('*',)), match(m, tools=('terminal',)), match(m, tools=('terminal',), commands=('ls',)), match(m, tools=('terminal',), commands=('rm *',)),
             match(m, tools=('mcp_*',)), match(m, tools=('web_search',)), match(m, tools=('web_search',), conditions=(('path', 'workspace:a.md'),)),
             match(m, tools=('write_file',), conditions=(('path', 'workspace:notas/a.md'),)), match(m, tools=('write_file',), conditions=(('path:under', 'workspace:notas'),)),
             match(m, tools=('write_file',), conditions=(('path:glob', 'workspace:notas/*.md'),)), match(m, tools=('write_file',), conditions=(('path:glob', 'workspace:notas/a.md'),)),
             match(m, tools=('kanban_create',), conditions=(('recipient:eq', 'bot:vendas'),)), match(m, tools=('terminal',), commands=('ls',), conditions=(('cwd', '/tmp'),)),
             match(m, tools=('execute_code',)), match(m, tools=('web_search', '*'))]
    table += [r.match for r in m.builtin_rules()]
    seen = set()
    for item in table:
        found = m.covers(item)
        assert type(found) is str and found in VALUES, (item, found)
        assert (found == 'wider') == (m.exact(item) is False), (item, found, m.exact(item))
        seen.add(found)
    assert seen == VALUES, seen                                                              # the table reaches the four values


def inv_the_four_values_on_four_rules(m):
    assert m.covers(draft(m, tool='terminal', command='ls -la').match) == 'command'            # a terminal draft with its command
    assert m.covers(draft(m, tool='write_file', facts=(('path', 'workspace:notas/a.md'),)).match) == 'facts'         # a write_file draft with its path (as in test_rules_exact.py)
    assert m.covers(draft(m, tool='web_search').match) == 'tool'                                # a tool with no command and no condition
    edited = draft(m, tool='terminal', command='ls -la')
    assert m.covers(match(m, tools=edited.match.tools, commands=(edited.match.commands[0] + '*',), conditions=edited.match.conditions)) == 'wider'    # the same draft edited with a `*`
    tree = draft(m, tool='write_file', facts=(('path', 'workspace:notas/a.md'),))
    assert m.covers(match(m, tools=tree.match.tools, conditions=(('path:under', 'workspace:notas'),))) == 'wider'                                       # a folder instead of a file
    assert m.covers(draft(m, tool='kanban_create', facts=(('recipient', 'bot:vendas'),)).match) == 'facts'                                           # a recipient is a fact too


def inv_a_command_wins_over_the_facts(m):
    both = match(m, tools=('terminal',), commands=('ls',), conditions=(('cwd', '/tmp'),))
    assert m.exact(both) is True and m.covers(both) == 'command'
    only = match(m, tools=('web_search',), conditions=(('path', 'workspace:a.md'),))
    assert m.exact(only) is True and m.covers(only) == 'facts'


def inv_covers_reads_the_exact_of_the_engine_and_has_no_reading_of_its_own(m):
    kept = m.exact
    try:
        m.exact = lambda item: False
        assert m.covers(match(m, tools=('terminal',), commands=('ls',))) == 'wider' and m.covers(match(m, tools=('web_search',))) == 'wider'
        m.exact = lambda item: True
        assert m.covers(match(m, tools=('*',))) == 'tool' and m.covers(match(m, tools=('terminal',), commands=('rm *',))) == 'command'
        assert m.covers(match(m, tools=('write_file',), conditions=(('path:under', 'workspace:x'),))) == 'facts'
    finally:
        m.exact = kept


INVARIANTS = {name[4:]: fn for name, fn in globals().items() if name.startswith('inv_')}
SOURCE = (SRC / 'rules.py').read_text()
GATE = '    if not exact(match):\n        return "wider"\n'
PICK = '    return "command" if match.commands else "facts" if match.conditions else "tool"\n'
MUTATIONS = [
    ('covers_is_wider_if_and_only_if_the_rule_is_not_exact', 'everything is wider', GATE, '    if True:\n        return "wider"\n'),
    ('covers_is_wider_if_and_only_if_the_rule_is_not_exact', 'nothing is wider', GATE, '    if False:\n        return "wider"\n'),
    ('covers_is_wider_if_and_only_if_the_rule_is_not_exact', 'a rule that is exact but has a condition is wider', PICK, '    return "command" if match.commands else "wider" if match.conditions else "tool"\n'),
    ('covers_is_wider_if_and_only_if_the_rule_is_not_exact', 'the tool is a fact', PICK, '    return "command" if match.commands else "facts"\n'),
    ('covers_is_wider_if_and_only_if_the_rule_is_not_exact', 'its own reading of the pattern', GATE, '    if not match.tools or any(has_wildcard(pattern) for pattern in (*match.tools, *match.commands)):\n        return "wider"\n'),
    ('the_four_values_on_four_rules', 'the command is not read', PICK, '    return "command" if False else "facts" if match.conditions else "tool"\n'),
    ('the_four_values_on_four_rules', 'a tool with no condition is facts', PICK, '    return "command" if match.commands else "facts"\n'),
    ('the_four_values_on_four_rules', 'the facts are not read', PICK, '    return "command" if match.commands else "tool"\n'),
    ('the_four_values_on_four_rules', 'nothing is wider', GATE, '    if False:\n        return "wider"\n'),
    ('a_command_wins_over_the_facts', 'the facts win', PICK, '    return "facts" if match.conditions else "command" if match.commands else "tool"\n'),
    ('covers_reads_the_exact_of_the_engine_and_has_no_reading_of_its_own', 'its own reading of the pattern', GATE, '    if not match.tools or any(has_wildcard(pattern) for pattern in (*match.tools, *match.commands)):\n        return "wider"\n'),
    ('covers_reads_the_exact_of_the_engine_and_has_no_reading_of_its_own', 'the rule is never wider', GATE, '    if False:\n        return "wider"\n'),
]
_counter = itertools.count()


def load_variant(tmp_path_factory, old, new):
    assert SOURCE.count(old) == 1, f'the defect must apply exactly once: {old[:70]!r} ({SOURCE.count(old)})'
    pkg = tmp_path_factory.mktemp('mut') / f'coversmut{next(_counter)}'
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


# ---- the API: the field is in every rule, it comes from the engine, and `exact` did not move ---------------------------------------------------------------------------
def test_the_api_of_a_rule_carries_covers_beside_a_boolean_exact(monkeypatch):
    exact_rule = rule(real, tools=('terminal',), commands=('ls ' + BS + '*',))
    wide_rule = rule(real, tools=('terminal',), commands=('ls *',))
    for item, covers in ((exact_rule, 'command'), (wide_rule, 'wider')):
        out = store.api_dict(item)
        assert out['covers'] == covers and type(out['exact']) is bool and out['exact'] is (covers != 'wider')
        assert set(out) == set(store.rule_to_dict(item)) | {'exact', 'covers'}, 'only two fields are new'
        assert 'covers' not in store.rule_to_dict(item) and 'exact' not in store.rule_to_dict(item), 'storage and the digest of an activation are unchanged'
    monkeypatch.setattr(real, 'covers', lambda match: 'from the engine')
    assert store.api_dict(wide_rule)['covers'] == 'from the engine', 'the store computes nothing of its own'
    source = (SRC / 'rules_store.py').read_text()
    body = source[source.index('def api_dict'):source.index('def rule_from_dict')]
    assert 'has_wildcard' not in body and "'*'" not in body and '"*"' not in body and "'wider'" not in body


def test_the_four_rules_in_the_api():
    four = {
        'command': rule(real, tools=('terminal',), commands=('ls -la',)),
        'facts': rule(real, tools=('write_file',), conditions=(('path', 'workspace:notas/a.md'),)),
        'tool': rule(real, tools=('web_search',)),
        'wider': rule(real, tools=('terminal',), commands=('ls -la*',)),
    }
    for expected, item in four.items():
        assert store.api_dict(item)['covers'] == expected, expected
    assert [store.api_dict(item)['exact'] for item in four.values()] == [True, True, True, False]


def test_every_rule_of_the_api_has_one_of_the_four_values():
    for item in real.builtin_rules():
        out = store.api_dict(item)
        assert out['covers'] in VALUES and (out['covers'] == 'wider') == (out['exact'] is False), item.id


def test_the_draft_that_the_approval_answers_and_the_suggestion_carry_covers(tmp_path):
    import backend.approvals as approvals
    row = {'bot': 'vendas', 'tool': 'terminal', 'command_redacted': 'rm -rf *', 'paths_json': None}
    answered, error = approvals._draft(tmp_path / 'rules.db', row, {'label': 'x', 'level': 'allow'})
    assert error is None and answered['exact'] is True and answered['covers'] == 'command', (answered, error)
    web = {'bot': 'vendas', 'tool': 'web_search', 'command_redacted': None, 'paths_json': None}
    assert approvals._draft(tmp_path / 'rules2.db', web, {'label': 'x', 'level': 'allow'})[0]['covers'] == 'tool'
    path = {'bot': 'vendas', 'tool': 'write_file', 'command_redacted': None, 'paths_json': '["workspace:notas/a.md"]'}
    assert approvals._draft(tmp_path / 'rules3.db', path, {'label': 'x', 'level': 'allow'})[0]['covers'] == 'facts'
    import backend.suggestions as suggestions
    text = (SRC / 'suggestions.py').read_text()
    assert 'return rules_store.api_dict(rule)' in text and suggestions.rules_store.api_dict is store.api_dict   # the preview of the suggestion goes through the same function
