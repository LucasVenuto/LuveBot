"""T8.3d: mascot avatars and `image` refused on write (contract v0 section 14, A-53 and A-54), against the REAL mounted plugin and
Hermes. One validator (`validate_display`) serves PATCH /bots/{bot}/display and the display of POST /bots; both are exercised.
Mutations: tests/harness/mutate_v04.py (t83d_any_mascot, t83d_image_accepted).
"""
import json
from pathlib import Path
import sqlite3
import uuid

import pytest

from support import DASHBOARD, plugin
from test_bots import DB, audit_rows, error_of, patch, post

BAD = ['Luvi', 'luvi.svg', 'luvi-rosto', '../luvi', '', 'https://x/y.svg', 7, None, ['luvi']]
REFUSED = [{'kind': 'mascot', 'value': v} for v in BAD] + [{'kind': 'image', 'value': 'abc'}, {'kind': 'image', 'value': '/etc/passwd'}]


def ids():
    plugin()
    from luvebot_backend.bot_meta import MASCOT_IDS
    return MASCOT_IDS


def profiles(browser):
    return {p['name'] for p in browser.request.get(DASHBOARD + '/api/profiles').json()['profiles']}


@pytest.fixture
def vendas_display():
    conn = sqlite3.connect(DB)
    saved = conn.execute("SELECT * FROM bot_meta WHERE bot='vendas'").fetchone()
    cols = [c[1] for c in conn.execute('PRAGMA table_info(bot_meta)')]
    conn.close()
    yield
    conn = sqlite3.connect(DB)
    conn.execute("DELETE FROM bot_meta WHERE bot='vendas'")
    if saved:
        conn.execute(f"INSERT INTO bot_meta ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})", saved)
    conn.commit()
    conn.close()


@pytest.fixture
def name(human_browser):
    made = 't83d-' + uuid.uuid4().hex[:8]
    yield made
    human_browser.request.delete(DASHBOARD + '/api/profiles/' + made)
    conn = sqlite3.connect(DB)
    conn.execute('DELETE FROM bot_meta WHERE bot=?', (made,))
    conn.commit()
    conn.close()


def test_mascot_ids_match_the_manifest():
    root = Path(plugin().__file__).parents[1] / 'assets/mascots'
    manifest = json.loads((root / 'manifest.json').read_text())
    assert sorted(m['id'] for m in manifest) == sorted(ids()) and len(ids()) == 15
    assert all((root / m['face']).is_file() and m['face'] == m['id'] + '-rosto.svg' for m in manifest)


def test_every_mascot_is_accepted_on_patch_and_create_with_an_audit_row(human_browser, vendas_display, name):
    before = len(audit_rows('bot.display.update'))
    for mascot in sorted(ids()):
        response = patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'mascot', 'value': mascot}})
        assert response.status == 200, (mascot, response.text())
        assert response.json()['display']['avatar'] == {'kind': 'mascot', 'value': mascot}
    assert [r[1:3] for r in audit_rows('bot.display.update')[before:]] == [('ok', 'intent'), ('ok', 'result')] * 15
    shown = {b['name']: b for b in human_browser.request.get(DASHBOARD + '/api/plugins/luvebot/bots').json()['bots']}['vendas']
    assert shown['display']['avatar'] == {'kind': 'mascot', 'value': sorted(ids())[-1]}                 # an id, never a URL or path

    created = post(human_browser, '/bots', {'name': name, 'display': {'label': 'Mascote', 'avatar': {'kind': 'mascot', 'value': 'tico'}}})
    assert created.status == 201, created.text()
    assert created.json()['bot']['display']['avatar'] == {'kind': 'mascot', 'value': 'tico'}
    assert [r[1:3] for r in audit_rows('bot.create') if r[3] == name] == [('ok', 'intent'), ('ok', 'result')]


@pytest.mark.parametrize('avatar', REFUSED, ids=[json.dumps(a) for a in REFUSED])
def test_an_unknown_mascot_or_an_image_is_refused_on_both_routes_and_writes_nothing(human_browser, vendas_display, name, avatar):
    display, creates = len(audit_rows('bot.display.update')), len(audit_rows('bot.create'))
    code = 'avatar_unknown' if avatar['kind'] == 'image' else 'invalid_field'    # since AV-3 an image is an id of an image the writer owns (v0.11 2.2); anything else of that kind is `avatar_unknown`
    patched = patch(human_browser, '/bots/vendas/display', {'avatar': avatar})
    assert patched.status == 422 and error_of(patched)['code'] == code and (code == 'avatar_unknown' or 'avatar' in error_of(patched)['message']), patched.text()
    created = post(human_browser, '/bots', {'name': name, 'display': {'label': 'X', 'avatar': avatar}})
    assert created.status == 422 and error_of(created)['code'] == code and (code == 'avatar_unknown' or 'avatar' in error_of(created)['message']), created.text()
    assert (len(audit_rows('bot.display.update')), len(audit_rows('bot.create'))) == (display, creates)
    assert name not in profiles(human_browser)


# Crie seu Luve B1 (docs/propostas/v02-crie-seu-luve.md §4 and §8 Q1): the kind 'luve' holds a canonical recipe checked against
# the fixed lists, on both routes, audited like any display change. Mutation: tests/harness/mutate_v04.py luve_any_value.
LUVE_OK = ['nimbo.fosco.lupa.38bdf8', 'tico.metal.sinos.000000']
LUVE_BAD = ['nimbo.fosco.lupa.38BDF8', 'nimbo.fosco.lupa.#38bdf8', 'nimbo.ouro.lupa.38bdf8', 'gato.fosco.lupa.38bdf8',
            'nimbo.fosco.espada.38bdf8', 'nimbo.fosco.lupa.38bdf8.x', 'https://x/y.svg', 7]


def test_a_luve_recipe_is_accepted_on_patch_and_create_with_an_audit_row(human_browser, vendas_display, name):
    before = len(audit_rows('bot.display.update'))
    for recipe in LUVE_OK:
        response = patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'luve', 'value': recipe}})
        assert response.status == 200, (recipe, response.text())
        assert response.json()['display']['avatar'] == {'kind': 'luve', 'value': recipe}
    assert [r[1:3] for r in audit_rows('bot.display.update')[before:]] == [('ok', 'intent'), ('ok', 'result')] * len(LUVE_OK)
    created = post(human_browser, '/bots', {'name': name, 'display': {'label': 'Luve', 'avatar': {'kind': 'luve', 'value': LUVE_OK[0]}}})
    assert created.status == 201, created.text()
    assert created.json()['bot']['display']['avatar'] == {'kind': 'luve', 'value': LUVE_OK[0]}


@pytest.mark.parametrize('value', LUVE_BAD, ids=[json.dumps(v) for v in LUVE_BAD])
def test_a_luve_recipe_off_the_lists_is_refused_on_both_routes_and_writes_nothing(human_browser, vendas_display, name, value):
    avatar = {'kind': 'luve', 'value': value}
    display, creates = len(audit_rows('bot.display.update')), len(audit_rows('bot.create'))
    patched = patch(human_browser, '/bots/vendas/display', {'avatar': avatar})
    assert patched.status == 422 and error_of(patched)['code'] == 'invalid_field', patched.text()
    created = post(human_browser, '/bots', {'name': name, 'display': {'label': 'X', 'avatar': avatar}})
    assert created.status == 422 and error_of(created)['code'] == 'invalid_field', created.text()
    assert (len(audit_rows('bot.display.update')), len(audit_rows('bot.create'))) == (display, creates)
    assert name not in profiles(human_browser)
