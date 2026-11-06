"""`admission_queued` for real (contract v0.9 section 1.6, A-119, R-13): a turn Hermes ACCEPTED and queued while the owner that would run it retires.
WRITTEN FROM THE v0.22.5 SOURCE, NOT RUN against the real stack (the Forja proves it; this file sorts late because it restarts the gateway under the other tests).

What the Hermes code says (read at the tag, gateway/session_api_turn.py `observe_api_turn`, gateway/platforms/api_server_runs.py, api_server.py `_admit_api_agent_request`):
* the case is a turn ADMITTED BEFORE the drain and still waiting (queued behind another turn of the same session) when the owner retires: its waiter is released with
  `runtime_draining` while its row is still `queued`, and Hermes raises `AdmissionQueued` ("Your input is saved and will run once when it is back; do not resend it");
* it is NOT a plain HTTP 503 on the two surfaces LuveBot uses: `POST /v1/runs` answers with the run and its status becomes `queued` with the SSE event `run.queued`; the SESSION
  CHAT STREAM (`/api/sessions/{id}/chat/stream`) has already sent its 200, so the same exception becomes an SSE `error` frame and the run is marked FAILED in Hermes's own memory;
  only the non-streaming JSON surfaces (chat completions, session chat) answer the real 503 `admission_queued`, and LuveBot does not call them;
* a request that ARRIVES during the restart's after-turn wait is another thing: `_admit_api_agent_request` refuses it with a plain retryable 503 `runtime_draining`.
The graceful restart is SIGUSR1 (Hermes's in-band restart: it waits for the turns in flight, then exits; the entrypoint relaunches the gateway because `restart-gateway` exists).

One restart serves every test below: whichever test runs first makes it (`observed()`), keeps what it saw in OBS and the others read it; a scenario that fails midway is a
FAILURE of every test that needs what it did not get (never a skip), so the expected-red test is never hidden behind the first one:
  head  = a run that holds session S1 until THIS test releases it (scene C23_HOLD waits for a file: no clock decides when it ends)
  run   = a second turn on S1 sent through `POST /runs`, queued behind the head       (scene C22_ONCE: it appends a byte each time it runs)
  chat  = a third turn on S1 sent through the chat stream, queued behind them        (the stream stays open until the owner retires)
  new   = a request on ANOTHER session sent after SIGUSR1: refused while draining
What must hold: nothing queued is ever shown as failed or lost, nothing is sent again, each queued turn runs ONCE on the next owner, the person is told it is queued
(our own text, never Hermes's), a refusal during the drain is retryable and releases the message claim.
SUSPECTED DEFECT (from reading the code, to be CONFIRMED by this run): the chat stream's `error` frame is dropped by the relay and its stream closes `upstream_closed`, and the run
the screen follows reads `failed`/`lost` in Hermes's memory while the turn is only queued, which invites a resend (= the work runs twice). Expect `test_the_chat_stream_says_queued...`
red until that is fixed; the run surface is expected green."""
import http.client
import json
import os
import signal
import threading
import time
import uuid
from pathlib import Path

import pytest

from support import API, STATE
from test_bots import DB, audit_rows, csrf, error_of, post
from test_hook import session, wait_for
from test_plugin import PREFIX
from test_runs import get
from test_stream import parse
from test_zz_lost_execution import ONCE, main, status_of  # noqa: F401  (main is a module fixture)

OBS = {}
RELEASE = Path('/tmp/luvebot-c23-release')                                              # the file the scene C23_HOLD waits for
HERMES_TEXT = 'do not resend it'                                                         # Hermes's own sentence: it never reaches the browser
OPEN_OR_DONE = {'queued', 'started', 'running', 'completed'}                              # the only words a queued turn may carry on its way


class ChatStream(threading.Thread):
    """POST /bots/vendas/sessions/{sid}/chat/stream with the human's cookie, read incrementally: the frames, or the refusal."""

    def __init__(self, browser, session_id, text, cid):
        super().__init__(daemon=True)
        self.cookie = '; '.join(f"{c['name']}={c['value']}" for c in browser.cookies())
        self.token = csrf(browser)
        self.path = f'{PREFIX}/bots/vendas/sessions/{session_id}/chat/stream'
        self.body = json.dumps({'input': text, 'client_message_id': cid})
        self.status, self.frames, self.raw, self.error = None, [], b'', None

    def run(self):
        try:
            conn = http.client.HTTPConnection('127.0.0.1', 9119, timeout=420)
            conn.request('POST', self.path, body=self.body, headers={'Cookie': self.cookie, 'X-LuveBot-CSRF': self.token, 'Content-Type': 'application/json'})
            response = conn.getresponse()
            self.status = response.status
            block = b''
            while True:
                line = response.readline()
                if not line:
                    break
                self.raw += line
                block += line
                if line.strip() == b'' and block.strip():
                    if not block.startswith(b':') and self.status == 200:
                        self.frames.extend(parse(block.decode()))
                    block = b''
        except Exception as error:  # noqa: BLE001 - surfaced through .error for the test
            self.error = error


