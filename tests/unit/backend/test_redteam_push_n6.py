"""Red team (Lume, 31/10) of N-1 (d8de65e: the contact of the VAPID `sub`, the last outcome and the one log line per host, POST /notifications/test, the key id and
`key_mismatch`) against contract v0.11 section 7.1 to 7.4 and 7.5. The `question` kind (7.6, N-3) is not delivered yet: it is NOT attacked here.

HELD (plain tests; the mutations below turn each red): a hostile contact is DATA in the JWT claim (quotes, backslashes, a whole `"},"admin":true` tail come back as the
`sub` string, the claim set is exactly aud, exp, sub) and never reaches a header; every control, separator and non-ASCII character is refused in a contact; the log
lines, the audit rows, the device list, /health and the answer of the test carry no endpoint, no JWT and no text of an exception, whatever the sender does (it raises with
the endpoint and a token in its message, it is refused, it never answers); the test wakes ONLY the caller's devices with six people calling at once; look-alike hosts of the
four services are refused; the host class a Windows endpoint may carry has no control, format, space or bidi character (this is what keeps a log line one line); a key in
any alphabet or shape the browser would not send is refused.

FIXED IN N-1b (A-189; the seven tests that were `xfail(strict=True)` are plain tests now, with mutations in test_push.py):
  F-N6-1 (Baixa): a hostile body is an unhandled exception, so a 500 where the contract says 422. `key_id_of` raises binascii.Error for a base64url string whose length is 1
          more than a multiple of 4 (17, 21, ... 137 characters: it passes the regex and then fails to decode), and `endpoint_of` lets `urlsplit` raise ValueError for
          `https://[::1/x`, a port out of range or not a number, and any host that holds a character whose NFKC form is a separator (a fullwidth slash, a fullwidth hash).
  F-N6-5 (Info): `endpoint_of` validates what `urlsplit` PARSED and stores the string it was GIVEN: `urlsplit` drops a tab, CR and LF, so one inside the host or the path passes
          (`https://fcm.googleapis.com/fcm/send/a<TAB>b`), and the path is not checked at all (a control character, a space, a non-ASCII letter), so a device that no push can ever reach
          is stored as subscribed. It breaks nothing else (http.client refuses such a URL, the send says `other`), but a row that can never work should be a 422 at the door.
  F-N6-2 (Baixa): `valid_subject` accepts an https contact that is an IP in a form the URL standard reads as one (`https://0x7f.0x1`: a last label in hex, which the
          `isdigit` test does not see), a port that is not one (`:abc`, `:99999`), and, by the letter of 7.1, the names the mailto branch refuses (`.local`, `.test`,
          `.invalid`, `.example`) and `.localhost`. The last part is a decision for the Architect (7.1 lists the endings for mailto only).
  F-N6-3 (Media): the 10 seconds of `POST /notifications/test` are not kept under concurrency. `test()` reads the clock BEFORE `BEGIN IMMEDIATE`, and the window is
          `0 <= now - last < 10`: a request whose clock was read earlier than the winner's write sees a NEGATIVE difference and is let through. Real threads: 8 at once, 25 of
          30 rounds sent more than one wake (4 at worst), each to every device of the person (up to 10), against a limit that protects the person's phone and the one VAPID
          identity that every person shares.
  F-N6-4 (Baixa): `_TOKENS` (one JWT per audience) and `_LOGGED` (one time per host) are module dictionaries keyed by the push service's host, which a person chooses for
          `*.notify.windows.com`; nothing ever removes an entry, so subscribe, test and unsubscribe with a new subdomain each round grows them without limit (300 rounds: 300 and 300).
NOT CLAIMED, in the report: the contact that is the whole `public_url` (path and query go to Apple, Google and Mozilla inside the JWT: only the origin is needed); an explicit
`LUVEBOT_PUSH_SUBJECT` that is malformed falls back to `public_url` and says so only through `source`; `moved: true` tells whoever already holds an endpoint whether it was
someone else's; the validated Windows host string is not the host the request goes to (IDNA normalizes it, but only before the fixed suffix)."""
import json
import re
import sys
import threading
import time
import unicodedata
import urllib.parse
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_push', reason='the Brasa rig of N-1')
jwt = pytest.importorskip('jwt', reason='the VAPID token is a JWT')

