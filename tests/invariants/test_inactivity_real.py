"""The pause by inactivity (contract v0.8 section 8) firing AFTER ITS DEADLINE on the real Hermes, and "Retomar" meeting the cap's pause (invariant 7).
WRITTEN, NOT RUN against the real stack (the Forja proves it): the unit suite proves the clock logic (tests/unit/backend/test_inactivity.py, the red team A1 file),
this proves the same through the running watcher, the real cron of the Bot and the real routes.

The deadline is not waited for and the product is not touched: the clock is moved IN OUR OWN DATABASE (the watcher reads `inactivity_settings.set_at` and
`last_seen` in `luvebot.db` and compares them with `time.time()`), the way a test of a 3-day rule must; the harness runs the watcher every 3 s (`LUVEBOT_WATCH_EVERY`).
A person's visit is a row in `last_seen` (and the real `GET /session`, which writes it at most once a minute per process: so the row is also written by hand).

* nobody opened LuveBot for more than the days set: the routines of EVERY Bot pause (reason `inactivity`, a person's own pause stays `user`), the banner says how many,
  conversations still work; a visit (GET /session) resumes nothing; "Retomar" (a person with a login) resumes only what this paused, and the watcher does not pause them again;
* a Bot the cap paused: "Retomar" does NOT bring its routines back (`held`), the banner stays, and once a person has lifted the cap a later "Retomar" does."""
import sqlite3
import time

import pytest

from support import DASHBOARD
from test_bots import DB, audit_rows, error_of, post
from test_hook import run_to_end, wait_for
from test_inactivity_routes import put as put_days
from test_phase4 import clean_budget, new_routine, put as put_limit, routine_state, seed_session
from test_phase4 import delete as delete_routine, made_names
from test_plugin import PREFIX
from test_runs import get

DAY = 86400.0


def settings(browser):
    response = get(browser, '/settings/inactivity-pause')
    assert response.status == 200, response.text()
    return response.json()


def move_the_clock_back(days):
    """Nobody has opened LuveBot for `days` days: the setting is that old and so is every visit. The product's own clock is untouched."""
    conn = sqlite3.connect(DB, timeout=30)
    try:
        conn.execute('UPDATE inactivity_settings SET set_at = ? WHERE id = 1', (time.time() - days * DAY,))
        conn.execute('UPDATE last_seen SET at = ?', (time.time() - days * DAY,))
        conn.commit()
    finally:
        conn.close()


def a_person_visits(browser):
    """What opening LuveBot does: GET /session (the real route; it writes `last_seen` at most once a minute per process, so the row is also written here)."""
    assert browser.request.get(DASHBOARD + PREFIX + '/session').status == 200
    conn = sqlite3.connect(DB, timeout=30)
    try:
        conn.execute('INSERT OR REPLACE INTO last_seen VALUES (?, ?)', ('harness-person', time.time()))
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def made(human_browser):
    """Routines made by the test, and the setting and the memory of the pause put back whatever happened."""
    clean_budget()
    mine = []
    yield mine
    try:
        post(human_browser, '/routines/inactivity-resume', {})
    finally:
        put_days(human_browser, {'days': None})
        for job_id in mine:
            delete_routine(human_browser, f'/routines/{job_id}', {'confirm_name': made_names.get(job_id, '')})
        conn = sqlite3.connect(DB, timeout=30)
        try:
            conn.execute('DELETE FROM last_seen')
            conn.execute('DELETE FROM inactivity_event')
            conn.commit()
        finally:
            conn.close()
        clean_budget()


def paused_by(browser, job_id, reason):
    return routine_state(browser, job_id)['state'] == 'paused' and routine_state(browser, job_id)['paused_reason'] == reason


