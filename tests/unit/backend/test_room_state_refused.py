"""A refused read of ONE room (plan v0.3 4.4, decided by the Prumo): Hermes v0.22.5 answers an id it does not know with a 404 (`room_not_found`), Hermes `main` with a 422 `invalid_field` that blames a request
that is right (the id already passed LuveBot's `rooms.valid_id`). LuveBot never repeats the 422: on the ERROR PATH only it asks Hermes's own list of groups (disbanded ones too, page by page): an id that is
not in the list is a room that is not there (404 `room_not_found`), an id that is in it is a refusal that is real (502 `hermes_error`), never a 422 and never a guess. The happy path makes no second call.
`_room_state` is what every route that reads one room goes through, so the rule holds for all of them with the same helper. The stand-ins are the Hermes calls; the route text is the real one.
Mutations: one line changed -> red."""
import asyncio
import importlib
import importlib.util
import itertools
import re
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
BACKEND = ROOT / 'backend'
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
_n = itertools.count()
ROOM = 'grp_0123456789ab'


class PluginError(Exception):
    def __init__(self, code, message, status):
        self.code, self.status = code, status
        super().__init__(message)


class HermesError(Exception):
    STATUS = {'hermes_error': 502, 'hermes_unreachable': 503}

    def __init__(self, code):
        self.code, self.status = code, self.STATUS[code]
        super().__init__(code)


def rooms_module():
    name = f'rs_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    return importlib.import_module(f'{name}.rooms')


class Hermes:
    """`state`: what groups.state does (a dict, or an exception to raise). `pages`: [[room ids of a page]...] (the last one has no next_offset); `listed_disbanded`: ids only listed with include_disbanded."""
    def __init__(self, state, pages=(), list_error=None, disbanded=()):
        self.state, self.pages, self.list_error, self.disbanded, self.calls = state, list(pages), list_error, set(disbanded), []

    async def call(self, method, params, **options):
        self.calls.append((method, dict(params)))
        if method == 'groups.state':
            if isinstance(self.state, BaseException):
                raise self.state
            return self.state
        assert method == 'groups.list', method
        if len(self.calls) > 60:
            raise AssertionError('the list is being read without end: a read that never stops is a failed test')
        if self.list_error is not None:
            raise self.list_error
        index = params['offset'] // 100
        ids = [r for r in (self.pages[index] if index < len(self.pages) else []) if params['include_disbanded'] or r not in self.disbanded]
        more = index + 1 < len(self.pages)
        return {'rooms': [{'room_id': r} for r in ids] + [{'room_id': None}, 'not a dict'], **({'next_offset': (index + 1) * 100} if more else {})}


def run(hermes, room_id=ROOM, edits=()):
    """`_room_state` as written in plugin_api.py, against `hermes`. -> ('ok', value) | (code, status), and `hermes.calls`."""
    text = API
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    block = re.search(r"_ROOM_PAGES = 30.*?(?=\n\n\ndef _room_view)", text, re.S).group(0)
    ns = {'PluginError': PluginError, 'HermesError': HermesError, 'rooms': rooms_module(), '_room_call': hermes.call}
    exec(block, ns)
    try:
        return 'ok', asyncio.run(ns['_room_state'](room_id))
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__), getattr(error, 'status', None)


def refused_422():
    return PluginError('invalid_field', 'Hermes refused this request.', 422)


def not_found_404():
    return PluginError('room_not_found', 'Room not found.', 404)


