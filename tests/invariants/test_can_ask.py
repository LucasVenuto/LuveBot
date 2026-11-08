"""`can_ask` of GET /bots/{bot} (contract v0.9 12, A-129) against the REAL Hermes v0.22.5: it says whether the Bot can ask a person a question, from the toolsets
the RUNNING api_server reports (`GET /p/<bot>/v1/toolsets`, which merges Hermes's defaults through `load_config()`), while what the Bot really does is decided
by the gateway's own config read (`_load_gateway_config()`, gateway/run.py, no merge). Only a real Hermes shows that the two agree on `clarify`:

* a Bot whose api_server toolset has `clarify`: `can_ask` is true AND the Bot asks (a `waiting` row of kind clarify, the same wait the Today screen shows);
* a Bot whose api_server toolset is a list WITHOUT `clarify`: `can_ask` is false AND it never asks (the run just ends);
* a Bot whose config names no api_server toolsets at all (the merge case): whatever `can_ask` says, the Bot does exactly that (true -> asks, false -> never asks); a
  field that is absent is also allowed (not told), never a wrong answer;
* without the session authority the field is absent (skipped here: v0.22.5 has the authority; it runs on a Hermes without it).
The profile `default` is the one rewritten (its config.yaml, put back afterwards); `vendas` keeps the harness config (with `clarify`)."""
import re
import sqlite3
import time

import pytest

from support import plugin
from test_bots import DB, post
from test_hook import ROOT_HOME, loopback_request, run_async, session, wait_for, wait_live
from test_runs import get, wait_run

PROMPT = 'G_CLARIFY_TEXT: ask me'
CONFIG = {'default': ROOT_HOME / 'config.yaml', 'vendas': ROOT_HOME / 'profiles' / 'vendas' / 'config.yaml'}


def read_config(bot):
    import hermes_yaml as yaml
    return yaml.safe_load(CONFIG[bot].read_text()) or {}


def write_config(bot, data):
    import hermes_yaml as yaml
    CONFIG[bot].write_text(yaml.safe_dump(data))


@pytest.fixture
def config_back():
    """Whatever a test writes to a profile's config.yaml is put back exactly."""
    saved = {bot: path.read_text() for bot, path in CONFIG.items()}
    yield
    for bot, text in saved.items():
        CONFIG[bot].write_text(text)


def set_api_server_toolsets(bot, toolsets):
    """A list: that is the api_server toolset; None: the key is not in the config at all."""
    data = read_config(bot)
    if toolsets is None:
        data.pop('platform_toolsets', None)
    else:
        data['platform_toolsets'] = {'api_server': toolsets}
    write_config(bot, data)


def can_ask_of(browser, bot):
    response = get(browser, f'/bots/{bot}')
    assert response.status == 200, response.text()
    body = response.json()
    return body.get('can_ask', 'absent')


def waiting_rows(bot, since):
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM hook_events WHERE profile=? AND verdict='waiting' AND id>? AND tool LIKE 'human_input:%' ORDER BY id",
                                              (bot, since))]
    finally:
        conn.close()


def last_id():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT COALESCE(MAX(id), 0) FROM hook_events').fetchone()[0]
    finally:
        conn.close()


def does_the_bot_ask(browser, bot, wait=25):
    """Run the clarify scene on the Bot: True when it really asks (a waiting row), False when the run simply ends without asking."""
    wait_live(browser, bot)
    before = last_id()
    started = post(browser, f'/bots/{bot}/runs', {'input': PROMPT, 'session_id': session(browser, bot)})
    assert started.status == 202, started.text()
    run_id = started.json()['run']['id']
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        rows = waiting_rows(bot, before)
        if rows:
            assert rows[0]['tool'] == 'human_input:clarify' and re.fullmatch(r'[0-9a-f]{32}', rows[0]['tool_call_id'])
            post(browser, f'/bots/{bot}/runs/{run_id}/stop', {})
            wait_run(browser, bot, run_id, {'completed', 'failed', 'cancelled'})
            return True
        run = get(browser, f'/bots/{bot}/runs/{run_id}').json()['run']
        if run['status'] in ('completed', 'failed', 'cancelled'):
            return bool(waiting_rows(bot, before))
        time.sleep(0.5)
    post(browser, f'/bots/{bot}/runs/{run_id}/stop', {})
    return bool(waiting_rows(bot, before))


