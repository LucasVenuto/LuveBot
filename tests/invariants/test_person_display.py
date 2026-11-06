"""Crie seu Luve B2 (docs/propostas/v02-crie-seu-luve.md §8 Q3) against the REAL mounted plugin and Hermes: GET/PATCH /me/display
keep the face of the actor of /session (the real login here; 'dashboard' on loopback). PATCH needs CSRF (refused before any audit row), takes only an
avatar by the Bot rule, and is audited 'me.display.set' (intent, then result). 401 without a session: test_plugin.py walks every
route. Mutation: tests/harness/mutate_v04.py me_no_csrf.
"""
import sqlite3

import pytest

from support import DASHBOARD
from test_bots import DB, PREFIX, audit_rows, error_of, patch

LUVE = {'kind': 'luve', 'value': 'nimbo.fosco.lupa.38bdf8'}


@pytest.fixture
def clean_face():
    def wipe():
        conn = sqlite3.connect(DB)
        conn.execute("CREATE TABLE IF NOT EXISTS person_display (actor TEXT PRIMARY KEY, avatar_kind TEXT NOT NULL, avatar_value TEXT NOT NULL)")
        conn.execute('DELETE FROM person_display')  # the harness actor is the real login (provider:user_id), not 'dashboard'
        conn.commit()
        conn.close()
    wipe()
    yield
    wipe()


def get(browser):
    return browser.request.get(DASHBOARD + PREFIX + '/me/display')


def test_the_face_of_the_viewer_is_set_audited_and_read_back(human_browser, clean_face):
    assert get(human_browser).json() == {'avatar': None}
    before = len(audit_rows('me.display.set'))
    response = patch(human_browser, '/me/display', {'avatar': LUVE})
    assert response.status == 200 and response.json() == {'avatar': LUVE}, response.text()
    assert [r[1:3] for r in audit_rows('me.display.set')[before:]] == [('ok', 'intent'), ('ok', 'result')]
    assert get(human_browser).json() == {'avatar': LUVE}
    actor = human_browser.request.get(DASHBOARD + PREFIX + '/session').json()['actor']
    assert sqlite3.connect(DB).execute('SELECT actor FROM person_display').fetchall() == [(actor,)]


@pytest.mark.parametrize('token', [None, 'forged'])
def test_no_csrf_no_change_and_no_audit_row(human_browser, clean_face, token):
    before = len(audit_rows('me.display.set'))
    response = patch(human_browser, '/me/display', {'avatar': LUVE}, token=token)
    assert response.status == 403 and error_of(response)['code'] == 'csrf_required', response.text()
    assert len(audit_rows('me.display.set')) == before and get(human_browser).json() == {'avatar': None}


@pytest.mark.parametrize('body', [{'avatar': LUVE, 'label': 'Eu'}, {'avatar': {'kind': 'image', 'value': 'https://x/y.png'}},
                                  {'avatar': {'kind': 'luve', 'value': 'nimbo.fosco.lupa.38BDF8'}}, {}])
def test_anything_but_a_valid_avatar_is_refused_and_writes_nothing(human_browser, clean_face, body):
    before = len(audit_rows('me.display.set'))
    response = patch(human_browser, '/me/display', body)
    code = 'avatar_unknown' if (body.get('avatar') or {}).get('kind') == 'image' else 'invalid_field'    # an image that is not one the person owns (AV-3, v0.11 2.2)
    assert response.status == 422 and error_of(response)['code'] == code, response.text()
    assert len(audit_rows('me.display.set')) == before and get(human_browser).json() == {'avatar': None}
