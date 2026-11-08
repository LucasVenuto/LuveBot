"""R-10 (contract v0.11 section 8, A-205; the Forja's measure of R-6): what IDNA reads as a dot or as nothing, in the destination of a URL.

MEASURED (docs/propostas/r6-medida-curl-idna.md): libidn2 2.3.8 turns U+3002, U+FF61 and U+FF0E into `127.0.0.1` and refuses U+1806; the Python codec does the same for the three dots and ERASES U+1806 from a host; NFKC folds U+FF0E to a
dot, leaves U+3002 and turns U+FF61 into U+3002. So, only in the RESTRICTIVE branch (block, ask, handback: it can only match more, never allow):
1. the host of the canonical destination reads U+3002 and U+FF61 as a dot, BEFORE the percent decoding and the IPv4 reading (`127<U+3002>0<U+3002>0<U+3002>%31` is 127.0.0.1), and only in the host of a URL authority: a name with U+3002 with
   no `scheme://`, in a path, a query or a fragment is not changed;
2. U+1806 (MONGOLIAN TODO SOFT HYPHEN, category Pd) is dropped like the other characters of RFC 3454 B.1 (the one that neither the categories nor the table cover), so `local<U+1806>host` is `localhost` for the matcher and the action is not clean.
An ALLOW rule keeps reading the exact text: with only `allow curl *127.0.0.1*`, the U+3002 and U+FF61 spellings are asked about, never allowed. (U+FF0E is the exception that proves it: NFKC makes it the plain dot in the text of EVERY branch, so that
spelling IS the text `127.0.0.1` and an allow rule reads it as it reads the plain one.) Decided as it is (A-207): for the engine U+FF0E IS the text 127.0.0.1, and libidn2 reads it as a dot and goes to the destination the person allowed;
U+3002 and U+FF61 are mapped only by the resolver, so a permission keeps the exact text and asks, and a block catches the three.

Every invariant runs on the real `backend.rules` and goes red on variants with one deliberate defect."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the rules')

import backend.rules as real  # noqa: E402

D3002, DFF61, DFF0E, H1806 = chr(0x3002), chr(0xFF61), chr(0xFF0E), chr(0x1806)
# RFC 3454 B.1, "commonly mapped to nothing" (IDNA 2003): the matcher drops every one of them
B1 = [0x00AD, 0x034F, 0x1806, 0x180B, 0x180C, 0x180D, 0x200B, 0x200C, 0x200D, 0x2060, *range(0xFE00, 0xFE10), 0xFEFF]


def dotted(dot, host='127.0.0.1'):
    return host.replace('.', dot)


def winner(m, rules, command):
    decision, _ordered = m._evaluate_full(rules, m.Action(bot='vendas', tool='terminal', command=command))
    return decision.winner


def blocked(m, level, pattern, command):
    rules = [tp.rule(m, 'b', level, tools=('terminal',), commands=(pattern,)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]
    return winner(m, rules, command) == 'b'


def inv_the_ideographic_stops_are_a_dot_in_the_host_of_a_destination(m):
    forms = {
        f'curl http://{dotted(D3002)}/': 'curl http://127.0.0.1/', f'curl http://{dotted(DFF61)}/': 'curl http://127.0.0.1/', f'curl http://127{D3002}0.0{DFF61}1/': 'curl http://127.0.0.1/',
        f'curl http://{dotted(D3002, "0x7f.0.0.1")}:80/x': 'curl http://127.0.0.1/x', f'curl http://{dotted(D3002, "127.1")}/': 'curl http://127.0.0.1/', f'curl http://2130706433{D3002}/x': 'curl http://127.0.0.1/x',
        f'curl http://example{D3002}com{D3002}/x': 'curl http://example.com/x', f'curl http://user@{dotted(D3002, "127.0.0.1")}/': 'curl http://127.0.0.1/',
        f'curl http://127{D3002}0{D3002}0{D3002}%31/': 'curl http://127.0.0.1/',          # the stops are read BEFORE the percent decoding, which needs a host name and not an address with a stop in it
        f'curl http://{dotted(D3002, "127.0.0.256")}/': 'curl http://127.0.0.256/',        # not an address: the dots are dots, the host is still not an IPv4
    }
    for before, after in forms.items():
        assert m._canon_authorities(before) == after, before
    assert m._canon_authorities(f'curl http://{dotted(D3002)}/', glob=True) == 'curl http://127.0.0.1/'          # and in a pattern that writes the destination
    assert m._destination_forms(f'curl http://{dotted(D3002)}/*') == (f'curl http://{dotted(D3002)}/*', 'curl http://127.0.0.1/*')


def inv_a_stop_outside_the_host_of_a_url_is_left_alone(m):
    for text in (f'curl example{D3002}com', f'echo a{D3002}b', f'curl http://example.com/a{D3002}b', f'curl http://example.com/?q={dotted(D3002)}', f'curl http://example.com/#{dotted(D3002)}',
                 f'curl -d {dotted(D3002)} http://example.com/', f'curl {dotted(D3002)}:8080', f'curl http://example.com:80{D3002}/x'.replace(f'80{D3002}', '8080')):
        assert m._canon_authorities(text) == text, text
    assert not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', f'curl http://example.com/?q={dotted(D3002)}')              # the same through the engine
    assert not blocked(m, m.Level.BLOCK, 'curl *example.com*', f'curl example{D3002}com')                                 # no scheme: not read (the limit of R-16)


def inv_a_block_ask_or_handback_holds_for_the_idna_spellings(m):
    for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
        for host in (dotted(D3002), dotted(DFF61), dotted(DFF0E), f'127{D3002}0.0{DFF61}1', dotted(D3002, '127.1'), dotted(D3002, '0x7f.0.0.1'), f'2130706433{D3002}'):
            assert blocked(m, level, 'curl *127.0.0.1*', f'curl http://{host}/'), (level, host)                          # with `allow curl *` wider: the rule that matches more wins
            assert blocked(m, level, 'curl *127.0.0.1/*', f'curl http://{host}:80/x'), (level, host)
        assert blocked(m, level, 'curl *example.com/*', f'curl http://example{D3002}com/x'), level
        for command in (f'curl http://local{H1806}host/', f'curl http://local{H1806}host:8080/x', f'sh -c "curl http://local{H1806}host/"'):
            assert blocked(m, level, 'curl *localhost*', command), (level, command)
            assert blocked(m, level, 'curl *localhost*', command.replace(':8080', '')), (level, command)
        assert blocked(m, level, 'curl *localhost/*', f'curl http://local{H1806}host/x'), level
    assert not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', f'curl http://{dotted(D3002, "127.0.0.2")}/') and not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', f'curl http://{dotted(D3002, "128.0.0.1")}/')    # another address is another address


def inv_an_allow_rule_matches_the_exact_text(m):
    allow = [tp.rule(m, 'a', m.Level.ALLOW, tools=('terminal',), commands=('curl *127.0.0.1*',))]
    assert winner(m, allow, 'curl http://127.0.0.1/') == 'a'
    for host in (dotted(D3002), dotted(DFF61), f'127{D3002}0.0{DFF61}1', dotted(D3002, '127.1')):
        assert winner(m, allow, f'curl http://{host}/') is None, host                                                    # asked about, never allowed
    assert winner(m, allow, f'curl http://{dotted(DFF0E)}/') == 'a'                                                      # NFKC made it the plain text before any rule read it
    hidden = [tp.rule(m, 'h', m.Level.ALLOW, tools=('terminal',), commands=('curl *localhost*',))]
    decision, _ordered = m._evaluate_full(hidden, m.Action(bot='vendas', tool='terminal', command=f'curl http://local{H1806}host/'))
    assert decision.winner is None and decision.reason is m.ReasonCode.NONCANONICAL_ACTION                               # a character that is erased makes the action not clean
    spelled = [tp.rule(m, 's', m.Level.ALLOW, tools=('terminal',), commands=(f'curl http://{dotted(D3002)}/*',))]
    assert winner(m, spelled, f'curl http://{dotted(D3002)}/x') == 's' and winner(m, spelled, 'curl http://127.0.0.1/x') is None   # the pattern of an allow rule is not canonicalized either


def inv_u1806_is_dropped_like_the_rest_of_rfc_3454_b1(m):
    for code in B1:
        assert m._invisible(chr(code)), hex(code)
    assert m._command_text(f'local{H1806}host') == ('localhost', False) and m._command_text('localhost') == ('localhost', True)
    problems = m.validate_rule(tp.rule(m, 'r', m.Level.BLOCK, tools=('terminal',), commands=(f'curl *local{H1806}host*',)))
    assert [p.code for p in problems] == ['bad_glob'], problems                                                          # a pattern that holds it is refused like any other hidden character
    assert m.canon_name(f'te{H1806}rminal') == ('terminal', False)


def inv_the_hook_decides_as_the_engine_does(m):
    def table(pattern):
        return m.compile_hook_table([tp.rule(m, 'b', m.Level.BLOCK, tools=(), commands=(pattern,))], version=1, toolset_tools={}, mcp_server_tools={})
    block = table('curl *127.0.0.1*')
    for host in (dotted(D3002), dotted(DFF61), dotted(DFF0E), dotted(D3002, '127.1')):
        assert m.hook_verdict(block, tool='terminal', command=f'curl http://{host}/').action == 'block', host
    assert m.hook_verdict(block, tool='terminal', command=f'curl http://{dotted(D3002, "127.0.0.2")}/').action == 'none'
    hidden = table('curl *localhost*')
    assert m.hook_verdict(hidden, tool='terminal', command=f'curl http://local{H1806}host/').action == 'block'
    verdict = m.hook_verdict(hidden, tool='terminal', command=f'echo local{H1806}host')
    assert verdict.action == 'approve' and verdict.message == 'luvebot:noncanonical'                                     # no entry matches, and the action is not clean
    spelled = table(f'curl http://{dotted(D3002)}/*')
    assert 'curl http://127.0.0.1/*' in spelled.entries[0].commands and m.hook_verdict(spelled, tool='terminal', command='curl http://127.0.0.1/x').action == 'block'     # both forms of the pattern are in the table


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
S, O, B, A, U, H = tuple(INVARIANTS)

HOST = '    host = _host_name(found.group("host").translate(_IDEOGRAPHIC_STOPS)).rstrip(".")'
STOPS = '_IDEOGRAPHIC_STOPS = {0x3002: ".", 0xFF61: "."}'
MUTATIONS = [
    (S, 'the stops are not read', HOST, '    host = _host_name(found.group("host")).rstrip(".")'),
    (B, 'the stops are not read', HOST, '    host = _host_name(found.group("host")).rstrip(".")'),
    (H, 'the stops are not read', HOST, '    host = _host_name(found.group("host")).rstrip(".")'),
    (S, 'only U+3002 is read', STOPS, '_IDEOGRAPHIC_STOPS = {0x3002: "."}'),
    (S, 'only U+FF61 is read', STOPS, '_IDEOGRAPHIC_STOPS = {0xFF61: "."}'),
    (S, 'the stops are read after the percent decoding', HOST, '    host = _host_name(found.group("host")).translate(_IDEOGRAPHIC_STOPS).rstrip(".")'),
    (S, 'a stop is a hyphen', STOPS, '_IDEOGRAPHIC_STOPS = {0x3002: "-", 0xFF61: "-"}'),
    (O, 'the stops are read in the whole text', '    return (_AUTHORITY_OF_A_PATTERN if glob else _AUTHORITY).sub(_canon_authority, text)',
     '    return (_AUTHORITY_OF_A_PATTERN if glob else _AUTHORITY).sub(_canon_authority, text.translate(_IDEOGRAPHIC_STOPS))'),
    (A, 'the allow branch reads the canonical authority', '        if not any(glob_match(pat, segment) for pat in pats):', '        if not any(glob_match(pat, _canon_authorities(segment)) for pat in pats):'),
    (A, 'the stops are read in the whole action', '    folded, simple = _fold_plain(raw[:MAX_COMMAND])', '    folded, simple = _fold_plain(raw[:MAX_COMMAND])\n    folded = folded.translate(_IDEOGRAPHIC_STOPS)'),
    (U, 'U+1806 is not dropped', ' or code in _ERASED_BY_IDNA', ''),
    (B, 'U+1806 is not dropped', ' or code in _ERASED_BY_IDNA', ''),
    (H, 'U+1806 is not dropped', ' or code in _ERASED_BY_IDNA', ''),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


def test_the_premises_the_python_codec_reads_a_host_the_same_way():
    assert f'127{D3002}0{D3002}0{D3002}1'.encode('idna') == b'127.0.0.1' and f'127{DFF61}0{DFF61}0{DFF61}1'.encode('idna') == b'127.0.0.1'
    assert f'local{H1806}host'.encode('idna') == b'localhost'                                                              # the codec erases it: a command may be a Python one-liner
    assert [c for c in B1 if f'a{chr(c)}b'.encode('idna') != b'ab'] == []                                                  # and RFC 3454 B.1 is the list the matcher drops


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)
