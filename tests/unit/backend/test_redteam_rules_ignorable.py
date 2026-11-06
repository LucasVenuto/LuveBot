"""Red team (Lume, 31/10) of R-4 (A-196): "a field the matcher drops characters from refuses them, so a pattern that holds one could never match" and "the matcher drops the invisible characters of the action, so a rule
written for the plain name still hits". The matcher decides what is invisible BY UNICODE CATEGORY (`_INVISIBLE`: Cc, Cf, Cs, Co, Cn, Zl, Zp). The characters that a RESOLVER deletes from a host name are not that set.

HELD (plain, the harness's control): a Cf character (a zero-width space, a soft hyphen) inserted in the host of a command is dropped by the matcher, so `block curl *localhost*` still blocks it.

FIXED IN R-5 (A-198; the two tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_invisible_table.py) F-R4-1 (Media): U+034F (COMBINING GRAPHEME JOINER), U+180B to U+180D (the Mongolian free variation selectors) and U+FE00 to U+FE0F (the variation selectors) are `Mn`, so they are NOT dropped, and they are exactly
what IDNA mapping deletes from a host name (RFC 3454 table B.1 for IDNA2003, UTS 46 "ignored"). Measured on this machine: `curl http://local<U+034F>host:1/`, `local<U+FE0F>host` and `local<U+180B>host` reach localhost (curl error 7, "could not connect"; a
control host that does not exist, with the same character, is error 6, "could not resolve"), so the system resolver deleted the character; and Python's `'ev\\u034fil.test'.encode('idna')` is `evil.test`. The engine decides `ALLOW` (the broad `curl *` rule) for the command, not
`BLOCK`: a block, ask or handback rule on a DESTINATION is silently bypassed by one invisible character, and the action is judged clean, so it is not even asked about. A pattern that holds one of them is also ACCEPTED (nothing refuses it), and the person
cannot read it. Reference fix: one `_invisible(c)` (the category set plus an explicit set of the default-ignorable code points the category misses) used by every drop and by the pattern check (the same rule A-196 states).
NOT CLAIMED: the ideographic full stop U+3002 (IDNA maps it to a dot; this machine's curl did not) and the Hangul fillers (IDNA refuses them: no resolver evasion); both are in the report."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the path rules')

import backend.rules as real  # noqa: E402

ZWSP, SHY, WJ, BOM = chr(0x200B), chr(0x00AD), chr(0x2060), chr(0xFEFF)
IGNORED_BY_IDNA = [0x034F, 0x180B, 0x180C, 0x180D, 0xFE00, 0xFE01, 0xFE0E, 0xFE0F]       # category Mn: deleted from a host name by IDNA mapping


def rules(m):
    return [tp.rule(m, 'net', m.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]


def winner(m, command):
    decision, _ordered = m._evaluate_full(rules(m), m.Action(bot='vendas', tool='terminal', command=command))
    return decision.winner


def test_control_the_plain_command_and_the_dropped_characters_are_blocked():
    assert winner(real, 'curl http://localhost:1/') == 'net'
    for ch in (ZWSP, SHY, WJ, BOM, chr(0x1B), chr(0x00)):                                      # Cf and Cc: dropped, as A-196 says
        assert winner(real, f'curl http://local{ch}host:1/') == 'net', hex(ord(ch))
    assert winner(real, 'wget http://localhost:1/') is None or winner(real, 'wget http://localhost:1/') != 'net'          # the rule is about curl: the harness does not block everything


@pytest.mark.parametrize('cp', IGNORED_BY_IDNA, ids=lambda c: f'U+{c:04X}')
def test_a_character_the_resolver_deletes_from_a_host_does_not_bypass_a_block_on_it(cp):
    assert winner(real, f'curl http://local{chr(cp)}host:1/') == 'net', hex(cp)
    assert winner(real, f'curl http://localhost{chr(cp)}:1/') == 'net', hex(cp)                # at the end of the label too


@pytest.mark.parametrize('cp', IGNORED_BY_IDNA, ids=lambda c: f'U+{c:04X}')
def test_a_command_pattern_holding_such_a_character_is_refused(cp):
    rule = tp.rule(real, 'c', real.Level.BLOCK, tools=('terminal',), commands=(f'curl *local{chr(cp)}host*',))
    assert [p.code for p in real.validate_rule(rule)] == ['bad_glob'], hex(cp)
