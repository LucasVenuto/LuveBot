"""ADR-006 D2b against the real dashboard: Hermes appends `?profile=<selector>` to every plugin call and, on a Hermes that serves plugins per
profile, a selector on another profile sends the call to that profile's plugin host. LuveBot lives in the launch profile's process and takes
its Bot from the PATH, so every route answers only for none, `current` and the launch profile's own name; anything else is
`400 profile_param_not_supported`, before any handler runs (no effect, no audit row, no echo of the value)."""
import pytest

from support import DASHBOARD
from test_plugin import PREFIX

GETS = ('/health', '/session', '/bots', '/bots/vendas', '/bots/vendas/approval-surface', '/bots/vendas/free-passes', '/costs')


def launch_profile(browser):
    response = browser.request.get(DASHBOARD + '/api/profiles/active')
    assert response.status == 200, response.text()
    return response.json()['current']


# A foreign `?profile=` is refused. Hermes (v0.22.5) sends one that names a REAL Bot with this plugin enabled to that Bot's plugin host BEFORE our route runs, and
# the host refuses (409 luvebot_needs_in_process: LuveBot runs in the dashboard process only); a name that is no Bot reaches our route (400 profile_param_not_supported).
ALLOWED = {False: ((400, 'profile_param_not_supported'),), True: ((400, 'profile_param_not_supported'), (409, 'luvebot_needs_in_process'))}


@pytest.mark.parametrize('value', ['vendas', 'other', 'CURRENT', ' current', 'current\n', 'default/../x', 'a' * 70, '%00'])
def test_a_foreign_profile_param_is_a_400_on_every_route_and_is_not_echoed(human_browser, value):
    from urllib.parse import quote
    launch = launch_profile(human_browser)
    if value == launch:
        pytest.skip('the launch profile is answered')
    for path in GETS:
        response = human_browser.request.get(DASHBOARD + PREFIX + path + '?profile=' + quote(value, safe=''))
        assert (response.status, response.json()['error']['code']) in ALLOWED[value == 'vendas'], (path, response.status, response.text()[:200])
        # the value is never echoed (the message itself says `?profile=current`, so a value that strips to `current` is checked as written)
        assert (value if value.strip() == 'current' else value.strip()) not in response.text(), path


def test_none_current_and_the_launch_profile_are_answered(human_browser):
    launch = launch_profile(human_browser)
    for suffix in ('', '?profile=', '?profile=current', f'?profile={launch}'):
        for path in ('/health', '/session', '/bots'):
            response = human_browser.request.get(DASHBOARD + PREFIX + path + suffix)
            assert response.status == 200, (path, suffix, response.status, response.text()[:200])


def stable(bots):
    """The Bots as the list shows them, minus what moves by itself (the hook's heartbeat age counts seconds: two reads of an unchanged Bot differ by it)."""
    out = []
    for bot in bots:
        bot = dict(bot)
        if isinstance(bot.get('hook'), dict):
            bot['hook'] = {k: v for k, v in bot['hook'].items() if k != 'heartbeat_age_s'}
        out.append(bot)
    return out


def test_a_mutation_with_a_foreign_profile_param_does_nothing(human_browser):
    before = stable(human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots'])
    response = human_browser.request.post(DASHBOARD + PREFIX + '/bots?profile=vendas', data={'name': 'no-such-effect', 'template': 'blank'})
    assert (response.status, response.json()['error']['code']) in ALLOWED[True]                      # refused by us (400) or by the Bot's plugin host (409): nothing happens
    after = stable(human_browser.request.get(DASHBOARD + PREFIX + '/bots').json()['bots'])
    changed = [(a.get('name'), key) for a, b in zip(after, before) for key in set(a) | set(b) if a.get(key) != b.get(key)]
    assert after == before, ('a Bot changed', changed, len(after), len(before))


def test_the_profile_selector_on_a_real_bot_is_refused_in_words_never_a_500(human_browser):
    """The `profile_selector` limit, proven on the build under test: Hermes hands a call that names a real Bot to that Bot's plugin host, which answers
    `409 luvebot_needs_in_process` in words (what it is, what to set), never a 5xx and never a Bot's data. On v0.22.5 every call is that 409; on another build
    our own `400 profile_param_not_supported` is the other honest answer. Reads and a write alike: a refused write changes nothing (test above)."""
    version = human_browser.request.get(DASHBOARD + PREFIX + '/health').json()['hermes']['version']
    calls = [(path, human_browser.request.get(DASHBOARD + PREFIX + path + '?profile=vendas')) for path in GETS]
    calls.append(('POST /bots', human_browser.request.post(DASHBOARD + PREFIX + '/bots?profile=vendas', data={'name': 'no-such-effect', 'template': 'blank'})))
    for where, response in calls:
        assert response.status in (400, 409), (version, where, response.status, response.text()[:200])
        error = response.json()['error']
        if response.status == 409:
            assert error['code'] == 'luvebot_needs_in_process' and error['request_id'].startswith('req_'), (where, error)
            assert 'plugins.isolation: in_process' in error['message'] and 'dashboard' in error['message'], (where, error)
            assert response.headers['x-luvebot-api'] == '0' and response.headers['cache-control'] == 'no-store', (where, dict(response.headers))
        elif version == '0.22.5':
            raise AssertionError(('v0.22.5 hands a real Bot to its plugin host: the 409 is the limit, a 400 here means the limit moved', where, error))