real = tp.real
FCM, MOZ, WIN = tp.FCM, tp.MOZ, tp.WIN
BS = chr(92)
cp = chr


def must(fn, *args):
    return tp.must(fn, *args)


def quiet():
    return tp.Lines()


# ---------------------------------------------------------------- held: a hostile contact is data -------------------------------------------------------------
def check_a_hostile_contact_is_data(m, tmp):
    hostile = ['https://luve.app/"},"admin":true,"x":"', 'https://luve.app/' + BS, 'https://luve.app/' + BS + 'u0022', 'https://luve.app/%0d%0aX-Evil:%201',
               'mailto:a%0d%0ab@luve.app', "https://luve.app/a'b;c", 'https://luve.app/?a=b&c="d"']
    for index, subject in enumerate(hostile):
        assert must(m.valid_subject, subject) is True, subject                  # the case is only worth something if the contact IS accepted
        sub_dir = tmp / f'c{index}'
        sub_dir.mkdir()
        sender = tp.Sender()
        audit = tp.sibling(m, 'audit').AuditLog(sub_dir / 'a.db')
        box = m.Push(sub_dir / 'a.db', subject=subject, source='setting', sender=sender)
        tp.sub(m, audit, box, FCM)
        must(box.test, audit, 'basic:ana', 'req_c')
        (url, headers), = sender.sent
        assert set(headers) == {'TTL', 'Urgency', 'Content-Length', 'Topic', 'Authorization'}, headers
        auth = headers['Authorization']
        head, _sep, key = auth.partition(', k=')
        token = head[len('vapid t='):]
        assert head.startswith('vapid t=') and all(ch.isascii() and (ch.isalnum() or ch in '_-.') for ch in token + key), auth      # only token characters reach a header
        claims = jwt.decode(token, options={'verify_signature': False})
        assert set(claims) == {'aud', 'exp', 'sub'} and claims['sub'] == (subject if subject.startswith('mailto:') else 'https://luve.app'), (subject, claims)                          # the tail did not become a claim
    refused = [cp(c) for c in list(range(0, 33)) + [127] + list(range(0x80, 0x300))] + [cp(c) for c in (0x2028, 0x2029, 0x200b, 0x200e, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff, 0xe0041)]
    for ch in refused:
        for template in ('https://luve.app/a{}b', 'https://lu{}ve.app', 'mailto:a{}b@luve.app', 'mailto:ab@lu{}ve.app'):
            assert must(m.valid_subject, template.format(ch)) is False, (template, hex(ord(ch)))
    for bad in ('mailto:a@luve.app?cc=x@evil.org', 'mailto:a@luve.app,b@evil.org', 'mailto:a@@luve.app', 'mailto:a@luve.app;b', 'https://luve.app@evil.test:80', 'https://evil.test' + BS + '@luve.app'):
        assert must(m.valid_subject, bad) is False, bad


def test_a_hostile_contact_is_data_on_the_real_module(tmp_path):
    check_a_hostile_contact_is_data(real, tmp_path)


# ---------------------------------------------------------------- held: nothing of the capability anywhere ---------------------------------------------------
SECRETS = ('dEvIcE', 'APA91b', 'gAAAAB', 'QGuQ', '/fcm/', 'token=', 'SECRETTOKEN123', 'vapid', 'Authorization', 'luve.app')
JWT_SHAPE = re.compile(r'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}')   # a JWT: three base64url groups (header, claims, signature) behind `eyJ`; the three letters alone are base64 of `{"` and
# turn up by chance in any random base64 string (a VAPID public key holds them in 0.03% of the keys), so they are not a leak by themselves