def wait_can_ask(browser, bot, want, timeout=90):
    return wait_for(lambda: can_ask_of(browser, bot) == want or None, timeout, f'can_ask of {bot} to read {want!r}; last={can_ask_of(browser, bot)!r}')


def test_a_bot_with_clarify_in_its_api_server_toolset_can_ask_and_does(human_browser):
    assert can_ask_of(human_browser, 'vendas') is True                                    # the harness config has `clarify` for the api_server
    assert does_the_bot_ask(human_browser, 'vendas') is True


def test_a_bot_whose_toolset_has_no_clarify_cannot_ask_and_never_does(human_browser, config_back):
    set_api_server_toolsets('default', ['terminal', 'file', 'kanban'])
    wait_can_ask(human_browser, 'default', False)
    assert does_the_bot_ask(human_browser, 'default') is False                           # the execution agrees: nothing to answer, the run ends


def test_a_bot_with_no_api_server_toolsets_in_its_config_does_what_can_ask_says(human_browser, config_back):
    """The merge case: `GET /v1/toolsets` fills the missing key from Hermes's defaults, the gateway's own read does not."""
    set_api_server_toolsets('default', None)
    time.sleep(3)                                                                         # the process reads its config again
    said = can_ask_of(human_browser, 'default')                                           # True, False, or 'absent' (not told)
    asked = does_the_bot_ask(human_browser, 'default')
    print(f'MERGE CASE: can_ask={said!r} the Bot asks={asked!r}')
    if said in (True, False):
        assert said is asked, f'can_ask said {said!r} but the Bot {"asks" if asked else "never asks"}'


def test_without_the_session_authority_the_field_is_absent(human_browser):
    """On a Hermes WITHOUT the authority (v0.22.2 or older) the field is absent: a question reaches LuveBot there through the old format, not `pending_controls`, and
    the screen says nothing it cannot back. v0.22.5 has the authority and the v0.22.2 stack was not mounted, so on it the SAME route runs IN THIS PROCESS (the real
    `get_bot`, the real api_server and its real `/v1/toolsets`) with ONE thing changed: the capabilities read for the authority are the real ones minus the flag
    `features.run_unknown_resolution`, which is exactly how an old Hermes differs there. Not a real v0.22.2 (its other differences are not simulated); what it proves is that
    the field's presence follows that one flag and nothing else, with a control (the real capabilities give `can_ask: true` for the same Bot a moment later)."""
    module = plugin()
    import luvebot_backend.canonical as canonical
    if not canonical.authority('vendas'):
        assert can_ask_of(human_browser, 'vendas') == 'absent'                             # a real old Hermes: the route over HTTP
        return
    real = canonical._capabilities

    def old_hermes(bot):
        caps = real(bot)
        return {**caps, 'features': {k: v for k, v in (caps.get('features') or {}).items() if k != canonical.FLAG}}

    def read_bot():
        module._EPOCH[0] += 1                                                              # nothing remembered by this process answers for the next read
        canonical._flag.clear()
        return run_async(module.get_bot('vendas', loopback_request(module, 'GET', '/bots/vendas')))
    canonical._capabilities = old_hermes
    try:
        simulated = read_bot()
    finally:
        canonical._capabilities = real
        canonical._flag.clear()
    assert 'can_ask' not in simulated, ('without the authority flag the field must be absent', simulated.get('can_ask'))
    assert simulated['name'] == 'vendas' and simulated.get('status'), 'the rest of the Bot is still there'
    assert read_bot().get('can_ask') is True                                               # the control: the real capabilities, the same Bot, the field is back
