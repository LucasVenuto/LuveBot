"""Contract v0.8 section 6: Web Push WITHOUT payload. The push message carries nothing: it wakes the installed app's service
worker, which fetches "<Bot> precisa de você" from LuveBot behind the dashboard's gate. So no content passes through the push
services and there is no payload encryption to write. VAPID (RFC 8292) with Hermes's own PyJWT and cryptography: no new
dependency. The private key lives in luvebot.db and never leaves the backend (invariant 1); requests go only to four push
services, by a fixed host list, without redirects (no SSRF); sending is best effort on a worker thread and never delays the event."""
import base64
import concurrent.futures
import hashlib
import json
import logging
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from . import dbfile, hermes_boundary
from .api_errors import PluginError

HOSTS = ('fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com')
WINDOWS = '.notify.windows.com'
KINDS = ('approval', 'budget', 'question')   # `question`: a Bot waits for a person outside the browser (contract v0.11 7.6); a device's stored list is explicit, so an existing device does not get it until it saves its kinds
RESERVED_ENDINGS = ('.local', '.localhost', '.test', '.invalid', '.example', '.internal', '.lan', '.localdomain', '.home.arpa')   # names no push service can reach: a contact on one is not a contact (7.1, A-189)
TABLE_MAX = 64   # the per-host tables keep this many entries (the host of a Windows endpoint is a person's choice): the oldest goes
REASONS = ('bad_jwt', 'key_mismatch', 'expired', 'too_large', 'rate_limited', 'timeout', 'other')   # the closed list of why a push failed (7.2); a body is read to BODY_MAX and never kept
BODY_MAX = 256
GONE = (404, 410)
LOG_KEEP = 50
KEYED_KEEP = 500        # the events that carry a key are the memory of "did I say it?": they outlive the 50 latest events while they are younger than KEYED_SECONDS, at most this many (the newest)
KEYED_SECONDS = 3600
RECENT_SECONDS = 24 * 3600
LOG_EVERY = 60  # seconds: one log line per host per minute
TEST_EVERY = 10  # seconds between two test notifications of one person (429 `rate_limited`)
TEST_DEADLINE = 10  # seconds: the whole test call; a device that has not answered is `timeout`
MAX_PER_ACTOR = 10
LATEST = 5
TTL = 3600  # seconds a push may wait at the push service; `latest` shows nothing older, so a late wake never shows a stale alert
TIMEOUT = 5
JWT_HOURS = 12
JWT_REUSE_HOURS = 6  # a token is kept until fewer than this many hours remain: Apple limits how often a new one may be made
SCHEMA = """
CREATE TABLE IF NOT EXISTS push_key (id INTEGER PRIMARY KEY CHECK (id = 1), private_pem BLOB NOT NULL, public_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE,
 kinds TEXT NOT NULL, created_at REAL NOT NULL, key_id TEXT, last_at REAL, last_ok INTEGER, last_status INTEGER, last_reason TEXT);
CREATE TABLE IF NOT EXISTS push_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL, status INTEGER NOT NULL, reason TEXT);
CREATE TABLE IF NOT EXISTS push_tests (actor TEXT PRIMARY KEY, at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS push_events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, bot TEXT NOT NULL, created_at REAL NOT NULL, dedupe TEXT);
"""
LINKS = {'approval': '/approvals', 'budget': '/costs', 'question': '/activity'}


def stored_kinds(raw):
    """The ONE reader of a stored `kinds` value: the sender and /notifications/latest both ask it, so a device that turned a kind off
    neither gets the wake nor sees the event."""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return ()
    return tuple(k for k in value if k in KINDS) if isinstance(value, list) else ()


_TOKENS = {}  # (audience, subject, public key) -> (token, exp): the VAPID JWT is made once per push service, not once per send
_TOKENS_LOCK = threading.Lock()
_LOGGED = {}  # host -> when its last failure line was written: one line per host per minute, whichever Push sends
_LOGGED_LOCK = threading.Lock()


def _chosen(key):
    """A host a PERSON chooses: the Windows class (`<anything>.notify.windows.com`); the three fixed services are not. The key is the host (the log memory) or a tuple whose first item is the audience `https://<host>` (the tokens)."""
    host = key[0] if isinstance(key, tuple) else key
    return isinstance(host, str) and host.lower().removeprefix('https://').endswith(WINDOWS)


