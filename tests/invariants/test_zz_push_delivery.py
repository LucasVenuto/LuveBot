"""N-5 (contract v0.11 section 7), the part N-1 delivered: LuveBot's REAL sender against the harness push service (tests/harness/fake_push_service.py) that judges the request like Apple, Google and Mozilla do.

The stack is started with `HTTPS_PROXY=http://127.0.0.1:<port>`, `SSL_CERT_FILE=<the service's ca.pem>`, `NO_PROXY=127.0.0.1,localhost` and `HARNESS_PUSH_FAKE=http://127.0.0.1:<port>` (nothing in production is opened for
this: the sender's opener honors the environment it is imported in). Two stacks, one file:
  * NO contact (`LUVEBOT_PUSH_SUBJECT` unset, the harness's `dashboard.public_url` is not https): `GET /notifications/config` says `subject: {ok: false, source: null}`, `/health` says `needs_subject`, `POST /notifications/test`
    is `409 needs_subject` and THE SERVICE SAW NOTHING: LuveBot does not send with a contact it made up (A-180);
  * `LUVEBOT_PUSH_SUBJECT=https://luve.app`: `subject: {ok: true, source: "setting"}` and the value in no response, a test to six devices (one fate each: the service's path picks it) is answered PER DEVICE with the status and
    the closed `reason`, the service judged a well-formed `sub` (ES256 signed by the key it was given, `aud` the service's origin, `TTL` 3600, `Topic: test`, `Urgency: high`, an empty body), the device the service
    called gone is forgotten, each device's `last` outcome is listed, a second test inside 10 seconds is `429 rate_limited`, and no endpoint is in any answer or in what LuveBot logged.
Skipped without that environment."""
import json
import os
import urllib.request

import pytest

from support import DASHBOARD, STATE
from test_bots import csrf, error_of, post
from test_hook import ROOT_HOME
from test_runs import get

FAKE = os.environ.get('HARNESS_PUSH_FAKE', '')
SUBJECT = os.environ.get('LUVEBOT_PUSH_SUBJECT', '')
pytestmark = pytest.mark.skipif(not FAKE or not os.environ.get('HTTPS_PROXY'), reason='needs a stack started with HTTPS_PROXY, SSL_CERT_FILE and HARNESS_PUSH_FAKE (the harness push service)')
HOST = 'web.push.apple.com'
FATES = ['ok/1', 'badjwt/2', 'mismatch/3', 'gone/4', 'limited/5', 'slow/6']
WANT = {'ok/1': (201, None), 'badjwt/2': (403, 'bad_jwt'), 'mismatch/3': (403, 'key_mismatch'), 'limited/5': (429, 'rate_limited'), 'slow/6': (0, 'timeout')}


def fake(path, method='GET'):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))               # straight to the service's own port, never through the proxy
    return json.load(opener.open(urllib.request.Request(FAKE + path, data=b'' if method == 'POST' else None, method=method), timeout=15))


def subscribe(browser, fate, key):
    return post(browser, '/notifications/subscriptions', {'endpoint': f'https://{HOST}/{fate}', 'kinds': ['approval'], 'application_server_key': key})


def devices(browser):
    return get(browser, '/notifications/subscriptions').json()['subscriptions']


def forget_mine(browser):
    for device in devices(browser):
        browser.request.delete(f'{DASHBOARD}/api/plugins/luvebot/notifications/subscriptions/{device["id"]}', headers={'X-LuveBot-CSRF': csrf(browser)})


def note(line):
    print(line)
    try:
        with open(STATE / 'logs' / 'n5-timeline.txt', 'a') as handle:
            handle.write(line + '\n')
    except OSError:
        pass


def luvebot_logs():
    text = ''
    for path in (ROOT_HOME / 'logs').glob('*.log'):
        text += ''.join(line for line in path.read_text(errors='replace').splitlines(True) if ' luvebot.' in line)
    return text