def gateway_pid():
    """The pid the entrypoint wrote, or None while the file is being rewritten in place (a read in between is empty or half a number)."""
    try:
        return int((STATE / 'gateway-pid.txt').read_text().strip())
    except (OSError, ValueError):
        return None


def api_back(browser, timeout=240):
    """The API Server answers again (`/health`) and LuveBot reads the Bot."""
    import urllib.request

    def up():
        try:
            with urllib.request.urlopen(API + '/health', timeout=5) as response:
                ok = response.status == 200
        except Exception:  # noqa: BLE001
            return None
        return ok and get(browser, '/bots/vendas').status == 200
    return wait_for(up, timeout, 'the API Server and LuveBot to answer after the restart')


def scenario(browser):
    """The restart, made once. Everything seen goes into OBS as it is seen; a failure midway is kept in OBS['error'] (and the head is always released)."""
    ONCE.unlink(missing_ok=True)
    RELEASE.unlink(missing_ok=True)
    try:
        s1, s2 = session(browser, 'vendas'), session(browser, 'vendas')
        OBS.update(s1=s1, s2=s2)
        head = post(browser, '/bots/vendas/runs', {'input': 'C23_HOLD: hold the session', 'session_id': s1})
        assert head.status == 202, ('the head was refused', head.status, head.text()[:200])
        head_id = head.json()['run']['id']
        OBS['head_id'] = head_id
        wait_for(lambda: status_of(browser, head_id) in ('started', 'running'), 120, 'the head to run')
        behind = post(browser, '/bots/vendas/runs', {'input': 'C22_ONCE: through runs', 'session_id': s1})
        assert behind.status == 202, ('the run turn was refused', behind.status, behind.text()[:200])
        run_id = behind.json()['run']['id']
        OBS['run_id'] = run_id
        wait_for(lambda: status_of(browser, run_id) == 'queued', 120, 'the second turn of S1 to be queued behind the head')
        cid = 'cm-' + uuid.uuid4().hex
        chat = ChatStream(browser, s1, 'C22_ONCE: through the chat stream', cid)
        chat.start()
        wait_for(lambda: chat.status == 200 and any(f[1] == 'run.started' for f in chat.frames), 120, 'the chat stream to open and say run.started')
        OBS['chat_run'] = next(f[2]['run_id'] for f in chat.frames if f[1] == 'run.started' and isinstance(f[2].get('run_id'), str))
        OBS['cid'] = cid
        assert not ONCE.exists(), 'a turn queued behind the head ran while the head still held the session'     # the head holds until RELEASE: this is the product, not the clock

        old = gateway_pid()
        assert old is not None, 'no gateway pid file'
        (STATE / 'restart-gateway').write_text('1')                                      # BEFORE the signal: the entrypoint relaunches only when it was asked to
        os.kill(old, signal.SIGUSR1)                                                     # Hermes's in-band restart: wait for the turns in flight, then exit

        drain_cid = 'cm-' + uuid.uuid4().hex                                             # a request that ARRIVES during the drain (another session)
        refused = None
        for _ in range(30):
            time.sleep(1)
            attempt = post(browser, f'/bots/vendas/sessions/{s2}/chat/stream', {'input': 'hello', 'client_message_id': drain_cid})
            if attempt.status != 200:
                refused = attempt
                break
            drain_cid = 'cm-' + uuid.uuid4().hex                                         # it was not draining yet: a real turn ran; try a new message
        OBS['refused'] = None if refused is None else (refused.status, error_of(refused) if refused.status >= 400 else None, refused.text()[:300])
        OBS['drain_cid'] = drain_cid
    finally:
        RELEASE.write_text('1')                                                          # the head finishes; the restart that waited for it goes on, whatever happened above

    seen = set()
    deadline = time.monotonic() + 300
    while gateway_pid() in (None, old) and time.monotonic() < deadline:
        seen.add(status_of(browser, run_id))
        time.sleep(1)
    assert gateway_pid() not in (None, old), 'the gateway did not retire and come back'
    api_back(browser)
    chat.join(120)
    OBS.update(seen=seen - {None}, frames=list(chat.frames), chat_status=chat.status, chat_error=chat.error, chat_raw=chat.raw.decode(errors='replace'))
    wait_for(lambda: ONCE.exists() and len(ONCE.read_text()) >= 2, 300, 'both queued turns to run on the next owner')
    time.sleep(8)                                                                        # and nothing runs either of them again
    OBS['once'] = ONCE.read_text()
    OBS['run_final'] = status_of(browser, run_id)
    OBS['head_final'] = status_of(browser, head_id)
    OBS['chat_run_final'] = status_of(browser, OBS['chat_run'])
    OBS['retry'] = post(browser, f'/bots/vendas/sessions/{s2}/chat/stream', {'input': 'hello', 'client_message_id': drain_cid})


