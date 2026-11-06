"""Red team (Lume, 31/10): the boundaries of A-200 (F-R5-1, decided: R-9), pinned BEFORE the Brasa's R-9 lands so that it cannot be wider than the decision.

A-200: a variation selector (U+FE0E, U+FE0F) right after a NON-ASCII symbol (category So, Sk, Sm, No) is dropped for the match and does not make the action unclean; ONLY ONE, right after the symbol; after ASCII, a letter, a digit or a space the action stays unclean; U+034F and U+180B-180D are never
clean; a keycap (a digit, U+FE0F, U+20E3) stays unclean on purpose.

All plain tests: they pass on today's engine (every such character makes the action unclean) and each must keep passing under R-9. They were built against my own model of the fix, which let TWO selectors in a row through: one of them goes red on it, which is the proof that they say something.
Every character is built with chr(), never written raw."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the path rules')

import backend.rules as real  # noqa: E402

VS16, VS15 = chr(0xFE0F), chr(0xFE0E)
CHECK, WARN = chr(0x2714), chr(0x26A0)
ALLOW_GIT = [tp.rule(real, 'git', real.Level.ALLOW, tools=('terminal',), commands=('git commit *',))]


def reason(command):
    decision, _ordered = real._evaluate_full(ALLOW_GIT, real.Action(bot='vendas', tool='terminal', command=command))
    return decision.reason


def commit(text):
    return 'git commit -m "' + text + '"'


def test_control_a_plain_commit_is_allowed():
    assert reason(commit('fix')) is real.ReasonCode.SINGLE_RULE


@pytest.mark.parametrize('text', [CHECK + VS16 + VS16, CHECK + VS16 + VS15, CHECK + VS15 + VS16, WARN + VS16 + VS16 + VS16], ids=['two VS16', 'VS16 then VS15', 'VS15 then VS16', 'three'])
def test_only_ONE_selector_right_after_the_symbol_is_clean(text):
    assert reason(commit('fix ' + text)) is real.ReasonCode.NONCANONICAL_ACTION


@pytest.mark.parametrize('text', ['a' + VS16, 'Z' + VS15, '5' + VS16, ' ' + VS16, VS16, '-' + VS16, '.' + VS16, '/' + VS16], ids=['letter', 'upper letter', 'digit', 'space', 'alone', 'hyphen', 'dot', 'slash'])
def test_a_selector_after_ascii_letter_digit_space_or_nothing_stays_unclean(text):
    assert reason(commit('fix ' + text)) is real.ReasonCode.NONCANONICAL_ACTION


@pytest.mark.parametrize('cp', [0x034F, 0x180B, 0x180C, 0x180D], ids=lambda c: f'U+{c:04X}')
def test_the_other_ignorable_characters_are_never_clean_even_after_a_symbol(cp):
    assert reason(commit('fix ' + CHECK + chr(cp))) is real.ReasonCode.NONCANONICAL_ACTION


def test_a_keycap_stays_unclean_on_purpose():
    assert reason(commit('step 1' + VS16 + chr(0x20E3))) is real.ReasonCode.NONCANONICAL_ACTION


def test_a_selector_after_a_symbol_in_a_host_position_does_not_make_an_ascii_host_clean():
    # the selector follows a non-ASCII symbol, so the action may be clean, but the host it sits in is not an ASCII host: an ALLOW rule for an ASCII host must not cover it
    rules = [tp.rule(real, 'only', real.Level.ALLOW, tools=('terminal',), commands=('curl http://example.com/*',))]
    decision, _ordered = real._evaluate_full(rules, real.Action(bot='vendas', tool='terminal', command='curl http://example.com' + CHECK + VS16 + '/x'))
    assert decision.winner != 'only'
