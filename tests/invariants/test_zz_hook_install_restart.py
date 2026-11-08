"""The gateway restarted RIGHT AFTER the hook was installed: does the API Server come back? (step 6c of the VPS roteiro)
WRITTEN, NOT RUN against the real stack (the Forja proves it). Installing a plugin makes Hermes's plugin manager (PM) build a runtime environment of its own, and the
NEXT start of the gateway adopts it in place of the main one; the Forja saw, on his native checkout, that environment come out WITHOUT `aiohttp`, so the restarted
gateway had no API Server at all (no conversation, no approval for that Bot: `aiohttp not installed` in gateway.log). On an installation made by Hermes's installer the
environment should be complete, but that is not proved: this test is what proves it, the same way the roteiro does by hand (`curl /health` on the Bot's API Server port,
the Bot not offline in LuveBot, a new conversation answering).

The sequence is the VPS one: a Bot WITHOUT the hook (made by Hermes's own route) -> the hook installed through the route the screen's button uses -> the gateway stopped
and started again (SIGTERM, as `hermes gateway stop` does; the entrypoint supervisor relaunches it with the same home and environment because `restart-gateway` exists) ->

* the API Server answers `GET /health` with `{"status": "ok", "platform": "hermes-agent"}` (no key needed, the roteiro's own check);
* the Bot is not offline in LuveBot and its hook reads `live` (loaded by the restarted gateway);
* a new conversation answers.
When the API Server does not come back, the failure names the line the roteiro tells a person to look for (`aiohttp` in the gateway log).

SKIPPED on the native macOS lane (V1 of the review of r47): the entrypoint wipes `home/installs` before it relaunches the gateway there (a checkout that is not a blessed install builds
that environment without the extras, which is exactly what 6c is afraid of), so a green on that lane would NOT prove 6c, only the restart mechanics. It runs in the container (its install is
complete) or on a blessed install, and only a run there is a proof."""
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request

import pytest

from support import API, STATE
from test_bots import post
from test_hook import ROOT_HOME, bot_hook, enabled_of, native_bot, run_to_end, wait_for, wait_live  # noqa: F401  (native_bot is a fixture)
from test_runs import get

GATEWAY_LOG = ROOT_HOME / 'logs' / 'gateway.log'


def gateway_pid():
    """The pid the entrypoint wrote, or None while the file is being rewritten in place (truncated and written: a read in between is empty or half a number)."""
    try:
        return int((STATE / 'gateway-pid.txt').read_text().strip())
    except (OSError, ValueError):
        return None


def health():
    """The roteiro's `curl -s -m 5 /health` -> the parsed body, or the reason there is none."""
    try:
        with urllib.request.urlopen(API + '/health', timeout=5) as response:
            return response.status, json.loads(response.read().decode() or '{}')
    except (urllib.error.URLError, OSError, ValueError) as error:
        return None, f'{type(error).__name__}: {error}'


def log_size():
    try:
        return GATEWAY_LOG.stat().st_size
    except OSError:
        return 0


def aiohttp_lines(since=0):
    """What the roteiro tells a person to grep (`aiohttp` in the gateway log), the last few, of what was written AFTER byte `since` (an `aiohttp not installed` line of an earlier restart of
    the same run must not fail a good one; a log that is shorter than `since` was rotated: read it all)."""
    try:
        data = GATEWAY_LOG.read_bytes()
    except OSError:
        return ['(no gateway.log at ' + str(GATEWAY_LOG) + ')']
    text = data[since:] if len(data) >= since else data
    return [line for line in text.decode(errors='replace').splitlines() if 'aiohttp' in line][-3:]


def test_the_api_server_comes_back_after_the_gateway_restarts_right_after_the_hook_install(human_browser, native_bot):
    if sys.platform == 'darwin':
        pytest.skip('the native macOS lane wipes home/installs before it relaunches the gateway, so a green here would not prove step 6c: run it in the container or on a blessed install')
    assert enabled_of(native_bot) == [], 'the Bot starts without the hook'
    installed = post(human_browser, f'/bots/{native_bot}/hook/install', {})                  # the route behind the screen's "Atualizar o hook deste Bot"
    assert installed.status == 200, installed.text()
    assert installed.json()['changed'] is True and enabled_of(native_bot) == ['luvebot-hook']

    old = gateway_pid()
    assert old is not None, 'no gateway pid file'
    since = log_size()                                                                       # only what the restarted gateway writes counts
    (STATE / 'restart-gateway').write_text('1')                                              # BEFORE the stop: the entrypoint relaunches only when asked to
    os.kill(old, signal.SIGTERM)                                                             # `hermes gateway stop`
    wait_for(lambda: gateway_pid() not in (None, old), 180, 'the entrypoint to start a new gateway')

    deadline = time.monotonic() + 240
    last = None
    while time.monotonic() < deadline:
        last = health()
        if last[0] == 200 and isinstance(last[1], dict) and last[1].get('status') == 'ok':
            break
        time.sleep(2)
    else:
        pytest.fail(f'the API Server did not come back after the restart (roteiro 6c): last /health = {last!r}; aiohttp lines in gateway.log (this restart) = {aiohttp_lines(since)!r}')
    assert last[1].get('platform') == 'hermes-agent', last

    bot = wait_for(lambda: get(human_browser, f'/bots/{native_bot}').json() if get(human_browser, f'/bots/{native_bot}').status == 200 else None, 120,
                   f'{native_bot} to be read again by LuveBot')
    assert bot['status'] != 'offline', ('the Bot reads offline after the restart', bot['status'])
    wait_live(human_browser, native_bot, 180)                                                # the restarted gateway loaded the hook
    assert bot_hook(human_browser, native_bot)['status'] == 'live'
    _, _, done = run_to_end(human_browser, native_bot, 'hello')                              # "uma conversa nova responde"
    assert done['status'] == 'completed', done
    assert not [line for line in aiohttp_lines(since) if 'not installed' in line], aiohttp_lines(since)
