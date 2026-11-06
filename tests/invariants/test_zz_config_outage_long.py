"""C1c (plan v0.3 4.3 and contract v0.10 section 1): what happens to LuveBot's budget watcher and to new work after a LONG outage of the config backend on Hermes `main`, with the panel and the
gateway under a supervisor.

On main a config outage is fatal for Hermes itself (`ConfigBackendUnavailable` is a SystemExit on purpose): the gateway's tasks die in under a second, the processes go, and at every boot they
die again until the service is back. The harness entrypoint plays the supervisor with `restart-always` (systemd's `Restart=always`). The test turns the outage on (the forja test backend,
HERMES_CONFIG_BACKEND=forja), keeps it for C1C_OUTAGE_SECONDS (330 by default: longer than the 300 s after which the `Budget` refuses new work and `watcher_stale` lights), samples the
stack every 10 s, turns it off and records, with times, how the stack comes back: the panel answering, the watcher's first heartbeat, GET /health (its problems), and the first new run accepted.
The timeline is in logs/c1c-timeline.txt. It asserts the DESIGN, which the plan said was never measured: the panel comes back, the watcher beats again, `watcher_stale` goes away and a new run
is accepted again. It runs only with the forja backend selected (main)."""
import os
import socket
import time

import pytest

from support import DASHBOARD, STATE
from test_bots import post
from test_hook import ROOT_HOME, session, wait_for
from test_runs import get
from test_zz_watcher_lease import dashboard_answers, heartbeat_age, lease, pid_of, sign_in

pytestmark = pytest.mark.skipif(os.environ.get('HERMES_CONFIG_BACKEND') != 'forja', reason='needs Hermes main with the forja test config backend selected (HERMES_CONFIG_BACKEND=forja)')

OUTAGE = STATE / 'config-outage'
ALWAYS = STATE / 'restart-always'
OUTAGE_S = int(os.environ.get('C1C_OUTAGE_SECONDS', '330'))
BACK_S = 300                                                   # how long after the outage the stack gets to come back


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'c1c-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def port_open():
    host, port = DASHBOARD.split('//')[1].split(':')
    try:
        with socket.create_connection((host, int(port)), timeout=1):
            return True
    except OSError:
        return False


def pids():
    out = {}
    for name in ('gateway', 'dashboard'):
        try:
            out[name] = pid_of(name)
        except (OSError, ValueError):
            out[name] = None
    return out


def health_problems(browser):
    try:
        answer = get(browser, '/health')
        if answer.status != 200:
            return ('http', answer.status)
        body = answer.json()
        return ('ok' if body.get('ok') else 'not ok', sorted(p.get('code') for p in body.get('problems', [])), (body.get('watcher') or {}).get('lease'))
    except Exception as error:  # noqa: BLE001
        return ('error', type(error).__name__)


def test_the_stack_and_the_watcher_come_back_after_a_long_outage(human_browser):
    sign_in(human_browser)
    wait_for(lambda: (heartbeat_age() or 999) < 20 or None, 90, 'a steady heartbeat before the outage')
    note(f'C1c start: heartbeat age {heartbeat_age():.0f} s, lease {lease()}, pids {pids()}; outage of {OUTAGE_S} s with a restart-always supervisor')
    ALWAYS.write_text('1')
    OUTAGE.write_text('1')
    began, restarts, last = time.monotonic(), set(), None
    try:
        while time.monotonic() - began < OUTAGE_S:
            time.sleep(10)
            now = pids()
            restarts.add(tuple(now.items()))
            age = heartbeat_age()
            note(f'C1c outage +{time.monotonic() - began:.0f}s: panel port open={port_open()} heartbeat age={age if age is None else round(age)} s pids={now}')
    finally:
        OUTAGE.unlink(missing_ok=True)
    note(f'C1c outage over after {time.monotonic() - began:.0f} s; distinct pid sets seen during it={len(restarts)}')
    over, seen = time.monotonic(), {}
    run_status = None
    while time.monotonic() - over < BACK_S:
        time.sleep(5)
        t = time.monotonic() - over
        if 'panel' not in seen and dashboard_answers(human_browser):
            seen['panel'] = t
            note(f'C1c +{t:.0f}s: the panel answers again (pids {pids()})')
        if 'panel' in seen:
            try:
                sign_in(human_browser)
            except BaseException:  # noqa: BLE001  (the new process may not serve the plugin yet)
                continue
            age = heartbeat_age()
            if 'beat' not in seen and age is not None and age < 15:
                seen['beat'] = t
                note(f'C1c +{t:.0f}s: the watcher beats again (heartbeat age {age:.0f} s, lease {lease()})')
            problems = health_problems(human_browser)
            if seen.get('last_health') != problems:
                seen['last_health'] = problems
                note(f'C1c +{t:.0f}s: GET /health -> {problems}')
            if 'run' not in seen and 'beat' in seen:
                try:
                    started = post(human_browser, '/bots/vendas/runs', {'input': 'olá', 'session_id': session(human_browser, 'vendas')})
                    run_status = (started.status, (started.json().get('error') or {}).get('code') if started.status >= 400 else 'accepted')
                except BaseException as error:  # noqa: BLE001
                    run_status = ('error', type(error).__name__)
                if run_status[0] == 202:
                    seen['run'] = t
                    note(f'C1c +{t:.0f}s: a new run is accepted again')
                    break
    ALWAYS.unlink(missing_ok=True)
    note(f'C1c summary: {seen} last run attempt {run_status}')
    assert 'panel' in seen, f'the panel did not come back within {BACK_S} s of the outage ending'
    assert 'beat' in seen, 'the watcher did not beat again'
    assert 'run' in seen, f'no new run was accepted (last attempt {run_status}; health {seen.get("last_health")})'
