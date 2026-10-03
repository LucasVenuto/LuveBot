"""Blocker 2026-10-02: the chat of `default` failed with capability_missing
"update Hermes or enable its API Server" because a slow /api/status (get_status, 5 s) read as an incompatible Hermes. The baseline
is now one of three states, read from the release date of the RUNNING Hermes (the constant /api/status itself reports,
hermes_cli/web_routers/status.py#L503), in-process: no probe, nothing to time out.

  ok           readable release >= 2026.9.24: the features follow /v1/capabilities
  unsupported  readable release older: proof, `capability_missing` that says "update Hermes"
  unverified   no readable release: no proof either way; 503 `hermes_status_unverified`, recoverable, never "update Hermes",
               and nothing reaches the Bot

The real plugin module and the real API Servers of the harness; only the release constant and get_status are swapped, per test."""
import asyncio
import json
import time

import pytest

from support import plugin
from test_hook import loopback_request, run_async

BOT = 'default'


@pytest.fixture
def module(monkeypatch):
    from luvebot_backend import bots
    module = plugin()
    monkeypatch.setattr(bots, '_caps_cache', {})                                        # every test probes afresh
    return module


def release(monkeypatch, value):
    import hermes_cli
    if value is None:
        monkeypatch.delattr(hermes_cli, '__release_date__')
    else:
        monkeypatch.setattr(hermes_cli, '__release_date__', value)


def hang_status(monkeypatch, module):
    async def never(*args, **kwargs):
        await asyncio.sleep(30)
    monkeypatch.setattr(module, 'get_status', never)


def refusal(module, coro):
    with pytest.raises((module.PluginError, module.HermesError)) as caught:
        run_async(coro)
    return caught.value


def health(module, profile=BOT):
    response = run_async(module.health(loopback_request(module, 'GET', '/health?profile=' + profile), profile=profile))
    return response if isinstance(response, dict) else json.loads(response.body)


def codes(body):
    """The problems about Hermes itself and the chat/run features (Group Chat and approvals have their own, in test_health.py)."""
    return {p['code'] for p in body['problems'] if p['feature'] in ('hermes', 'runs', 'session_chat_stream', 'api_server')}


def test_the_three_states_from_the_release_of_the_running_hermes(module, monkeypatch):
    assert module._baseline() == 'ok'                                                   # the harness runs f8489405 (2026.9.24)
    for value, state in (('2026.9.23', 'unsupported'), ('2025.1.1', 'unsupported'), ('2026.9.24', 'ok'), ('2027.1.1', 'ok'),
                         ('2026.99.99', 'unverified'), ('unexpected', 'unverified'), ('', 'unverified'), (None, 'unverified')):
        with monkeypatch.context() as patch:
            release(patch, value)
            assert module._baseline() == state, value


def test_compatible_with_capabilities_the_chat_is_allowed(module):
    run_async(module._require_feature(BOT, 'session_chat_stream'))
    run_async(module._require_feature(BOT, 'runs'))


def test_a_slow_status_no_longer_decides_anything(module, monkeypatch):
    hang_status(monkeypatch, module)
    started = time.monotonic()
    run_async(module._require_feature(BOT, 'session_chat_stream'))                      # the blocker: this was capability_missing
    assert time.monotonic() - started < 4
    body = health(module)
    assert 'hermes_unreachable' in codes(body)                                          # the liveness probe still says it is slow
    assert not codes(body) & {'baseline_unsupported', 'capability_missing', 'hermes_status_unverified'}, body['problems']
    assert body['hermes']['baseline_ok'] is True and body['features']['session_chat_stream'] == 'ok'


def test_a_proven_old_hermes_says_update(module, monkeypatch):
    release(monkeypatch, '2026.9.23')
    error = refusal(module, module._require_feature(BOT, 'session_chat_stream'))
    assert (error.code, error.status) == ('capability_missing', 409) and 'update Hermes' in error.message
    assert error.extra['feature'] == 'session_chat_stream' and error.extra['reason'] == 'baseline_unsupported'
    body = health(module)
    assert 'baseline_unsupported' in codes(body) and 'hermes_status_unverified' not in codes(body)


def test_an_unverifiable_hermes_fails_closed_with_its_own_recoverable_error(module, monkeypatch):
    from luvebot_backend import bots
    asked = []
    monkeypatch.setattr(bots.HermesClient, 'capabilities', lambda self: asked.append(self.profile) or {})
    for value in ('unexpected', None):
        with monkeypatch.context() as patch:
            release(patch, value)
            asked.clear()
            error = refusal(module, module._require_feature(BOT, 'session_chat_stream'))
            assert (error.code, error.status) == ('hermes_status_unverified', 503) and 'try again' in error.message
            assert 'update' not in error.message.lower() and asked == []                 # the gate did not even ask the Bot
            body = health(module)                                                       # (health's read-only probe may)
            assert 'hermes_status_unverified' in codes(body) and not codes(body) & {'baseline_unsupported', 'capability_missing'}
            assert body['hermes']['baseline_ok'] is False and body['sdk']['supported'] is False
    route = module.create_session(BOT, loopback_request(module, 'POST', f'/bots/{BOT}/sessions', body=b'{}'))
    release(monkeypatch, 'unexpected')
    assert refusal(module, route).code == 'hermes_status_unverified'


def test_a_wrong_key_or_unreachable_api_is_its_own_error_without_secrets(module, monkeypatch):
    from luvebot_backend import bots
    from luvebot_backend.hermes_client import HermesError
    from support import credentials
    for code in ('hermes_error', 'hermes_unreachable', 'hermes_timeout'):
        bots._caps_cache.clear()
        monkeypatch.setattr(bots.HermesClient, 'capabilities', lambda self, c=code: (_ for _ in ()).throw(HermesError(c)))
        if code == 'hermes_error':                                                      # e.g. a 401 for a wrong key: not "update Hermes"
            error = refusal(module, module._require_feature(BOT, 'runs'))
            assert error.code == 'hermes_error' and 'update' not in error.message.lower()
        else:                                                                           # offline: left to the call, which fails closed
            run_async(module._require_feature(BOT, 'runs'))
        text = json.dumps(health(module))
        assert all(secret not in text for secret in credentials().values() if isinstance(secret, str) and len(secret) > 8)


def test_a_missing_feature_is_still_capability_missing(module, monkeypatch):
    from luvebot_backend import bots
    real = bots.HermesClient.capabilities

    def without_streaming(self):
        caps = real(self)
        caps['features'] = {**caps['features'], 'session_chat_streaming': False}
        return caps
    monkeypatch.setattr(bots.HermesClient, 'capabilities', without_streaming)
    error = refusal(module, module._require_feature(BOT, 'session_chat_stream'))
    assert (error.code, error.status) == ('capability_missing', 409) and error.extra == {'feature': 'session_chat_stream'}
    run_async(module._require_feature(BOT, 'runs'))
