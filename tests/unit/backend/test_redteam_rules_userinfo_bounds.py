"""Red team (Lume, 31/10): the boundaries of A-202 (F-R7-2, decided: the user info of a URL runs to the LAST `@` of the authority, only for the rules that match MORE, and `%40` does not count), pinned BEFORE the Brasa's fix.

All plain tests. They pass on the engine as it is (the regex takes ONE `@`) and each must keep passing when the user info is allowed to hold `@`: a fix that is WIDER than the decision turns one red (the proof is below: a user info that may also hold `/`, `?` or `#`).
 - an `@` in the PATH, the QUERY or the FRAGMENT is not a user info separator: `http://example.org/p?x=@2130706433/` is the host example.org, not 127.0.0.1;
 - `%40` is not an `@` (`http://x%402130706433/` is a host name that is not an address; `http://a%40b@2130706433/` has ONE real `@`);
 - a space ends the authority: `curl http://a@b @2130706433/x` is two words;
 - an ALLOW rule keeps matching the exact text: several `@`, one `@`, user info or none: another text, another decision.
Every case with a number is the address 127.0.0.1 written as a decimal, so a block on `127.0.0.1` shows when the canonical form is wrongly applied."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
dest = pytest.importorskip('test_redteam_rules_destination', reason='my destination helpers')
more = pytest.importorskip('test_redteam_rules_destination_more', reason='my allow helper')

LOOPBACK = 'curl *127.0.0.1*'


@pytest.mark.parametrize('command', ['curl http://example.org/p?x=@2130706433/', 'curl http://example.org/p@2130706433/', 'curl http://example.org#@2130706433/', 'curl http://example.org?@2130706433', 'curl http://example.org/a/b@c@2130706433/x'],
                         ids=['query', 'path', 'fragment', 'query only', 'path two @'])
def test_an_at_sign_after_the_authority_is_not_a_user_info_separator(command):
    assert not dest.blocked(LOOPBACK, command), command                                      # the host is example.org: the number after the `@` is not a destination


@pytest.mark.parametrize('command', ['curl http://x%402130706433/', 'curl http://x%402130706433.evil.test/', 'curl http://a%40b%402130706433/'], ids=['encoded at', 'encoded at, then a name', 'two encoded'])
def test_a_percent_encoded_at_sign_is_not_a_separator(command):
    host_is_the_address = 'curl http://a@2130706433/x'
    assert dest.blocked(LOOPBACK, host_is_the_address)                                         # control: ONE real `@` and a decimal address is the loopback
    assert not dest.blocked(LOOPBACK, command), command


def test_one_real_at_sign_with_an_encoded_one_in_the_user_info_still_reads_the_host():
    assert dest.blocked(LOOPBACK, 'curl http://a%40b@2130706433/x')


def test_a_space_ends_the_authority():
    assert not dest.blocked(LOOPBACK, 'curl http://a@b @2130706433/x')


@pytest.mark.parametrize('command', ['curl http://a@b@example.com/x', 'curl http://a@example.com/x', 'curl http://a@b@c@example.com/x', 'curl http://example.com@example.com/x'])
def test_an_allow_rule_for_a_host_matches_the_exact_text_whatever_the_user_info(command):
    assert not more.allowed_by('curl http://example.com/*', command), command
    assert more.allowed_by('curl http://example.com/*', 'curl http://example.com/x')          # control