def check_nothing_of_the_capability_is_shown(m, tmp):
    def raising(url, headers):
        raise RuntimeError(f'cannot reach {url} with token=SECRETTOKEN123 {headers.get("Authorization", "")}')

    def refused(url, headers):
        return m._status(403, 'bad_jwt')

    def mixed(url, headers):
        return 201 if 'fcm' in url else m._status(0, 'timeout')
    for index, sender in enumerate((raising, refused, mixed)):
        folder = tmp / f's{index}'
        folder.mkdir()
        path = folder / 'a.db'
        audit = tp.sibling(m, 'audit').AuditLog(path)
        box = m.Push(path, subject='https://luve.app', source='public_url', sender=sender, clock=time.time)
        for endpoint in (FCM, MOZ, WIN):
            tp.sub(m, audit, box, endpoint)
        m._LOGGED.clear()
        with quiet() as lines:
            tp.settled(box, audit, 'approval', 'vendas')
            answer = must(box.test, audit, 'basic:ana', 'req_t')
        shown = [lines, answer, box.mine('basic:ana'), box.status(), m.problem_of(box.status()), {k: v for k, v in box.config().items() if k != 'public_key'},     # the public key is served on purpose
                 tp.rows_of(path, 'SELECT * FROM audit_log'), tp.rows_of(path, 'SELECT * FROM push_log'), tp.rows_of(path, 'SELECT * FROM push_events')]
        text = json.dumps(shown, default=str)
        for secret in SECRETS:
            assert secret not in text, (index, secret)
        assert JWT_SHAPE.search(text) is None, (index, 'a JWT')
        pem, _public = box._key()
        assert 'PRIVATE KEY' not in text and pem.decode().splitlines()[1][:30] not in text, (index, 'the private key')


def test_nothing_of_the_capability_is_shown_on_the_real_module(tmp_path):
    check_nothing_of_the_capability_is_shown(real, tmp_path)


def lucky_key():
    """A VAPID key whose PUBLIC half holds `eyJ` (about one in 3,000): what made the check below fail once in a whole-suite run, by chance."""
    import base64
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    for _ in range(300_000):
        key = ec.generate_private_key(ec.SECP256R1())
        public = base64.urlsafe_b64encode(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).rstrip(b'=').decode()
        if 'eyJ' in public:
            return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()), public
    raise AssertionError('no key with eyJ in 300,000 tries')


def test_a_public_key_that_happens_to_hold_eyJ_is_not_taken_for_a_leaked_token(tmp_path, monkeypatch):
    lucky = lucky_key()
    monkeypatch.setattr(real.Push, '_key', lambda self: lucky)
    assert 'eyJ' in real.Push(tmp_path / 'k.db', subject='https://luve.app', source='public_url').config()['public_key']
    check_nothing_of_the_capability_is_shown(real, tmp_path)


# ---------------------------------------------------------------- held: the test wakes only the caller's devices ---------------------------------------------
def check_six_people_test_at_once_and_each_wakes_only_theirs(m, tmp):
    sent, guard = [], threading.Lock()

    def sender(url, headers):
        with guard:
            sent.append(url)
        return 201
    path = tmp / 'a.db'
    audit = tp.sibling(m, 'audit').AuditLog(path)
    box = m.Push(path, subject='https://luve.app', source='public_url', sender=sender)
    owners, ids = {}, {}
    for i in range(6):
        actor = f'basic:p{i}'
        ids[actor] = []
        for j in range(2):
            endpoint = f'https://fcm.googleapis.com/fcm/send/dev{i}x{j}:APA91b'
            ids[actor].append(box.subscribe(audit, actor, endpoint, list(m.KINDS), 'req_s')['id'])
            owners[endpoint] = actor
    bar, got, errors = threading.Barrier(6), {}, []

    def call(actor):
        bar.wait()
        try:
            got[actor] = box.test(audit, actor, 'req_' + actor[-2:])
        except Exception as error:  # noqa: BLE001
            errors.append((actor, error))
    threads = [threading.Thread(target=call, args=(actor,)) for actor in ids]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == [], errors
    for actor, expected in ids.items():
        assert [d['id'] for d in got[actor]['devices']] == expected, actor                  # the answer lists hers, in order, and only hers
    assert sorted(sent) == sorted(owners), 'each device is woken exactly once, and no endpoint of anyone else was reached by a call'


def test_six_people_test_at_once_on_the_real_module(tmp_path):
    check_six_people_test_at_once_and_each_wakes_only_theirs(real, tmp_path)


