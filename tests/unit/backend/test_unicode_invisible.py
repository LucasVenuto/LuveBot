"""SK-2a (contract v0.11 section 3.4): the ONE table of invisible characters, the script that makes it, and the classifier the server reads it with.
* `scripts/gen_invisible_table.py` makes `backend/unicode_invisible.json` from the pinned lines of the Unicode Character Database (`scripts/ucd/`) and a rerun reproduces it byte for byte;
* the table: sorted, merged, no overlap between classes, every class the contract names is in it (the minimum lists and the ones a hand list missed), and it covers every Default_Ignorable_Code_Point
  that the Lume's fixture lists (the Unicode 17 positions an ICU gave: 4,174) with nothing extra but U+2800;
* test (1) of 3.4: the first and last code point of every range classify as the table says;
* test (3) of 3.4: the SHARED fixture `tests/data/invisible-fixture.json`, strings with their verdict, count and positions, the 50th and the 51st marked character and a refused character that wins over the
  count, which the Vitest of the dashboard checks too;
* the classifier holds no range and asks neither `unicodedata` nor a regular-expression engine what a character is; it never changes the text.
Mutations: a range dropped, the 51st accepted, a marked character removed, the engine used instead of the table, a table that says something else (the fixture holds that too)."""
import importlib.util
import json
import re
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
SOURCE = (BACKEND / 'unicode_invisible.py').read_text()
TABLE_PATH = BACKEND / 'unicode_invisible.json'
FIXTURE = json.loads((ROOT / 'tests' / 'data' / 'invisible-fixture.json').read_text())
LUME = json.loads((ROOT / 'tests' / 'unit' / 'redteam' / 'fixtures' / 'default-ignorable-unicode17.json').read_text())['ranges']


def classifier(edits=(), table=None):
    """backend/unicode_invisible.py from its source with `edits` applied (an anchor must occur once), reading `table` (a dict written to a temp file by the caller) or the real JSON."""
    source = SOURCE
    for old, new in edits:
        assert source.count(old) == 1, old
        source = source.replace(old, new)
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader('ui_variant', loader=None))
    module.__file__ = str(BACKEND / 'unicode_invisible.py')
    if table is not None:
        source = source.replace("PATH = Path(__file__).with_name('unicode_invisible.json')", f'PATH = Path({str(table)!r})')
    exec(compile(source, str(BACKEND / 'unicode_invisible.py'), 'exec'), module.__dict__)
    return module


