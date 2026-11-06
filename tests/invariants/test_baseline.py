"""Invariant 9 (F2, honest gate). Blocker 2026-10-02: the chat of `default` failed with capability_missing "update Hermes or enable its
API Server" because a slow /api/status (get_status, 5 s) read as an incompatible Hermes. The gate then compared
`hermes_cli.__release_date__`, which Hermes stopped updating (2026.9.24 on the baseline, on v0.22.2 and on main): every Hermes passed.
It now reads the identity of the RUNNING Hermes (`get_version_info()`, what GET /api/health reports) and `plugins.isolation`,
in-process (no probe, nothing to time out), through backend/hermes_compat.py (its pure cases: tests/unit/backend/test_hermes_compat.py):

  compatible   the build LuveBot was run against (or main with every break of its session authority handled)
  untested     any other Hermes, or an identity nobody can read: the features follow /v1/capabilities; never "update Hermes"
  unsupported  proof: a release older than the baseline (`capability_missing` that says update Hermes), or `plugins.isolation: host`

The real plugin module and the real API Servers of the harness; only the identity, the isolation and get_status are swapped, per test."""
import asyncio
import json
import time

import pytest

from support import plugin
from test_hook import loopback_request, run_async

BOT = 'default'
OLD = {'version': '0.21.4', 'display_version': '0.21.4', 'commit': None, 'distance': 0}
NEW = {'version': '0.22.2', 'display_version': '0.22.2', 'commit': 'd923a5eb487a' + '0' * 28, 'distance': 0}


@pytest.fixture
def module(monkeypatch):
    from luvebot_backend import bots, hermes_compat
    module = plugin()
    monkeypatch.setattr(bots, '_caps_cache', {})                                        # every test probes afresh
    hermes_compat._cache[:] = [0.0, None]
    yield module
    hermes_compat._cache[:] = [0.0, None]


def hermes(monkeypatch, identity, isolation='in_process'):
    """What `hermes_compat.read()` reports for the running Hermes (None = could not be read)."""
    from luvebot_backend import hermes_compat
    monkeypatch.setattr(hermes_compat, '_identity', lambda: identity)
    monkeypatch.setattr(hermes_compat, '_isolation', lambda: isolation)
    hermes_compat._cache[:] = [0.0, None]


def release_date(monkeypatch, value):
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
    response = run_async(module.health(loopback_request(module, 'GET', '/health?bot=' + profile), bot=profile))
    return response if isinstance(response, dict) else json.loads(response.body)


def codes(body):
    """The problems about Hermes itself and the chat/run features (Group Chat and approvals have their own, in test_health.py)."""
    return {p['code'] for p in body['problems'] if p['feature'] in ('hermes', 'runs', 'session_chat_stream', 'api_server')}


def test_the_gate_is_decided_by_the_identity_of_the_running_hermes(module, monkeypatch):
    assert run_async(module._gate()) is None                                            # the harness Hermes is neither old nor in a host
    for identity, isolation, why in ((OLD, 'in_process', 'hermes_unsupported'), (NEW, 'in_process', None), (None, 'in_process', None),
                                     ({'version': 'unknown'}, None, None), (NEW, 'host', 'isolation_host'), (OLD, 'host', 'isolation_host')):
        with monkeypatch.context() as patch:
            hermes(patch, identity, isolation)
            assert run_async(module._gate()) == why, (identity, isolation)


def test_the_stale_release_constant_decides_nothing(module, monkeypatch):
    """The mutation of this invariant (the gate put back on `__release_date__`) is red here: with an old identity a new date does not
    rescue it, and with a good identity a missing, old or garbage date does not refuse it."""
    for value in ('2020.1.1', '2026.9.23', 'garbage', '', None):
        with monkeypatch.context() as patch:
            release_date(patch, value)
            hermes(patch, NEW)
            assert run_async(module._gate()) is None, value
            body = health(module)
            assert body['hermes']['compat'] == 'untested' and 'hermes_unsupported' not in codes(body), value
    with monkeypatch.context() as patch:
        release_date(patch, '2099.12.31')
        hermes(patch, OLD)
        assert run_async(module._gate()) == 'hermes_unsupported'
    assert 'release_date' not in health(module)['hermes']


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
    assert not codes(body) & {'hermes_unsupported', 'isolation_host', 'capability_missing'}, body['problems']
    assert body['hermes']['baseline_ok'] is True and body['features']['session_chat_stream'] == 'ok'


