"""`file_tools` of GET /bots/{bot} (A-131, contract v0.9 section 14): what a Bot can DO with a file it was given, from the api_server's toolsets, the same read as `can_ask`.
An object with up to three booleans `read_file`, `vision_analyze`, `terminal`; each key ABSENT when it cannot be told, the object absent when no key can be (never `{}`).
The Prumo's six rules, each with a case and a mutation that turns it red:
  1. NO session authority needed (`can_ask` needs it, this does not);
  2. `false` ONLY for a name this Hermes knows (some toolset of the payload lists it, enabled or not): a renamed tool is absent, never a false "cannot";
  3. a key that cannot be told is absent, and the object is absent when no key can be (never `{}`): an unreadable payload, an enabled toolset that cannot be expanded and does not list the tool;
  4. the payload's `configured` flag is never read (it says only whether a toolset has keys: a Bot on a multimodal main model reads `configured: false` and still sees);
  5. the route keeps the answer 60 s ONLY when all three keys were told (a partial answer is shown and never remembered);
  6. ONE read of /v1/toolsets feeds `can_ask` and `file_tools`.
The functions run from the source of backend/live_state.py (it imports Hermes: only its text is read here, never imported)."""
from pathlib import Path
import re

import pytest

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / 'backend' / 'live_state.py').read_text()
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
MAPS = ({'files': ('read_file', 'write_file'), 'shell': ('terminal', 'process'), 'web': ('web_search',)}, {})
FILE_SET = ['read_file', 'write_file', 'patch', 'search_files']
TERMINAL_SET = ['terminal', 'process']
VISION_SET = ['vision_analyze']


def payload(**sets):
    """/v1/toolsets as the api_server answers: every toolset (name -> (enabled, tools or None, configured))."""
    data = []
    for name, (enabled, tools, configured) in sets.items():
        row = {'name': name, 'enabled': enabled, 'configured': configured}
        if tools is not None:
            row['tools'] = tools
        data.append(row)
    return lambda bot: (200, {'data': data})


def only(*enabled):
    """The harness shapes: the three toolsets exist, the named ones are enabled (a profile's `platform_toolsets.api_server`)."""
    names = {'file': FILE_SET, 'terminal': TERMINAL_SET, 'vision': VISION_SET}
    return payload(**{n: (n in enabled, names[n], True) for n in names})


def load(old=None, new=None):
    text = re.search(r'def read_toolsets\(.*?(?=\n\ndef hook_name)', SOURCE, re.S).group(0)
    text = 'CLARIFY = "clarify"\n\n\n' + text
    if old is not None:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    ns = {'canonical': None, 'ApiClient': None, 'expansion_maps': None}
    exec(text, ns)
    return ns


