"""Red team (Lume, 31/10), F-A214-1 as the Architect closed it (A-215): a KNOWN LIMIT, not a slice, with a trigger and a path written in the contract. This file is the executable form of both: the strict `xfail` is the acceptance of the day the path is taken, and the plain tests are what
the path must keep.
THE LIMIT (measured on be2d805): `validate_rule` refuses a RESTRICTIVE rule on a toolset or an MCP server whose key has a letter that is not ASCII after the fold, as `bad_glob` ("not a plain name"): Greek (including the final sigma), Cyrillic, CJK, Cherokee, and ALSO an accented Latin letter
(`caf<e acute>`, `gest<a tilde>o`); `ss` for the sharp s is fine (its fold is ASCII), and so is a tool name (a glob, no such limit). A person whose MCP server key (the raw key of the Hermes `list_mcp_servers`: the person's own text) has such a letter cannot ask or block on that server by its name,
and the matcher would hit it (the plain test below): the limit is in the validation, not in the match.
THE TRIGGER (A-215): a person who cannot ask or block a server or a toolset by name because its key is not ASCII.
THE PATH (A-215): only the RESTRICTIVE rule, a name that is not empty, has no invisible character and no space; the permissive rule keeps the refusal.
PLAIN (hold today, must hold after the path): an empty name, a name with a space or with an invisible character is still refused for a restrictive rule; a permissive rule on a non-ASCII key is still refused (`bad_glob` or `fold_divergence`); a permissive rule on a plain ASCII key is still valid;
the engine already matches a restrictive rule on a non-ASCII key.
FIXED by R-13c (A-216): the test of a restrictive rule on a non-ASCII key is a plain test now (the mark left with the patch) and also asserts that the hook table of such a rule is not empty (a rule that validates and expands to nothing would be a seal that lies).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the rules')

import backend.rules as real  # noqa: E402

G = lambda *cps: ''.join(map(chr, cps))
NON_ASCII = {'Greek final sigma': 'gla' + chr(0x3C2), 'Greek word': G(0x3B5, 0x3BB, 0x3BB, 0x3B7, 0x3BD, 0x3B9, 0x3BA, 0x3AC), 'Cyrillic': G(0x43F, 0x440, 0x43E, 0x435, 0x43A, 0x442), 'CJK': G(0x4E2D, 0x6587), 'Cherokee': G(0xAB70, 0xAB71),
             'accented Latin (e acute)': 'caf' + chr(0xE9), 'accented Latin (a tilde)': 'gest' + chr(0xE3) + 'o'}
FIELDS = {'toolset': lambda name: dict(tools=(), toolsets=(name,)), 'MCP server': lambda name: dict(tools=(), servers=(name,))}
RESTRICTIVE = [real.Level.ASK, real.Level.HANDBACK, real.Level.BLOCK]


def table_for(level, field, name, key=None):
    """The hook table of ONE restrictive rule on `name`, where the live state calls the toolset or the MCP server `key` (the raw key of the Hermes `list_mcp_servers`, the person's own text) and lists its tools."""
    rule = tp.rule(real, 'x', level, **FIELDS[field](name))
    if field == 'MCP server':
        tools, maps = ('mcp__srv__list', 'mcp__srv__lookup'), dict(toolset_tools={}, mcp_server_tools={key or name: ('mcp__srv__lookup', 'mcp__srv__list')})
    else:
        tools, maps = ('read_file', 'write_file'), dict(toolset_tools={key or name: ('write_file', 'read_file')}, mcp_server_tools={})
    return real.compile_hook_table([rule], version=1, **maps), tools


def codes(level, field, name):
    return [p.code for p in real.validate_rule(tp.rule(real, 'x', level, **FIELDS[field](name)))]


@pytest.mark.parametrize('level', RESTRICTIVE, ids=[x.value for x in RESTRICTIVE])
@pytest.mark.parametrize('field', list(FIELDS))
@pytest.mark.parametrize('why,name', list(NON_ASCII.items()), ids=list(NON_ASCII))
def test_a_restrictive_rule_on_a_toolset_or_server_with_a_non_ascii_key_is_valid_and_its_hook_table_is_not_empty(why, name, field, level):
    assert codes(level, field, name) == []
    table, tools = table_for(level, field, name)                                                # A-216: a rule that validates and expands to nothing would be a seal that lies
    assert [e.rule_id for e in table.entries] == ['x'] and table.problems == ()


@pytest.mark.parametrize('level', RESTRICTIVE, ids=[x.value for x in RESTRICTIVE])
@pytest.mark.parametrize('field', list(FIELDS))
@pytest.mark.parametrize('name', ['', 'a b', 'a\tb', 'a\nb', 'gla' + chr(0x200B) + 'ss', 'gla' + chr(0x200D) + 'ss', 'gla' + chr(0xAD) + 'ss', 'gla' + chr(0x202E) + 'ss'], ids=['empty', 'space', 'tab', 'newline', 'zwsp', 'zwj', 'soft-hyphen', 'rlo'])
def test_a_restrictive_rule_on_an_empty_name_or_one_with_a_space_or_an_invisible_character_stays_refused(name, field, level):
    assert codes(level, field, name) != []


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('field', list(FIELDS))
@pytest.mark.parametrize('why,name', list(NON_ASCII.items()), ids=list(NON_ASCII))
def test_a_permissive_rule_on_a_non_ascii_key_stays_refused(why, name, field, level):
    assert codes(level, field, name) != []


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT, real.Level.ASK, real.Level.BLOCK])
@pytest.mark.parametrize('field', list(FIELDS))
def test_a_rule_on_a_plain_ascii_key_is_valid_at_every_level(field, level):
    assert codes(level, field, 'glass') == []


