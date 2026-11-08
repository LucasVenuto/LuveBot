"""Red team (Lume, 30/10): no raw invisible or bidi character in a SOURCE file (the "Trojan Source" class, CVE-2021-42574, and its ASCII-smuggling cousins).

A reviewer cannot see a U+202E in a string, a U+2028 in a regular expression or a Tag character in a comment, and a compiler reads them all: `if (user !== "admin<RLO>") ...` reads as another line. The product refuses these
characters in a skill a Bot drafts (contract v0.11 3.4); its own source must not hold one either. Write them as an escape (`\\u202e`, `chr(0x202e)`) so the page shows what the file does.

What is refused in a file (the dangerous class, not every invisible one: a ZWJ inside an emoji and a ZWNJ in a Persian word are text, and a non-breaking space is only a space):
  bidi embeddings, overrides and isolates (U+202A-202E, U+2066-2069), LRM, RLM, ALM (U+200E, U+200F, U+061C), the line and paragraph separators (U+2028, U+2029), ZWSP, the word joiner and the soft hyphen
  (U+200B, U+2060, U+00AD), the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the Tags block, C0 controls but TAB, LF, CR and FF, C1 controls, DEL, noncharacters, and a BOM anywhere but the first byte.

A RATCHET, not a wall, and EMPTY today: every source file is clean. An entry is a count that can only go DOWN; a file that is clean must leave the list; a file that is not on it must be clean."""
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCAN = ('backend', 'dashboard', 'scripts', 'tests', 'theme')
SUFFIXES = {'.py', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.sh', '.css', '.html', '.yaml', '.yml'}
SKIP_PARTS = {'node_modules', 'dist', '__pycache__', '.git', 'archive', 'evidence', 'ucd', 'out'}
SKIP_FILES = {'tests/data/invisible-fixture.json'}                      # data whose job is to hold such characters (and it holds them escaped, but it is the one file allowed to change that)

RANGES = [(0x00, 0x08), (0x0b, 0x0b), (0x0e, 0x1f), (0x7f, 0x9f), (0xad, 0xad), (0x61c, 0x61c), (0x115f, 0x1160), (0x200b, 0x200b), (0x200e, 0x200f), (0x2028, 0x202e), (0x2060, 0x2060),
          (0x2066, 0x2069), (0x3164, 0x3164), (0xfdd0, 0xfdef), (0xffa0, 0xffa0), (0xfffe, 0xffff), (0xe0000, 0xe007f)]
RATCHET = {}   # every source file is clean today: an entry may only be added for a file that must hold such a character, with its count, and it only ever goes down


def dangerous(text):
    count = 0
    for index, char in enumerate(text):
        code = ord(char)
        if code < 0x20 and code not in (0x09, 0x0a, 0x0d, 0x0c) or code >= 0x7f and any(a <= code <= b for a, b in RANGES) or code == 0xfeff and index > 0:
            count += 1
    return count


def files(root):
    for top in SCAN:
        base = Path(root) / top
        if not base.exists():
            continue
        for path in base.rglob('*'):
            if path.is_file() and path.suffix in SUFFIXES and not (set(path.relative_to(root).parts) & SKIP_PARTS) and path.relative_to(root).as_posix() not in SKIP_FILES:
                yield path


def offenders(root):
    found = {}
    for path in files(root):
        try:
            text = path.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        n = dangerous(text)
        if n:
            found[path.relative_to(root).as_posix()] = n
    return found


def test_no_new_raw_invisible_or_bidi_character_in_a_source_file():
    found = offenders(ROOT)
    grown = {f: (n, RATCHET.get(f, 0)) for f, n in found.items() if n > RATCHET.get(f, 0)}
    assert not grown, f'raw invisible/bidi characters in source (found, allowed): {grown}. Write each as an escape (\\u202e, chr(0x202e)) so a reviewer sees it.'


def test_a_file_that_is_clean_leaves_the_ratchet():
    found = offenders(ROOT)
    stale = sorted(f for f in RATCHET if f not in found and (ROOT / f).exists())
    assert not stale, f'clean now, remove from RATCHET: {stale}'


def test_the_detector_sees_what_it_claims_to_and_nothing_else():
    ok = ('x = "' + chr(92) + 'u202e"  # an escape is text' + chr(10) + 'snowman = ' + chr(0x2603) + ' family = ' + chr(0x1f468) + chr(0x200d) + chr(0x1f469)
          + ' persian = ' + chr(0x645) + chr(0x200c) + chr(0x62e) + ' nbsp = a' + chr(0xa0) + 'b tab' + chr(9) + 'here' + chr(13) + chr(10) + chr(12))
    assert dangerous(ok) == 0
    for code in (0x202e, 0x2066, 0x200e, 0x2028, 0x2029, 0x200b, 0x2060, 0xad, 0x3164, 0xe0041, 0x0, 0x1b, 0x7f, 0x85, 0xfdd0, 0xffff):
        assert dangerous(f'a{chr(code)}b') == 1, hex(code)
    assert dangerous(chr(0xfeff) + 'ab') == 0 and dangerous('a' + chr(0xfeff) + 'b') == 1                          # a BOM is a file's own first character, a text character anywhere else is a hidden one
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / 'backend').mkdir()
        (Path(tmp) / 'backend' / 'a.py').write_text('x = 1\n')
        (Path(tmp) / 'backend' / 'b.py').write_text(f'x = "{chr(0x202e)}"\n')
        (Path(tmp) / 'backend' / 'c.txt').write_text(f'{chr(0x202e)}')                      # not a source suffix
        assert offenders(tmp) == {'backend/b.py': 1}
