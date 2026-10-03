"""T10.1: ONE resolver of where a profile's API Server is (port + key), used by capabilities, REST and SSE alike.

Real Hermes in the harness: two real profiles with DIFFERENT ports and DIFFERENT keys in their own `.env`, and a real listener on
each port. `get_secret('API_SERVER_PORT')` returns the process value (the name is in agent/secret_scope.py `_GLOBAL_ENV_EXACT`,
L189), so a client built on it sends every Bot to the same port; the resolver reads the profile's scope first.
"""
import http.server
import json
from pathlib import Path
import threading
import uuid

import pytest

from support import credentials, plugin
from test_bots import post  # noqa: F401  (human_browser fixture lives in conftest)

ROOT_HOME = Path('/root/.hermes')
PORT_A, PORT_B = 18651, 18652
CAPS = {'object': 'hermes.api_server.capabilities', 'features': {}, 'endpoints': {}}


class Listener:
    """A stand-in for one profile's API Server: answers only the key it was given, records what reached it."""

    def __init__(self, port, key):
        self.port, self.key, self.seen = port, key, []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'  # like aiohttp: keep-alive, and an event stream is chunked

            def log_message(self, *args):
                pass

            def do_GET(self):
                outer.seen.append((self.path, self.headers.get('Authorization')))
                if self.headers.get('Authorization') != 'Bearer ' + outer.key:
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.path.endswith('/v1/capabilities'):
                    body, kind = json.dumps(CAPS).encode(), 'application/json'
                elif self.path.endswith('/events'):
                    body, kind = b'event: run.completed\ndata: {}\n\n', 'text/event-stream'
                else:
                    body, kind = json.dumps({'ok': True, 'port': outer.port}).encode(), 'application/json'
                self.send_response(200)
                self.send_header('Content-Type', kind)
                if kind == 'application/json':
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    self.wfile.write(b'%x\r\n' % len(body) + body + b'\r\n0\r\n\r\n')

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def clients():
    plugin()
    import luvebot_backend.hermes_api as api
    import luvebot_backend.hermes_client as client
    return client, api


@pytest.fixture
def two_bots(human_browser):
    """Two real profiles; each has its own key and its own port in ITS .env, and a listener on that port."""
    made, listeners = [], []
    try:
        for port in (PORT_A, PORT_B):
            name = 't101-' + uuid.uuid4().hex[:8]
            assert human_browser.request.post('http://127.0.0.1:9119/api/profiles', data={'name': name}).status == 200
            made.append(name)
            key = uuid.uuid4().hex + uuid.uuid4().hex
            env = ROOT_HOME / 'profiles' / name / '.env'
            env.write_text(f'API_SERVER_KEY={key}\nAPI_SERVER_PORT={port}\n')
            env.chmod(0o600)
            listeners.append((name, key, Listener(port, key)))
        yield listeners
    finally:
        for _, _, listener in listeners:
            listener.close()
        for name in made:
            human_browser.request.delete('http://127.0.0.1:9119/api/profiles/' + name)


def test_capabilities_rest_and_sse_go_to_the_port_and_key_of_their_own_profile(two_bots):
    client, api = clients()
    for name, key, listener in two_bots:
        assert client.HermesClient(name).capabilities()['object'] == 'hermes.api_server.capabilities'
        status, payload = api.ApiClient(name).call('GET', '/v1/runs/run_1')
        assert status == 200 and payload == {'ok': True, 'port': listener.port}
        status, stream = api.ApiClient(name).open_stream('GET', '/v1/runs/run_1/events')
        assert status == 200 and list(stream.lines(1024))[0] == 'event: run.completed'
        stream.abort()
        assert api.ApiClient(name)._target() == (listener.port, key) == client.HermesClient(name)._target()
    for name, key, listener in two_bots:                                      # each listener saw only its own Bot, with its own key
        assert listener.seen and all(path.startswith(f'/p/{name}/') and auth == 'Bearer ' + key for path, auth in listener.seen), listener.seen
        assert len(listener.seen) == 3


def test_an_explicit_value_that_is_not_a_port_fails_closed_and_reaches_nobody(two_bots):
    client, api = clients()
    name, key, listener = two_bots[0]
    other = two_bots[1][2]
    env = ROOT_HOME / 'profiles' / name / '.env'
    for bad in ('99999', '0', 'abc', '8644x', '', '-1', '1e3', '١٢٣٤'):
        env.write_text(f'API_SERVER_KEY={key}\nAPI_SERVER_PORT={bad}\n')
        for call in (lambda: client.HermesClient(name).capabilities(), lambda: api.ApiClient(name).call('GET', '/v1/runs/x'),
                     lambda: api.ApiClient(name).open_stream('GET', '/v1/runs/x/events')):
            with pytest.raises(client.HermesError) as refused:
                call()
            assert refused.value.code == 'hermes_unreachable', bad
    assert listener.seen == [] and other.seen == []                            # an explicit bad value never becomes another Bot's port


def test_without_a_key_the_profile_is_unreachable_and_never_borrows_another_profiles(two_bots):
    client, api = clients()
    name, key, listener = two_bots[0]
    (ROOT_HOME / 'profiles' / name / '.env').write_text(f'API_SERVER_PORT={PORT_A}\n')
    for call in (lambda: client.HermesClient(name).capabilities(), lambda: api.ApiClient(name).call('GET', '/v1/runs/x')):
        with pytest.raises(client.HermesError) as refused:
            call()
        assert refused.value.code == 'hermes_unreachable'
    assert listener.seen == []


def test_a_profile_that_does_not_say_uses_the_process_port_and_its_own_key(two_bots, monkeypatch):
    client, api = clients()
    creds = credentials()
    import os
    fallback = int(os.environ.get('API_SERVER_PORT', '8642'))
    assert client.HermesClient('vendas')._target() == (fallback, creds['vendas_api_key'])      # absent port: the global one, its OWN key
    assert api.ApiClient('default')._target() == (fallback, creds['api_key'])
    assert creds['api_key'] != creds['vendas_api_key']


def test_the_target_is_numeric_loopback_with_no_proxy_and_no_redirect(two_bots, monkeypatch):
    client, api = clients()
    for var in ('http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'):
        monkeypatch.setenv(var, 'http://127.0.0.1:1')                          # a proxy that would refuse everything
    name, key, listener = two_bots[0]
    assert client.HermesClient(name).capabilities()['object'] == 'hermes.api_server.capabilities'
    assert api.ApiClient(name).call('GET', '/v1/runs/x')[0] == 200 and len(listener.seen) == 2
