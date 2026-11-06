"""The harness push service (tests/harness/fake_push_service.py), checked OFFLINE and then THROUGH LuveBot's own sender: what N-5 will send to it is what a real push service would judge.

  python -m pytest -q tests/harness/test_fake_push_service.py

1. the pure judgement: a well-formed contact is `201`, `mailto:luvebot@localhost` (the CEO's phone) and every other bad one is `403 BadJwtToken`; a wrong audience, a tampered signature, an `exp` more than a day ahead and no
   `Authorization` are the same refusal; the path picks a device's fate (`gone` 410, `limited` 429, `mismatch` 403 with no body, `badjwt`, `big`);
2. the real path: `backend/push.py`'s `http_post`, in a subprocess whose environment names the proxy and the CA BEFORE it imports the module (its opener is made at import), reaches the service through `CONNECT`, trusts the
   certificate of the test CA, gets the status and the `reason` LuveBot keeps (`bad_jwt` for a 403 whose body says `BadJwtToken`, `key_mismatch` for a 403 with none, `gone`, `rate_limited`, `timeout`), and a host that is not a push host is
   TUNNELED untouched (the stack's own https calls must keep working through `HTTPS_PROXY`), with the system's roots still in `ca.pem`."""
import base64
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, str(Path(__file__).parent))
import fake_push_service as fake  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
HOST = 'web.push.apple.com'


def key_pair():
    private = ec.generate_private_key(ec.SECP256R1())
    point = private.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return private, base64.urlsafe_b64encode(point).rstrip(b'=').decode()


def vapid(sub, host=HOST, exp_in=3600, private=None, public=None, aud=None):
    private, public = (private, public) if private else key_pair()
    token = jwt.encode({'aud': aud or f'https://{host}', 'exp': int(time.time()) + exp_in, 'sub': sub}, private, algorithm='ES256')
    return {'authorization': f'vapid t={token}, k={public}', 'ttl': '3600', 'urgency': 'high', 'topic': 'test', 'content-length': '0'}


def judge(headers, path='/ok/1', host=HOST, body=b''):
    return fake.judge(host, path, headers, body)[:2]


@pytest.mark.parametrize('sub, status', [('https://luve.app', 201), ('mailto:ceo@luve.app', 201), ('mailto:luvebot@localhost', 403), ('https://localhost', 403), ('https://127.0.0.1', 403),
                                         ('http://luve.app', 403), ('mailto:a@host.test', 403), ('mailto:a@host.example', 403), ('mailto:a@x.local', 403), ('mailto:a@nodot', 403), ('', 403), (None, 403)])
def test_the_contact_decides(sub, status):
    answer = judge(vapid(sub))
    assert answer[0] == status and (answer[1] == b'' if status == 201 else answer[1] == fake.BAD), (sub, answer)


def test_every_other_refusal_of_a_real_service():
    private, public = key_pair()
    good = vapid('https://luve.app', private=private, public=public)
    assert judge(good)[0] == 201
    assert judge({k: v for k, v in good.items() if k != 'authorization'}) == (403, fake.BAD)                          # no credential
    assert judge(vapid('https://luve.app', aud='https://fcm.googleapis.com')) == (403, fake.BAD)                      # the token is for another service
    assert judge(vapid('https://luve.app', exp_in=3 * 86400)) == (403, fake.BAD)                                      # an `exp` more than 24 h ahead
    assert judge(vapid('https://luve.app', exp_in=-60)) == (403, fake.BAD)                                            # expired
    other, _ = key_pair()
    assert judge(vapid('https://luve.app', private=other, public=public)) == (403, fake.BAD)                          # signed by another key than `k`
    assert judge({**good, 'authorization': good['authorization'].replace(', k=', ',k=')}) == (403, fake.BAD)         # the exact shape LuveBot sends
    assert judge({**good, 'ttl': 'soon'})[0] == 400 and judge({**good, 'content-length': '5'}, body=b'hello')[0] == 400


def test_the_path_picks_a_devices_fate_so_one_run_shows_every_outcome():
    good = vapid('https://luve.app')
    assert judge(good, '/gone/3') == (410, b'{"reason":"Unregistered"}') and judge(good, '/limited/5')[0] == 429
    assert judge(good, '/mismatch/4') == (403, b'') and judge(good, '/badjwt/2') == (403, fake.BAD) and judge(good, '/big/7')[0] == 413


@pytest.fixture(scope='module')
def service(tmp_path_factory):
    directory = tmp_path_factory.mktemp('push')
    fake.make_ca(directory)
    server = fake.Server(('127.0.0.1', 0), directory)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1], directory
    server.shutdown()


