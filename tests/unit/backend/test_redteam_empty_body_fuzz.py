"""Red team (Lume, 30/10): the fuzz between the two classifiers of "nothing to read" that Prumo asked for (contract v0.11 3.4: "there is no text where JS `\\s` and Python `.strip()` disagree on the test of emptiness").

* `\\s` of the extractor and `str.strip()` of the server, over EVERY code point: outside the table's refused and marked classes they take out exactly the same characters (the ECMAScript WhiteSpace and
  LineTerminator list against `str.isspace()` of this Python's Unicode data). Inside the table the difference does not matter (U+FEFF is marked and goes first; U+001C..U+001F and U+0085 are refused first).
* `tests/unit/redteam/fixtures/empty-body-fuzz.json` is what `gen_empty_body_fuzz.py` makes (a rerun reproduces it byte for byte), so the Vitest's 2,281 bodies are held to the SERVER's classifier,
  and the generator itself is checked here against a hand-written oracle for the cases that matter."""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / 'tests' / 'unit' / 'redteam' / 'fixtures'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ui = load(ROOT / 'backend' / 'unicode_invisible.py', 'fz_ui')
gen = load(FIXTURES / 'gen_empty_body_fuzz.py', 'fz_gen')
SPEC_WHITESPACE = {0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, *range(0x2000, 0x200b), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff}   # ECMAScript: WhiteSpace and LineTerminator


def test_js_whitespace_and_python_strip_take_out_the_same_characters_outside_the_table():
    disagree = [hex(c) for c in range(0x110000) if not 0xd800 <= c <= 0xdfff and ui.kind_of(c) is None and (c in SPEC_WHITESPACE) != chr(c).isspace()]
    assert disagree == []


def test_inside_the_table_the_two_do_disagree_and_the_table_takes_those_first():
    """The honest limit: JS `\\s` takes U+FEFF and not U+001C..U+001F or U+0085; Python's `isspace` takes the other three and not U+FEFF. Each of the four is in the table (marked or refused), which is checked first."""
    differ = sorted(c for c in range(0x110000) if not 0xd800 <= c <= 0xdfff and (c in SPEC_WHITESPACE) != chr(c).isspace())
    assert differ == [0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xfeff]
    assert [ui.kind_of(c) for c in differ] == ['refuse'] * 5 + ['mark']


def test_the_fixture_is_what_the_generator_makes():
    assert (FIXTURES / 'empty-body-fuzz.json').read_text() == gen.render(), 'rerun: python3 tests/unit/redteam/fixtures/gen_empty_body_fuzz.py'


def test_the_generator_agrees_with_a_hand_written_oracle_on_the_cases_that_matter():
    cases = {c['body']: c['expect'] for c in json.loads((FIXTURES / 'empty-body-fuzz.json').read_text())['cases']}
    z, nb = chr(0x200b), chr(0xa0)
    assert cases[''] == {'ok': False, 'why': 'empty_body'}
    assert cases[z * 3] == {'ok': False, 'why': 'empty_body'} and cases[nb + chr(0x3000)] == {'ok': False, 'why': 'empty_body'}
    assert cases[chr(0xfeff)] == {'ok': False, 'why': 'empty_body'}                       # a BOM is marked, so it goes first, and what is left is empty
    assert cases[chr(0x1f)]['why'] == 'hidden_characters' and cases[chr(0x85)]['why'] == 'hidden_characters' and cases[chr(0x2028)]['why'] == 'hidden_characters'
    assert cases['a' + chr(0x200c)] == {'ok': True, 'hidden': 1, 'marks': [[0x200c, 5, 2]]}
    assert cases[chr(0xfe0f)] == {'ok': True, 'hidden': 0, 'marks': []}                    # an emoji selector is not marked and is not a blank: it is something to read
    assert cases[chr(0xe0041)]['details'] == {'code': 'U+E0041', 'line': 5, 'column': 1}
    assert cases[chr(0x200c) * 51 + chr(0xe0041)]['why'] == 'hidden_characters'            # a refused character beats the count
    assert cases[chr(0x200c) * 52]['why'] == 'too_many_invisible' and cases[chr(0x200c) * 50 + 'x'] == {'ok': True, 'hidden': 50, 'marks': cases[chr(0x200c) * 50 + 'x']['marks']}
    assert len(cases) > 2000
