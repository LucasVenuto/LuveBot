"""Red team (Lume, 31/10) of N-1b (the Brasa's patch, A-189 and A-191: ONE host rule for an https contact and a mailto domain, only the ORIGIN of an https contact in the JWT, a malformed explicit
setting that is not replaced, the clock read inside the lock, the tables of 64, a 410 that is `expired`, and an audit that holds refusals and one row per test). Contract v0.11 7.1 to 7.5.

HELD (plain tests; the mutations below turn each red): the host rule over the reserved names and the last label, in https and mailto, and over the ports; the JWT carries the ORIGIN of an https
contact (never its path, query or fragment, hostile or not) and a mailto as it is, with the claim set exactly aud, exp, sub; the audit holds a REFUSAL as one `notifications.deliver` row and a
success as none, and a test leaves its one `notifications.test` row and none per device; the two tables stay at 64 inside ONE minute (a single event that reaches 70 hosts), not only after their
entries age out; eight requests of one person at once send ONE test (the clock inside the lock).

FIXED IN N-1c (A-197; the tests that were `xfail(strict=True)` are plain tests now, and each rule has its mutations in test_push.py), all four introduced or left by the patch itself:
  F-N6-10 (Baixa): the patch dropped the `0 <=` of the rate window (`now - last < 10`), which was there for a clock that goes BACK. With the clock read inside the lock the race it was removed for is
          gone, and a clock stepped back by D seconds (an NTP step, a VM resumed) now blocks the test for D seconds: measured 30, 600 and 3600 seconds, all `rate_limited`, and the time stored is the
          future one, so it survives a restart. Reference fix: put `0 <=` back (the clock inside the lock makes it safe).
  F-N6-11 (Baixa): `subject_claim` builds the origin from `netloc`, so what the contact says leaks into the claim: `https://luve.app:/x` (an empty port, accepted) is claimed as `https://luve.app:`,
          and `https://luve.app:0080/` as `https://luve.app:0080`. An origin has no empty port and no leading zeros. Reference fix: build it from `hostname` and `port`.
  F-N6-12 (Info): the reserved names are matched as endings that start with a dot, so the APEX of the one that has two labels passes: `https://home.arpa`, `mailto:ops@home.arpa`.
          Reference fix: match `'.' + host`.
  F-N6-13 (Info): the table of 64 evicts the oldest host, and the hosts of Windows endpoints are a person's choice: seventy of them in one event push the real service out of `_LOGGED`, so
          `fcm.googleapis.com` logs its refusal on EVERY event instead of once a minute (the line that 7.2 limits to one per host per minute). Reference fix: key the log memory by the SERVICE, not the
          exact host (the line still names the host).
NOT CLAIMED, in the report: the log line of a refusal is the one thing the tables protect, and the audit now holds no success (a delivery that worked leaves `last_*` and `push_log`, not a row):
that is A-189, read and accepted; `.onion`, `.alt` and the reverse zones (`in-addr.arpa`) are not on the contract's list and pass."""
import json
import logging
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_push', reason='the Brasa rig of N-1')
jwt = pytest.importorskip('jwt', reason='the VAPID token is a JWT')

real = tp.real
FCM, MOZ, APPLE, WIN = tp.FCM, tp.MOZ, tp.APPLE, tp.WIN
BS = chr(92)


def must(fn, *args):
    return tp.must(fn, *args)


# ---------------------------------------------------------------- held: the ONE host rule (A-189) ---------------------------------------------------
RESERVED = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')


def check_the_one_host_rule(m, tmp):
    for good in ('https://luve.app', 'https://a.b-c.luve.app:1/', 'https://luve.app:65535', 'https://xn--p1ai.xn--p1ai/x', 'https://luve.app1', 'mailto:ops@luve.app', 'mailto:ops@xn--p1ai.xn--p1ai',
                 'https://home-arpa.luve.app', 'https://lan.luve.app', 'https://localdomain.luve.app'):
        assert must(m.valid_subject, good) is True, good                                         # a name that only CONTAINS a reserved word is fine
    for ending in RESERVED:
        for template in ('https://luve{}', 'https://mac{}:9119/x', 'mailto:ops@luve{}', 'https://LUVE{}.', 'https://a.b.c{}/p'):
            assert must(m.valid_subject, template.format(ending)) is False, (template, ending)
    for bad in ('https://luve.1app', 'https://0x7f.0x1', 'https://0x7f.0.0.0x1', 'https://1.2.3.4', 'https://127.1', 'https://luve.123', 'https://luve.0x', 'mailto:ops@luve.1app', 'mailto:ops@127.0.0.1',
                'https://localhost', 'https://luve', 'https://[::1]/'):
        assert must(m.valid_subject, bad) is False, bad
    for port in ('0', '65536', '99999', 'abc', '-1', '+80', '00', '1.5', cp(0x668) + cp(0x660)):
        assert must(m.valid_subject, f'https://luve.app:{port}/x') is False, port
    for port in ('1', '80', '443', '8443', '65535'):
        assert must(m.valid_subject, f'https://luve.app:{port}/x') is True, port


