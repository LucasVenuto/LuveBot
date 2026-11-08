"""Four T0.8 probes against real Hermes f8489405; only its model is fake."""
import json
from pathlib import Path
import shutil
import time
from urllib.request import Request, urlopen

import pytest

from test_spike import API, CREDS, DASHBOARD, get, human_browser, real_hermes_ready

EVIDENCE = Path('/spike/evidence/t08')
FRAMES = Path('/frames')


@pytest.fixture
def plugin_page(human_browser):
    page = human_browser.new_page()
    page.goto(DASHBOARD + '/')
    page.get_by_test_id('luvebot-spike-home').wait_for(timeout=20000)
    assert page.evaluate('typeof window.__T08_SPIKE__.rpc') == 'function'
    yield page
    page.close()


def evidence(name, payload):
    encoded = json.dumps(payload, indent=2, ensure_ascii=False)
    for field in ('password', 'api_key', 'vendas_api_key', 'signing_key'):
        assert CREDS[field] not in encoded, f'Secret leaked in {name}: {field}'
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / (name + '.json')).write_text(encoded + '\n')
    print('\n' + name + ': ' + encoded)


def test_plugin_page_calls_authenticated_groups_rpc(plugin_page):
    result = plugin_page.evaluate('() => window.__T08_SPIKE__.rpc(["groups.capabilities", "groups.list"])')
    assert result['opened'] and result['ticketAuth']
    assert result['origin'] == DASHBOARD and result['path'] == '/api/ws'
    capabilities, groups = [entry['reply'] for entry in result['replies']]
    assert 'error' not in capabilities, capabilities
    assert 'error' not in groups, groups
    assert 'groups.list' in capabilities['result']['methods']
    assert 'actor_identity' in capabilities['result']['features']
    assert isinstance(capabilities['result']['driver'], bool)
    assert isinstance(groups['result']['rooms'], list)
    assert 'next_offset' in groups['result']
    evidence('groups', result)
    # Fresh unauthenticated context: no cookie means no way to mint a WS ticket.
    response = get(DASHBOARD + '/api/plugins/t0-spike/probe')
    assert response[0] == 401


def test_display_ticket_or_actual_container_blocker(plugin_page):
    result = plugin_page.evaluate('() => window.__T08_SPIKE__.rpc(["display.status", "display.start", "display.observe"])')
    assert result['opened'] and result['ticketAuth']
    status, start, observe = [entry['reply'] for entry in result['replies']]
    assert 'error' not in status, status
    if 'result' in observe:
        observed = observe['result']
        assert observed['ticket'] and observed['path'] == '/api/display/ws'
        socket = plugin_page.evaluate('(ticket) => window.__T08_SPIKE__.displaySocket(ticket)', observed['ticket'])
        assert socket['opened'] and socket.get('binary') is True, socket
        observed['ticket'] = '[single-use ticket omitted]'
        evidence('display', {'rpc': result, 'socket': socket, 'outcome': 'real RFB frame'})
    else:
        # Explicitly permitted environment limitation, not an arbitrary error/skip.
        assert shutil.which('Xvnc') is None
        assert 'Xvnc' in status['result']['missing']
        assert status['result']['installed'] is False and status['result']['running'] is False
        assert start['error']['code'] == 5300
        assert 'Bot Desktop needs' in start['error']['message'] and 'Xvnc' in start['error']['message']
        assert observe['error']['code'] == 5300
        assert observe['error']['message'] == "this profile's Bot Desktop is not running; call display.start first"
        socket = plugin_page.evaluate('() => window.__T08_SPIKE__.displaySocket(null)')
        assert socket == {'opened': True, 'code': 4401, 'reason': 'display ticket missing, expired or used'}
        evidence('display', {'rpc': result, 'socket': socket, 'Xvnc': None,
                            'outcome': 'container lacks Xvnc/Xfce; no observe ticket or RFB proof'})


def test_handler_reads_verified_actor_and_profile_key_without_leak(plugin_page, human_browser):
    assert CREDS['api_key'] != CREDS['vendas_api_key']
    reports = []
    cookie_values = [cookie['value'] for cookie in human_browser.cookies() if cookie['name'] in {'hermes_session_at', 'hermes_session_rt'}]
    for profile, own, other in [('default', 'api_key', 'vendas_api_key'), ('vendas', 'vendas_api_key', 'api_key')]:
        # Actual SDK authedFetch FROM the plugin page; key never provided to JS.
        response = plugin_page.evaluate('(profile) => window.__T08_SPIKE__.identity(profile)', profile)
        assert response['status'] == 200, response
        text = response['text']
        for secret in [CREDS['api_key'], CREDS['vendas_api_key'], *cookie_values]:
            assert secret not in text, 'Server secret/session token reached the browser'
        data = json.loads(text)
        assert data['actor'] == {'user_id': CREDS['username'], 'provider': 'basic'}
        assert data['profile'] == profile
        assert data['profile_home'] == ('/root/.hermes' if profile == 'default' else '/root/.hermes/profiles/vendas')
        assert data['key_resolved'] is True and data['upstream_status'] == 200
        assert data['upstream_object'] == 'hermes.api_server.capabilities'
        assert get(API + f'/p/{profile}/v1/capabilities', CREDS[own])[0] == 200
        assert get(API + f'/p/{profile}/v1/capabilities', CREDS[other])[0] == 401
        assert get(DASHBOARD + f'/api/plugins/t0-spike/identity?profile={profile}')[0] == 401
        reports.append({**data, 'wrong_profile_key_status': 401, 'without_session_status': 401})
    evidence('principal-profile', reports)