def checks(edits=()):
    # the happy path: the state, and NO second call
    hermes = Hermes({'room': {'room_id': ROOM}})
    assert run(hermes, edits=edits) == ('ok', {'room': {'room_id': ROOM}}) and [c[0] for c in hermes.calls] == ['groups.state'], hermes.calls
    # a refusal, the id NOT in the list: a room that is not there. The 422 of `main` and the 404 of v0.22.5 take the same path
    for refusal in (refused_422, not_found_404):
        hermes = Hermes(refusal(), pages=[['grp_aaaaaaaaaaaa', 'grp_bbbbbbbbbbbb']])
        assert run(hermes, edits=edits) == ('room_not_found', 404), refusal
        assert [c[0] for c in hermes.calls] == ['groups.state', 'groups.list'] and hermes.calls[1][1] == {'include_disbanded': True, 'limit': 100, 'offset': 0}, hermes.calls
    # a refusal, the id IN the list: a real refusal, 502, and NOT 404 and NOT 422 (the mutation "every 422 becomes 404" is red here)
    for refusal in (refused_422, not_found_404):
        hermes = Hermes(refusal(), pages=[['grp_aaaaaaaaaaaa', ROOM]])
        assert run(hermes, edits=edits) == ('hermes_error', 502), refusal
    # the list is read page by page until the id is found or the pages end, and a disbanded room is "in the list"
    hermes = Hermes(refused_422(), pages=[['grp_a' + str(i).zfill(7) for i in range(100)], ['grp_b' + str(i).zfill(7) for i in range(100)], [ROOM]])
    assert run(hermes, edits=edits) == ('hermes_error', 502) and [c[1]['offset'] for c in hermes.calls[1:]] == [0, 100, 200], hermes.calls
    hermes = Hermes(refused_422(), pages=[['grp_0123456789ac', 'grp_01234567ffff']])
    assert run(hermes, edits=edits) == ('room_not_found', 404), 'the id is compared whole, never by its start'
    hermes = Hermes(refused_422(), pages=[[ROOM], ['grp_cccccccccccc']])
    assert run(hermes, edits=edits) == ('hermes_error', 502) and len(hermes.calls) == 2, hermes.calls                                  # found on the first page: no more pages read
    hermes = Hermes(refused_422(), pages=[['grp_aaaaaaaaaaaa'], ['grp_bbbbbbbbbbbb']])
    assert run(hermes, edits=edits) == ('room_not_found', 404) and len(hermes.calls) == 3, hermes.calls                                 # all pages read, not there
    hermes = Hermes(refused_422(), pages=[[ROOM]], disbanded=[ROOM])
    assert run(hermes, edits=edits) == ('hermes_error', 502), 'a disbanded room is listed'
    hermes = Hermes(refused_422(), pages=[['grp_aaaaaaaaaaaa'] for _ in range(100)])                                                     # a list that never ends: a ceiling, then "not there"
    assert run(hermes, edits=edits) == ('room_not_found', 404) and len(hermes.calls) == 31, len(hermes.calls)
    # the second read fails: its own answer for a failure of the server, never the 422 of a request nobody blamed
    for error, want in ((PluginError('capability_missing', 'x', 409), ('capability_missing', 409)), (PluginError('hermes_unreachable', 'x', 503), ('hermes_unreachable', 503)),
                        (PluginError('invalid_field', 'x', 422), ('hermes_error', 502)), (PluginError('room_not_found', 'x', 404), ('hermes_error', 502))):
        hermes = Hermes(refused_422(), list_error=error)
        assert run(hermes, edits=edits) == want, (error.code, run(Hermes(refused_422(), list_error=error), edits=edits))
    # any other failure of the first read is its own answer, with NO second call
    for error in (PluginError('capability_missing', 'x', 409), PluginError('hermes_unreachable', 'x', 503), PluginError('hermes_error', 'x', 502), HermesError('hermes_unreachable')):
        hermes = Hermes(error, pages=[[ROOM]])
        assert run(hermes, edits=edits) == (error.code, error.status) and [c[0] for c in hermes.calls] == ['groups.state'], error.code
    # an id that is not a room id is a 404 before Hermes is asked anything
    for bad in ('x', '123', 'room-nope', '', 'a' * 32, 'grp_' + '0' * 12 + '/../x'):
        hermes = Hermes({'room': {}}, pages=[[ROOM]])
        got = run(hermes, bad, edits=edits)
        if got[0] == 'ok':                                                              # only an id that `rooms.valid_id` accepts may reach Hermes
            assert rooms_module().valid_id(bad), bad
        else:
            assert got == ('room_not_found', 404) and hermes.calls == [], (bad, got, hermes.calls)