cp = chr


def test_the_one_host_rule_on_the_real_module(tmp_path):
    check_the_one_host_rule(real, tmp_path)


# ---------------------------------------------------------------- held: only the origin goes to the services ---------------------------------------
def check_only_the_origin_is_in_the_jwt(m, tmp):
    tails = ['/', '/contact?x=1', '/a/b#frag', '/"},"admin":true,"x":"', '/' + BS, '/%0d%0aX-Evil:%201', "/?a='b';c=\"d\"&e=f", '?q=secret-token-9941', '#secret-fragment-9941']
    for index, tail in enumerate(tails):
        folder = tmp / f'o{index}'
        folder.mkdir()
        for host, expected in (('luve.app', 'https://luve.app'), ('luve.app:8443', 'https://luve.app:8443')):
            subject = 'https://' + host + tail
            assert must(m.valid_subject, subject) is True, subject                               # only worth something if the contact IS accepted
            sender = tp.Sender()
            audit = tp.sibling(m, 'audit').AuditLog(folder / f'{host.replace(":", "_")}.db')
            box = m.Push(folder / f'{host.replace(":", "_")}.db', subject=subject, source='setting', sender=sender)
            tp.sub(m, audit, box, FCM)
            must(box.test, audit, 'basic:ana', 'req_o')
            (url, headers), = sender.sent
            token = headers['Authorization'].partition(', k=')[0][len('vapid t='):]
            claims = jwt.decode(token, options={'verify_signature': False})
            assert set(claims) == {'aud', 'exp', 'sub'} and claims['sub'] == expected, (subject, claims)
            assert 'secret' not in json.dumps(claims) and 'admin' not in json.dumps(claims)
    folder = tmp / 'mail'
    folder.mkdir()
    sender = tp.Sender()
    audit = tp.sibling(m, 'audit').AuditLog(folder / 'a.db')
    box = m.Push(folder / 'a.db', subject='mailto:Ops.Team+push@mail.luve.com.br', source='setting', sender=sender)
    tp.sub(m, audit, box, FCM)
    must(box.test, audit, 'basic:ana', 'req_m')
    token = sender.sent[0][1]['Authorization'].partition(', k=')[0][len('vapid t='):]
    assert jwt.decode(token, options={'verify_signature': False})['sub'] == 'mailto:Ops.Team+push@mail.luve.com.br'      # a mailto is as it is


def test_only_the_origin_is_in_the_jwt_on_the_real_module(tmp_path):
    check_only_the_origin_is_in_the_jwt(real, tmp_path)


# ---------------------------------------------------------------- held: the audit holds refusals and one row per test --------------------------------
def audit_count(path, action, detail='intent'):
    return tp.rows_of(path, f"SELECT COUNT(*) FROM audit_log WHERE action='{action}' AND detail='{detail}'")[0][0]


def check_the_audit_holds_refusals_and_one_row_per_test(m, tmp):
    sender = tp.Sender(lambda url: {FCM: 201, MOZ: m._status(403, 'bad_jwt'), APPLE: 410}.get(url, 201))
    path = tmp / 'a.db'
    audit = tp.sibling(m, 'audit').AuditLog(path)
    box = m.Push(path, subject='https://luve.app', source='public_url', sender=sender, clock=lambda: 3_000_000.0)
    for endpoint in (FCM, MOZ, APPLE):
        tp.sub(m, audit, box, endpoint)
    tp.settled(box, audit, 'approval', 'vendas')
    assert audit_count(path, 'notifications.deliver') == 2                                         # the refused (403 and 410), never the one that worked
    rows = tp.rows_of(path, "SELECT target FROM audit_log WHERE action='notifications.deliver' AND detail='intent' ORDER BY id")
    assert sorted(r[0] for r in rows) == sorted(['updates.push.services.mozilla.com:403', 'web.push.apple.com:410']), rows       # the target is the host and the status, never the endpoint
    tp.sub(m, audit, box, WIN, actor='basic:bia')                                                 # a second person, so the test below shows it wakes only the caller's
    must(box.test, audit, 'basic:ana', 'req_t')
    assert audit_count(path, 'notifications.test') == 1                                            # ONE row for the test...
    assert audit_count(path, 'notifications.deliver') == 2                                         # ...and none per device, refused or not
    assert tp.rows_of(path, "SELECT target FROM audit_log WHERE action='notifications.test' AND detail='intent'") == [('devices:2',)]       # the count: hers were three, the 410 was forgotten at the first wake, two are left


