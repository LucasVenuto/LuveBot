"""`@todos` in a room (the Vitral's finding): the screen offers "todos — Acionar todos os membros" and `rooms.RESERVED` knew only `all` and `everyone`, so a typed `@todos` was a 422
`not_a_member`. Now `todos` is reserved too and means exactly what `@all` means, END TO END:
* `check_send`: `@todos` (any case, anywhere in the text, next to a member or not) wakes every member, needs the cost confirmation, and never counts as an unknown handle;
* the text that goes to Hermes carries `@all` where the person typed `@todos`: Hermes reserves only all and everyone (hosted_room_discussion.py `resolve_mentions`), so `@todos` ALONE
  would still wake everyone there (nothing valid named: its default), but `@todos @ana` would wake ONLY Ana: the prediction and the delivery would differ;
* a room whose member handle is literally `todos` (Hermes allows it; LuveBot's own create refuses it now) keeps its member: `@todos` is that member, the text is not rewritten;
* a roster cannot take `todos` as a handle (like all and everyone); a non-member next to `@todos` is still refused, naming only the non-member.
Mutations: `todos` not reserved; the text not rewritten (the mixed case); a member named todos does not win; the rewrite also eats other handles."""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
MEMBERS = [{'handle': 'vendas', 'bot': 'vendas', 'member_id': 'm1'}, {'handle': 'ana', 'bot': 'default', 'member_id': 'm2'}, {'handle': 'fin', 'bot': 'fin', 'member_id': 'm3'}]
TODOS_MEMBER = [{'handle': 'todos', 'bot': 'todos', 'member_id': 'm9'}, {'handle': 'ana', 'bot': 'default', 'member_id': 'm2'}]


def load(old=None, new=None):
    name = f'rt_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    if old is None:
        return importlib.import_module(f'{name}.rooms')
    source = (BACKEND / 'rooms.py').read_text()
    assert source.count(old) == 1, old
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.rooms', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(old, new), str(BACKEND / 'rooms.py'), 'exec'), module.__dict__)
    return module


def code_of(fn, *args):
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001 - a defect shows as a failed assertion
        return getattr(error, 'code', type(error).__name__), getattr(error, 'extra', None)


def handles(targets):
    return [t['handle'] for t in targets]


def checks(rooms):
    send = rooms.check_send
    everyone = ['vendas', 'ana', 'fin']
    assert handles(send('@todos report', MEMBERS)[0]) == everyone                                   # the screen's word: every member
    assert handles(send('report @Todos', MEMBERS)[0]) == everyone and handles(send('@TODOS', MEMBERS)[0]) == everyone     # any case, anywhere
    assert handles(send('@all report', MEMBERS)[0]) == everyone and handles(send('@everyone', MEMBERS)[0]) == everyone    # the others, as before
    assert rooms.needs_confirmation(send('@todos', MEMBERS)[0])                                      # the same cost confirmation as @all
    # what Hermes receives
    assert send('@todos report', MEMBERS)[1] == '@all report'
    assert send('report @Todos now', MEMBERS)[1] == 'report @all now'
    targets, stored = send('@todos @ana and @vendas, go', MEMBERS)
    assert handles(targets) == everyone and stored == '@all @ana and @vendas, go'                    # the mixed case: Hermes would have woken only the named ones
    assert send('todos os dias', MEMBERS)[1] == 'todos os dias'                                       # a word is not a mention
    assert send('@all report', MEMBERS)[1] == '@all report' and send('@vendas go', MEMBERS)[1] == '@vendas go'    # nothing else is touched
    # a non-member is still refused, and only it is named
    refused = code_of(send, '@todos @ghost go', MEMBERS)
    assert refused[0] == 'not_a_member' and refused[1]['details']['handles'] == ['ghost'], refused
    assert code_of(send, 'mail me @todos.com', MEMBERS)[0] == 'not_a_member'                         # `todos.com` is one handle, as in Hermes
    # a room whose member is called `todos` (Hermes made it so): that member wins, the text goes as typed
    targets, stored = send('@todos report', TODOS_MEMBER)
    assert handles(targets) == ['todos'] and stored == '@todos report', (handles(targets), stored)
    assert handles(send('@all report', TODOS_MEMBER)[0]) == ['todos', 'ana']                          # @all is still everyone
    # a roster cannot take it
    for handle in ('todos', 'TODOS', 'all', 'everyone'):
        body = {'name': 'sala', 'members': [{'bot': 'a', 'handle': handle}, {'bot': 'b'}]}
        assert code_of(rooms.validate_create, body)[0] == 'invalid_field', handle
    assert not isinstance(code_of(rooms.validate_create, {'name': 'sala', 'members': [{'bot': 'a'}, {'bot': 'b'}]}), tuple)   # an ordinary roster is fine


def test_todos_means_everyone_in_a_room_end_to_end():
    checks(load())


MUTATIONS = {
    'todos is not reserved': ('RESERVED = {"all", "everyone", "todos"}', 'RESERVED = {"all", "everyone"}'),
    'the text is not rewritten': ('    stored = hermes_text(text, by_handle)\n', '    stored = text\n'),
    'a member named todos does not win (rewrite)': ('    if "todos" in by_handle:\n        return text\n', ''),
    'a member named todos does not win (targets)': ('any(h in RESERVED and h not in by_handle for h in named)', 'any(h in RESERVED for h in named)'),
    'the rewrite eats every handle': ('"@all" if m.group(1).casefold() == "todos" else m.group(0)', '"@all"'),
    'the rewrite is case sensitive': ('m.group(1).casefold() == "todos"', 'm.group(1) == "todos"'),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label):
    old, new = MUTATIONS[label]
    rooms = load(old, new)                                         # an anchor that moved fails HERE, not inside the raises below
    with pytest.raises(Exception):  # noqa: B017
        checks(rooms)
