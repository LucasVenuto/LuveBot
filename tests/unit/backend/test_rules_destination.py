"""R-7 (contract v0.11 section 8, A-199; the Lume's F-R4-2, Medium, and F-R4-3, Low): the engine reads the DESTINATION of every URL of an action in one canonical form.

A resolver or a URL parser treats `2130706433`, `0x7f.1`, `localhost.` and `example.com:80` as the same host that the matcher compared as different text: a block, ask or handback on a destination was bypassed by a
spelling, and the action judged clean. Now, with three limits:
1. ONLY for rules that match MORE (block, ask, handback), as ONE variant more of the action; an ALLOW rule keeps matching the EXACT text (one that allows matches less: a canonicalizer that disagreed with a real
   resolver could allow ANOTHER host).
2. The canonical form: the host without its trailing dot; an IPv4 in any form of `inet_aton` (a, a.b, a.b.c, a.b.c.d; each part decimal, `0` octal or `0x` hex, the last part filling the rest; a part out of range, `08`
   or five parts are NOT an address and stay as they are) as dotted decimal; the port off when it is the default of the scheme (http 80, https 443: `http://h:443` keeps its port); the user info off. The PATTERN that spells
   a destination literally (an IPv4 literal anywhere, and an authority after `://` with no `*` or `?`) gets the same form NEXT TO the original, never instead of it. Pure: no socket.
3. NOT read, and not claimed: IPv6 (`[::1]`, `[::ffff:127.0.0.1]`), `0.0.0.0` (another address), a destination with no scheme (`curl 127.1:8080`) and a name that resolves to the address (threat model R-16).

Every invariant runs on the real `backend.rules` and goes red on variants with one deliberate defect."""
from __future__ import annotations

import socket
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the rules')

import backend.rules as real  # noqa: E402

LOOPBACK = ['127.1', '127.0.1', '2130706433', '0x7f000001', '017700000001', '0177.0.0.1', '0x7f.0.0.1', '0x7f.1', '127.000.000.001']
METADATA = ['2852039166', '0xa9fea9fe', '025177524776', '169.254.43518']
NOT_AN_ADDRESS = ['08', '09.1.1.1', '0x', '0xg', '1.2.3.4.5', '1.2.3.4.0', '256.1.1.1', '1.2.3.256', '1.2.65536', '1.16777216', '4294967296', '99999999999', '', 'a.b.c.d', '1..2']


def winner(m, rules, command):
    decision, _ordered = m._evaluate_full(rules, m.Action(bot='vendas', tool='terminal', command=command))
    return decision.winner


