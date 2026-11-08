"""R-9 (contract v0.11 section 8, A-200; the Lume's F-R5-1, Low, availability): an emoji written with its variation selector does not dirty the action.

R-5 made the matcher drop U+FE0E and U+FE0F (the resolver erases them from a host) and, like every character it drops, mark the action NOT clean; an action that is not clean is never allowed (`NONCANONICAL_ACTION` makes it
an ask). So `git commit -m "fix <check mark><VS16>"` with `allow terminal git commit *` became a question, and so did every command with an emoji written the usual way (the warning sign, the heart, the copyright sign).
The rule: ONE variation selector (U+FE00 to U+FE0F) DIRECTLY after a NON-ASCII symbol (category So, Sk, Sm or No) is dropped for matching and does not make the action unclean: it cannot be part of an ASCII host, and the symbol
stays in the text. Everything else keeps the R-5 rule: a selector after an ASCII character, a letter, a digit, a space, a newline or the start of the text; a second selector; a hidden character between the symbol and the
selector; the keycap sequences (`#`, `*` or a digit, U+FE0F, U+20E3), on purpose (rare in a command, and a selector after an ASCII character is exactly what the destination bypass looked like); and U+034F and U+180B to
U+180D, which are never clean. Dirt is never washed: a clean emoji after an unclean spelling leaves the action unclean. A block on a host still sees through every selector (F-R4-1 stays closed).

Every invariant runs on the real `backend.rules` and goes red on variants with one deliberate defect."""
from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the rules')

import backend.rules as real  # noqa: E402

VS16, VS15, VS1, VS14 = chr(0xFE0F), chr(0xFE0E), chr(0xFE00), chr(0xFE0D)
SELECTORS = [chr(code) for code in range(0xFE00, 0xFE10)]
CHECK, WARN, HEART, COPY = chr(0x2714), chr(0x26A0), chr(0x2764), chr(0xA9)
SYMBOLS = {'So': CHECK, 'Sk': chr(0x2C2), 'Sm': chr(0x2260), 'No': chr(0x2CFD)}          # one that survives the NFKC fold of the action, per category
NOT_SYMBOLS = {'Ll': chr(0xE9), 'Lo': chr(0x65E5), 'Sc': chr(0x20AC), 'Nd': chr(0x663), 'Po': chr(0xA1)}
ASCII_SYMBOLS = ['+', '^', '`', '~', '|', '<', '=', '>']                               # ASCII characters of category Sm and Sk: not "non-ASCII symbols"
HIDDEN = [chr(0x34F), chr(0x180B), chr(0x180C), chr(0x180D), chr(0x200B), chr(0xE0100)]  # U+034F, U+180B to U+180D, ZWSP, a variation selector of the supplement


def allow_git(m):
    return [tp.rule(m, 'git', m.Level.ALLOW, tools=('terminal',), commands=('git commit *',))]


def decide(m, rules, command):
    decision, _ordered = m._evaluate_full(rules, m.Action(bot='vendas', tool='terminal', command=command))
    return decision


def unclean(m, command):
    """The engine asks about it (an ALLOW rule does not cover it) AND the text says it is not clean."""
    decision = decide(m, allow_git(m), 'git commit -m "' + command + '"')
    return m._command_text(command)[1] is False and decision.reason is m.ReasonCode.NONCANONICAL_ACTION


def inv_an_emoji_selector_directly_after_a_symbol_keeps_the_action_clean(m):
    for category, symbol in SYMBOLS.items():
        assert m._fold(symbol) == symbol and unicodedata.category(symbol) == category, category                      # the premise: the symbol reaches the matcher as it is
        for selector in SELECTORS:
            text, clean = m._command_text(f'git commit -m "fix {symbol}{selector}"')
            assert clean and text == f'git commit -m "fix {symbol}"', (category, hex(ord(selector)))               # dropped for the match, and clean
    for message in (f'fix {CHECK}{VS16}', f'{WARN}{VS16} careful', f'{HEART}{VS16}', f'ship it {COPY}{VS16}', f'{CHECK}{VS16} {HEART}{VS16} {WARN}{VS15}'):
        decision = decide(m, allow_git(m), f'git commit -m "{message}"')
        assert decision.effect is m.Level.ALLOW and decision.winner == 'git', message                                # the allow rule covers it again
    assert m._command_text('echo ' + HEART + VS16)[1] is True                                                      # at the very end of the text too