def test_after_the_deadline_the_routines_of_every_bot_pause_and_only_a_person_resumes_them(human_browser, made):
    mine = new_routine(human_browser, made, 't47-mine')
    elsewhere = new_routine(human_browser, made, 't47-elsewhere', bot='default')
    theirs = new_routine(human_browser, made, 't47-theirs')
    assert post(human_browser, f"/routines/{theirs['id']}/pause", {}).status == 200            # a person paused this one on purpose
    assert put_days(human_browser, {'days': 3}).status == 200
    a_person_visits(human_browser)                                                              # a recent visit: nothing happens yet
    time.sleep(8)                                                                               # (two watcher passes)
    assert routine_state(human_browser, mine['id'])['state'] == 'scheduled' and settings(human_browser)['paused'] is None

    move_the_clock_back(4)                                                                      # nobody came for 4 days; the deadline is 3
    wait_for(lambda: paused_by(human_browser, mine['id'], 'inactivity'), 60, 'the watcher to pause the routine after the deadline')
    wait_for(lambda: paused_by(human_browser, elsewhere['id'], 'inactivity'), 30, "the other Bot's routine to pause with it")
    assert paused_by(human_browser, theirs['id'], 'user'), 'a pause a person made is not ours and keeps its reason'
    banner = settings(human_browser)
    assert banner['days'] == 3 and banner['paused'] and banner['paused']['count'] >= 2 and banner['paused']['days'] == 3, banner
    assert any(r[1] == 'ok' for r in audit_rows('routines.inactivity_pause')), 'the pause is audited'

    _, _, done = run_to_end(human_browser, 'vendas', 'hello')                                  # conversations are not paused
    assert done['status'] == 'completed'
    a_person_visits(human_browser)                                                              # opening LuveBot resumes nothing
    assert routine_state(human_browser, mine['id'])['state'] == 'paused' and settings(human_browser)['paused'] is not None

    resumed = post(human_browser, '/routines/inactivity-resume', {})
    assert resumed.status == 200 and resumed.json()['resumed'] >= 2 and 'held' not in resumed.json(), resumed.text()
    assert routine_state(human_browser, mine['id'])['state'] == 'scheduled'
    assert routine_state(human_browser, elsewhere['id'])['state'] == 'scheduled'
    assert paused_by(human_browser, theirs['id'], 'user'), "Retomar does not undo a person's own pause"
    assert settings(human_browser)['paused'] is None
    assert any(r[1] == 'ok' for r in audit_rows('routines.inactivity_resume'))
    time.sleep(8)                                                                               # the visit is recent: the watcher does not pause them again
    assert routine_state(human_browser, mine['id'])['state'] == 'scheduled'


def test_retomar_does_not_undo_the_pause_of_the_cap_and_comes_back_once_it_is_lifted(human_browser, made):
    mine = new_routine(human_browser, made, 't47-cap-mine')
    elsewhere = new_routine(human_browser, made, 't47-cap-elsewhere', bot='default')
    assert put_days(human_browser, {'days': 3}).status == 200
    move_the_clock_back(4)
    wait_for(lambda: paused_by(human_browser, mine['id'], 'inactivity') and paused_by(human_browser, elsewhere['id'], 'inactivity'), 60,
             'both routines to pause by inactivity')
    assert put_limit(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 500}).status == 200
    for n in range(3):                                                                         # the loop that blows the cap: 3 x USD 1.70 = 510 cents
        seed_session(f"cron_{mine['id']}_20260101_00000{n}", 1.7)
    wait_for(lambda: [p['bot'] for p in get(human_browser, '/budget').json()['paused']] == ['vendas'], 60, 'the cap to pause the Bot')
    a_person_visits(human_browser)

    held = post(human_browser, '/routines/inactivity-resume', {})
    assert held.status == 200, held.text()
    body = held.json()
    assert body['resumed'] >= 1 and body.get('held', 0) >= 1, ('the other Bot comes back, the capped Bot does not', body)
    assert routine_state(human_browser, mine['id'])['state'] == 'paused', 'Retomar must not undo the pause of the cap (invariant 7)'
    assert routine_state(human_browser, elsewhere['id'])['state'] == 'scheduled'
    assert settings(human_browser)['paused'] is not None and settings(human_browser)['paused']['count'] >= 1, 'the banner stays while something is held'
    time.sleep(8)
    assert routine_state(human_browser, mine['id'])['state'] == 'paused'
    refused = post(human_browser, '/bots/vendas/runs', {'input': 'hello'})
    assert refused.status == 409 and error_of(refused)['code'] == 'bot_paused'                  # and the Bot still takes no new run

    assert put_limit(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 100000}).status == 200
    lifted = post(human_browser, '/bots/vendas/budget/resume', {})
    assert lifted.status == 200 and lifted.json()['resumed'] is True, lifted.text()
    a_person_visits(human_browser)
    back = post(human_browser, '/routines/inactivity-resume', {})
    assert back.status == 200 and back.json()['resumed'] >= 1 and 'held' not in back.json(), back.text()
    assert routine_state(human_browser, mine['id'])['state'] == 'scheduled', 'once the cap is lifted a later Retomar brings the routine back'
    assert settings(human_browser)['paused'] is None
