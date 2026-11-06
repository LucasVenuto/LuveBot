"""Contract v0.6 Part C (backend/room_files.py): a person's room message with files. Everything is refused before any copy (6
files, 25 MiB per send, 100 MiB files x recipients, markup, one recipient without a workspace: all or nothing); one copy per
recipient with the SAME stored name, each audited with the send's origin ref; a copy failing midway stops (the text is not sent by
the caller); the `[Anexo: …]` lines wake no one; the person's chips come from LuveBot's record, never from the text; a member's
card author is the member that SENT it. Hermes's file helpers are stubbed (the harness runs the real ones).
Every check also runs against room_files.py with one defect each: each must go red.
"""
import importlib
import importlib.util
import itertools
from pathlib import Path
import sys
import types

import pytest

BACKEND = Path(__file__).resolve().parents[3] / 'backend'
_n = itertools.count()
PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + bytes(64)
MEMBERS = [{'member_id': 'mem-a', 'bot': 'vendas', 'handle': 'vendas', 'display_name': None},
           {'member_id': 'mem-b', 'bot': 'suporte', 'handle': 'sup', 'display_name': None},
           {'member_id': 'mem-c', 'bot': 'dev', 'handle': 'dev', 'display_name': None}]


def load(edit=None):
    name = f'roomfiles_backend_{next(_n)}'
    spec = importlib.util.spec_from_file_location(name, BACKEND / '__init__.py', submodule_search_locations=[str(BACKEND)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[name] = package
    spec.loader.exec_module(package)
    rooms = importlib.import_module(f'{name}.rooms')
    if not edit:
        return importlib.import_module(f'{name}.room_files'), rooms
    source = (BACKEND / 'room_files.py').read_text()
    assert source.count(edit[0]) == 1, edit[0]
    module = importlib.util.module_from_spec(importlib.util.spec_from_loader(f'{name}.room_files', loader=None))
    module.__package__ = name
    sys.modules[module.__name__] = module
    exec(compile(source.replace(*edit), str(BACKEND / 'room_files.py'), 'exec'), module.__dict__)
    return module, rooms


@pytest.fixture
def hermes(monkeypatch):
    files = types.ModuleType('hermes_cli.web_routers.files')
    files._CHAT_IMAGE_ALLOWED_EXTENSIONS = {'.png'}
    files._chat_image_extension = lambda data: '.png' if data.startswith(b'\x89PNG') else None
    files._is_sensitive_filename = lambda name: name.lower().startswith('.env')
    for name, module in (('hermes_cli', types.ModuleType('hermes_cli')), ('hermes_cli.web_routers', types.ModuleType('hermes_cli.web_routers')),
                         ('hermes_cli.web_routers.files', files)):
        monkeypatch.setitem(sys.modules, name, module)


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append(('intent', action, target, origin['ref'], bot))
        result = fn()
        self.rows.append(('result', action, target))
        return result


def code_of(fn, *args):
    """The result, or the error's code: a defect shows as a failed assertion, never as an unexpected exception."""
    try:
        return fn(*args)
    except Exception as error:  # noqa: BLE001
        return getattr(error, 'code', type(error).__name__)


def checks(rf, rooms, tmp_path, monkeypatch):
    pages = rf.pages
    big = b'%PDF-' + bytes(9 * 1024 * 1024)
    assert code_of(rf.checked, [('a.txt', b'oi')] * 6) == 'invalid_field'                               # 6 files
    assert code_of(rf.checked, [('a.pdf', big), ('b.pdf', big), ('c.pdf', big)]) == 'too_large'       # 27 MiB together
    for name, data in (('x.svg', b'<svg/>'), ('x.txt', b'<html>oi</html>'), ('x.exe', b'MZ\x90\x00'), ('.env.txt', b'A=1')):
        assert code_of(rf.checked, [('ok.txt', b'texto'), (name, data)]) in ('attachment_refused',), name
    items = code_of(rf.checked, [('Relatório @todos final.txt', 'conteúdo'.encode()), ('foto.png', PNG)])
    assert isinstance(items, list) and [i['name'] for i in items] == ['Relatorio-todos-final.txt', 'foto.png']

    targets = [MEMBERS[0], MEMBERS[1]]
    assert code_of(rf.check_fanout, [{'size': 30 * 1024 * 1024}] * 2, targets) == 'too_large'       # 60 MiB x 2 Bots
    assert code_of(rf.check_fanout, [{'size': 20 * 1024 * 1024}], targets) is None                   # 40 MiB: fine

    roots = {'vendas': tmp_path / 'v', 'suporte': tmp_path / 's'}
    monkeypatch.setattr(pages, 'workspace', lambda bot: ('ready', str(roots[bot])) if bot in roots else ('no_workspace', None))
    refused = None
    try:
        rf.workspaces([*targets, MEMBERS[2]])
    except rf.PluginError as error:
        refused = error
    assert refused is not None and refused.code == 'workspace_unavailable'
    assert refused.extra['details']['bots'] == [{'bot': 'dev', 'reason': 'no_workspace'}]
    found = code_of(rf.workspaces, targets)
    assert found == {'vendas': str(roots['vendas']), 'suporte': str(roots['suporte'])}

    stored = '@vendas @sup veja os arquivos'
    final = rf.final_text(stored, items)
    assert final.startswith(stored) and final.count('[Anexo: attachments/') == 2 and '@' not in final[len(stored):]
    again, _ = rooms.check_send(final, MEMBERS, None)
    assert [t['handle'] for t in again] == ['vendas', 'sup']                                          # the lines wake no one

    writes, audit = [], Audit()
    monkeypatch.setattr(pages, '_write_attachment', lambda root, name, data: writes.append((root, name, len(data))))
    rf.copy_all(audit, 'ana', items, found, ['d1', 'd2'], 'req_send')
    assert [(Path(r).name, n) for r, n, _ in writes] == [('v', items[0]['stored']), ('s', items[0]['stored']),
                                                         ('v', items[1]['stored']), ('s', items[1]['stored'])]   # same name in every Bot
    intents = [r for r in audit.rows if r[0] == 'intent']
    assert intents == [('intent', 'attachment.upload', 'vendas:d1', 'req_send', 'vendas'), ('intent', 'attachment.upload', 'suporte:d1', 'req_send', 'suporte'),
                       ('intent', 'attachment.upload', 'vendas:d2', 'req_send', 'vendas'), ('intent', 'attachment.upload', 'suporte:d2', 'req_send', 'suporte')]

    def fail_on_second(root, name, data):
        if writes:
            raise rf.PluginError('hermes_error', 'x', 502)
        writes.append(name)
    writes.clear()
    monkeypatch.setattr(pages, '_write_attachment', fail_on_second)
    assert code_of(rf.copy_all, Audit(), 'ana', items, found, ['d1', 'd2'], 'req_x') == 'hermes_error' and len(writes) == 1

    db = tmp_path / 'luvebot.db'
    view = rf.view(items, found)
    assert [v['bots'] for v in view] == [['vendas', 'suporte']] * 2 and 'data' not in view[0] and 'stored' not in view[0]
    rf.record(db, 'room-1', 'e-files', view)
    sends = rf.recorded(db, 'room-1', ['e-files', 'e-typed'])
    assert sends == {'e-files': view} and rf.recorded(db, 'room-2', ['e-files']) == {}
    events = [{'kind': 'message.user', 'event_id': 'e-files', 'actor': {'kind': 'user', 'id': 'desktop'}, 'payload': {'text': final}},
              {'kind': 'message.user', 'event_id': 'e-typed', 'actor': {'kind': 'user', 'id': 'desktop'},
               'payload': {'text': '[Anexo: attachments/x-segredo.txt, text/plain, 1 KB]'}},
              {'kind': 'message.member', 'event_id': 'm1', 'actor': {'kind': 'member', 'id': 'mem-b', 'profile': 'suporte'}, 'payload': {}},
              {'kind': 'message.member', 'event_id': 'm2', 'actor': {'kind': 'member', 'id': 'mem-x', 'profile': 'dev'}, 'payload': {}},
              {'kind': 'message.member', 'event_id': 'm3', 'actor': {'kind': 'member', 'id': 'mem-a', 'profile': 'suporte'}, 'payload': {}},
              {'kind': 'message.member', 'event_id': 'm4', 'actor': {'kind': 'member', 'id': 'vendas', 'display_name': 'vendas'}, 'payload': {}}]
    shown = rf.annotate(events, MEMBERS, sends)
    assert shown[0]['attachments'] == view and 'attachments' not in shown[1]                         # a typed line: no chip
    assert [e.get('author_bot') for e in shown[2:]] == ['suporte', 'dev', None, None]                 # by the sender, never guessed


def test_room_files_all_or_nothing_and_only_to_recipients(hermes, tmp_path, monkeypatch):
    checks(*load(), tmp_path, monkeypatch)


@pytest.mark.parametrize('edit', [
    ("    if len(files) > FILES_MAX:\n", "    if False:\n"),
    ("    if sum(len(data) for _name, data in files) > SEND_MAX:\n", "    if False:\n"),
    ("    if total > FANOUT_MAX:\n", "    if False:\n"),
    ("        if state in ('ready', 'empty'):\n            roots[target['bot']] = root\n        else:\n",
     "        if True:\n            roots[target['bot']] = root\n        else:\n"),
    ("        items.append({'stored': f'{uuid.uuid4().hex}-{name}',", "        items.append({'stored': f'{uuid.uuid4().hex}-{_original}',"),
    ("lambda root=root, item=item: pages._write_attachment(root, item['stored'], item['data'])",
     "lambda root=root, item=item: pages._write_attachment(root, uuid.uuid4().hex + item['name'], item['data'])"),
    ("{'kind': 'ui', 'ref': origin_ref},\n", "{'kind': 'ui', 'ref': 'req_' + uuid.uuid4().hex},\n"),
    ("        if event.get('kind') == 'message.user' and event.get('event_id') in sends:",
     "        if event.get('kind') == 'message.user' and '[Anexo:' in str(event.get('payload')):"),
    ("            if author is None and profile in bots:\n", "            if profile in bots:\n"),
], ids=['six_files', 'no_send_cap', 'no_fanout_cap', 'workspace_not_checked', 'name_as_sent', 'name_differs_per_bot',
        'copies_not_linked_to_the_send', 'chips_from_the_text', 'author_from_the_profile_field_alone'])
def test_each_mutation_is_caught(hermes, tmp_path, monkeypatch, edit):
    with pytest.raises(AssertionError):
        checks(*load(edit), tmp_path, monkeypatch)
