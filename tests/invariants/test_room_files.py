"""Contract v0.6 Part C against the REAL Hermes room: a person's room message with files (POST /rooms/{id}/messages, multipart).
CSRF before the body; the file goes ONLY to the Bots the text wakes, one copy each with the same stored name, written by Hermes's
writer; all or nothing (a recipient without a workspace, a non-member mention, an SVG, 6 files: refused before ANY copy and no
text sent); `room.send` audited first and every copy linked to it; the person's chips come from LuveBot's record of the send; no
byte of a file reaches a response, the log or the audit, and the copy of a file holding a key is refused at download.
The unit side (stand-in Hermes, 9 mutations): tests/unit/backend/test_room_files.py.
"""
import sqlite3
import time
import uuid

import pytest

from support import DASHBOARD
from test_bots import DB, csrf, error_of
from test_pages import terminal, workspace_config  # noqa: F401  (workspace_config is a fixture)
from test_phase5 import log_of, make_room, send, tidy_phase5  # noqa: F401  (tidy_phase5 removes the rooms made here)
from test_plugin import PREFIX

KEY = 'sk-' + '9a8b7c6d5e4f' * 3
PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89' + bytes(32)


def multipart(fields, files):
    boundary = 'luvebot' + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for filename, data in files:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                     'Content-Type: application/octet-stream\r\n\r\n'.encode() + data + b'\r\n')
    return b''.join(parts) + f'--{boundary}--\r\n'.encode(), f'multipart/form-data; boundary={boundary}'


def send_files(browser, room_id, text, files, *, token='valid', **fields):
    body, ctype = multipart({'text': text, 'event_id': 'e-' + str(time.time_ns()), **fields}, files)
    headers = {'Content-Type': ctype, **({'X-LuveBot-CSRF': csrf(browser)} if token == 'valid' else {})}
    return browser.request.post(DASHBOARD + PREFIX + f'/rooms/{room_id}/messages', data=body, headers=headers)


def attachments_in(folder):
    return sorted(p.name for p in (folder / 'attachments').iterdir()) if (folder / 'attachments').is_dir() else []


def audit_since(row_id):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT id, action, outcome, detail, target, origin_ref FROM audit_log WHERE id > ? ORDER BY id', (row_id,)).fetchall()
    finally:
        conn.close()


def last_audit_id():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT coalesce(max(id), 0) FROM audit_log').fetchone()[0]
    finally:
        conn.close()


@pytest.fixture
def two_workspaces(workspace_config, tmp_path):
    ws = {'vendas': tmp_path / 'vendas', 'default': tmp_path / 'default'}
    for folder in ws.values():
        folder.mkdir()
    terminal('vendas', backend='local', cwd=str(ws['vendas']))
    return ws


def test_room_files_csrf_first(human_browser, two_workspaces):
    room = make_room(human_browser, name='t-files csrf')
    started = time.monotonic()
    refused = send_files(human_browser, room['id'], '@vendas veja', [('grande.txt', b'a' * (25 * 1024 * 1024))], token=None)
    assert refused.status == 403 and error_of(refused)['code'] in ('csrf_required', 'csrf_invalid')
    assert attachments_in(two_workspaces['vendas']) == [] and time.monotonic() - started < 30


def test_room_files_only_to_recipients_audited_and_no_secret(human_browser, two_workspaces):
    ws = two_workspaces
    terminal('default', backend='local', cwd=str(ws['default']))
    room = make_room(human_browser, name='t-files only')
    before = last_audit_id()
    text = f'chave {KEY}\n'.encode()
    sent = send_files(human_browser, room['id'], '@vendas veja estes', [('notas.txt', text), ('foto.png', PNG)])
    assert sent.status == 202, sent.text()
    body = sent.json()
    assert body['targets'] == ['vendas'] and KEY not in sent.text()
    assert [(a['name'], a['bots']) for a in body['attachments']] == [('notas.txt', ['vendas']), ('foto.png', ['vendas'])]
    copies = attachments_in(ws['vendas'])
    assert len(copies) == 2 and attachments_in(ws['default']) == []                       # only the Bot the text woke
    assert sorted(c.split('-', 1)[1] for c in copies) == ['foto.png', 'notas.txt']                    # copies sort by uuid
    rows = audit_since(before)
    send_intent = next(r for r in rows if r[1] == 'room.send' and r[3] == 'intent')
    uploads = [r for r in rows if r[1] == 'attachment.upload' and r[3] == 'intent']
    assert len(uploads) == 2 and all(r[0] > send_intent[0] and r[5] == send_intent[5] and r[4].startswith('vendas:') for r in uploads)
    assert KEY not in str(rows)
    events = log_of(human_browser, room['id'])
    mine = next((e for e in events if e.get('kind') == 'message.user' and e.get('attachments')), None)
    assert mine is not None, [(e.get('kind'), e.get('event_id'), sorted(e)) for e in events]
    assert [a['name'] for a in mine['attachments']] == ['notas.txt', 'foto.png'] and KEY not in str(events)
    assert mine['payload']['text'].count('[Anexo: attachments/') == 2
    typed = send(human_browser, room['id'], '@vendas [Anexo: attachments/abc-notas.txt, text/plain, 1 KB]')
    assert typed.status == 202, typed.text()
    events = log_of(human_browser, room['id'])
    line = next(e for e in events if e.get('kind') == 'message.user' and 'abc-notas' in str(e.get('payload')))
    assert 'attachments' not in line                                                         # a typed line gets no chip
    note = next(c for c in copies if c.endswith('notas.txt'))
    got = human_browser.request.get(DASHBOARD + PREFIX + f'/bots/vendas/files/download?path=attachments/{note}&purpose=view')
    assert got.status == 409 and error_of(got)['code'] == 'file_redacted' and KEY not in got.text()


def test_room_files_all_or_nothing(human_browser, two_workspaces):
    ws = two_workspaces                                     # default keeps cwd '.': no workspace
    room = make_room(human_browser, name='t-files all')
    seen = len(log_of(human_browser, room['id']))
    refused = send_files(human_browser, room['id'], '@all veja', [('notas.txt', b'oi')], confirm_cost='true')   # 'all' is the reserved handle
    assert refused.status == 409 and error_of(refused)['code'] == 'workspace_unavailable'
    assert error_of(refused)['details']['bots'] == [{'bot': 'default', 'reason': 'no_workspace'}]
    for text, files, code in (('@ninguem veja', [('notas.txt', b'oi')], 'not_a_member'),
                              ('@vendas veja', [('logo.svg', b'<svg xmlns="http://www.w3.org/2000/svg"/>')], 'attachment_refused'),
                              ('@vendas veja', [(f'n{i}.txt', b'oi') for i in range(6)], 'invalid_field'),
                              ('@vendas veja', [('ok.txt', b'oi'), ('run.txt', b'#!/bin/sh\nrm -rf /\n')], 'attachment_refused')):
        response = send_files(human_browser, room['id'], text, files)
        assert response.status in (409, 413, 415, 422) and error_of(response)['code'] == code, (text, response.status)
    assert attachments_in(ws['vendas']) == [] and attachments_in(ws['default']) == []      # no copy anywhere
    assert len(log_of(human_browser, room['id'])) == seen                                   # and no text sent
