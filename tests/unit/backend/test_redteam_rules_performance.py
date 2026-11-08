"""Red team (Lume, 31/10) of the COST of the destination reading of R-7 (A-199): the blind spot of my first performance test, found by the Brasa measuring.

My first payloads ("http://a@" x1800, "a://" x4000, a long host, "%41" x5300...) all MATCH a URL at the first try, so the scheme `[a-z][a-z0-9+.-]*` never had to be re-read; they said "about 11 ms, linear" and that was incomplete. A long run of lowercase letters with NO URL in it (`curl -d` and
16 KiB of letters, hex or base64 in lowercase) made the regex re-scan the scheme from EVERY letter: 350 to 915 ms per evaluation (a plain 16 KiB command costs 11 ms), and the same after a URL. The Brasa bounded the scheme to 32 characters (R-7b): 11 to 15 ms.
The cases here are the ones that matter: long runs with no URL (letters, hex, lowercase base64, letters with dots, hyphens and plus signs: every character a scheme may hold), long runs after and before a URL, many `://` with a scheme just inside and just over the limit.

The test is RELATIVE, so a loaded machine does not turn it red: the cost of each payload is compared with a plain command of the same length (best of three each), `cost <= 10 x plain + 40 ms`; the quadratic cost is 30 to 80 times the plain one. A mutation (the scheme without its bound) turns it red."""
import random
import string
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the path rules')

import backend.rules as real  # noqa: E402

SIZE = 15900


def payloads():
    rng = random.Random(7)
    letters = ''.join(rng.choice(string.ascii_lowercase) for _ in range(SIZE))
    hexa = ''.join(rng.choice('0123456789abcdef') for _ in range(SIZE))
    base64ish = ''.join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(SIZE))
    return {
        'letters with no URL': 'curl -d ' + letters,
        'hex with no URL': 'curl -d ' + hexa,
        'lowercase base64 with no URL': 'curl -d ' + base64ish,
        'dots with no URL': 'curl -d ' + 'a.' * (SIZE // 2),
        'hyphens with no URL': 'curl -d ' + 'a-' * (SIZE // 2),
        'plus signs with no URL': 'curl -d ' + 'a+' * (SIZE // 2),
        'letters after a URL': 'curl http://example.com/x -d ' + letters,
        'letters before a URL': 'curl -d ' + letters[:7000] + ' http://example.com/x',
        'many :// with a 30-letter scheme': 'curl ' + ('a' * 30 + '://x ') * 480,
        'many :// with a 40-letter scheme (over the bound)': 'curl ' + ('a' * 40 + '://x ') * 380,
        'a long number': 'curl -d ' + '1' * SIZE,
    }


def cost(m, rules, command):
    best = 1e9
    for _ in range(3):
        started = time.perf_counter()
        m._evaluate_full(rules, m.Action(bot='v', tool='terminal', command=command[:16000]))
        best = min(best, time.perf_counter() - started)
    return best * 1000


def check_no_payload_costs_much_more_than_a_plain_command_of_the_same_length(m, tmp):
    rules = [tp.rule(m, 'b', m.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',)), tp.rule(m, 'a', m.Level.ALLOW, tools=('terminal',), commands=('curl http://example.com/*',))]
    plain = cost(m, rules, 'curl -d ' + ' '.join(['abc'] * (SIZE // 4)))
    for label, command in payloads().items():
        spent = cost(m, rules, command)
        assert spent <= 10 * plain + 40, (label, round(spent, 1), 'ms against', round(plain, 1))
        assert spent < 2000, label


def test_no_payload_costs_much_more_than_a_plain_command_on_the_real_module(tmp_path):
    check_no_payload_costs_much_more_than_a_plain_command_of_the_same_length(real, tmp_path)


def test_the_scheme_without_its_bound_turns_it_red(tmp_path_factory, tmp_path):
    variant = tp.load_variant(tmp_path_factory, '[a-z0-9+.-]{0,31})://', '[a-z0-9+.-]*)://')
    with pytest.raises(AssertionError):
        check_no_payload_costs_much_more_than_a_plain_command_of_the_same_length(variant, tmp_path)