def blocked(m, level, pattern, command):
    rules = [tp.rule(m, 'b', level, tools=('terminal',), commands=(pattern,)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]
    return winner(m, rules, command) == 'b'


def inv_the_address_is_read_the_way_libc_reads_it(m):
    for spelling in LOOPBACK:
        assert m._inet_aton(spelling) == '127.0.0.1' == socket.inet_ntoa(socket.inet_aton(spelling)), spelling       # the premise: this machine's libc reads them the same
    for spelling in METADATA:
        assert m._inet_aton(spelling) == '169.254.169.254' == socket.inet_ntoa(socket.inet_aton(spelling)), spelling
    assert m._inet_aton('1.2.3') == '1.2.0.3' and m._inet_aton('1.2') == '1.0.0.2' and m._inet_aton('0') == '0.0.0.0' and m._inet_aton('255.255.255.255') == '255.255.255.255'      # the last part fills the rest
    assert m._inet_aton('1.2.256') == '1.2.1.0' and m._inet_aton('1.65536') == '1.1.0.0' and m._inet_aton('16777216') == '1.0.0.0'                                         # ...so 256 fits where two bytes are left
    assert m._inet_aton('0x0a.010.0b1.1') is None and m._inet_aton('010.010.010.010') == '8.8.8.8' and m._inet_aton('0377.0xff.255.0') == '255.255.255.0'
    for spelling in NOT_AN_ADDRESS:
        assert m._inet_aton(spelling) is None, spelling                                                                  # not an address: it stays as it is


def inv_the_authority_of_an_action_is_one_form(m):
    forms = {
        'curl http://2130706433:1/x': 'curl http://127.0.0.1:1/x', 'curl http://0x7f.1/': 'curl http://127.0.0.1/', 'curl http://017700000001/': 'curl http://127.0.0.1/', 'curl http://127.000.000.001/': 'curl http://127.0.0.1/',
        'curl http://example.com./x': 'curl http://example.com/x', 'curl http://localhost./': 'curl http://localhost/', 'curl http://example.com:/x': 'curl http://example.com/x',
        'curl http://example.com:80/x': 'curl http://example.com/x', 'curl https://example.com:443/x': 'curl https://example.com/x', 'curl http://2130706433:80/': 'curl http://127.0.0.1/',
        'curl http://example.com:080/x': 'curl http://example.com/x', 'curl http://user:pw@example.com/x': 'curl http://example.com/x', 'curl http://user@127.1:80?q=1': 'curl http://127.0.0.1/?q=1',
        'curl http://example.com#frag': 'curl http://example.com/#frag', 'curl http://example.com': 'curl http://example.com/', 'curl https://example.com -o out': 'curl https://example.com/ -o out',
        'curl http://example.com?x=1': 'curl http://example.com/?x=1', 'curl http://example.com:80': 'curl http://example.com/', 'curl http://2130706433': 'curl http://127.0.0.1/',          # no path: the `/` is there
        'curl http://example.com:0080/x': 'curl http://example.com/x', 'curl https://example.com:00443/x': 'curl https://example.com/x', 'curl http://example.com:00080': 'curl http://example.com/',  # the default port with zeros
        'curl http://example.com:000080/x': 'curl http://example.com/x', 'curl https://example.com:0000443/x': 'curl https://example.com/x', 'curl http://example.com:0000000000000080': 'curl http://example.com/',   # ...six digits and more: curl reads them as 80 and 443
        'curl http://local%68ost:1/': 'curl http://localhost:1/', 'curl http://%6c%6f%63%61%6c%68%6f%73%74/': 'curl http://localhost/', 'curl http://%31%32%37.0.0.1/': 'curl http://127.0.0.1/',
        'curl http://127.0.0.%31/': 'curl http://127.0.0.1/', 'curl http://exampl%65.com/x': 'curl http://example.com/x', 'curl http://EXAMPL%45.COM/x': 'curl http://example.com/x', 'curl http://exampl%65.com./x': 'curl http://example.com/x', 'curl "http://example.com./x" && curl ftp://127.1/': 'curl "http://example.com/x" && curl ftp://127.0.0.1/',
        'curl http://a@b@127.0.0.1/': 'curl http://127.0.0.1/', 'curl http://a:p@b@localhost:80/': 'curl http://localhost/', 'curl http://a@b@c@2130706433:1/x': 'curl http://127.0.0.1:1/x',   # the user info runs to the LAST @ (A-202)
        'curl http://a%40b@127.0.0.1/': 'curl http://127.0.0.1/', 'curl http://a@b@example.com./x': 'curl http://example.com/x', 'curl http://example.com?a@b': 'curl http://example.com/?a@b', 'curl http://example.com#a@b': 'curl http://example.com/#a@b',
        'curl 1.http://127.1:80/p': 'curl 1.http://127.0.0.1/p', 'curl ' + 'x' * 40 + 'http://127.1:80/p': 'curl ' + 'x' * 40 + 'http://127.0.0.1:80/p',        # a scheme is read from the first letter; a run longer than 32 keeps its text before, and `xxxhttp` is not `http`, so its :80 stays
    }
    for before, after in forms.items():
        assert m._canon_authorities(before) == after, before
    assert m._canon_authorities('curl http://example.com:' + '0' * 5000 + '80/x') == 'curl http://example.com/x'                  # no limit of digits: the port is never made an int
    keeps = ['curl http://a%2fb.com/x', 'curl http://a%40b.com/x', 'curl http://a%3ab.com/x', 'curl http://a%20b.com/x', 'curl http://a%00b.com/x', 'curl http://a%2541.com/x', 'curl http://a%zzb.com/x', 'curl http://a%.com/x', 'curl http://a%e2%82%acb.com/x',
             'curl http://example.com:443/x', 'curl https://example.com:80/x', 'curl http://h:8080/', 'curl https://h:8443/', 'curl http://example.com:0/x', 'curl http://example.com:00/x', 'curl http://example.com:000081/x', 'curl https://example.com:000080/x', 'curl http://example.com:0000443/x', 'curl http://example.com:' + '0' * 5000 + '81/x', 'curl ftp://h:21/', 'curl http://256.1.1.1/', 'curl http://08.1.1.1/',          # the other schemes and other ports keep the port
             'curl http://1.2.3.4.5/', 'curl http://1.2.3.256/', 'curl http://[::1]/', 'curl http://[::1]:8080/', 'curl http://[::ffff:127.0.0.1]/', 'curl http://0.0.0.0/', 'curl 127.1:8080',      # NOT read and not claimed (limit 3)
             'curl http://127.0.0.1/', 'curl http://example.com/', 'echo 2130706433', 'curl http://www.2130706433.nip.io/',
             'curl http://a%40127.0.0.1/', 'curl http://x%402130706433/', 'curl http://example.com/x@y', 'curl http://example.com/a@b@c']          # a percent-encoded @ is not an @; an @ after the path is not user info
    for text in keeps:
        assert m._canon_authorities(text) == text, text


def inv_a_pattern_that_spells_a_destination_gets_the_same_form_next_to_its_own(m):
    assert m._destination_forms('curl *2130706433*') == ('curl *2130706433*', 'curl *127.0.0.1*')
    assert m._destination_forms('curl *0x7f.1*') == ('curl *0x7f.1*', 'curl *127.0.0.1*') and m._destination_forms('curl *127.0.0.1*') == ('curl *127.0.0.1*',)
    assert m._destination_forms('curl http://127.1:80/x') == ('curl http://127.1:80/x', 'curl http://127.0.0.1/x')
    assert m._destination_forms('curl *//example.com./x*') == ('curl *//example.com./x*',)                                # no `://` and a wildcard: not an authority
    assert m._destination_forms('curl http://127.*/x') == ('curl http://127.*/x',) and m._destination_forms('curl http://exam?le.com./x') == ('curl http://exam?le.com./x',)    # a wildcard in the authority: left alone
    for text in ('curl *www.2130706433*', 'curl *v1.5*', 'curl *10.0.0.1.nip.io*', 'curl *2130706433.nip.io*', 'curl *0x7f000001.example.com*', 'curl *:2130706433*', 'curl *a-2130706433*', 'curl *h.0x7f.1*', 'curl *x127.1*',
                 'curl *256.1.1.1*', 'curl *08*'):
        assert m._destination_forms(text) == (text,), text                                                                # a piece of a name is not an address
    assert m._destination_forms('curl http://example.com?x=1') == ('curl http://example.com?x=1',) and m._destination_forms('curl http://exam?le.com/x') == ('curl http://exam?le.com/x',)      # `?` in a pattern is a wildcard
    assert m._destination_forms('curl http://example.com') == ('curl http://example.com', 'curl http://example.com/') and m._destination_forms('curl *1234*') == ('curl *1234*',) and m._destination_forms('curl *:8080/x*') == ('curl *:8080/x*',) and m._destination_forms('curl *80*') == ('curl *80*',)      # a port or an id is not an address
    assert m._destination_forms('curl *0x7f000001*') == ('curl *0x7f000001*', 'curl *127.0.0.1*') and m._destination_forms('curl *1.5*') == ('curl *1.5*', 'curl *1.0.0.5*')   # the original is ALWAYS kept: the canonical form only ADDS
    assert m._destination_forms('curl http://a@b@127.0.0.1/*') == ('curl http://a@b@127.0.0.1/*', 'curl http://127.0.0.1/*') and m._destination_forms('curl http://a@b@2130706433/*') == ('curl http://a@b@2130706433/*', 'curl http://127.0.0.1/*')   # the user info of a pattern runs to the last @ too (A-202)


def inv_a_block_ask_or_handback_on_a_destination_holds_for_every_spelling(m):
    for level in (m.Level.BLOCK, m.Level.ASK, m.Level.HANDBACK):
        for spelling in LOOPBACK:
            assert blocked(m, level, 'curl *127.0.0.1*', f'curl http://{spelling}:1/'), (level, spelling)
        for spelling in METADATA:
            assert blocked(m, level, 'curl *169.254.169.254*', f'curl http://{spelling}/latest/meta-data/'), (level, spelling)
        assert blocked(m, level, 'curl *2130706433*', 'curl http://127.0.0.1/') and blocked(m, level, 'curl *0x7f000001*', 'curl http://127.1/')     # a pattern spelled numerically catches the dotted form too
        for pattern in ('curl *example.com/*', 'curl *//example.com/*'):
            for command in ('curl http://example.com./x', 'curl http://example.com:80/x', 'curl https://example.com:443/x', 'curl https://EXAMPLE.COM.:443/x', 'curl http://user:pw@example.com./x'):
                assert blocked(m, level, pattern, command), (level, pattern, command)
        for pattern, command in (('curl *127.0.0.1*', 'curl http://a@b@2130706433/x'), ('curl *127.0.0.1*', 'curl http://a:b@c@0x7f000001:1/'), ('curl *localhost/*', 'curl http://a:p@b@localhost:80/x'),
                                 ('curl *example.com/*', 'curl http://a@b@example.com:80/x'), ('curl *example.com/*', 'curl http://a@b@example.com./x')):
            assert blocked(m, level, pattern, command), (level, pattern, command)                                          # the user info runs to the LAST @: a client that reads it so reaches the host (A-202)
        assert blocked(m, level, 'curl *127.0.0.1*', 'sh -c "curl http://2130706433/"'), level                                  # inside a nested command as well
    assert not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', 'curl http://x%402130706433/')                                 # %40 is not an @: the host stays what it is written
    assert not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', 'curl http://127.0.0.2/') and not blocked(m, m.Level.BLOCK, 'curl *example.com/*', 'curl http://example.org/x')     # not a block on everything
    assert not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', 'curl http://256.1.1.1/') and not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', 'curl http://08.1.1.1/')       # out of range: not an address
    assert blocked(m, m.Level.BLOCK, 'curl *example.com:80/*', 'curl http://example.com:80/x')                              # a rule that names the default port still finds it where it is written
    assert not blocked(m, m.Level.BLOCK, 'curl *example.com:443/*', 'curl http://example.com:443x/x') and blocked(m, m.Level.BLOCK, 'curl *example.com:443/*', 'curl http://example.com:443/x')   # http://h:443 keeps its port
    for spelling in ('curl http://[::1]:1/', 'curl http://0.0.0.0/', 'curl 127.1:8080'):                                       # limit 3: not read, and the rule does not claim them (`[::ffff:127.0.0.1]` holds the text and was blocked before)
        assert not blocked(m, m.Level.BLOCK, 'curl *127.0.0.1*', spelling), spelling


def inv_an_allow_rule_matches_the_exact_text(m):
    allow = [tp.rule(m, 'a', m.Level.ALLOW, tools=('terminal',), commands=('curl *127.0.0.1*',))]
    assert winner(m, allow, 'curl http://127.0.0.1/') == 'a'                                                                # the plain spelling is allowed
    for spelling in ('2130706433', '0x7f000001', '127.1', '0177.0.0.1'):
        assert winner(m, allow, f'curl http://{spelling}/') is None, spelling                                               # a spelling is NOT allowed: no rule wins, Hermes asks
    numeric = [tp.rule(m, 'n', m.Level.ALLOW, tools=('terminal',), commands=('curl *2130706433*',))]
    assert winner(m, numeric, 'curl http://127.0.0.1/') is None and winner(m, numeric, 'curl http://2130706433/') == 'n'      # the pattern of an allow rule is not canonicalized either
    port = [tp.rule(m, 'p', m.Level.ALLOW, tools=('terminal',), commands=('curl http://example.com/*',))]
    assert winner(m, port, 'curl http://example.com/x') == 'p' and winner(m, port, 'curl http://example.com:80/x') is None and winner(m, port, 'curl http://example.com./x') is None
    assert winner(m, allow, 'curl http://a@b@2130706433/x') is None                                                          # many @ and a numeric spelling: asked about, not allowed (A-202)
    many = [tp.rule(m, 'm', m.Level.ALLOW, tools=('terminal',), commands=('curl http://a@b@127.0.0.1/*',))]
    assert winner(m, many, 'curl http://a@b@127.0.0.1/x') == 'm' and winner(m, many, 'curl http://127.0.0.1/x') is None       # the pattern of an allow rule is not canonicalized either


def inv_the_hook_decides_as_the_engine_does(m):
    def table(level, pattern):
        return m.compile_hook_table([tp.rule(m, 'b', level, tools=(), commands=(pattern,))], version=1, toolset_tools={}, mcp_server_tools={})
    block = table(m.Level.BLOCK, 'curl *2130706433*')
    assert 'curl *127.0.0.1*' in block.entries[0].commands and 'curl *2130706433*' in block.entries[0].commands            # both forms of the pattern are in the table the hook reads
    for command in ('curl http://127.1/', 'curl http://2130706433/', 'curl http://0x7f.0.0.1/', 'curl http://127.0.0.1/'):
        assert m.hook_verdict(block, tool='terminal', command=command).action == 'block', command
    many = table(m.Level.BLOCK, 'curl http://a@b@2130706433/*')
    assert 'curl http://127.0.0.1/*' in many.entries[0].commands                                                            # the pattern with many @ is in the table in both forms
    for command in ('curl http://c@d@127.1/x', 'curl http://a:p@b@0x7f.1:80/x'):
        assert m.hook_verdict(many, tool='terminal', command=command).action == 'block', command
    assert m.hook_verdict(block, tool='terminal', command='curl http://127.0.0.2/').action == 'none'
    ask = table(m.Level.ASK, 'curl *example.com/*')
    for command in ('curl http://example.com./x', 'curl http://example.com:80/x', 'curl https://example.com:443/x'):
        assert m.hook_verdict(ask, tool='terminal', command=command).action == 'approve', command
    assert m.hook_verdict(table(m.Level.BLOCK, 'curl *example.com*'), tool='terminal', command='curl http://example.org/').action == 'none'


def inv_a_long_run_of_lowercase_text_costs_milliseconds_not_seconds(m):
    """A scheme is at most 32 characters, so the scan from each start is constant: without the bound a command of 16 KiB with a run of hex or base64 cost 0.35 to 0.9 s (a hundred times more), and the hook runs for every call."""
    for blob in ('x' * 30000, ('0123456789abcdef' * 2000)[:30000], 'a1+' * 10000):
        started = time.perf_counter()
        m._canon_authorities('curl -d ' + blob)
        assert time.perf_counter() - started < 0.5, blob[:12]
    assert m._canon_authorities('curl http://example.com:80/' + 'x' * 30000) == 'curl http://example.com/' + 'x' * 30000          # and the text is the same
    assert m._canon_authorities('curl ' + 'a' * 32 + '://127.1:80/p') == 'curl ' + 'a' * 32 + '://127.0.0.1:80/p'                   # a scheme of 32 characters is read (and 80 is not its default)


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
A, U, P, B, L, H, C = tuple(INVARIANTS)
MUTATIONS = [
    (A, 'the octal is read as decimal', 'int(x, 8) if len(x) > 1 and x.startswith("0") else int(x, 10) for x in parts]', 'int(x, 10) for x in parts]'),
    (A, 'the hex is read as decimal', 'int(x, 16) if x.startswith("0x") else', 'int(x, 10) if x.startswith("0x") else'),
    (A, 'the last part does not fill the rest', 'nums[-1] >= 256 ** (5 - len(nums))', 'nums[-1] >= 256'),
    (A, 'the last part overflows into the address', 'or nums[-1] >= 256 ** (5 - len(nums)):', ':'),
    (A, 'a part out of range is an address', 'if any(n > 255 for n in nums[:-1]) or', 'if'),
    (A, 'five parts are an address', 'if not 1 <= len(parts) <= 4:', 'if not 1 <= len(parts) <= 5:'),
    (A, 'the value is built little endian', 'for shift in (24, 16, 8, 0))', 'for shift in (0, 8, 16, 24))'),
    (U, 'the default port of http is 443', '_DEFAULT_PORT = {"http": 80, "https": 443}', '_DEFAULT_PORT = {"http": 443, "https": 443}'),
    (U, 'the default port of https is 80', '_DEFAULT_PORT = {"http": 80, "https": 443}', '_DEFAULT_PORT = {"http": 80, "https": 80}'),
    (U, 'every scheme has default ports', '_DEFAULT_PORT = {"http": 80, "https": 443}', '_DEFAULT_PORT = {"http": 80, "https": 443, "ftp": 21}'),
    (U, 'the user info goes back to one @', r'://(?:[^/?#\s]*@)?', r'://(?:[^/@?#\s]*@)?'),
    (U, 'a percent-encoded @ ends the user info', r'://(?:[^/?#\s]*@)?', r'://(?:[^/?#\s]*(?:@|%40))?'),
    (P, 'the pattern goes back to one @', r'"(?P<next>[/#\\s]|$)"))', r'"(?P<next>[/#\\s]|$)").replace("(?:[^/?#\\s]*@)?", "(?:[^/@?#\\s]*@)?"))'),
    (C, 'the scheme has no length bound', '{0,31})://', '*)://'),
    (U, 'a scheme is at most 4 characters', '{0,31})://', '{0,3})://'),
    (U, 'any port is a default one', 'keep = bool(port) and port.lstrip("0") != str(_DEFAULT_PORT.get(scheme))', 'keep = False'),
    (U, 'the port is never dropped', 'keep = bool(port) and port.lstrip("0") != str(_DEFAULT_PORT.get(scheme))', 'keep = bool(port)'),
    (U, 'the port is a number of at most five digits', 'keep = bool(port) and port.lstrip("0") != str(_DEFAULT_PORT.get(scheme))', 'keep = bool(port) and not (len(port) <= 5 and int(port) == _DEFAULT_PORT.get(scheme))'),
    (U, 'the port is an int with no limit of digits', 'keep = bool(port) and port.lstrip("0") != str(_DEFAULT_PORT.get(scheme))', 'keep = bool(port) and int(port) != _DEFAULT_PORT.get(scheme)'),
    (U, 'a port of zeros is the default one', 'keep = bool(port) and port.lstrip("0") != str(_DEFAULT_PORT.get(scheme))', 'keep = bool(port) and port.lstrip("0") not in (str(_DEFAULT_PORT.get(scheme)), "")'),
    (U, 'the trailing dot stays', '    host = _host_name(found.group("host").translate(_IDEOGRAPHIC_STOPS)).rstrip(".")', '    host = _host_name(found.group("host").translate(_IDEOGRAPHIC_STOPS))'),
    (U, 'the user info stays', '    return f"{scheme}://{host}" + (f":{port}" if keep else "")', '    return f"{scheme}://{found.group(0).partition(\'://\')[2].partition(host)[0]}{host}" + (f":{port}" if keep else "")'),
    (U, 'a percent-encoded host is not decoded', '    host = _host_name(found.group("host").translate(_IDEOGRAPHIC_STOPS)).rstrip(".")', '    host = found.group("host").translate(_IDEOGRAPHIC_STOPS).rstrip(".")'),
    (U, 'a decoded host is not lowered', 'decoded = _PERCENT.sub(lambda found: chr(int(found.group(1), 16)), host).lower()', 'decoded = _PERCENT.sub(lambda found: chr(int(found.group(1), 16)), host)'),
    (U, 'anything that decodes is a host', 'return decoded if re.fullmatch(r"[a-z0-9.-]+", decoded) else host', 'return decoded'),
    (U, 'a host is decoded twice', 'decoded = _PERCENT.sub(lambda found: chr(int(found.group(1), 16)), host).lower()', 'decoded = _PERCENT.sub(lambda found: chr(int(found.group(1), 16)), _PERCENT.sub(lambda found: chr(int(found.group(1), 16)), host)).lower()'),
    (U, 'a URL with no path gets no slash', '+ ("" if found.group("next") == "/" else "/")', '+ ""'),
    (U, 'every URL gets a slash', '+ ("" if found.group("next") == "/" else "/")', '+ "/"'),
    (U, 'the query is not a boundary for an action', '(?::(?P<port>[0-9]*))?(?=(?P<next>[/?#\\s]|$))")\n_AUTHORITY_OF_A_PATTERN', '(?::(?P<port>[0-9]*))?(?=(?P<next>[/#\\s]|$))")\n_AUTHORITY_OF_A_PATTERN'),
    (P, 'the question mark of a pattern is a query', '(?P<next>[/#\\\\s]|$)")', '(?P<next>[/?#\\\\s]|$)")'),
    (U, 'the numeric host is not read', '    if _IPV4_FORM.fullmatch(host):\n        host = _inet_aton(host) or host', '    if False:\n        host = _inet_aton(host) or host'),
    (P, 'the pattern is not canonicalized', '    return (pattern,) if canon == pattern else (pattern, canon)', '    return (pattern,)'),
    (P, 'the pattern is replaced, not added to', '    return (pattern,) if canon == pattern else (pattern, canon)', '    return (canon,)'),
    (P, 'the IPv4 literal of a pattern is not read', '_IPV4_TOKEN.sub(_literal_address, pattern)', 'pattern'),
    (P, 'a piece of a name is an address', '(?<![0-9A-Za-z_-]\\.)', ''),
    (P, 'a name that continues is an address', '(?![0-9A-Za-z_-])(?!\\.[0-9A-Za-z_-])")', '(?![0-9A-Za-z_-])")'),
    (P, 'a port is an address', '(?<![0-9A-Za-z_:-])', '(?<![0-9A-Za-z_-])'),
    (P, 'any number is an address', '    if "." not in token and not (token.startswith("0x") or len(token) >= 8):\n        return token\n', ''),
    (B, 'the action keeps only its own spelling', 'variants = frozenset(found | {_canon_authorities(v) for v in found})', 'variants = frozenset(found)'),
    (B, 'the action keeps only the canonical spelling', 'variants = frozenset(found | {_canon_authorities(v) for v in found})', 'variants = frozenset({_canon_authorities(v) for v in found})'),
    (B, 'the match reads only the pattern as written', 'if any(glob_match(form, v) for form in _destination_forms(pat) for v in view.variants):', 'if any(glob_match(pat, v) for v in view.variants):'),
    (L, 'the allow side is canonicalized', '    for segment in view.segments:\n        if not any(glob_match(pat, segment) for pat in pats):', '    for segment in view.segments:\n        if not any(glob_match(form, _canon_authorities(segment)) for pat in pats for form in _destination_forms(pat)):'),
    (L, 'the pattern of an allow rule is canonicalized', '    for segment in view.segments:\n        if not any(glob_match(pat, segment) for pat in pats):', '    for segment in view.segments:\n        if not any(glob_match(form, segment) for pat in pats for form in _destination_forms(pat)):'),
    (L, 'the segment of an allow rule is canonicalized', '    for segment in view.segments:\n        if not any(glob_match(pat, segment) for pat in pats):', '    for segment in view.segments:\n        if not any(glob_match(pat, _canon_authorities(segment)) for pat in pats):'),
    (H, 'the table keeps only the written pattern', "commands = tuple(sorted({form for c in m.commands for form in _destination_forms(_squash(_fold(c)))}))", "commands = tuple(sorted({_squash(_fold(c)) for c in m.commands}))"),
    (H, 'the table keeps only the canonical pattern', "commands = tuple(sorted({form for c in m.commands for form in _destination_forms(_squash(_fold(c)))}))", "commands = tuple(sorted({_destination_forms(_squash(_fold(c)))[-1] for c in m.commands}))"),
]


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(name):
    INVARIANTS[name](real)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, invariant, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(Exception):  # noqa: B017  (red = the invariant noticed; any failure of the check counts)
        INVARIANTS[invariant](variant)