def _put(table, key, value):
    """A bounded per-host memory: the key moves to the end, and past TABLE_MAX one entry goes: the oldest host a PERSON chose, and only when there is none the oldest of all. A real service is never pushed out by hosts
    someone made up (each host has its own audience, so its token would be made again, and its refusal would be logged on every event instead of once a minute)."""
    table.pop(key, None)
    table[key] = value
    while len(table) > TABLE_MAX:
        victim = next((k for k in table if _chosen(k)), None)
        del table[victim if victim is not None else next(iter(table))]


def capable():
    """Can this install send a push at all: Hermes's own PyJWT and cryptography are importable (an older Hermes without them is `unavailable`, said by
    /health `features.notifications` and a 409 on /notifications/config, never a 503 from a missing import)."""
    try:
        import jwt  # noqa: F401
        from cryptography.hazmat.primitives import serialization  # noqa: F401
        from cryptography.hazmat.primitives.asymmetric import ec  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def _host_ok(host):
    """The ONE host rule of a contact, for an https URL and for the domain of a mailto (7.1, A-189): dotted labels of letters, digits and hyphens whose LAST label starts with a letter (so never `localhost`, which has no
    dot, and never an IP in any form the URL standard reads as one: `127.0.0.1`, `127.1`, `0x7f.0x1`; an IPv6 has colons) and does not end in a reserved name. Apple answers 403 BadJwtToken for a `sub` it cannot take."""
    host = (host or '').lower().rstrip('.')
    labels = host.split('.')
    return len(labels) > 1 and all(re.fullmatch(r'[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?', label) for label in labels) and labels[-1][0].isalpha() and not ('.' + host).endswith(RESERVED_ENDINGS)


def valid_subject(value):
    """The VAPID `sub` LuveBot may send with (RFC 8292: a contact URI; contract v0.11 7.1): `https://<host>[:<port>][...]` or `mailto:<name>@<domain>`, the host or domain by `_host_ok` and a port, when there is
    one, from 1 to 65535. Anything else is "not set": LuveBot does not send with a contact it made up."""
    if not isinstance(value, str) or not value or len(value) > 200 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        return False
    if value.startswith('mailto:'):
        name, _at, host = value[len('mailto:'):].partition('@')
        return re.fullmatch(r'[A-Za-z0-9._%+-]{1,64}', name) is not None and _host_ok(host)
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port                                  # a ValueError for a port that is not one
        return url.scheme == 'https' and not url.username and not url.password and _host_ok(url.hostname) and (port is None or 1 <= port <= 65535)
    except ValueError:   # `https://[::1`, `https://luve.app:abc` and the like
        return False


def subject_claim(value):
    """The `sub` of the JWT for a contact LuveBot may use (None for one it may not): the ORIGIN of an https URL (`https://host[:port]`: its path and query are nobody's business at Apple, Google or Mozilla), a mailto as it is."""
    if not valid_subject(value):
        return None
    if value.startswith('mailto:'):
        return value
    url = urllib.parse.urlsplit(value)
    return f'https://{url.hostname}' + (f':{url.port}' if url.port not in (None, 443) else '')     # built from the PARSED host and port: an empty port and leading zeros are gone, the default 443 falls


def reason_of(status, text='', error=None):
    """Why a push that did not succeed failed, from the closed list REASONS. `text` is the start of the service's answer (read, classified, never kept); `error` the exception when it never answered."""
    text = (text or '').lower()
    if status == 0:
        return 'timeout' if isinstance(error, TimeoutError) or 'timed out' in str(error).lower() or isinstance(getattr(error, 'reason', None), TimeoutError) else 'other'
    if status == 413 or 'toolarge' in text.replace(' ', ''):   # `PayloadTooLarge`, `payload too large`
        return 'too_large'
    if status == 429:
        return 'rate_limited'
    if status == 410 or 'expired' in text:     # 410 Gone: the subscription expired or was undone
        return 'expired'
    if status in (400, 401, 403) and 'jwt' in text:
        return 'bad_jwt'
    if status in (401, 403):
        return 'key_mismatch'
    return 'other'


