#!/usr/bin/env python3
"""Generates backend/unicode_invisible.json: the ONE table of invisible characters that the server and the dashboard both read (contract v0.11 section 3.4).

    python3 scripts/gen_invisible_table.py            write backend/unicode_invisible.json
    python3 scripts/gen_invisible_table.py --check    exit 1 unless that file is exactly what this script makes of its input

Offline and deterministic: the input is the pinned section of the Unicode Character Database in scripts/ucd/ (its URL, version and hash are in its first lines), and the output is the same bytes on
every run. Nobody reads the Unicode property at run time: Python's `unicodedata` does not expose Default_Ignorable_Code_Point and a browser's ICU moves with every release.

The classes (the contract's table):
  refuse  fixed below: the Tags block, the variation selectors supplement, bidi embeddings and overrides, the line and paragraph separators, the C0 controls but TAB, LF and CR (DEL with them), the C1 controls,
          the noncharacters U+FDD0..U+FDEF and the last two code points of every plane (U+FFFE, U+FFFF ... U+10FFFE, U+10FFFF), and the surrogates (a lone one cannot be encoded);
  mark    every Default_Ignorable_Code_Point that refuse does not take, plus EXTRA_MARK (U+2800, U+FFF9..U+FFFB, U+13430..U+1343F), minus mark_except;
  mark_except  U+FE0E and U+FE0F, the text and emoji presentation selectors: ordinary text, not marked, not refused.
Ranges are [lo, hi] in decimal code points, sorted, merged, never overlapping."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'backend' / 'unicode_invisible.json'
REFUSE = [(0x00, 0x08), (0x0B, 0x0C), (0x0E, 0x1F), (0x7F, 0x7F), (0x80, 0x9F), (0x2028, 0x2029), (0x202A, 0x202E), (0xD800, 0xDFFF), (0xFDD0, 0xFDEF), (0xFFFE, 0xFFFF),
          (0xE0000, 0xE007F), (0xE0100, 0xE01EF)]
REFUSE += [(plane * 0x10000 + 0xFFFE, plane * 0x10000 + 0xFFFF) for plane in range(1, 17)]   # the noncharacters at the end of every other plane (U+1FFFE ... U+10FFFF), like U+FFFE and U+FFFF
EXTRA_MARK = [(0x2800, 0x2800), (0xFFF9, 0xFFFB), (0x13430, 0x1343F)]   # drawn as nothing and in no class: the blank braille cell, the interlinear annotation marks and the Egyptian hieroglyph format controls (Unicode keeps the last two OUT of the property on purpose)
MARK_EXCEPT = [0xFE0E, 0xFE0F]
LINE = re.compile(r'^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*Default_Ignorable_Code_Point\b')


def merge(ranges):
    out = []
    for lo, hi in sorted((int(lo), int(hi)) for lo, hi in ranges):
        if out and lo <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def subtract(ranges, holes):
    """`ranges` without the code points of `holes` (both lists of (lo, hi)), merged."""
    out = []
    for lo, hi in ranges:
        cursor = lo
        for hole_lo, hole_hi in sorted(holes):
            if hole_hi < cursor or hole_lo > hi:
                continue
            if hole_lo > cursor:
                out.append((cursor, hole_lo - 1))
            cursor = max(cursor, hole_hi + 1)
        if cursor <= hi:
            out.append((cursor, hi))
    return merge(out)


def pinned_input():
    found = sorted((ROOT / 'scripts' / 'ucd').glob('DerivedCoreProperties-*-Default_Ignorable_Code_Point.txt'))
    if len(found) != 1:
        raise SystemExit(f'expected exactly one pinned input in scripts/ucd/, found {len(found)}')
    return found[0], re.fullmatch(r'DerivedCoreProperties-(\d+\.\d+\.\d+)-Default_Ignorable_Code_Point\.txt', found[0].name).group(1)


def default_ignorable(path):
    ranges = []
    for line in path.read_text(encoding='utf-8').splitlines():
        found = LINE.match(line)
        if found:
            lo = int(found.group(1), 16)
            ranges.append((lo, int(found.group(2) or found.group(1), 16)))
    if not ranges:
        raise SystemExit('no Default_Ignorable_Code_Point line in the pinned input')
    return merge(ranges)


def table():
    path, version = pinned_input()
    refuse = merge(REFUSE)
    holes = [(c, c) for c in MARK_EXCEPT]
    mark = subtract(merge([*subtract(default_ignorable(path), refuse), *EXTRA_MARK]), holes)
    return {'unicode_version': version, 'refuse': refuse, 'mark': mark, 'mark_except': list(MARK_EXCEPT)}


def render(data):
    """The bytes of the file: one key per line, every list on one line, decimal numbers, a final newline."""
    lines = [f' {json.dumps(key)}: {json.dumps(value, separators=(", ", ": "))}' for key, value in data.items()]
    return '{\n' + ',\n'.join(lines) + '\n}\n'


def main(argv):
    text = render(table())
    if argv == ['--check']:
        if not OUT.exists() or OUT.read_text(encoding='utf-8') != text:
            print(f'{OUT.relative_to(ROOT)} is not what this script makes of its pinned input: run it and commit the result', file=sys.stderr)
            return 1
        print(f'{OUT.relative_to(ROOT)}: ok')
        return 0
    if argv:
        print(__doc__, file=sys.stderr)
        return 2
    OUT.write_text(text, encoding='utf-8')
    print(f'wrote {OUT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
