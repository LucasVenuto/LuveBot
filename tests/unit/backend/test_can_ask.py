"""`can_ask` of GET /bots/{bot} (the Prumo's proposal, from the Forja's finding on the real v0.22.5): a Bot whose api_server toolsets do not include `clarify` never
asks a person (Hermes sets the question aside and the Bot decides alone), and no screen shows a Bot's tools, so the profile must say it. Backend:
ADDITIVE, a boolean, ABSENT when it cannot be told (never a guess), computed only on a Hermes with the session authority; true when `clarify` is among the
tools of the toolsets the RUNNING api_server uses. Each case also runs against a variant with one defect: each must go red."""
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[3]  # live_state imports Hermes's own modules: only its source is read here, never imported
SOURCE = (ROOT / 'backend' / 'live_state.py').read_text()
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
MAPS = ({'web': ('web_search', 'web_extract'), 'clarify': ('clarify',), 'core': ('terminal', 'clarify', 'read_file'), 'files': ('read_file', 'write_file')}, {})


def reader(*enabled, disabled=(), tools=None):
    """/v1/toolsets as the api_server answers: `tools` (per name) is what each toolset expands to there; none = an api_server before that field."""
    data = [{'name': n, 'enabled': True, **({'tools': tools[n]} if tools and n in tools else {})} for n in enabled] + [{'name': n, 'enabled': False} for n in disabled]
    return lambda bot: (200, {'data': data})


def checks(fn):
    yes = lambda bot: True  # noqa: E731
    maps = lambda bot: MAPS  # noqa: E731
    assert fn('a', authority=yes, reader=reader('web', 'core'), maps=maps) is True                       # clarify is in the tools of an enabled toolset
    assert fn('a', authority=yes, reader=reader('clarify'), maps=maps) is True                           # the toolset named like the tool
    assert fn('a', authority=yes, reader=reader('web', 'files'), maps=maps) is False                     # every toolset expanded, none has it
    assert fn('a', authority=yes, reader=reader('web', disabled=('core',)), maps=maps) is False          # a disabled toolset does not count
    assert fn('a', authority=lambda bot: False, reader=reader('core'), maps=maps) is None                # no session authority: not told
    assert fn('a', authority=yes, reader=lambda bot: (404, None), maps=maps) is None                     # the api_server's toolsets cannot be read
    assert fn('a', authority=yes, reader=lambda bot: (200, {'data': 'x'}), maps=maps) is None
    assert fn('a', authority=yes, reader=lambda bot: (200, None), maps=maps) is None

    def boom(bot):
        raise RuntimeError('hermes is down')
    assert fn('a', authority=yes, reader=boom, maps=maps) is None
    assert fn('a', authority=boom, reader=reader('core'), maps=maps) is None
    assert fn('a', authority=yes, reader=reader('core'), maps=boom) is None                              # the expansion cannot be read
    assert fn('a', authority=yes, reader=reader('web', 'mystery'), maps=maps) is None                    # a toolset we cannot expand keeps it open...
    assert fn('a', authority=yes, reader=reader('mystery', 'core'), maps=maps) is True                   # ...unless clarify is already found
    assert fn('a', authority=yes, reader=reader(), maps=maps) is False                                   # nothing enabled: certainly no clarify
    # the tools come from the process that answers; the installed Hermes's map is only plan B
    def boom_maps(bot):
        raise RuntimeError('the dashboard has no such Hermes')
    assert fn('a', authority=yes, reader=reader('core', tools={'core': ['terminal', 'clarify']}), maps=boom_maps) is True
    assert fn('a', authority=yes, reader=reader('web', tools={'web': ['web_search']}), maps=boom_maps) is False
    assert fn('a', authority=yes, reader=reader('core', tools={'core': ['terminal']}), maps=maps) is False  # the answering process wins over the installed map (which would say True)
    assert fn('a', authority=yes, reader=reader('core', tools={'core': []}), maps=maps) is True            # an empty list = it could not expand: plan B
    assert fn('a', authority=yes, reader=reader('web', 'core', tools={'web': ['web_search']}), maps=maps) is True   # one toolset from each side
    assert fn('a', authority=yes, reader=reader('web', 'mystery', tools={'web': ['web_search']}), maps=maps) is None
    assert fn('a', authority=yes, reader=reader('core', tools={'core': 'clarify'}), maps=maps) is True     # a malformed `tools` is ignored: plan B
    assert fn('a', authority=yes, reader=reader('core', 'mystery', tools={'core': ['clarify']}), maps=boom_maps) is True   # plan B failing never undoes what the answer already says
    assert fn('a', authority=yes, reader=reader('core', 'mystery', tools={'core': ['terminal']}), maps=boom_maps) is None  # ...and leaves the rest open