def inv_a_selector_anywhere_else_makes_the_action_unclean(m):
    for before in ('a', 'Z', '1', ' ', '"', '-', '\n', '\t', ''):
        assert unclean(m, 'x' + before + VS16 + 'y' if before else VS16 + 'y'), repr(before)                          # after ASCII, a space, a newline, or at the very start
    for ascii_symbol in ASCII_SYMBOLS:
        assert unclean(m, 'x' + ascii_symbol + VS16), ascii_symbol                                                 # an ASCII Sm or Sk is not a non-ASCII symbol
    for category, char in NOT_SYMBOLS.items():
        assert m._fold(char) == char and unicodedata.category(char) == category, category
        assert unclean(m, 'x' + char + VS16), category                                                             # a letter, a digit, a currency sign, a punctuation mark
    for keycap in ('#', '*', '1'):
        assert unclean(m, keycap + VS16 + chr(0x20E3)), keycap                                                     # the keycap sequences stay unclean, on purpose
    assert unclean(m, 'curl http://local' + VS16 + 'host/')


def inv_a_hidden_character_or_a_second_selector_is_never_clean_and_the_dirt_stays(m):
    for hidden in HIDDEN:
        assert unclean(m, CHECK + hidden), hex(ord(hidden))                                                        # a hidden character right after a symbol
        assert unclean(m, CHECK + hidden + VS16), hex(ord(hidden))                                                 # ...and between the symbol and the selector
        assert unclean(m, CHECK + VS16 + hidden), hex(ord(hidden))
    for tail in (VS16, VS15, VS1, VS16 + VS16):
        assert unclean(m, CHECK + VS16 + tail), hex(ord(tail[0]))                                                  # one selector only
    assert unclean(m, 'local' + VS16 + 'host ' + CHECK + VS16)                                                     # an unclean spelling before an emoji stays unclean
    assert unclean(m, CHECK + VS16 + ' x' + VS16 + 'y')                                                            # ...and after it
    assert unclean(m, 'x' + chr(0x180B) + ' ' + HEART + VS16)