def test_the_audit_holds_refusals_and_one_row_per_test_on_the_real_module(tmp_path):
    check_the_audit_holds_refusals_and_one_row_per_test(real, tmp_path)


# ---------------------------------------------------------------- held: the tables stay at 64 inside ONE minute -----------------------------------------
def check_the_tables_stay_at_64_inside_one_minute(m, tmp):
    path = tmp / 'a.db'
    audit = tp.sibling(m, 'audit').AuditLog(path)
    box = m.Push(path, subject='https://luve.app', source='public_url', sender=tp.Sender(lambda url: m._status(403, 'bad_jwt')), clock=lambda: 1_000_000.0)
    tp.sub(m, audit, box, FCM)
    for person in range(7):
        for device in range(10):
            box.subscribe(audit, f'basic:p{person}', f'https://h{person}x{device}.notify.windows.com/w/?token=x', ['approval'], 'req_t')
    m._TOKENS.clear()
    m._LOGGED.clear()
    with tp.Lines():
        tp.settled(box, audit, 'approval', 'vendas')                                               # ONE event reaches 71 hosts at one instant: nothing ages out
    assert len(tp.rows_of(path, 'SELECT id FROM push_subscriptions')) == 71
    assert len(m._TOKENS) <= 64 and len(m._LOGGED) <= 64, (len(m._TOKENS), len(m._LOGGED))
    m._TOKENS.clear()
    m._LOGGED.clear()


def test_the_tables_stay_at_64_inside_one_minute_on_the_real_module(tmp_path):
    check_the_tables_stay_at_64_inside_one_minute(real, tmp_path)