# ---------------------------------------------------------------- held: hosts and keys --------------------------------------------------------------------
def check_look_alike_hosts_and_the_windows_class(m, tmp):
    for bad in ('https://fcm.googleapis.com.evil.test/x', 'https://evilfcm.googleapis.com/x', 'https://notify.windows.com/x', 'https://evil-notify.windows.com/x',
                'https://x.notify.windows.com.evil.test/x', 'https://fcm.googleapis.com@evil.test/x', 'https://evil.test/@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x',
                'https://fcm.googleapis.com./x', 'http://fcm.googleapis.com/x', 'https://user:pw@fcm.googleapis.com/x', 'https://x.notify.windows.com:8443/x', 'https://-.notify.windows.com/x'):
        error = tp.refused(m, 'invalid_field', m.endpoint_of, bad)
        assert error.status == 422, bad
    forbidden = set('/?#@:' + BS + '[]%')
    taken = []
    for code in list(range(0x10000)) + list(range(0x1d400, 0x1d800)) + list(range(0xe0000, 0xe0080)) + list(range(0x1f100, 0x1f200)):
        if 0xd800 <= code < 0xe000:
            continue
        endpoint = 'https://' + cp(code) + 'a.notify.windows.com/w'
        try:
            m.endpoint_of(endpoint)
        except Exception:  # noqa: BLE001  a refusal (PluginError) or the urlsplit ValueError of F-N6-1: either way not accepted
            continue
        taken.append(code)
    assert len(taken) >= 60                                                                   # the scan is not empty (the 62 ASCII letters and digits at least; today it is tens of thousands of letters of every script)
    for code in taken:
        host = urllib.parse.urlsplit('https://' + cp(code) + 'a.notify.windows.com/w').hostname      # the host the log line and the answer name (urlsplit drops a tab, CR and LF itself: F-N6-5)
        for char in host:
            assert unicodedata.category(char) not in ('Cc', 'Cf', 'Zs', 'Zl', 'Zp', 'Cs', 'Co', 'Cn') and char not in forbidden, (hex(code), hex(ord(char)))


def test_look_alike_hosts_and_the_windows_class_on_the_real_module(tmp_path):
    check_look_alike_hosts_and_the_windows_class(real, tmp_path)


def check_a_key_in_a_shape_the_browser_would_not_send_is_refused(m, tmp):
    good = 'A' * 20
    assert must(m.key_id_of, good) is not None
    for bad in (good + '\n', '\n' + good, good + ' ', good[:10] + ' ' + good[10:], good + '\x00', 'A' * 15, good + '===', good[:8] + '=' + good[8:], 'A' * 8 + cp(0x663) * 8 + 'A' * 4,
                cp(0xff21) * 20, good + cp(0x2028), 'a+b/' * 8, 'A' * 140 + 'A' * 4, good.replace('A', '-', 1).replace('A', '+', 1)):
        assert must(m.key_id_of, bad) is None, repr(bad)
        tp.refused(m, 'invalid_field', m.subscribe_body, {'endpoint': FCM, 'application_server_key': bad})
    for odd in (True, 5, 5.5, ['k'], {'k': 1}, b'AAAAAAAAAAAAAAAAAAAA'):
        tp.refused(m, 'invalid_field', m.subscribe_body, {'endpoint': FCM, 'application_server_key': odd})
    for extra in ({'x': 1}, {'application_server_key_id': 'a'}, {'subject': 'https://evil.test'}):
        tp.refused(m, 'bad_request', m.subscribe_body, {'endpoint': FCM, **extra})
    for length in range(16, 141):
        if length % 4 == 1:
            continue                                                                          # the open finding F-N6-1
        got = must(m.key_id_of, 'A' * length)
        assert got is None or (len(got) == 16 and set(got) <= set('0123456789abcdef')), length


def test_a_key_in_a_shape_the_browser_would_not_send_is_refused_on_the_real_module(tmp_path):
    check_a_key_in_a_shape_the_browser_would_not_send_is_refused(real, tmp_path)


CHECKS = {'contact': check_a_hostile_contact_is_data, 'capability': check_nothing_of_the_capability_is_shown, 'isolation': check_six_people_test_at_once_and_each_wakes_only_theirs,
          'hosts': check_look_alike_hosts_and_the_windows_class, 'keys': check_a_key_in_a_shape_the_browser_would_not_send_is_refused}