def inv_the_destination_bypass_of_r5_stays_blocked_and_an_emoji_unlocks_nothing(m):
    block = [tp.rule(m, 'net', m.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]
    for selector in (VS16, VS15, VS1, VS14):
        assert decide(m, block, 'curl http://local' + selector + 'host:1/').winner == 'net', hex(ord(selector))   # a block on a host sees through every selector
    assert decide(m, block, 'curl http://local' + VS16 + 'host/ ' + CHECK + VS16).winner == 'net'                  # ...and an emoji next to it changes nothing
    assert decide(m, block, 'curl http://localhost/ ' + CHECK + VS16).winner == 'net'                              # an emoji next to a plain host: the block still matches the text
    allow = [tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]
    assert decide(m, allow, 'curl http://exam' + VS16 + 'ple.com/').reason is m.ReasonCode.NONCANONICAL_ACTION     # a selector inside a host asks...
    assert decide(m, allow, 'curl http://exam' + VS16 + 'ple.com/ ' + CHECK + VS16).reason is m.ReasonCode.NONCANONICAL_ACTION   # ...and an emoji after it does not unlock it
    assert decide(m, allow, 'curl http://example.com/ ' + CHECK + VS16).winner == 'all'                            # an emoji alone is fine


def inv_the_hook_treats_an_emoji_as_clean_and_a_selector_elsewhere_as_noncanonical(m):
    table = m.compile_hook_table([tp.rule(m, 'b', m.Level.BLOCK, tools=(), commands=('curl *localhost*',))], version=1, toolset_tools={}, mcp_server_tools={})
    for command in ('git commit -m "fix ' + CHECK + VS16 + '"', 'echo ' + HEART + VS16, 'echo ' + WARN + VS16 + ' careful'):
        assert m.hook_verdict(table, tool='terminal', command=command).action == 'none', command                    # nothing to ask: Hermes decides alone
    for command in ('git commit -m "a' + VS16 + 'b"', 'echo 1' + VS16, 'echo ' + CHECK + VS16 + VS16, 'echo local' + VS16 + 'host ' + CHECK + VS16):
        verdict = m.hook_verdict(table, tool='terminal', command=command)
        assert verdict.action == 'approve' and verdict.message == 'luvebot:noncanonical', command
    assert m.hook_verdict(table, tool='terminal', command='curl http://local' + VS16 + 'host/').action == 'block'


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
A, U, X, D, H = tuple(INVARIANTS)

GATE = 'if not (0xFE00 <= ord(char) <= 0xFE0F and index and ord(folded[index - 1]) > 0x7F and unicodedata.category(folded[index - 1]) in _SYMBOL_BEFORE_SELECTOR):'
AFTER_ANYTHING = ('if not (0xFE00 <= ord(char) <= 0xFE0F and index and ord(folded[index - 1]) > 0x7F and unicodedata.category(folded[index - 1]) in _SYMBOL_BEFORE_SELECTOR):', 'if not (0xFE00 <= ord(char) <= 0xFE0F):')
WASHES = ('                clean = False\n            continue\n        kept.append(char)', '                clean = False\n            else:\n                clean = len(raw) <= MAX_COMMAND\n            continue\n        kept.append(char)')
CLASSES = 'frozenset({"So", "Sk", "Sm", "No"})'

MUTATIONS = [
    (U, 'the selector is clean after anything', *AFTER_ANYTHING),
    (D, 'the selector is clean after anything', *AFTER_ANYTHING),
    (H, 'the selector is clean after anything', *AFTER_ANYTHING),
    (D, 'a clean emoji washes the dirt before it', *WASHES),
    (H, 'a clean emoji washes the dirt before it', *WASHES),
    (X, 'a clean emoji washes the dirt before it', *WASHES),
    (X, 'any hidden character is clean after a symbol', '0xFE00 <= ord(char) <= 0xFE0F and index and', 'index and'),
    (X, 'the previous KEPT character is the symbol (two selectors stay clean)', 'index and ord(folded[index - 1]) > 0x7F and unicodedata.category(folded[index - 1]) in _SYMBOL_BEFORE_SELECTOR', 'kept and ord(kept[-1]) > 0x7F and unicodedata.category(kept[-1]) in _SYMBOL_BEFORE_SELECTOR'),
    (X, 'U+180B to U+180D are clean after a symbol', '0xFE00 <= ord(char) <= 0xFE0F and index', '(0xFE00 <= ord(char) <= 0xFE0F or 0x180B <= ord(char) <= 0x180D) and index'),
    (X, 'U+034F is clean after a symbol', '0xFE00 <= ord(char) <= 0xFE0F and index', '(0xFE00 <= ord(char) <= 0xFE0F or ord(char) == 0x34F) and index'),
    (U, 'the symbol need not be non-ASCII', 'ord(folded[index - 1]) > 0x7F and ', ''),
    (U, 'the symbol classes widened to letters', CLASSES, 'frozenset({"So", "Sk", "Sm", "No", "Ll", "Lo"})'),
    (U, 'the symbol classes widened to digits', CLASSES, 'frozenset({"So", "Sk", "Sm", "No", "Nd"})'),
    (U, 'the symbol classes widened to currency and punctuation', CLASSES, 'frozenset({"So", "Sk", "Sm", "No", "Sc", "Po"})'),
    (A, 'So is not a symbol', CLASSES, 'frozenset({"Sk", "Sm", "No"})'),
    (A, 'Sk is not a symbol', CLASSES, 'frozenset({"So", "Sm", "No"})'),
    (A, 'Sm is not a symbol', CLASSES, 'frozenset({"So", "Sk", "No"})'),
    (A, 'No is not a symbol', CLASSES, 'frozenset({"So", "Sk", "Sm"})'),
    (A, 'only the two emoji selectors are clean', '0xFE00 <= ord(char) <= 0xFE0F and index', '0xFE0E <= ord(char) <= 0xFE0F and index'),
    (A, 'only U+FE0F is clean', '0xFE00 <= ord(char) <= 0xFE0F and index', 'ord(char) == 0xFE0F and index'),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


def test_every_mutation_anchors_once_in_the_gate():
    source = (Path(__file__).resolve().parents[3] / 'backend' / 'rules.py').read_text(encoding='utf-8')
    assert source.count(GATE) == 1
    for _inv, label, old, _new in MUTATIONS:
        assert source.count(old) == 1, label


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)
