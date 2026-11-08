"""ADR-010 / r45 on the REAL Hermes: ONE budget watcher per luvebot.db, whoever hosts the app (the dashboard, and the gateway too since Hermes 0.22.5). The stack is the
harness's own: the entrypoint starts both processes and restarts one of them when a test killed it ON PURPOSE (`restart-<name>` written first; `hold-dashboard` keeps the dashboard
DOWN until the file is removed). This file sorts last (`zz`): it kills the dashboard and the gateway under the other tests and leaves both up.

* S3  both up: the heartbeats are ONE sequence, not two (the dashboard holds the lease once a request proved it serves);
* S5  the owner (the dashboard) is killed: the gateway takes over within the lease (90 s) plus one pass, `watcher_stale` never lights, a cap that paused a routine keeps pausing
      it (a job resumed behind LuveBot's back is paused again by the new owner);
* S4  the dashboard comes back: on a build the harness PINNED it takes the lease by itself, on any other it is not PROVEN to serve until a request reaches the plugin and the gateway keeps
      the lease till then;
* the gateway (the non-owner) killed and restarted: the watcher does not notice, and the new gateway does not take the lease back.
Also pinned here, per Hermes tag: the internals the serving check reads (hermes_compat.SERVING_PROVEN needs this file green on that tag)."""
import ast
import inspect
import os
import signal
import sqlite3
import time
from datetime import datetime, timezone

import pytest

from support import DASHBOARD, STATE, credentials, plugin
from test_bots import DB
from test_hook import wait_for
from test_phase4 import HOME, SEEDED, clean_budget, delete, made_names, new_routine, put, seed_session
from test_runs import get

EVERY = 3        # LUVEBOT_WATCH_EVERY of the stack (compose.yaml)
EXPIRES = 90     # watcher_lease.EXPIRES_S
STALE = 300      # Budget.watcher_max_age: `watcher_stale` lights above it
PASS_ROWS = 2    # one pass writes the heartbeat's intent and result to the audit


MADE = []


@pytest.fixture(scope='module', autouse=True)
def cleanup(human_browser):
    """test_phase4's `clean` runs around EACH test and deletes through the dashboard, which S5 kills on purpose: here it runs once, after S4 brought the dashboard back."""
    clean_budget()
    yield
    for job_id in MADE:
        delete(human_browser, f'/routines/{job_id}', {'confirm_name': made_names.get(job_id, '')})
    clean_budget()
    conn = sqlite3.connect(HOME / 'state.db')
    for session_id in SEEDED:
        conn.execute('DELETE FROM sessions WHERE id=?', (session_id,))
    conn.commit()
    conn.close()
    SEEDED.clear()


@pytest.fixture(scope='module')
def hosted_by_gateway():
    """Needs a Hermes whose gateway hosts the app (run_api.py sets `app.state.gateway_runner`): on another one no second watcher can start there. The harness starts its first gateway
    BEFORE it enables the plugin (to record the baseline of the listeners), so THAT process never loaded LuveBot: a gateway started now does (the entrypoint restarts it on request)."""
    try:
        import gateway.run_api as run_api
        hosted = '.app.state.gateway_runner = ' in inspect.getsource(run_api)
    except Exception:  # noqa: BLE001
        hosted = False
    if not hosted:
        pytest.skip('the gateway of this Hermes does not host the app: no second watcher can start there')
    bring_back('gateway', kill('gateway'))
    time.sleep(20)                                                          # its boot: the app, the plugin import, the first pass


def q(sql, *args):
    conn = sqlite3.connect(f'file:{DB}?mode=ro', uri=True, timeout=10)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def lease():
    """(kind, pid, age in s by the database's own clock) or None."""
    rows = q("SELECT kind, pid, CAST(strftime('%s','now') AS INTEGER) - beat FROM watcher_lease WHERE id=1")
    return rows[0] if rows else None


def beats():
    return q("SELECT COUNT(*) FROM audit_log WHERE action='budget.heartbeat'")[0][0]


def heartbeat_age():
    """Age of the watcher's last pass as the Budget reads it (it is stale above STALE)."""
    rows = q('SELECT ts FROM budget_watcher WHERE id=1')
    if not rows:
        return None
    text = str(rows[0][0])
    try:
        when = datetime.fromisoformat(text.replace('Z', '+00:00'))
        return datetime.now(timezone.utc).timestamp() - (when if when.tzinfo else when.replace(tzinfo=timezone.utc)).timestamp()
    except ValueError:
        return time.time() - float(text) if text.replace('.', '', 1).isdigit() else None


def pid_of(name):
    return int((STATE / f'{name}-pid.txt').read_text())