def test_a_refused_read_of_one_room_is_told_by_the_list_of_groups_and_only_on_the_error_path():
    checks()


MUTATIONS = {
    'every refusal is a 404': [('    if await _room_listed(room_id):\n        raise HermesError(\'hermes_error\')\n', '    if False:\n        raise HermesError(\'hermes_error\')\n')],
    'every refusal is a 502': [('    if await _room_listed(room_id):\n        raise HermesError(\'hermes_error\')\n', '    if True:\n        raise HermesError(\'hermes_error\')\n')],
    'the 422 is repeated': [("    if await _room_listed(room_id):\n        raise HermesError('hermes_error')\n    raise PluginError('room_not_found', 'Room not found.', 404)",
                             "    if await _room_listed(room_id):\n        raise PluginError('invalid_field', 'Hermes refused this request.', 422)\n    raise PluginError('room_not_found', 'Room not found.', 404)")],
    'the happy path reads the list': [("    try:\n        return await _room_call('groups.state', {'room_id': room_id})", "    await _room_listed(room_id)\n    try:\n        return await _room_call('groups.state', {'room_id': room_id})")],
    'the 404 of v0.22.5 is not read': [("        if error.code not in ('invalid_field', 'room_not_found'):\n            raise\n    if await", "        if error.code != 'invalid_field':\n            raise\n    if await")],
    'the 422 of main is not read': [("        if error.code not in ('invalid_field', 'room_not_found'):\n            raise\n    if await", "        if error.code != 'room_not_found':\n            raise\n    if await")],
    'every failure reads the list': [("        if error.code not in ('invalid_field', 'room_not_found'):\n            raise\n    if await", "        if False:\n            raise\n    if await")],
    'disbanded rooms are not listed': [("{'include_disbanded': True, 'limit': 100, 'offset': offset}", "{'include_disbanded': False, 'limit': 100, 'offset': offset}")],
    'only the first page is read': [("        offset = page.get('next_offset')\n        if not isinstance(offset, int) or isinstance(offset, bool):\n            return False\n    return False", "        return False\n    return False")],
    'the list has no ceiling': [('    for _ in range(_ROOM_PAGES):', '    for _ in range(10 ** 6):')],
    'the id is matched by prefix': [("item.get('room_id') == room_id", "str(item.get('room_id')).startswith(room_id[:8])")],
    'the second failure is the 422': [("            if error.code in ('invalid_field', 'room_not_found'):  # the second read is refused too: nothing is known, and the request is never blamed\n                raise HermesError('hermes_error') from None\n", '')],
    'the second failure is swallowed': [("            raise\n        if any(isinstance(item, dict)", "            return False\n        if any(isinstance(item, dict)")],
    'the happy path is not returned': [("        return await _room_call('groups.state', {'room_id': room_id})\n    except PluginError as error:", "        await _room_call('groups.state', {'room_id': room_id})\n        return None\n    except PluginError as error:")],
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label):
    edits = MUTATIONS[label]
    assert all(API.count(old) == 1 for old, _ in edits), label                      # an anchor that moved fails HERE, not inside the raises below
    with pytest.raises(AssertionError):
        checks(edits)


def test_every_route_that_reads_one_room_goes_through_the_helper_and_the_list_is_read_nowhere_else_for_it():
    reads = [m.group(1) for m in re.finditer(r"@router\.(?:get|post|patch|put|delete)\('/rooms/\{room_id\}[^']*'\)\nasync def (\w+)", API)]
    assert reads, 'no room route found'
    for name in reads:
        body = re.search(rf"async def {name}\(.*?(?=\n\n\n(?:@router|def |async def ))", API, re.S).group(0)
        assert '_room_state(room_id)' in body or '_room_call(' in body or 'rooms.valid_id' in body, name
    assert API.count("'groups.state'") == 1, 'a second place reads one room without the helper'
    assert API.count('_room_listed(') == 2                                           # its definition and its single use, in `_room_state`