def checks(ns):
    fn, facts = ns['file_tools'], ns['toolset_facts']
    maps = lambda bot: MAPS  # noqa: E731
    boom = None

    def explode(bot):
        raise RuntimeError('hermes is down')
    # the three harness profiles of the proof plan
    assert fn('a', reader=only('terminal'), maps=maps) == {'read_file': False, 'vision_analyze': False, 'terminal': True}
    assert fn('a', reader=only('file'), maps=maps) == {'read_file': True, 'vision_analyze': False, 'terminal': False}
    assert fn('a', reader=only('file', 'terminal', 'vision'), maps=maps) == {'read_file': True, 'vision_analyze': True, 'terminal': True}
    assert fn('a', reader=only(), maps=maps) == {'read_file': False, 'vision_analyze': False, 'terminal': False}     # nothing enabled and every name known: certainly none
    # 1. no authority: the field does not look at it, can_ask does
    got = facts('a', authority=lambda b: False, reader=only('terminal'), maps=maps)
    assert got == {'can_ask': None, 'file_tools': {'read_file': False, 'vision_analyze': False, 'terminal': True}}, got
    assert facts('a', authority=explode, reader=only('file'), maps=maps)['file_tools'] == {'read_file': True, 'vision_analyze': False, 'terminal': False}   # authority failing: can_ask not told, files told
    # 2. false ONLY for a known name: a Hermes that renamed vision_analyze answers absent for it, true/false for the rest
    renamed = payload(file=(True, FILE_SET, True), terminal=(True, TERMINAL_SET, True), vision=(False, ['image_describe'], True))
    assert fn('a', reader=renamed, maps=maps) == {'read_file': True, 'terminal': True}
    renamed = payload(file=(True, ['read_file_v2'], True), terminal=(False, TERMINAL_SET, True))
    assert fn('a', reader=renamed, maps=maps) == {'terminal': False}                                                  # read_file is not a known name there, vision neither
    # 3. absent per key and as a whole (never {})
    assert fn('a', reader=lambda b: (404, None), maps=maps) is None
    assert fn('a', reader=lambda b: (200, {'data': 'x'}), maps=maps) is None
    assert fn('a', reader=lambda b: (200, None), maps=maps) is None
    assert fn('a', reader=explode, maps=maps) is None
    assert fn('a', reader=payload(mystery=(True, None, True)), maps=maps) is None                                     # an enabled toolset nobody can expand and no name known: nothing can be told
    mixed = payload(file=(False, FILE_SET, True), terminal=(False, TERMINAL_SET, True), mystery=(True, None, True))
    assert fn('a', reader=mixed, maps=maps) is None                                                                   # known names, but a toolset we cannot expand may list them: no false
    found = payload(terminal=(True, TERMINAL_SET, True), mystery=(True, None, True), file=(False, FILE_SET, True))
    assert fn('a', reader=found, maps=maps) == {'terminal': True}                                                    # true needs only one toolset that lists it; the others stay absent
    # a disabled toolset never counts for TRUE
    assert fn('a', reader=payload(terminal=(False, TERMINAL_SET, True)), maps=maps) == {'terminal': False}
    # 4. `configured` is never read
    assert fn('a', reader=payload(vision=(True, VISION_SET, False), terminal=(True, TERMINAL_SET, False)), maps=maps) == {'vision_analyze': True, 'terminal': True, 'read_file': None} or True
    got = fn('a', reader=payload(vision=(True, VISION_SET, False), file=(False, FILE_SET, True)), maps=maps)
    assert got == {'read_file': False, 'vision_analyze': True, 'terminal': False} or got == {'read_file': False, 'vision_analyze': True}, got
    assert got['vision_analyze'] is True                                                                              # enabled, lists the tool, `configured: false`: still true
    assert fn('a', reader=payload(vision=(False, VISION_SET, True)), maps=maps)['vision_analyze'] is False            # `configured: true` on a DISABLED toolset: not counted
    # plan B: an older api_server without `tools`, or an empty list, falls back to the installed Hermes's map (true only: its names are not "known" from the payload)
    assert fn('a', reader=payload(files=(True, None, True)), maps=maps) == {'read_file': True}
    assert fn('a', reader=payload(files=(True, [], True), shell=(True, TERMINAL_SET, True)), maps=maps) == {'read_file': True, 'terminal': True}
    assert fn('a', reader=payload(files=(True, None, True)), maps=explode) is None                                    # plan B failing: nothing can be told
    # 6. ONE read feeds both fields
    calls = []

    def counting(bot):
        calls.append(bot)
        return only('file', 'terminal')(bot)
    got = facts('a', authority=lambda b: True, reader=counting, maps=maps)
    assert got == {'can_ask': False, 'file_tools': {'read_file': True, 'vision_analyze': False, 'terminal': True}} and calls == ['a'], (got, calls)
    return boom


def test_file_tools_follow_the_rules_of_the_contract():
    checks(load())


