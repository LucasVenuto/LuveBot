"""Crie seu Luve B1 (docs/propostas/v02-crie-seu-luve.md §4 and §8 Q1): the avatar kind 'luve' with the canonical recipe
"<shape>.<material>.<accessory>.<rrggbb>", checked against fixed lists (the same closed rule as 'mascot', A-54), no migration.
The backend lists are tied byte for byte to assets/mascots/luve-kit.json (the kit the UI draws from). Every check also runs
against bot_meta.py with one defect each: each must go red.
"""
import importlib
import importlib.util
import itertools
import json
from pathlib import Path
import sqlite3
import sys

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
KIT = json.loads((ROOT / 'assets/mascots/luve-kit.json').read_text())
_n = itertools.count()

GOOD = ['nimbo.fosco.lupa.38bdf8', 'luvi.vinil.nenhum.6a70f8', 'tico.metal.sinos.000000', 'zuca.laca.balao.ffffff']
BAD = ['nimbo.fosco.lupa.38BDF8', 'nimbo.fosco.lupa.#38bdf8', '#38bdf8', 'Nimbo.fosco.lupa.38bdf8', 'nimbo.fosco.lupa.38bdf8.x',
       'nimbo.fosco.lupa', 'nimbo.ouro.lupa.38bdf8', 'nimbo.fosco.espada.38bdf8', 'gato.fosco.lupa.38bdf8', ' nimbo.fosco.lupa.38bdf8',
       'nimbo.fosco.lupa.38bdf8\n', 'nimbo.fosco.lupa.38bdf', 'nimbo..lupa.38bdf8', 'https://x/y.svg', 'data:image/svg+xml,<svg/>',
       '', 7, None, ['nimbo'], {'shape': 'nimbo'}]


def load(edit=None):
    name = f'luve_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if not edit:
        return importlib.import_module(f'{name}.bot_meta')
    source = (BACKEND / 'bot_meta.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.bot_meta', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'bot_meta.py'), 'exec'), module.__dict__)
    return module


def refused(meta, value):
    try:
        meta.validate_display({'avatar': {'kind': 'luve', 'value': value}})
    except meta.PluginError as e:
        return e.code == 'invalid_field' and e.status == 422
    return False


def check_lists(meta):
    assert sorted(meta.MASCOT_IDS) == sorted(KIT['shapes'])
    assert sorted(meta.LUVE_MATERIALS) == sorted(KIT['materials'])
    assert sorted(meta.LUVE_ACCESSORIES) == sorted(KIT['accessories'])


def check_accepts(meta):
    for value in GOOD:
        assert meta.validate_display({'avatar': {'kind': 'luve', 'value': value}}) == {'avatar': {'kind': 'luve', 'value': value}}, value


def check_refuses(meta):
    for value in BAD:
        assert refused(meta, value), repr(value)
    # every recipe of the kit is accepted, and one id off the list in any slot is refused
    for shape in KIT['shapes']:
        for material in KIT['materials']:
            for accessory in KIT['accessories']:
                assert meta.is_luve(f'{shape}.{material}.{accessory}.a1b2c3')
    for i, off in enumerate(['gato', 'ouro', 'espada']):
        parts = ['nimbo', 'fosco', 'lupa', '38bdf8']
        parts[i] = off
        assert refused(meta, '.'.join(parts)), parts


def check_other_kinds_unchanged(meta):
    assert meta.validate_display({'avatar': {'kind': 'mascot', 'value': 'luvi'}})['avatar'] == {'kind': 'mascot', 'value': 'luvi'}
    for avatar in ({'kind': 'mascot', 'value': 'nimbo.fosco.lupa.38bdf8'}, {'kind': 'image', 'value': 'nimbo.fosco.lupa.38bdf8'},
                   {'kind': 'luve', 'value': 'luvi', 'extra': 1}, {'kind': 'Luve', 'value': GOOD[0]}):
        with pytest.raises(meta.PluginError):
            meta.validate_display({'avatar': avatar})


def check_stored_without_migration(meta, tmp_path):
    db = tmp_path / 'luvebot.db'
    sqlite3.connect(db).close()
    store = meta.BotMeta(db)
    store.upsert('vendas', meta.validate_display({'avatar': {'kind': 'luve', 'value': GOOD[0]}}))
    assert store.get('vendas')['avatar'] == {'kind': 'luve', 'value': GOOD[0]}
    conn = sqlite3.connect(db)
    # the recipe lives in the columns every avatar uses; no column of its own (no migration)
    assert conn.execute("SELECT avatar_kind, avatar_value FROM bot_meta WHERE bot='vendas'").fetchone() == ('luve', GOOD[0])
    assert not [c[1] for c in conn.execute('PRAGMA table_info(bot_meta)') if 'luve' in c[1] or 'recipe' in c[1]]


CHECKS = [check_lists, check_accepts, check_refuses, check_other_kinds_unchanged]


@pytest.mark.parametrize('check', CHECKS + [check_stored_without_migration], ids=lambda c: c.__name__)
def test_luve_recipe(check, tmp_path):
    meta = load()
    check(meta, tmp_path) if check is check_stored_without_migration else check(meta)


@pytest.mark.parametrize('edit', [
    ("'emoji', 'initials', 'mascot', 'luve', 'image')", "'emoji', 'initials', 'mascot', 'image')"),   # the kind not accepted at all
    ("            if not is_luve(value):\n                raise _bad('avatar')", "            pass"),   # any value accepted
    ("r'([a-z]+)\\.([a-z]+)\\.([a-z]+)\\.([0-9a-f]{6})'", "r'([a-z]+)\\.([a-z]+)\\.([a-z]+)\\.#?([0-9a-fA-F]{6})'"),  # two spellings
    ("_LUVE.fullmatch(value)", "_LUVE.match(value)"),                                        # a tail after the hex
    ("match[2] in LUVE_MATERIALS and ", ""),                                                  # material off the list
    ("'coracao', 'cadeado', 'sinos'))", "'coracao', 'cadeado', 'sinos', 'espada'))"),        # list drifts from the kit
], ids=['kind', 'any-value', 'two-spellings', 'tail', 'material', 'drift'])
def test_each_mutation_is_caught(edit):
    meta = load(edit)
    failed = 0
    for check in CHECKS:
        try:
            check(meta)
        except AssertionError:
            failed += 1
        except meta.PluginError:
            failed += 1
    assert failed, f'mutation not caught: {edit[1]!r}'
