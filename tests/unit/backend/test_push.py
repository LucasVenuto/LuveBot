"""Contract v0.8 section 6 (Web Push without payload): backend/push.py. Every invariant also runs against variants of push.py with
one defect each: each must go red. The harness (tests/invariants/test_push.py) checks the routes and the approval hook against the
real Hermes."""
import base64
import hashlib
import importlib
import io
import itertools
import json
import logging
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import threading
import time
import urllib.error

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

import backend.push as real

SRC = Path(real.__file__).parent
_n = itertools.count()
FCM = 'https://fcm.googleapis.com/fcm/send/dEvIcE-1:APA91b'
MOZ = 'https://updates.push.services.mozilla.com/wpush/v2/gAAAAB'
APPLE = 'https://web.push.apple.com/QGuQ'
WIN = 'https://wns2-par02p.notify.windows.com/w/?token=AwYAAAB'


def sibling(m, name):
    return importlib.import_module(m.__name__.rsplit('.', 1)[0] + '.' + name)


def refused(m, code, fn, *args):
    try:
        fn(*args)
    except sibling(m, 'api_errors').PluginError as error:
        assert error.code == code, error.code
        return error
    raise AssertionError(f'{code} was not raised')


class Sender:
    def __init__(self, status=201, delay=0):
        self.status, self.delay, self.sent = status, delay, []

    def __call__(self, url, headers):
        time.sleep(self.delay)
        self.sent.append((url, headers))
        return self.status(url) if callable(self.status) else self.status


def rig(m, tmp, sender=None):
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', source='public_url', sender=sender or Sender())
    return audit, box


def sub(m, audit, box, endpoint, actor='basic:ana', kinds=None):
    return box.subscribe(audit, actor, endpoint, kinds or list(m.KINDS), 'req_1')


def rows(tmp, sql):
    conn = sqlite3.connect(tmp / 'audit.db')
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def public_key(b64):
    raw = base64.urlsafe_b64decode(b64 + '=' * (-len(b64) % 4))
    return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)


def inv_push_endpoint_allowlist(m, tmp):
    for good in (FCM, MOZ, APPLE, WIN):
        assert m.endpoint_of(good) == good
    for bad in ('http://fcm.googleapis.com/fcm/send/x', 'https://10.0.0.5/push', 'https://127.0.0.1/x', 'https://[::1]/x',
                'https://fcm.googleapis.com.evil.example/x', 'https://evil.example/fcm.googleapis.com', 'https://notify.windows.com/x',
                'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/?h=web.push.apple.com',
                'https://localhost/x', 'file:///etc/passwd', 'https://xfcm.googleapis.com/x', '', None, 5, 'https://' + 'a' * 2050):
        refused(m, 'invalid_field', m.endpoint_of, bad)


def inv_push_a_hostile_endpoint_is_a_422_and_what_is_stored_is_what_was_validated(m, tmp):
    tab, cr, lf = chr(9), chr(13), chr(10)
    for bad in ('https://fcm.googleapis.com/fcm/send/a' + tab + 'b', 'https://fcm.googleapis.com/fcm/send/a' + cr + lf + 'b', 'https://fcm.googleapis.com' + tab + '/x', 'https://fcm.google' + lf + 'apis.com/x',
                'https://fcm.googleapis.com/fcm/send/a' + chr(0) + 'b', 'https://fcm.googleapis.com/fcm/send/a b', 'https://fcm.googleapis.com/fcm/send/a' + chr(0xe9) + 'b', 'https://fcm.googleapis.com/fcm/send/a' + chr(0x202e) + 'b',
                'https://[::1/x', 'https://fcm.googleapis.com:99999/x', 'https://fcm.googleapis.com:abc/x', 'https://' + chr(0x2100) + '.notify.windows.com/x', 'https://x' + chr(0xff03) + '.notify.windows.com/'):
        error = must(refused, m, 'invalid_field', m.endpoint_of, bad)
        assert error.status == 422, repr(bad)
    for good in (FCM, MOZ, APPLE, WIN):
        assert must(m.endpoint_of, good) == good                                         # the stored string is exactly the validated one


def inv_push_no_payload_and_a_valid_vapid_jwt(m, tmp):
    sender = Sender()
    audit, box = rig(m, tmp, sender)
    sub(m, audit, box, FCM)
    box.notify(audit, 'approval', 'vendas').join(5)
    (url, headers), = sender.sent
    assert url == FCM and headers['TTL'] == '3600' and headers['Urgency'] == 'high' and headers['Content-Length'] == '0'
    assert headers.get('Topic') == 'approval' and re.fullmatch(r'[A-Za-z0-9_-]{1,32}', headers['Topic'])      # one wake per kind waits at the push service (RFC 8030)
    scheme, token, key = headers['Authorization'].replace(',', '').split()
    assert scheme == 'vapid' and key == 'k=' + box.config()['public_key']
    try:
        claims = jwt.decode(token[2:], public_key(box.config()['public_key']), algorithms=['ES256'], audience='https://fcm.googleapis.com')
    except jwt.InvalidTokenError as error:
        raise AssertionError(f'invalid VAPID JWT: {type(error).__name__}') from None
    assert claims['sub'] == 'https://luve.app' and 11 * 3600 < claims['exp'] - time.time() <= 12 * 3600
    sent = {}

    class Opener:
        def open(self, request, timeout):
            sent.update(data=request.data, method=request.get_method(), timeout=timeout, headers=dict(request.header_items()))
            raise m.urllib.error.HTTPError(request.full_url, 410, 'gone', {}, None)
    real_opener, m._OPENER = m._OPENER, Opener()
    try:
        assert m.http_post(FCM, {'TTL': '3600'}) == 410
    finally:
        m._OPENER = real_opener
    assert sent['data'] == b'' and sent['method'] == 'POST' and sent['timeout'] == 5
    assert isinstance(m._OPENER.handlers[0], m._NoRedirect) or any(isinstance(h, m._NoRedirect) for h in m._OPENER.handlers)


def inv_push_private_key_never_leaves(m, tmp):
    audit, box = rig(m, tmp)
    sub(m, audit, box, FCM)
    box.config()
    pem = rows(tmp, 'SELECT private_pem FROM push_key')[0][0]
    shown = json.dumps([box.config(), box.mine('basic:ana'), box.latest('basic:ana')])
    assert b'PRIVATE' in pem and pem.decode() not in shown and 'PRIVATE' not in shown
    assert set(box.config()) == {'public_key', 'enabled_kinds', 'subject'} and 'luve.app' not in json.dumps(box.config()) and len(base64.urlsafe_b64decode(box.config()['public_key'] + '=')) == 65
    assert box.config()['public_key'] == m.Push(tmp / 'audit.db').config()['public_key']        # one key, kept


def inv_push_gone_removes(m, tmp):
    sender = Sender(lambda url: 410 if url == MOZ else 500)
    audit, box = rig(m, tmp, sender)
    sub(m, audit, box, FCM)
    sub(m, audit, box, MOZ)
    box.notify(audit, 'approval', 'vendas').join(5)
    assert [s['host'] for s in box.mine('basic:ana')] == ['fcm.googleapis.com']               # 410 forgotten, 500 kept
    assert set(box.mine('basic:ana')[0]) == {'id', 'host', 'kinds', 'created_at', 'stale', 'last'}               # the list never carries the endpoint (a delivery secret)
    assert isinstance(box.mine('basic:ana')[0]['created_at'], float) and 'fcm.googleapis.com/' not in json.dumps(box.mine('basic:ana'))


def inv_push_never_blocks(m, tmp):
    sender = Sender(delay=2)
    audit, box = rig(m, tmp, sender)
    sub(m, audit, box, FCM)
    started = time.monotonic()
    thread = box.notify(audit, 'approval', 'vendas')
    assert time.monotonic() - started < 1 and sender.sent == []
    thread.join(5)
    assert len(sender.sent) == 1


