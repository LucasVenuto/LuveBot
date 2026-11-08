"""Red team (Lume, 31/10) of R-13 as A-210 and A-211 widen it (Brasa's patch `r13-casefold-completo-nomes-e-padroes-permissivos-hook-0-8-5`): `fold_divergence` and the one predicate `nfkc.lower() != nfkc.casefold()` in three places.
Needs that patch: on bb54c37 alone the plain tests below fail by design.

HELD (plain; the questions of Prumo and the attacks I added, measured on bb54c37 plus the patch):
 (a) a RESTRICTIVE rule written with the sharp s, the capital sharp s or the final sigma is accepted and still catches both spellings, in the engine and in the compiled hook table (the pattern is stored folded, `curl *fass.de*`);
     an ALLOW or EXPLICIT rule written with one is refused with `fold_divergence` (422, own code) in the command, tool, toolset and MCP server patterns, also when a Bot proposes it (`suggested_by_bot`: a restrictive proposal is still accepted as a suggestion);
     a permissive rule that is already stored never matches either spelling.
 (b) the digest of a hook table made of restrictive rules does not move (pinned below, measured on bb54c37 before the patch and after it); an allow never enters the table.
 (c) paths and recipients keep the exact NFC text (a path with a sharp s still makes a "Sempre permitir" draft).
 A-211: `draft_from_always_allow` refuses the sharp s in the command, the tool and the names with `fold_divergence` BEFORE `noncanonical_action`, and `approvals._draft` hands that code to the route (not `draft_not_saved`); the other codes keep their own.
 A character that only NFKC turns into the final sigma (U+1D6D3) is caught too.
OPEN (`xfail(strict=True)`; the decision is the Architect's):
 F-A210-1 (Baixa, usability and approval fatigue): the mark is on the ACTION, so a command that merely CONTAINS one of these letters asks with NO rule at all (engine `ask` / `noncanonical_action`; the hook answers `approve` on an EMPTY table; before the patch: allow / none): a German commit message or
   file name (`git commit -m "Stra<U+00DF>e"`), Greek text (the final sigma ends most words) and, because Python's `lower()` applies the Final_Sigma context and `casefold()` does not, Greek CAPITALS that end a word (`KOSMOS`). "Sempre permitir" is refused for them and, until the screen reads `draft_error` (R-15, F-A211-1), says a rule was made.
   The alternative Prumo keeps (two folds: faithful for the permissive branch, full for the restrictive one) would leave the action clean and make the permissive rule simply not match; not built here.
 F-A210-2 (Info, ACCEPTED AND LEFT by A-212, so no mark here): a permissive rule stored with the character before the refusal has a seal that says nothing (`none` for an allow, no `fold_divergence` problem anywhere), so the card gives no reason for a rule
   that never fires; `validate_rule` does say it (the test of the stored rule above).
FIXED by R-13b (A-212): F-A210-1, the 4 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_fold.py."""
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the rules')

import backend.approvals as approvals  # noqa: E402
import backend.rules as real  # noqa: E402
import backend.rules_service as service  # noqa: E402
from backend.api_errors import PluginError  # noqa: E402

SS, CAP, FINAL, SIGMA, OMICRON, MATH_FINAL = chr(0xDF), chr(0x1E9E), chr(0x3C2), chr(0x3C3), chr(0x3BF), chr(0x1D6D3)
CHARS = [SS, CAP, FINAL, MATH_FINAL]
HOST = {SS: 'fass.de', CAP: 'fass.de', FINAL: SIGMA + OMICRON + SIGMA + '.gr', MATH_FINAL: SIGMA + OMICRON + SIGMA + '.gr'}
PINNED_DIGEST = '262531499ed8e1b2ca76392a36e061597db320e30ae36b761bf8f4e89d0c068e'   # the table of `restrictive_rules()` below, on bb54c37 BEFORE the patch and AFTER it


def host_with(c):
    """The host of the rule written with the character `c`, and the plain host of the same name."""
    return {SS: ('fa' + SS + '.de', 'fass.de'), CAP: ('fa' + CAP + '.de', 'fass.de'), FINAL: (SIGMA + OMICRON + FINAL + '.gr', SIGMA + OMICRON + SIGMA + '.gr'),
            MATH_FINAL: (SIGMA + OMICRON + MATH_FINAL + '.gr', SIGMA + OMICRON + SIGMA + '.gr')}[c]


def action(text, tool='terminal'):
    return real.Action(bot='vendas', tool=tool, command=text)


def decide(level, text, **match):
    match.setdefault('tools', ('terminal',))
    return real.evaluate([tp.rule(real, 'x', level, **match)], action(text))