def load(old=None, new=None):
    text = re.search(r'CLARIFY = .*?(?=\n\ndef hook_name)', SOURCE, re.S).group(0)
    if old is not None:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    ns = {'canonical': None, 'ApiClient': None, 'expansion_maps': None}
    exec(text, ns)
    return ns['can_ask']


def test_can_ask_is_true_false_or_not_told():
    checks(load())


@pytest.mark.parametrize('old,new', [
    ("        if not (authority or canonical.authority)(bot):\n            return None\n", ""),
    ("        if code != 200 or not isinstance(payload, dict) or not isinstance(payload.get('data'), list):\n            return None\n",
     "        if code != 200 or not isinstance(payload, dict) or not isinstance(payload.get('data'), list):\n            return False\n"),
    ("    except Exception:  # noqa: BLE001  (Hermes unreachable, a changed shape: not told)\n        return None", "    except Exception:  # noqa: BLE001  (Hermes unreachable, a changed shape: not told)\n        return False"),
    ("s.get('enabled') is True and", "True and"),
    ("    return False if all(name in tools for name in shown) else None", "    return False"),
    ("    if any(CLARIFY in listed for listed in tools.values()):", "    if CLARIFY in shown:"),
    ("tools = {name: [t for t in listed if isinstance(t, str)] for name, listed in shown.items() if isinstance(listed, list) and listed}", "tools = {}"),
    ("            tools.update({name: installed[name] for name in shown if name not in tools and name in installed})\n", "            pass\n"),
    ("if isinstance(listed, list) and listed}", "if isinstance(listed, list)}"),
    ("            try:\n                installed = (maps or expansion_maps)(bot)[0]\n            except Exception:  # noqa: BLE001\n                installed = {}\n",
     "            installed = (maps or expansion_maps)(bot)[0]\n"),
], ids=['no_authority_needed', 'unreadable_is_false', 'an_error_is_false', 'disabled_counts', 'unexpandable_is_false', 'toolset_name_only', 'tools_never_read_from_the_answer',
        'plan_b_never_used', 'an_empty_list_is_an_answer', 'plan_b_error_kills_the_answer'])
def test_each_mutation_is_caught(old, new):
    with pytest.raises(Exception):  # noqa: B017
        checks(load(old, new))


def test_the_route_adds_the_field_only_to_the_detail_in_parallel_kept_and_only_when_it_is_told():
    def wired(text):
        one = text.split('async def _one(name, extras=False):', 1)[1].split('\n@router', 1)[0]
        return ("if not extras:\n        return _redact_deep(bot)" in one and 'live_state.toolset_facts, name' in one
                and "await _CAN_ASK.get(('can_ask', name), _EPOCH[0], read)" in one and "if found is None:\n                raise LookupError(name)  # not told" in one
                and 'asyncio.gather(detail_extras(name), asking(), files())' in one and "**({'can_ask': answer} if isinstance(answer, bool) else {})" in one)
    assert wired(API) and '_CAN_ASK = Memo(60.0)' in API
    for old, new in (("**({'can_ask': answer} if isinstance(answer, bool) else {})", "'can_ask': answer"), ('live_state.toolset_facts, name', 'live_state.read, name'),
                     ('asyncio.gather(detail_extras(name), asking(), files())', 'asyncio.gather(detail_extras(name), files())'),
                     ("await _CAN_ASK.get(('can_ask', name), _EPOCH[0], read)", 'await read()'), ("_CAN_ASK.get(('can_ask', name), _EPOCH[0], read)", "_CAN_ASK.get(('can_ask', name), 0, read)"),
                     ('raise LookupError(name)  # not told', 'return found  # not told')):
        assert API.count(old) == 1, old
        assert not wired(API.replace(old, new)), old