def generator():
    spec = importlib.util.spec_from_file_location('gen_invisible_table', ROOT / 'scripts' / 'gen_invisible_table.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cps(ranges):
    return {cp for lo, hi in ranges for cp in range(lo, hi + 1)}


def spans(*pairs):
    return {cp for lo, hi in pairs for cp in range(lo, hi + 1)}


# ---- the script and the file ----------------------------------------------------------------------------------------------------------------------
def test_a_rerun_of_the_script_reproduces_the_json_byte_for_byte():
    gen = generator()
    assert TABLE_PATH.read_text(encoding='utf-8') == gen.render(gen.table())
    assert gen.main(['--check']) == 0


def test_the_pinned_input_is_the_ucd_section_with_its_provenance():
    pinned = sorted((ROOT / 'scripts' / 'ucd').glob('DerivedCoreProperties-*-Default_Ignorable_Code_Point.txt'))
    assert len(pinned) == 1
    text = pinned[0].read_text(encoding='utf-8')
    assert 'https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt' in text and re.search(r'SHA-256 of the whole file it was cut from: [0-9a-f]{64}', text)
    lines = [l for l in text.splitlines() if re.match(r'^[0-9A-F]{4,6}(\.\.[0-9A-F]{4,6})?\s*;', l)]
    assert all(l.split(';')[1].split('#')[0].strip() == 'Default_Ignorable_Code_Point' for l in lines) and len(lines) == 27
    total = int(re.search(r'# Total code points: (\d+)', text).group(1))
    assert total == len(cps(generator().default_ignorable(pinned[0]))) == 4174                         # the lines add up to what the file says: nothing was lost or changed in the copy
    assert json.loads(TABLE_PATH.read_text())['unicode_version'] == '17.0.0' == re.fullmatch(r'DerivedCoreProperties-(\d+\.\d+\.\d+)-.*', pinned[0].name).group(1)


def test_the_json_is_the_documented_shape_in_decimal_sorted_merged_ranges():
    table = json.loads(TABLE_PATH.read_text())
    assert list(table) == ['unicode_version', 'refuse', 'mark', 'mark_except']
    for name in ('refuse', 'mark'):
        ranges = table[name]
        assert all(isinstance(lo, int) and isinstance(hi, int) and not isinstance(lo, bool) and 0 <= lo <= hi <= 0x10FFFF for lo, hi in ranges), name
        assert ranges == sorted(ranges) and all(a[1] + 1 < b[0] for a, b in zip(ranges, ranges[1:])), f'{name}: sorted, merged, no overlap'
    assert not cps(table['refuse']) & cps(table['mark']), 'a character has one class'
    assert table['mark_except'] == [0xFE0E, 0xFE0F] and not set(table['mark_except']) & (cps(table['refuse']) | cps(table['mark']))
    assert TABLE_PATH.read_text().endswith('}\n') and TABLE_PATH.read_text().isascii()


def test_every_class_the_contract_names_is_in_the_table():
    table = json.loads(TABLE_PATH.read_text())
    refuse, mark = cps(table['refuse']), cps(table['mark'])
    assert refuse >= spans((0xE0000, 0xE007F), (0xE0100, 0xE01EF), (0x202A, 0x202E), (0x2028, 0x2029), (0, 8), (0xB, 0xC), (0xE, 0x1F), (0x7F, 0x7F), (0x80, 0x9F), (0xFDD0, 0xFDEF), (0xFFFE, 0xFFFF), (0xD800, 0xDFFF))
    assert refuse >= {plane * 0x10000 + low for plane in range(1, 17) for low in (0xFFFE, 0xFFFF)}, 'the noncharacters at the end of every plane'
    assert not refuse & {9, 10, 13}, 'TAB, LF and CR stay'
    assert mark >= spans((0x200B, 0x200D), (0x2060, 0x2064), (0xAD, 0xAD), (0x200E, 0x200F), (0x61C, 0x61C), (0x2066, 0x2069), (0xFEFF, 0xFEFF), (0x115F, 0x1160), (0x3164, 0x3164), (0xFFA0, 0xFFA0),
                         (0x180E, 0x180E), (0xFE00, 0xFE0D))                                             # the contract's table
    assert mark >= spans((0x34F, 0x34F), (0x17B4, 0x17B5), (0x180B, 0x180D), (0x180F, 0x180F), (0x206A, 0x206F), (0x1BCA0, 0x1BCA3), (0x1D173, 0x1D17A), (0xE0080, 0xE00FF), (0xE01F0, 0xE0FFF),
                         (0xFFF0, 0xFFF8), (0x2065, 0x2065), (0x2800, 0x2800), (0xFFF9, 0xFFFB), (0x13430, 0x1343F))      # what a hand list missed (the Lume's F-SK6b), the blank braille cell and the two families outside the property
    assert not mark & {0xFE0E, 0xFE0F, 9, 10, 13, 0x20, 0x41}


def test_the_table_covers_every_default_ignorable_code_point_of_the_lumes_fixture_and_nothing_else_but_what_the_generator_adds():
    table = json.loads(TABLE_PATH.read_text())
    refuse, mark, everything = cps(table['refuse']), cps(table['mark']), cps(LUME)
    assert len(everything) == 4174
    assert everything <= refuse | mark | set(table['mark_except']), f'{len(everything - (refuse | mark | set(table["mark_except"])))} default-ignorable code points are in no class'
    added = spans((0x2800, 0x2800), (0xFFF9, 0xFFFB), (0x13430, 0x1343F))                              # the blank braille cell and the two families Unicode keeps out of the property on purpose
    assert mark | set(table['mark_except']) == (everything - refuse) | added, 'mark holds a code point that is neither default-ignorable nor one of the three the generator adds'


# ---- test (1) of 3.4: the first and the last of every range ----------------------------------------------------------------------------------------
def boundary_checks(m):
    table = json.loads(TABLE_PATH.read_text())
    refuse, mark = cps(table['refuse']), cps(table['mark'])
    for name, ranges in (('refuse', table['refuse']), ('mark', table['mark'])):
        for lo, hi in ranges:
            for cp in (lo, hi, (lo + hi) // 2):
                assert m.kind_of(cp) == name, (name, hex(cp))
            for outside in (lo - 1, hi + 1):
                if 0 <= outside <= 0x10FFFF and outside not in refuse and outside not in mark:
                    assert m.kind_of(outside) is None, (name, hex(outside))
    for cp in (9, 10, 13, 0x20, 0x41, 0xE9, 0x3042, 0x1F600, 0xFE0E, 0xFE0F, 0x10FFFD):
        assert m.kind_of(cp) is None, hex(cp)


def test_the_first_and_the_last_code_point_of_every_range_classify_as_the_table_says():
    boundary_checks(classifier())


# ---- test (3) of 3.4: the shared fixture ----------------------------------------------------------------------------------------------------------
def fixture_checks(m):
    assert FIXTURE['max_marked'] == m.MAX_MARKED == 50 and len(FIXTURE['cases']) > 100
    for case in FIXTURE['cases']:
        result, verdict = m.scan(case['text']), m.verdict(case['text'])
        assert verdict == case['verdict'], (case['id'], verdict)
        if verdict == 'refuse':
            assert result['refused'] == case['refused'], (case['id'], result['refused'])
        elif verdict == 'too_many':
            assert result['count'] == case['count'] and result['refused'] is None, case['id']
        else:
            assert result['count'] == case['count'] and [[x['line'], x['column']] for x in result['marked']] == case['where'] and result['refused'] is None, (case['id'], result)
            warning = m.warning(result)
            assert (warning is None) == (case['count'] == 0), case['id']
            if warning:
                assert warning['kind'] == 'invisible_characters' and warning['count'] == case['count'] and [[w['line'], w['column']] for w in warning['where']] == case['where']
                assert sum(k['count'] for k in warning['kinds']) == case['count'] and [k['code'] for k in warning['kinds']] == sorted(k['code'] for k in warning['kinds']), case['id']
    for case in FIXTURE['emptiness']:                                                                 # whole files: the verdict the server and the extractor must give the same way
        text, body = case['text'], case['body']
        assert text == case['header'] + body, case['id']
        if case['verdict'] == 'hidden_characters':
            assert m.verdict(text) == 'refuse', case['id']                                            # a refused character wins over the cut
        else:
            assert m.verdict(text) == 'ok' and m.blank(body) is (case['verdict'] == 'empty_body'), (case['id'], m.verdict(text), m.blank(body))
    # the count in a warning, by kind, in words the screen can say: "ZWNJ x5, LRM x2"
    assert m.warning(m.scan('a‌b‌\n\u200e\u200ez‌‌'))['kinds'] == [{'code': 'U+200C', 'count': 4}, {'code': 'U+200E', 'count': 2}]
    assert m.warning(m.scan('clean')) is None and m.warning(m.scan('a\u202eb')) is None and m.warning(m.scan('a' + '‌' * 51)) is None   # nothing to warn about a text that is refused


def test_the_emptiness_cases_are_what_the_contract_names():
    ids = {c['id']: c['verdict'] for c in FIXTURE['emptiness']}
    assert {'empty-body-nbsp', 'empty-body-ideographic-space', 'empty-body-en-quad', 'empty-body-medium-math-space', 'empty-body-bom', 'empty-body-tab'} <= {i for i, v in ids.items() if v == 'empty_body'}
    assert {'hidden-body-nel', 'hidden-body-file-separator'} <= {i for i, v in ids.items() if v == 'hidden_characters'} and 'not-empty-letter' in ids
    assert all(c['header'].startswith('---\n') and c['header'].endswith('---\n') for c in FIXTURE['emptiness'])


def test_the_shared_fixture_holds_on_the_server():
    fixture_checks(classifier())


def test_the_fixture_has_every_case_the_contract_asks_for():
    ids = {c['id'] for c in FIXTURE['cases']}
    assert {'fifty-marked-is-allowed', 'fifty-one-marked-is-refused', 'refuse-beats-the-count-after', 'refuse-beats-the-count-before', 'persian-zwnj-is-marked-not-refused',
            'emoji-presentation-selectors-are-not-marked', 'column-counts-code-points', 'tab-lf-cr-are-allowed', 'refuse-tag-a', 'mark-blank-braille-U+2800'} <= ids
    assert len(ids) == len(FIXTURE['cases']) and all(re.fullmatch(r'[a-z0-9+\-]+', c['id'], re.I) for c in FIXTURE['cases'])
    assert all(c['verdict'] in ('ok', 'refuse', 'too_many') for c in FIXTURE['cases'])
    for c in FIXTURE['cases']:                                                                          # what the dashboard's extractor and the server both carry in `details` (SK-1d)
        if c['verdict'] == 'refuse':
            r = c['refused']
            assert list(r) == ['code', 'code_point', 'line', 'column'] and r['code'] == f"U+{r['code_point']:04X}" and re.fullmatch(r'U\+[0-9A-F]{4,6}', r['code']) and r['line'] >= 1 and r['column'] >= 1, c['id']
        elif c['verdict'] == 'too_many':
            assert isinstance(c['count'], int) and c['count'] > FIXTURE['max_marked'] and c['refused'] is None, c['id']
        else:
            assert c['refused'] is None and c['count'] <= FIXTURE['max_marked'], c['id']
    assert json.dumps(FIXTURE, ensure_ascii=False).isascii() or True
    assert (ROOT / 'tests' / 'data' / 'invisible-fixture.json').read_text().isascii(), 'every character that is not drawn is written as an escape: it can be reviewed'


# ---- the classifier reads the table and nothing else, and never changes the text ---------------------------------------------------------------
def test_the_classifier_holds_no_range_and_asks_no_engine():
    assert not re.findall(r'0x[0-9A-Fa-f]{3,}', SOURCE) and not re.findall(r'\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8}', SOURCE), 'a range typed by hand'
    assert 'unicodedata' not in SOURCE.replace('never `unicodedata`', '').replace('asks neither `unicodedata`', '') and not re.search(r'^\s*(import|from)\s+regex\b', SOURCE, re.M)
    assert 'json.loads' in SOURCE and 'unicode_invisible.json' in SOURCE


def test_the_text_is_never_changed_and_a_copy_without_the_marked_is_only_a_copy():
    m = classifier()
    text = 'a‌b\u200e\u202eć ⠀ d'
    before = str(text)
    m.scan(text), m.verdict(text), m.warning(m.scan(text))
    assert text == before and len(text) == len(before)
    assert m.without_marked('a‌b\u200e c⠀d️') == 'ab cd️'                          # the marked ones out, FE0F and everything else stays
    assert m.without_marked('\u200b' * 40) == '' and m.without_marked('') == '' and m.without_marked('plain') == 'plain'
    assert m.without_marked('x\u202ey') == 'x\u202ey'                                                   # a refused one is not this function's business: it stays, the text is refused before


def test_a_big_text_costs_little():
    m = classifier()
    started = time.perf_counter()
    assert m.verdict('‌' * 1_000_000) == 'too_many' and m.verdict('a' * 2_000_000) == 'ok' and m.verdict('‌' * 1_000_000 + '\u202e') == 'refuse'
    assert time.perf_counter() - started < 5.0


# ---- mutations ----------------------------------------------------------------------------------------------------------------------------------
CODE_MUTATIONS = {
    'the 51st is accepted': [('MAX_MARKED = 50', 'MAX_MARKED = 51')],
    'the 50th is refused': [('return \'too_many\' if result[\'count\'] > MAX_MARKED else \'ok\'', 'return \'too_many\' if result[\'count\'] >= MAX_MARKED else \'ok\'')],
    'a refusal does not beat the count': [("        if kind_of(cp) == 'refuse':\n", "        if kind_of(cp) == 'refuse' and count <= MAX_MARKED:\n")],
    'a marked character is removed before the positions are told': [("            line, column = _place(text, found.start())\n            marked.append", "            line, column = _place(without_marked(text[:found.start()]) + text[found.start():], found.start())\n            marked.append")],
    'the engine tells what a character is': [("    if _within(TABLE['refuse'], _REFUSE_STARTS, cp):\n        return 'refuse'\n    return 'mark' if _within(TABLE['mark'], _MARK_STARTS, cp) else None",
                                              "    import unicodedata\n    return 'mark' if unicodedata.category(chr(cp)) == 'Cf' else None")],
    'a column counts UTF-16 units': [("    return text.count('\\n', 0, index) + 1, index - line_start + 1", "    return text.count('\\n', 0, index) + 1, len(text[line_start:index].encode('utf-16-le')) // 2 + 1")],
    'a CR is a line break': [("    return text.count('\\n', 0, index) + 1, index - line_start + 1", "    return text.count('\\n', 0, index) + text.count('\\r', 0, index) + 1, index - line_start + 1")],
    'the first refusal is not the one reported': [("    for found in _ANY.finditer(text):\n", "    for found in reversed(list(_ANY.finditer(text))):\n")],
    'the code is lower-case hex': [("{'refused': {'code': f'U+{cp:04X}'", "{'refused': {'code': f'U+{cp:04x}'")],
    'the code has no padding': [("{'refused': {'code': f'U+{cp:04X}'", "{'refused': {'code': f'U+{cp:X}'")],
    'the code is the decimal': [("{'refused': {'code': f'U+{cp:04X}'", "{'refused': {'code': f'U+{cp}'")],
    'blank strips only ASCII whitespace': [('    return without_marked(text).strip() == \'\'', "    return without_marked(text).strip(' \\t\\n\\r') == ''")],
    'blank leaves the marked in': [('    return without_marked(text).strip() == \'\'', "    return text.strip() == ''")],
    'a mark is counted twice': [("        count += 1\n        if count <= MAX_MARKED:", "        count += 2\n        if count <= MAX_MARKED:")],
    'a range is missing from the scan pattern': [("_ANY = _pattern(sorted(TABLE['refuse'] + TABLE['mark']))", "_ANY = _pattern(sorted(TABLE['refuse'] + TABLE['mark'])[:-1])")],
    'a range of refuse is dropped': [("TABLE = load()\n", "TABLE = load()\nTABLE['refuse'] = TABLE['refuse'][1:]\n")],
    'the last range of refuse is dropped': [("TABLE = load()\n", "TABLE = load()\nTABLE['refuse'] = TABLE['refuse'][:-1]\n")],
    'a range of mark is dropped': [("TABLE = load()\n", "TABLE = load()\nTABLE['mark'] = TABLE['mark'][:3] + TABLE['mark'][4:]\n")],
    'the last range of mark is dropped': [("TABLE = load()\n", "TABLE = load()\nTABLE['mark'] = TABLE['mark'][:-1]\n")],
    'a range shrinks by one': [("TABLE = load()\n", "TABLE = load()\nTABLE['mark'] = [(lo, hi - 1) if hi - lo > 5 else (lo, hi) for lo, hi in TABLE['mark']]\n")],
}


@pytest.mark.parametrize('label', sorted(CODE_MUTATIONS))
def test_each_classifier_mutation_is_caught(label):
    m = classifier(CODE_MUTATIONS[label])                                  # an anchor that moved fails HERE
    with pytest.raises(BaseException):  # noqa: B017
        boundary_checks(m)
        fixture_checks(m)


def table_with(tmp_path, change):
    table = json.loads(TABLE_PATH.read_text())
    change(table)
    path = tmp_path / 'table.json'
    path.write_text(json.dumps(table))
    return path


def carve(ranges, lo, hi):
    """`ranges` without the code points lo..hi (a range may have been merged with its neighbours: the astral noncharacters touch the Tags block)."""
    out = []
    for a, b in ranges:
        if b < lo or a > hi:
            out.append([a, b])
            continue
        if a < lo:
            out.append([a, lo - 1])
        if b > hi:
            out.append([hi + 1, b])
    return out


TABLE_MUTATIONS = {
    'TAB is refused': lambda t: t['refuse'].insert(0, [9, 9]),
    'LF is refused': lambda t: t['refuse'].insert(1, [10, 10]),
    'the emoji selector is marked': lambda t: t['mark'].append([0xFE0F, 0xFE0F]),
    'the blank braille cell is not marked': lambda t: t.update(mark=carve(t['mark'], 0x2800, 0x2800)),
    'the variation selectors supplement is only marked': lambda t: t.update(refuse=carve(t['refuse'], 0xE0100, 0xE01EF), mark=t['mark'] + [[0xE0100, 0xE01EF]]),
    'the tags are only marked': lambda t: t.update(refuse=carve(t['refuse'], 0xE0000, 0xE007F), mark=t['mark'] + [[0xE0000, 0xE007F]]),
    'the surrogates are not refused': lambda t: t.update(refuse=carve(t['refuse'], 0xD800, 0xDFFF)),
    'the soft hyphen is not marked': lambda t: t.update(mark=carve(t['mark'], 0xAD, 0xAD)),
    'an astral noncharacter is not refused': lambda t: t.update(refuse=carve(t['refuse'], 0x1FFFE, 0x1FFFF)),
    'the last noncharacter of the last plane is not refused': lambda t: t.update(refuse=carve(t['refuse'], 0x10FFFF, 0x10FFFF)),
    'the interlinear annotation marks are not marked': lambda t: t.update(mark=carve(t['mark'], 0xFFF9, 0xFFFB)),
    'the Egyptian format controls are not marked': lambda t: t.update(mark=carve(t['mark'], 0x13430, 0x1343F)),
}


@pytest.mark.parametrize('label', sorted(TABLE_MUTATIONS))
def test_a_table_that_says_something_else_is_caught_by_the_shared_fixture(label, tmp_path):
    m = classifier(table=table_with(tmp_path, TABLE_MUTATIONS[label]))
    with pytest.raises(AssertionError):
        fixture_checks(m)
