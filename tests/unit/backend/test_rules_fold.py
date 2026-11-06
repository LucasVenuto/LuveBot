"""R-13 (contract v0.11 section 8, A-208): a case fold that the resolvers do not make leaves the action not clean.

The engine folds a text with NFKC and the FULL case fold. The full case fold takes the sharp s (U+00DF) and the capital sharp s (U+1E9E) to `ss`, the final sigma (U+03C2) to U+03C3, and the small Cherokee letters to the capitals; a simple lower
case does none of that. The resolvers of a browser, Node and libidn2 (IDNA 2008, UTS 46 non-transitional) KEEP those characters: `http://stra<U+00DF>e.de` is `xn--strae-oqa.de`, not `strasse.de`, and the Python codec (IDNA 2003) agrees with the fold,
which is why the tools disagree with each other. So the folded text names the host A where the tool goes to the host B, and an allow rule for `strasse.de` would cover `stra<U+00DF>e.de`.
The rule: the action is NOT clean when the full fold changes something that a simple lower case does not (`nfkc.lower() != nfkc.casefold()`): a permission does not cover it and the person is asked; a restrictive rule keeps reading the folded text, so
a block on `strasse.de` also catches `stra<U+00DF>e.de` (it can only block or ask more). The same test is applied wherever a permission reads a folded value (A-210): the names of the action's tool, toolset and server, and the patterns of a permissive rule (command, tool, toolset, server): `validate_rule` REFUSES
such a rule under its own code `fold_divergence`, and `_match` never lets a permissive rule match when one of its patterns fails the test (a rule stored before the refusal covers nothing: it fails closed); a restrictive pattern is fine. Paths and recipients are read exactly (NFC) by a permission and need nothing. Accepted: a text that never meant a host (German
prose, a final sigma, Cherokee) is asked about too, which is rare and the safe side.

Every invariant runs on the real `backend.rules` and goes red on variants with one deliberate defect."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the rules')

import backend.rules as real  # noqa: E402

SS, CAP_SS, SIGMA, CHEROKEE = chr(0xDF), chr(0x1E9E), chr(0x3C2), chr(0xAB70)
UNCLEAN = {
    f'curl http://stra{SS}e.de/': 'curl http://strasse.de/', f'curl http://STRA{CAP_SS}E.DE/': 'curl http://strasse.de/', f'curl http://{SIGMA}.gr/': f'curl http://{chr(0x3C3)}.gr/',
    f'curl http://{CHEROKEE}.org/': f'curl http://{chr(0x13A0)}.org/', f'echo Stra{SS}e': 'echo strasse',          # prose that is no URL is asked about too: accepted
}
CLEAN = ['curl http://STRASSE.DE/', 'curl http://strasse.de/', 'git commit -m "fix"', f'echo {chr(0xC9)}COLE', 'curl http://Example.COM:80/x']


def winner(m, rules, command):
    decision, _ordered = m._evaluate_full(rules, m.Action(bot='vendas', tool='terminal', command=command))
    return decision


def blocked(m, level, pattern, command):
    rules = [tp.rule(m, 'b', level, tools=('terminal',), commands=(pattern,)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *', 'echo *'))]
    return winner(m, rules, command).winner == 'b'


def inv_a_full_case_fold_the_resolvers_do_not_make_keeps_the_action_from_being_allowable(m):
    for command, text in UNCLEAN.items():
        assert m._command_read(command) == (text, True, False), command                                              # the text is still folded (a restrictive rule reads it), it was read WHOLE, and no permission covers it
        assert m._command_text(command) == (text, True), command                                                     # `clean` is back to "read whole" (A-212): nothing asks because of the fold
    for command in CLEAN:
        assert m._command_read(command)[1:] == (True, True), command                                                 # a simple lower case is the plain fold: allowable


def inv_a_permission_does_not_cover_it_and_a_block_does(m):
    allow = [tp.rule(m, 'a', m.Level.ALLOW, tools=('terminal',), commands=('curl *strasse.de*',))]
    assert winner(m, allow, 'curl http://strasse.de/').winner == 'a' and winner(m, allow, 'curl http://STRASSE.DE/').winner == 'a'
    for command in (f'curl http://stra{SS}e.de/', f'curl http://STRA{CAP_SS}E.DE/'):
        decision = winner(m, allow, command)
        assert decision.winner is None and decision.reason is not m.ReasonCode.NONCANONICAL_ACTION, command           # not allowed, and not asked about by default either (A-212)
    sigma = [tp.rule(m, 's', m.Level.ALLOW, tools=('terminal',), commands=(f'curl *{chr(0x3C3)}.gr*',))]
    assert winner(m, sigma, f'curl http://{SIGMA}.gr/').winner is None
    prose = [tp.rule(m, 'p', m.Level.ALLOW, tools=('terminal',), commands=('echo *',))]
    assert winner(m, prose, 'echo Strasse').winner == 'p' and winner(m, prose, f'echo Stra{SS}e').winner is None      # accepted: a word with a sharp s is asked about
    for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
        assert blocked(m, level, 'curl *strasse.de*', f'curl http://stra{SS}e.de/'), level                           # a restrictive rule wins over the broader allow, on the folded text
        assert blocked(m, level, f'curl *stra{SS}e.de*', 'curl http://strasse.de/'), level                           # a pattern written with the character reads the same folded text
        assert blocked(m, level, f'curl *stra{SS}e.de*', f'curl http://stra{SS}e.de/'), level
        assert blocked(m, level, f'curl *{chr(0x3C3)}.gr*', f'curl http://{SIGMA}.gr/'), level


def inv_an_allow_pattern_with_such_a_character_covers_nothing(m):
    wide = [tp.rule(m, 'w', m.Level.ALLOW, tools=('terminal',), commands=(f'curl *stra{SS}e.de*',))]
    assert winner(m, wide, 'curl http://strasse.de/').winner is None                                                 # it would have allowed ANOTHER host than the one it names
    both = [tp.rule(m, 'b', m.Level.ALLOW, tools=('terminal',), commands=(f'curl *stra{SS}e.de*', 'curl *example.com*'))]
    assert winner(m, both, 'curl http://example.com/').winner is None                                                # the WHOLE rule covers nothing: a stored rule fails closed, it is never half alive
    for kwargs in ({'commands': (f'curl *stra{SS}e.de*',)}, {'tools': (f'read_pa{SS}',)}, {'tools': (), 'toolsets': (f'gla{SS}',)}, {'tools': (), 'servers': (f'gla{SS}',)}):
        kwargs.setdefault('tools', ('terminal',))
        for level in (m.Level.ALLOW, m.Level.EXPLICIT):
            refused = m.validate_rule(tp.rule(m, 'w', level, **kwargs))
            assert [p.code for p in refused] == ['fold_divergence'], (level, kwargs, refused)                           # its OWN code, and one problem
            assert 'ASCII' in refused[0].detail and 'ask level' in refused[0].detail                                  # and it says what to do
        for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
            assert m.validate_rule(tp.rule(m, 'r', level, **kwargs)) == (), (level, kwargs)                           # a restrictive pattern is fine: it only matches more
    assert [p.code for p in m.validate_rule(tp.rule(m, 'w', m.Level.EXPLICIT, tools=('terminal',), commands=(f'curl *{SIGMA}.gr*',)))] == ['fold_divergence']


def inv_a_permission_on_a_name_covers_neither_spelling_and_a_block_covers_both(m):
    for allow_kwargs, action in (({'tools': ('read_pass',)}, m.Action(bot='v', tool=f'read_pa{SS}')), ({'tools': (f'read_pa{SS}',)}, m.Action(bot='v', tool='read_pass')),
                                 ({'tools': (), 'toolsets': ('glass',)}, m.Action(bot='v', tool='t', toolset=f'gla{SS}')), ({'tools': (), 'toolsets': (f'gla{SS}',)}, m.Action(bot='v', tool='t', toolset='glass')),
                                 ({'tools': (), 'servers': ('glass',)}, m.Action(bot='v', tool='mcp__glass__x', mcp_server=f'gla{SS}')), ({'tools': (), 'servers': (f'gla{SS}',)}, m.Action(bot='v', tool='mcp__glass__x', mcp_server='glass'))):
        decision, _ordered = m._evaluate_full([tp.rule(m, 'x', m.Level.ALLOW, **allow_kwargs)], action)
        assert decision.winner is None, (allow_kwargs, action)                                                      # not allowed in either direction
    plain = m.Action(bot='v', tool='read_pass'), m.Action(bot='v', tool='t', toolset='glass'), m.Action(bot='v', tool='mcp__glass__x', mcp_server='glass')
    for allow_kwargs, action in (({'tools': ('read_pass',)}, plain[0]), ({'tools': (), 'toolsets': ('glass',)}, plain[1]), ({'tools': (), 'servers': ('glass',)}, plain[2])):
        assert m._evaluate_full([tp.rule(m, 'x', m.Level.ALLOW, **allow_kwargs)], action)[0].winner == 'x', allow_kwargs   # the control: the plain spelling is allowed
    for kwargs, action in (({'tools': ('read_pass',)}, m.Action(bot='v', tool=f'read_pa{SS}')), ({'tools': (f'read_pa{SS}',)}, m.Action(bot='v', tool='read_pass')),
                           ({'tools': (), 'toolsets': (f'gla{SS}',)}, m.Action(bot='v', tool='t', toolset='glass')), ({'tools': (), 'servers': ('glass',)}, m.Action(bot='v', tool='mcp__glass__x', mcp_server=f'gla{SS}'))):
        for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
            assert m._evaluate_full([tp.rule(m, 'x', level, **kwargs)], action)[0].winner == 'x', (level, kwargs)         # a restrictive rule matches both: the full fold on both sides


def inv_a_name_is_read_whole_and_is_not_allowable_when_its_fold_is_not_a_lower_case(m):
    """A-214: a tool, toolset or server name is read like the command: its clean flag says it was read WHOLE (the sharp s folds to the ASCII `ss`), no permission covers it, and nothing asks because of it."""
    assert m.canon_name('Terminal') == ('terminal', True) and m.canon_name('MCP_Server') == ('mcp_server', True)
    assert m.canon_name(f'stra{SS}e') == ('strasse', True)                                                           # read whole, however it folds
    empty = m.compile_hook_table([], version=1, toolset_tools={}, mcp_server_tools={})
    for kwargs in ({'tool': f'read_pa{SS}'}, {'tool': f'read_pa{CAP_SS}'}, {'tool': 't', 'toolset': f'gla{SS}'}, {'tool': 'mcp__glass__x', 'mcp_server': f'gla{SS}'}):
        action = m.Action(bot='v', **kwargs)
        view = m._view(action)
        assert view.clean is True and view.allowable is False, kwargs                                                  # not allowable, and nothing to ask about
        assert m.evaluate([], action).effect is m.Level.ALLOW, kwargs                                                  # no rule: the engine asks nothing...
    assert m.hook_verdict(empty, tool=f'read_pa{SS}', command=None).action == 'none'                                    # ...and the hook says none
    plain = m._view(m.Action(bot='v', tool='read_pass', toolset='glass', mcp_server='glass'))
    assert plain.clean is True and plain.allowable is True                                                             # the control


def inv_the_hook_decides_as_the_engine_does(m):
    def table(pattern):
        return m.compile_hook_table([tp.rule(m, 'b', m.Level.BLOCK, tools=(), commands=(pattern,))], version=1, toolset_tools={}, mcp_server_tools={})
    block = table('curl *strasse.de*')
    assert m.hook_verdict(block, tool='terminal', command=f'curl http://stra{SS}e.de/').action == 'block'
    other = table('curl *nothing.example*')
    verdict = m.hook_verdict(other, tool='terminal', command=f'curl http://stra{SS}e.de/')
    assert verdict.action == 'none'                                                                                  # no entry matches and the action was read whole: nothing to ask (A-212)
    hidden = m.hook_verdict(other, tool='terminal', command='curl http://local' + chr(0x200B) + 'host/')
    assert hidden.action == 'approve' and hidden.message == 'luvebot:noncanonical'                                    # a hidden character is another thing: that one is still asked about
    assert m.hook_verdict(other, tool='terminal', command='curl http://strasse.de/').action == 'none'


PINNED_DIGEST = '2fa73fe92427f00d03a33c015b4cfff5fea5b80d3ef92de96d888b1f7a010dd8'   # measured on the engine BEFORE R-13 (a691352), for the table of the invariant below


def inv_a_restrictive_rule_with_the_sharp_s_keeps_the_hook_table_as_it_was(m):
    """A-211 (a): a restrictive rule is NOT refused and no entry of the hook table changes: it is stored folded (`curl *strasse.de*`) and the hook decides on both spellings. The digest of the entries is what the seal compares, so a changed
    entry would turn `hook_outdated` in every Bot."""
    rules = [tp.rule(m, 'b1', m.Level.BLOCK, tools=('terminal',), commands=(f'curl *stra{SS}e.de*', 'rm -rf *')),
             tp.rule(m, 'a1', m.Level.ASK, tools=(f'read_pa{SS}',)),
             tp.rule(m, 'h1', m.Level.HANDBACK, tools=('terminal',), commands=(f'curl *{chr(0x3C3)}.gr*',))]
    assert all(m.validate_rule(rule) == () for rule in rules)
    table = m.compile_hook_table(rules, version=7, toolset_tools={}, mcp_server_tools={})
    assert table.digest == PINNED_DIGEST, table.digest
    assert {e.rule_id: e.commands for e in table.entries}['b1'] == ('curl *strasse.de*', 'rm -rf *')
    for command in (f'curl http://stra{SS}e.de/', 'curl http://strasse.de/'):
        assert m.hook_verdict(table, tool='terminal', command=command).action == 'block', command


def inv_the_always_allow_draft_is_refused_at_birth_for_such_an_action(m):
    """A-211 (c): the draft would cover ANOTHER host or name than the one the person saw, so it is refused when it is born, under the code the card draws; the approval itself stays as the person decided."""
    for action in (m.Action(bot='v', tool='terminal', command=f'curl http://stra{SS}e.de/'), m.Action(bot='v', tool=f'read_pa{SS}'), m.Action(bot='v', tool='t', toolset=f'gla{SS}'),
                   m.Action(bot='v', tool='mcp__glass__x', mcp_server=f'gla{SS}')):
        try:
            m.draft_from_always_allow(action, label='x', rule_id='aa-1')
        except m.RuleError as error:
            assert error.args[0] == 'fold_divergence', action
        else:
            raise AssertionError(f'a draft was made for {action}')
    ok = m.draft_from_always_allow(m.Action(bot='v', tool='terminal', command='curl http://strasse.de/'), label='x', rule_id='aa-2')    # the control: the plain spelling is drafted
    assert ok.state is m.RuleState.DRAFT and ok.match.commands == ('curl http://strasse.de/',)


def inv_the_nfkc_is_made_once_per_command(m):
    """A-211 (d): the case fold and the lower case read the SAME normalized text, and the cut of R-11 comes after."""
    import unicodedata
    calls, original = [], unicodedata.normalize

    def counting(form, text):
        calls.append(form)
        return original(form, text)
    unicodedata.normalize = counting
    try:
        m._command_text('curl http://example.com/ ' + SS)
    finally:
        unicodedata.normalize = original
    assert calls.count('NFKC') == 1, calls


def inv_a_command_that_only_contains_the_character_asks_nothing(m):
    """A-212 (the Lume's F-A210-1): German text, Greek text and Greek capitals that end a word (the Final_Sigma context of `lower()`) ask with NO rule at all, in the engine and in the hook; a block or an ask still catches both spellings,
    and a real hidden character still asks."""
    texts = [f'git commit -m "Stra{SS}e"', f'ls Gr{chr(0xF6)}{SS}e/', 'echo ' + ''.join(map(chr, (0x3BA, 0x3CC, 0x3C3, 0x3BC, 0x3BF, 0x3C2))), 'echo ' + ''.join(map(chr, (0x39A, 0x39F, 0x3A3, 0x39C, 0x39F, 0x3A3)))]
    empty = m.compile_hook_table([], version=1, toolset_tools={}, mcp_server_tools={})
    unrelated = [tp.rule(m, 'u', m.Level.BLOCK, tools=('terminal',), commands=('curl *example.org*',))]
    for text in texts:
        assert m.hook_verdict(empty, tool='terminal', command=text).action == 'none', text
        for rules in ([], unrelated):
            decision = m.evaluate(rules, m.Action(bot='v', tool='terminal', command=text))
            assert decision.effect is m.Level.ALLOW and decision.reason is not m.ReasonCode.NONCANONICAL_ACTION, (text, decision)
    hidden = 'ls' + chr(0x200B) + ' -la'
    assert m.evaluate([], m.Action(bot='v', tool='terminal', command=hidden)).effect is m.Level.ASK and m.hook_verdict(empty, tool='terminal', command=hidden).action == 'approve'
    for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
        assert blocked(m, level, 'curl *strasse.de*', f'curl http://stra{SS}e.de/'), level                           # the restrictive rules keep both spellings


def inv_a_fact_of_another_name_is_read_like_the_command(m):
    """A-213 (the Lume's F-A212-1): the facts with a name other than `path` and `recipient` are folded on BOTH sides, so a condition (`note`, `pass`) would cover the fact (`note`, `pa<sharp s>`). The adapters of the hook send only `path`
    and `recipient` today, and the next adapter must not find the hole open. A path and a recipient keep the exact NFC text."""
    def covered(fact, condition, level=None):
        action = m.Action(bot='v', tool='terminal', facts=(fact,))
        return m._evaluate_full([tp.rule(m, 'x', level or m.Level.ALLOW, tools=('terminal',), conditions=(condition,))], action)[0].winner == 'x'
    assert covered(('note', 'pass'), ('note', 'pass'))                                                              # the control: the same fact is covered
    assert covered(('note', 'pass'), ('note', 'PASS'))                                                              # and a simple case difference is still the same fact
    assert not covered(('note', 'pa' + SS), ('note', 'pass')) and not covered(('note', 'pa' + SIGMA), ('note', 'pa' + chr(0x3C3)))       # the VALUE
    assert not covered(('no' + SS + 'te', 'x'), ('nosste', 'x'))                                                      # and the NAME of the fact
    assert covered(('note', 'pa' + SS), ('note', 'pa' + SS)) is False                                                  # the fold is the same on both sides, and still no allow covers it
    assert m._evaluate_full([tp.rule(m, 'x', m.Level.BLOCK, tools=('terminal',), conditions=(('note', 'pass'),))], m.Action(bot='v', tool='terminal', facts=(('note', 'pa' + SS),)))[0].winner == 'x'    # a block still catches both
    exact = m.Action(bot='v', tool='write_file', facts=(('path', 'workspace:pa' + SS + '/a.md'),))
    assert m._evaluate_full([tp.rule(m, 'x', m.Level.ALLOW, conditions=(('path', 'workspace:pa' + SS + '/a.md'),))], exact)[0].winner == 'x'      # a path keeps its exact text: R-13b does not take this away


def inv_a_restrictive_rule_may_name_a_toolset_or_server_by_any_usable_key(m):
    """A-216 (the Lume's F-A214-1, whose trigger fired: an accented Latin letter is refused too, `cafe` and `gestao` in Portuguese): only for a RESTRICTIVE rule, a toolset or MCP server name is valid when it is not empty, not longer than a tool
    name, has no invisible character, no space and no glob character, whatever its letters; the engine already matches it and the hook table carries it (a lookup that fails is an explicit problem, never a silent rule). A permissive rule keeps the refusal."""
    cafe, gestao = 'caf' + chr(0xE9), 'gest' + chr(0xE3) + 'o'
    names = [cafe, gestao, 'gla' + chr(0x3C2), ''.join(map(chr, (0x43F, 0x440, 0x43E, 0x435, 0x43A, 0x442))), chr(0x4E2D) + chr(0x6587), 'glass', 'my-server']
    refused = ['', 'a b', 'a\tb', 'a\nb', 'a' + chr(0x200B) + 'b', 'a' + chr(0x200D) + 'b', 'a' + chr(0xAD) + 'b', 'a' + chr(0x202E) + 'b', 'a*', '?a', 'a[b', 'a]b', 'a' * 129]

    def codes(level, **kwargs):
        return [p.code for p in m.validate_rule(tp.rule(m, 'x', level, **({'tools': ()} | kwargs)))]
    for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
        for name in names:
            assert codes(level, toolsets=(name,)) == [] and codes(level, servers=(name,)) == [], (level, name)
        for bad in refused:
            assert codes(level, toolsets=(bad,)) == ['bad_glob'] and codes(level, servers=(bad,)) == ['bad_glob'], (level, bad)
    for level in (m.Level.ALLOW, m.Level.EXPLICIT):                                                                   # a permissive rule keeps the refusal
        assert codes(level, toolsets=(cafe,)) == ['bad_glob'] and codes(level, servers=(gestao,)) == ['bad_glob'], level
        assert codes(level, toolsets=('glass',)) == [] and codes(level, servers=('my-server',)) == [], level
    rule = tp.rule(m, 'r1', m.Level.BLOCK, tools=(), servers=(gestao,))
    table = m.compile_hook_table([rule], version=1, toolset_tools={}, mcp_server_tools={gestao: ('mcp_gestao_listar',)})
    assert table.problems == () and [(e.rule_id, e.tools) for e in table.entries] == [('r1', ('mcp_gestao_listar',))]    # the table of the hook is NOT empty
    assert m.hook_verdict(table, tool='mcp_gestao_listar', command=None).action == 'block'
    unmapped = m.compile_hook_table([rule], version=1, toolset_tools={}, mcp_server_tools={})
    assert unmapped.entries == () and {'unknown_mcp_server', 'empty_expansion'} <= {p.code for p in unmapped.problems}   # a lookup that fails is an explicit problem
    assert m.evaluate([rule], m.Action(bot='v', tool='mcp_gestao_apagar', mcp_server=gestao)).effect is m.Level.BLOCK    # and the engine matches it


def inv_a_permission_on_a_fact_condition_that_folds_differently_covers_nothing(m):
    """A-217: the key and the value of a condition on a fact other than `path` and `recipient` are folded on both sides, so a permissive rule with `note=pa<sharp s>` would cover the fact `note=pass`: validate_rule refuses it under
    `fold_divergence` and the match never lets a stored one hit; a restrictive rule keeps both spellings, and a path or a recipient keeps its exact NFC text."""
    def codes(level, conditions, **kwargs):
        return [p.code for p in m.validate_rule(tp.rule(m, 'x', level, **({'tools': ('terminal',)} | kwargs), conditions=conditions))]
    for level in (m.Level.ALLOW, m.Level.EXPLICIT):
        assert codes(level, (('note', 'pa' + SS),)) == ['fold_divergence'], level                                       # the VALUE
        assert codes(level, (('no' + SS + 'te', 'x'),)) == ['fold_divergence'], level                                   # the KEY
        assert codes(level, (('note', 'pass'),)) == [], level                                                           # the control
    for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
        assert codes(level, (('note', 'pa' + SS),)) == [], level                                                        # a restrictive rule is fine
    assert codes(m.Level.ALLOW, (('path', 'workspace:pa' + SS + '/a.md'),), tools=('write_file',)) == []                # a path keeps its exact text
    stored = [tp.rule(m, 'x', m.Level.ALLOW, tools=('terminal',), conditions=(('note', 'pa' + SS),))]
    for value in ('pass', 'pa' + SS):
        assert m._evaluate_full(stored, m.Action(bot='v', tool='terminal', facts=(('note', value),)))[0].winner is None, value   # a stored permissive rule covers neither
    block = [tp.rule(m, 'x', m.Level.BLOCK, tools=('terminal',), conditions=(('note', 'pa' + SS),))]
    for value in ('pass', 'pa' + SS):
        assert m._evaluate_full(block, m.Action(bot='v', tool='terminal', facts=(('note', value),)))[0].winner == 'x', value     # a restrictive one covers both
    exact = [tp.rule(m, 'x', m.Level.ALLOW, conditions=(('path', 'workspace:pa' + SS + '/a.md'),))]
    assert m._evaluate_full(exact, tp.act(m, 'workspace:pa' + SS + '/a.md'))[0].winner == 'x'                          # a permissive path rule with the letter still covers its exact text


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
C, P, W, X, N, H, D, F, O, R, Q, U, V = tuple(INVARIANTS)
GUARD = 'if not restrictive and any(isinstance(p, str) and not _fold_plain(p)[1] for p in (*m.tools, *m.toolsets, *m.mcp_servers, *m.commands, *(text for key, value in m.conditions if fact_of(key) is None for text in (key, value)))):'
CONDITIONS = ', *(text for key, value in m.conditions if fact_of(key) is None for text in (key, value))'

ALLOWABLE = 'return "".join(kept), clean, simple'
MUTATIONS = [
    (C, 'the action is allowable whatever the fold', ALLOWABLE, 'return "".join(kept), clean, True'),
    (P, 'the action is allowable whatever the fold', ALLOWABLE, 'return "".join(kept), clean, True'),
    (R, 'the mark makes the action not clean again', ALLOWABLE, 'return "".join(kept), clean and simple, simple'),
    (H, 'the mark makes the action not clean again', ALLOWABLE, 'return "".join(kept), clean and simple, simple'),
    (C, 'the mark makes the action not clean again', ALLOWABLE, 'return "".join(kept), clean and simple, simple'),
    (P, 'the permissive match does not read allowable', 'if not restrictive and not (view.clean and view.allowable):', 'if not restrictive and not view.clean:'),
    (P, 'the view ignores what the command says about allowable', '        allowable = allowable and command_allowable' + chr(10), '        pass' + chr(10)),
    (C, 'the check compares the fold with itself', 'return folded, nfkc.lower() == folded', 'return folded, folded.lower() == folded'),
    (P, 'the check compares the fold with itself', 'return folded, nfkc.lower() == folded', 'return folded, folded.lower() == folded'),
    (W, 'the guard of a permissive rule is gone', GUARD, 'if False:'),
    (X, 'the guard of a permissive rule is gone', GUARD, 'if False:'),
    (X, 'the guard looks only at the commands', '(*m.tools, *m.toolsets, *m.mcp_servers, *m.commands' + CONDITIONS + '))', '(*m.commands,))'),
    (P, 'the guard also dries up a restrictive rule', GUARD, GUARD.replace('if not restrictive and any', 'if any')),
    (X, 'the guard also dries up a restrictive rule', GUARD, GUARD.replace('if not restrictive and any', 'if any')),
    (W, 'validate_rule accepts such a pattern in a permissive rule', '                    if rule.level not in _RESTRICTIVE and not _fold_plain(text)[1]:\n', '                    if False:\n'),
    (W, 'validate_rule refuses it in a restrictive rule too', '                    if rule.level not in _RESTRICTIVE and not _fold_plain(text)[1]:\n', '                    if not _fold_plain(text)[1]:\n'),
    (W, 'validate_rule says bad_glob, not its own code', 'problems.append(Problem("fold_divergence", _FOLD_DIVERGENCE))   # a restrictive pattern', 'problems.append(Problem("bad_glob", _FOLD_DIVERGENCE))   # a restrictive pattern'),
    (W, 'the toolsets and servers are not checked by validate_rule', '                    if lossy and permissive:' + chr(10), '                    if False:' + chr(10)),
    (X, 'the view ignores the names', 'allowable = all(_fold_plain(name)[1] for name in (action.tool, action.toolset, action.mcp_server) if isinstance(name, str))', 'allowable = True'),
    (N, 'the view ignores the names', 'allowable = all(_fold_plain(name)[1] for name in (action.tool, action.toolset, action.mcp_server) if isinstance(name, str))', 'allowable = True'),
    (X, 'the view reads only the tool name', 'for name in (action.tool, action.toolset, action.mcp_server) if isinstance(name, str))', 'for name in (action.tool,) if isinstance(name, str))'),
    (N, 'the predicate is back in the clean of a name', 'return plain, _TOOL_RE.fullmatch(folded) is not None', 'return plain, _fold_plain(raw)[1] and _TOOL_RE.fullmatch(folded) is not None'),
    (D, 'the table keeps the pattern as written', 'for form in _destination_forms(_squash(_fold(c)))', 'for form in _destination_forms(_squash(c))'),
    (D, 'the table folds the pattern with a simple lower case', 'for form in _destination_forms(_squash(_fold(c)))', 'for form in _destination_forms(_squash(c.lower()))'),
    (F, 'the draft is refused with the generic code', 'raise RuleError("fold_divergence")', 'raise RuleError("noncanonical_action")'),
    (F, 'the draft does not look at the tool name', '(action.tool, action.toolset, action.mcp_server, action.command)', '(action.command,)'),
    (F, 'the draft does not look at the toolset and the server', '(action.tool, action.toolset, action.mcp_server, action.command)', '(action.tool, action.command)'),
    (O, 'the fold is made twice', '    folded, simple = _fold_plain(raw[:MAX_COMMAND])\n', '    folded = _fold(raw[:MAX_COMMAND])\n    simple = _fold_plain(raw[:MAX_COMMAND])[1]\n'),
    (O, 'the NFKC is made again for the lower case', 'return folded, nfkc.lower() == folded', 'return folded, unicodedata.normalize("NFKC", text).lower() == folded'),
    (Q, 'a fact of another name is not read for the fold', 'allowable = allowable and _fold_plain(pair[0])[1] and _fold_plain(pair[1])[1]', 'pass'),
    (Q, 'only the value of a fact is read for the fold', 'allowable = allowable and _fold_plain(pair[0])[1] and _fold_plain(pair[1])[1]', 'allowable = allowable and _fold_plain(pair[1])[1]'),
    (U, 'a restrictive name takes only plain identifiers', 'elif not (canon_name(name)[1] if permissive else _usable_name(name)):', 'elif not canon_name(name)[1]:'),
    (U, 'a permissive name is as free as a restrictive one', 'elif not (canon_name(name)[1] if permissive else _usable_name(name)):', 'elif not _usable_name(name):'),
    (U, 'a restrictive name may be empty', '0 < len(name) <= MAX_TOOL', 'len(name) <= MAX_TOOL'),
    (U, 'a restrictive name may be as long as it likes', '0 < len(name) <= MAX_TOOL', '0 < len(name)'),
    (U, 'a restrictive name may hold a space', '_invisible(c) or c.isspace() or c in "*?[]"', '_invisible(c) or c in "*?[]"'),
    (U, 'a restrictive name may hold an invisible character', '_invisible(c) or c.isspace() or c in "*?[]"', 'c.isspace() or c in "*?[]"'),
    (U, 'a restrictive name may hold a glob character', '_invisible(c) or c.isspace() or c in "*?[]"', '_invisible(c) or c.isspace()'),
    (V, 'validate_rule accepts a divergent condition in a permissive rule', 'if fact_of(key) is None and not all(_fold_plain(text)[1] for text in (key, value) if isinstance(text, str)):', 'if False:'),
    (V, 'only the value of a condition is read', 'for text in (key, value) if isinstance(text, str)):', 'for text in (value,) if isinstance(text, str)):'),
    (V, 'the match guard ignores the conditions', CONDITIONS, ''),
    (V, 'the match guard reads path and recipient too', 'if fact_of(key) is None for text in (key, value)', 'for text in (key, value)'),
    (Q, 'only the name of a fact is read for the fold', 'allowable = allowable and _fold_plain(pair[0])[1] and _fold_plain(pair[1])[1]', 'allowable = allowable and _fold_plain(pair[0])[1]'),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


def test_the_two_folds_agree_so_that_nothing_drifts():
    for text in list(UNCLEAN) + CLEAN + ['', 'ABC', f'{chr(0xFB03)}x', f'{chr(0xFDFA)}', f'a{chr(0x130)}b']:
        assert real._fold_plain(text)[0] == real._fold(text), text


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)


# ---- A-211 (b) and (c): the ways a rule or a draft gets in, through the real service --------------------------------------------------------------------------
@pytest.fixture
def service(monkeypatch):
    import types
    modules = {'agent': {}, 'agent.secret_scope': {'current_secret_scope': lambda: None, 'get_secret': lambda *a: None},
               'hermes_cli': {}, 'hermes_cli.profiles': {'list_profile_names': lambda: []},
               'hermes_cli.web_server_profiles': {'_config_profile_scope': None}}
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        monkeypatch.setitem(sys.modules, name, module)
    import backend.rules_service as rules_service
    return rules_service


def fields(level, commands, bot=None, tools=('terminal',)):
    return {'suggested_by_bot': bot, 'label': 'x', 'level': level, 'scope': real.Scope(real.ScopeKind.GLOBAL),
            'match': real.Match(tools=tools, toolsets=(), mcp_servers=(), commands=commands, conditions=())}


def test_the_four_ways_a_rule_gets_in_are_behind_validate_rule_with_its_own_code(service, tmp_path):
    """`permissive` is `rule.level not in _RESTRICTIVE` (EXPLICIT included) inside `validate_rule`, which POST, PATCH, an agent's suggestion and the activation already call."""
    path, human, bad = tmp_path / 'rules.db', real.Actor(real.ActorKind.HUMAN, 'basic:ana'), (f'curl *stra{SS}e.de*',)
    for level in (real.Level.ALLOW, real.Level.EXPLICIT):                                                             # POST
        with pytest.raises(Exception) as error:
            service.create(path, human, fields(level, bad), 'r-post')
        assert (error.value.code, error.value.status) == ('fold_divergence', 422), level
    block = service.create(path, human, fields(real.Level.BLOCK, bad), 'r-block')                                      # a restrictive rule is saved: the sharp s is fine there
    assert block.state is real.RuleState.DRAFT and block.match.commands == bad
    with pytest.raises(Exception) as error:                                                                           # PATCH: a restrictive rule edited into a permissive one
        service.edit(path, human, 'r-block', block.version, {'level': real.Level.ALLOW})
    assert error.value.code == 'fold_divergence'
    plain = service.create(path, human, fields(real.Level.ALLOW, ('curl *example.com*',)), 'r-allow')
    with pytest.raises(Exception) as error:                                                                           # PATCH: a permissive draft edited to carry the character
        service.edit(path, human, 'r-allow', plain.version, {'match': real.Match(tools=('terminal',), toolsets=(), mcp_servers=(), commands=bad, conditions=())})
    assert error.value.code == 'fold_divergence'
    with pytest.raises(Exception) as error:                                                                           # an agent's suggestion
        service.create(path, human, fields(real.Level.ALLOW, bad, bot='vendas'), 'r-agent')
    assert error.value.code == 'fold_divergence'
    late = real.Rule(id='r-late', label='x', level=real.Level.ALLOW, scope=real.Scope(real.ScopeKind.GLOBAL), match=fields(real.Level.ALLOW, bad)['match'], state=real.RuleState.DRAFT,
                     origin=real.Origin.HUMAN, builtin=False, version=1, updated_by='x')
    with pytest.raises(real.RuleError) as error:                                                                      # the activation: a draft that got in some other way is refused again
        real.activate(late, actor=human, now_version=2)
    assert error.value.args[0] == 'invalid_rule'


def test_the_refusal_says_what_to_do(service):
    refused = real.validate_rule(real.Rule(id='x', label='x', level=real.Level.ALLOW, scope=real.Scope(real.ScopeKind.GLOBAL), match=fields(real.Level.ALLOW, (f'curl *stra{SS}e.de*',))['match'],
                                           state=real.RuleState.DRAFT, origin=real.Origin.HUMAN, builtin=False, version=1, updated_by='x'))
    with pytest.raises(Exception) as error:
        service._refuse_invalid(refused)
    assert error.value.code == 'fold_divergence' and 'ASCII' in str(error.value.args) and 'ask level' in str(error.value.args)      # its own code, not `invalid_field`, so the person reads the way out


def test_the_approval_stays_as_decided_and_only_the_always_allow_draft_comes_back_with_its_code(service, tmp_path):
    import backend.approvals as approvals
    row = {'bot': 'vendas', 'tool': 'terminal', 'command_redacted': f'curl http://stra{SS}e.de/', 'paths_json': None}
    assert approvals._draft(tmp_path / 'rules.db', row, {'label': 'x', 'level': 'allow'}) == (None, 'fold_divergence')                # the code, not a generic `draft_not_saved`: the card can draw its phrase