@pytest.mark.skipif(bool(SUBJECT), reason='the stack under test has a contact set')
def test_without_a_contact_nothing_is_sent_and_every_screen_says_why(human_browser):
    fake('/_reset', 'POST')
    config = get(human_browser, '/notifications/config')
    assert config.status == 200 and config.json()['subject'] == {'ok': False, 'source': None}, config.text()[:300]
    assert get(human_browser, '/health').json()['features']['notifications'] == 'needs_subject'
    made = subscribe(human_browser, 'ok/1', config.json()['public_key'])
    assert made.status == 201, made.text()[:300]
    try:
        asked = post(human_browser, '/notifications/test', {})
        assert (asked.status, error_of(asked)['code']) == (409, 'needs_subject'), asked.text()[:300]
        assert fake('/_log') == [], fake('/_log')                                                     # the service saw NOTHING: no contact made up, no 403 to explain
        note('N-5 without a contact: config subject not ok, /health needs_subject, test route 409 needs_subject, the service saw 0 requests')
    finally:
        forget_mine(human_browser)


@pytest.mark.skipif(SUBJECT != 'https://luve.app', reason='needs LUVEBOT_PUSH_SUBJECT=https://luve.app')
def test_with_a_contact_the_test_route_answers_per_device_and_the_service_judged_a_well_formed_one(human_browser):
    fake('/_reset', 'POST')
    config = get(human_browser, '/notifications/config')
    assert config.json()['subject'] == {'ok': True, 'source': 'setting'}, config.text()[:300]
    assert 'luve.app' not in config.text() and 'luve.app' not in get(human_browser, '/health').text()   # the contact is never shown (it may be a person's address)
    assert get(human_browser, '/health').json()['features']['notifications'] == 'ok'
    key = config.json()['public_key']
    for fate in FATES:
        assert subscribe(human_browser, fate, key).status == 201, fate
    try:
        before = devices(human_browser)
        assert len(before) == len(FATES) and all(d['stale'] is False for d in before), before
        asked = post(human_browser, '/notifications/test', {})
        assert asked.status == 200, (asked.status, asked.text()[:300])
        answers = asked.json()['devices']
        assert [d['id'] for d in answers] == [d['id'] for d in before] and all(d['host'] == HOST for d in answers), answers
        by_fate = dict(zip(FATES, answers))
        note('N-5 test route, per device: ' + json.dumps({f: (d['ok'], d['status'], d['reason']) for f, d in by_fate.items()}))
        for fate, (status, reason) in WANT.items():
            assert (by_fate[fate]['status'], by_fate[fate]['reason'], by_fate[fate]['ok']) == (status, reason, status == 201), (fate, by_fate[fate])
        assert by_fate['gone/4']['status'] == 410 and by_fate['gone/4']['ok'] is False and by_fate['gone/4']['reason'] in {'expired', 'other'}, by_fate['gone/4']   # (a 410 is forgotten below; its word is the sender's: `other` today)
        # what the service judged: a well-formed contact, signed by the key it was given, for ITS origin, an empty wake of the kind `test`
        seen = [e for e in fake('/_log') if e['path'] != '/slow/6']
        assert len(seen) == 5 and all(e['sub'] == 'https://luve.app' and e['aud'] == f'https://{HOST}' and e['ttl'] == '3600' and e['topic'] == 'test' and e['urgency'] == 'high' and e['body_len'] == 0 for e in seen), seen
        assert [e['status'] for e in seen if e['path'] == '/ok/1'] == [201]
        # each device's last outcome is listed; the one the service called gone is forgotten (404 and 410 delete the device)
        after = {d['id']: d for d in devices(human_browser)}
        assert by_fate['gone/4']['id'] not in after and len(after) == len(FATES) - 1, after
        assert after[by_fate['ok/1']['id']]['last']['ok'] is True and after[by_fate['badjwt/2']['id']]['last']['reason'] == 'bad_jwt', after
        # a second test inside 10 seconds is refused, and nothing of a device's address is in any answer or in what LuveBot logged
        again = post(human_browser, '/notifications/test', {})
        assert (again.status, error_of(again)['code']) == (429, 'rate_limited'), again.text()[:300]
        everything = asked.text() + json.dumps(devices(human_browser)) + get(human_browser, '/health').text() + luvebot_logs()
        assert not any(f'{HOST}/{fate}' in everything or f'/{fate}' in everything for fate in FATES), 'an endpoint reached an answer or a log'
        note('N-5 with a contact: the service judged a well-formed sub for 5 devices, the test route answered per device, gone forgotten, second test 429, no endpoint anywhere')
    finally:
        forget_mine(human_browser)