# ---- (a) restrictive rules ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize('level', [real.Level.ASK, real.Level.BLOCK, real.Level.HANDBACK])
@pytest.mark.parametrize('c', CHARS, ids=['sharp-s', 'capital-sharp-s', 'final-sigma', 'math-final-sigma'])
def test_a_restrictive_rule_written_with_the_character_is_valid_and_catches_both_spellings(level, c):
    written, plain = host_with(c)
    rule = tp.rule(real, 'x', level, tools=('terminal',), commands=('curl *' + written + '*',))
    assert [p.code for p in real.validate_rule(rule)] == []
    for spelling in (written, plain):
        decision = real.evaluate([rule], action('curl http://' + spelling + '/x'))
        assert decision.effect is level and any(h.rule_id == 'x' for h in decision.hits), spelling


@pytest.mark.parametrize('level', [real.Level.ASK, real.Level.BLOCK])
def test_the_hook_table_of_a_restrictive_rule_stores_the_pattern_folded_and_answers_for_both_spellings(level):
    written, plain = host_with(SS)
    table = real.compile_hook_table([tp.rule(real, 'x', level, tools=('terminal',), commands=('curl *' + written + '*',))], version=1, toolset_tools={}, mcp_server_tools={})
    assert [e.commands for e in table.entries] == [('curl *fass.de*',)]
    want = 'block' if level is real.Level.BLOCK else 'approve'
    for spelling in (written, plain):
        assert real.hook_verdict(table, tool='terminal', command='curl http://' + spelling + '/').action == want
    assert real.hook_verdict(table, tool='terminal', command='curl http://other.de/').action == 'none'


def restrictive_rules():
    G = lambda *cps: ''.join(map(chr, cps))
    out = []
    for i, (level, kw) in enumerate(((real.Level.ASK, dict(tools=('terminal',), commands=('curl *fa' + SS + '.de*',))),
                                     (real.Level.BLOCK, dict(tools=('terminal',), commands=('curl *' + G(0x3c3, 0x3bf, 0x3c2) + '.gr*',))),
                                     (real.Level.ASK, dict(tools=('read_pa' + SS,))),
                                     (real.Level.BLOCK, dict(tools=(), toolsets=('gla' + SS,))),
                                     (real.Level.ASK, dict(tools=(), servers=('gla' + CAP,))),
                                     (real.Level.ASK, dict(tools=('terminal',), commands=('rm -rf *', 'curl *example.com/*'))),
                                     (real.Level.HANDBACK, dict(tools=('write_file',), conditions=(('path:under', 'workspace:pa' + SS),))),
                                     (real.Level.ALLOW, dict(tools=('terminal',), commands=('git status',))))):
        out.append(tp.rule(real, 'r%d' % i, level, **kw))
    return out


def test_the_digest_of_a_table_of_restrictive_rules_does_not_move_and_an_allow_never_enters_it():
    table = real.compile_hook_table(restrictive_rules(), version=1, toolset_tools={}, mcp_server_tools={})
    assert table.digest == PINNED_DIGEST
    assert 'r7' not in [e.rule_id for e in table.entries]


# ---- (a) permissive rules: refused at birth, and dead when they were stored before ----------------------------------------------------------
FIELDS = [('commands', lambda c: dict(tools=['terminal'], commands=['curl *' + host_with(c)[0] + '*'])), ('tools', lambda c: dict(tools=['read_pa' + c])),
          ('toolsets', lambda c: dict(toolsets=['gla' + c])), ('mcp_servers', lambda c: dict(mcp_servers=['gla' + c]))]


@pytest.mark.parametrize('level', ['allow', 'explicit'])
@pytest.mark.parametrize('field,build', FIELDS, ids=[f[0] for f in FIELDS])
@pytest.mark.parametrize('c', CHARS, ids=['sharp-s', 'capital-sharp-s', 'final-sigma', 'math-final-sigma'])
def test_a_permissive_rule_written_with_the_character_is_refused_with_its_own_code(level, field, build, c):
    db = str(Path(tempfile.mkdtemp()) / 'luvebot.db')
    body = {'label': 'x', 'level': level, 'scope': {'kind': 'bot', 'ref': 'vendas'}, 'match': build(c)}
    with pytest.raises(PluginError) as refused:
        service.create(db, real.Actor(real.ActorKind.HUMAN, 'basic:t'), service.validate_create(body), service.new_rule_id())
    assert refused.value.code == 'fold_divergence' and refused.value.status == 422


def test_a_bot_may_suggest_a_restrictive_rule_with_the_character_and_not_a_permissive_one():
    db = str(Path(tempfile.mkdtemp()) / 'luvebot.db')
    human = real.Actor(real.ActorKind.HUMAN, 'basic:t')
    match = {'tools': ['terminal'], 'commands': ['curl *fa' + SS + '.de*']}
    body = lambda level: {'label': 'x', 'level': level, 'scope': {'kind': 'bot', 'ref': 'vendas'}, 'match': match, 'suggested_by_bot': 'vendas'}
    assert service.create(db, human, service.validate_create(body('ask')), service.new_rule_id()).state is real.RuleState.SUGGESTION
    with pytest.raises(PluginError) as refused:
        service.create(db, human, service.validate_create(body('allow')), service.new_rule_id())
    assert refused.value.code == 'fold_divergence'


