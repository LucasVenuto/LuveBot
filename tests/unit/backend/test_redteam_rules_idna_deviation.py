"""Red team (Lume, 31/10), the target of A-207 (A-208, R-13): is there a tool for which the FOLDED text names host A and the tool reaches host B? YES: the three characters whose full case fold is not the simple lowercase.

MEASURED (evidence/a207/ of the role; Python 3.14.5, Unicode 16; Node 26.7, ICU 78, Unicode 17; libidn2 2.3.8): the engine folds with NFKC and `casefold()`: U+00DF (sharp s) and U+1E9E (capital sharp s) become `ss`, U+03C2 (final sigma) becomes U+03C3. libidn2 called with the
flags curl uses for a host (NFC input, non-transitional processing, the transitional one only if that fails) and the WHATWG URL parser (Node: fetch, undici, http; a browser) KEEP them: `fa<ss>.de` resolves `xn--fa-hia.de`, never `fass.de`; `<sigma><omicron><final sigma>.gr` resolves `xn--0xagb.gr`, not
the host of the plain sigma. The IDNA 2003 codec of Python's standard library agrees with the fold (`b'fass.de'`): the divergence is in every stack that follows UTS 46 non-transitional. SCAN of the 6377 code points whose fold differs from themselves (a host `a<c>b.com` against `a<fold>b.com`): through libidn2 6113 the same, 261 refused by the tool, 3
DIVERGE; through Node 5250 the same, 1124 refused, the same 3: U+00DF, U+03C2, U+1E9E and nothing else. NFKC alone (fullwidth letters, the fullwidth dot) introduces none, so A-207's U+FF0E stays consistent.
Two directions, and R-13 as worded closes one: (1) ACTION side: `allow curl *fass.de*` PERMITS `curl http://fa<ss>.de/`, the tool reaches `xn--fa-hia.de` (another host). (2) PATTERN side: the pattern is folded too, so a person who allows the REAL host, `allow curl *fa<ss>.de*`, ALSO permits `curl http://fass.de/`, and ANY
tool reaches `fass.de` (no IDN stack needed): the action is plain ASCII and clean, so R-13's mark on the action does not see it. The names (tool, toolset, MCP server) fold the same way and `canon_name` says clean: `allow tools=read_pass` hits `read_pa<ss>`, and the reverse.
HELD (plain): a path, a path condition and a recipient keep the exact NFC text in the permissive branch (neither direction hits), and a block or an ask written either way catches both spellings (the restrictive branch matches more).
Reference fix (a model, not a patch; the first hunk is R-13 as A-208 words it, the other two close the pattern side and the names): `redteam-a207-ss-sigma-conserto-prova.diff`.
FIXED by R-13 as A-210 extends it (one predicate, three uses: the command, the names of the action, the patterns of a permissive rule): the 12 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_fold.py."""
import ctypes
import ctypes.util
import sys
import unicodedata
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the rules')

import backend.rules as real  # noqa: E402

SS, CAP, FINAL, SIGMA, OMICRON = chr(0xDF), chr(0x1E9E), chr(0x3C2), chr(0x3C3), chr(0x3BF)
DIVERGENT = {SS, CAP, FINAL}
nfkc = lambda s: unicodedata.normalize('NFKC', s)


def decide(level, action, **match):
    match.setdefault('tools', ('terminal',))                                  # tp.rule defaults to the file tools; a command rule is about the terminal
    return real.evaluate([tp.rule(real, 'x', level, **match)], action)


def permitted(decision):
    """Did the ALLOW rule `x` itself let the action through?"""
    return decision.effect is real.Level.ALLOW and any(h.rule_id == 'x' for h in decision.hits)


def command(text):
    return real.Action(bot='v', tool='terminal', command=text)


def test_premise_the_fold_is_not_what_a_utf46_stack_reads_for_exactly_these_three_characters():
    assert (real._fold(SS), real._fold(CAP), real._fold(FINAL)) == ('ss', 'ss', SIGMA)
    for c in DIVERGENT:
        assert nfkc(c).lower() != nfkc(c).casefold(), hex(ord(c))            # the predicate of R-13 marks each of them
    assert ('fa' + SS + '.de').encode('idna') == b'fass.de'                  # Python's IDNA 2003 codec agrees with the fold: the divergence is in the UTS 46 stacks


def _libidn2():
    name = ctypes.util.find_library('idn2')
    if not name:
        return None
    lib = ctypes.CDLL(name)
    lib.idn2_lookup_u8.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
    lib.idn2_free.argtypes = [ctypes.c_void_p]

    def lookup(host, flags):
        out = ctypes.c_void_p()
        if lib.idn2_lookup_u8(host.encode(), ctypes.byref(out), flags) != 0:
            return None
        text = ctypes.string_at(out.value).decode()
        lib.idn2_free(out)
        return text
    return lambda host: lookup(host, 1 | 8) or lookup(host, 1 | 4)             # NFC_INPUT | NONTRANSITIONAL, then TRANSITIONAL when that fails: the order curl uses


def test_premise_libidn2_with_the_flags_curl_uses_keeps_the_three_characters():
    resolve = _libidn2()
    if resolve is None:
        pytest.skip('libidn2 is not installed here (the measurement is in evidence/a207/)')
    for c in DIVERGENT:
        host = 'a' + c + 'b.com'
        assert resolve(host) != resolve('a' + real._fold(c) + 'b.com'), hex(ord(c))   # the tool reaches another host than the one the engine matched
    assert resolve('fa' + SS + '.de') == 'xn--fa-hia.de' and resolve('fass.de') == 'fass.de'