def observed(browser):
    """OBS, after the scenario ran ONCE (by whichever test came first). A scenario that broke leaves OBS['error']; the tests that need the rest fail with it."""
    if 'ran' not in OBS:
        OBS['ran'] = True
        try:
            scenario(browser)
        except BaseException as error:  # noqa: BLE001 - kept for every test that needs what was not seen
            OBS['error'] = f'{type(error).__name__}: {str(error)[:400]}'
        finally:
            RELEASE.write_text('1')
            ONCE.unlink(missing_ok=True)
    return OBS


def need(browser, *keys):
    obs = observed(browser)
    missing = [key for key in keys if key not in obs]
    assert not missing, ('the restart scenario did not get as far as these observations', missing, obs.get('error'))
    return obs


def test_the_gateway_retires_with_two_turns_queued_and_a_request_arriving_during_the_drain(human_browser, main):
    obs = observed(human_browser)
    assert 'error' not in obs, obs['error']


def test_the_run_surface_never_shows_a_queued_turn_as_failed_and_it_runs_once(human_browser, main):
    need(human_browser, 'seen', 'run_final', 'head_final', 'once')
    assert OBS['seen'] <= OPEN_OR_DONE, ('a queued turn read as something else while the owner retired', OBS['seen'])
    assert 'queued' in OBS['seen'] or OBS['run_final'] == 'completed', OBS['seen']
    assert OBS['head_final'] == 'completed', ('the head finished during the restart wait', OBS['head_final'])
    assert OBS['run_final'] == 'completed', ('the queued turn runs on the next owner', OBS['run_final'])
    assert OBS['once'] == 'xx', f'each queued turn must run exactly once (two turns, two bytes), got {OBS["once"]!r}'


def test_nothing_was_sent_again_by_luvebot(human_browser, main):
    need(human_browser, 's1', 'once')
    import sqlite3
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute('SELECT COUNT(*) FROM run_index WHERE session_id = ?', (OBS['s1'],)).fetchone()[0]
    finally:
        conn.close()
    assert rows == 3, ('head, the run turn and the chat turn: one row each, none for a resend', rows)
    creates = [r for r in audit_rows('run.create') if r[3] == OBS['s1'] and (r[1], r[2]) == ('ok', 'result')]
    assert len(creates) == 2, ('the head and the run turn were created once each', creates)


def test_the_chat_stream_says_queued_in_our_words_and_the_run_it_follows_is_not_failed(human_browser, main):
    """SUSPECTED DEFECT (see the module docstring): expected RED until the relay turns Hermes's `error` frame for a released queued turn into our `run.queued`."""
    need(human_browser, 'frames', 'chat_status', 'chat_error', 'chat_raw', 'chat_run_final')
    assert OBS['chat_error'] is None and OBS['chat_status'] == 200, (OBS['chat_status'], OBS['chat_error'])
    names = [f[1] for f in OBS['frames']]
    assert 'luvebot.error' not in names, ('a queued turn must not read as an error', names)
    queued = [f for f in OBS['frames'] if f[1] == 'run.queued']
    assert queued and queued[0][2].get('code') == 'run_queued' and queued[0][2].get('status') == 'queued', ('the person must be told it is queued', names)
    assert HERMES_TEXT not in OBS['chat_raw'], "Hermes's own sentence must not reach the browser"
    # a chat run id is an in-memory handle of Hermes: it does not survive the restart (404, None here), so it is never followed to a result; what it must never be is a FAILURE. The turn itself ran once (above).
    assert OBS['chat_run_final'] in (None, 'completed', 'queued'), ('the run the screen follows must not read failed, lost or unknown', OBS['chat_run_final'])


def test_a_request_that_arrives_while_draining_is_a_retryable_refusal_and_its_claim_is_released(human_browser, main):
    need(human_browser, 'refused', 'retry')
    assert OBS['refused'] is not None, 'no request was refused during the drain: the restart did not drain, or it ended before the probe'
    status, error, text = OBS['refused']
    assert status == 503 and error and error['code'] == 'hermes_draining', ('a plain retryable refusal, in words', status, text)
    assert HERMES_TEXT not in text
    retry = OBS['retry']                                                                 # after the restart the SAME message goes through: the refusal released the claim
    assert retry.status == 200, ('the refused message was claimed and cannot be sent again', retry.status, retry.text()[:200])
    assert '"reason":"completed"' in retry.text().replace(' ', ''), 'the retried turn ran to the end'