MUTANTS = [
    ('contact', 'a control or non-ASCII character is allowed in a contact', "any(ord(c) < 33 or ord(c) > 126 for c in value)", 'False'),
    ('contact', 'a mailto with a query is accepted', "re.fullmatch(r'[A-Za-z0-9._%+-]{1,64}', name) is not None and _host_ok(host)", "re.fullmatch(r'[A-Za-z0-9._%+-]{1,64}', name) is not None and _host_ok(host.partition('?')[0])"),
    ('contact', 'a user name in an https contact is accepted', "and not url.username and not url.password", ''),
    ('capability', 'the refusal line carries the endpoint', "logging.getLogger('luvebot.push').warning('push refused by %s: status %s, reason %s', host, status, reason)",
     "logging.getLogger('luvebot.push').warning('push refused by %s: status %s, reason %s %s', host, status, reason, target['endpoint'])"),
    ('capability', 'the VAPID token is logged', "            token = self._token(jwt, pem, public, f'{url.scheme}://{url.netloc.lower()}')",
     "            token = self._token(jwt, pem, public, f'{url.scheme}://{url.netloc.lower()}')\n            logging.getLogger('luvebot.push').warning('sent with %s', token)"),
    ('capability', 'the text of a failed send is logged', "            return 0, reason_of(0, '', error)",
     "            logging.getLogger('luvebot.push').warning('push failed: %s', error)\n            return 0, reason_of(0, '', error)"),
    ('capability', 'the audit target is the endpoint', "audit.act(actor, 'notifications.deliver', f'{host}:{status}', origin, effect,", "audit.act(actor, 'notifications.deliver', target['endpoint'], origin, effect,"),
    ('capability', 'the device list shows the endpoint', "'host': host_of(r['endpoint']), 'kinds': list(stored_kinds(r['kinds']))", "'host': r['endpoint'], 'kinds': list(stored_kinds(r['kinds']))"),
    ('capability', 'the answer of the test shows the endpoint', "results.append({'id': target['id'], 'host': host_of(target['endpoint']), 'ok': kept is None,", "results.append({'id': target['id'], 'host': target['endpoint'], 'ok': kept is None,"),
    ('isolation', 'the test wakes everybody', "'SELECT id, endpoint FROM push_subscriptions WHERE actor=? ORDER BY id', (actor,))]", "'SELECT id, endpoint FROM push_subscriptions WHERE ?=? ORDER BY id', (actor, actor))]"),
    ('hosts', 'the Windows suffix needs no dot', "host.endswith(WINDOWS) and host[:-len(WINDOWS)]", "host.endswith(WINDOWS.lstrip('.')) and host[:-len(WINDOWS.lstrip('.'))]"),
    ('hosts', 'any character is a host character', ".replace('.', '').isalnum())", ".replace('.', '') != '')"),
    ('keys', 'a trailing newline is part of a key', "re.fullmatch(r'[A-Za-z0-9_-]{16,140}={0,2}', public_key)", "re.match(r'[A-Za-z0-9_-]{16,140}={0,2}$', public_key)"),
    ('keys', 'any shape is a key', "re.fullmatch(r'[A-Za-z0-9_-]{16,140}={0,2}', public_key)", "re.match(r'[A-Za-z0-9_-]{16,140}', public_key)"),
]


def test_every_check_has_a_mutant():
    assert set(CHECKS) == {name for name, *_ in MUTANTS}