def kill(name, hold=False):
    pid = pid_of(name)
    (STATE / f'restart-{name}').write_text('1')                           # BEFORE the kill: the entrypoint relaunches only when it was asked to
    if hold:
        (STATE / f'hold-{name}').write_text('1')
    os.kill(pid, signal.SIGKILL)
    return pid


def bring_back(name, old):
    (STATE / f'hold-{name}').unlink(missing_ok=True)
    wait_for(lambda: pid_of(name) != old, 120, f'the entrypoint to start a new {name}')


def sign_in(browser):
    """A person opens LuveBot: the request reaches the plugin's router, which is what proves THIS process serves it."""
    answer = browser.request.get(DASHBOARD + '/api/plugins/luvebot/session')
    if answer.status == 401:                                               # a new dashboard process: its sessions are its own
        creds = credentials()
        login = browser.request.post(DASHBOARD + '/auth/password-login', data={'provider': 'basic', 'username': creds['username'],
                                                                               'password': creds['password'], 'next': '/'})
        assert login.status == 200, login.text()
        answer = browser.request.get(DASHBOARD + '/api/plugins/luvebot/session')
    assert answer.status == 200, answer.text()


def dashboard_answers(browser):
    try:
        return browser.request.get(DASHBOARD + '/api/status', timeout=3000).status == 200
    except Exception:  # noqa: BLE001  (not up yet)
        return False


def watch(seconds):
    """-> (heartbeat rows written, the leases seen, the oldest heartbeat age seen, the seconds it really took)."""
    first, started, seen, ages = beats(), time.monotonic(), [], []
    while time.monotonic() - started < seconds:
        seen.append(lease())
        age = heartbeat_age()
        if age is not None:
            ages.append(age)
        time.sleep(EVERY)
    return beats() - first, seen, max(ages, default=None), time.monotonic() - started


def one_sequence(rows, took):
    """A single watcher passes every EVERY s (a pass takes a little: fewer rows than the ideal), two would double it."""
    ideal = PASS_ROWS * took / EVERY
    assert 0.5 * ideal <= rows <= 1.4 * ideal, f'{rows} heartbeat rows in {took:.0f} s; one watcher writes about {ideal:.0f}'


def job_state(job_id):
    from hermes_cli.web_server_cron import _call_cron_for_profile
    return next((j for j in _call_cron_for_profile('vendas', 'list_jobs', True) if j.get('id') == job_id), {})


def test_the_hermes_internals_the_serving_check_and_the_lease_read(human_browser):
    plugin()
    """Where Hermes sets what the plugin reads, pinned for THIS tag: both lifespans mark `app.state.event_lock` before they yield; the lifespan is chosen by
    `app.state.gateway_runner`, which the gateway sets; the plugin's router is mounted at import. A Hermes that moves one of them fails here, not in a user's budget."""
    import hermes_cli.web_server as web_server
    import hermes_cli.web_server_app as web_app
    import gateway.run_api as run_api
    tree = ast.parse(inspect.getsource(web_app))
    for name in ('standalone_lifespan', 'http_lifespan'):
        function = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
        marks = [n.lineno for n in ast.walk(function) if isinstance(n, ast.Attribute) and n.attr == 'event_lock' and isinstance(n.ctx, ast.Store)]
        yields = [n.lineno for n in ast.walk(function) if isinstance(n, (ast.Yield, ast.YieldFrom))]
        assert marks and yields and min(marks) < min(yields), f'{name} no longer marks app.state.event_lock before it yields'
    assert 'gateway_runner' in inspect.getsource(web_app), 'the lifespan is no longer chosen by app.state.gateway_runner'
    assert '.app.state.gateway_runner = ' in inspect.getsource(run_api), 'the gateway no longer sets app.state.gateway_runner'
    top = ast.parse(inspect.getsource(web_server)).body
    assert any(isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and getattr(n.value.func, 'id', '') == '_mount_plugin_api_routes' for n in top), \
        'the plugin routes are no longer mounted at import'
    health = get(human_browser, '/health')                                  # this very request reached the router of the dashboard
    assert health.status == 200, health.text()
    watcher = health.json()['watcher']
    from luvebot_backend import hermes_compat
    expected = (True, 'lifespan_ran') if hermes_compat.pinned(hermes_compat.read()[0]) else (None, 'hermes_not_pinned')    # `False` (watcher off) is only ever answered for a pinned build
    assert (watcher['serving'], watcher['reason']) == expected, watcher
    assert set(watcher['lease']) == {'held', 'owner_kind'}, watcher         # never a pid, a host or an owner id