@pytest.mark.parametrize('level', [real.Level.ALLOW, real.Level.EXPLICIT])
@pytest.mark.parametrize('spelling', ['fass.de', 'fa' + SS + '.de'])
def test_a_permissive_rule_stored_with_the_character_before_the_refusal_matches_neither_spelling(level, spelling):
    old = tp.rule(real, 'old', level, tools=('terminal',), commands=('curl *fa' + SS + '.de*',))
    decision = real.evaluate([old], action('curl http://' + spelling + '/'))
    assert not any(h.rule_id == 'old' for h in decision.hits)
    assert [p.code for p in real.validate_rule(old)] == ['fold_divergence']                    # validate_rule says so; nothing carries it to the card (F-A210-2)


# ---- (c) paths and recipients keep the exact NFC text -----------------------------------------------------------------------------------
def test_a_path_with_the_sharp_s_still_makes_a_sempre_permitir_draft_and_a_rule_on_it_matches_only_itself():
    draft = real.draft_from_always_allow(real.Action(bot='vendas', tool='write_file', facts=(('path', 'workspace:pa' + SS + '/a.md'),)), label='x', rule_id='aa-1')
    assert draft.match.conditions == (('path', 'workspace:pa' + SS + '/a.md'),)
    rule = tp.rule(real, 'x', real.Level.ALLOW, conditions=(('path', 'workspace:pa' + SS + '/a.md'),))
    assert any(h.rule_id == 'x' for h in real.evaluate([rule], tp.act(real, 'workspace:pa' + SS + '/a.md')).hits)
    assert not real.evaluate([rule], tp.act(real, 'workspace:pass/a.md')).hits


# ---- A-211: the code of "Sempre permitir" ------------------------------------------------------------------------------------------------
def code_of(act):
    try:
        real.draft_from_always_allow(act, label='x', rule_id='aa-1')
    except real.RuleError as error:
        return error.args[0]
    return 'draft'


def test_sempre_permitir_gives_each_refusal_its_own_code_and_fold_divergence_comes_first():
    assert code_of(action('curl http://fa' + SS + '.de/')) == 'fold_divergence'
    assert code_of(action('git commit -m "Stra' + SS + 'e"')) == 'fold_divergence'
    assert code_of(action('x', tool='read_pa' + SS)) == 'fold_divergence'
    assert code_of(real.Action(bot='vendas', tool='terminal', toolset='gla' + SS, command='ls')) == 'fold_divergence'
    assert code_of(action('ls' + chr(0x200B) + ' -la')) == 'noncanonical_action'                  # the other codes are still their own
    assert code_of(real.Action(bot='vendas', tool='write_file', facts=(('path', 'workspace:a.md'), ('path', 'workspace:b.md')))) == 'multiple_paths'
    assert code_of(action('curl http://fass.de/')) == 'draft'


def test_the_route_gets_the_code_not_a_generic_draft_not_saved():
    db = str(Path(tempfile.mkdtemp()) / 'luvebot.db')
    row = {'bot': 'vendas', 'tool': 'terminal', 'command_redacted': 'curl http://fa' + SS + '.de/', 'paths_json': None}
    assert approvals._draft(db, row, {'label': 'x', 'level': 'allow'}) == (None, 'fold_divergence')
    row['command_redacted'] = 'curl http://fass.de/'
    rule, error = approvals._draft(db, row, {'label': 'x', 'level': 'allow'})
    assert error is None and rule['state'] == 'draft'


# ---- F-A210-1, fixed by R-13b (A-212): a command that only contains the letter does not ask when no rule is about it --------------------
GREEK = {'a German commit message': 'git commit -m "Stra' + SS + 'e"', 'a German file name': 'ls Gr' + chr(0xF6) + SS + 'e/', 'Greek text with a final sigma': 'echo ' + ''.join(map(chr, (0x3BA, 0x3CC, 0x3C3, 0x3BC, 0x3BF, 0x3C2))),
         'Greek capitals ending a word (Final_Sigma context of lower())': 'echo ' + ''.join(map(chr, (0x39A, 0x39F, 0x3A3, 0x39C, 0x39F, 0x3A3)))}


@pytest.mark.parametrize('why,text', list(GREEK.items()), ids=list(GREEK))
def test_a_command_that_only_contains_the_letter_does_not_ask_when_no_rule_is_about_it(why, text):
    empty = real.compile_hook_table([], version=1, toolset_tools={}, mcp_server_tools={})
    assert real.hook_verdict(empty, tool='terminal', command=text).action == 'none'
    assert real.evaluate([], action(text)).effect is real.Level.ALLOW
