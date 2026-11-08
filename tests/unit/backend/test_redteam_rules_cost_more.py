"""Red team (Lume, 31/10) of the cost invariant of A-203 (the Brasa's tests/unit/backend/test_rules_cost.py), and of his own finding on `glob_match`.

MEASURED on Python 3.14.5 (Unicode 16.0.0), the version of the managed installs of Hermes and of the harness:
 - A-203's "characters whose fold is longer than the character (U+FDFD becomes 18)" is NOT true here: U+FDFD folds to ONE character since Unicode 16 (its NFKC mapping was dropped); on Python 3.11 to 3.13 it is 18. The character that expands most on 3.14 is U+FDFA (SALLALLAHOU ALAYHE WASALLAM): 18 characters.
   `curl -d` and 16 KiB of U+FDFA, once folded, is 288,000 characters: 235 ms per evaluation (a plain 16 KiB command: 11 ms), 94% of the BUDGET of 0.25 s of the invariant, whose own "slowest command 0.07 s" was measured with a character that does not expand: a slower machine, more rules or
   a few more characters and the invariant is red, and on 3.14 it never exercised what it says it does. The engine cuts the RAW command to MAX_COMMAND and THEN folds, so the folded text can be 18 times longer than the cap.
 - `glob_match` costs the text times the literal tail after the last `*` (the Brasa's finding, 0.65 s for a tail of 500 in 16 KiB). A-203 calls it "a hostile PATTERN, never a hostile text". Not entirely: a Bot's rule SUGGESTION (`propose_from_agent`) carries any pattern up to 512 characters, a person may activate it, and the Bot writes the text it is
   evaluated against: both halves of the product are the Bot's. ("Always allow" is safe: the draft escapes the command, so it has no `*`.)
HELD (plain): a command of 2 MiB costs what 16 KiB costs (the engine cuts it first); a pattern of 10000 characters is read in milliseconds by `_destination_forms`; and `glob_match` equals a reference translation to a regular expression on 30,000 random patterns of `a b * ? \\` against random texts, which is what a rewrite has to keep.
FIXED (the 2 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_rules_cost.py): F-A203-1 (Baixa): the folded text was not capped.
OPEN (`xfail(strict=True)`, 6 tests, kept as A-204 decided): F-A203-2 (Baixa): the glob tail.
Fix of F-A203-1 (A-203): the folded text is cut to MAX_COMMAND too (and the action is then unclean, as one over the cap already is). Model, not applied (A-204):  `glob_match` matches the pieces between the stars (the first against the start, the last against the END, the middle ones with `str.find`), which is linear in the
text for the patterns people write and equal to today's results (the differential test above)."""
import random
import re
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders of the rules')

import backend.rules as real  # noqa: E402

N = 15900


def worst_expander():
    """The character whose fold (NFKC and case) is longest on THIS Python, never a hard-coded one."""
    return max((chr(c) for c in range(0x10000) if not 0xD800 <= c < 0xE000), key=lambda ch: len(real._fold(ch)))


def cost(fn, rounds=3):
    best = 1e9
    for _ in range(rounds):
        started = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - started)
    return best * 1000


RULES = [tp.rule(real, 'b', real.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',)), tp.rule(real, 'a', real.Level.ALLOW, tools=('terminal',), commands=('curl http://example.com/*',))]


def evaluate(command):
    return cost(lambda: real._evaluate_full(RULES, real.Action(bot='v', tool='terminal', command=command)))


PLAIN = 'curl -d ' + ' '.join(['abc'] * (N // 4))


def test_control_this_python_has_a_character_that_expands_and_u_fdfd_is_one_or_eighteen():
    assert len(real._fold(worst_expander())) >= 3
    assert len(real._fold(chr(0xFDFD))) in (1, 18)                                              # 1 on Unicode 16 (Python 3.14), 18 before: a test that hard-codes U+FDFD tests nothing on 3.14


def test_a_command_of_2_MiB_costs_what_a_16_KiB_one_costs():
    plain = evaluate(PLAIN)
    for label, command in (('letters', 'curl -d ' + 'a' * (2 * 1024 * 1024)), ('words', 'curl -d ' + 'ab ' * (700 * 1024)), ('urls', 'curl ' + 'http://a@b:80/x ' * 130000)):
        assert evaluate(command) <= 10 * plain + 40, label


def test_a_pattern_of_10000_characters_is_read_in_milliseconds():
    for label, pattern in (('x', 'x' * 10000), ('schemes', 'http://' * 1400), ('digits', '1' * 10000), ('dots', 'a.' * 5000), ('percents', '%41' * 3300), ('ipv4', '1.' * 5000), ('stars', '*a' * 5000)):
        assert cost(lambda: real._destination_forms(pattern)) < 250, label


def reference(pattern, text):
    parts, i = [], 0
    while i < len(pattern):
        char = pattern[i]
        if char == '\\' and i + 1 < len(pattern):
            parts.append(re.escape(pattern[i + 1]))
            i += 2
            continue
        parts.append('.*' if char == '*' else '.' if char == '?' else re.escape(char))
        i += 1
    return re.fullmatch(''.join(parts), text, re.S) is not None


def test_glob_match_equals_a_reference_translation_on_30000_random_cases():
    rng = random.Random(11)
    for _ in range(30000):
        pattern = ''.join(rng.choice('ab*?\\') for _ in range(rng.randint(0, 9)))
        text = ''.join(rng.choice('ab') for _ in range(rng.randint(0, 9)))
        assert real.glob_match(pattern, text) is reference(pattern, text), (pattern, text)


@pytest.mark.parametrize('size', [N, 2 * 1024 * 1024], ids=['16 KiB', '2 MiB'])
def test_a_command_of_the_character_that_expands_most_costs_like_a_plain_one(size):
    # the 2 MiB case is also what keeps the mutation "the command is not cut before it is read" red once the folded text is capped (an ASCII 2 MiB command is cheap to fold, an expanding one is not)
    assert evaluate('curl -d ' + worst_expander() * size) <= 10 * evaluate(PLAIN) + 40


@pytest.mark.xfail(strict=True, reason='F-A203-2: glob_match costs the text times the literal tail after the last star')
@pytest.mark.parametrize('tail', [250, 499])
@pytest.mark.parametrize('end', ['b', '?b', 'b*b'], ids=['literal', 'with-question-mark', 'two-stars'])
def test_glob_match_with_a_long_tail_costs_like_one_with_a_short_one(tail, end):
    text = 'a' * 16000
    short = cost(lambda: real.glob_match('*' + 'a' * 5 + end, text))
    assert cost(lambda: real.glob_match('*' + 'a' * tail + end, text), 2) <= 10 * short + 40


def test_glob_match_equals_the_reference_on_longer_patterns_and_texts():
    rng = random.Random(23)
    for _ in range(6000):
        pattern = ''.join(rng.choice('abc*?*\\') for _ in range(rng.randint(0, 24)))
        text = ''.join(rng.choice('abc') for _ in range(rng.randint(0, 40)))
        assert real.glob_match(pattern, text) is reference(pattern, text), (pattern, text)