def closed(status, reason):
    """The `reason` that may be kept and shown for a delivery: None for a 2xx, else one of REASONS (a sender's own word, or none, becomes the class of the status)."""
    return None if 200 <= status < 300 else reason if reason in REASONS else reason_of(status)


def key_id_of(public_key):
    """The first 16 hex digits of the sha256 of a VAPID public key (base64url, as the browser holds it): what is kept with a device to tell, later, which key it subscribed with. None for anything that is
    not base64url of at most 100 bytes."""
    if not isinstance(public_key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,140}={0,2}', public_key):
        return None
    try:
        raw = base64.urlsafe_b64decode(public_key.rstrip('=') + '=' * (-len(public_key.rstrip('=')) % 4))
    except ValueError:                                    # binascii.Error: a length that is 1 more than a multiple of 4 cannot be base64
        return None
    return hashlib.sha256(raw).hexdigest()[:16] if 1 <= len(raw) <= 100 else None


def host_of(endpoint):
    """The push service's host (one of the four, so nothing secret: the endpoint's path is the capability to push to a device and never leaves the row)."""
    return (urllib.parse.urlsplit(endpoint).hostname or 'unknown').lower()


def endpoint_of(value):
    """The subscription endpoint, or 422: https, default port, no user info, and a host of one of the four push services."""
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 or ord(c) >= 127 for c in value):      # the stored string is EXACTLY the validated one: urlsplit drops a tab, CR and LF, so none may be there
        raise PluginError('invalid_field', 'Invalid value for endpoint.', 422)
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
    except ValueError:                                                                   # an unclosed IPv6, a port that is not one: a refusal, never an exception
        raise PluginError('invalid_field', 'Invalid value for endpoint.', 422) from None
    host = (url.hostname or '').lower()
    allowed = host in HOSTS or (host.endswith(WINDOWS) and host[:-len(WINDOWS)].replace('-', '').replace('.', '').isalnum())
    if url.scheme != 'https' or url.username or url.password or port not in (None, 443) or not allowed or url.netloc.lower() != host:
        raise PluginError('invalid_field', 'This is not a supported push service.', 422)
    return value


def kinds_of(value):
    if value is None:
        return list(KINDS)
    if not isinstance(value, list) or not value or any(k not in KINDS for k in value):
        raise PluginError('invalid_field', 'Invalid value for kinds.', 422)
    return sorted(set(value))


def subscribe_body(body):
    """-> (endpoint, kinds, key_id | None). The browser's `keys` are ignored (no payload is ever sent); `application_server_key` (base64url of `PushSubscription.options.applicationServerKey`) is the key it
    subscribed with: only its `key_id` is kept, 422 for a value that is not base64url of a plausible key."""
    if not isinstance(body, dict) or 'endpoint' not in body or set(body) - {'endpoint', 'kinds', 'keys', 'expirationTime', 'application_server_key'}:
        raise PluginError('bad_request', 'Malformed request body.', 400)
    key_id = None
    if body.get('application_server_key') is not None:
        key_id = key_id_of(body['application_server_key'])
        if key_id is None:
            raise PluginError('invalid_field', 'Invalid value for application_server_key.', 422)
    return endpoint_of(body['endpoint']), kinds_of(body.get('kinds')), key_id


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


class Status(int):
    """An HTTP status that may carry a `reason` from REASONS: still an `int`, so a sender that returns a plain number works too."""
    reason = None


def _status(code, reason=None):
    status = Status(code)
    status.reason = reason
    return status


def http_post(url, headers):
    """The one outbound request: an empty POST, 5 s, no redirect followed. -> HTTP status (0 when it never answered), with its `reason` from the closed list REASONS when it failed. The answer's body
    is read to BODY_MAX only to classify it, and is neither kept nor logged."""
    request = urllib.request.Request(url, data=b'', method='POST', headers=headers)
    try:
        with _OPENER.open(request, timeout=TIMEOUT) as response:
            return _status(response.status)
    except urllib.error.HTTPError as error:
        try:
            text = error.read(BODY_MAX).decode('utf-8', 'replace')
        except Exception:  # noqa: BLE001
            text = ''
        return _status(error.code, reason_of(error.code, text))
    except Exception as error:  # noqa: BLE001
        return _status(0, reason_of(0, '', error))


class _Refused(Exception):
    """A delivery the push service did not take: raised inside the audit act so the row says `error`."""


