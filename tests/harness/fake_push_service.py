"""A push service for the harness (N-5, contract v0.11 section 7): the thing that stands where Apple's, Google's and Mozilla's web push services stand, so LuveBot's REAL sender (`backend/push.py`, `http_post`) can be proven
end to end with no change to production code and no opening in it.

How it is reached: LuveBot's opener is `urllib.request.build_opener(...)`, which honors `HTTPS_PROXY` and `SSL_CERT_FILE` from the environment of the process that imports it. So the stack under test is started with
    HTTPS_PROXY=http://127.0.0.1:<port> SSL_CERT_FILE=<dir>/ca.pem NO_PROXY=127.0.0.1,localhost
and this process is that proxy: it accepts `CONNECT <host>:443` for the three push hosts and answers the TLS handshake itself with a certificate of its own CA (`ca.pem`, written on start), then judges the one HTTP request that
comes through. Any other host is tunneled to the real server untouched (`HTTPS_PROXY` applies to EVERY https call of those processes: the harness's own setup and Hermes asking a provider too), and `ca.pem` is the test CA
PLUS the system's roots, so those calls still verify what they verify without the proxy (`SSL_CERT_FILE` replaces the default store).

What it judges, like the real services do (RFC 8292, RFC 8030):
  * `Authorization: vapid t=<jwt>, k=<public key>`: the JWT must be ES256, signed by the key `k`, with `aud` = the origin the request went to and an `exp` at most 24 h ahead, and a `sub` that is a contact the services
    accept (an `https://` URL whose host has a dot and is neither `localhost` nor an IP, or a `mailto:` whose domain has a dot and is not `localhost`, `.local`, `.test`, `.invalid` or `.example`); anything else is
    `403 {"reason": "BadJwtToken"}`, the answer Apple gave the CEO's phone for `mailto:luvebot@localhost`;
  * `TTL` is a number, `Content-Length` is 0 and there is no body (LuveBot pushes empty wakes) => `201`;
  * the FIRST segment of the endpoint path picks a device's fate on purpose (so one run shows every outcome): `/badjwt/..` 403 with `BadJwtToken`, `/mismatch/..` 403 with no body (a device subscribed with another key),
    `/gone/..` 410, `/limited/..` 429, `/big/..` 413, `/slow/..` answers after 8 s (LuveBot gives up at 5), anything else is judged as above.
It records, per request, the host, the path, the status and what the request said (`sub`, `aud`, `TTL`, `Urgency`, `Topic`, the body length): never the JWT. `GET /_log` returns the list, `POST /_reset` empties it (plain HTTP,
straight to the port, not through the proxy).

    python fake_push_service.py <dir> <port>        writes <dir>/ca.pem (and the certificate) and serves until killed; prints `ready` once it listens."""
import base64
import datetime
import http.server
import ipaddress
import json
import re
import select
import socket
import ssl
import sys
import threading
import time
from pathlib import Path

HOSTS = ('web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com')
BAD = (b'{"reason":"BadJwtToken"}')
BAD_TLDS = ('.local', '.test', '.invalid', '.example')
SLOW_SECONDS = 8
LOG = []
LOCK = threading.Lock()


def system_roots():
    """The PEM of the roots this machine trusts (certifi's when it is importable, else the platform's own file), so a tunnel to a real host still verifies. Empty when none is found."""
    candidates = []
    try:
        import certifi
        candidates.append(certifi.where())
    except ImportError:
        pass
    candidates += [ssl.get_default_verify_paths().cafile or '', '/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt']
    for path in candidates:
        if path and Path(path).is_file():
            return Path(path).read_bytes().rstrip(b'\n') + b'\n'
    return b''


def relay(a, b):
    """Copy bytes both ways until either side closes (a tunnel that looks at nothing)."""
    while True:
        ready, _, _ = select.select([a, b], [], [], 60)
        if not ready:
            return
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (b if source is a else a).sendall(data)


def make_ca(directory):
    """The test CA and a certificate for the three hosts, written into `directory`: `ca.pem` (what SSL_CERT_FILE names), `server.pem` (certificate, then CA) and `server.key`."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc)

    def name(common):
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])
    ca_key, key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca = (x509.CertificateBuilder().subject_name(name('LuveBot harness push CA')).issuer_name(name('LuveBot harness push CA')).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=2))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False,
                                       encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False).sign(ca_key, hashes.SHA256()))
    # Python 3.13+ verifies in strict mode: the leaf must carry the Authority Key Identifier of its CA, and the usual key usages
    leaf = (x509.CertificateBuilder().subject_name(name(HOSTS[0])).issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(host) for host in HOSTS]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=False, crl_sign=False, content_commitment=False, key_encipherment=False, data_encipherment=False, key_agreement=False,
                                         encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False).sign(ca_key, hashes.SHA256()))
    pem = serialization.Encoding.PEM
    (directory / 'ca-only.pem').write_bytes(ca.public_bytes(pem))
    (directory / 'ca.pem').write_bytes(system_roots() + ca.public_bytes(pem))       # what SSL_CERT_FILE names: the test CA added to the roots the system trusts
    (directory / 'server.pem').write_bytes(leaf.public_bytes(pem) + ca.public_bytes(pem))
    (directory / 'server.key').write_bytes(key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (directory / 'server.key').chmod(0o600)


def good_subject(sub):
    """A contact the push services accept (contract v0.11 7.1): the rule LuveBot applies too, here as the SERVICE's own check."""
    if not isinstance(sub, str):
        return False
    if sub.startswith('https://'):
        host = sub[len('https://'):].split('/', 1)[0].split(':', 1)[0].lower()
        try:
            ipaddress.ip_address(host.strip('[]'))
            return False
        except ValueError:
            pass
        return '.' in host and host != 'localhost' and not host.endswith('.localhost')
    if sub.startswith('mailto:') and '@' in sub:
        domain = sub.rsplit('@', 1)[1].lower()
        return '.' in domain and domain != 'localhost' and not domain.endswith(BAD_TLDS)
    return False


