"""Red team (Lume, 31/10), the guard for R-13b (A-212): once the mark of a full fold that is not the simple lowercase stops making the action "unclean" (so nothing asks because of it) and becomes a second flag that only the PERMISSIVE
match reads, an action that holds the sharp s, the capital sharp s, the final sigma (or a letter like them) must STILL not be covered by an allow or an explicit rule, in any branch. These tests hold TODAY (R-13 does it through `clean`)
and must keep holding after R-13b: a second flag that one branch forgets to read is exactly how an allow would cover it again.
Method: an `allow` on `*` for the terminal covers every segment of a command that is read whole, so the action is permitted if and only if nothing marks it; each vector is run twice, with `ss` (the control: permitted) and with the
character (not permitted). The vectors are the places the flag could be lost: a second or third segment (`;`, `&&`, `|`, newline), a substitution (`$(...)`, backticks), an assignment before the executable, a wrapper (`sudo`, `env`, `nohup`),
code given inline (`bash -c`; `python -c` is left out: with `ss` the engine already does not read it, so the control would not be covered either), a here-document, a character beyond the cap of the command (so the fold never sees it), a letter that only NFKC turns into the final sigma, the names of the action (tool, toolset, MCP server), and a
command together with a path or a recipient (which keep the exact NFC text and are not folded).
F-A212-1 (A-213: it is part of R-13b, and this test is its acceptance): the facts of an action with a name other than `path` or `recipient` are folded on both sides (`_conditions_hold`), so a rule with the condition (`note`, `pass`) would cover the fact
(`note`, `pa<U+00DF>`); the adapters of the hook send only `path` (0.6.0) and `recipient` (0.7.0) today, and the next adapter must not find the hole open. It FAILS on R-13b until `_view` reads the predicate on those facts."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the rules')

import backend.rules as real  # noqa: E402

SS, CAP, FINAL, MATH_FINAL, CHEROKEE = chr(0xDF), chr(0x1E9E), chr(0x3C2), chr(0x1D6D3), chr(0xAB70)   # U+AB70: CHEROKEE SMALL LETTER A (its full fold is the capital letter, not the lowercase)
CHARS = {'sharp-s': SS, 'capital-sharp-s': CAP, 'final-sigma': FINAL, 'math-final-sigma': MATH_FINAL, 'cherokee-small-a': CHEROKEE}
CONTROL = 'ss'
SIGMA_PLAIN = chr(0x3C3)   # what the full fold makes of the final sigma


def permitted(level, action, **match):
    rule = tp.rule(real, 'x', level, **match)
    decision = real.evaluate([rule], action)
    return decision.effect is level and any(h.rule_id == 'x' for h in decision.hits)      # an explicit rule's effect is `explicit`, an allow's is `allow`


def terminal(text):
    return real.Action(bot='vendas', tool='terminal', command=text)


# `{x}` is `ss` for the control and the character for the attack
TEMPLATES = {
    'one command': 'echo Stra{x}e',
    'second segment, `;`': 'git status; ls Stra{x}e',
    'second segment, `&&`': 'true && ls Stra{x}e',
    'second segment, pipe': 'echo a | grep Stra{x}e',
    'second segment, newline': 'git status\nls Stra{x}e',
    'third segment': 'git status; ls; ls Stra{x}e',
    'first segment only': 'ls Stra{x}e; git status',
    'command substitution': 'echo $(ls Stra{x}e)',
    'backticks': 'echo `ls Stra{x}e`',
    'assignment before the executable': 'X=Stra{x}e ls',
    'sudo': 'sudo ls Stra{x}e',
    'env': 'env X=1 ls Stra{x}e',
    'nohup, background': 'nohup ls Stra{x}e &',
    'bash -c': "bash -c 'ls Stra{x}e'",
    'here-document': 'cat <<EOF\nStra{x}e\nEOF',
    'inside a quoted argument': 'git commit -m "Stra{x}e"',
    'a host': 'curl http://fa{x}.de/x',
    'a flag': 'ls --color=Stra{x}e',
}


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('name,template', list(TEMPLATES.items()), ids=list(TEMPLATES))
def test_control_the_same_command_with_ss_is_covered_by_an_allow_on_everything(level, name, template):
    assert permitted(level, terminal(template.format(x=CONTROL)), tools=('terminal',), commands=('*',)), name


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('why,c', list(CHARS.items()), ids=list(CHARS))
@pytest.mark.parametrize('name,template', list(TEMPLATES.items()), ids=list(TEMPLATES))
def test_a_command_with_the_character_is_covered_by_no_allow_wherever_it_sits(level, name, template, why, c):
    assert not permitted(level, terminal(template.format(x=c)), tools=('terminal',), commands=('*',)), (name, why)


@pytest.mark.parametrize('c', CHARS.values(), ids=list(CHARS))
def test_a_character_beyond_the_cap_of_the_command_leaves_it_unreadable_for_an_allow_anyway(c):
    long_text = 'echo ' + 'a' * (real.MAX_COMMAND + 100) + ' Stra' + c + 'e'
    assert not permitted(real.Level.ALLOW, terminal(long_text), tools=('terminal',), commands=('*',))
    assert not permitted(real.Level.ALLOW, terminal('echo ' + 'a' * (real.MAX_COMMAND + 100)), tools=('terminal',), commands=('*',))   # the cap alone does it; the character adds nothing to lose


NAMES = {'tool': (dict(tools=('read_*',)), lambda x: real.Action(bot='vendas', tool='read_pa' + x)),
         'toolset': (dict(tools=(), toolsets=('glass',)), lambda x: real.Action(bot='vendas', tool='t', toolset='gla' + x)),
         'MCP server': (dict(tools=(), servers=('glass',)), lambda x: real.Action(bot='vendas', tool='mcp__glass__x', mcp_server='gla' + x))}


@pytest.mark.parametrize('name', list(NAMES))
def test_control_the_name_written_with_ss_is_covered(name):
    match, build = NAMES[name]
    assert permitted(real.Level.ALLOW, build(CONTROL), **match)


@pytest.mark.parametrize('why,c', [(k, v) for k, v in CHARS.items() if k != 'cherokee-small-a'], ids=[k for k in CHARS if k != 'cherokee-small-a'])
@pytest.mark.parametrize('name', list(NAMES))
def test_a_name_with_the_character_is_covered_by_no_allow(name, why, c):
    match, build = NAMES[name]
    wide = dict(match, tools=('*',)) if name != 'tool' else match                              # a `*` on the tool so only the name under test can decide
    assert not permitted(real.Level.ALLOW, build(c), **wide)


@pytest.mark.parametrize('c', CHARS.values(), ids=list(CHARS))
def test_a_command_with_the_character_next_to_a_path_or_a_recipient_is_covered_by_no_allow(c):
    path = real.Action(bot='vendas', tool='write_file', command='cp a Stra' + c + 'e', facts=(('path', 'workspace:pages/a.md'),))
    assert not permitted(real.Level.ALLOW, path, tools=('write_file',), commands=('*',), conditions=(('path:under', 'workspace:pages'),))
    send = real.Action(bot='vendas', tool='send_message', command='echo Stra' + c + 'e', facts=(('recipient', 'bot:vendas'),))
    assert not permitted(real.Level.ALLOW, send, tools=('send_message',), commands=('*',), conditions=(('recipient:eq', 'bot:vendas'),))
    ascii_path = real.Action(bot='vendas', tool='write_file', command='cp a Strasse', facts=(('path', 'workspace:pages/a.md'),))
    assert permitted(real.Level.ALLOW, ascii_path, tools=('write_file',), commands=('*',), conditions=(('path:under', 'workspace:pages'),))   # the control


@pytest.mark.parametrize('c', CHARS.values(), ids=list(CHARS))
def test_a_path_or_a_recipient_with_the_character_keeps_its_exact_text_and_an_allow_on_that_exact_text_still_covers_it(c):
    action = real.Action(bot='vendas', tool='write_file', facts=(('path', 'workspace:pa' + c + '/a.md'),))
    assert permitted(real.Level.ALLOW, action, conditions=(('path', 'workspace:pa' + c + '/a.md'),))                       # R-13b must not take this away: paths are not folded
    assert not permitted(real.Level.ALLOW, real.Action(bot='vendas', tool='write_file', facts=(('path', 'workspace:pass/a.md'),)), conditions=(('path', 'workspace:pa' + c + '/a.md'),))


def test_a_condition_on_a_fact_of_another_name_does_not_equate_ss_and_the_sharp_s():
    # A-213: no allow covers an action with one of the letters, with no exception; the adapters of the hook send `path` and `recipient` today, and the next adapter must not find the hole open
    act = lambda x: real.Action(bot='vendas', tool='terminal', facts=(('note', 'pa' + x),))
    assert permitted(real.Level.ALLOW, act('ss'), tools=('terminal',), conditions=(('note', 'pass'),))                    # the control
    assert not permitted(real.Level.ALLOW, act(SS), tools=('terminal',), conditions=(('note', 'pass'),))
    assert not permitted(real.Level.ALLOW, act(FINAL), tools=('terminal',), conditions=(('note', 'pa' + 'ss'),))


# ---- A-214: the names are read like the command: no permission covers one, nothing asks because of it ----------------------------------------------------------------------------
# A tool name keeps being "plain" only when its fold is ASCII (`_TOOL_RE`: a Greek or Cherokee tool name is an unusual spelling and asks, with or without the letter), so the sharp s and the capital sharp s (fold: `ss`) are the tool-name cases;
# a toolset or a server (an MCP server key is the person's own text in the config, and the Hermes sanitises only the names it makes itself) takes all five.
ASCII_FOLD = [SS, CAP]
NAME_ACTIONS = {'tool': (ASCII_FOLD, lambda x: real.Action(bot='vendas', tool='read_pa' + x)),
                'toolset': (list(CHARS.values()), lambda x: real.Action(bot='vendas', tool='t', toolset='gla' + x)),
                'MCP server': (list(CHARS.values()), lambda x: real.Action(bot='vendas', tool='mcp__glass__x', mcp_server='gla' + x))}
NAME_CASES = [(kind, c) for kind, (chars, _build) in NAME_ACTIONS.items() for c in chars]
NAME_IDS = [f'{kind}-{hex(ord(c))}' for kind, c in NAME_CASES]


@pytest.mark.parametrize('kind,c', NAME_CASES, ids=NAME_IDS)
def test_a_name_with_the_character_and_no_rule_is_allowed_by_the_engine(kind, c):
    decision = real.evaluate([], NAME_ACTIONS[kind][1](c))
    assert decision.effect is real.Level.ALLOW and decision.reason is real.ReasonCode.DEFAULT_ALLOW


@pytest.mark.parametrize('c', ASCII_FOLD, ids=['sharp-s', 'capital-sharp-s'])
def test_the_hook_with_an_empty_table_or_an_unrelated_rule_says_none_for_a_tool_with_the_character(c):
    unrelated = tp.rule(real, 'u', real.Level.ASK, tools=('terminal',), commands=('rm -rf *',))
    for table in (real.compile_hook_table([], version=1, toolset_tools={}, mcp_server_tools={}), real.compile_hook_table([unrelated], version=1, toolset_tools={}, mcp_server_tools={})):
        assert real.hook_verdict(table, tool='read_pa' + c, command=None).action == 'none'
        assert real.hook_verdict(table, tool='read_pass', command=None).action == 'none'                 # the control


RESTRICTIVE_NAMES = {'tool': lambda c: dict(tools=('read_pa' + c,)), 'toolset': lambda c: dict(tools=(), toolsets=('gla' + c,)), 'MCP server': lambda c: dict(tools=(), servers=('gla' + c,))}
SPELLINGS = {'tool': lambda x: real.Action(bot='vendas', tool='read_pa' + x), 'toolset': lambda x: real.Action(bot='vendas', tool='t', toolset='gla' + x),
             'MCP server': lambda x: real.Action(bot='vendas', tool='mcp__glass__x', mcp_server='gla' + x)}


@pytest.mark.parametrize('level', [real.Level.ASK, real.Level.BLOCK])
@pytest.mark.parametrize('kind,c', [(k, c) for k, c in NAME_CASES if c in (SS, CAP, FINAL)], ids=[i for (k, c), i in zip(NAME_CASES, NAME_IDS) if c in (SS, CAP, FINAL)])
def test_a_restrictive_rule_on_a_name_written_with_the_character_catches_both_spellings(level, kind, c):
    rule = tp.rule(real, 'x', level, **RESTRICTIVE_NAMES[kind](c))
    if c in ASCII_FOLD or kind == 'tool':                                                       # a toolset or server key whose fold is not ASCII is refused as `bad_glob` ("not a plain name"): a limit that was there before (F-A214-1, Info); the match below still works
        assert [p.code for p in real.validate_rule(rule)] == []
    plain = {SS: 'ss', CAP: 'ss', FINAL: SIGMA_PLAIN}[c]
    for spelling in (c, plain):
        decision = real.evaluate([rule], SPELLINGS[kind](spelling))
        assert decision.effect is level and any(h.rule_id == 'x' for h in decision.hits), (kind, spelling)


@pytest.mark.parametrize('level', [real.Level.ASK, real.Level.BLOCK])
@pytest.mark.parametrize('c', ASCII_FOLD, ids=['sharp-s', 'capital-sharp-s'])
def test_the_hook_table_of_a_restrictive_rule_on_a_tool_name_answers_for_both_spellings(level, c):
    table = real.compile_hook_table([tp.rule(real, 'x', level, tools=('read_pa' + c,))], version=1, toolset_tools={}, mcp_server_tools={})
    want = 'block' if level is real.Level.BLOCK else 'approve'
    for spelling in (c, 'ss'):
        assert real.hook_verdict(table, tool='read_pa' + spelling, command=None).action == want


@pytest.mark.parametrize('field,build', [('tools', lambda c: dict(tools=('read_pa' + c,))), ('toolsets', lambda c: dict(tools=(), toolsets=('gla' + c,))), ('mcp_servers', lambda c: dict(tools=(), servers=('gla' + c,)))], ids=['tools', 'toolsets', 'mcp_servers'])
@pytest.mark.parametrize('c', list(CHARS.values()), ids=list(CHARS))
def test_validate_rule_still_refuses_a_permissive_name_pattern_with_the_character_and_accepts_a_restrictive_one(field, build, c):
    for level in (real.Level.ALLOW, real.Level.EXPLICIT):
        assert 'fold_divergence' in [p.code for p in real.validate_rule(tp.rule(real, 'x', level, **build(c)))]
    if c in ASCII_FOLD or field == 'tools':                                                     # see F-A214-1 above: a non-ASCII toolset or server key is `bad_glob` for a restrictive rule too
        for level in (real.Level.ASK, real.Level.BLOCK):
            assert [p.code for p in real.validate_rule(tp.rule(real, 'x', level, **build(c)))] == []


# ---- A-217: the RULE side of a condition on a fact of another name than `path` and `recipient` ------------------------------------------------------------------------------------
# The action side is above (F-A212-1). Here a permissive rule WRITTEN with the character in the key or the value of such a condition: `_conditions_hold` folds both sides, so the rule (`note`, `pa<U+00DF>`) covers the fact (`note`, `pass`), and
# `validate_rule` says nothing. FIXED by R-13c (A-217), the two tests that were `xfail(strict=True)` are plain tests now: `validate_rule` refuses a permissive rule whose condition key or value fails the predicate (`fold_divergence`) and `_match` never lets it match. `path` and
# `recipient` conditions keep the exact NFC text (a permissive path rule with the character stays valid). A restrictive rule is fine either way: it only matches more.
PLAIN_OF = {SS: 'ss', CAP: 'ss', FINAL: SIGMA_PLAIN, MATH_FINAL: SIGMA_PLAIN}
RULE_SIDE = [(where, c) for where in ('value', 'key') for c in (SS, CAP, FINAL, MATH_FINAL)]
RULE_SIDE_IDS = [f'{where}-{hex(ord(c))}' for where, c in RULE_SIDE]


def condition_of(where, spelling):
    return (('note', 'pa' + spelling),) if where == 'value' else (('pa' + spelling, 'x'),)


def fact_of_spelling(where, spelling):
    return (('note', 'pa' + spelling),) if where == 'value' else (('pa' + spelling, 'x'),)


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('where,c', RULE_SIDE, ids=RULE_SIDE_IDS)
def test_validate_rule_refuses_a_permissive_condition_on_another_fact_written_with_the_character(where, c, level):
    rule = tp.rule(real, 'x', level, tools=('terminal',), conditions=condition_of(where, c))
    assert 'fold_divergence' in [p.code for p in real.validate_rule(rule)]


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('where,c', RULE_SIDE, ids=RULE_SIDE_IDS)
def test_a_permissive_condition_on_another_fact_written_with_the_character_never_matches(where, c, level):
    for spelling in (PLAIN_OF[c], c):
        action = real.Action(bot='vendas', tool='terminal', facts=fact_of_spelling(where, spelling))
        assert not permitted(level, action, tools=('terminal',), conditions=condition_of(where, c)), spelling


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('where', ['value', 'key'])
def test_control_the_same_condition_written_with_ss_covers_its_fact(where, level):
    action = real.Action(bot='vendas', tool='terminal', facts=fact_of_spelling(where, 'ss'))
    assert permitted(level, action, tools=('terminal',), conditions=condition_of(where, 'ss'))


@pytest.mark.parametrize('level', [real.Level.ASK, real.Level.BLOCK])
@pytest.mark.parametrize('where,c', RULE_SIDE, ids=RULE_SIDE_IDS)
def test_a_restrictive_condition_on_another_fact_written_with_the_character_is_valid_and_matches_both_spellings(where, c, level):
    rule = tp.rule(real, 'x', level, tools=('terminal',), conditions=condition_of(where, c))
    assert 'fold_divergence' not in [p.code for p in real.validate_rule(rule)]
    for spelling in (PLAIN_OF[c], c):
        decision = real.evaluate([rule], real.Action(bot='vendas', tool='terminal', facts=fact_of_spelling(where, spelling)))
        assert decision.effect is level and any(h.rule_id == 'x' for h in decision.hits), spelling


@pytest.mark.parametrize('c', CHARS.values(), ids=list(CHARS))
def test_a_permissive_path_condition_with_the_character_stays_valid_because_a_path_keeps_its_exact_text(c):
    for op, value in (('path', 'workspace:pa' + c + '/a.md'), ('path:under', 'workspace:pa' + c), ('path:glob', 'workspace:pa' + c + '/*.md')):
        rule = tp.rule(real, 'x', real.Level.ALLOW, conditions=((op, value),))
        assert 'fold_divergence' not in [p.code for p in real.validate_rule(rule)], (op, value)