def inv_push_devices_kinds_and_owner(m, tmp):
    sender = Sender()
    audit, box = rig(m, tmp, sender)
    sub(m, audit, box, FCM, kinds=['budget'])
    sub(m, audit, box, MOZ, actor='basic:bia')
    box.notify(audit, 'approval', 'vendas').join(5)
    assert [u for u, _h in sender.sent] == [MOZ]                                                 # the FCM device only wants budget
    assert box.notify(audit, 'approval', 'x') is not None
    for n in range(9):
        sub(m, audit, box, f'{FCM}{n}')
    refused(m, 'too_many_devices', sub, m, audit, box, FCM + 'X')
    assert sub(m, audit, box, FCM, kinds=['approval'])['kinds'] == ['approval']                  # the same device updates, no new row
    bia = box.mine('basic:bia')[0]['id']
    refused(m, 'subscription_not_found', box.unsubscribe, audit, 'basic:ana', bia, 'req_2')
    assert box.unsubscribe(audit, 'basic:bia', bia, 'req_2') == {'removed': 1} and box.mine('basic:bia') == []
    assert rows(tmp, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.subscribe' AND detail='intent'")[0][0] == 13
    latest = box.latest('basic:ana')
    assert len(latest) == 2 and set(latest[0]) == {'kind', 'bot', 'at', 'link'} and latest[0]['link'] == '/approvals'
    for body in ({}, {'endpoint': FCM, 'x': 1}, None):
        refused(m, 'bad_request', m.subscribe_body, body)
    for kinds in ([], ['sms'], 'approval'):
        refused(m, 'invalid_field', m.subscribe_body, {'endpoint': FCM, 'kinds': kinds})
    assert m.subscribe_body({'endpoint': FCM, 'keys': {'p256dh': 'x', 'auth': 'y'}}) == (FCM, ['approval', 'budget', 'question'], None)


def settled(box, audit, kind, bot):
    thread = box.notify(audit, kind, bot)
    if thread:
        thread.join(5)


def inv_push_latest_by_subscribed_kinds(m, tmp):
    now = [1_000_000.0]
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', sender=Sender(), clock=lambda: now[0])
    assert box.latest('basic:ana') == []                                                       # no subscription: nothing, never "everything"
    phone = sub(m, audit, box, FCM, kinds=['budget'])['id']
    laptop = sub(m, audit, box, MOZ, kinds=['approval'])['id']
    sub(m, audit, box, APPLE, actor='basic:bia', kinds=['budget'])
    settled(box, audit, 'budget', 'caixa')
    for n in range(6):
        settled(box, audit, 'approval', f'bot{n}')
    assert [e['bot'] for e in box.latest('basic:bia')] == ['caixa']                           # filtered FIRST, then the 5: six newer approvals do not hide it
    assert [e['bot'] for e in box.latest('basic:ana')] == [f'bot{n}' for n in (5, 4, 3, 2, 1)]  # the union of her devices, the 5 newest
    assert [e['bot'] for e in box.latest('basic:ana', laptop)] == [f'bot{n}' for n in (5, 4, 3, 2, 1)]
    assert [e['bot'] for e in box.latest('basic:ana', phone)] == ['caixa']                    # one device: only what it wants
    assert box.latest('basic:ana', 987654) == box.latest('basic:ana', None) == box.latest('basic:ana')
    bia_phone = box.mine('basic:bia')[0]['id']
    assert box.latest('basic:ana', bia_phone) == box.latest('basic:ana')                       # another person's device narrows nothing
    assert box.latest('basic:cris') == []
    now[0] += m.TTL - 1
    assert len(box.latest('basic:ana')) == 5
    now[0] += 2
    assert box.latest('basic:ana') == [] and box.latest('basic:bia') == []                    # older than the push TTL: gone
    for event in box.latest('basic:ana'):
        assert set(event) == {'kind', 'bot', 'at', 'link'}


def shown(box, actor):
    try:
        return [e['bot'] for e in box.latest(actor)]
    except Exception as error:                      # a damaged row must never break the screen the service worker reads
        raise AssertionError(f'latest broke on a damaged row: {type(error).__name__}') from None


def inv_push_sender_and_latest_read_kinds_alike(m, tmp):
    sender = Sender()
    audit, box = rig(m, tmp, sender)
    sub(m, audit, box, FCM, kinds=['approval'])
    sub(m, audit, box, MOZ, actor='basic:bia')
    conn = sqlite3.connect(tmp / 'audit.db')
    conn.execute("UPDATE push_subscriptions SET kinds='not json' WHERE endpoint=?", (FCM,))   # a damaged row
    conn.commit()
    conn.close()
    settled(box, audit, 'approval', 'vendas')
    assert [u for u, _h in sender.sent] == [MOZ]                                               # the damaged device is skipped, not everyone
    assert shown(box, 'basic:ana') == []                                                       # and it wants nothing on its own screen
    assert shown(box, 'basic:bia') == ['vendas']
    conn = sqlite3.connect(tmp / 'audit.db')
    conn.execute("UPDATE push_subscriptions SET kinds='[1, \"budget\"]' WHERE endpoint=?", (MOZ,))   # a stray value is ignored, the rest counts
    conn.commit()
    conn.close()
    sender.sent.clear()
    settled(box, audit, 'approval', 'vendas')
    assert sender.sent == [] and shown(box, 'basic:bia') == []


def inv_push_a_post_by_another_person_moves_the_device(m, tmp):
    audit, box = rig(m, tmp)
    first = sub(m, audit, box, FCM)
    again = sub(m, audit, box, FCM, kinds=['budget'])
    assert 'moved' not in first and 'moved' not in again and again['id'] == first['id']       # the same person: an update
    moved = sub(m, audit, box, FCM, actor='basic:bia')
    assert moved.get('moved') is True and moved['id'] == first['id']
    assert box.mine('basic:ana') == [] and [s['id'] for s in box.mine('basic:bia')] == [first['id']]
    assert rows(tmp, 'SELECT COUNT(*) FROM push_subscriptions')[0][0] == 1                    # moved, never duplicated
    assert rows(tmp, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.move' AND actor='basic:bia' AND detail='intent'")[0][0] == 1
    assert rows(tmp, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.subscribe' AND detail='intent'")[0][0] == 2   # ana's two
    for n in range(10):
        sub(m, audit, box, f'{MOZ}{n}', actor='basic:ana')
    refused(m, 'too_many_devices', sub, m, audit, box, FCM, 'basic:ana')                       # a move counts against the new owner's limit
    assert [s['id'] for s in box.mine('basic:bia')] == [first['id']]


def inv_push_the_vapid_token_is_reused(m, tmp):
    now = [2_000_000.0]
    sender = Sender()
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', sender=sender, clock=lambda: now[0])
    sub(m, audit, box, FCM)
    sub(m, audit, box, MOZ)

    def tokens():
        return [h['Authorization'].split('t=')[1].split(',')[0] for _u, h in sender.sent]
    settled(box, audit, 'approval', 'vendas')
    settled(box, audit, 'approval', 'caixa')
    sent_urls = [u for u, _h in sender.sent]
    by_url = {}
    for url, token in zip(sent_urls, tokens()):
        by_url.setdefault(url, set()).add(token)
    assert all(len(found) == 1 for found in by_url.values()) and len(by_url) == 2          # four sends, two services: ONE token each (Apple limits renewals)
    assert by_url[FCM] != by_url[MOZ]                                                      # each is for its own audience
    first = next(iter(by_url[FCM]))
    now[0] += (m.JWT_HOURS - m.JWT_REUSE_HOURS) * 3600 - 60
    sender.sent.clear()
    settled(box, audit, 'approval', 'vendas')
    assert set(tokens()) <= {first, next(iter(by_url[MOZ]))}                               # still more than the reuse margin left: the same tokens
    now[0] += 120
    sender.sent.clear()
    settled(box, audit, 'approval', 'vendas')
    fresh = {u: t for (u, _h), t in zip(sender.sent, tokens())}
    assert fresh[FCM] != first                                                             # under the margin: renewed
    claims = jwt.decode(fresh[FCM], options={'verify_signature': False})
    assert claims['aud'] == 'https://fcm.googleapis.com' and claims['exp'] == int(now[0]) + m.JWT_HOURS * 3600 and claims['sub'] == 'https://luve.app'
    other = m.Push(tmp / 'audit.db', subject='https://other.app', sender=sender, clock=lambda: now[0])
    sender.sent.clear()
    settled(other, audit, 'approval', 'vendas')
    assert jwt.decode(tokens()[0], options={'verify_signature': False})['sub'] == 'https://other.app'   # another subject never gets this one


def inv_push_a_keyed_event_is_once(m, tmp):
    """Two watchers on one luvebot.db (threat-model section 8, item 22) must tell the person about a pause once: `pause:<bot>:<since>` is the key of that pause."""
    sender = Sender()
    audit, box = rig(m, tmp, sender)
    sub(m, audit, box, FCM)
    second = m.Push(tmp / 'audit.db', subject='https://luve.app', sender=sender)                 # the other watcher: same database, its own memory
    box.notify(audit, 'budget', 'vendas', 'pause:vendas:100.5').join(5)
    assert second.notify(audit, 'budget', 'vendas', 'pause:vendas:100.5') is None                      # the same pause: nobody woken
    assert len(sender.sent) == 1 and rows(tmp, "SELECT COUNT(*) FROM push_events WHERE dedupe='pause:vendas:100.5'")[0][0] == 1
    assert rows(tmp, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.push' AND detail='intent'")[0][0] == 1   # and no audit row for the second look
    second.notify(audit, 'budget', 'vendas', 'pause:vendas:200.5').join(5)                              # the NEXT pause of that Bot (after a resume): a new key
    assert len(sender.sent) == 2
    for _ in range(2):                                                                                   # no key: each call counts, as before
        settled(box, audit, 'budget', 'suporte')
    assert len(sender.sent) == 4
    second._notified = lambda key: False                                                                 # the race: the other watcher's insert lands between the look and the insert
    assert second.notify(audit, 'budget', 'vendas', 'pause:vendas:100.5') is None
    assert len(sender.sent) == 4 and rows(tmp, "SELECT COUNT(*) FROM audit_log WHERE outcome='error'")[0][0] == 0   # nobody woken, and no error either


def inv_push_an_old_database_gets_the_key(m, tmp):
    conn = sqlite3.connect(tmp / 'audit.db')
    conn.execute('CREATE TABLE push_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, bot TEXT NOT NULL, created_at REAL NOT NULL)')   # before the key
    conn.execute("INSERT INTO push_events (kind, bot, created_at) VALUES ('approval', 'vendas', 1.0)")
    conn.commit()
    conn.close()
    sender = Sender()
    try:
        audit, box = rig(m, tmp, sender)
    except sqlite3.OperationalError as error:                                                            # a build that cannot open the old table is red, not a crash
        raise AssertionError(f'the old database cannot be opened: {error}') from None
    assert rows(tmp, 'SELECT kind, bot, dedupe FROM push_events') == [('approval', 'vendas', None)]     # the old event survives the migration
    sub(m, audit, box, FCM)
    box.notify(audit, 'budget', 'vendas', 'pause:vendas:1.0').join(5)
    assert box.notify(audit, 'budget', 'vendas', 'pause:vendas:1.0') is None and len(sender.sent) == 1
    m.Push(tmp / 'audit.db')                                                                             # constructing it again changes nothing
    assert rows(tmp, 'SELECT COUNT(*) FROM push_events')[0][0] == 2


# ---- contract v0.11 section 7 (N-1): a contact the services accept, deliveries you can see, the test route, the key a device used ----------------------
def must(fn, *args):
    """What a mutant may do is raise: that is a red invariant, said as one (the mutation test only accepts an AssertionError)."""
    try:
        return fn(*args)
    except AssertionError:
        raise
    except Exception as error:  # noqa: BLE001
        raise AssertionError(f'{getattr(fn, "__name__", "call")} raised {type(error).__name__}: {error}') from None


class Lines:
    """The log lines the push module writes while this is open."""
    def __enter__(self):
        self.lines, self.logger = [], logging.getLogger('luvebot.push')
        lines = self.lines

        class Catch(logging.Handler):
            def emit(self, record):
                lines.append(record.getMessage())
        self.handler, self.level = Catch(), self.logger.level
        self.logger.addHandler(self.handler)
        self.logger.setLevel(logging.DEBUG)
        return self.lines

    def __exit__(self, *exc):
        self.logger.removeHandler(self.handler)
        self.logger.setLevel(self.level)


def another_key():
    raw = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def inv_push_the_contact_is_one_a_service_takes(m, tmp):
    for good in ('https://luve.app', 'https://luve.app/contact?x=1', 'https://a.b.luve.app:8443/', 'mailto:ops@luve.app', 'mailto:Ops.Team+push@mail.luve.com.br'):
        assert must(m.valid_subject, good) is True, good
    for bad in ('mailto:luvebot@localhost', 'mailto:ops@host.local', 'mailto:ops@x.test', 'mailto:ops@x.invalid', 'mailto:ops@x.example', 'mailto:ops@luve', 'mailto:@luve.app', 'mailto:ops@', 'mailto:ops',
                'mailto:o ps@luve.app', 'mailto:ops@127.0.0.1', 'http://luve.app', 'https://localhost', 'https://localhost:9119/x', 'https://127.0.0.1', 'https://192.168.1.5:9119', 'https://[::1]/x',
                'https://[::ffff:10.0.0.1]/', 'https://luve', 'https://user:pw@luve.app', 'https://', 'ftp://luve.app', 'luve.app', 'https://-luve.app', 'https://luve..app', 'https://luve.123',
                'https://luve.app\r\nX-Evil: 1', 'https://0x7f.0x1', 'https://127.1', 'https://0X7F.0.0.1', 'https://luve.app:0/', 'https://luve.app:99999/', 'https://luve.app:abc/', 'https://luve.app/ x', 'https://luve.app/\u00e9', 'https://luve.app/' + 'a' * 300, 'https://[::1', '', None, 5, ['https://luve.app']):
        assert must(m.valid_subject, bad) is False, bad
    assert must(m.valid_subject, 'https://luve.app:8443/x') is True and must(m.valid_subject, 'https://a1.luve.app') is True and must(m.valid_subject, 'https://luve.app:1') is True
    for ending in ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa'):          # ONE host rule for both schemes
        assert must(m.valid_subject, f'mailto:ops@luve{ending}') is False and must(m.valid_subject, f'https://luve{ending}') is False and must(m.valid_subject, f'https://mac{ending}:9119/') is False, ending
        apex = ending[1:]                                                                   # the apex of a reserved name with two labels is reserved too (`home.arpa`); `local` alone has no dot and falls on the dot rule
        for subject in (f'https://{apex}', f'https://{apex.upper()}/x', f'mailto:ops@{apex}', f'https://{apex}:8443'):
            assert must(m.valid_subject, subject) is False, subject


def inv_push_without_a_contact_nothing_is_sent(m, tmp):
    """No contact a service takes: no push with one LuveBot made up (the iPhone case: `mailto:luvebot@localhost` is answered 403). The event is still recorded and the settings say why."""
    pairs = [(subject, 'setting') for subject in (None, '', 'mailto:luvebot@localhost', 'http://luve.app', 'https://localhost', 'https://127.0.0.1', 'mailto:ops@x.local', 'https://0x7f.0x1')] + [(None, 'public_url'), ('http://luve.app', 'public_url')]
    for subject, source in pairs:
        path = tmp / f'nc{next(_n)}.db'
        sender = Sender()
        audit = sibling(m, 'audit').AuditLog(path)
        box = m.Push(path, subject=subject, source=source, sender=sender)
        said = {'ok': False, 'source': 'setting' if source == 'setting' else None}                      # a malformed explicit setting still says it is the setting, and is not replaced by another contact
        assert box.config()['subject'] == said and box.status()['subject'] == said, (subject, source)
        box.subscribe(audit, 'basic:ana', FCM, list(m.KINDS), 'req_1')
        with Lines() as lines:
            m._LOGGED.clear()
            for _ in range(3):
                settled(box, audit, 'approval', 'vendas')
        assert sender.sent == [] and [e['bot'] for e in box.latest('basic:ana')] == ['vendas'] * 3, subject      # nothing sent, the event is still there
        assert len(lines) == 1 and 'LUVEBOT_PUSH_SUBJECT' in lines[0] and 'luve' not in lines[0].replace('LUVEBOT', '').lower(), lines   # said once a minute, no value
        assert rows_of(path, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.deliver'")[0][0] == 0
        refused(m, 'needs_subject', box.test, audit, 'basic:ana', 'req_t')
        assert sender.sent == [] and rows_of(path, 'SELECT COUNT(*) FROM push_tests')[0][0] == 0
    path = tmp / 'default.db'
    assert m.Push(path).config()['subject'] == {'ok': False, 'source': None}                                    # no default contact at all
    good = m.Push(path, subject='https://luve.app', source='setting')
    assert good.config()['subject'] == {'ok': True, 'source': 'setting'} and good.status()['subject'] == {'ok': True, 'source': 'setting'}
    assert 'luve.app' not in json.dumps([good.config(), good.status()])                                         # the value may be a person's address: it is never shown


def rows_of(path, sql):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(sql).fetchall()
    finally:
        conn.close()


def ticking(start=4_000_000.0):
    count = itertools.count()
    return lambda: start + next(count)


def inv_push_a_refusal_is_seen_not_dropped(m, tmp):
    answers = {FCM: lambda: m._status(403, 'bad_jwt'), MOZ: lambda: 500, APPLE: lambda: 201, WIN: lambda: m._status(403, 'Boom: eyJsecret.dEvIcE.APA91b')}
    sender = Sender(lambda url: answers[url]())
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', source='public_url', sender=sender, clock=ticking())
    ids = {url: sub(m, audit, box, url)['id'] for url in (FCM, MOZ, APPLE, WIN)}
    settled(box, audit, 'approval', 'vendas')
    last = {d['id']: d['last'] for d in box.mine('basic:ana')}
    assert all(v is not None for v in last.values()), last                                                                 # every device says what became of its push
    assert set(last[ids[FCM]]) == {'at', 'ok', 'status', 'reason'} and isinstance(last[ids[FCM]]['at'], float)
    assert (last[ids[FCM]]['ok'], last[ids[FCM]]['status'], last[ids[FCM]]['reason']) == (False, 403, 'bad_jwt')
    assert (last[ids[MOZ]]['ok'], last[ids[MOZ]]['status'], last[ids[MOZ]]['reason']) == (False, 500, 'other')
    assert (last[ids[APPLE]]['ok'], last[ids[APPLE]]['status'], last[ids[APPLE]]['reason']) == (True, 201, None)
    assert last[ids[WIN]]['reason'] in m.REASONS and 'Boom' not in json.dumps(last) and 'eyJ' not in json.dumps(last)   # the service's own word is never kept
    delivered = rows_of(tmp / 'audit.db', "SELECT target, outcome, origin_kind, actor FROM audit_log WHERE action='notifications.deliver' AND detail='result' ORDER BY id")
    assert [(t, o) for t, o, *_ in delivered] == [('fcm.googleapis.com:403', 'error'), ('updates.push.services.mozilla.com:500', 'error'), ('wns2-par02p.notify.windows.com:403', 'error')]      # a REFUSAL is audited, a 2xx is not (A-189)
    assert {(k, a) for _t, _o, k, a in delivered} == {('system', 'system')}
    status = box.status()
    assert status['failing'] == {'devices': 3, 'reason': last[ids[WIN]]['reason']} and status['devices'] == 4 and status['last']['host'] == 'wns2-par02p.notify.windows.com'
    assert set(status) == {'subject', 'devices', 'stale', 'failing', 'last', 'recent'} and status['recent'] == {'hours': 24, 'ok': 1, 'failed': 3}
    problem = must(m.problem_of, status)
    assert (problem['code'], problem['feature'], problem['devices'], problem['reason']) == ('push_delivery_failed', 'notifications', 3, last[ids[WIN]]['reason'])
    for secret in ('dEvIcE', 'APA91b', 'gAAAAB', 'eyJ', 'luve.app', 'AwYAAAB', 'QGuQ'):                                   # no capability in what is shown or logged
        assert secret not in json.dumps([status, problem, box.mine('basic:ana')]) and secret not in json.dumps(rows_of(tmp / 'audit.db', 'SELECT * FROM push_log') + rows_of(tmp / 'audit.db', 'SELECT * FROM audit_log')), secret
    assert must(m.problem_of, None) is None and must(m.problem_of, {**status, 'failing': None}) is None
    assert m.closed(201, 'bad_jwt') is None and m.closed(500, 'secret') == 'other' and m.closed(403, 'bad_jwt') == 'bad_jwt'      # a 2xx has no reason; a stranger's word is a class
    answers.update({url: (lambda: 201) for url in answers})                                                                # every device takes the next one: the refusal goes
    settled(box, audit, 'approval', 'caixa')
    assert rows_of(tmp / 'audit.db', "SELECT COUNT(*) FROM audit_log WHERE action='notifications.deliver' AND detail='result'")[0][0] == 3      # four 2xx more, not one row more
    assert all(d['last']['ok'] and d['last']['reason'] is None for d in box.mine('basic:ana')) and box.status()['failing'] is None and must(m.problem_of, box.status()) is None
    answers[MOZ] = lambda: 410
    answers[FCM] = lambda: (_ for _ in ()).throw(RuntimeError('network down: https://fcm.googleapis.com/fcm/send/dEvIcE-1:APA91b'))   # a sender that fails
    sent_before = len(sender.sent)
    with Lines() as lines:
        settled(box, audit, 'approval', 'x')
    assert len(sender.sent) - sent_before == 4                                                                             # every device was tried, the failing one first
    assert [d['host'] for d in box.mine('basic:ana')] == ['fcm.googleapis.com', 'web.push.apple.com', 'wns2-par02p.notify.windows.com']       # the gone device is forgotten
    fcm = [d for d in box.mine('basic:ana') if d['id'] == ids[FCM]][0]['last']
    assert (fcm['ok'], fcm['status'], fcm['reason']) == (False, 0, 'other') and box.status()['failing'] == {'devices': 1, 'reason': 'other'}      # and the next device was still sent
    assert [d['last']['ok'] for d in box.mine('basic:ana')] == [False, True, True] and 'dEvIcE' not in ' '.join(lines)
    one = tmp / 'one.db'
    audit_one = sibling(m, 'audit').AuditLog(one)
    quick = m.Push(one, subject='https://luve.app', source='public_url', sender=Sender())
    sub(m, audit_one, quick, FCM)
    for n in range(m.LOG_KEEP + 8):
        settled(quick, audit_one, 'approval', f'b{n}')
    assert rows_of(one, 'SELECT COUNT(*) FROM push_log')[0][0] == m.LOG_KEEP                                                # the last 50, no more


def inv_push_a_failure_logs_one_line_per_host_and_never_the_capability(m, tmp):
    now = [5_000_000.0]
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', source='public_url', sender=Sender(lambda url: m._status(403, 'bad_jwt')), clock=lambda: now[0])
    for endpoint in (FCM, FCM + '2', MOZ):
        sub(m, audit, box, endpoint)
    m._LOGGED.clear()
    with Lines() as lines:
        settled(box, audit, 'approval', 'vendas')                       # two failures on one host, one on another: two lines
        assert len(lines) == 2, lines
        now[0] += 30
        settled(box, audit, 'approval', 'vendas')                       # the same minute: nothing more
        assert len(lines) == 2, lines
        now[0] += 31
        settled(box, audit, 'approval', 'vendas')                       # the next minute: one more each
        assert len(lines) == 4, lines
    text = '\n'.join(lines)
    for secret in ('dEvIcE', 'APA91b', 'gAAAAB', 'eyJ', 'vapid', 'luve.app', 'Authorization'):
        assert secret not in text, secret
    assert 'fcm.googleapis.com' in text and 'updates.push.services.mozilla.com' in text and '403' in text and 'bad_jwt' in text
    with Lines() as quiet:                                              # a success says nothing
        ok = m.Push(tmp / 'audit.db', subject='https://luve.app', source='public_url', sender=Sender(), clock=lambda: now[0] + 1000)
        settled(ok, audit, 'approval', 'vendas')
    assert quiet == []


def inv_push_the_answer_is_classified_and_not_kept(m, tmp):
    class Body(io.BytesIO):
        asked = []

        def read(self, n=-1):
            Body.asked.append(n)
            return super().read(n)

    class Ok:
        def __init__(self, status):
            self.status = status

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def post(code=None, text=b'', error=None):
        class Opener:
            def open(self, request, timeout):
                if error is not None:
                    raise error
                if code < 400:
                    return Ok(code)
                raise urllib.error.HTTPError(request.full_url, code, 'x', {}, Body(text))
        real_opener, m._OPENER = m._OPENER, Opener()
        try:
            return must(m.http_post, FCM, {'TTL': '3600'})
        finally:
            m._OPENER = real_opener
    cases = [(201, b'', None), (403, b'{"reason":"BadJwtToken"}', 'bad_jwt'), (400, b'JWT is invalid', 'bad_jwt'), (401, b'invalid JWT provided', 'bad_jwt'), (403, b'', 'key_mismatch'), (401, b'', 'key_mismatch'),
             (403, b'the key does not correspond to the sender ID', 'key_mismatch'), (403, b'{"reason":"ExpiredToken"}', 'expired'), (401, b'jwt expired', 'expired'), (413, b'', 'too_large'),
             (400, b'PayloadTooLarge', 'too_large'), (400, b'Payload Too Large', 'too_large'), (429, b'', 'rate_limited'), (500, b'jwt', 'other'), (503, b'', 'other'), (404, b'', 'other'), (410, b'', 'expired')]
    for code, text, reason in cases:
        got = post(code, text)
        assert int(got) == code and got.reason == reason and vars(got) == {'reason': reason}, (code, text, got.reason)      # the status and ONE word of the closed list: the text is gone
    Body.asked.clear()
    got = post(403, b'x' * 300 + b'expired')
    assert Body.asked == [m.BODY_MAX] and got.reason == 'key_mismatch'                                                  # read to 256 bytes and no further
    for error, reason in ((TimeoutError(), 'timeout'), (OSError('The read operation timed out'), 'timeout'), (urllib.error.URLError(TimeoutError()), 'timeout'),
                          (urllib.error.URLError(ConnectionRefusedError()), 'other'), (ConnectionResetError(), 'other')):
        got = post(error=error)
        assert int(got) == 0 and got.reason == reason, (error, got.reason)
    assert all(r in m.REASONS for _c, _t, r in cases if r) and len(m.REASONS) == 7


def inv_push_the_test_wakes_only_the_callers_devices(m, tmp):
    sender = Sender(lambda url: {FCM: 201, MOZ: m._status(403, 'bad_jwt'), APPLE: 410}.get(url, 201))
    now = [3_000_000.0]
    path = tmp / 'audit.db'
    audit = sibling(m, 'audit').AuditLog(path)
    box = m.Push(path, subject='https://luve.app', source='public_url', sender=sender, clock=lambda: now[0])
    assert must(box.test, audit, 'basic:ana', 'req_t0') == {'devices': []} and rows_of(path, 'SELECT COUNT(*) FROM push_tests')[0][0] == 0      # nothing to wake: the 10 seconds are not spent
    fcm, moz, apple = (sub(m, audit, box, url)['id'] for url in (FCM, MOZ, APPLE))
    other = sub(m, audit, box, WIN, actor='basic:bia')['id']
    result = must(box.test, audit, 'basic:ana', 'req_t1')
    assert result == {'devices': [{'id': fcm, 'host': 'fcm.googleapis.com', 'ok': True, 'status': 201, 'reason': None},
                                  {'id': moz, 'host': 'updates.push.services.mozilla.com', 'ok': False, 'status': 403, 'reason': 'bad_jwt'},
                                  {'id': apple, 'host': 'web.push.apple.com', 'ok': False, 'status': 410, 'reason': 'expired'}]}
    assert sorted(u for u, _h in sender.sent) == sorted([FCM, MOZ, APPLE]) and all(h['Topic'] == 'test' and h['Content-Length'] == '0' for _u, h in sender.sent)   # hers only, the same empty wake
    assert [d['id'] for d in box.mine('basic:ana')] == [fcm, moz] and box.mine('basic:bia')[0]['last'] is None            # the gone one is forgotten; hers only was touched
    assert box.mine('basic:ana')[1]['last']['reason'] == 'bad_jwt'                                                         # and the device list shows what the test found
    assert rows_of(path, 'SELECT COUNT(*) FROM push_events')[0][0] == 0 and box.latest('basic:ana') == []                 # a test records no event
    for secret in ('dEvIcE', 'APA91b', 'QGuQ', 'gAAAAB', '/fcm/'):
        assert secret not in json.dumps(result), secret
    assert rows_of(path, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.test' AND actor='basic:ana' AND origin_kind='ui' AND origin_ref='req_t1' AND detail='intent'")[0][0] == 1
    assert rows_of(path, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.deliver' AND detail='result'")[0][0] == 0      # none per device for a test: the one `notifications.test` row carries the count (A-189)
    assert rows_of(path, "SELECT target FROM audit_log WHERE action='notifications.test' AND detail='intent'") == [('devices:3',)]
    before = len(sender.sent)
    error = refused(m, 'rate_limited', box.test, audit, 'basic:ana', 'req_t2')
    assert error.status == 429 and len(sender.sent) == before                                                                 # one every 10 seconds per person
    now[0] += m.TEST_EVERY - 1
    refused(m, 'rate_limited', box.test, audit, 'basic:ana', 'req_t3')
    assert must(box.test, audit, 'basic:bia', 'req_t4')['devices'][0]['id'] == other                                          # another person has their own window
    now[0] += 2
    assert [d['id'] for d in must(box.test, audit, 'basic:ana', 'req_t5')['devices']] == [fcm, moz]                           # and it reopens


def inv_push_the_test_is_bounded_and_side_by_side(m, tmp):
    old = m.TEST_DEADLINE
    m.TEST_DEADLINE = 1.0
    try:
        audit, box = rig(m, tmp, Sender(delay=0.4))
        for url in (FCM, MOZ, APPLE):
            sub(m, audit, box, url)
        started = time.monotonic()
        result = must(box.test, audit, 'basic:ana', 'req_a')
        assert [d['ok'] for d in result['devices']] == [True, True, True] and time.monotonic() - started < 0.9        # three sends of 0.4 s side by side, not one after the other
        tmp2 = tmp / 'hang'
        tmp2.mkdir()
        audit, box = rig(m, tmp2, Sender(delay=2.5))
        for url in (FCM, MOZ):
            sub(m, audit, box, url)
        started = time.monotonic()
        result = must(box.test, audit, 'basic:ana', 'req_b')
        assert time.monotonic() - started < 2.0                                                                       # the call waits 1 s, never for a service that hangs
        assert [(d['ok'], d['status'], d['reason']) for d in result['devices']] == [(False, 0, 'timeout')] * 2
    finally:
        m.TEST_DEADLINE = old


def inv_push_the_key_a_device_used_is_compared(m, tmp):
    audit, box = rig(m, tmp)
    current = box.config()['public_key']
    expected = hashlib.sha256(base64.urlsafe_b64decode(current + '=')).hexdigest()[:16]
    assert m.key_id_of(current) == expected and m.key_id_of(current + '=') == expected
    for bad in ('', 'x', '!!!', 'a+b/' * 8, 'A' * 200, 5, None):
        assert m.key_id_of(bad) is None, bad
    for n in (17, 21, 137):                                                                 # a length that cannot be base64 is `not a key`, never an exception (F-N6-1)
        assert must(m.key_id_of, 'A' * n) is None, n
    must(refused, m, 'invalid_field', m.subscribe_body, {'endpoint': FCM, 'application_server_key': 'A' * 21})
    assert must(m.subscribe_body, {'endpoint': FCM, 'application_server_key': current}) == (FCM, ['approval', 'budget', 'question'], expected)
    assert must(m.subscribe_body, {'endpoint': FCM, 'application_server_key': None})[2] is None
    for bad in ('', 'x', 'a+b/' * 8, 5, ['k']):
        refused(m, 'invalid_field', m.subscribe_body, {'endpoint': FCM, 'application_server_key': bad})

    def keyed(endpoint, key, actor='basic:ana', kinds=None):
        return box.subscribe(audit, actor, endpoint, kinds or list(m.KINDS), 'req_k', m.key_id_of(key))
    first = must(keyed, FCM, current)['id']
    assert box.mine('basic:ana')[0]['stale'] is False
    error = refused(m, 'key_mismatch', keyed, FCM, another_key(), 'basic:ana', ['budget'])
    assert error.status == 409 and box.mine('basic:ana')[0]['kinds'] == ['approval', 'budget', 'question']                          # refused: the device is left as it was
    refused(m, 'key_mismatch', keyed, MOZ, another_key())
    assert [d['id'] for d in box.mine('basic:ana')] == [first]                                                          # and a new device with a wrong key is not stored
    must(sub, m, audit, box, MOZ)                                                                                      # an older screen: no key
    assert [d['stale'] for d in box.mine('basic:ana')] == [False, True] and box.status()['stale'] == 1
    must(lambda: sub(m, audit, box, FCM, kinds=['budget']))                                                                     # a change of kinds is not a renewal: the key it had stays
    assert [(d['stale'], d['kinds']) for d in box.mine('basic:ana')][0] == (False, ['budget']) and box.status()['stale'] == 1
    must(keyed, MOZ, current)                                                                                           # the device renews: no longer stale
    assert [d['stale'] for d in box.mine('basic:ana')] == [False, False] and box.status()['stale'] == 0
    conn = sqlite3.connect(tmp / 'audit.db')
    conn.execute('UPDATE push_key SET public_key=?', (another_key(),))                                                  # the server's key changed: every device is now on the old one
    conn.commit()
    conn.close()
    assert [d['stale'] for d in box.mine('basic:ana')] == [True, True] and box.status()['stale'] == 2


def inv_push_the_question_kind(m, tmp):
    """Contract v0.11 7.6: a third kind. A device's stored list is explicit: one that saved `approval` and `budget` does not get `question` until it saves its kinds again; a new subscription with no `kinds` gets all
    three; the event carries the kind and the Bot only and `latest` says where to go."""
    assert m.KINDS == ('approval', 'budget', 'question') and m.LINKS.get('question') == '/activity'
    sender = Sender()
    audit, box = rig(m, tmp, sender)
    assert box.config()['enabled_kinds'] == ['approval', 'budget', 'question']
    old = sub(m, audit, box, FCM, kinds=['approval', 'budget'])['id']                       # a device from before the kind: its list is explicit
    new = must(box.subscribe, audit, 'basic:ana', MOZ, m.kinds_of(None), 'req_n')['id']       # a new subscription that said nothing: all three
    sub(m, audit, box, APPLE, kinds=['question'], actor='basic:bia')
    assert [d['kinds'] for d in box.mine('basic:ana')] == [['approval', 'budget'], ['approval', 'budget', 'question']] and box.mine('basic:bia')[0]['kinds'] == ['question']
    settled(box, audit, 'question', 'vendas')
    assert sorted(u for u, _h in sender.sent) == sorted([MOZ, APPLE]) and all(h['Topic'] == 'question' for _u, h in sender.sent)   # the old device is not woken
    assert [e['bot'] for e in must(box.latest, 'basic:ana', old)] == [] and [e['bot'] for e in must(box.latest, 'basic:ana', new)] == ['vendas']   # and does not see it either
    assert must(box.latest, 'basic:bia') == [{'kind': 'question', 'bot': 'vendas', 'at': box.latest('basic:bia')[0]['at'], 'link': '/activity'}]
    assert set(box.latest('basic:ana')[0]) == {'kind', 'bot', 'at', 'link'}                 # nothing else travels: no text of the wait
    assert 'sms' not in m.KINDS and refused(m, 'invalid_field', m.subscribe_body, {'endpoint': FCM, 'kinds': ['question', 'sms']})
    assert m.subscribe_body({'endpoint': FCM, 'kinds': ['question']})[1] == ['question']
    conn = sqlite3.connect(tmp / 'audit.db')
    conn.execute("UPDATE push_subscriptions SET kinds='[\"approval\", \"budget\"]' WHERE id=?", (new,))        # saved again WITHOUT the kind: gone
    conn.commit()
    conn.close()
    sender.sent.clear()
    settled(box, audit, 'question', 'caixa')
    assert [u for u, _h in sender.sent] == [APPLE]


def inv_push_only_the_origin_is_sent(m, tmp):
    """A-189: the contact in the JWT is the ORIGIN of an https URL (its path and query are nobody's business at Apple, Google or Mozilla), a mailto as it is; never shown anywhere."""
    cases = (('https://luve.app/admin?token=SECRETPATH#frag', 'https://luve.app'), ('https://luve.app:8443/x/y', 'https://luve.app:8443'), ('https://luve.app', 'https://luve.app'), ('mailto:ops@luve.app', 'mailto:ops@luve.app'),
             ('https://luve.app:/x', 'https://luve.app'), ('https://luve.app:0080/x', 'https://luve.app:80'), ('https://luve.app:443/x', 'https://luve.app'), ('https://luve.app:00443/x', 'https://luve.app'),
             ('https://LUVE.App:8443/x', 'https://luve.app:8443'), ('https://luve.app:65535/', 'https://luve.app:65535'))
    for index, (given, sent) in enumerate(cases):
        path = tmp / f'or{index}.db'
        sender = Sender()
        audit = sibling(m, 'audit').AuditLog(path)
        box = m.Push(path, subject=given, source='setting', sender=sender)
        sub(m, audit, box, FCM)
        must(box.test, audit, 'basic:ana', 'req_o')
        (url, headers), = sender.sent
        claims = jwt.decode(headers['Authorization'].split('t=')[1].split(',')[0], options={'verify_signature': False})
        assert claims['sub'] == sent and set(claims) == {'aud', 'exp', 'sub'}, (given, claims)
        assert 'SECRETPATH' not in json.dumps([headers, box.config(), box.status()])


def inv_push_the_tables_are_bounded(m, tmp):
    """A-189 (F-N6-4): `_TOKENS` and `_LOGGED` are keyed by the host of a push service, which a person chooses for `*.notify.windows.com`: 64 entries each, the oldest dropped."""
    now = [6_000_000.0]
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', source='public_url', sender=Sender(lambda url: m._status(403, 'bad_jwt')), clock=lambda: now[0])
    m._TOKENS.clear()
    m._LOGGED.clear()
    try:
        with Lines():
            real_one = box.subscribe(audit, 'basic:zoe', FCM, ['approval'], 'req_f')['id']       # a REAL service, logged and tokened FIRST (the oldest entry of both tables) and never again
            must(box.test, audit, 'basic:zoe', 'req_f')
            box.unsubscribe(audit, 'basic:zoe', real_one, 'req_f')
            now[0] += 11
            for i in range(104):
                sid = box.subscribe(audit, 'basic:ana', f'https://h{i}.notify.windows.com/w/?token=x', ['approval'], 'req_g')['id']
                must(box.test, audit, 'basic:ana', 'req_g')
                box.unsubscribe(audit, 'basic:ana', sid, 'req_g')
                now[0] += 11
        assert len(m._TOKENS) == 64 and len(m._LOGGED) == 64, (len(m._TOKENS), len(m._LOGGED))
        assert 'fcm.googleapis.com' in m._LOGGED and 'https://fcm.googleapis.com' in {key[0] for key in m._TOKENS}       # the real service was NEVER pushed out by hosts a person made up (A-197)
        assert 'h103.notify.windows.com' in m._LOGGED and 'h41.notify.windows.com' in m._LOGGED and 'h40.notify.windows.com' not in m._LOGGED and 'h0.notify.windows.com' not in m._LOGGED     # 63 chosen ones: the oldest of THEM went
        audiences = {key[0] for key in m._TOKENS}
        assert 'https://h103.notify.windows.com' in audiences and 'https://h41.notify.windows.com' in audiences and 'https://h0.notify.windows.com' not in audiences
    finally:
        m._TOKENS.clear()
        m._LOGGED.clear()


def inv_push_the_host_of_an_endpoint_is_read_in_lowercase(m, tmp):
    """A-200 (N-1d, F-N6-14): `endpoint_of` lowercases the host only to compare and stores the endpoint as received, so the audience, the token key and the class of an entry (a real service, or a host a PERSON chose) come from the LOWERCASE
    netloc: the `aud` is an origin, a case variant of one host shares its token, and sixty-five capital Windows hosts do not push the three fixed services out of `_TOKENS` or `_LOGGED`. The path of the endpoint (the capability) is not touched."""
    def boxed(name):
        audit = sibling(m, 'audit').AuditLog(tmp / name)
        sender = Sender(lambda url: m._status(403, 'bad_jwt'))
        return audit, sender, m.Push(tmp / name, subject='https://luve.app', source='public_url', sender=sender, clock=lambda: 7_000_000.0)
    lower, upper = 'https://x1.notify.windows.com/W/?token=AbC', 'https://X1.NOTIFY.WINDOWS.COM/W/?token=XyZ'
    m._TOKENS.clear()
    m._LOGGED.clear()
    try:
        audit, sender, box = boxed('twins.db')
        with Lines():
            sub(m, audit, box, lower)
            sub(m, audit, box, upper, actor='basic:bia')
            settled(box, audit, 'approval', 'vendas')
        sent = [(url, headers['Authorization'], jwt.decode(headers['Authorization'].partition(', k=')[0][len('vapid t='):], options={'verify_signature': False})['aud']) for url, headers in sender.sent]
        assert sorted(url for url, _h, _a in sent) == sorted([lower, upper]), [(u, a) for u, _h, a in sent]                                         # each wake goes to its endpoint AS STORED: the path is the capability
        assert {aud for _u, _h, aud in sent} == {'https://x1.notify.windows.com'}, [(u, a) for u, _h, a in sent]                                   # an origin is lowercase
        assert len({auth for _u, auth, _a in sent}) == 1 and len(m._TOKENS) == 1, (len(m._TOKENS), [(u, a) for u, _h, a in sent])                 # the capital twin shares the token of the lowercase one: one JWT, one entry
        m._TOKENS.clear()
        m._LOGGED.clear()
        audit, sender, box = boxed('many.db')
        for endpoint in (FCM, MOZ, APPLE):
            sub(m, audit, box, endpoint)
        for i in range(65):
            sub(m, audit, box, f'https://H{i}.NOTIFY.WINDOWS.COM/w/?token=x', actor=f'basic:p{i // 10}')
        m._TOKENS.clear()
        m._LOGGED.clear()
        with Lines():
            settled(box, audit, 'approval', 'vendas')
        assert {key[0].removeprefix('https://') for key in m._TOKENS} >= set(m.HOSTS) and set(m.HOSTS) <= set(m._LOGGED), (sorted(key[0] for key in m._TOKENS)[:4], sorted(m._LOGGED)[:4])   # the fixed services stay in BOTH tables
        assert len(m._TOKENS) <= 64 and len(m._LOGGED) <= 64 and all(host == host.lower() for host in m._LOGGED)
        for key in ('https://X1.NOTIFY.WINDOWS.COM', ('https://X1.NOTIFY.WINDOWS.COM', 's', 'k'), 'X1.NOTIFY.WINDOWS.COM', ('HTTPS://x1.notify.windows.com', 's', 'k')):
            assert m._chosen(key), key                                                                                 # the class is read in lowercase whoever built the key...
        for key in ('https://FCM.GOOGLEAPIS.COM', ('https://Web.Push.Apple.com', 's', 'k'), 'updates.push.services.mozilla.com'):
            assert not m._chosen(key), key
        table = {}
        for host in m.HOSTS:
            m._put(table, (f'https://{host}', 's', 'k'), 1)
        for i in range(70):
            m._put(table, (f'https://H{i}.NOTIFY.WINDOWS.COM', 's', 'k'), 1)
        assert len(table) == 64 and all((f'https://{host}', 's', 'k') in table for host in m.HOSTS)                    # ...and a capital host a person chose goes before a real service
    finally:
        m._TOKENS.clear()
        m._LOGGED.clear()


def inv_push_the_test_window_holds_under_concurrency(m, tmp):
    """A-189 (F-N6-3, A-197): the clock is read INSIDE the write lock, and the window is `0 <= now - last < 10`: a clock that went BACK (an NTP step, a VM resumed) is not inside it, whatever the size of the step."""
    sender = Sender()
    audit = sibling(m, 'audit').AuditLog(tmp / 'audit.db')
    box = m.Push(tmp / 'audit.db', subject='https://luve.app', source='public_url', sender=sender, clock=lambda: 50.0)
    sub(m, audit, box, FCM)
    seen = set()

    def clock():
        if threading.current_thread().name == 'B' and 'B' not in seen:
            seen.add('B')
            time.sleep(0.4)                                                                   # B reached the lock FIRST and read the clock there (an earlier value than A's, who writes after it)
            return 100.000
        return 100.001
    box.clock = clock
    out = []

    def call(tag):
        try:
            box.test(audit, 'basic:ana', 'req_' + tag)
            out.append((tag, 'sent'))
        except Exception as error:  # noqa: BLE001
            out.append((tag, getattr(error, 'code', type(error).__name__)))
    b = threading.Thread(target=call, args=('B',), name='B')
    a = threading.Thread(target=call, args=('A',), name='A')
    b.start()
    time.sleep(0.05)
    a.start()
    a.join()
    b.join()
    assert sorted(result for _tag, result in out) == ['rate_limited', 'sent'] and len(sender.sent) == 1, (out, len(sender.sent))
    other = tmp / 'back'
    other.mkdir()
    moment = [100.0]
    audit2 = sibling(m, 'audit').AuditLog(other / 'audit.db')
    box2 = m.Push(other / 'audit.db', subject='https://luve.app', source='public_url', sender=Sender(), clock=lambda: moment[0])
    sub(m, audit2, box2, FCM)
    assert must(box2.test, audit2, 'basic:ana', 'req_b1')['devices'][0]['ok'] is True
    for index, step in enumerate((1, 30, 600, 3600)):                                          # the clock went BACK: the time of the last test is in the FUTURE, and that is not a window
        moment[0] = 100.0 - step
        assert must(box2.test, audit2, 'basic:ana', f'req_s{index}')['devices'][0]['ok'] is True, step
        moment[0] += 1                                                                      # and the limit itself holds: one second after the last test
        refused(m, 'rate_limited', box2.test, audit2, 'basic:ana', f'req_t{index}')
        moment[0] += m.TEST_EVERY                                                           # ten seconds after: free again


def inv_push_the_wake_goes_out_whatever_the_audit_result_does(m, tmp):
    """N-3c (contract 7.6 (d)): the point of commit is the event row with its key; after it the wake goes out, whatever becomes of the audit's own RESULT row. If the effect itself fails (no event row) nothing is sent and the key
    is free, so a wait with a key is tried again on the next tick. Approval, budget and question share `notify`."""
    class AuditFails:
        """`act` runs the effect and then raises, the way an audit whose result row does not write does; with `before=True` it raises BEFORE the effect (the intent row fails)."""
        def __init__(self, real, before=False):
            self.real, self.before = real, before

        def act(self, *args, **kwargs):
            if args[1] == 'notifications.push':
                if self.before:
                    raise sqlite3.OperationalError('database is locked')
                self.real.act(*args, **kwargs)
                raise sqlite3.OperationalError('database is locked')                      # the result row did not write
            return self.real.act(*args, **kwargs)
    for index, (kind, key) in enumerate((('question', 'wait:vendas:req_a'), ('budget', 'pause:vendas:100.5'), ('approval', None))):
        path = tmp / f'n3c{index}.db'
        sender = Sender()
        real_audit = sibling(m, 'audit').AuditLog(path)
        box = m.Push(path, subject='https://luve.app', source='public_url', sender=sender)
        box.subscribe(real_audit, 'basic:ana', FCM, list(m.KINDS), 'req_1')
        with Lines() as lines:
            thread = box.notify(AuditFails(real_audit), kind, 'vendas', key)
            assert thread is not None, kind                                              # the thread started although the audit raised
            thread.join(5)
        assert [h['Topic'] for _u, h in sender.sent] == [kind], (kind, sender.sent)         # and the push service was called
        assert rows_of(path, 'SELECT COUNT(*) FROM push_events')[0][0] == 1 and (key is None or box._notified(key)), kind     # the event row, and the key says "said"
        assert len(lines) == 1 and 'audit result was not written' in lines[0] and 'OperationalError' in lines[0] and 'luve.app' not in lines[0] and FCM[-10:] not in lines[0], lines
        path2 = tmp / f'n3c{index}b.db'                                                    # the intent row fails: no effect, no event, nothing sent, and the key is free
        sender2 = Sender()
        real_audit2 = sibling(m, 'audit').AuditLog(path2)
        box2 = m.Push(path2, subject='https://luve.app', source='public_url', sender=sender2)
        box2.subscribe(real_audit2, 'basic:ana', FCM, list(m.KINDS), 'req_1')
        with Lines() as before_lines:
            assert box2.notify(AuditFails(real_audit2, before=True), kind, 'vendas', key) is None
        assert before_lines == ['notify failed: OperationalError'], before_lines                  # the error that stopped it is the one said, not a consequence of it
        assert sender2.sent == [] and rows_of(path2, 'SELECT COUNT(*) FROM push_events')[0][0] == 0 and (key is None or not box2._notified(key)), kind
        thread = box2.notify(real_audit2, kind, 'vendas', key)                             # the next try (a healthy audit) says it
        thread and thread.join(5)
        assert [h['Topic'] for _u, h in sender2.sent] == [kind], kind


def inv_push_a_commit_that_fails_sends_nothing_and_leaves_the_key_free(m, tmp):
    """N-3d (contract 7.6 (d)): the point of commit is the event row. When the COMMIT itself fails the event was never written: nothing is sent, there is no event row, the key is free, and the next try with a healthy
    connection sends. (The wake of an event that never existed would be a notice with nothing behind it.)"""
    class FailingCommit:
        """A connection that delegates everything and whose `commit` says the database is locked."""
        def __init__(self, conn):
            self._conn = conn

        def commit(self):
            raise sqlite3.OperationalError('database is locked')

        def __getattr__(self, name):
            return getattr(self._conn, name)
    for index, (kind, key) in enumerate((('question', 'wait:vendas:req_a'), ('budget', 'pause:vendas:100.5'), ('approval', None))):
        path = tmp / f'n3d{index}.db'
        sender = Sender()
        audit = sibling(m, 'audit').AuditLog(path)
        box = m.Push(path, subject='https://luve.app', source='public_url', sender=sender)
        box.subscribe(audit, 'basic:ana', FCM, list(m.KINDS), 'req_1')
        healthy = box._connect
        box._connect = lambda: FailingCommit(healthy())                                    # the connection `notify` opens cannot commit
        with Lines() as lines:
            thread = box.notify(audit, kind, 'vendas', key)
        del box._connect                                                                    # the healthy connection again
        assert thread is None and sender.sent == [], (kind, sender.sent)                    # nothing was sent: there is no event
        assert rows_of(path, 'SELECT COUNT(*) FROM push_events')[0][0] == 0 and (key is None or not box._notified(key)), kind     # no event row, and the key is free
        assert lines == ['notify failed: OperationalError'], lines                           # the error that stopped it is the one said
        assert rows_of(path, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.push' AND outcome='error'")[0][0] == 1   # and the audit says the effect failed
        thread = box.notify(audit, kind, 'vendas', key)                                     # the next try, with the healthy connection, sends
        thread and thread.join(5)
        assert [h['Topic'] for _u, h in sender.sent] == [kind] and rows_of(path, 'SELECT COUNT(*) FROM push_events')[0][0] == 1 and (key is None or box._notified(key)), kind


INVARIANTS = {n[4:]: f for n, f in globals().items() if n.startswith('inv_')}
MUTATIONS = [
    ('push_endpoint_allowlist', 'any https host', "    if url.scheme != 'https' or url.username or url.password or port not in (None, 443) or not allowed",
     "    if url.scheme != 'https'"),
    ('push_endpoint_allowlist', 'any subdomain of a push host', "    allowed = host in HOSTS or", "    allowed = any(host.endswith(h) for h in HOSTS) or"),
    ('push_no_payload_and_a_valid_vapid_jwt', 'a payload is sent', "    request = urllib.request.Request(url, data=b'', method='POST', headers=headers)",
     "    request = urllib.request.Request(url, data=json.dumps(headers).encode(), method='POST', headers=headers)"),
    ('push_no_payload_and_a_valid_vapid_jwt', 'the audience is the whole endpoint', "token = self._token(jwt, pem, public, f'{url.scheme}://{url.netloc.lower()}')",
     "token = self._token(jwt, pem, public, target['endpoint'])"),
    ('push_no_payload_and_a_valid_vapid_jwt', 'redirects are followed', "_OPENER = urllib.request.build_opener(_NoRedirect)",
     "_OPENER = urllib.request.build_opener()"),
    ('push_private_key_never_leaves', 'the private key in the config', "        return {'public_key': self._key()[1], 'enabled_kinds': list(KINDS), 'subject':",
     "        return {'public_key': self._key()[1], 'enabled_kinds': list(KINDS), 'private_key': self._key()[0].decode(), 'subject':"),
    ('push_private_key_never_leaves', 'the contact in the config', "'subject': {'ok': self.subject is not None, 'source': self.source}}", "'subject': {'ok': self.subject is not None, 'source': self.source, 'value': self.subject}}"),
    ('push_gone_removes', 'a gone device is kept', "            if status in GONE:  # the device unsubscribed: forget it", "            if False:"),
    ('push_never_blocks', 'the event waits for the push', "            thread.start()\n            return thread",
     "            thread.start()\n            thread.join()\n            return thread"),
    ('push_devices_kinds_and_owner', 'every device gets every kind', "                            if kind in stored_kinds(r['kinds'])]", "                            ]"),
    ('push_devices_kinds_and_owner', 'no device limit', "                if mine >= MAX_PER_ACTOR:", "                if False:"),
    ('push_devices_kinds_and_owner', 'anyone removes any device', "'DELETE FROM push_subscriptions WHERE id=? AND actor=?', (sid, actor)",
     "'DELETE FROM push_subscriptions WHERE id=? OR ?=?', (sid, actor, actor)"),
    ('push_latest_by_subscribed_kinds', 'cut to 5 first, then filter', "'SELECT kind, bot, created_at FROM push_events WHERE kind IN ({marks}) AND created_at >= ? '",
     "'SELECT kind, bot, created_at FROM (SELECT * FROM push_events ORDER BY id DESC LIMIT 5) WHERE kind IN ({marks}) AND created_at >= ? '"),
    ('push_latest_by_subscribed_kinds', 'no subscription shows everything', "            if not kinds:\n                return []", "            if not kinds:\n                kinds = list(KINDS)"),
    ('push_latest_by_subscribed_kinds', 'no TTL', "self.clock() - TTL", "0"),
    ('push_latest_by_subscribed_kinds', 'the device id is ignored', "wanted = [r for r in rows if r['id'] == sub] or rows", "wanted = rows"),
    ('push_latest_by_subscribed_kinds', 'the first device only, not the union', "wanted = [r for r in rows if r['id'] == sub] or rows", "wanted = [r for r in rows if r['id'] == sub] or rows[:1]"),
    ('push_latest_by_subscribed_kinds', "another person's device narrows it", "'SELECT id, kinds FROM push_subscriptions WHERE actor=?', (actor,)",
     "'SELECT id, kinds FROM push_subscriptions WHERE actor=? OR id=?', (actor, sub)"),
    ('push_latest_by_subscribed_kinds', 'every person sees the team', "'SELECT id, kinds FROM push_subscriptions WHERE actor=?', (actor,)",
     "'SELECT id, kinds FROM push_subscriptions WHERE ?=?', (actor, actor)"),
    ('push_sender_and_latest_read_kinds_alike', 'the sender reads kinds its own way', "if kind in stored_kinds(r['kinds'])]", "if kind in json.loads(r['kinds'])]"),
    ('push_sender_and_latest_read_kinds_alike', 'latest reads kinds its own way', "for k in stored_kinds(r['kinds'])}", "for k in json.loads(r['kinds'])}"),
    ('push_sender_and_latest_read_kinds_alike', 'an unknown kind is trusted', "return tuple(k for k in value if k in KINDS) if isinstance(value, list) else ()", "return tuple(value)"),
    ('push_a_post_by_another_person_moves_the_device', 'the move is never said', "return sid, previous is not None and previous[0] != actor", "return sid, False"),
    ('push_a_post_by_another_person_moves_the_device', 'an update is called a move', "return sid, previous is not None and previous[0] != actor", "return sid, previous is not None"),
    ('push_a_post_by_another_person_moves_the_device', 'the move is audited as a plain subscribe', "'notifications.move' if owner not in (None, actor) else 'notifications.subscribe'", "'notifications.subscribe'"),
    ('push_a_post_by_another_person_moves_the_device', 'the device stays with the first person', "DO UPDATE SET actor=excluded.actor,", "DO UPDATE SET actor=push_subscriptions.actor,"),
    ('push_the_vapid_token_is_reused', 'a new token for every send', "            if token is None or exp - now < JWT_REUSE_HOURS * 3600:", "            if True:"),
    ('push_the_vapid_token_is_reused', 'a token is kept past its margin', "            if token is None or exp - now < JWT_REUSE_HOURS * 3600:", "            if token is None or exp - now < 0:"),
    ('push_the_vapid_token_is_reused', 'one token for every push service', "        key = (audience, self.subject, public)", "        key = (self.subject, public)"),
    ('push_the_vapid_token_is_reused', 'one token for every subject', "        key = (audience, self.subject, public)", "        key = (audience, public)"),
    ('push_no_payload_and_a_valid_vapid_jwt', 'no topic to coalesce a burst', "'Topic': kind,", "'Topic_': kind,"),
    ('push_no_payload_and_a_valid_vapid_jwt', 'the topic is not the kind', "'Topic': kind,", "'Topic': 'x' * 40,"),
    ('push_a_keyed_event_is_once', 'the look before the audit is gone', "            if key is not None and self._notified(key):\n                return None\n", "            if False:\n                return None\n"),
    ('push_a_keyed_event_is_once', 'a duplicate insert is an error', "INSERT OR IGNORE INTO push_events (kind, bot, created_at, dedupe)", "INSERT INTO push_events (kind, bot, created_at, dedupe)"),
    ('push_a_keyed_event_is_once', 'a lost race still wakes the devices', "created_at, dedupe) VALUES (?,?,?,?)', (kind, bot, self.clock(), key)).rowcount == 0:", "created_at, dedupe) VALUES (?,?,?,?)', (kind, bot, self.clock(), key)).rowcount == -1:"),
    ('push_a_keyed_event_is_once', 'the key is not stored', "(kind, bot, self.clock(), key)).rowcount == 0", "(kind, bot, self.clock(), None)).rowcount == 0"),
    ('push_a_keyed_event_is_once', 'no unique index', "            conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS push_events_dedupe ON push_events (dedupe) WHERE dedupe IS NOT NULL')\n", ""),
    ('push_an_old_database_gets_the_key', 'no migration', "                conn.execute('ALTER TABLE push_events ADD COLUMN dedupe TEXT')\n", "                pass\n"),
    ('push_the_contact_is_one_a_service_takes', 'a name with no dot is a host', 'len(labels) > 1 and ', ''),
    ('push_the_contact_is_one_a_service_takes', 'any label is a label', "all(re.fullmatch(r'[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels)", 'all(label for label in labels)'),
    ('push_the_contact_is_one_a_service_takes', 'http is https', "return url.scheme == 'https' and", "return url.scheme in ('http', 'https') and"),
    ('push_the_contact_is_one_a_service_takes', 'user info is allowed', ' and not url.username and not url.password', ''),
    ('push_the_contact_is_one_a_service_takes', 'an empty name is a name', "re.fullmatch(r'[A-Za-z0-9._%+-]{1,64}', name) is not None and ", ''),
    ('push_the_contact_is_one_a_service_takes', 'the mailto domain is not looked at', 'is not None and _host_ok(host)', 'is not None'),
    ('push_the_contact_is_one_a_service_takes', 'a space is fine', 'ord(c) < 33 or ', ''),
    ('push_the_contact_is_one_a_service_takes', 'non-ASCII is fine', ' or ord(c) > 126', ''),
    ('push_the_contact_is_one_a_service_takes', 'any length', 'or len(value) > 200 or', 'or len(value) > 20000 or'),
    ('push_the_contact_is_one_a_service_takes', 'anything is a string', '    if not isinstance(value, str) or not value or len(value)', '    if not value or len(value)'),
    ('push_without_a_contact_nothing_is_sent', 'it sends without a contact', '        if self.subject is None:   # no contact the services accept', '        if False:   # no contact the services accept'),
    ('push_without_a_contact_nothing_is_sent', 'the test sends without a contact', "        if self.subject is None:\n            raise PluginError('needs_subject'", "        if False:\n            raise PluginError('needs_subject'"),
    ('push_without_a_contact_nothing_is_sent', 'the missing contact is said every time', "            due = now - _LOGGED.get('', -LOG_EVERY) >= LOG_EVERY\n", '            due = True\n'),
    ('push_a_refusal_is_seen_not_dropped', 'a refusal is dropped', "            self._record(audit, 'system', {'kind': 'system'}, kind, target, status, reason)", '            pass'),
    ('push_a_refusal_is_seen_not_dropped', 'the outcome is not kept on the device', "last_reason=? WHERE id=?'", "last_reason=? WHERE 0=1 AND id=?'"),
    ('push_a_refusal_is_seen_not_dropped', 'a refusal is marked ok', 'int(reason is None)', '1'),
    ('push_a_refusal_is_seen_not_dropped', "the service's word is kept as it came", '        reason = closed(status, reason)\n', '        reason = reason\n'),
    ('push_a_refusal_is_seen_not_dropped', 'a 2xx keeps a reason', '    return None if 200 <= status < 300 else reason if reason in REASONS else reason_of(status)', '    return reason if reason in REASONS else None if 200 <= status < 300 else reason_of(status)'),
    ('push_a_refusal_is_seen_not_dropped', 'any word is a reason', 'else reason if reason in REASONS else reason_of(status)', 'else reason or reason_of(status)'),
    ('push_a_refusal_is_seen_not_dropped', 'no deliver row', "audit.act(actor, 'notifications.deliver', f'{host}:{status}'", "audit.act(actor, 'notifications.delivery', f'{host}:{status}'"),
    ('push_a_refusal_is_seen_not_dropped', 'the deliver row has no status', "f'{host}:{status}', origin", "f'{host}', origin"),
    ('push_a_refusal_is_seen_not_dropped', 'the log is never cut', "ORDER BY id DESC LIMIT ?)', (LOG_KEEP,))", "ORDER BY id DESC LIMIT ?)', (10 ** 6,))"),
    ('push_a_refusal_is_seen_not_dropped', 'health counts the devices that worked', "FROM push_subscriptions WHERE last_ok=0').fetchone()", "FROM push_subscriptions WHERE last_ok=1').fetchone()"),
    ('push_a_refusal_is_seen_not_dropped', 'no problem for a calm list', "    if not failing:\n        return None\n    n = failing['devices']", "    if False:\n        return None\n    n = failing['devices']"),
    ('push_a_refusal_is_seen_not_dropped', 'the problem counts one device', "'devices': n, 'reason'", "'devices': 1, 'reason'"),
    ('push_a_refusal_is_seen_not_dropped', 'a failing sender stops the next device', "        except Exception as error:  # noqa: BLE001\n            return 0, reason_of(0, '', error)", '        except Exception as error:  # noqa: BLE001\n            raise'),
    ('push_a_failure_logs_one_line_per_host_and_never_the_capability', 'a line per failure', '                due = now - _LOGGED.get(host, -LOG_EVERY) >= LOG_EVERY\n', '                due = True\n'),
    ('push_a_failure_logs_one_line_per_host_and_never_the_capability', 'no minute between lines', 'LOG_EVERY = 60  # seconds: one log line per host per minute', 'LOG_EVERY = 0  # seconds: one log line per host per minute'),
    ('push_a_failure_logs_one_line_per_host_and_never_the_capability', 'the endpoint in the line', "'push refused by %s: status %s, reason %s', host, status, reason)", "'push refused by %s: status %s, reason %s %s', host, status, reason, target['endpoint'])"),
    ('push_a_failure_logs_one_line_per_host_and_never_the_capability', 'a success is logged too', '        if reason is not None:\n            with _LOGGED_LOCK:', '        if True:\n            with _LOGGED_LOCK:'),
    ('push_the_answer_is_classified_and_not_kept', 'the whole body is read', "text = error.read(BODY_MAX).decode('utf-8', 'replace')", "text = error.read().decode('utf-8', 'replace')"),
    ('push_the_answer_is_classified_and_not_kept', 'the body is the reason', 'return _status(error.code, reason_of(error.code, text))', 'return _status(error.code, text)'),
    ('push_the_answer_is_classified_and_not_kept', 'a 413 says nothing', "    if status == 413 or 'toolarge'", "    if 'toolarge'"),
    ('push_the_answer_is_classified_and_not_kept', 'a text says nothing about size', "    if status == 413 or 'toolarge' in text.replace(' ', ''):", '    if status == 413:'),
    ('push_the_answer_is_classified_and_not_kept', 'spaces matter', "'toolarge' in text.replace(' ', '')", "'toolarge' in text"),
    ('push_the_answer_is_classified_and_not_kept', 'a 429 is other', "    if status == 429:\n        return 'rate_limited'", "    if False:\n        return 'rate_limited'"),
    ('push_the_answer_is_classified_and_not_kept', 'a 400 jwt is other', "    if status in (400, 401, 403) and 'jwt' in text:", "    if status in (401, 403) and 'jwt' in text:"),
    ('push_the_answer_is_classified_and_not_kept', 'a jwt in a 500 is bad_jwt', "    if status in (400, 401, 403) and 'jwt' in text:", "    if 'jwt' in text:"),
    ('push_the_answer_is_classified_and_not_kept', 'a 401 is other', "    if status in (401, 403):\n        return 'key_mismatch'", "    if status in (403,):\n        return 'key_mismatch'"),
    ('push_the_answer_is_classified_and_not_kept', 'a 403 is other', "    if status in (401, 403):\n        return 'key_mismatch'", "    if status in (401,):\n        return 'key_mismatch'"),
    ('push_the_answer_is_classified_and_not_kept', 'a TimeoutError is other', 'isinstance(error, TimeoutError) or ', ''),
    ('push_the_answer_is_classified_and_not_kept', 'a timed-out text is other', "'timed out' in str(error).lower() or ", ''),
    ('push_the_answer_is_classified_and_not_kept', 'a wrapped timeout is other', " or isinstance(getattr(error, 'reason', None), TimeoutError)", ''),
    ('push_the_answer_is_classified_and_not_kept', 'every failure to answer is a timeout', "TimeoutError) else 'other'", "TimeoutError) else 'timeout'"),
    ('push_the_test_wakes_only_the_callers_devices', 'an empty test spends the window', "            if not devices:\n                conn.rollback()\n                return {'devices': []}", "            if not devices:\n                conn.execute('INSERT INTO push_tests (actor, at) VALUES (?, ?) ON CONFLICT(actor) DO UPDATE SET at=excluded.at', (actor, now))\n                conn.commit()\n                return {'devices': []}"),
    ('push_the_test_wakes_only_the_callers_devices', "it wakes everyone's devices", "'SELECT id, endpoint FROM push_subscriptions WHERE actor=? ORDER BY id', (actor,))]", "'SELECT id, endpoint FROM push_subscriptions WHERE ?=? ORDER BY id', (actor, actor))]"),
    ('push_the_test_wakes_only_the_callers_devices', 'one window for everyone', "'SELECT at FROM push_tests WHERE actor=?', (actor,)).fetchone()", "'SELECT at FROM push_tests WHERE ?=?', (actor, actor)).fetchone()"),
    ('push_the_test_wakes_only_the_callers_devices', 'the topic is an event kind', "self._post, jwt, pem, public, target, 'test')", "self._post, jwt, pem, public, target, 'approval')"),
    ('push_the_test_wakes_only_the_callers_devices', 'the test records an event', "        pem, public = self._key()\n        origin = {'kind': 'ui', 'ref': ref}\n", '        pem, public = self._key()\n        origin = {\'kind\': \'ui\', \'ref\': ref}\n        conn = self._connect()\n        conn.execute("INSERT INTO push_events (kind, bot, created_at) VALUES (\'budget\', \'\', ?)", (now,))\n        conn.commit()\n        conn.close()\n'),
    ('push_the_test_wakes_only_the_callers_devices', 'a gone device is kept by the test', "                if status in GONE:\n                    self._forget(target['id'])\n                results.append", "                if False:\n                    self._forget(target['id'])\n                results.append"),
    ('push_the_test_wakes_only_the_callers_devices', 'a refusal is ok', "'ok': kept is None,", "'ok': True,"),
    ('push_the_test_wakes_only_the_callers_devices', 'the endpoint is the host', "'host': host_of(target['endpoint']), 'ok': kept is None", "'host': target['endpoint'], 'ok': kept is None"),
    ('push_the_test_wakes_only_the_callers_devices', 'the test is not audited as a test', "audit.act(actor, 'notifications.test', f'devices:{len(devices)}'", "audit.act(actor, 'notifications.tested', f'devices:{len(devices)}'"),
    ('push_the_test_wakes_only_the_callers_devices', 'the deliveries are not linked to the call', "        origin = {'kind': 'ui', 'ref': ref}\n", "        origin = {'kind': 'ui'}\n"),
    ('push_the_test_is_bounded_and_side_by_side', 'it waits for every device', '            concurrent.futures.wait(futures, timeout=TEST_DEADLINE)', '            concurrent.futures.wait(futures)'),
    ('push_the_test_is_bounded_and_side_by_side', 'one send after the other', 'ThreadPoolExecutor(max_workers=len(devices))', 'ThreadPoolExecutor(max_workers=1)'),
    ('push_the_test_is_bounded_and_side_by_side', 'a late answer is waited for', "answers = [f.result() if f.done() and f.exception() is None else (0, 'timeout') for f in futures]", 'answers = [f.result() for f in futures]'),
    ('push_the_test_is_bounded_and_side_by_side', 'the pool is joined', 'pool.shutdown(wait=False, cancel_futures=True)', 'pool.shutdown(wait=True)'),
    ('push_the_key_a_device_used_is_compared', 'the key is not compared', '        if key_id is not None and key_id != key_id_of(self._key()[1]):', '        if False:'),
    ('push_the_key_a_device_used_is_compared', 'a mismatch is a 400', "on again on it.', 409)", "on again on it.', 400)"),
    ('push_the_key_a_device_used_is_compared', 'the key is not stored', '(actor, endpoint, json.dumps(kinds), self.clock(), key_id))', '(actor, endpoint, json.dumps(kinds), self.clock(), None))'),
    ('push_the_key_a_device_used_is_compared', 'a change of kinds forgets the key', 'key_id=COALESCE(excluded.key_id, push_subscriptions.key_id)', 'key_id=excluded.key_id'),
    ('push_the_key_a_device_used_is_compared', 'no device is stale', "'stale': r['key_id'] != current,", "'stale': False,"),
    ('push_the_key_a_device_used_is_compared', 'a device with no key is fine', "'stale': r['key_id'] != current,", "'stale': r['key_id'] is not None and r['key_id'] != current,"),
    ('push_the_key_a_device_used_is_compared', 'the stale count counts nobody', 'WHERE key_id IS NOT ?', 'WHERE key_id IS ?'),
    ('push_the_key_a_device_used_is_compared', 'the key id is short', 'hexdigest()[:16]', 'hexdigest()[:8]'),
    ('push_the_key_a_device_used_is_compared', 'any alphabet is a key', "re.fullmatch(r'[A-Za-z0-9_-]{16,140}={0,2}', public_key)", "re.fullmatch(r'[A-Za-z0-9_+/-]{16,140}={0,2}', public_key)"),
    ('push_the_key_a_device_used_is_compared', 'every key is refused', "        key_id = key_id_of(body['application_server_key'])", '        key_id = None'),
    ('push_the_key_a_device_used_is_compared', 'a bad key is accepted', "        if key_id is None:\n            raise PluginError('invalid_field', 'Invalid value for application_server_key.', 422)", "        if False:\n            raise PluginError('invalid_field', 'Invalid value for application_server_key.', 422)"),
    ('push_the_question_kind', 'the kind does not exist', "KINDS = ('approval', 'budget', 'question')", "KINDS = ('approval', 'budget')"),
    ('push_the_question_kind', 'the kind has no link', "'budget': '/costs', 'question': '/activity'}", "'budget': '/costs'}"),
    ('push_the_question_kind', 'the kind goes to the wrong screen', "'question': '/activity'}", "'question': '/approvals'}"),
    ('push_the_question_kind', 'an existing device is given the kind', '    return tuple(k for k in value if k in KINDS) if isinstance(value, list) else ()', "    return (tuple(k for k in value if k in KINDS) + ('question',)) if isinstance(value, list) else ()"),
    ('push_the_question_kind', 'a new subscription gets two kinds', '    if value is None:\n        return list(KINDS)', "    if value is None:\n        return ['approval', 'budget']"),
    ('push_the_contact_is_one_a_service_takes', 'an IP literal is a host', ' and labels[-1][0].isalpha()', ''),
    ('push_the_contact_is_one_a_service_takes', 'a digit may start the last label', 'labels[-1][0].isalpha()', 'labels[-1][0].isalnum()'),
    ('push_the_contact_is_one_a_service_takes', 'the reserved endings are not looked at', " and not ('.' + host).endswith(RESERVED_ENDINGS)", ''),
    ('push_the_contact_is_one_a_service_takes', 'the apex of a reserved name passes', "not ('.' + host).endswith(RESERVED_ENDINGS)", 'not host.endswith(RESERVED_ENDINGS)'),
    ('push_the_contact_is_one_a_service_takes', 'a port of 0 is a port', '(port is None or 1 <= port <= 65535)', '(port is None or port <= 65535)'),
    ('push_the_contact_is_one_a_service_takes', 'any port is a port', '(port is None or 1 <= port <= 65535)', 'True'),
    ('push_the_contact_is_one_a_service_takes', 'a malformed URL raises', '    except ValueError:   # `https://[::1`, `https://luve.app:abc` and the like\n        return False', '    except ValueError:   # `https://[::1`, `https://luve.app:abc` and the like\n        raise'),
    ('push_the_contact_is_one_a_service_takes', 'the port is never read', '        port = url.port                                  # a ValueError for a port that is not one\n', '        port = None\n'),
    ('push_the_contact_is_one_a_service_takes', '.local is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.localhost is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.test is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.invalid is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.example is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.internal', '.lan', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.internal is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.lan', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.lan is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.localdomain', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.localdomain is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.home.arpa')"),
    ('push_the_contact_is_one_a_service_takes', '.home.arpa is a real name', "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain')"),
    ('push_without_a_contact_nothing_is_sent', 'the made-up contact is back', '        self.subject = subject_claim(subject)\n', "        self.subject = subject_claim(subject) or 'mailto:luvebot@localhost'\n"),
    ('push_without_a_contact_nothing_is_sent', 'a bad contact is used', '        self.subject = subject_claim(subject)\n', '        self.subject = subject\n'),
    ('push_without_a_contact_nothing_is_sent', 'the source outlives the contact', "source if self.subject is not None or source == 'setting' else None", 'source'),
    ('push_without_a_contact_nothing_is_sent', 'a malformed setting loses its source', "self.subject is not None or source == 'setting'", 'self.subject is not None'),
    ('push_a_refusal_is_seen_not_dropped', 'the audit says ok to a refusal', '        def effect():\n            raise _Refused()\n', '        def effect():\n            return None\n'),
    ('push_a_refusal_is_seen_not_dropped', 'a success is audited', "        if reason is not None and kind != 'test':", "        if kind != 'test':"),
    ('push_the_test_wakes_only_the_callers_devices', 'a test audits every device', "        if reason is not None and kind != 'test':", '        if reason is not None:'),
    ('push_a_failure_logs_one_line_per_host_and_never_the_capability', 'the host is never remembered', '                if due:\n                    _put(_LOGGED, host, now)', '                if False:\n                    _put(_LOGGED, host, now)'),
    ('push_the_answer_is_classified_and_not_kept', 'expired is not read', "    if status == 410 or 'expired' in text:", '    if False:'),
    ('push_the_answer_is_classified_and_not_kept', 'a 410 is other', "    if status == 410 or 'expired' in text:", "    if 'expired' in text:"),
    ('push_the_answer_is_classified_and_not_kept', 'only the status says expired', "    if status == 410 or 'expired' in text:", '    if status == 410:'),
    ('push_the_answer_is_classified_and_not_kept', 'jwt wins over expired', "    if status == 410 or 'expired' in text:", "    if status == 410 or ('expired' in text and 'jwt' not in text):"),
    ('push_the_test_wakes_only_the_callers_devices', 'no limit', "            if last is not None and 0 <= now - last['at'] < TEST_EVERY:", '            if False:'),
    ('push_the_test_wakes_only_the_callers_devices', 'the window never ends', "            if last is not None and 0 <= now - last['at'] < TEST_EVERY:", '            if last is not None:'),
    ('push_the_test_window_holds_under_concurrency', 'a negative difference counts as inside the window', "            if last is not None and 0 <= now - last['at'] < TEST_EVERY:", "            if last is not None and now - last['at'] < TEST_EVERY:"),
    ('push_only_the_origin_is_sent', 'the whole URL is the contact', "    return f'https://{url.hostname}' + (f':{url.port}' if url.port not in (None, 443) else '')", '    return value'),
    ('push_only_the_origin_is_sent', 'the port is dropped from the origin', "    return f'https://{url.hostname}' + (f':{url.port}' if url.port not in (None, 443) else '')", "    return f'https://{url.hostname}'"),
    ('push_only_the_origin_is_sent', 'the origin is copied from the netloc', "    return f'https://{url.hostname}' + (f':{url.port}' if url.port not in (None, 443) else '')", "    return f'https://{url.netloc}'"),
    ('push_only_the_origin_is_sent', 'the default port is kept', "(f':{url.port}' if url.port not in (None, 443) else '')", "(f':{url.port}' if url.port is not None else '')"),
    ('push_the_tables_are_bounded', 'no cap', '    while len(table) > TABLE_MAX:', '    while False:'),
    ('push_the_tables_are_bounded', 'the newest is dropped', '        del table[victim if victim is not None else next(iter(table))]', '        del table[key]'),
    ('push_the_tables_are_bounded', 'the oldest goes whatever it is', '        victim = next((k for k in table if _chosen(k)), None)', '        victim = None'),
    ('push_the_tables_are_bounded', 'a real service goes first', 'next((k for k in table if _chosen(k)), None)', 'next((k for k in table if not _chosen(k)), None)'),
    ('push_the_tables_are_bounded', 'no host is a chosen one', "host.lower().removeprefix('https://').endswith(WINDOWS)", "host.lower().removeprefix('https://').endswith('.nope')"),
    ('push_the_host_of_an_endpoint_is_read_in_lowercase', 'the raw netloc is back', "f'{url.scheme}://{url.netloc.lower()}')", "f'{url.scheme}://{url.netloc}')"),
    ('push_the_host_of_an_endpoint_is_read_in_lowercase', 'the class is decided on the raw host', "host.lower().removeprefix('https://').endswith(WINDOWS)", "host.removeprefix('https://').endswith(WINDOWS)"),
    ('push_the_host_of_an_endpoint_is_read_in_lowercase', 'the path of the endpoint is lowercased too', "raw = self.sender(target['endpoint'], {", "raw = self.sender(target['endpoint'].lower(), {"),
    ('push_the_host_of_an_endpoint_is_read_in_lowercase', 'no host is a chosen one', "host.lower().removeprefix('https://').endswith(WINDOWS)", "host.lower().removeprefix('https://').endswith('.nope')"),
    ('push_the_tables_are_bounded', 'the host of a token is not read', '    host = key[0] if isinstance(key, tuple) else key\n', "    host = key if isinstance(key, str) else ''\n"),
    ('push_the_tables_are_bounded', 'the cap is a thousand', 'TABLE_MAX = 64 ', 'TABLE_MAX = 1000 '),
    ('push_a_hostile_endpoint_is_a_422_and_what_is_stored_is_what_was_validated', 'a control character is stored', 'len(value) > 2048 or any(ord(c) <= 32 or ord(c) >= 127 for c in value)', 'len(value) > 2048'),
    ('push_a_hostile_endpoint_is_a_422_and_what_is_stored_is_what_was_validated', 'a bad port is an exception', "# an unclosed IPv6, a port that is not one: a refusal, never an exception\n        raise PluginError('invalid_field', 'Invalid value for endpoint.', 422) from None", '# an unclosed IPv6, a port that is not one: a refusal, never an exception\n        raise'),
    ('push_the_key_a_device_used_is_compared', 'a length that cannot be base64 raises', '# binascii.Error: a length that is 1 more than a multiple of 4 cannot be base64\n        return None', '# binascii.Error: a length that is 1 more than a multiple of 4 cannot be base64\n        raise'),
    ('push_the_wake_goes_out_whatever_the_audit_result_does', 'the audit exception loses the wake', "                targets = committed['targets']                     # the event row IS there", '                return None                                        # the event row IS there'),
    ('push_the_wake_goes_out_whatever_the_audit_result_does', 'the audit exception stops the wake with a log', "                targets = committed['targets']                     # the event row IS there", '                targets = []                                       # the event row IS there'),
    ('push_the_wake_goes_out_whatever_the_audit_result_does', 'a failed effect is carried on as sent', "                if 'targets' not in committed:\n                    raise", '                if False:\n                    raise'),
    ('push_the_wake_goes_out_whatever_the_audit_result_does', 'the targets are never captured', "                    committed['targets'] = found\n", ''),
    ('push_a_commit_that_fails_sends_nothing_and_leaves_the_key_free', 'the targets are taken before the commit succeeds', "                    conn.commit()\n                    committed['targets'] = found\n", "                    committed['targets'] = found\n                    conn.commit()\n"),
    ('push_a_commit_that_fails_sends_nothing_and_leaves_the_key_free', 'a commit that fails is carried on', "                    conn.commit()\n                    committed['targets'] = found\n", "                    try:\n                        conn.commit()\n                    except sqlite3.Error:\n                        pass\n                    committed['targets'] = found\n"),
    ('push_the_wake_goes_out_whatever_the_audit_result_does', 'the audit failure is silent', "                logging.getLogger('luvebot.push').warning('notify: the audit result was not written: %s', type(error).__name__)", '                pass'),
    ('push_the_wake_goes_out_whatever_the_audit_result_does', 'the audit failure log carries the error text', "('notify: the audit result was not written: %s', type(error).__name__)", "('notify: the audit result was not written: %s', error)"),
]


def load_variant(tmp_path_factory, old, new):
    pkg = tmp_path_factory.mktemp('pushvariant') / f'psv{next(_n)}'
    pkg.mkdir()
    for name in ('__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'hermes_boundary.py', 'push.py'):
        shutil.copy(SRC / name, pkg / name)
    text = (pkg / 'push.py').read_text()
    assert text.count(old) == 1, old
    (pkg / 'push.py').write_text(text.replace(old, new))
    sys.path.insert(0, str(pkg.parent))
    try:
        return importlib.import_module(f'{pkg.name}.push')
    finally:
        sys.path.remove(str(pkg.parent))


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(tmp_path, name):
    INVARIANTS[name](real, tmp_path)


def test_every_invariant_has_a_mutation():
    assert set(INVARIANTS) == {inv for inv, *_ in MUTATIONS}


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(tmp_path_factory, tmp_path, invariant, label, old, new):
    variant = load_variant(tmp_path_factory, old, new)
    with pytest.raises(AssertionError):
        INVARIANTS[invariant](variant, tmp_path)


# ---- what the rebase added: the capability and one wake per request --------------------------------------------------------------------
def inv_capable_says_whether_this_hermes_can_push(m, tmp):
    import builtins
    real_import = builtins.__import__

    def without(top, wanted=None):
        def fake(name, globals=None, locals=None, fromlist=(), level=0):
            if name == top and (wanted is None or wanted in (fromlist or ())):  # `from pkg import x` names the package and lists x
                raise ImportError(f'{top} {wanted or ""} is not installed')
            return real_import(name, globals, locals, fromlist, level)
        return fake
    assert m.capable() is True                                           # PyJWT and cryptography: Hermes's own
    try:
        for top, wanted in (('jwt', None), ('cryptography.hazmat.primitives', 'serialization'), ('cryptography.hazmat.primitives.asymmetric', 'ec')):
            builtins.__import__ = without(top, wanted)                    # an older Hermes without one of them
            assert m.capable() is False, (top, wanted)
    finally:
        builtins.__import__ = real_import
    assert m.capable() is True


CAPABLE_MUTATIONS = [
    ('always capable', "    try:\n        import jwt  # noqa: F401", "    return True\n    try:\n        import jwt  # noqa: F401"),
    ('jwt not checked', "        import jwt  # noqa: F401\n", "        pass\n"),
    ('ec not checked', "        from cryptography.hazmat.primitives.asymmetric import ec  # noqa: F401\n", "        pass\n"),
    ('serialization not checked', "        from cryptography.hazmat.primitives import serialization  # noqa: F401\n", "        pass\n"),
]


def test_capable_on_the_real_module(tmp_path):
    inv_capable_says_whether_this_hermes_can_push(real, tmp_path)


@pytest.mark.parametrize('label,old,new', CAPABLE_MUTATIONS, ids=[m[0] for m in CAPABLE_MUTATIONS])
def test_each_capable_mutation_turns_it_red(tmp_path_factory, tmp_path, label, old, new):
    with pytest.raises(AssertionError):
        inv_capable_says_whether_this_hermes_can_push(load_variant(tmp_path_factory, old, new), tmp_path)


def test_the_routes_and_the_approval_hook_are_wired_as_the_contract_says():
    api = (SRC.parent / 'dashboard' / 'plugin_api.py').read_text()
    approvals = (SRC / 'approvals.py').read_text()
    assert "features['notifications'], push_status = await run_in_threadpool(_push_health, db_path)" in api
    config = api.split('async def notifications_config(', 1)[1].split('\n@router', 1)[0]
    assert 'push.capable' in config and "'capability_missing'" in config and config.index('push.capable') < config.index('_stores')   # a 409 before anything is made

    def latest_route_ok(text):
        route = text.split('async def notifications_latest(', 1)[1].split('\n@router', 1)[0]
        return ('actor, _credential, _mode = _identity(request)' in route and '.latest(actor, device)' in route      # the person's kinds, never the team's
                and 'sub.isascii() and sub.isdigit()' in route and 'else None' in route)                            # a bad ?sub is ignored, never an error
    assert latest_route_ok(api) and 'json.loads(r[\'kinds\'])' not in (SRC / 'push.py').read_text()                   # one reader of the stored kinds
    assert not latest_route_ok(api.replace('.latest(actor, device)', ".latest('', None)"))
    assert not latest_route_ok(api.replace('sub.isascii() and sub.isdigit()', 'True'))
    assert 'if on_request is not None and inserted == [1]:' in approvals                  # ONE wake per request: a lost INSERT OR IGNORE adds nothing
    assert '.rowcount)' in approvals and 'inserted = []' in approvals
    notify = approvals.split('inserted == [1]', 1)[1].split('return dict', 1)[0]
    assert 'except Exception:' in notify                                                   # the wake can never break the capture of the request
    for broken in (approvals.replace('if on_request is not None and inserted == [1]:', 'if on_request is not None:'),
                   api.replace("features['notifications'], push_status = await run_in_threadpool(_push_health, db_path)", "features['notifications'] = 'ok'")):
        assert broken != approvals and broken != api


# ---- the key of a pause: the same for every process that shares luvebot.db, new for the next pause of the same Bot ---------------------------------------
API_SOURCE = (SRC.parent / 'dashboard' / 'plugin_api.py').read_text()


def pause_key_checks(source, tmp_path):
    text = re.search(r"def _pause_key\(.*?(?=\n\n\n)", source, re.S).group(0)
    ns = {'sqlite3': sqlite3}
    exec(text, ns)
    key_of, path = ns['_pause_key'], tmp_path / 'luvebot.db'
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE budget_exec_state (bot TEXT PRIMARY KEY, since REAL NOT NULL, estop_noted INTEGER NOT NULL DEFAULT 0)')
    conn.commit()
    assert key_of(path, 'vendas') is None                                                    # the executor has not noted the pause yet: nothing to deduplicate by
    conn.execute("INSERT INTO budget_exec_state (bot, since) VALUES ('vendas', 1800000000.25)")
    conn.commit()
    first = key_of(path, 'vendas')
    assert first == 'pause:vendas:1800000000.25' and key_of(path, 'vendas') == first         # the same text for every process that reads it
    conn.execute("DELETE FROM budget_exec_state WHERE bot='vendas'")                         # the resume removes the row...
    conn.execute("INSERT INTO budget_exec_state (bot, since) VALUES ('vendas', 1800000500.5)")   # ...the next pause of the same Bot has its own
    conn.commit()
    conn.close()
    assert key_of(path, 'vendas') != first and key_of(path, 'suporte') is None
    assert key_of(tmp_path / 'no' / 'such.db', 'vendas') is None                              # unreadable: not deduplicated, never an exception
    wired = "_push(path).notify(audit, 'budget', bot, key)" in source and "key = _pause_key(path, bot)" in source
    assert wired


def test_the_pause_key_follows_the_executors_pause(tmp_path):
    pause_key_checks(API_SOURCE, tmp_path)


@pytest.mark.parametrize('old,new', [
    ("return f'pause:{bot}:{row[0]}' if row else None", "return f'pause:{bot}' if row else None"),
    ("return f'pause:{bot}:{row[0]}' if row else None", "return f'pause:{bot}:{row[0]}'"),
    ("_push(path).notify(audit, 'budget', bot, key)", "_push(path).notify(audit, 'budget', bot)"),
    ("    except sqlite3.Error:\n        return None\n    return f'pause", "    except sqlite3.Error:\n        raise\n    return f'pause"),
], ids=['the_key_has_no_since', 'no_row_no_key', 'the_key_is_not_passed', 'an_unreadable_database_raises'])
def test_each_pause_key_mutation_is_caught(tmp_path, old, new):
    assert API_SOURCE.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        pause_key_checks(API_SOURCE.replace(old, new), tmp_path)


# ---- contract v0.11 section 7 in plugin_api.py: the subject read once, the routes, /health ---------------------------------------------------------------
def source_of(name, source=API_SOURCE):
    return re.search(rf"^(?:async )?def {name}\(.*?(?=\n\n\n)", source, re.S | re.M).group(0)


def in_order(text, *parts):
    where = [text.find(p) for p in parts]
    return -1 not in where and where == sorted(where)


def wiring_ok(api):
    subject = source_of('_push_subject', api)
    test = source_of('notifications_test', api)
    subscribe = source_of('notifications_subscribe', api)
    health = source_of('_push_health', api)
    return all([
        api.count("_PUSH_SUBJECT_SETTING = os.environ.get('LUVEBOT_PUSH_SUBJECT', '').strip()") == 1 and 'os.environ' not in subject,          # read once, from the environment only
        "(_PUSH_SUBJECT_SETTING, 'setting') if push.valid_subject(_PUSH_SUBJECT_SETTING) else (None, 'setting')" in subject and "return url, 'public_url'" in subject and subject.rstrip().endswith('return None, None'),
        'luvebot@localhost' not in api and 'luvebot@localhost' not in (SRC / 'push.py').read_text(),                                         # no placeholder survives anywhere
        'push.Push(path, subject=subject, source=source)' in api,
        in_order(test, 'actor, credential, _mode = _identity(request)', '_require_csrf(request, credential)', '_json_body(request)'),
        '_human' not in test and "!= {}" in test and '.test(audit, actor,' in test and 'push.capable' in test,
        'endpoint, kinds, key_id = push.subscribe_body(' in subscribe and "'req_' + uuid4().hex, key_id))" in subscribe and "headers.get('origin')" not in subscribe,
        "if not push.capable():\n        return 'unavailable', None" in health and "return ('ok' if subject else 'needs_subject'), status" in health,
        'push.problem_of(push_status)' in api and "'push': push_status, 'features': features" in api,
    ])


def test_the_notification_wiring_follows_contract_v011_section_7():
    assert wiring_ok(API_SOURCE)


@pytest.mark.parametrize('old,new', [
    ("_PUSH_SUBJECT_SETTING = os.environ.get('LUVEBOT_PUSH_SUBJECT', '').strip()", "_PUSH_SUBJECT_SETTING = ''"),
    ("    if _PUSH_SUBJECT_SETTING:\n        return (_PUSH_SUBJECT_SETTING, 'setting') if", "    if os.environ.get('LUVEBOT_PUSH_SUBJECT'):\n        return (_PUSH_SUBJECT_SETTING, 'setting') if"),
    ("    if _PUSH_SUBJECT_SETTING:\n        return (_PUSH_SUBJECT_SETTING, 'setting') if push.valid_subject(_PUSH_SUBJECT_SETTING) else (None, 'setting')", "    if push.valid_subject(_PUSH_SUBJECT_SETTING):\n        return _PUSH_SUBJECT_SETTING, 'setting'"),
    ("return url, 'public_url'", "return url, 'dashboard'"),
    ("    return None, None\n\n\ndef _push(path):", "    return 'mailto:luvebot@localhost', 'default'\n\n\ndef _push(path):"),
    ("    return push.Push(path, subject=subject, source=source)", "    return push.Push(path, subject=subject)"),
    ("    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n    if await _json_body(request) != {}:\n        raise PluginError('bad_request', 'Send an empty body {}.', 400)",
     "    actor, credential, _mode = _identity(request)\n    if await _json_body(request) != {}:\n        raise PluginError('bad_request', 'Send an empty body {}.', 400)"),
    ("    if await _json_body(request) != {}:\n        raise PluginError('bad_request', 'Send an empty body {}.', 400)\n    if not await run_in_threadpool(push.capable)", "    if not await run_in_threadpool(push.capable)"),
    ("_push(meta.path).test(audit, actor, 'req_' + uuid4().hex)", "_push(meta.path).test(audit, 'basic:anyone', 'req_' + uuid4().hex)"),
    ("'req_' + uuid4().hex, key_id))", "'req_' + uuid4().hex, request.headers.get('origin')))"),
    ("    endpoint, kinds, key_id = push.subscribe_body(await _json_body(request))", "    endpoint, kinds = push.subscribe_body(await _json_body(request))[:2]\n    key_id = None"),
    ("    if not push.capable():\n        return 'unavailable', None", "    if False:\n        return 'unavailable', None"),
    ("return ('ok' if subject else 'needs_subject'), status", "return 'ok', status"),
    ("    if push_status is not None and (push_problem := push.problem_of(push_status)) is not None:\n        problems.append(push_problem)\n", ""),
    ("'push': push_status, 'features': features", "'features': features"),
], ids=['setting_not_read_once', 'setting_read_again', 'a_malformed_setting_falls_to_the_public_url', 'public_url_source_renamed', 'a_placeholder_survives', 'the_source_is_not_passed', 'test_without_csrf', 'test_ignores_the_body',
        'test_wakes_somebody_else', 'subscribe_passes_the_origin', 'subscribe_drops_the_key', 'health_ignores_capability', 'health_says_ok_without_a_contact', 'health_has_no_problem', 'health_has_no_push'])
def test_each_notification_wiring_mutation_is_caught(old, new):
    assert API_SOURCE.count(old) == 1, old
    assert not wiring_ok(API_SOURCE.replace(old, new))


def push_subject(monkeypatch, config, setting=''):
    import types
    monkeypatch.setitem(sys.modules, 'hermes_cli', types.ModuleType('hermes_cli'))
    module = types.ModuleType('hermes_cli.config')
    module.load_config = config
    monkeypatch.setitem(sys.modules, 'hermes_cli.config', module)
    ns = {'push': real, 'hermes_boundary': sibling(real, 'hermes_boundary'), '_PUSH_SUBJECT_SETTING': setting}
    exec(source_of('_push_subject'), ns)
    return ns['_push_subject']()


def test_the_subject_is_the_setting_then_the_public_https_url_and_otherwise_none(monkeypatch):
    public = lambda url: (lambda: {'dashboard': {'public_url': url}})  # noqa: E731
    assert push_subject(monkeypatch, public('https://luve.app/'), 'mailto:ops@luve.app') == ('mailto:ops@luve.app', 'setting')       # the operator's word wins
    assert push_subject(monkeypatch, public('https://luve.app/')) == ('https://luve.app/', 'public_url')
    assert push_subject(monkeypatch, public('https://luve.app/'), 'mailto:luvebot@localhost') == (None, 'setting')                   # a malformed EXPLICIT setting is not replaced by the public URL (A-189)
    for bad in ('http://luve.app', 'https://localhost', 'https://0x7f.0x1', 'mailto:ops@luve.local', 'luve.app'):
        assert push_subject(monkeypatch, public('https://luve.app/'), bad) == (None, 'setting'), bad
    for url in ('http://luve.app', 'https://localhost:9119', 'https://127.0.0.1', 'https://luve', '', None, 5):
        assert push_subject(monkeypatch, public(url)) == (None, None), url
    assert push_subject(monkeypatch, lambda: {}) == (None, None) and push_subject(monkeypatch, lambda: {'dashboard': None}) == (None, None)

    def broken():
        raise RuntimeError('config unreadable')
    assert push_subject(monkeypatch, broken) == (None, None)                                                       # an ordinary failure: no contact, not an error


def push_health(monkeypatch, tmp_path, *, subject, capable=True, path='db'):
    import types
    box = types.SimpleNamespace(capable=lambda: capable, Push=real.Push)
    ns = {'push': box, '_push_subject': lambda: subject}
    exec(source_of('_push_health'), ns)
    return ns['_push_health'](tmp_path / 'luvebot.db' if path == 'db' else tmp_path)


def health_checks(source, monkeypatch, tmp_path):
    import types
    box = types.SimpleNamespace(capable=lambda: True, Push=real.Push)

    def run(subject, capable=True, db=None):
        box.capable = lambda: capable
        ns = {'push': box, '_push_subject': lambda: subject}
        exec(source_of('_push_health', source), ns)
        return ns['_push_health'](db or tmp_path / 'luvebot.db')
    word, status = run(('https://luve.app', 'public_url'))
    assert word == 'ok' and status['subject'] == {'ok': True, 'source': 'public_url'} and status['devices'] == 0
    word, status = run((None, None))
    assert word == 'needs_subject' and status['subject'] == {'ok': False, 'source': None}                         # on, but it cannot send: said
    assert run(('https://luve.app', 'public_url'), capable=False) == ('unavailable', None)
    assert run(('https://luve.app', 'public_url'), db=tmp_path) == ('ok', None)                                    # an unreadable store: no push section, /health still answers


def test_health_says_ok_needs_subject_or_unavailable(monkeypatch, tmp_path):
    health_checks(API_SOURCE, monkeypatch, tmp_path)


@pytest.mark.parametrize('old,new', [
    ("        return 'unavailable', None\n", "        pass\n"),
    ("return ('ok' if subject else 'needs_subject'), status", "return 'ok', status"),
    ("    except Exception:  # noqa: BLE001\n        status = None", "    except Exception:  # noqa: BLE001\n        raise"),
], ids=['unavailable_not_said', 'no_needs_subject', 'a_broken_store_breaks_health'])
def test_each_health_mutation_is_caught(monkeypatch, tmp_path, old, new):
    assert API_SOURCE.count(old) == 1, old
    with pytest.raises(Exception):  # noqa: B017
        health_checks(API_SOURCE.replace(old, new), monkeypatch, tmp_path)


# ---- contract v0.11 7.6: the watcher announces the waits `waiting.read` derives ---------------------------------------------------------------------------
WAIT_SOURCE_RE = re.compile(r"_WAIT_WINDOW_S = .*?(?=\n\n\ndef _pause_key)", re.S)


class FakeWaiting:
    def __init__(self):
        self.markers, self.items, self.reads, self.marker_calls = {}, {}, [], []

    def marker(self, path, bot):
        self.marker_calls.append(bot)
        return self.markers.get(bot)

    def read(self, path, bot, redact):
        self.reads.append(bot)
        return self.items.get(bot)


PROMPT = 'Qual senha uso? hunter2-do-cliente'


def wait_item(request_id, ago=0, kind='clarify', now=1_000_000.0):
    return {'request_id': request_id, 'kind': kind, 'since': now - ago, 'session_id': None, 'platform': None, 'prompt': PROMPT if kind == 'clarify' else None}


def wait_checks(source, tmp_path):
    ns_text = WAIT_SOURCE_RE.search(source).group(0)
    now = [1_000_000.0]
    path = tmp_path / 'luvebot.db'
    sender = Sender()
    audit = sibling(real, 'audit').AuditLog(path)
    box = real.Push(path, subject='https://luve.app', source='public_url', sender=sender, clock=lambda: now[0])
    sub(real, audit, box, FCM, kinds=['question'])
    fake, joined = FakeWaiting(), []

    class Pusher:
        def __getattr__(self, name):                                      # whatever the tick asks of the box (a look at what was said): the real one answers
            return getattr(box, name)

        def notify(self, audit, kind, bot, key=None):
            thread = box.notify(audit, kind, bot, key)
            joined.append(thread)
            return thread
    import logging as logging_module
    import types
    time_box = types.SimpleNamespace(time=lambda: now[0])
    ns = {'waiting': fake, '_REDACT': lambda text: text, '_push': lambda p: Pusher(), 'time': time_box, 'logging': logging_module}
    exec(ns_text, ns)
    tick = ns['_notify_new_waits']

    def run(*names):
        tick(audit, path, list(names))
        for thread in [t for t in joined if t]:
            thread.join(5)
        joined.clear()
    # first sight: a young wait is announced, one older than 10 minutes is not (an update must not announce old waits)
    fake.markers['vendas'], fake.items['vendas'] = 'm1', [wait_item('req_a', 30), wait_item('req_old', 601), wait_item('req_b', 599, kind='sudo'), wait_item('req_c', 5, kind='approval'), wait_item('req_d', 5, kind='other')]
    run('vendas')
    assert fake.reads == ['vendas'] and len(sender.sent) == 4 and {h['Topic'] for _u, h in sender.sent} == {'question'}      # one wake per wait announced (the push service coalesces them by Topic); the old one is not among them
    keys = sorted(r[0] for r in rows_of(path, "SELECT dedupe FROM push_events"))
    assert keys == ['wait:vendas:req_a', 'wait:vendas:req_b', 'wait:vendas:req_c', 'wait:vendas:req_d'], keys                  # every kind of wait is `question`; the old one is not there
    assert [(e['kind'], e['bot'], e['link']) for e in box.latest('basic:ana')] == [('question', 'vendas', '/activity')] * 4
    # the same marker: nothing is read at all
    run('vendas')
    assert fake.reads == ['vendas'] and fake.marker_calls == ['vendas', 'vendas']
    # the marker moved (another wait): the list is read again, the ones already said are not said again, the new one is
    fake.markers['vendas'], fake.items['vendas'] = 'm2', fake.items['vendas'] + [wait_item('req_e', 2)]
    sent_before = len(sender.sent)
    run('vendas')
    assert fake.reads == ['vendas', 'vendas'] and len(rows_of(path, "SELECT dedupe FROM push_events")) == 5 and len(sender.sent) == sent_before + 1
    # another process (another lease owner) that never saw the first tick says nothing about waits already said
    ns['_WAIT_MARKERS'].clear()
    run('vendas')
    assert len(rows_of(path, "SELECT dedupe FROM push_events")) == 5 and len(sender.sent) == sent_before + 1
    fake.markers['vendas'] = None                                                                                       # the hook can no longer be read: no marker, nothing is read
    reads_before = len(fake.reads)
    run('vendas')
    assert len(fake.reads) == reads_before
    fake.markers['vendas'] = 'm2'
    # nothing of the clarify's text anywhere: not in the events, the audit, the log of deliveries, the headers or what the lock screen reads
    everything = json.dumps([rows_of(path, 'SELECT * FROM push_events'), rows_of(path, 'SELECT * FROM audit_log'), rows_of(path, 'SELECT * FROM push_log'), box.latest('basic:ana'), sender.sent], default=str)
    assert 'hunter2' not in everything and 'senha' not in everything
    assert rows_of(path, "SELECT COUNT(*) FROM audit_log WHERE action='notifications.push' AND detail='intent'")[0][0] == 5
    # a marker that cannot be told reads nothing; an unreadable list is not remembered, so the next tick tries again; one Bot's failure stops no other
    fake.markers['suporte'], fake.items['suporte'] = None, [wait_item('req_s', 1)]
    run('suporte')
    assert 'suporte' not in fake.reads
    fake.markers['suporte'], fake.items['suporte'] = 'm1', None
    run('suporte')
    run('suporte')
    assert fake.reads.count('suporte') == 2 and len(rows_of(path, "SELECT dedupe FROM push_events")) == 5                  # read twice (never remembered), nothing said
    fake.items['suporte'] = [wait_item('req_s', 1)]
    run('suporte')
    assert fake.reads.count('suporte') == 3 and len(rows_of(path, "SELECT dedupe FROM push_events WHERE dedupe LIKE 'wait:suporte:%'")) == 1
    fake.read = lambda path, bot, redact: (_ for _ in ()).throw(RuntimeError('hook gone'))
    fake.markers['caixa'], fake.markers['loja'] = 'x', 'y'
    fake.items['loja'] = [wait_item('req_l', 1)]
    ok = fake.read
    fake.read = lambda path, bot, redact: ok(path, bot, redact) if bot == 'caixa' else FakeWaiting.read(fake, path, bot, redact)
    run('caixa', 'loja')
    assert len(rows_of(path, "SELECT dedupe FROM push_events WHERE dedupe='wait:loja:req_l'")) == 1                           # `caixa` blew up, `loja` was still told
    # wired in the tick that already announces the pauses
    assert re.search(r"_notify_new_pauses\(audit, meta.path, budget\).*\n    _notify_new_waits\(audit, meta.path, names\)", source)


def test_a_wait_wakes_the_devices_that_asked_for_question_once_and_without_its_text(tmp_path):
    wait_checks(API_SOURCE, tmp_path)


@pytest.mark.parametrize('old,new', [
    ("            if marker is None or _WAIT_MARKERS.get((str(path), bot)) == marker:\n                continue", "            if False:\n                continue"),
    ("            if marker is None or _WAIT_MARKERS.get((str(path), bot)) == marker:", "            if _WAIT_MARKERS.get((str(path), bot)) == marker:"),
    ("                _WAIT_MARKERS[(str(path), bot)] = marker", "                pass"),
    ("            items = waiting.read(path, bot, _REDACT)\n            if items is None:\n                continue", "            items = waiting.read(path, bot, _REDACT) or []\n            if items is None:\n                continue"),
    ("                if time.time() - item['since'] > _WAIT_WINDOW_S:\n                    continue\n", ""),
    ("_WAIT_WINDOW_S = 600.0", "_WAIT_WINDOW_S = 6000.0"),
    ("key = f\"wait:{bot}:{item['request_id']}\"\n", "key = f\"wait:{bot}\"\n"),
    ("key = f\"wait:{bot}:{item['request_id']}\"\n", "key = f\"wait:{item['request_id']}\"\n"),
    ("key = f\"wait:{bot}:{item['request_id']}\"\n", "key = None\n"),
    ("box.notify(audit, 'question', bot, key)", "box.notify(audit, 'approval', bot, key)"),
    ("box.notify(audit, 'question', bot, key)", "box.notify(audit, 'question', item['prompt'] or bot, key)"),
    ("        except Exception as error:\n            logging.getLogger('luvebot.push').warning('wait notification failed: %s', type(error).__name__)", "        except KeyError as error:\n            logging.getLogger('luvebot.push').warning('wait notification failed: %s', type(error).__name__)"),
    ("    _notify_new_waits(audit, meta.path, names)  # v0.11 7.6", "    pass  # v0.11 7.6"),
], ids=['reads_every_tick', 'a_marker_that_cannot_be_told_is_read', 'the_marker_is_never_remembered', 'an_unreadable_list_is_remembered', 'no_window', 'the_window_is_100_minutes', 'the_key_has_no_request',
        'the_key_has_no_bot', 'no_key', 'the_kind_is_approval', 'the_text_is_the_bot', 'one_bot_stops_the_others', 'the_tick_does_not_call_it'])
def test_each_wait_mutation_is_caught(tmp_path, old, new):
    assert API_SOURCE.count(old) == 1, old
    with pytest.raises(BaseException):  # noqa: B017
        wait_checks(API_SOURCE.replace(old, new), tmp_path)


# ---- A-189: a malformed explicit setting says so ONCE, without its value --------------------------------------------------------------------------------------
LOG_BLOCK_RE = re.compile(r"_PUSH_SUBJECT_SETTING = os\.environ.*?(?=\n\n\ndef _push_subject)", re.S)


def setting_log_checks(source, monkeypatch):
    import os as os_module
    text = LOG_BLOCK_RE.search(source).group(0)
    for value, expected in (('', 0), ('mailto:ops@luve.app', 0), ('https://luve.app', 0), ('mailto:luvebot@localhost', 1), ('http://luve.app', 1), ('https://localhost', 1), ('https://0x7f.0x1', 1)):
        monkeypatch.setenv('LUVEBOT_PUSH_SUBJECT', value)
        with Lines() as lines:
            ns = {'os': os_module, 'push': real, 'logging': logging}
            exec(text, ns)
        assert len(lines) == expected and ns['_PUSH_SUBJECT_SETTING'] == value, (value, lines)
        assert all('LUVEBOT_PUSH_SUBJECT' in line and value not in line for line in lines), lines                   # one line, and not the value (it may be an address)


def test_a_malformed_setting_says_so_once_and_never_shows_its_value(monkeypatch):
    setting_log_checks(API_SOURCE, monkeypatch)


@pytest.mark.parametrize('old,new', [
    ("if _PUSH_SUBJECT_SETTING and not push.valid_subject(_PUSH_SUBJECT_SETTING):", "if False:"),
    ("if _PUSH_SUBJECT_SETTING and not push.valid_subject(_PUSH_SUBJECT_SETTING):", "if _PUSH_SUBJECT_SETTING:"),
    ("no push is sent until it is fixed')", "no push is sent until it is fixed %s', _PUSH_SUBJECT_SETTING)"),
], ids=['no_line', 'a_good_setting_is_complained_about', 'the_value_is_in_the_line'])
def test_each_setting_log_mutation_is_caught(monkeypatch, old, new):
    assert API_SOURCE.count(old) == 1, old
    with pytest.raises(AssertionError):
        setting_log_checks(API_SOURCE.replace(old, new), monkeypatch)
