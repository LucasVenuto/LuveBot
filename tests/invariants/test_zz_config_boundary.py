"""P1-5 (a) / contract v0.10 section 1, on the REAL Hermes v0.22.5: what LuveBot does when Hermes's config read raises `ConfigBackendUnavailable` (a `SystemExit`: Hermes `main` raises it
when a remote config backend does not answer; nothing on v0.22.5 ever does, so a stand-in is raised from a patched `load_config`).

The stand-in is a tiny dashboard plugin the test installs (`zz_outage`: its api file patches `hermes_cli.config.load_config` and `read_raw_config`, and raises ONLY when the call comes
from LuveBot's code, so Hermes's own gate and routes keep working: this is an outage the plugin has to survive, not one that takes Hermes down). The flag file `config-outage` in the
stack's state folder turns it on: `unavailable` raises a class NAMED `ConfigBackendUnavailable(SystemExit)`, `exit` raises a plain `SystemExit(3)` (a helper that calls `sys.exit()`).
This file sorts last (`zz`): it restarts the dashboard to mount the stand-in and, in the last test, kills it on purpose (the entrypoint relaunches it).

* a route (GET /bots/{bot}: `detail_extras` reaches the config in a worker thread, in a child task and in a Hermes route awaited on the loop) answers `503 config_backend_unavailable`;
* the DASHBOARD PROCESS keeps serving: the same pid answers before, during and after (the claim: a `SystemExit` that reaches an asyncio task would stop the event loop);
* the budget watcher keeps (or resumes) its heartbeat after the outage. MEASURED on v0.22.5: its pass never reads the config (the stand-in logged no raise from the watcher's thread, and
  it wrote heartbeats at the normal rate through the whole outage), so on this Hermes the outage cannot reach it; the tick's own guard (a failed pass sends none and gives the lease up) is
  what the unit tests prove;
* a plain `sys.exit()` is NOT converted into the outage and not swallowed (the answer is neither 200 nor the 503; the server decides what else happens)."""
import os
import shutil
import time

import pytest

from support import DASHBOARD, STATE
from test_can_ask import read_config, write_config
from test_hook import ROOT_HOME, wait_for
from test_runs import get
from test_zz_watcher_lease import beats, bring_back, dashboard_answers, kill, pid_of, sign_in

SEAM = ROOT_HOME / 'plugins' / 'zz_outage'
FLAG = STATE / 'config-outage'
CODE = 'config_backend_unavailable'

MANIFEST = '{"name": "zz_outage", "label": "zz outage", "description": "harness stand-in for a config backend outage", "version": "0.0.0", "has_api": true, "api": "plugin_api.py"}\n'

API = '''import os
import sys
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()
FLAG = Path(os.environ["HARNESS_STATE"]) / "config-outage"


class ConfigBackendUnavailable(SystemExit):   # the stand-in: recognised by NAME through the MRO, as Hermes main's class is
    pass


def from_luvebot():
    frame = sys._getframe(2)
    while frame is not None:
        if "/plugins/luvebot/" in frame.f_code.co_filename:
            return True
        frame = frame.f_back
    return False


def outage():
    try:
        mode = FLAG.read_text().strip()
    except OSError:
        return
    if mode and from_luvebot():
        try:   # where it was raised from, kept next to the stack's logs: the evidence of WHICH path reached the config
            import threading
            import traceback
            with open(Path(os.environ["HARNESS_STATE"]) / "logs" / "outage-raise.log", "a") as handle:
                handle.write("---- " + mode + " thread=" + threading.current_thread().name + "\\n" + "".join(traceback.format_stack(limit=30)[:-2]) + "\\n")
        except Exception:
            pass
        raise (ConfigBackendUnavailable(3) if mode == "unavailable" else SystemExit(3))


def install():
    import hermes_cli.config as config
    if getattr(config, "_zz_outage", False):
        return
    load, raw = config.load_config, config.read_raw_config

    def load_config(*args, **kwargs):
        outage()
        return load(*args, **kwargs)

    def read_raw_config(*args, **kwargs):
        outage()
        return raw(*args, **kwargs)
    config.load_config, config.read_raw_config, config._zz_outage = load_config, read_raw_config, True


install()


@router.get("/ping")
def ping():
    return {"ok": True}
'''


