"""A run whose owner Hermes LOST, for real (contract v0.9 B3). The gateway that owns the run is killed in the middle of a turn and a new one starts (the entrypoint
relaunches it when `restart-gateway` exists: the same home and environment, as a restart policy would give): the new process recovers the turn it did not finish as
`unknown`. This file sorts LAST (`zz`): it restarts the gateway under the other tests.

* the run reads `unknown` (not terminal, kept open) with `resolution.needed`, the admission id and the generation Hermes reports;
* resolving needs a person (a loopback dashboard is refused) and the generation the person SAW (another one is 409 `stale`); the audit keeps the attempt;
* once resolved the lost run is closed (no longer `unknown`) and the Bot takes new work.
Measured on v0.22.5: a NEW turn sent after the restart starts at once; a turn accepted BEFORE it, behind the lost head, stays queued (second test)."""
import os
from pathlib import Path
import signal
import time

import pytest

from support import STATE, plugin
from test_approvals import ask_run, wait_pending
from test_bots import audit_rows, error_of, post
from test_hook import loopback_request, run_async, run_to_end, wait_for
from test_runs import get

MARK = Path('/tmp/luvebot-t30e-allow')                                  # what the scene T30E_ALLOW leaves when its command ran


@pytest.fixture(scope='module')
def main():
    plugin()
    import luvebot_backend.canonical as canonical
    if not canonical.authority('vendas'):
        pytest.skip('this Hermes has no session authority: a lost run is not `unknown` there')


def gateway_pid():
    return int((STATE / 'gateway-pid.txt').read_text())


def kill_and_restart_the_gateway():
    old = gateway_pid()
    (STATE / 'restart-gateway').write_text('1')                          # BEFORE the kill: the entrypoint relaunches only when it was asked to
    os.kill(old, signal.SIGKILL)
    wait_for(lambda: gateway_pid() != old, 120, 'the entrypoint to start a new gateway')


def test_a_run_whose_owner_was_lost_is_resolved_by_a_person(human_browser, main):
    MARK.unlink(missing_ok=True)
    run_id = ask_run(human_browser)                                      # in progress: it waits for a person's approval
    wait_pending(human_browser, run_id)
    kill_and_restart_the_gateway()

    def lost():
        response = get(human_browser, f'/bots/vendas/runs/{run_id}')
        if response.status != 200:
            return None
        run = response.json()['run']
        return run if run['status'] == 'unknown' and run.get('resolution') else None
    run = wait_for(lost, 180, 'the new gateway to recover the run as unknown')
    assert run['resolution']['needed'] is True and isinstance(run['execution_generation'], int), run
    generation = run['execution_generation']
    assert run['resolution']['execution_generation'] == generation

    path = f'/bots/vendas/runs/{run_id}/resolve-unknown'
    stale = post(human_browser, path, {'execution_generation': generation + 1})
    assert stale.status == 409 and error_of(stale)['code'] == 'stale', stale.text()
    module = plugin()
    with pytest.raises(module.PluginError) as refused:                                                              # the machine cannot stand for a person
        run_async(module.resolve_unknown_run('vendas', run_id, loopback_request(module, 'POST', path, body=('{"execution_generation": %d}' % generation).encode())))
    assert refused.value.code == 'loopback_not_human'
    assert get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']['status'] == 'unknown'                  # nothing moved yet

    before = len(audit_rows('run.resolve_unknown'))
    resolved = post(human_browser, path, {'execution_generation': generation})
    assert resolved.status == 200, resolved.text()
    assert resolved.json()['run']['id'] == run_id and resolved.json()['run']['status'] != 'unknown', resolved.text()
    assert [(r[1], r[2]) for r in audit_rows('run.resolve_unknown')[before:]][:2] == [('ok', 'intent'), ('ok', 'result')]
    assert get(human_browser, f'/bots/vendas/runs/{run_id}').json()['run']['status'] != 'unknown'
    again = post(human_browser, path, {'execution_generation': generation})
    assert again.status == 409 and error_of(again)['code'] == 'run_not_unknown', again.text()                       # a second time: it is no longer lost
    _, _, done = run_to_end(human_browser, 'vendas', 'T30E_ALLOW: go')                                              # the Bot takes new work
    assert done['status'] == 'completed' and MARK.exists()
    MARK.unlink(missing_ok=True)


ONCE = Path('/tmp/luvebot-c22-once')                                    # the scene C22_ONCE APPENDS a byte each time its command runs


def run_of(browser, run_id):
    """The run, or None while the API is not answering (the moments right after a restart)."""
    response = get(browser, f'/bots/vendas/runs/{run_id}')
    return response.json()['run'] if response.status == 200 else None


def status_of(browser, run_id):
    run = run_of(browser, run_id)
    return run['status'] if run else None


def test_a_turn_queued_behind_a_lost_run_waits_and_runs_once_when_a_person_resolves_it(human_browser, main):
    """The queue (the Hermes `AdmissionQueued` case): a turn accepted on a session while another is still running waits behind it. When the owner is lost the head is
    `unknown` and the turn stays queued, it does not jump the line and it is not lost; resolving the head frees it, and it runs exactly once."""
    ONCE.unlink(missing_ok=True)
    head = ask_run(human_browser)                                        # holds the session: it waits for a person's approval
    wait_pending(human_browser, head)
    session_id = get(human_browser, f'/bots/vendas/runs/{head}').json()['run']['session_id']
    behind = post(human_browser, '/bots/vendas/runs', {'input': 'C22_ONCE: go', 'session_id': session_id})
    assert behind.status == 202, behind.text()
    queued = behind.json()['run']['id']
    wait_for(lambda: status_of(human_browser, queued) == 'queued', 30, 'the second turn of the session to be queued behind the first')
    assert not ONCE.exists()
    kill_and_restart_the_gateway()

    def lost():
        run = run_of(human_browser, head)
        return run if run and run['status'] == 'unknown' and run.get('resolution') else None
    run = wait_for(lost, 180, 'the new gateway to recover the head as unknown')
    for _ in range(6):                                                   # the queued turn waits: nothing runs behind a head nobody has settled
        time.sleep(3)
        assert status_of(human_browser, queued) == 'queued' and not ONCE.exists(), 'the queued turn ran behind an unresolved lost run'
    resolved = post(human_browser, f'/bots/vendas/runs/{head}/resolve-unknown', {'execution_generation': run['execution_generation']})
    assert resolved.status == 200, resolved.text()
    wait_for(lambda: status_of(human_browser, queued) == 'completed', 120, 'the queued turn to run once the head is resolved')
    time.sleep(5)                                                        # and nothing runs it a second time
    assert ONCE.read_text() == 'x', 'the queued turn ran %d times' % len(ONCE.read_text())
    ONCE.unlink(missing_ok=True)
