"""`file_tools` of GET /bots/{bot} (contract v0.9 14, A-131) against the REAL Hermes v0.22.5: what the Bot can do with a file it was given (read_file, vision_analyze,
terminal), MEASURED from the toolsets of the RUNNING api_server (`GET /p/<bot>/v1/toolsets`) and compared with that very payload, computed here from the raw answer (the enabled
toolsets' tool lists), not with the code under test. Three configurations of one profile (its config.yaml, put back afterwards):

* no `platform_toolsets` key (the merge case: the api_server fills it from Hermes's defaults): whatever the payload lists is what the field says; the three keys are printed;
* `['terminal']`: read_file false, vision_analyze false, terminal true;
* `['file']`: read_file true, terminal false, vision_analyze false.
`vendas` keeps the harness config and is checked against its own payload too. The field is cached 60 s per Bot, so a change shows up within that wait. A Bot that really opens the
file is NOT required here: "true" is a capability the config gives, never a promise."""
import os

import pytest

from support import plugin
from test_can_ask import config_back, set_api_server_toolsets  # noqa: F401  (config_back is a fixture)
from test_hook import wait_for
from test_runs import get

TOOLS = ('read_file', 'vision_analyze', 'terminal')


def record(line):
    """What was measured, printed and appended to $HARNESS_STATE/logs/file-tools-measured.txt (the run keeps that folder): the numbers of this proof."""
    print(line)
    try:
        with open(os.path.join(os.environ['HARNESS_STATE'], 'logs', 'file-tools-measured.txt'), 'a') as handle:
            handle.write(line + '\n')
    except OSError:
        pass


def payload_of(bot):
    plugin()
    from luvebot_backend.hermes_api import ApiClient
    code, payload = ApiClient(bot).call('GET', '/v1/toolsets', timeout=5)
    assert code == 200 and isinstance(payload.get('data'), list), (code, payload)
    return payload


def measured(bot):
    """{tool: bool} from the RAW payload: true when an ENABLED toolset lists the tool; every enabled toolset must carry its tool list (v0.22.5 expands them)."""
    payload = payload_of(bot)
    enabled = [s for s in payload['data'] if isinstance(s, dict) and s.get('enabled') is True]
    assert all(isinstance(s.get('tools'), list) and s['tools'] for s in enabled), [(s.get('name'), s.get('tools')) for s in enabled]
    listed = {tool for s in enabled for tool in s['tools']}
    known = {tool for s in payload['data'] if isinstance(s, dict) and isinstance(s.get('tools'), list) for tool in s['tools']}
    assert all(tool in known for tool in TOOLS), (TOOLS, 'this Hermes does not know one of them', sorted(known))
    return {tool: tool in listed for tool in TOOLS}, [s['name'] for s in enabled]


def field_of(browser, bot):
    response = get(browser, f'/bots/{bot}')
    assert response.status == 200, response.text()
    return response.json().get('file_tools', 'absent')


def wait_field(browser, bot, timeout=90):
    """Poll until the field equals what the raw payload says NOW (the field is cached 60 s per Bot); -> (field, measured, enabled toolsets)."""
    last = []

    def settled():
        want, enabled = measured(bot)
        got = field_of(browser, bot)
        last[:] = [got, want]
        return (got, want, enabled) if got == want else None
    return wait_for(settled, timeout, f'file_tools of {bot} to equal the toolsets payload; last={last}')


def test_the_harness_config_says_what_the_payload_says(human_browser):
    got, want, enabled = wait_field(human_browser, 'vendas')
    record(f'VENDAS: enabled={enabled} file_tools={got}')
    assert set(got) == set(TOOLS)


def test_no_platform_toolsets_key_the_merge_case(human_browser, config_back):
    set_api_server_toolsets('default', None)
    got, want, enabled = wait_field(human_browser, 'default')
    record(f'MERGE CASE: enabled={enabled} file_tools={got}')       # the contract expects the three listed: measured, not assumed
    assert set(got) == set(TOOLS)


def test_terminal_only(human_browser, config_back):
    set_api_server_toolsets('default', ['terminal'])
    got, want, enabled = wait_field(human_browser, 'default')
    record(f"['terminal']: enabled={enabled} file_tools={got}")
    assert got == {'read_file': False, 'vision_analyze': False, 'terminal': True}


def test_file_only(human_browser, config_back):
    set_api_server_toolsets('default', ['file'])
    got, want, enabled = wait_field(human_browser, 'default')
    record(f"['file']: enabled={enabled} file_tools={got}")
    assert got == {'read_file': True, 'vision_analyze': False, 'terminal': False}
