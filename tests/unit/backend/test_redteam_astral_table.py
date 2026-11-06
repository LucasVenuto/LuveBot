"""Red team (Lume, 30/10): the widened table (the 32 astral noncharacters refused, U+FFF9..U+FFFB and U+13430..U+1343F marked) attacked at the SERVER's classifier (`backend/unicode_invisible.py`).
The code points are built with chr(): the Python str is made of code points, so a "surrogate pair that spells U+1FFFE" is the one character and its two halves alone are two lone surrogates. What is pinned:
the 66 noncharacters are all refused and their neighbours are not; the new families are marked, one per character, with the place in code points; an emoji in a sequence is never marked (the ZWJ and the new
characters are); a refused character wins over the count; the refusal says where and never what; the table file and the generator agree."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ui = load(ROOT / 'backend' / 'unicode_invisible.py', 'as_ui')
NONCHARACTERS = [*range(0xfdd0, 0xfdf0)] + [plane * 0x10000 + low for plane in range(17) for low in (0xfffe, 0xffff)]
PLANES = range(1, 17)


def test_all_66_noncharacters_are_refused_and_nothing_next_to_them_is():
    assert len(NONCHARACTERS) == 66
    assert [hex(c) for c in NONCHARACTERS if ui.kind_of(c) != 'refuse'] == []
    for plane in range(17):
        for neighbour in (plane * 0x10000 + 0xfffd, plane * 0x10000 + 0xfffc, plane * 0x10000 + 0x10000 if plane < 16 else None):
            if neighbour is None or neighbour in NONCHARACTERS or 0xe0000 <= neighbour <= 0xe007f or 0xe0100 <= neighbour <= 0xe01ef or 0xd800 <= neighbour <= 0xdfff:
                continue
            assert ui.kind_of(neighbour) != 'refuse', hex(neighbour)
    assert ui.kind_of(0xfdcf) is None and ui.kind_of(0xfdf0) is None                           # the edges of the BMP block of noncharacters
    assert ui.kind_of(0x10ffff) == 'refuse' and ui.kind_of(0x10fffd) is None


@pytest.mark.parametrize('c', [plane * 0x10000 + low for plane in PLANES for low in (0xfffe, 0xffff)], ids=lambda c: f'U+{c:X}')
def test_an_astral_noncharacter_is_refused_with_its_place_and_nothing_else(c):
    text = f'line one\nab\U0001f600{chr(c)}cd SEGREDO-DO-RASCUNHO'
    found = ui.scan(text)
    assert found['refused'] == {'code_point': c, 'code': f'U+{c:04X}', 'line': 2, 'column': 4}                       # the emoji is one column; the code is `U+` and at least four uppercase hex digits
    assert 'SEGREDO' not in repr(found['refused']) and ui.verdict(text) == 'refuse' and ui.warning(found) is None


def test_the_two_halves_of_a_pair_alone_are_lone_surrogates_and_refused_as_such():
    high, low = chr(0xd83f), chr(0xdffe)                                                          # what a JSON "\\ud83f\\udffe" gives when something splits it
    for text in (f'a{high}b', f'a{low}b', f'a{high}\n{low}b', f'a{low}{high}b'):
        found = ui.scan(text)['refused']
        assert found is not None and found['code_point'] in (0xd83f, 0xdffe), text.encode('unicode_escape')
    assert ui.scan('a' + chr(0x1fffe) + 'b')['refused']['code_point'] == 0x1fffe                  # the same two units joined: the code point, one refusal


@pytest.mark.parametrize('c', [0xfff0, 0xfff5, 0xfff8, 0xfff9, 0xfffa, 0xfffb, 0x13430, 0x13437, 0x1343f])
def test_the_new_families_and_their_neighbours_in_the_old_range_are_marked_one_each(c):
    found = ui.scan(f'a{chr(c)}b{chr(c)}')
    assert found['count'] == 2 and [m['column'] for m in found['marked']] == [2, 4] and ui.warning(found)['kinds'] == [{'code': f'U+{c:04X}', 'count': 2}]


@pytest.mark.parametrize('c', [0xffef, 0xfffc, 0xfffd, 0x1342f, 0x13440, 0x13441])
def test_the_edges_of_the_new_ranges_are_not_marked(c):
    assert ui.kind_of(c) is None and ui.scan('a' + chr(c))['count'] == 0


def test_emoji_in_sequences_are_never_marked_only_the_joiners_and_the_new_characters_are():
    man, woman, girl, zwj = chr(0x1f468), chr(0x1f469), chr(0x1f467), chr(0x200d)
    text = f'1. {man}{zwj}{chr(0x13430)}{woman}{zwj}{girl}{chr(0xfff9)}'
    found = ui.scan(text)
    assert [(m['code_point'], m['column']) for m in found['marked']] == [(0x200d, 5), (0x13430, 6), (0x200d, 8), (0xfff9, 10)] and found['count'] == 4
    for seq in (f'1{chr(0xfe0f)}{chr(0x20e3)}', chr(0x1f1e7) + chr(0x1f1f7), chr(0x1f44d) + chr(0x1f3fd), chr(0x2764) + chr(0xfe0f), chr(0x2764) + chr(0xfe0e)):
        assert ui.scan(seq)['count'] == 0, seq.encode('unicode_escape')
        for new in (chr(0xfffa), chr(0x13431)):
            inside = seq[0] + new + seq[1:]
            assert ui.scan(inside)['count'] == 1 and ui.scan(inside)['marked'][0]['code_point'] == ord(new)


def test_a_subdivision_flag_is_refused_whole_the_known_false_positive_and_the_new_marks_do_not_rescue_it():
    england = chr(0x1f3f4) + ''.join(chr(c) for c in (0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f))
    assert ui.verdict(england) == 'refuse' and ui.verdict(england + chr(0xfff9)) == 'refuse'


def test_a_refused_character_wins_over_fifty_one_new_marks_wherever_it_sits():
    marks = chr(0x13430) * 26 + chr(0xfffb) * 25
    for text in (marks + chr(0x1fffe), chr(0x1fffe) + marks, marks[:10] + chr(0x10ffff) + marks[10:]):
        assert ui.verdict(text) == 'refuse'
    assert ui.verdict(marks) == 'too_many' and ui.verdict(marks[:-1]) == 'ok'


def test_the_text_is_only_read_and_the_copy_without_the_marked_ones_holds_the_rest():
    text = f'a{chr(0x13430)}b{chr(0xfff9)}c{chr(0x200d)}'
    before = text
    ui.scan(text)
    assert text == before and ui.without_marked(text) == 'abc'


def test_the_table_file_is_sorted_merged_in_range_and_what_the_generator_makes():
    table = json.loads((ROOT / 'backend' / 'unicode_invisible.json').read_text())
    for name in ('refuse', 'mark'):
        ranges = table[name]
        assert all(0 <= lo <= hi <= 0x10ffff for lo, hi in ranges) and all(ranges[i][1] + 1 < ranges[i + 1][0] for i in range(len(ranges) - 1)), name
    assert not [c for lo, hi in table['mark'] for c in (lo, hi) if ui.kind_of(c) == 'refuse']
    done = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'gen_invisible_table.py'), '--check'], capture_output=True, text=True)
    assert done.returncode == 0, done.stdout + done.stderr