class Push:
    def __init__(self, path, *, subject=None, source=None, sender=http_post, clock=time.time):
        """`subject`: the VAPID `sub` the operator chose (`LUVEBOT_PUSH_SUBJECT`, source `setting`, or the dashboard's public https URL, source `public_url`; contract v0.11 7.1). One that is not
        well formed (`valid_subject`) is NOT SET: no push is sent with a contact LuveBot made up."""
        self.path, self.sender, self.clock = path, sender, clock
        self.subject = subject_claim(subject)
        self.source = source if self.subject is not None or source == 'setting' else None     # a malformed explicit setting still says it is the setting (`ok: false`), and is not replaced by another contact
        self._logged = {}   # host -> when its last log line was written (one per host per minute)
        conn = self._connect()
        try:
            conn.executescript(SCHEMA)
            have = {r['name'] for r in conn.execute('PRAGMA table_info(push_subscriptions)')}
            for column, kind in (('key_id', 'TEXT'), ('last_at', 'REAL'), ('last_ok', 'INTEGER'), ('last_status', 'INTEGER'), ('last_reason', 'TEXT')):   # a database from before the key and the last outcome
                if column not in have:
                    conn.execute(f'ALTER TABLE push_subscriptions ADD COLUMN {column} {kind}')
            if 'dedupe' not in {r['name'] for r in conn.execute('PRAGMA table_info(push_events)')}:  # a database from before the key
                conn.execute('ALTER TABLE push_events ADD COLUMN dedupe TEXT')
            conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS push_events_dedupe ON push_events (dedupe) WHERE dedupe IS NOT NULL')
            conn.commit()
        finally:
            conn.close()

    def _connect(self):
        conn = dbfile.connect(self.path, timeout=5)  # ADR-008 section 4.2: every store opens through dbfile (busy timeout and journal_size_limit)
        conn.row_factory = sqlite3.Row
        return conn

    def _key(self):
        """(private PEM, public key b64url), made on first use (P-256, uncompressed point) and kept in luvebot.db."""
        conn = self._connect()
        try:
            row = conn.execute('SELECT private_pem, public_key FROM push_key WHERE id=1').fetchone()
            if row is None:
                from cryptography.hazmat.primitives import serialization
                from cryptography.hazmat.primitives.asymmetric import ec
                key = ec.generate_private_key(ec.SECP256R1())
                pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
                public = _b64(key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
                conn.execute('INSERT OR IGNORE INTO push_key (id, private_pem, public_key) VALUES (1, ?, ?)', (pem, public))
                conn.commit()
                row = conn.execute('SELECT private_pem, public_key FROM push_key WHERE id=1').fetchone()
            return bytes(row['private_pem']), row['public_key']
        finally:
            conn.close()

    def config(self):
        """The public key, the kinds, and whether a contact is set: `subject: {ok, source}`, never the value (it may hold a person's address)."""
        return {'public_key': self._key()[1], 'enabled_kinds': list(KINDS), 'subject': {'ok': self.subject is not None, 'source': self.source}}

    def subscribe(self, audit, actor, endpoint, kinds, ref, key_id=None):
        """One row per device endpoint (a second subscribe of the same device updates it, and moves it to this person). `key_id` is that of the VAPID key the browser says it subscribed with: when it is not
        the current key the device would never get a push, so it is `409 key_mismatch` (renew on that device); without one (an older screen) the device is kept and listed as `stale`."""
        host = urllib.parse.urlsplit(endpoint).hostname
        owner = self._owner(endpoint)
        if key_id is not None and key_id != key_id_of(self._key()[1]):
            raise PluginError('key_mismatch', 'This device subscribed with another notification key: turn notifications off and on again on it.', 409)

        def effect():
            conn = self._connect()
            try:
                conn.execute('BEGIN IMMEDIATE')
                mine = conn.execute('SELECT COUNT(*) FROM push_subscriptions WHERE actor=? AND endpoint<>?', (actor, endpoint)).fetchone()[0]
                if mine >= MAX_PER_ACTOR:
                    raise PluginError('too_many_devices', 'At most 10 devices per person receive notifications.', 409)
                previous = conn.execute('SELECT actor FROM push_subscriptions WHERE endpoint=?', (endpoint,)).fetchone()
                conn.execute('INSERT INTO push_subscriptions (actor, endpoint, kinds, created_at, key_id) VALUES (?,?,?,?,?) '
                             'ON CONFLICT(endpoint) DO UPDATE SET actor=excluded.actor, kinds=excluded.kinds, key_id=COALESCE(excluded.key_id, push_subscriptions.key_id)', (actor, endpoint, json.dumps(kinds), self.clock(), key_id))
                sid = conn.execute('SELECT id FROM push_subscriptions WHERE endpoint=?', (endpoint,)).fetchone()[0]
                conn.commit()
                return sid, previous is not None and previous[0] != actor
            finally:
                conn.close()

        # a move gets its own audit action: the payload is only hashed, so a flag in it would be unreadable
        action = 'notifications.move' if owner not in (None, actor) else 'notifications.subscribe'
        sid, moved = audit.act(actor, action, host, {'kind': 'ui', 'ref': ref}, effect, payload={'host': host, 'kinds': kinds})
        return {'id': sid, 'kinds': kinds, **({'moved': True} if moved else {})}

    def _owner(self, endpoint):
        conn = self._connect()
        try:
            row = conn.execute('SELECT actor FROM push_subscriptions WHERE endpoint=?', (endpoint,)).fetchone()
            return row[0] if row else None
        finally:
            conn.close()

    def unsubscribe(self, audit, actor, sid, ref):
        def effect():
            conn = self._connect()
            try:
                gone = conn.execute('DELETE FROM push_subscriptions WHERE id=? AND actor=?', (sid, actor)).rowcount
                conn.commit()
            finally:
                conn.close()
            if not gone:
                raise PluginError('subscription_not_found', 'This device is not subscribed.', 404)
        audit.act(actor, 'notifications.unsubscribe', str(sid), {'kind': 'ui', 'ref': ref}, effect)
        return {'removed': 1}

    def mine(self, actor):
        """The person's devices: id, host (never the endpoint), kinds, when, `stale` (subscribed without a key, or with a key that is not the current one: it will be refused) and `last`, the last push
        to it as `{at, ok, status, reason}` (None until one was sent; `reason` from the closed list REASONS)."""
        current = key_id_of(self._key()[1])
        conn = self._connect()
        try:
            return [{'id': r['id'], 'host': host_of(r['endpoint']), 'kinds': list(stored_kinds(r['kinds'])), 'created_at': r['created_at'], 'stale': r['key_id'] != current,
                     'last': {'at': r['last_at'], 'ok': bool(r['last_ok']), 'status': r['last_status'], 'reason': r['last_reason']} if r['last_at'] is not None else None}
                    for r in conn.execute('SELECT * FROM push_subscriptions WHERE actor=? ORDER BY id', (actor,))]
        finally:
            conn.close()

    def latest(self, actor, sub=None):
        """What the service worker shows: kind, Bot, time and where to go. Never an action, a command or any content.
        The events are the team's, so: the last 5 of the kinds THIS person subscribed to (the union of their devices, or only device
        `sub` when it is theirs), filtered first and then cut, and only the ones younger than the push TTL. No subscription: nothing."""
        conn = self._connect()
        try:
            rows = conn.execute('SELECT id, kinds FROM push_subscriptions WHERE actor=?', (actor,)).fetchall()
            wanted = [r for r in rows if r['id'] == sub] or rows
            kinds = sorted({k for r in wanted for k in stored_kinds(r['kinds'])})
            if not kinds:
                return []
            marks = ','.join('?' * len(kinds))
            return [{'kind': r['kind'], 'bot': r['bot'], 'at': r['created_at'], 'link': LINKS[r['kind']]}
                    for r in conn.execute(f'SELECT kind, bot, created_at FROM push_events WHERE kind IN ({marks}) AND created_at >= ? '
                                          'ORDER BY id DESC LIMIT ?', (*kinds, self.clock() - TTL, LATEST))]
        finally:
            conn.close()

    def _notified(self, key):
        conn = self._connect()
        try:
            return conn.execute('SELECT 1 FROM push_events WHERE dedupe=?', (key,)).fetchone() is not None
        finally:
            conn.close()

    def notify(self, audit, kind, bot, key=None):
        """Record the event and wake every device that wants this kind, on a worker thread. Never raises, never waits.
        `key` (e.g. `pause:<bot>:<since>`) makes the event ONCE across every process that shares luvebot.db: a second caller with the same key records no event and wakes nobody; one that looks
        BEFORE any insert (two watchers at the same instant) may leave its audit intent row all the same, because its own insert is then ignored. -> the sending thread (or None), for tests."""
        try:
            if key is not None and self._notified(key):
                return None

            committed = {}   # `targets` once the event row is COMMITTED: from there the wake goes out whatever becomes of the audit's own RESULT row (N-3c)

            def effect():
                conn = self._connect()
                try:
                    if conn.execute('INSERT OR IGNORE INTO push_events (kind, bot, created_at, dedupe) VALUES (?,?,?,?)', (kind, bot, self.clock(), key)).rowcount == 0:
                        return []  # the other watcher recorded this very event between the look and here
                    conn.execute('DELETE FROM push_events WHERE id NOT IN (SELECT id FROM push_events ORDER BY id DESC LIMIT 50) '
                                 'AND id NOT IN (SELECT id FROM push_events WHERE dedupe IS NOT NULL AND created_at >= ? ORDER BY id DESC LIMIT ?)',
                                 (self.clock() - KEYED_SECONDS, KEYED_KEEP))     # 50 approvals must not make the same wait or pause be said again (F-N6-8)
                    found = [dict(r) for r in conn.execute('SELECT id, endpoint, kinds FROM push_subscriptions')
                             if kind in stored_kinds(r['kinds'])]
                    conn.commit()
                    committed['targets'] = found
                    return found
                finally:
                    conn.close()
            try:
                targets = audit.act('system', 'notifications.push', bot, {'kind': 'system'}, effect, bot=bot, payload={'kind': kind})
            except Exception as error:  # noqa: BLE001
                if 'targets' not in committed:
                    raise                                          # the effect itself failed (no event row): nothing is sent, and a wait with a key is tried again on the next tick
                logging.getLogger('luvebot.push').warning('notify: the audit result was not written: %s', type(error).__name__)   # the class only
                targets = committed['targets']                     # the event row IS there (its key says "said"): the wake goes out all the same
            if not targets:
                return None
            thread = threading.Thread(target=hermes_boundary.thread_target(self._send_all), args=(audit, targets, kind), daemon=True, name='luvebot-push')
            thread.start()
            return thread
        except Exception as error:  # noqa: BLE001
            logging.getLogger('luvebot.push').warning('notify failed: %s', type(error).__name__)   # the event is never delayed or broken by it, but it is not silent
            return None

    def _token(self, jwt, pem, public, audience):
        now = int(self.clock())
        key = (audience, self.subject, public)
        with _TOKENS_LOCK:
            token, exp = _TOKENS.get(key, (None, 0))
            if token is None or exp - now < JWT_REUSE_HOURS * 3600:
                exp = now + JWT_HOURS * 3600
                token = jwt.encode({'aud': audience, 'exp': exp, 'sub': self.subject}, pem, algorithm='ES256')
                _put(_TOKENS, key, (token, exp))
        return token

    def _post(self, jwt, pem, public, target, kind):
        """One wake to one device -> (status, the sender's reason or None). Never raises: a token that cannot be made, a sender that fails, anything: status 0 and the class of the error."""
        try:
            url = urllib.parse.urlsplit(target['endpoint'])
            token = self._token(jwt, pem, public, f'{url.scheme}://{url.netloc.lower()}')   # a host is case-insensitive and an origin is lowercase: `aud`, the token key and the class come from the lowercase netloc (A-200)
            raw = self.sender(target['endpoint'], {'TTL': str(TTL), 'Urgency': 'high', 'Content-Length': '0',
                                                   'Topic': kind,  # RFC 8030: a wake still waiting is replaced by the next of its kind (a burst of approvals is ONE wake)
                                                   'Authorization': f'vapid t={token}, k={public}'})
            return int(raw), getattr(raw, 'reason', None)
        except Exception as error:  # noqa: BLE001
            return 0, reason_of(0, '', error)

    def _record(self, audit, actor, origin, kind, target, status, reason):
        """What became of one delivery, where somebody can see it, and never an endpoint or a token: the device's own last outcome (`last_*`, what the device list shows), a row of `push_log` (the last 50,
        what /health counts), an audit row `notifications.deliver` whose target is `<host>:<status>` (the row says `error` for anything but a 2xx) and, for a failure, ONE log line per host per minute
        (host, status, reason). -> the reason kept (None for a 2xx). It never raises and never stops the next device."""
        host = host_of(target['endpoint'])
        now = self.clock()
        reason = closed(status, reason)
        try:
            conn = self._connect()
            try:
                conn.execute('UPDATE push_subscriptions SET last_at=?, last_ok=?, last_status=?, last_reason=? WHERE id=?', (now, int(reason is None), status, reason, target['id']))
                conn.execute('INSERT INTO push_log (at, kind, host, status, reason) VALUES (?,?,?,?,?)', (now, kind, host, status, reason))
                conn.execute('DELETE FROM push_log WHERE id NOT IN (SELECT id FROM push_log ORDER BY id DESC LIMIT ?)', (LOG_KEEP,))
                conn.commit()
            finally:
                conn.close()
        except Exception as error:  # noqa: BLE001
            logging.getLogger('luvebot.push').warning('push outcome not written: %s', type(error).__name__)
        if reason is not None:
            with _LOGGED_LOCK:
                due = now - _LOGGED.get(host, -LOG_EVERY) >= LOG_EVERY
                if due:
                    _put(_LOGGED, host, now)
            if due:
                logging.getLogger('luvebot.push').warning('push refused by %s: status %s, reason %s', host, status, reason)

        def effect():
            raise _Refused()
        if reason is not None and kind != 'test':      # the audit holds a REFUSAL, not a success (`last_*` and `push_log` say it) and nothing per device for a test: its one `notifications.test` row carries the count (A-189)
            try:
                audit.act(actor, 'notifications.deliver', f'{host}:{status}', origin, effect, payload={'kind': kind, 'status': status, 'reason': reason})
            except Exception:  # noqa: BLE001
                pass  # the refusal IS what the row records; an audit that cannot be written must not stop the other devices
        return reason

    def _forget(self, sid):
        conn = self._connect()
        try:
            conn.execute('DELETE FROM push_subscriptions WHERE id=?', (sid,))
            conn.commit()
        finally:
            conn.close()

    def _send_all(self, audit, targets, kind):
        if self.subject is None:   # no contact the services accept: nothing is sent, and /health and the settings say why (7.1)
            self._no_contact_line()
            return
        try:
            import jwt
            pem, public = self._key()
        except Exception as error:  # noqa: BLE001
            logging.getLogger('luvebot.push').warning('push not sent: %s', type(error).__name__)
            return
        for target in targets:
            status, reason = self._post(jwt, pem, public, target, kind)
            self._record(audit, 'system', {'kind': 'system'}, kind, target, status, reason)
            if status in GONE:  # the device unsubscribed: forget it
                self._forget(target['id'])

    def _no_contact_line(self):
        with _LOGGED_LOCK:
            now = self.clock()
            due = now - _LOGGED.get('', -LOG_EVERY) >= LOG_EVERY
            if due:
                _put(_LOGGED, '', now)
        if due:
            logging.getLogger('luvebot.push').warning('push not sent: no contact is set (set LUVEBOT_PUSH_SUBJECT or an https dashboard.public_url)')

    def test(self, audit, actor, ref):
        """A test wake to THIS person's own devices (never anyone else's), at most one every TEST_EVERY seconds -> {devices: [{id, host, ok, status, reason}]}, one per device in the order of `mine`.
        409 `needs_subject` without a contact (nothing is sent), no device: an empty list (and the 10 seconds are not spent), 429 `rate_limited` inside the window. The sends go side by side and the whole
        call waits TEST_DEADLINE seconds at most: a device that has not answered is `{ok: false, status: 0, reason: 'timeout'}`. The wake is the real one (`Topic: test`) and records no event, so the worker
        shows its generic text. The deliveries leave the same rows as a real wake (sharing this call's `ref`); a device the service says is gone is forgotten here too."""
        if self.subject is None:
            raise PluginError('needs_subject', 'Set a contact for the notifications first (the dashboard public address, or LUVEBOT_PUSH_SUBJECT).', 409)
        import jwt
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            now = self.clock()                       # INSIDE the write lock: whoever holds it is the latest writer (a clock read before it let a second request through, F-N6-3)
            devices = [dict(r) for r in conn.execute('SELECT id, endpoint FROM push_subscriptions WHERE actor=? ORDER BY id', (actor,))]
            if not devices:
                conn.rollback()
                return {'devices': []}
            last = conn.execute('SELECT at FROM push_tests WHERE actor=?', (actor,)).fetchone()
            if last is not None and 0 <= now - last['at'] < TEST_EVERY:      # a clock that went BACK is not inside the window (it is read inside the lock: there is no race left for a negative difference to stop)
                raise PluginError('rate_limited', 'Wait a few seconds before sending another test.', 429)
            conn.execute('INSERT INTO push_tests (actor, at) VALUES (?, ?) ON CONFLICT(actor) DO UPDATE SET at=excluded.at', (actor, now))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
        pem, public = self._key()
        origin = {'kind': 'ui', 'ref': ref}

        def effect():
            pool = concurrent.futures.ThreadPoolExecutor(max_workers=len(devices))
            futures = [pool.submit(self._post, jwt, pem, public, target, 'test') for target in devices]
            concurrent.futures.wait(futures, timeout=TEST_DEADLINE)
            pool.shutdown(wait=False, cancel_futures=True)   # a sender that hangs is left behind: the person gets their answer
            answers = [f.result() if f.done() and f.exception() is None else (0, 'timeout') for f in futures]
            results = []
            for target, (status, reason) in zip(devices, answers):
                kept = self._record(audit, actor, origin, 'test', target, status, reason)
                if status in GONE:
                    self._forget(target['id'])
                results.append({'id': target['id'], 'host': host_of(target['endpoint']), 'ok': kept is None, 'status': status, 'reason': kept})
            return results
        return {'devices': audit.act(actor, 'notifications.test', f'devices:{len(devices)}', origin, effect, payload={'devices': len(devices)})}

    def status(self):
        """What /health says about the notifications, without a secret or an endpoint: whether a contact is set and where it came from, how many devices, how many are `stale` (a key that is not the
        current one) and how many were REFUSED the last time (a later success, a new subscription or the removal of the device clears it), the last delivery and the last day's count."""
        current = key_id_of(self._key()[1])
        conn = self._connect()
        try:
            devices = conn.execute('SELECT COUNT(*) FROM push_subscriptions').fetchone()[0]
            stale = conn.execute('SELECT COUNT(*) FROM push_subscriptions WHERE key_id IS NOT ?', (current,)).fetchone()[0]
            failing = conn.execute('SELECT COUNT(*), (SELECT last_reason FROM push_subscriptions WHERE last_ok=0 ORDER BY last_at DESC LIMIT 1) FROM push_subscriptions WHERE last_ok=0').fetchone()
            last = conn.execute('SELECT at, kind, host, status, reason FROM push_log ORDER BY id DESC LIMIT 1').fetchone()
            since = self.clock() - RECENT_SECONDS
            ok, failed = conn.execute('SELECT COALESCE(SUM(status BETWEEN 200 AND 299), 0), COALESCE(SUM(NOT (status BETWEEN 200 AND 299)), 0) FROM push_log WHERE at >= ?', (since,)).fetchone()
        finally:
            conn.close()
        return {'subject': {'ok': self.subject is not None, 'source': self.source}, 'devices': devices, 'stale': stale, 'failing': {'devices': failing[0], 'reason': failing[1]} if failing[0] else None,
                'last': dict(last) if last else None, 'recent': {'hours': RECENT_SECONDS // 3600, 'ok': ok, 'failed': failed}}


def problem_of(status):
    """The `/health` problem when the push services refused the LAST wake to some devices, or None: `devices` how many, `reason` the closed word of the most recent refusal. It goes when the next wake to
    those devices works or they are removed. Never an endpoint."""
    failing = (status or {}).get('failing')
    if not failing:
        return None
    n = failing['devices']
    return {'code': 'push_delivery_failed', 'feature': 'notifications', 'devices': n, 'reason': failing['reason'],
            'message': f"The last notification could not reach {n} device{'s' if n != 1 else ''} ({failing['reason']}). Send a test from Settings, then renew notifications on that device if it says so."}