# ---------------------------------------------------------------- held: eight requests at once send ONE test ---------------------------------------------
def test_eight_requests_of_one_person_at_once_send_one_test(tmp_path):
    for round_ in range(8):
        folder = tmp_path / f'r{round_}'
        folder.mkdir()
        sender = tp.Sender(delay=0.05)
        audit = tp.sibling(real, 'audit').AuditLog(folder / 'a.db')
        box = real.Push(folder / 'a.db', subject='https://luve.app', source='public_url', sender=sender)
        tp.sub(real, audit, box, FCM)
        bar = threading.Barrier(8)

        def call():
            bar.wait()
            try:
                box.test(audit, 'basic:ana', 'req_r')
            except Exception:  # noqa: BLE001  the 429 of the others
                pass
        threads = [threading.Thread(target=call) for _ in range(8)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert len(sender.sent) == 1, (round_, len(sender.sent))                                  # the contract: one per 10 seconds per person


CHECKS = {'rule': check_the_one_host_rule, 'origin': check_only_the_origin_is_in_the_jwt, 'audit': check_the_audit_holds_refusals_and_one_row_per_test,
          'tables': check_the_tables_stay_at_64_inside_one_minute}
MUTANTS = [
    ('rule', 'a last label may start with a digit', " and labels[-1][0].isalpha() and not ('.' + host).endswith(RESERVED_ENDINGS)", " and not ('.' + host).endswith(RESERVED_ENDINGS)"),
    ('rule', 'the internal names are fine', "'.example', '.internal', '.lan', '.localdomain', '.home.arpa')", "'.example', '.lan', '.localdomain', '.home.arpa')"),
    ('rule', 'the lan names are fine', "'.internal', '.lan', '.localdomain'", "'.internal', '.localdomain'"),
    ('rule', 'any port is a port', "and (port is None or 1 <= port <= 65535)", ""),
    ('rule', 'port 0 is a port', "(port is None or 1 <= port <= 65535)", "(port is None or 0 <= port <= 65535)"),
    ('rule', 'a mailto domain is not checked by the one rule', "re.fullmatch(r'[A-Za-z0-9._%+-]{1,64}', name) is not None and _host_ok(host)", "re.fullmatch(r'[A-Za-z0-9._%+-]{1,64}', name) is not None and '.' in host"),
    ('origin', 'the whole URL is the claim', "    return f'https://{url.hostname}' + (f':{url.port}' if url.port not in (None, 443) else '')", '    return value'),
    ('origin', 'the path stays', "(f':{url.port}' if url.port not in (None, 443) else '')", "(f':{url.port}' if url.port not in (None, 443) else '') + url.path"),
    ('audit', 'a test leaves a row per device', "if reason is not None and kind != 'test':", "if reason is not None:"),
    ('audit', 'a success is audited too', "if reason is not None and kind != 'test':", "if kind != 'test':"),
    ('tables', 'the table never drops its oldest', '    while len(table) > TABLE_MAX:\n        victim = next((k for k in table if _chosen(k)), None)\n        del table[victim if victim is not None else next(iter(table))]', '    while False:\n        pass'),
    ('tables', 'the table is of 65', "TABLE_MAX = 64 ", "TABLE_MAX = 640 "),
]


def test_every_check_has_a_mutant():
    assert set(CHECKS) == {name for name, *_ in MUTANTS}


@pytest.mark.parametrize('name,label,old,new', MUTANTS, ids=[f'{n}|{l}' for n, l, *_ in MUTANTS])
def test_each_mutant_turns_its_check_red(tmp_path_factory, tmp_path, name, label, old, new):
    variant = tp.load_variant(tmp_path_factory, old, new)
    with pytest.raises(AssertionError):
        CHECKS[name](variant, tmp_path)


# ---------------------------------------------------------------- open: F-N6-10 a clock stepped back blocks the test --------------------------------
@pytest.mark.parametrize('step', [30, 600, 3600])
def test_a_clock_stepped_back_does_not_block_the_test_for_the_length_of_the_step(tmp_path, step):
    now = [1_000_000.0]
    sender = tp.Sender()
    audit = tp.sibling(real, 'audit').AuditLog(tmp_path / 'a.db')
    box = real.Push(tmp_path / 'a.db', subject='https://luve.app', source='public_url', sender=sender, clock=lambda: now[0])
    tp.sub(real, audit, box, FCM)
    box.test(audit, 'basic:ana', 'req_1')
    now[0] -= step                                                                                # an NTP step, a VM resumed: the time of the first test is now in the FUTURE
    box.test(audit, 'basic:ana', 'req_2')                                                         # not the 429 of a window that never ends
    assert len(sender.sent) == 2


# ---------------------------------------------------------------- open: F-N6-11 the claim is not an origin -------------------------------------------
def test_the_claim_is_a_canonical_origin():
    for subject, origin in (('https://luve.app:/x', 'https://luve.app'), ('https://luve.app:0080/x', 'https://luve.app:80'), ('https://luve.app:443/x', 'https://luve.app'),      # A-197: the default port FALLS
                           ('https://luve.app:8443/x', 'https://luve.app:8443'), ('https://LUVE.App/x', 'https://luve.app')):
        assert real.subject_claim(subject) == origin, (subject, real.subject_claim(subject))


# ---------------------------------------------------------------- open: F-N6-12 the apex of a reserved name -------------------------------------------
def test_the_apex_of_a_reserved_name_is_not_a_contact():
    for subject in ('https://home.arpa', 'https://HOME.ARPA/x', 'mailto:ops@home.arpa', 'https://home.arpa:8443'):
        assert real.valid_subject(subject) is False, subject


# ---------------------------------------------------------------- open: F-N6-13 hostile hosts evict the real service from the log memory ---------------
def test_seventy_hosts_of_windows_endpoints_do_not_make_a_real_service_log_every_event(tmp_path):
    now = [1_000_000.0]
    audit = tp.sibling(real, 'audit').AuditLog(tmp_path / 'a.db')
    box = real.Push(tmp_path / 'a.db', subject='https://luve.app', source='public_url', sender=tp.Sender(lambda url: real._status(403, 'bad_jwt')), clock=lambda: now[0])
    tp.sub(real, audit, box, FCM)
    for person in range(7):
        for device in range(10):
            box.subscribe(audit, f'basic:p{person}', f'https://h{person}x{device}.notify.windows.com/w/?token=x', ['approval'], 'req_t')
    real._LOGGED.clear()
    with tp.Lines() as lines:
        tp.settled(box, audit, 'approval', 'vendas')
        now[0] += 1
        tp.settled(box, audit, 'approval', 'vendas')
    real._LOGGED.clear()
    assert len([line for line in lines if 'fcm.googleapis.com' in line]) == 1, [line for line in lines if 'fcm.googleapis.com' in line]       # one line per host per minute (7.2)