def read_claims(host, headers):
    """The JWT's claims when it is a valid VAPID token for THIS service (ES256, signed by the key `k`, `aud` this origin, an `exp`), else None."""
    found = re.fullmatch(r'vapid t=([A-Za-z0-9_\-.]+), k=([A-Za-z0-9_\-]+)', headers.get('authorization', ''))
    if not found:
        return None
    try:
        import jwt
        from cryptography.hazmat.primitives.asymmetric import ec
        point = base64.urlsafe_b64decode(found.group(2) + '=' * (-len(found.group(2)) % 4))
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
        return jwt.decode(found.group(1), key, algorithms=['ES256'], audience=f'https://{host}', options={'require': ['exp', 'aud']})
    except Exception:  # noqa: BLE001  (a bad signature, a wrong audience, an expired or malformed token: all the same answer)
        return None


def judge(host, path, headers, body):
    """-> (status, body bytes, what to record). The token is ALWAYS read and what it said (`sub`, `aud`) recorded when it is valid, whatever fate the path gives the device. Pure: no socket, no clock but the JWT's own `exp`."""
    seen = {'host': host, 'path': path, 'ttl': headers.get('ttl'), 'urgency': headers.get('urgency'), 'topic': headers.get('topic'), 'body_len': len(body)}
    claims = read_claims(host, headers)
    if claims is not None:
        seen.update(sub=claims.get('sub'), aud=claims.get('aud'))
    mode = path.strip('/').split('/', 1)[0]
    if mode == 'badjwt':
        return 403, BAD, seen
    if mode == 'mismatch':
        return 403, b'', seen
    if mode == 'gone':
        return 410, b'{"reason":"Unregistered"}', seen
    if mode == 'limited':
        return 429, b'{"reason":"TooManyRequests"}', seen
    if mode == 'big':
        return 413, b'{"reason":"PayloadTooLarge"}', seen
    if mode == 'slow':
        time.sleep(SLOW_SECONDS)
    if claims is None or claims['exp'] - time.time() > 86400 or not good_subject(claims.get('sub')):
        return 403, BAD, seen
    if not str(headers.get('ttl', '')).isdigit() or headers.get('content-length') != '0' or body:
        return 400, b'{"reason":"BadRequest"}', seen
    return 201, b'', seen


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'HarnessPush/1'

    def log_message(self, *args):
        pass

    def _json(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/_log':
            with LOCK:
                return self._json(200, list(LOG))
        self._json(404, {'error': 'only /_log'})

    def do_POST(self):
        if self.path == '/_reset':
            with LOCK:
                LOG.clear()
            return self._json(200, {'ok': True})
        self._json(404, {'error': 'only /_reset'})

    def do_CONNECT(self):
        host, _, port = self.path.rpartition(':')
        host = host.lower()
        if host not in HOSTS:                                                     # not a push host: a plain tunnel to the real server, untouched
            self.close_connection = True
            try:
                upstream = socket.create_connection((host, int(port or 443)), timeout=15)
            except (OSError, ValueError):
                self.send_error(502, 'could not reach the host')
                return
            try:
                self.send_response(200, 'Connection Established')
                self.end_headers()
                relay(self.connection, upstream)
            except OSError:
                pass
            finally:
                upstream.close()
            return
        self.send_response(200, 'Connection Established')
        self.end_headers()
        self.close_connection = True
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.server.directory / 'server.pem', self.server.directory / 'server.key')
        try:
            tls = context.wrap_socket(self.connection, server_side=True)
            tls.settimeout(15)
            stream = tls.makefile('rb')
            line = stream.readline().decode('latin-1').split()
            headers = {}
            while True:
                row = stream.readline().decode('latin-1').strip()
                if not row:
                    break
                key, _, value = row.partition(':')
                headers[key.strip().lower()] = value.strip()
            body = stream.read(int(headers.get('content-length') or 0))
            path = line[1] if len(line) > 1 else '/'
            status, answer, seen = judge(host, path, headers, body)
            seen.update(status=status, at=time.time(), method=line[0] if line else '')
            with LOCK:
                LOG.append(seen)
            tls.sendall(f'HTTP/1.1 {status} X\r\nContent-Length: {len(answer)}\r\nConnection: close\r\n\r\n'.encode() + answer)
            tls.close()
        except (ssl.SSLError, OSError):
            pass


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, directory):
        super().__init__(address, Handler)
        self.directory = Path(directory)


def serve(directory, port):
    make_ca(directory)
    server = Server(('127.0.0.1', int(port)), directory)
    print('ready', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    serve(sys.argv[1], sys.argv[2])
