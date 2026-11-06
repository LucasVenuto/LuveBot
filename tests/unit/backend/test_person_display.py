"""Crie seu Luve B2 (docs/propostas/v02-crie-seu-luve.md §8 Q3): the person's own face, kept PER ACTOR (the actor of /session) in
person_display, set with the same avatar rule as a Bot (kinds initials, emoji, mascot, luve) and nothing else in the body. Every
check also runs against bot_meta.py with one defect each: each must go red.
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
LUVE = {'kind': 'luve', 'value': 'nimbo.fosco.lupa.38bdf8'}


def load(edit=None):
    name = f'person_backend_{next(_n)}'
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


def store(meta, tmp_path):
    db = tmp_path / f'luvebot-{next(_n)}.db'
    sqlite3.connect(db).close()
    return meta.BotMeta(db)


def check_per_actor(meta, tmp_path):
    s = store(meta, tmp_path)
    assert s.person('dashboard') is None
    assert s.set_person('github:1', meta.validate_person({'avatar': LUVE})['avatar']) == LUVE
    assert s.set_person('github:2', {'kind': 'mascot', 'value': 'tico'}) == {'kind': 'mascot', 'value': 'tico'}
    assert s.person('github:1') == LUVE and s.person('github:2') == {'kind': 'mascot', 'value': 'tico'}
    assert s.person('dashboard') is None
    s.set_person('github:1', {'kind': 'initials', 'value': 'LV'})          # a second save replaces, never adds a row
    assert s.person('github:1') == {'kind': 'initials', 'value': 'LV'}
    assert sqlite3.connect(s.path).execute('SELECT COUNT(*) FROM person_display').fetchone()[0] == 2


def check_only_the_avatar(meta, _tmp_path):
    for body in ({'avatar': LUVE, 'label': 'Eu'}, {'label': 'Eu'}, {}, [], 'x', None, {'avatar': {'kind': 'luve', 'value': 'nimbo.fosco.lupa.38BDF8'}},
                 {'avatar': {'kind': 'mascot', 'value': 'gato'}}):
        with pytest.raises(meta.PluginError) as e:
            meta.validate_person(body)
        assert (e.value.code, e.value.status) == ('invalid_field', 422), body
    for value in ('https://x/y.png', '/etc/passwd', 'img_' + '0' * 31, 'IMG_' + '0' * 32, 'img_' + '0' * 32 + '\n', 5, None):        # an image is an id of ours that the writer owns (v0.11 2.2): anything else, and an id nobody owns, is `avatar_unknown`
        for owns in (None, lambda v: False):
            with pytest.raises(meta.PluginError) as e:
                meta.validate_person({'avatar': {'kind': 'image', 'value': value}}, owns=owns)
            assert (e.value.code, e.value.status) == ('avatar_unknown', 422), (value, owns)
    for avatar in (LUVE, {'kind': 'mascot', 'value': 'luvi'}, {'kind': 'emoji', 'value': '🙂'}, {'kind': 'initials', 'value': 'LV'}):
        assert meta.validate_person({'avatar': avatar}) == {'avatar': avatar}


CHECKS = [check_per_actor, check_only_the_avatar]


@pytest.mark.parametrize('check', CHECKS, ids=lambda c: c.__name__)
def test_person_display(check, tmp_path):
    check(load(), tmp_path)


@pytest.mark.parametrize('edit', [
    ("SELECT avatar_kind, avatar_value FROM person_display WHERE actor=?', (actor,)", "SELECT avatar_kind, avatar_value FROM person_display ORDER BY rowid DESC', ()"),  # one face for everyone
    ("    if not isinstance(body, dict) or set(body) != {'avatar'}:", "    if not isinstance(body, dict) or 'avatar' not in body:"),  # more than the avatar
    ("    return validate_display(body, owns=owns, current=current)\n", "    return body\n"),                                                   # the avatar unchecked
], ids=['one-face', 'extra-field', 'unchecked'])
def test_each_mutation_is_caught(edit, tmp_path):
    meta, failed = load(edit), 0
    for check in CHECKS:
        try:
            check(meta, tmp_path)
        except (AssertionError, pytest.fail.Exception):
            failed += 1
    assert failed, f'mutation not caught: {edit[1]!r}'
