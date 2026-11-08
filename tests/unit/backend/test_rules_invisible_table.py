"""R-5 (contract v0.11 section 8, A-198; the Lume's F-R4-1, Medium): ONE question decides what is invisible for the rules' matcher.

Before, `rules.py` kept its own list BY UNICODE CATEGORY (`_INVISIBLE`: Cc, Cf, Cs, Co, Cn, Zl, Zp) and the table of 3.4 (`unicode_invisible`) was a second list that had diverged: CGJ U+034F, the Mongolian free variation
selectors U+180B-180D and the variation selectors U+FE00-FE0F are `Mn`, so the matcher did not drop them while the IDNA resolver erases them from a host: with `block curl *localhost*` and `allow curl *`, the command
`curl http://local<CGJ>host` was judged ALLOW and reached localhost (a block or an ask on a DESTINATION bypassed by one invisible character, and the action not even asked about).

`_invisible(c)` is true for the categories of before OR `unicode_invisible.kind_of(cp)` is not None OR the two code points of `mark_except` (U+FE0E, U+FE0F: legitimate in text, so the table does not mark them, but the resolver erases
them all the same; the matcher only COMPARES, it never changes the action). It replaces the category list in the four places that drop or refuse an invisible character (`canon_name`, `_canon_pattern`, `_command_text` and the
refusal of a pattern in `validate_rule`). By A-196 a pattern that holds one of them is now `bad_glob`; a path condition still accepts them.

The hook runs THIS engine (it loads `luvebot_backend` from the clone's `backend/`, and install.sh copies the whole directory: the JSON goes with it): the last tests load it the way the hook does, from an installed layout, and pin that the
hook's version rose so that "update protection" is offered."""
from __future__ import annotations

import importlib
import importlib.util
import re
import shutil
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_rules_paths', reason='the builders and the variant loader of the rules')

import backend.rules as real  # noqa: E402
import backend.unicode_invisible as table  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
CGJ = 0x034F
IDNA_IGNORED = [CGJ, 0x180B, 0x180C, 0x180D] + list(range(0xFE00, 0xFE10))                # what the resolver deletes from a host (and the category list never saw)
CATEGORY_SAMPLES = [0x00, 0x1B, 0x7F, 0x85, 0x200B, 0x00AD, 0x2060, 0xFEFF, 0xD800, 0xE000, 0x0378, 0x2028, 0x2029]          # Cc, Cf, Cs, Co, Cn, Zl, Zp
PLAIN = ['a', 'Z', '0', '-', '.', '/', ' ', chr(0xE9), chr(0x5D0), chr(0x646), chr(0x1F600), chr(0x301), chr(0x300), chr(0x3099)]    # text: letters, digits, punctuation, accents, an emoji