def api_request(path, body=None):
    return Request(API + '/p/default' + path,
                   data=None if body is None else json.dumps(body).encode(),
                   headers={'Authorization': 'Bearer ' + CREDS['api_key'], 'Content-Type': 'application/json'})


def api_json(path, body=None):
    with urlopen(api_request(path, body), timeout=90) as response:
        return response.status, json.loads(response.read())


def read_sse(request, channel, frames, stop_at_approval=False):
    """Keep original bytes including id/event lines; derive field inventory separately."""
    raw_stream, seen = [], []
    with urlopen(request, timeout=90) as response:
        assert response.status == 200
        assert response.headers.get_content_type() == 'text/event-stream'
        pending = b''
        while line := response.readline():
            pending += line
            if line.strip():
                continue
            raw = pending
            pending = b''
            raw_stream.append(raw)
            lines = raw.decode().splitlines()
            data_lines = [line[6:] for line in lines if line.startswith('data: ')]
            if not data_lines:
                continue
            data = json.loads('\n'.join(data_lines))
            event = next((line[7:] for line in lines if line.startswith('event: ')), data.get('event'))
            assert event and data.get('run_id') and isinstance(data.get('seq'), int)
            assert isinstance(data.get('ts' if channel == 'chat' else 'timestamp'), (int, float))
            for field in ('api_key', 'vendas_api_key', 'password', 'signing_key'):
                assert CREDS[field].encode() not in raw, f'Secret leaked in SSE: {field}'
            seen.append(event)
            frames.setdefault((channel, event), raw)
            if stop_at_approval and event == 'approval.request':
                assert data['command'] == 'rm -rf /tmp/luvebot-approval-canary'
                assert 'deny' in data['choices'] and 'once' in data['choices']
                # Cancel through the official run control API; NEVER approve.
                code, stopped = api_json('/v1/runs/' + data['run_id'] + '/stop', {})
                assert code == 200 and stopped['run_id'] == data['run_id']
                assert stopped["status"] == "stopping"
                # Keep reading real cancellation/tool frames through EOF.
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    suffix = '-approval' if stop_at_approval else ''
    (EVIDENCE / (channel + suffix + '-stream.sse')).write_bytes(b''.join(raw_stream))
    return seen


def test_capture_real_run_and_chat_sse_frames_including_approval():
    frames = {}
    code, created = api_json('/v1/runs', {'input': 'T08_TOOL_NORMAL: use the local terminal tool.'})
    assert code == 202
    run_id = created['run_id']
    run = read_sse(api_request('/v1/runs/' + run_id + '/events'), 'run', frames)
    assert {'message.delta', 'tool.started', 'tool.completed', 'run.completed'} <= set(run), run
    status, completed = api_json('/v1/runs/' + run_id)
    assert status == 200 and completed['status'] == 'completed'
    code, session = api_json('/api/sessions', {})
    assert code == 201
    session_id = session['session']['id']
    chat = read_sse(api_request('/api/sessions/' + session_id + '/chat/stream',
                               {'message': 'T08_TOOL_NORMAL: use the local terminal tool.'}), 'chat', frames)
    assert {'run.started', 'message.started', 'assistant.delta', 'tool.started', 'tool.completed',
            'assistant.completed', 'run.completed', 'done'} <= set(chat), chat
    canary = Path('/tmp/luvebot-approval-canary')
    canary.mkdir(exist_ok=True)
    (canary / 'never-executed.txt').write_text('Approval must remain unresolved.\n')
    approval_observations = {}
    for channel in ('run', 'chat'):
        if channel == 'run':
            code, created = api_json('/v1/runs', {'input': 'T08_TOOL_APPROVAL: request the dangerous tool.'})
            assert code == 202
            request = api_request('/v1/runs/' + created['run_id'] + '/events')
        else:
            code, session = api_json('/api/sessions', {})
            assert code == 201
            request = api_request('/api/sessions/' + session['session']['id'] + '/chat/stream',
                                  {'message': 'T08_TOOL_APPROVAL: request the dangerous tool.'})
        seen = read_sse(request, channel, frames, stop_at_approval=True)
        assert {'approval.request', 'run.cancelled'} <= set(seen), (channel, seen)
        assert (canary / 'never-executed.txt').exists(), 'Dangerous tool executed without approval'
        approval_observations[channel] = seen
    inventory = []
    for (channel, event), raw in sorted(frames.items()):
        destination = FRAMES / channel / (event + '.sse')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(raw)
        data = json.loads(next(line[6:] for line in raw.decode().splitlines() if line.startswith('data: ')))
        inventory.append({'file': str(destination.relative_to(FRAMES)), 'channel': channel, 'event': event,
                          'fields': list(data), 'bytes': len(raw)})
    metadata = {'hermes_commit': 'f8489405600c9a7d9d2f307dace086f18d7173ba',
                'source': 'real Hermes HTTP SSE; raw frames, no synthesized events or replaced IDs',
                'run_events': run, 'chat_events': chat, 'approval_events': approval_observations,
                'frames': inventory}
    (FRAMES / 'index.json').write_text(json.dumps(metadata, indent=2) + '\n')
    evidence('sse-inventory', metadata)
