"""Contract v0.8 section 6 (Web Push without payload) against the real plugin: the routes behind the gate, the allowlist, and the
approval insert waking a device without waiting for it. No request leaves the container: the sender is replaced in process and no
subscription is left behind for the dashboard to wake. The unit suite (tests/unit/backend/test_push.py) holds the mutations."""
import json
import sqlite3
import time
import uuid

import pytest

from support import DASHBOARD, credentials, plugin
from test_bots import DB, csrf, error_of
from test_plugin import PREFIX, routes

FCM = 'https://fcm.googleapis.com/fcm/send/harness-' + uuid.uuid4().hex


def call(browser, method, path, body=None, token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.fetch(DASHBOARD + PREFIX + path, method=method, data=body, headers=headers)


def subscriptions():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT id, endpoint FROM push_subscriptions').fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        conn.close()


@pytest.fixture(autouse=True)
def no_devices_left(human_browser):
    yield
    conn = sqlite3.connect(DB)
    try:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint LIKE 'https://fcm.googleapis.com/fcm/send/harness-%'")
        conn.commit()
    except sqlite3.OperationalError:
        pass
    finally:
        conn.close()
    assert subscriptions() == []


def test_the_six_notification_routes_are_in_the_real_router():
    found = {(m, p) for m, p in routes() if '/notifications' in p}
    assert found == {('GET', PREFIX + '/notifications/config'), ('GET', PREFIX + '/notifications/subscriptions'),
                     ('POST', PREFIX + '/notifications/subscriptions'), ('DELETE', PREFIX + '/notifications/subscriptions/{subscription_id}'),
                     ('GET', PREFIX + '/notifications/latest'), ('POST', PREFIX + '/notifications/test')}       # N-1: the test wake


def test_push_endpoint_allowlist_and_the_device_lifecycle(human_browser):
    config = human_browser.request.get(DASHBOARD + PREFIX + '/notifications/config')
    assert config.status == 200 and set(config.json()) == {'public_key', 'enabled_kinds', 'subject'} and b'PRIVATE' not in config.body()
    assert set(config.json()['subject']) == {'ok', 'source'} and isinstance(config.json()['subject']['ok'], bool)      # whether a contact is set and where from, never the value (contract v0.11 7.1)
    for bad in ('http://fcm.googleapis.com/fcm/send/x', 'https://172.17.0.1/push', 'https://fcm.googleapis.com.evil.example/x',
                'https://fake-openai:8000/v1/models'):
        response = call(human_browser, 'POST', '/notifications/subscriptions', {'endpoint': bad})
        assert response.status == 422 and error_of(response)['code'] == 'invalid_field', bad
    assert call(human_browser, 'POST', '/notifications/subscriptions', {'endpoint': FCM}, None).status == 403
    made = call(human_browser, 'POST', '/notifications/subscriptions', {'endpoint': FCM, 'kinds': ['budget'],
                                                                         'keys': {'p256dh': 'x', 'auth': 'y'}})
    assert made.status == 201 and made.json()['kinds'] == ['budget'], made.text()
    mine = human_browser.request.get(DASHBOARD + PREFIX + '/notifications/subscriptions').json()['subscriptions']
    assert [{k: d[k] for k in ('id', 'host', 'kinds')} for d in mine] == [{'id': made.json()['id'], 'host': 'fcm.googleapis.com', 'kinds': ['budget']}] and FCM not in json.dumps(mine)
    assert isinstance(mine[0]['created_at'], float) and mine[0]['last'] is None and mine[0]['stale'] is True        # N-1: no push yet, and a device that sent no key is listed as stale (7.4)
    assert call(human_browser, 'DELETE', f"/notifications/subscriptions/{made.json()['id']}").status == 200
    assert call(human_browser, 'DELETE', f"/notifications/subscriptions/{made.json()['id']}").status == 404


def test_an_approval_request_wakes_a_device_with_an_empty_push_and_never_waits(monkeypatch):
    module = plugin()
    from luvebot_backend import approvals, push
    from luvebot_backend.audit import AuditLog
    sent = []

    def slow_sender(url, headers):
        time.sleep(3)                                          # a push service that hangs: the approval insert must not wait
        sent.append((url, headers))
        return 201
    monkeypatch.setattr(module, '_push', lambda path: push.Push(path, subject='https://luve.app', sender=slow_sender))
    monkeypatch.setattr(approvals, 'on_request', module._on_approval_request)   # every load of plugin_api (a variant, in another test) rebinds this hook to ITS function: use this module's
    box = push.Push(DB)
    box.subscribe(AuditLog(DB), 'basic:harness-human', FCM, ['approval'], 'req_t')
    request_id = 'req_push_' + uuid.uuid4().hex[:12]
    started = time.monotonic()
    try:
        row = approvals.record_request(DB, 'vendas', 'run_push_' + uuid.uuid4().hex[:8], 'run',
                                       {'request_id': request_id, 'command': 'chmod 600 /tmp/x', 'description': 'push test',
                                        'choices': ['once', 'deny']})
        assert row['status'] == 'pending' and time.monotonic() - started < 2
        deadline = time.monotonic() + 10
        while not sent and time.monotonic() < deadline:
            time.sleep(0.2)
        (url, headers), = sent
        assert url == FCM and headers['Content-Length'] == '0' and headers['Authorization'].startswith('vapid t=')
        assert 'chmod' not in json.dumps(headers) and 'vendas' not in json.dumps(headers)            # nothing of the event travels
        latest = box.latest('basic:harness-human')[0]                                   # the person who subscribed (the events are the team's, the list is filtered by kinds)
        assert latest == {'kind': 'approval', 'bot': 'vendas', 'at': latest['at'], 'link': '/approvals'}
    finally:
        conn = sqlite3.connect(DB)
        conn.execute('DELETE FROM approvals WHERE request_id=?', (request_id,))
        conn.commit()
        conn.close()


def test_latest_holds_kind_and_bot_only(human_browser):
    events = human_browser.request.get(DASHBOARD + PREFIX + '/notifications/latest')
    assert events.status == 200 and len(events.json()['events']) <= 5
    for event in events.json()['events']:
        assert set(event) == {'kind', 'bot', 'at', 'link'}
    for value in credentials().values():
        assert value.encode() not in events.body()