@pytest.mark.parametrize('name,label,old,new', MUTANTS, ids=[f'{n}|{l}' for n, l, *_ in MUTANTS])
def test_each_mutant_turns_its_check_red(tmp_path_factory, tmp_path, name, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(AssertionError):
        CHECKS[name](variant, tmp_path)


# ---------------------------------------------------------------- open: F-N6-1 a hostile body is a 500 -------------------------------------------------------
def test_a_key_of_a_length_that_cannot_be_base64_is_a_422_not_an_error():
    for length in range(17, 138, 4):
        error = tp.refused(real, 'invalid_field', real.subscribe_body, {'endpoint': FCM, 'application_server_key': 'A' * length})
        assert error.status == 422, length
        assert real.key_id_of('A' * length) is None, length


def test_an_endpoint_urlsplit_cannot_read_is_a_422_not_an_error():
    for endpoint in ('https://[::1/x', 'https://fcm.googleapis.com:99999/x', 'https://fcm.googleapis.com:abc/x', 'https://' + cp(0x2100) + '.notify.windows.com/x',
                     'https://' + cp(0xff0f) + 'x.notify.windows.com/', 'https://x' + cp(0xff03) + '.notify.windows.com/'):
        error = tp.refused(real, 'invalid_field', real.endpoint_of, endpoint)
        assert error.status == 422, endpoint


# ---------------------------------------------------------------- open: F-N6-5 an endpoint that can never be reached is stored -----------------------------------------
def test_an_endpoint_that_no_push_can_reach_is_a_422_at_the_door():
    tab, cr, lf = cp(9), cp(13), cp(10)
    for bad in ('https://fcm.googleapis.com/fcm/send/a' + tab + 'b', 'https://fcm.googleapis.com/fcm/send/a' + cr + lf + 'b', 'https://fcm.googleapis.com' + tab + '/x',
                'https://fcm.google' + lf + 'apis.com/x', 'https://fcm.googleapis.com/fcm/send/a' + cp(0) + 'b', 'https://fcm.googleapis.com/fcm/send/a b', 'https://fcm.googleapis.com/fcm/send/a' + cp(0xe9) + 'b',
                'https://fcm.googleapis.com/fcm/send/a' + cp(0x202e) + 'b'):
        error = tp.refused(real, 'invalid_field', real.endpoint_of, bad)
        assert error.status == 422, repr(bad)


# ---------------------------------------------------------------- open: F-N6-2 a contact that is not one ------------------------------------------------------
def test_the_contact_is_never_an_ip_in_any_form_and_has_a_real_port():
    for bad in ('https://0x7f.0x1', 'https://0x7f.0.0.0x1', 'https://0X7F.0.0.1', 'https://luve.app:abc/', 'https://luve.app:99999/', 'https://luve.app:-1/'):
        assert real.valid_subject(bad) is False, bad
    assert real.valid_subject('https://luve.app:8443/') is True and real.valid_subject('https://a1.luve.app') is True      # and what is fine stays fine


def test_the_https_contact_refuses_the_names_the_mailto_one_refuses():
    for ending in ('.local', '.test', '.invalid', '.example', '.localhost'):
        assert real.valid_subject(f'mailto:ops@luve{ending}') is False, ending                 # what the contract already says
        assert real.valid_subject(f'https://luve{ending}') is False, ending
        assert real.valid_subject(f'https://mac{ending}:9119/') is False, ending


# ---------------------------------------------------------------- open: F-N6-3 the 10 seconds do not hold under concurrency --------------------------------------
def test_two_requests_whose_clock_was_read_before_the_lock_are_not_both_let_through(tmp_path):
    sender = tp.Sender()
    audit = tp.sibling(real, 'audit').AuditLog(tmp_path / 'a.db')
    box = real.Push(tmp_path / 'a.db', subject='https://luve.app', source='public_url', sender=sender, clock=lambda: 50.0)
    tp.sub(real, audit, box, FCM)
    seen = set()

    def clock():
        if threading.current_thread().name == 'B' and 'B' not in seen:
            seen.add('B')
            time.sleep(0.4)                                                                   # B read the clock FIRST (the earlier value) and reaches the lock last
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
    assert sorted(result for _tag, result in out) == ['rate_limited', 'sent'] and len(sender.sent) == 1, (out, len(sender.sent))      # one wake per 10 seconds per person: whoever wins the lock


# ---------------------------------------------------------------- open: F-N6-4 memory keyed by a host a person chooses ------------------------------------------
def test_the_token_and_log_memories_do_not_grow_with_every_new_host(tmp_path):
    now = [1_000_000.0]
    audit = tp.sibling(real, 'audit').AuditLog(tmp_path / 'a.db')
    box = real.Push(tmp_path / 'a.db', subject='https://luve.app', source='public_url', sender=tp.Sender(lambda url: real._status(403, 'bad_jwt')), clock=lambda: now[0])
    real._TOKENS.clear()
    real._LOGGED.clear()
    try:
        with quiet():
            for i in range(300):
                sid = box.subscribe(audit, 'basic:ana', f'https://h{i}.notify.windows.com/w/?token=x', ['approval'], 'req_g')['id']
                box.test(audit, 'basic:ana', 'req_g')
                box.unsubscribe(audit, 'basic:ana', sid, 'req_g')
                now[0] += 11
        assert len(real._TOKENS) <= 64 and len(real._LOGGED) <= 64, (len(real._TOKENS), len(real._LOGGED))   # A-189: 64 entries each
    finally:
        real._TOKENS.clear()
        real._LOGGED.clear()