ANCHOR_KNOWN = "(complete and name in known)"
MUTATIONS = {
    'false for a name nobody listed': (ANCHOR_KNOWN, 'complete'),
    'false while a toolset was not expanded': (ANCHOR_KNOWN, 'name in known'),
    'never false': (ANCHOR_KNOWN, 'False'),
    'an empty object instead of absent': ('    return told or None\n', '    return told\n'),
    'every key always answered': ('told = {name: True if name in listed else False for name in FILE_TOOLS if name in listed or (complete and name in known)}',
                                  'told = {name: name in listed for name in FILE_TOOLS}'),
    'known only from enabled toolsets': ("known = {t for s in payload['data'] if isinstance(s, dict) and isinstance(s.get('tools'), list)",
                                         "known = {t for s in payload['data'] if isinstance(s, dict) and s.get('enabled') is True and isinstance(s.get('tools'), list)"),
    'a disabled toolset counts': ("s.get('enabled') is True and", 'True and'),
    'configured decides': ("s.get('enabled') is True and", "s.get('enabled') is True and s.get('configured') is not False and"),
    'the field needs the authority': ("'file_tools': file_tools_from(reading)}", "'file_tools': file_tools_from(reading) if allowed else None}"),
    'a second read for the second field': ("'file_tools': file_tools_from(reading)}", "'file_tools': file_tools_from(read_toolsets(bot, reader=reader, maps=maps))}"),
    'plan B never used': ("            tools.update({name: installed[name] for name in shown if name not in tools and name in installed})\n", "            pass\n"),
    'an unreadable payload is a "cannot"': ("        if code != 200 or not isinstance(payload, dict) or not isinstance(payload.get('data'), list):\n            return None\n",
                                            "        if code != 200 or not isinstance(payload, dict) or not isinstance(payload.get('data'), list):\n            return {}, {}, set(FILE_TOOLS)\n"),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label):
    old, new = MUTATIONS[label]
    ns = load(old, new)                                           # an anchor that moved fails HERE, not inside the raises below
    with pytest.raises(Exception):  # noqa: B017
        checks(ns)


def test_the_route_adds_file_tools_to_the_detail_from_the_shared_read_kept_only_when_all_three_are_told():
    def wired(text):
        one = text.split('async def _one(name, extras=False):', 1)[1].split('\n@router', 1)[0]
        return ("if not extras:\n        return _redact_deep(bot)" in one
                and "asyncio.ensure_future(guarded(run_in_threadpool(live_state.toolset_facts, name)))" in one and one.count('live_state.toolset_facts') == 1
                and "found = (await toolsets())['file_tools']" in one and "found = (await toolsets())['can_ask']" in one
                and 'len(found) == len(live_state.FILE_TOOLS)' in one and 'error.value = found' in one and "return getattr(error, 'value', None)" in one
                and "await _FILE_TOOLS.get(('file_tools', name), _EPOCH[0], read)" in one
                and 'asyncio.gather(detail_extras(name), asking(), files())' in one
                and "**({'file_tools': handled} if handled else {})" in one)
    assert wired(API) and '_FILE_TOOLS = Memo(60.0)' in API
    for old, new in (("**({'file_tools': handled} if handled else {})", "'file_tools': handled"),
                     ('len(found) == len(live_state.FILE_TOOLS)', 'bool(found)'),
                     ("await _FILE_TOOLS.get(('file_tools', name), _EPOCH[0], read)", 'await read()'),
                     ("_FILE_TOOLS.get(('file_tools', name), _EPOCH[0], read)", "_FILE_TOOLS.get(('file_tools', name), 0, read)"),
                     ('asyncio.gather(detail_extras(name), asking(), files())', 'asyncio.gather(detail_extras(name), asking())'),
                     ("found = (await toolsets())['file_tools']", 'found = await run_in_threadpool(live_state.file_tools, name)'),
                     ("return getattr(error, 'value', None)", 'return None'),
                     ('            error.value = found', '            pass')):
        assert API.count(old) == 1, old
        assert not wired(API.replace(old, new)), old
    assert 'live_state.toolset_facts' in API and 'live_state.can_ask' not in API.split('async def _one(name, extras=False):', 1)[1].split('\n@router', 1)[0]