def table_samples():
    """Every range of the table: its ends, its next-to-ends and its middle (the whole table, one code point at a time, would be tens of thousands)."""
    points = set()
    for lo, hi in table.TABLE['refuse'] + table.TABLE['mark']:
        points.update({lo, hi, min(lo + 1, hi), max(hi - 1, lo), (lo + hi) // 2})
    return sorted(points)


def rules(m):
    return [tp.rule(m, 'net', m.Level.BLOCK, tools=('terminal',), commands=('curl *localhost*',)), tp.rule(m, 'all', m.Level.ALLOW, tools=('terminal',), commands=('curl *',))]


def winner(m, command):
    decision, _ordered = m._evaluate_full(rules(m), m.Action(bot='vendas', tool='terminal', command=command))
    return decision.winner


def inv_the_matcher_asks_one_question(m):
    for cp in CATEGORY_SAMPLES + IDNA_IGNORED + table_samples() + list(table.TABLE['mark_except']):
        assert m._invisible(chr(cp)) is True, hex(cp)                                       # the categories, the table (all of it) and the two kept out of the table
    assert sorted(table.TABLE['mark_except']) == [0xFE0E, 0xFE0F]                          # the exception is exactly the two variation selectors
    for ch in PLAIN:
        assert m._invisible(ch) is False, repr(ch)                                          # text stays text: an accent, a letter, an emoji, a space are not erased


def inv_a_block_on_a_destination_holds_whatever_the_resolver_deletes(m):
    assert winner(m, 'curl http://localhost:1/') == 'net' and winner(m, 'wget http://localhost:1/') != 'net'
    for cp in IDNA_IGNORED + table_samples()[::3]:
        ch = chr(cp)
        for command in (f'curl http://local{ch}host:1/', f'curl http://localhost{ch}:1/', f'curl http://{ch}localhost:1/', f'curl http://loc{ch}al{ch}host:1/'):
            assert winner(m, command) == 'net', (hex(cp), command)                           # judged as `localhost`: blocked, not allowed and not even asked about


def inv_the_four_places_drop_or_refuse_the_same_characters(m):
    for cp in IDNA_IGNORED + [0x200B, 0x00AD]:
        ch = chr(cp)
        assert m.canon_name('wri' + ch + 'te_file') == ('write_file', False), hex(cp)        # a tool name: dropped (so a rule for the plain name still hits)
        assert m._canon_pattern('wri' + ch + 'te_*') == 'write_*', hex(cp)                   # a pattern, as the matcher reads it
        assert m._command_text('r' + ch + 'm -rf')[0] == 'rm -rf', hex(cp)                   # a command: dropped (the tab and the newlines stay: they separate)
        for rule in (tp.rule(m, 'c', m.Level.BLOCK, tools=('terminal',), commands=('rm' + ch + ' -rf *',)), tp.rule(m, 't', m.Level.BLOCK, tools=('wri' + ch + 'te_file',)),
                     tp.rule(m, 's', m.Level.BLOCK, tools=(), toolsets=('we' + ch + 'b',))):
            assert [p.code for p in m.validate_rule(rule)] == ['bad_glob'], (hex(cp), rule.id)    # A-196: a pattern the matcher would drop from could never match
    assert m._command_text('a\tb\nc\r')[0] == 'a\tb\nc\r'                                   # the three that separate commands are never dropped
    # and what stays: a path condition is compared literally, so it still ACCEPTS them (and matches exactly that character)
    for cp in (CGJ, 0x180B, 0xFE0F):
        value = 'workspace:docs/a' + chr(cp) + 'b.txt'
        rule = tp.rule(m, 'p', m.Level.BLOCK, conditions=(('path', value),))
        assert m.validate_rule(rule) == () and tp.effect(m, [rule], value) == 'block' and tp.effect(m, [rule], 'workspace:docs/ab.txt') == 'none', hex(cp)


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
Q, D, F = tuple(INVARIANTS)
MUTATIONS = [
    (Q, 'the table is not consulted', ' or unicode_invisible.kind_of(code) is not None', ''),
    (Q, 'the two variation selectors are forgotten', ' or code in unicode_invisible.TABLE["mark_except"]', ''),
    (Q, 'the categories are forgotten', 'return unicodedata.category(char) in _INVISIBLE or unicode_invisible.kind_of(code)', 'return unicode_invisible.kind_of(code)'),
    (Q, 'only half of the exception', 'code in unicode_invisible.TABLE["mark_except"]', 'code == 0xFE0F'),
    (Q, 'private-use characters are text', 'return unicodedata.category(char) in _INVISIBLE or unicode_invisible.kind_of(code)', 'return unicodedata.category(char) in (_INVISIBLE - {"Co"}) or unicode_invisible.kind_of(code)'),
    (Q, 'unassigned characters are text', 'return unicodedata.category(char) in _INVISIBLE or unicode_invisible.kind_of(code)', 'return unicodedata.category(char) in (_INVISIBLE - {"Cn"}) or unicode_invisible.kind_of(code)'),
    (Q, 'an accent is invisible', ' or code in unicode_invisible.TABLE["mark_except"]', ' or code in unicode_invisible.TABLE["mark_except"] or unicodedata.category(char) == "Mn"'),
    (D, 'the table is not consulted', ' or unicode_invisible.kind_of(code) is not None', ''),
    (D, 'the two variation selectors are forgotten', ' or code in unicode_invisible.TABLE["mark_except"]', ''),
    (D, 'the matcher of a command is on the old list', '        if _invisible(char) and char not in "\\t\\n\\r":', '        if unicodedata.category(char) in _INVISIBLE and char not in "\\t\\n\\r":'),
    (F, 'the name of a tool is on the old list', '    plain = "".join(c for c in folded if not c.isspace() and not _invisible(c))', '    plain = "".join(c for c in folded if not c.isspace() and unicodedata.category(c) not in _INVISIBLE)'),
    (F, 'a pattern is on the old list', '    return "".join(c for c in folded if not c.isspace() and not _invisible(c))', '    return "".join(c for c in folded if not c.isspace() and unicodedata.category(c) not in _INVISIBLE)'),
    (F, 'a command is on the old list', '        if _invisible(char) and char not in "\\t\\n\\r":', '        if unicodedata.category(char) in _INVISIBLE and char not in "\\t\\n\\r":'),
    (F, 'the refusal of a pattern is on the old list', '                            or any(_invisible(c) for c in text)', '                            or any(unicodedata.category(c) in _INVISIBLE for c in text)'),
    (F, 'a command drops the tab and the newlines too', '        if _invisible(char) and char not in "\\t\\n\\r":', '        if _invisible(char) or char in "\\t":'),
    (F, 'a path condition refuses them', '    if parts is None or "\\\\" in value:\n        return False\n    if op in ("eq", "under"):', '    if parts is None or "\\\\" in value or any(_invisible(c) for c in value):\n        return False\n    if op in ("eq", "under"):'),
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


# ---- the hook runs THIS engine: loaded the way the hook loads it, from an installed layout --------------------------------------------------------------------
def install_backend(tmp_path, with_table=True):
    """What `scripts/install.sh` does with the backend: `cp -R backend/. <home>/plugins/luvebot/backend/`."""
    directory = tmp_path / 'plugins' / 'luvebot' / 'backend'
    shutil.copytree(ROOT / 'backend', directory, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    if not with_table:
        (directory / 'unicode_invisible.json').unlink()
    return directory


def load_the_way_the_hook_does(directory, monkeypatch):
    """The six lines of `hermes-plugin/__init__.py:_backend()`, on a copy: the package `luvebot_backend` out of the clone's backend directory."""
    for name in [n for n in sys.modules if n == 'luvebot_backend' or n.startswith('luvebot_backend.')]:
        monkeypatch.delitem(sys.modules, name)
    spec = importlib.util.spec_from_file_location('luvebot_backend', directory / '__init__.py', submodule_search_locations=[str(directory)])
    package = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, 'luvebot_backend', package)
    spec.loader.exec_module(package)
    return importlib.import_module('luvebot_backend.rules')


def test_the_hook_loads_the_engine_and_its_table_from_the_installed_layout(tmp_path, monkeypatch):
    directory = install_backend(tmp_path)
    engine = load_the_way_the_hook_does(directory, monkeypatch)
    assert Path(engine.__file__).parent == directory and Path(engine.unicode_invisible.PATH) == directory / 'unicode_invisible.json'      # the engine and its table are the installed copies
    assert winner(engine, 'curl http://local' + chr(CGJ) + 'host:1/') == 'net' and winner(engine, 'curl http://local' + chr(0xFE0F) + 'host:1/') == 'net'
    for name in [n for n in sys.modules if n == 'luvebot_backend' or n.startswith('luvebot_backend.')]:
        monkeypatch.delitem(sys.modules, name)


def test_control_without_the_table_the_engine_does_not_load_and_that_is_why_install_ships_the_whole_directory(tmp_path, monkeypatch):
    directory = install_backend(tmp_path, with_table=False)
    with pytest.raises(OSError):                                                              # a missing table is a failed import, not a quiet fallback to the old list
        load_the_way_the_hook_does(directory, monkeypatch)
    for name in [n for n in sys.modules if n == 'luvebot_backend' or n.startswith('luvebot_backend.')]:
        monkeypatch.delitem(sys.modules, name)
    install = (ROOT / 'scripts' / 'install.sh').read_text()
    assert 'cp -R "$project_dir/backend/." "$target/backend/"' in install                   # the whole directory, so the JSON goes with the code
    plugin = (ROOT / 'hermes-plugin' / '__init__.py').read_text()
    assert 'submodule_search_locations=[str(directory)]' in plugin and '"plugins" / "luvebot" / "backend"' in plugin       # and that is the directory the hook loads from
    assert (ROOT / 'backend' / 'unicode_invisible.json').is_file() and (ROOT / 'backend' / 'unicode_invisible.py').is_file()


def test_the_hook_version_rose_so_that_update_protection_is_offered():
    plugin = (ROOT / 'hermes-plugin' / '__init__.py').read_text()
    shipped = re.search(r'^PLUGIN_VERSION = "([0-9]+\.[0-9]+\.[0-9]+)"$', plugin, re.M).group(1)
    assert tuple(map(int, shipped.split('.'))) > (0, 8, 7)                                  # a hook that reports 0.8.0 to 0.8.7 is older than what this LuveBot ships (R-5 rose it to 0.8.1, R-7 to 0.8.2, R-7b to 0.8.3, the IDNA dots of R-10 to 0.8.4, the full case fold of R-13 to 0.8.5, the second flag of R-13b to 0.8.6, the restrictive names of R-13c to 0.8.7, the optional tools of BA-2 to 0.8.8)
    import backend.hook as hook
    assert hook.latest_version() == shipped                                                  # and the dashboard reads it from the install source, as text
    assert '* 0.8.1 (R-5, A-198)' in plugin and '* 0.8.2 (R-7, A-199)' in plugin and '* 0.8.3 (R-7b, A-201)' in plugin and '* 0.8.4 (R-10, A-205)' in plugin and '* 0.8.5 (R-13, A-208)' in plugin and '* 0.8.6 (R-13b, A-212)' in plugin and '* 0.8.7 (R-13c, A-216)' in plugin and f'* {shipped} (BA-2, A-248)' in plugin          # the docstring of the hook says why, for each rise
