"""T10.3: an honest /health (invariant 9). Approvals are as available as each Bot's LuveBot hook, Group Chat is what the real
groups.capabilities says, and the approval transport is reported as not used. Never available when it is not, nor the reverse."""
import json

import pytest

from support import plugin
from test_hook import loopback_request, run_async, wait_live
from test_plugin import no_secret
from test_runs import get


def health_of(profile=None):
    module = plugin()
    path = '/health' + ('' if profile is None else '?profile=' + profile)
    response = run_async(module.health(loopback_request(module, 'GET', path), profile=profile))
    return response if isinstance(response, dict) else json.loads(response.body)


def problems_for(health, feature):
    return [p for p in health['problems'] if p['feature'] == feature]


def test_the_real_health_matches_the_live_hooks_and_the_real_group_chat(human_browser):
    for name in ('default', 'vendas'):
        wait_live(human_browser, name)
        scoped = get(human_browser, '/health?profile=' + name).json()
        assert scoped['features']['approvals'] == 'ok' and not problems_for(scoped, 'approvals'), scoped
    health = get(human_browser, '/health')
    body = health.json()
    assert body['features']['approval_transport'] == 'not_used' and not problems_for(body, 'approval_transport')
    assert body['features']['groups'] == 'ok' and not problems_for(body, 'groups')        # the harness runs the room driver (T0.8)
    assert get(human_browser, '/rooms').status == 200                                    # and the room routes agree with it
    no_secret(health.body(), 'health')


def test_approvals_follow_the_hook_of_each_bot(human_browser, monkeypatch):
    wait_live(human_browser, 'default')
    module = plugin()
    real = module.hook.hook_state

    def state(path, name, **kw):
        return {'status': 'absent'} if name == 'vendas' else real(path, name, **kw)
    monkeypatch.setattr(module.hook, 'hook_state', state)
    vendas = health_of('vendas')
    assert vendas['features']['approvals'] == 'unavailable'
    assert [(p['code'], p['bot']) for p in problems_for(vendas, 'approvals')] == [('hook_not_live', 'vendas')]
    assert health_of('default')['features']['approvals'] == 'ok'
    assert health_of()['features']['approvals'] == 'unavailable'                          # one Bot without its hook: not "available"
    for status in ('pending_reload', 'absent'):
        monkeypatch.setattr(module.hook, 'hook_state', lambda path, name, status=status, **kw: {'status': status})
        assert health_of('default')['features']['approvals'] == 'unavailable', status

    def broken(path, name, **kw):
        raise RuntimeError('unreadable')
    monkeypatch.setattr(module.hook, 'hook_state', broken)
    unread = health_of('default')
    assert unread['features']['approvals'] == 'unknown' and problems_for(unread, 'approvals')[0]['code'] == 'capability_unverified'


@pytest.mark.parametrize('reply, expected', [
    ({'driver': True, 'protocol_version': 2}, 'ok'),
    ({'driver': False}, 'unavailable'),
    ({'driver': 'yes'}, 'unavailable'),
    ({}, 'unavailable'),
    ('capability_missing', 'unavailable'),
    ('hermes_unreachable', 'unknown'),
])
def test_group_chat_is_what_groups_capabilities_says(monkeypatch, reply, expected):
    module = plugin()

    async def call(method, params):
        assert method == 'groups.capabilities'
        if isinstance(reply, str):
            raise module.PluginError(reply, 'x', 409)
        return reply
    monkeypatch.setattr(module, '_room_call', call)
    health = health_of('default')
    assert health['features']['groups'] == expected
    assert bool(problems_for(health, 'groups')) is (expected != 'ok')
    assert health['features']['approval_transport'] == 'not_used'
