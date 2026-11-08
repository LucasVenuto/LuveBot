"""Red team (Lume, 31/10) of N-1c (acf3893, A-197): a host a PERSON chose leaves the two per-host tables before a real service does ("each host has its own audience, so its token would be made again, and its refusal would be logged on every event").

HELD (plain): with lowercase Windows hosts, seventy of them in one event leave the three fixed services in both tables.

FIXED IN N-1d (A-200; the 2 tests that were `xfail(strict=True)` are plain tests now, with their mutations in test_push.py) F-N6-14 (Baixa): `_chosen` recognises a chosen host by the suffix `.notify.windows.com`, case-sensitively, and the token table is keyed by the audience `https://<netloc>` with the netloc as the endpoint was written, and `endpoint_of` accepts an UPPERCASE host
(it lowercases only to compare). Seventy `X1.NOTIFY.WINDOWS.COM` devices are therefore taken for services: the tokens table keeps 0 of the 3 fixed services after one event (measured; lowercase: 3 of 3), which is the very thing N-1c exists to prevent (Apple limits the creation of a JWT).
The `aud` claim of such a token is also the uppercase origin, and an origin is lowercase (RFC 8292 section 2 names the origin of the push resource, RFC 6454 serializes it lowercase). The `_LOGGED` table is keyed by `host_of`, which lowercases: it is not affected.
Fix (N-1d): the audience is built from the lowercased netloc in `_post`, and `_chosen` decides the class from the lowercased host."""
import sys
from pathlib import Path

import jwt
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
tp = pytest.importorskip('test_push', reason='the Brasa rig of N-1')

real = tp.real


def one_event_reaching_71_hosts(tmp_path, case):
    audit = tp.sibling(real, 'audit').AuditLog(tmp_path / 'a.db')
    sender = tp.Sender(lambda url: real._status(403, 'bad_jwt'))
    box = real.Push(tmp_path / 'a.db', subject='https://luve.app', source='public_url', sender=sender, clock=lambda: 1_000_000.0)
    for endpoint in (tp.FCM, tp.MOZ, tp.APPLE):
        tp.sub(real, audit, box, endpoint)
    for person in range(7):
        for device in range(10):
            box.subscribe(audit, f'basic:p{person}', f'https://{case("h%dx%d" % (person, device))}.{case("notify.windows.com")}/w/?token=x', ['approval'], 'req_t')
    real._TOKENS.clear()
    real._LOGGED.clear()
    with tp.Lines():
        tp.settled(box, audit, 'approval', 'vendas')
    return sender


def services_in(table, host_of_key):
    return {h for h in (host_of_key(k) for k in table) if h in real.HOSTS}


def test_with_lowercase_windows_hosts_the_three_fixed_services_stay_in_both_tables(tmp_path):
    one_event_reaching_71_hosts(tmp_path, str.lower)
    assert services_in(real._TOKENS, lambda k: k[0].removeprefix('https://')) == set(real.HOSTS)
    assert services_in(real._LOGGED, lambda k: k) == set(real.HOSTS)
    assert len(real._TOKENS) <= 64 and len(real._LOGGED) <= 64


def test_with_UPPERCASE_windows_hosts_the_three_fixed_services_stay_in_the_tokens_table(tmp_path):
    one_event_reaching_71_hosts(tmp_path, str.upper)
    assert services_in(real._TOKENS, lambda k: k[0].removeprefix('https://').lower()) == set(real.HOSTS), sorted(k[0] for k in real._TOKENS)[:3]


def test_the_log_table_is_keyed_by_the_lowercased_host_and_is_not_affected(tmp_path):
    one_event_reaching_71_hosts(tmp_path, str.upper)
    assert services_in(real._LOGGED, lambda k: k) == set(real.HOSTS)


def test_the_aud_claim_is_the_lowercase_origin_whatever_case_the_endpoint_was_written_in(tmp_path):
    sender = one_event_reaching_71_hosts(tmp_path, str.upper)
    auds = set()
    for url, headers in sender.sent:
        token = headers['Authorization'].partition(', k=')[0][len('vapid t='):]
        auds.add(jwt.decode(token, options={'verify_signature': False})['aud'])
    assert auds and all(aud == aud.lower() for aud in auds), sorted(auds)[:3]
