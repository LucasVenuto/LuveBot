"""Red team (Lume, 31/10) of the rules engine on DESTINATIONS (the Prumo's list after A-198): what a resolver or a URL parser treats as the same host and the matcher compares as text.

MEASURED on this machine (macOS, curl 8.7.1, only against localhost, port 1, no network: error 7 = the host was reached, error 6 = it could not be resolved; the control, a host that does not exist, is 6): curl reaches
127.0.0.1 as `localhost.`, `127.1`, `127.0.1`, `2130706433`, `0x7f000001`, `017700000001`, `0177.0.0.1`, `0x7f.0.0.1`, `0x7f.1`, `127.000.000.001`, `[::1]`, `[::ffff:127.0.0.1]`, `0.0.0.0` and `0`. libc `inet_aton` turns the cloud
metadata address 169.254.169.254 from `2852039166`, `0xa9fea9fe`, `025177524776` and `169.254.43518` too.

HELD (plain, the control): a name rule by substring (`curl *example.com*`) already blocks the upper case, the trailing dot, the default port and user info; the plain IP and the plain boundary form are blocked.

FIXED IN R-7 (A-199; the 20 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_destination.py):
  F-R4-2 (Media): a block rule on an IP LITERAL (`curl *127.0.0.1*`, `curl *169.254.169.254*`: the rules people write against loopback and the cloud metadata service) is bypassed by every numeric spelling of the same address
  (decimal, hex, octal, short, leading zeros): the engine decides ALLOW (the broad `curl *`), the host is reached. The seal says "real block for the forms the pattern recognizes", but a numeric spelling of an address is not another command.
  F-R4-3 (Baixa): a rule with a BOUNDARY after the host (`curl *example.com/*`, `curl *//example.com/*`) is bypassed by the trailing dot (`example.com./x`) and by the default port (`example.com:80/x`, `:443` for https).
Reference fix (a model, not a patch): the action's URL authorities are put in one canonical form before the match (a numeric IPv4 spelling by libc `inet_aton`, the trailing dot off, the default port off) and a pattern that spells the authority literally gets the same.
NOT CLAIMED: `[::1]`, `0.0.0.0`, `[::ffff:127.0.0.1]` (other spellings of loopback that are not the same text in any form: the rule's author lists them) and a destination written without a scheme (`curl 127.1:8080`)."""
import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the path rules')

import backend.rules as real  # noqa: E402


def blocked(pattern, command, m=real):
    rules = [tp.rule(m, 'b', m.Level.BLOCK, tools=('terminal',), commands=(pattern,)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]
    decision, _ordered = m._evaluate_full(rules, m.Action(bot='vendas', tool='terminal', command=command))
    return decision.winner == 'b'


def test_the_premise_libc_reads_these_spellings_as_the_same_address():
    for spelling in ('2130706433', '0x7f000001', '017700000001', '127.1', '127.0.1', '0177.0.0.1', '0x7f.0.0.1', '127.000.000.001'):
        assert socket.inet_ntoa(socket.inet_aton(spelling)) == '127.0.0.1', spelling
    for spelling in ('2852039166', '0xa9fea9fe', '025177524776', '169.254.43518'):
        assert socket.inet_ntoa(socket.inet_aton(spelling)) == '169.254.169.254', spelling


def test_control_what_a_name_rule_by_substring_and_the_plain_forms_already_block():
    for host in ('example.com', 'EXAMPLE.COM', 'example.com.', 'example.com:80', 'user@example.com'):
        assert blocked('curl *example.com*', f'curl http://{host}'), host
    assert blocked('curl *127.0.0.1*', 'curl http://127.0.0.1:8080/') and blocked('curl *169.254.169.254*', 'curl http://169.254.169.254/latest/meta-data/')
    assert blocked('curl *example.com/*', 'curl http://example.com/x') and blocked('curl *example.com/*', 'curl http://EXAMPLE.COM/x') and blocked('curl *example.com/*', 'curl http://user@example.com/x')
    assert not blocked('curl *example.com/*', 'curl http://example.org/x')                     # the rule is not a block on everything


LOOPBACK = ['127.1', '127.0.1', '2130706433', '0x7f000001', '017700000001', '0177.0.0.1', '0x7f.0.0.1', '127.000.000.001']
METADATA = ['2852039166', '0xa9fea9fe', '025177524776', '169.254.43518']


@pytest.mark.parametrize('spelling', LOOPBACK)
def test_a_block_on_127_0_0_1_holds_for_every_numeric_spelling_of_it(spelling):
    assert blocked('curl *127.0.0.1*', f'curl http://{spelling}:1/'), spelling


@pytest.mark.parametrize('spelling', METADATA)
def test_a_block_on_the_metadata_address_holds_for_every_numeric_spelling_of_it(spelling):
    assert blocked('curl *169.254.169.254*', f'curl http://{spelling}/latest/meta-data/'), spelling


@pytest.mark.parametrize('pattern', ['curl *example.com/*', 'curl *//example.com/*'])
@pytest.mark.parametrize('command', ['curl http://example.com./x', 'curl http://example.com:80/x', 'curl https://example.com:443/x', 'curl https://EXAMPLE.COM.:443/x'])
def test_a_block_with_a_boundary_after_the_host_holds_for_the_trailing_dot_and_the_default_port(pattern, command):
    assert blocked(pattern, command), (pattern, command)
