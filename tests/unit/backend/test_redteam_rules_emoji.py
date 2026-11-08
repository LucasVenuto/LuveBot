"""Red team (Lume, 31/10) of R-5 (a8da6fb, A-198): the matcher now drops U+FE0E and U+FE0F (the variation selectors: legitimate in text, but the resolver erases them from a host) and, like every character it drops, marks the action
UNCLEAN, so an ALLOW rule no longer covers it (`NONCANONICAL_ACTION`: the person is asked).

MEASURED: with `allow terminal "git commit *"`, `git commit -m "fix <check mark><VS16>"` was ALLOW before R-5 and is ASK now; the same for the warning sign and the heart. U+FE0F is what makes a symbol an EMOJI (the check mark, the warning sign, the heart,
the copyright sign): the commonest emoji of a commit message or a message to a customer. A family emoji (ZWJ) was already ASK before. The direction is the safe one; the cost is a question for every command that holds one.

FIXED IN R-9 (A-200; the 4 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_emoji_selector.py) F-R5-1 (Baixa, availability): the matcher keeps dropping them (that is the fix of F-R4-1), but a variation selector right after a NON-ASCII symbol (category So, Sk, Sm, No: an emoji presentation sequence) cannot be part of an ASCII host, so it need not make
the action unclean. HELD (plain, they pass today and must keep passing): after an ASCII letter or digit it stays unclean (`local<VS16>host`, `curl http://exam<VS16>ple.com`), and a BLOCK on a host still sees through it.
Fix (R-9): in `_command_text`, ONE variation selector (U+FE00 to U+FE0F) directly after a non-ASCII symbol (So, Sk, Sm, No) keeps the action clean; a second selector, or one after anything else, does not.
NOT CLAIMED: U+1806 (MONGOLIAN TODO SOFT HYPHEN, category Pd) is erased from a host by Python's IDNA2003 codec (`'ev\\u1806il.test'.encode('idna')` is `evil.test`) and is in neither the categories nor the table; this machine's curl did NOT erase it (error 6): the Forja's curl with libidn2 (R-6)
decides."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the path rules')

import backend.rules as real  # noqa: E402

VS16, VS15 = chr(0xFE0F), chr(0xFE0E)
CHECK, WARN, HEART, COPY = chr(0x2714), chr(0x26A0), chr(0x2764), chr(0x00A9)


def decide(rules, command):
    decision, _ordered = real._evaluate_full(rules, real.Action(bot='vendas', tool='terminal', command=command))
    return decision


ALLOW_GIT = [tp.rule(real, 'git', real.Level.ALLOW, tools=('terminal',), commands=('git commit *',))]
BLOCK_NET = [tp.rule(real, 'net', real.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',)), tp.rule(real, 'all', real.Level.ALLOW, tools=('terminal',), commands=('curl *',))]


def test_control_a_plain_commit_is_allowed_and_a_zwj_emoji_was_already_asked():
    assert decide(ALLOW_GIT, 'git commit -m "fix"').effect is real.Level.ALLOW
    assert decide(ALLOW_GIT, 'git commit -m "' + chr(0x1F468) + chr(0x200D) + chr(0x1F469) + '"').reason is real.ReasonCode.NONCANONICAL_ACTION


def test_a_variation_selector_after_an_ascii_character_stays_unclean_and_a_block_still_sees_through_it():
    for command in ('git commit -m "a' + VS16 + 'b"', 'git commit -m "1' + VS16 + '"'):
        assert decide(ALLOW_GIT, command).reason is real.ReasonCode.NONCANONICAL_ACTION, command           # not an emoji sequence: the action is asked about
    assert decide(BLOCK_NET, 'curl http://local' + VS16 + 'host:1/').winner == 'net'                         # F-R4-1 stays closed
    assert decide(BLOCK_NET, 'curl http://local' + VS15 + 'host:1/').winner == 'net'
    assert decide([tp.rule(real, 'all', real.Level.ALLOW, tools=('terminal',), commands=('curl *',))], 'curl http://exam' + VS16 + 'ple.com/').reason is real.ReasonCode.NONCANONICAL_ACTION


@pytest.mark.parametrize('symbol', [CHECK, WARN, HEART, COPY], ids=lambda c: f'U+{ord(c):04X}')
def test_an_emoji_in_a_commit_message_does_not_turn_an_allow_into_a_question(symbol):
    decision = decide(ALLOW_GIT, 'git commit -m "fix ' + symbol + VS16 + '"')
    assert decision.effect is real.Level.ALLOW and decision.winner == 'git', decision
