"""Red team (Lume, 31/10) of R-7 (A-199, A-201): the destination read in one canonical form, for the rules that match MORE. The Prumo's three points after the delivery, measured.

MEASURED with the curl of this machine, only against localhost (error 7 = reached, 6 = not, 3 = malformed URL; the control, a host that does not exist, is 6):
 (1) SEVERAL `@` in the authority: `http://a@b@127.0.0.1:1/`, `http://a:b@c@2130706433:1/`, `http://a@b@localhost:1/` are ERROR 3: this curl refuses them, so for curl it is NOT a vector. A client that takes the LAST `@` as the userinfo delimiter reaches the host (Python's
     `urlsplit('http://a@b@127.0.0.1/').hostname` is `127.0.0.1`, and so is the WHATWG URL parser of a browser): the regex of R-7 takes ONE userinfo `[^/@?#\\s]*@` and then wants a border, so it does not canonicalize the URL.
 (2) A PORT of 6 or more digits written with zeros: `http://127.0.0.1:0000001/`, `:00000000001` and `:000001` are ERROR 7 (reached): curl reads them as port 1, so `:000080` is the default port 80. R-7 keeps `:000080` as written (`len(port) <= 5`), so a rule with a border after the host is bypassed.
HELD (plain): 1 to 5 digits of zeros are already read as the default port; a different port is a different destination; a percent-encoded dot in an address is decoded; the adversarial 16 KiB commands cost about 11 ms (linear, no backtracking blow-up); and an ALLOW rule never enters the table the hook receives
(`compile_hook_table` keeps the rules that match MORE), so the pattern forms of R-7 cannot reach the ALLOW side through the hook either.
FIXED IN R-7b (A-201 and A-202; the 14 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_destination.py): F-R7-1 (Baixa): the port with 6 or more digits of zeros; F-R7-2 (Info, a client that takes the last `@`): several `@` in the authority.
Fix of F-R7-1 (R-7b): the port is compared as a number (`port.lstrip('0') == str(default)`). Fix of F-R7-2: the userinfo may hold `@` (it runs to the LAST `@` before the host)."""
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
dest = pytest.importorskip('test_redteam_rules_destination', reason='my destination helpers')
tp = dest.tp
real = dest.real


def test_control_one_to_five_digits_of_zeros_are_the_default_port_and_another_port_is_another_destination():
    for port in ('80', '080', '0080', '00080'):
        assert dest.blocked('curl *example.com/*', f'curl http://example.com:{port}/x'), port
    for port in ('443', '0443', '00443'):
        assert dest.blocked('curl *example.com/*', f'curl https://example.com:{port}/x'), port
    assert not dest.blocked('curl *example.com/*', 'curl http://example.com:8080/x')               # another port is another destination: the border `host/` is not met
    assert not dest.blocked('curl *example.com/*', 'curl http://example.com:008080/x')
    assert dest.blocked('curl *127.0.0.1*', 'curl http://127%2e0%2e0%2e1:1/') and dest.blocked('curl *127.0.0.1*', 'curl http://127%2E0.0.1:1/')      # a percent-encoded dot of an address is decoded


def test_the_adversarial_16_KiB_commands_cost_about_ten_milliseconds_not_seconds():
    rules = [tp.rule(real, 'b', real.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',))]
    payloads = ['http://a@' * 1800, 'a://' * 4000, 'http://' + 'a.' * 7900, 'http://' + '%41' * 5300, 'http://127.' + '0.' * 7000, 'http://x?' + '#' * 15000, 'http://' + '0x' * 7900, 'http://:' * 2000 + 'x',
                'http://' + '1' * 15000, 'http://h:' + '0' * 15000 + '80/']
    for payload in payloads:
        started = time.perf_counter()
        real._evaluate_full(rules, real.Action(bot='v', tool='terminal', command='curl ' + payload[:15990]))
        assert time.perf_counter() - started < 1.0, payload[:20]


def test_an_allow_rule_never_enters_the_table_the_hook_receives():
    allow = tp.rule(real, 'a', real.Level.ALLOW, tools=('terminal',), commands=('curl http://2130706433/*',))
    block = tp.rule(real, 'b', real.Level.BLOCK, tools=('terminal',), commands=('curl http://2130706433/*',))
    table = real.compile_hook_table([allow], version=1, toolset_tools={}, mcp_server_tools={})
    assert [e.rule_id for e in table.entries] == []
    with_block = real.compile_hook_table([block], version=1, toolset_tools={}, mcp_server_tools={})
    assert [e.rule_id for e in with_block.entries] == ['b']                                       # and the one that matches MORE does


@pytest.mark.parametrize('pattern', ['curl *example.com/*', 'curl *//example.com/*'])
@pytest.mark.parametrize('command', ['curl http://example.com:000080/x', 'curl http://example.com:0000080/x', 'curl http://example.com:00000000080/x', 'curl https://example.com:000443/x', 'curl https://example.com:00000000443/x'])
def test_a_boundary_rule_holds_for_the_default_port_written_with_six_or_more_digits(pattern, command):
    assert dest.blocked(pattern, command), (pattern, command)


@pytest.mark.parametrize('pattern,command', [('curl *127.0.0.1*', 'curl http://a@b@2130706433/x'), ('curl *127.0.0.1*', 'curl http://a:b@c@0x7f000001:1/'), ('curl *example.com/*', 'curl http://a@b@example.com:80/x'),
                                             ('curl *example.com/*', 'curl http://a@b@example.com./x')])
def test_a_rule_holds_for_a_url_with_several_userinfo_separators(pattern, command):
    assert dest.blocked(pattern, command), (pattern, command)