def note(line):
    """One line with the time, kept next to the stack's logs (logs/c1-timeline.txt): what the proof saw, and when."""
    print(line)
    try:
        with open(STATE / 'logs' / 'c1-timeline.txt', 'a') as handle:
            handle.write(time.strftime('%H:%M:%S ') + line + '\n')
    except OSError:
        pass


def error_code(response):
    try:
        return (response.json().get('error') or {}).get('code')
    except Exception:  # noqa: BLE001
        return None


def restart_dashboard(browser):
    bring_back('dashboard', kill('dashboard'))
    wait_for(lambda: dashboard_answers(browser) or None, 120, 'the dashboard to answer after its restart')
    sign_in(browser)


def recover(browser):
    """Whatever the test before did to the dashboard (a death on a tree without the fix), the next one starts on a dashboard that answers and a session that is valid: the entrypoint
    relaunches it only when asked to, so the flag is written BEFORE every test that could take it down."""
    (STATE / 'restart-dashboard').write_text('1')
    wait_for(lambda: dashboard_answers(browser) or None, 120, 'the dashboard to answer')
    sign_in(browser)


@pytest.fixture(scope='module')
def seam(human_browser):
    """Install the stand-in plugin, enable it in the config, restart the dashboard so it mounts it; put everything back at the end (and restart once more)."""
    saved = (ROOT_HOME / 'config.yaml').read_text()
    SEAM.joinpath('dashboard').mkdir(parents=True, exist_ok=True)
    (SEAM / 'dashboard' / 'manifest.json').write_text(MANIFEST)
    (SEAM / 'dashboard' / 'plugin_api.py').write_text(API)
    data = read_config('default')
    data.setdefault('plugins', {}).setdefault('enabled', []).append('zz_outage')
    write_config('default', data)
    FLAG.unlink(missing_ok=True)
    restart_dashboard(human_browser)
    wait_for(lambda: human_browser.request.get(DASHBOARD + '/api/plugins/zz_outage/ping').status == 200 or None, 60, 'the stand-in to be mounted')
    yield
    FLAG.unlink(missing_ok=True)
    (ROOT_HOME / 'config.yaml').write_text(saved)
    shutil.rmtree(SEAM, ignore_errors=True)
    restart_dashboard(human_browser)


def test_a_route_answers_503_and_the_dashboard_keeps_serving(human_browser, seam):
    recover(human_browser)
    before = pid_of('dashboard')
    assert get(human_browser, '/bots/vendas').status == 200
    FLAG.write_text('unavailable')
    try:
        answers = [get(human_browser, '/bots/vendas') for _ in range(3)]
        assert [a.status for a in answers] == [503, 503, 503], [(a.status, a.text()[:160]) for a in answers]
        assert [error_code(a) for a in answers] == [CODE] * 3
        assert all('request_id' in a.text() for a in answers)
        assert dashboard_answers(human_browser), 'the dashboard stopped serving while the config was out'
    finally:
        FLAG.unlink(missing_ok=True)
    after = get(human_browser, '/bots/vendas')
    assert after.status == 200, (after.status, after.text()[:200])                  # back to normal as soon as the backend is back
    assert pid_of('dashboard') == before, 'the dashboard process was replaced: the SystemExit reached the event loop'


def test_the_budget_watcher_keeps_its_heartbeat_after_the_outage(human_browser, seam):
    """During the outage a failed pass sends no heartbeat (and gives the lease up); after it the loop is alive and beats again: it did not end for good. The test first waits until the
    watcher is beating steadily (a dashboard that was just restarted waits for the old owner's lease to run out), so what it measures is the outage and not the boot."""
    recover(human_browser)
    wait_for(lambda: True if beats() - beats_then(6) >= 2 else None, 150, 'a steady heartbeat before the outage')
    note(f'WATCHER before: beats={beats()}')
    FLAG.write_text('unavailable')
    time.sleep(12)                                                                  # four passes at LUVEBOT_WATCH_EVERY=3 s
    during = beats()
    time.sleep(9)
    quiet = beats() - during
    FLAG.unlink(missing_ok=True)
    resumed_from = beats()
    note(f'WATCHER outage over: heartbeats in its last 9 s={quiet}, beats={resumed_from}')
    wait_for(lambda: beats() > resumed_from + 2 or None, 60, 'the watcher to beat again after the outage')
    note(f'WATCHER resumed: beats={beats()}')
    assert dashboard_answers(human_browser)