@pytest.mark.parametrize('level', RESTRICTIVE, ids=[x.value for x in RESTRICTIVE])
@pytest.mark.parametrize('why,name', list(NON_ASCII.items()), ids=list(NON_ASCII))
def test_the_engine_already_matches_a_restrictive_rule_on_a_non_ascii_key_so_the_limit_is_in_the_validation_not_in_the_match(why, name, level):
    rule = tp.rule(real, 'x', level, tools=(), toolsets=(name,))
    decision = real.evaluate([rule], real.Action(bot='vendas', tool='t', toolset=name))
    assert decision.effect is level and any(h.rule_id == 'x' for h in decision.hits)
    assert not real.evaluate([rule], real.Action(bot='vendas', tool='t', toolset='other')).hits


@pytest.mark.parametrize('level', [real.Level.ASK, real.Level.BLOCK])
@pytest.mark.parametrize('field', list(FIELDS))
@pytest.mark.parametrize('why,name', list(NON_ASCII.items()), ids=list(NON_ASCII))
def test_the_hook_table_of_a_restrictive_rule_on_a_non_ascii_key_is_not_empty_and_the_hook_answers_for_its_tools(why, name, field, level):
    table, tools = table_for(level, field, name)                                                # holds today (the expansion reads both sides through canon_name): R-13c must keep it
    assert [e.rule_id for e in table.entries] == ['x'] and table.problems == () and table.entries[0].tools == tools
    want = 'approve' if level is real.Level.ASK else 'block'
    for tool in tools:
        assert real.hook_verdict(table, tool=tool, command=None).action == want
    assert real.hook_verdict(table, tool='terminal', command='ls').action == 'none'


@pytest.mark.parametrize('field', list(FIELDS))
@pytest.mark.parametrize('rule_form,key_form', [('NFC', 'NFD'), ('NFD', 'NFC'), ('NFC', 'NFC'), ('UPPER', 'NFC')])
@pytest.mark.parametrize('base', ['caf' + chr(0xE9), 'gest' + chr(0xE3) + 'o'])
def test_the_expansion_does_not_depend_on_how_the_accent_is_spelled(base, rule_form, key_form, field):
    import unicodedata
    spell = lambda form: {'NFC': unicodedata.normalize('NFC', base), 'NFD': unicodedata.normalize('NFD', base), 'UPPER': unicodedata.normalize('NFC', base).upper()}[form]
    table, tools = table_for(real.Level.BLOCK, field, spell(rule_form), key=spell(key_form))
    assert [e.rule_id for e in table.entries] == ['x'] and table.problems == () and table.entries[0].tools == tools


def test_a_rule_that_cannot_expand_is_an_explicit_problem_never_a_silent_empty_table():
    block = lambda **kw: tp.rule(real, 'x', real.Level.BLOCK, tools=(), **kw)
    unknown = real.compile_hook_table([block(servers=('nope',))], version=1, toolset_tools={}, mcp_server_tools={'caf' + chr(0xE9): ('mcp__srv__lookup',)})
    assert unknown.entries == () and {p.code for p in unknown.problems} == {'unknown_mcp_server', 'empty_expansion'}
    toolless = real.compile_hook_table([block(servers=('caf' + chr(0xE9),))], version=1, toolset_tools={}, mcp_server_tools={'caf' + chr(0xE9): ()})
    assert toolless.entries == () and {p.code for p in toolless.problems} == {'empty_expansion'}
