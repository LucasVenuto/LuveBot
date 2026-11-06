"""Red team (Lume, 31/10) of the destination rules, part 3: the question of A-199 and the vectors the curl of this machine accepts that the canonical form of A-199 does not read.

A-199 (decided): the engine reads a destination in ONE canonical form, but ONLY for the rules that match MORE (block, ask, handback), as one more variant of the action; an ALLOW rule keeps matching the exact text, because a canonicalizer
that disagreed with a resolver could allow another host. The Prumo's question to the red team: is there a path in which the ALLOW side gets the canonicalization by accident (a variant shared between the levels)?

HELD (plain; they pass on today's engine, which canonicalizes nothing, and each goes red on a variant that lets the ALLOW side read the canonical form): an ALLOW rule written for a destination matches that exact text and NOT its other
spellings (the default port, the trailing dot, a numeric IP, a percent-encoded letter); and it still allows the exact text.

FIXED IN R-7 (A-199; the tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_destination.py), measured with the curl of this machine against localhost only (error 7 = the host was reached, error 6 = it was not, the control is 6):
  F-R4-4 (Media): a PERCENT-ENCODED host (`local%68ost`, `%6c%6f%63%61%6c%68%6f%73%74`, `%31%32%37.0.0.1`, `127.0.0.%31`) reaches the same host (curl decodes it) and no text pattern reads it: one letter turns `curl *localhost*` into ALLOW.
  F-R4-5 (Baixa): the DEFAULT PORT written with zeros (`:0080`, `:00443`) is the default port for curl and another text for the matcher; and a boundary `host/` (`curl *example.com/*`) is not met by a URL with NO PATH
  (`http://example.com`, `http://example.com?x=1`, `http://example.com#f`: the plain way people write it).
The canonical form of the reference model (not a patch) reads them all: percent-decoding of a host that stays a host name, the port as a number, a `/` when there is no path; and it keeps the ALLOW side on the exact text."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
dest = pytest.importorskip('test_redteam_rules_destination', reason='my first destination tests')
tp = dest.tp
real = dest.real


def allowed_by(rule_pattern, command, m=real):
    """True when the ALLOW rule `curl <rule_pattern>` is the one that decides for `command` (and nothing stricter does)."""
    rules = [tp.rule(m, 'only', m.Level.ALLOW, tools=('terminal',), commands=(rule_pattern,))]
    decision, _ordered = m._evaluate_full(rules, m.Action(bot='vendas', tool='terminal', command=command))
    return decision.winner == 'only'


def test_an_allow_rule_for_a_destination_allows_that_exact_text():
    assert allowed_by('curl http://example.com/*', 'curl http://example.com/x')
    assert allowed_by('curl http://127.0.0.1/*', 'curl http://127.0.0.1/x')
    assert allowed_by('curl http://example.com:8080/*', 'curl http://example.com:8080/x')
    assert not allowed_by('curl http://example.com/*', 'curl http://example.org/x')


@pytest.mark.parametrize('command', ['curl http://example.com:80/x', 'curl http://example.com./x', 'curl http://exampl%65.com/x', 'curl http://user@example.com/x', 'curl http://example.com:0080/x'])
def test_an_allow_rule_for_a_host_does_not_allow_its_other_spellings(command):
    assert not allowed_by('curl http://example.com/*', command), command                   # the ALLOW side matches the exact text only (A-199)


@pytest.mark.parametrize('command', ['curl http://2130706433/x', 'curl http://127.1/x', 'curl http://0x7f000001/x', 'curl http://127.0.0.%31/x', 'curl http://0177.0.0.1/x'])
def test_an_allow_rule_for_an_ip_does_not_allow_its_other_spellings(command):
    assert not allowed_by('curl http://127.0.0.1/*', command), command


def test_an_allow_rule_written_in_another_spelling_does_not_allow_the_plain_one_either():
    assert not allowed_by('curl http://2130706433/*', 'curl http://127.0.0.1/x')
    assert not allowed_by('curl http://example.com:80/*', 'curl http://example.com/x')


@pytest.mark.parametrize('pattern,host', [('curl *localhost*', 'local%68ost'), ('curl *localhost*', '%6c%6f%63%61%6c%68%6f%73%74'), ('curl *127.0.0.1*', '%31%32%37.0.0.1'),
                                          ('curl *127.0.0.1*', '127.0.0.%31'), ('curl *example.com*', 'exampl%65.com'), ('curl *example.com*', 'EXAMPL%45.COM')])
def test_a_block_holds_for_a_percent_encoded_host(pattern, host):
    assert dest.blocked(pattern, f'curl http://{host}:1/'), (pattern, host)


@pytest.mark.parametrize('pattern', ['curl *example.com/*', 'curl *//example.com/*'])
@pytest.mark.parametrize('command', ['curl http://example.com:0080/x', 'curl https://example.com:00443/x'])
def test_a_boundary_rule_holds_for_the_default_port_written_with_zeros(pattern, command):
    assert dest.blocked(pattern, command), (pattern, command)


@pytest.mark.parametrize('pattern', ['curl *example.com/*', 'curl *//example.com/*'])
@pytest.mark.parametrize('command', ['curl http://example.com', 'curl https://example.com -o out', 'curl http://example.com?x=1', 'curl http://example.com#f'])
def test_a_boundary_rule_holds_for_a_url_with_no_path(pattern, command):
    assert dest.blocked(pattern, command), (pattern, command)
