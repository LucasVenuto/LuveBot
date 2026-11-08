"""Contract v0.8 section 9 (backend/bot_meta.py): pin, hide, reorder. `pinned` is a display field like `hidden`; PUT /bots/order takes
exactly a permutation of the listed Bots (missing, extra or repeated names: 422) and writes every position at once; a database
made before v0.8 gains the two columns. Every check also runs against bot_meta.py with one defect each: each must go red.
"""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sqlite3
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
NAMES = ['vendas', 'default', 'suporte']


def load(edit=None):
    name = f'order_backend_{next(_n)}'
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


def code_of(fn, *args):
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)


def checks(bm, tmp_path):
    assert code_of(bm.validate_order, {'bots': ['suporte', 'vendas', 'default']}, NAMES) == ['suporte', 'vendas', 'default']
    for bad in (['vendas', 'default'], ['vendas', 'default', 'suporte', 'outro'], ['vendas', 'vendas', 'default', 'suporte'],
                ['vendas', 'default', 7]):
        assert code_of(bm.validate_order, {'bots': bad}, NAMES) == 'invalid_field', bad
    for bad in ({'bots': 'vendas'}, {}, {'bots': NAMES, 'x': 1}, NAMES):
        assert code_of(bm.validate_order, bad, NAMES) == 'bad_request', bad
    assert code_of(bm.validate_display, {'pinned': 1}) == 'invalid_field'
    assert bm.validate_display({'pinned': True, 'hidden': False}) == {'pinned': True, 'hidden': False}

    db = tmp_path / f'old{next(_n)}.db'
    old = sqlite3.connect(db)                                    # a database made before v0.8 (and before v0.4's columns)
    old.execute('CREATE TABLE bot_meta (bot TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL, call_me TEXT, color TEXT NOT NULL, '
                'avatar_kind TEXT NOT NULL, avatar_value TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)')
    old.execute("INSERT INTO bot_meta VALUES ('vendas','Vendas','','','#60a5fa','initials','VE',1)")
    old.commit()
    old.close()
    meta = bm.BotMeta(db)
    assert meta.get('vendas')['pinned'] is False and meta.get('vendas')['position'] is None and meta.get('vendas')['hidden'] is True
    meta.upsert('vendas', {'pinned': True})
    assert meta.get('vendas')['pinned'] is True and meta.get('vendas')['label'] == 'Vendas'
    meta.set_order(['suporte', 'vendas', 'default'])
    assert [meta.get(n)['position'] for n in ('suporte', 'vendas', 'default')] == [0, 1, 2]
    assert meta.get('suporte')['label'] == 'suporte'                                          # a Bot with no row got its defaults
    meta.upsert('vendas', {'label': 'Vendas 2'})
    assert meta.get('vendas')['position'] == 1 and meta.get('vendas')['pinned'] is True      # a display edit keeps both


def test_pin_hide_and_order(tmp_path):
    checks(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ("len(order) != len(set(order)) or set(order) != set(names)", "len(order) != len(set(order))"),
    ("len(order) != len(set(order)) or set(order) != set(names)", "set(order) != set(names)"),
    ("int(merged['hidden']), int(merged['pinned'])))", "int(merged['hidden']), 0))"),
    ("                    conn.execute('UPDATE bot_meta SET position=? WHERE bot=?', (position, name))\n", ""),
    ("    for flag in ('hidden', 'pinned'):", "    for flag in ('hidden',):"),
], ids=['missing_or_extra_accepted', 'repeated_accepted', 'pin_not_saved', 'order_not_saved', 'pinned_refused'])
def test_each_mutation_is_caught(tmp_path, edit):
    with pytest.raises(AssertionError):
        checks(load(edit), tmp_path)