def test_a_proven_old_hermes_says_update(module, monkeypatch):
    hermes(monkeypatch, OLD)
    error = refusal(module, module._require_feature(BOT, 'session_chat_stream'))
    assert (error.code, error.status) == ('capability_missing', 409) and 'update Hermes' in error.message
    assert error.extra == {'feature': 'session_chat_stream', 'reason': 'hermes_unsupported'}
    body = health(module)
    assert body['hermes']['compat'] == 'unsupported' and body['hermes']['baseline_ok'] is False and body['sdk']['supported'] is False
    assert [p['code'] for p in body['problems'] if p['feature'] == 'hermes'] == ['hermes_unsupported']
    assert body['features']['runs'] == 'unavailable' and body['features']['session_chat_stream'] == 'unavailable'


def test_isolation_host_turns_the_plugin_off_with_its_own_words(module, monkeypatch):
    hermes(monkeypatch, NEW, 'host')
    error = refusal(module, module._require_feature(BOT, 'runs'))
    assert (error.code, error.status) == ('capability_missing', 409) and error.extra == {'feature': 'runs', 'reason': 'isolation_host'}
    assert 'plugins.isolation: in_process' in error.message and 'update' not in error.message.lower()
    body = health(module)
    assert (body['hermes']['compat'], body['hermes']['isolation'], body['sdk']['supported']) == ('unsupported', 'host', False)
    assert [p['code'] for p in body['problems'] if p['feature'] == 'hermes'] == ['isolation_host']
    assert body['features']['runs'] == 'unavailable'


def test_an_identity_nobody_can_read_is_untested_never_update_hermes(module, monkeypatch):
    from luvebot_backend import bots
    for identity in (None, {'version': 'unknown', 'display_version': 'unknown', 'commit': None, 'distance': None}):
        with monkeypatch.context() as patch:
            hermes(patch, identity, None)
            run_async(module._require_feature(BOT, 'session_chat_stream'))             # the probe decides: this Bot's API Server has it
            body = health(module)
            assert body['hermes']['compat'] == 'untested' and body['hermes']['version'] == 'unknown'
            assert body['hermes']['baseline_ok'] is True and body['features']['session_chat_stream'] == 'ok'
            assert [p['code'] for p in body['problems'] if p['feature'] == 'hermes'] == ['hermes_untested']
            assert all('update' not in p['message'].lower() for p in body['problems'] if p['feature'] == 'hermes')
    asked = []
    monkeypatch.setattr(bots.HermesClient, 'capabilities', lambda self: asked.append(self.profile) or {})
    bots._caps_cache.clear()
    hermes(monkeypatch, None, None)
    error = refusal(module, module._require_feature(BOT, 'session_chat_stream'))      # nothing offered: the plain, honest refusal
    assert error.code == 'capability_missing' and error.extra == {'feature': 'session_chat_stream'} and asked == [BOT]
    assert 'older than' not in error.message


def test_main_is_recognised_by_its_session_authority_and_lists_what_does_not_work(module, monkeypatch):
    """`features.run_unknown_resolution` in /v1/capabilities (main, v0.23): untested, with the exact limits, until every break is
    handled by its slice (F4, F5), when it is compatible."""
    from luvebot_backend import bots, hermes_compat
    real = bots.HermesClient.capabilities

    def with_authority(self):
        caps = real(self)
        caps['features'] = {**caps['features'], 'run_unknown_resolution': True}
        return caps
    monkeypatch.setattr(bots.HermesClient, 'capabilities', with_authority)
    hermes(monkeypatch, {**NEW, 'distance': 41, 'display_version': '0.22.2+41'})
    body = health(module)
    got = body['hermes']
    assert (got['session_authority'], got['compat'], got['channel']) == (True, 'untested', 'main')
    # F2-4: `profile_selector` hangs on per-profile plugins (PLG-3), the other three on the session authority
    # the three authority breaks have code (IMPLEMENTED) and the harness proof on v0.22.5 (HANDLED, with evidence files): not `unproven`; only `profile_selector` has no code
    assert got['limits'] == [*(hermes_compat.PLG3_BREAKS if body['plugin_scope']['plg3'] else ())]
    assert got['unproven'] == []
    monkeypatch.setattr(hermes_compat, 'HANDLED', frozenset())                       # a Hermes without that proof: the breaks are `unproven`, as before the harness ran
    assert health(module)['hermes']['unproven'] == list(hermes_compat.AUTHORITY_BREAKS)
    monkeypatch.setattr(hermes_compat, 'HANDLED', frozenset(hermes_compat.AUTHORITY_BREAKS + hermes_compat.PLG3_BREAKS))
    got = health(module)
    assert (got['hermes']['compat'], got['hermes']['limits'], got['hermes']['unproven']) == ('compatible', [], []) and 'hermes_untested' not in codes(got)


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