CLIENT = r'''
import json, os, sys, types
from pathlib import Path
package = types.ModuleType("luvebot_backend_push_fixture"); package.__path__ = [os.environ["BACKEND"]]; sys.modules[package.__name__] = package
from importlib import import_module
push = import_module(package.__name__ + ".push")
url, headers = sys.argv[1], json.loads(sys.argv[2])
status = push.http_post(url, headers)
print(json.dumps({"status": int(status), "reason": getattr(status, "reason", None)}))
'''


def through_the_real_sender(service, path, headers, host=HOST):
    port, directory = service
    env = {'PATH': '/usr/bin:/bin', 'HOME': str(directory), 'BACKEND': str(ROOT / 'backend'), 'HTTPS_PROXY': f'http://127.0.0.1:{port}', 'SSL_CERT_FILE': str(directory / 'ca.pem'),
           'NO_PROXY': '127.0.0.1,localhost', 'PYTHONDONTWRITEBYTECODE': '1'}
    wire = {'TTL': headers['ttl'], 'Urgency': headers['urgency'], 'Content-Length': '0', 'Topic': headers['topic'], 'Authorization': headers['authorization']}
    done = subprocess.run([sys.executable, '-c', CLIENT, f'https://{host}{path}', json.dumps(wire)], capture_output=True, text=True, timeout=60, env=env)
    assert done.returncode == 0, done.stderr[-800:]
    return json.loads(done.stdout.strip().splitlines()[-1])


def test_luvebots_real_sender_is_judged_like_a_real_service(service):
    port, _ = service
    good = vapid('https://luve.app')
    assert through_the_real_sender(service, '/ok/1', good) == {'status': 201, 'reason': None}
    assert through_the_real_sender(service, '/badjwt/2', good) == {'status': 403, 'reason': 'bad_jwt'}            # a 403 whose body says BadJwtToken
    assert through_the_real_sender(service, '/mismatch/4', good) == {'status': 403, 'reason': 'key_mismatch'}     # a 403 with no body
    assert through_the_real_sender(service, '/gone/3', good)['status'] == 410
    assert through_the_real_sender(service, '/limited/5', good) == {'status': 429, 'reason': 'rate_limited'}
    assert through_the_real_sender(service, '/ok/1', vapid('mailto:luvebot@localhost')) == {'status': 403, 'reason': 'bad_jwt'}   # what the CEO's phone got
    slow = through_the_real_sender(service, '/slow/6', good)
    assert slow['status'] == 0 and slow['reason'] == 'timeout', slow                                                # LuveBot gives up at 5 s, the service would answer at 8
    assert through_the_real_sender(service, '/ok/1', good, host='unreachable.invalid')['status'] == 0              # a host that is not a push host is tunneled, and this one does not exist: no answer
    import urllib.request
    log = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/_log', timeout=10))
    assert [e['status'] for e in log if e['path'] == '/ok/1'] == [201, 403] and log[0]['sub'] == 'https://luve.app' and log[0]['aud'] == f'https://{HOST}'
    assert log[0]['ttl'] == '3600' and log[0]['topic'] == 'test' and log[0]['urgency'] == 'high' and log[0]['body_len'] == 0
    assert 'authorization' not in json.dumps(log).lower() and 'vapid' not in json.dumps(log)                          # the JWT is never kept


def test_any_other_host_is_a_plain_tunnel_and_ca_pem_keeps_the_system_roots(service):
    import socket
    port, directory = service
    echo = socket.socket()
    echo.bind(('127.0.0.1', 0))
    echo.listen(1)

    def serve_once():
        conn, _ = echo.accept()
        conn.sendall(b'hello ' + conn.recv(16))
        conn.close()
    threading.Thread(target=serve_once, daemon=True).start()
    client = socket.create_connection(('127.0.0.1', port), timeout=10)
    client.sendall(f'CONNECT 127.0.0.1:{echo.getsockname()[1]} HTTP/1.1\r\nHost: x\r\n\r\n'.encode())
    assert b'200' in client.recv(200).split(b'\r\n')[0]
    client.sendall(b'tunnel')
    assert client.recv(64) == b'hello tunnel'                                                                       # bytes went through untouched
    client.close()
    echo.close()
    bundle = (directory / 'ca.pem').read_bytes()
    assert bundle.count(b'BEGIN CERTIFICATE') > 5 and (directory / 'ca-only.pem').read_bytes() in bundle              # the system roots AND the test CA