def test_s3_with_the_dashboard_and_the_gateway_up_the_heartbeats_are_one_sequence(human_browser, hosted_by_gateway):
    sign_in(human_browser)
    wait_for(lambda: (lease() or (None, None))[0] == 'dashboard' and lease()[1] == pid_of('dashboard'), 120, 'the dashboard (proven to serve) to hold the lease')
    rows, seen, _, took = watch(30)
    assert {row[0] for row in seen} == {'dashboard'} and {row[1] for row in seen} == {pid_of('dashboard')}, seen   # nobody took it, nobody shared it
    one_sequence(rows, took)


def test_s5_the_owner_dies_the_other_takes_over_and_the_cap_keeps_pausing(human_browser, hosted_by_gateway):
    mine = new_routine(human_browser, MADE, 't-lease-cap')
    assert put(human_browser, '/budget/limits', {'scope': 'bot', 'ref': 'vendas', 'period': 'day', 'cents': 500}).status == 200
    for n in range(3):
        seed_session(f"cron_{mine['id']}_20260101_00000{n}", 1.7)
    wait_for(lambda: job_state(mine['id']).get('state') == 'paused', 60, 'the cap to pause the routine (both up)')
    kill('dashboard', hold=True)                                      # the owner dies without giving the lease up
    killed = time.monotonic()
    ages, takeover = [], None
    while time.monotonic() - killed < EXPIRES + 60:
        age = heartbeat_age()
        ages.append(age if age is not None else 0)
        row = lease()
        if takeover is None and row and row[0] == 'gateway' and row[1] == pid_of('gateway') and row[2] < EVERY + 5:
            takeover = time.monotonic() - killed
        if takeover is not None and time.monotonic() - killed > takeover + 10:
            break
        time.sleep(EVERY)
    assert takeover is not None, f'the gateway did not take the lease: {lease()}'
    assert takeover <= EXPIRES + 20, f'the takeover took {takeover:.0f} s: the lease expires in {EXPIRES} s, plus one pass'
    assert max(ages) < STALE, f'watcher_stale would have lit: the heartbeat was {max(ages):.0f} s old'
    from hermes_cli.web_server_cron import _mutate_cron_for_profile
    _mutate_cron_for_profile('vendas', 'resume_job', mine['id'])            # resumed behind LuveBot's back: the NEW owner pauses it again
    wait_for(lambda: job_state(mine['id']).get('state') == 'paused' or job_state(mine['id']).get('enabled') is False, 60, 'the new owner to pause the job again')


def test_s4_the_dashboard_comes_back_and_takes_the_lease(human_browser, hosted_by_gateway):
    """On a build the harness PINNED (hermes_compat.SERVING_PROVEN) the dashboard is known to serve once its lifespan ran, and takes the lease by itself on its first pass. On any other build
    it is only PROVEN by a request that reaches the plugin's router: up with no request it has no preference, and the gateway keeps the lease until someone opens LuveBot."""
    from luvebot_backend import hermes_compat
    assert (STATE / 'hold-dashboard').exists(), 'S5 (the test above) kills the dashboard and keeps it down for this one'
    bring_back('dashboard', pid_of('dashboard'))                         # the pid file still holds the dead one's
    wait_for(lambda: dashboard_answers(human_browser), 150, 'the new dashboard to answer')
    if not hermes_compat.pinned(hermes_compat.read()[0]):
        time.sleep(2 * EVERY + 2)
        assert (lease() or (None,))[0] == 'gateway', lease()                # up, but nobody asked the plugin anything: not proven to serve, no preference
    else:
        wait_for(lambda: lease()[0] == 'dashboard' and lease()[1] == pid_of('dashboard'), 60, 'the pinned dashboard to take the lease with no request')
    sign_in(human_browser)                                                  # someone opens LuveBot: this process is proven to serve on any build
    wait_for(lambda: lease()[0] == 'dashboard' and lease()[1] == pid_of('dashboard'), 60, 'the dashboard to hold the lease once it serves')
    rows, seen, _, took = watch(20)
    assert {row[0] for row in seen} == {'dashboard'}, seen
    one_sequence(rows, took)


def test_the_gateway_killed_as_the_non_owner_changes_nothing_and_does_not_take_the_lease_back(human_browser, hosted_by_gateway):
    owner = lease()
    assert owner[0] == 'dashboard', owner
    old = kill('gateway')
    rows, seen, _, took = watch(20)
    assert {row[0] for row in seen} == {'dashboard'} and {row[1] for row in seen} == {owner[1]}, seen
    one_sequence(rows, took)
    bring_back('gateway', old)                                              # a new gateway starts a watcher of its own: the lease keeps it out
    rows, seen, _, took = watch(30)
    assert {row[0] for row in seen} == {'dashboard'} and {row[1] for row in seen} == {owner[1]}, seen
    one_sequence(rows, took)