def test_control_an_allow_for_the_plain_host_permits_the_plain_host_and_not_another():
    assert permitted(decide(real.Level.ALLOW, command('curl http://fass.de/x'), commands=('curl *fass.de*',)))
    assert not permitted(decide(real.Level.ALLOW, command('curl http://other.de/x'), commands=('curl *fass.de*',)))


@pytest.mark.parametrize('level', [real.Level.BLOCK, real.Level.ASK])
@pytest.mark.parametrize('pattern,text', [('curl *fass.de*', 'curl http://fa' + SS + '.de/'), ('curl *fa' + SS + '.de*', 'curl http://fass.de/'), ('curl *fa' + SS + '.de*', 'curl http://fa' + CAP + '.de/'),
                                          ('curl *' + SIGMA + OMICRON + SIGMA + '.gr*', 'curl http://' + SIGMA + OMICRON + FINAL + '.gr/')])
def test_a_block_or_an_ask_written_either_way_catches_both_spellings(level, pattern, text):
    decision = decide(level, command(text), commands=(pattern,))
    assert decision.effect is level and any(h.rule_id == 'x' for h in decision.hits)


@pytest.mark.parametrize('rule_path,fact_path', [('workspace:pass/a.md', 'workspace:pa' + SS + '/a.md'), ('workspace:pa' + SS + '/a.md', 'workspace:pass/a.md')])
@pytest.mark.parametrize('op', ['path', 'path:under', 'path:glob'])
def test_a_path_condition_keeps_the_exact_text_so_neither_direction_hits(op, rule_path, fact_path):
    if op == 'path:under':
        rule_path = rule_path.rsplit('/', 1)[0]
    if op == 'path:glob':
        rule_path = rule_path.rsplit('/', 1)[0] + '/*.md'
    assert not permitted(decide(real.Level.ALLOW, tp.act(real, fact_path), conditions=((op, rule_path),)))


@pytest.mark.parametrize('rule_value,fact', [('bot:pass', 'bot:pa' + SS), ('bot:pa' + SS, 'bot:pass')])
def test_a_recipient_condition_keeps_the_exact_text_so_neither_direction_hits(rule_value, fact):
    action = real.Action(bot='v', tool='send_message', facts=(('recipient', fact),))
    assert not permitted(decide(real.Level.ALLOW, action, tools=('send_message',), conditions=(('recipient:eq', rule_value),)))
    if rule_value.isascii():
        same = real.Action(bot='v', tool='send_message', facts=(('recipient', rule_value),))
        assert permitted(decide(real.Level.ALLOW, same, tools=('send_message',), conditions=(('recipient:eq', rule_value),)))      # the control: the same value does hit


ACTION_SIDE = [('ss host, sharp s in the command', 'curl *fass.de*', 'curl http://fa' + SS + '.de/'),
               ('ss host, capital sharp s in the command', 'curl *fass.de*', 'curl http://fa' + CAP + '.de/'),
               ('sigma host, final sigma in the command', 'curl http://' + SIGMA + OMICRON + SIGMA + '.gr/*', 'curl http://' + SIGMA + OMICRON + FINAL + '.gr/x')]
PATTERN_SIDE = [('sharp s in the pattern, ss in the command', 'curl *fa' + SS + '.de*', 'curl http://fass.de/'),
                ('capital sharp s in the pattern, ss in the command', 'curl *fa' + CAP + '.de*', 'curl http://fass.de/'),
                ('final sigma in the pattern, sigma in the command', 'curl http://' + SIGMA + OMICRON + FINAL + '.gr/*', 'curl http://' + SIGMA + OMICRON + SIGMA + '.gr/x')]


@pytest.mark.parametrize('why,pattern,text', ACTION_SIDE, ids=[x[0] for x in ACTION_SIDE])
def test_an_allow_does_not_permit_the_spelling_a_resolver_reads_as_another_host(why, pattern, text):
    assert not permitted(decide(real.Level.ALLOW, command(text), commands=(pattern,)))


@pytest.mark.parametrize('why,pattern,text', PATTERN_SIDE, ids=[x[0] for x in PATTERN_SIDE])
def test_an_allow_written_with_the_real_idn_host_does_not_permit_the_ascii_twin(why, pattern, text):
    assert not permitted(decide(real.Level.ALLOW, command(text), commands=(pattern,)))


NAMES = [('tool', dict(tools=('read_pass',)), real.Action(bot='v', tool='read_pa' + SS)),
         ('tool, pattern side', dict(tools=('read_pa' + SS,)), real.Action(bot='v', tool='read_pass')),
         ('toolset', dict(tools=(), toolsets=('glass',)), real.Action(bot='v', tool='t', toolset='gla' + SS)),
         ('toolset, pattern side', dict(tools=(), toolsets=('gla' + SS,)), real.Action(bot='v', tool='t', toolset='glass')),
         ('MCP server', dict(tools=(), servers=('glass',)), real.Action(bot='v', tool='mcp__glass__x', mcp_server='gla' + SS)),
         ('MCP server, pattern side', dict(tools=(), servers=('gla' + SS,)), real.Action(bot='v', tool='mcp__glass__x', mcp_server='glass'))]


@pytest.mark.parametrize('why,match,action', NAMES, ids=[x[0] for x in NAMES])
def test_an_allow_on_a_name_does_not_permit_the_other_spelling(why, match, action):
    assert not permitted(decide(real.Level.ALLOW, action, **match))