def beats_then(seconds):
    """Heartbeat rows as they were `seconds` ago, so `beats() - beats_then(6) >= 2` says the watcher wrote something in the last 6 s."""
    from test_zz_watcher_lease import q
    return q("SELECT COUNT(*) FROM audit_log WHERE action='budget.heartbeat' AND ts <= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)", f'-{seconds} seconds')[0][0]


def plain_exit_request(browser):
    """GET /bots/vendas while a PLAIN `SystemExit(3)` (not the outage) comes out of LuveBot's config read -> ('answered', status, code) or ('dropped', error name). The flag is always taken down."""
    FLAG.write_text('exit')
    try:
        answer = get(browser, '/bots/vendas')
        found = ('answered', answer.status, error_code(answer), answer.text()[:200])
    except (ConnectionError, OSError) as error:     # the process went away with it, or never answered
        found = ('dropped', type(error).__name__, None, '')
    finally:
        FLAG.unlink(missing_ok=True)
    note(f'PLAIN EXIT: {found[:3]}')
    return found


def test_a_plain_sys_exit_is_never_turned_into_the_outage(human_browser, seam):
    """A `SystemExit` that is NOT the config outage is never converted into it and never swallowed (A-133): out of the boundary's worker thread it is a `502 hermes_exited` (P1-8: converted
    IN the worker, no code or text of the exit) and the dashboard answers right after, on the same process. (Before P1-8 the answer was a timeout and a dashboard that stayed alive but
    mute in most runs; the test below repeats this RUNS times.)"""
    recover(human_browser)
    before = pid_of('dashboard')
    kind, status, code, text = plain_exit_request(human_browser)
    assert (kind, status, code) == ('answered', 502, 'hermes_exited'), (kind, status, code, text)
    assert code != CODE and status != 503 and status != 200
    assert dashboard_answers(human_browser) and pid_of('dashboard') == before, 'the dashboard did not answer right after, or it is another process'


RUNS = int(os.environ.get('P19_RUNS', '10'))


def test_a_plain_sys_exit_out_of_the_worker_is_a_502_hermes_exited_every_time_and_the_next_request_answers(human_browser, seam):
    """P1-9 (after P1-8): the plain `SystemExit(3)` that comes out of the boundary's worker thread, RUNS times in a row (10 by default; P19_RUNS=n): each one answers `502 hermes_exited` within a
    few seconds (not a timeout, not a 500, not the outage's 503) and the request right after it answers 200, on the SAME dashboard process. Before P1-8 the same exit left the dashboard
    unable to answer in most runs (see the test above); the rows go to logs/c1-timeline.txt either way, and a run stops looking after 5 minutes."""
    recover(human_browser)
    pid, rows, deadline = pid_of('dashboard'), [], time.monotonic() + 300
    for n in range(RUNS):
        if time.monotonic() > deadline:
            break
        FLAG.write_text('exit')
        started = time.monotonic()
        try:
            answer = get(human_browser, '/bots/vendas')
            first = (answer.status, error_code(answer), round(time.monotonic() - started, 1))
        except (ConnectionError, OSError) as error:
            first = ('dropped', type(error).__name__, round(time.monotonic() - started, 1))
        finally:
            FLAG.unlink(missing_ok=True)
        started = time.monotonic()
        try:
            second = (get(human_browser, '/bots/vendas').status, round(time.monotonic() - started, 1))
        except (ConnectionError, OSError) as error:
            second = ('dropped', round(time.monotonic() - started, 1))
        rows.append((first, second))
        note(f'P1-9 run {n + 1}/{RUNS}: first={first} next={second}')
    note(f'P1-9 same process={pid_of("dashboard") == pid}, runs done={len(rows)}')
    assert len(rows) == RUNS, ('the runs did not finish in 5 minutes', len(rows))
    assert all(first[0] == 502 and first[1] == 'hermes_exited' and first[2] < 10 for first, _ in rows), rows
    assert all(second[0] == 200 for _, second in rows), rows
    assert pid_of('dashboard') == pid, 'the dashboard process was replaced'
