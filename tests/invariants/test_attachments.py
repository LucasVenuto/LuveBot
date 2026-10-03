"""T14: attachments in the chat (ADR-005; backend/pages.py save_attachment, POST /bots/{bot}/attachments) and the working folder of
a Bot without terminal.cwd (set_own_workspace, POST /bots/{bot}/workspace).

Part 1 runs the REAL module in-process against the real Hermes (its image byte check, its sensitive-name guard, its upload writer,
its config writer) and the same module with ONE defect per mutation, which must turn its invariant red (pattern of test_pages.py).
Part 2 goes through the dashboard routes (401 without a session: test_plugin.py walks every route), and a real run proves the Bot of the default profile works in the folder it was given.
"""
import hashlib
import io
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import uuid
import zipfile

import pytest

from support import DASHBOARD, plugin
from test_bots import DB, audit_rows, csrf, error_of, post
from test_pages import load, off_loop, terminal, workspace_config  # noqa: F401  (workspace_config is a fixture)
from test_plugin import PREFIX

PNG = b'\x89PNG\r\n\x1a\n' + bytes(range(256))
JPG = b'\xff\xd8\xff\xe0' + bytes(64)
PDF = b'%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n'
HERMES_WS = Path('/root/.hermes/workspace')


def office(main_part):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as z:
        z.writestr('[Content_Types].xml', '<Types/>')
        z.writestr(main_part, '<x/>')
    return buffer.getvalue()


def plain_zip():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as z:
        z.writestr('run.sh', '#!/bin/sh\necho hi\n')
    return buffer.getvalue()


class Ctx:
    def __init__(self, m, tmp):
        self.m, self.tmp = m, tmp
        self.ws, self.outside = tmp / 'ws', tmp / 'outside'
        self.ws.mkdir()
        self.outside.mkdir()
        self.db_path = tmp / 'luvebot.db'
        self.audit = m.audit.AuditLog(self.db_path)
        from luvebot_backend.runs import RunIndex
        self.index = RunIndex(tmp / 'runs.db')                                     # the per-database HMAC key (run_digest_key)
        terminal('vendas', backend='local', cwd=str(self.ws))

    def save(self, name, data, bot='vendas'):
        return self.m.pages.save_attachment(self.audit, self.index.keyed_digest, 'basic:ana', bot, name, data, 'req_' + uuid.uuid4().hex)

    def code(self, name, data):
        try:
            self.save(name, data)
        except self.m.api_errors.PluginError as error:
            return error.code, (error.extra or {}).get('details', {}).get('reason')
        return 'saved', None

    def rows(self):
        conn = sqlite3.connect(self.db_path)
        try:
            return conn.execute('SELECT * FROM audit_log').fetchall()
        finally:
            conn.close()

    def files(self, folder=None):
        folder = folder or self.ws / 'attachments'
        return sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []


def hermes_writer(monkeypatch, before_write):
    """Wrap Hermes's upload writer (looked up at call time by the module) so a test can act at the moment of the write."""
    import hermes_cli.web_routers.files as files
    original = files.stream_upload_to_path

    async def wrapped(file, target, **kwargs):
        before_write(target)
        return await original(file, target, **kwargs)
    monkeypatch.setattr(files, 'stream_upload_to_path', wrapped)


# ---------------------------------------------------------------------------------------------------------------------
# Part 1: invariants
# ---------------------------------------------------------------------------------------------------------------------
def inv_types_by_bytes(m, tmp, monkeypatch):
    """A closed list decided by the bytes; the stored name carries the detected type, never the browser's."""
    c = Ctx(m, tmp)
    for name, data, kind in (('foto.png', PNG, 'png'), ('foto.jpeg', JPG, 'jpg'), ('scan.PDF', PDF, 'pdf'),
                             ('notas.txt', 'olá\n'.encode(), 'txt'), ('plano.md', b'# Plano\n<b>ok</b>\n', 'md'),
                             ('dados.csv', b'a,b\n1,2\n', 'csv'), ('x.json', b'{"a": 1}', 'json'),
                             ('contrato.docx', office('word/document.xml'), 'docx'), ('planilha.xlsx', office('xl/workbook.xml'), 'xlsx'),
                             ('marcas.txt', b'BMW e Audi\n', 'txt'),                # 'BM' is no image here (no BMP at all)
                             ('pagina.html', PNG, 'png')):                       # an image whatever the name says
        got = c.save(name, data)
        assert got['name'].endswith('.' + kind) and got['size'] == len(data), (name, got)
    for name, data in (('logo.svg', b'<svg xmlns="http://www.w3.org/2000/svg"/>'), ('logo.txt', b'<svg onload="x()"/>'),
                       ('pagina.html', b'<html><script>1</script></html>'), ('pagina.txt', b'  <!DOCTYPE html><p>x'),
                       ('feed.md', b'<?xml version="1.0"?><rss/>'), ('run.txt', b'#!/bin/sh\nrm -rf ~\n'),
                       ('app.png', b'\x7fELF\x02\x01\x01' + bytes(64)), ('setup.exe', b'MZ\x90\x00' + bytes(64)),
                       ('arquivo.docx', plain_zip()), ('quebrado.pdf', b'%PDX'), ('bin.txt', b'a\0b'),
                       ('foto.bmp', b'BM' + bytes(64)), ('foto2.png', b'BM6\x00' + bytes(64)),
                       ('latin.txt', 'olá'.encode('latin-1')), ('sem-extensao', b'texto'), ('script.py', b'print(1)')):
        assert c.code(name, data) == ('attachment_refused', 'type'), name
    assert m.pages.clean_name('../../Relatório Final (v2).PDF', 'pdf') == 'Relatorio-Final-v2.pdf'
    assert m.pages.clean_name('...', 'png') == 'anexo.png' and m.pages.clean_name('a/b\\.c.txt', 'txt') == 'c.txt'


def inv_caps(m, tmp, monkeypatch):
    """10 MB for images, 20 MB for documents, checked before anything is written."""
    c = Ctx(m, tmp)
    mb = 1024 * 1024
    assert c.save('grande.png', PNG + bytes(10 * mb - len(PNG)))['size'] == 10 * mb
    assert c.code('enorme.png', PNG + bytes(10 * mb + 1 - len(PNG))) == ('too_large', None)
    assert c.save('grande.pdf', PDF + bytes(15 * mb))['type'] == 'application/pdf'
    assert c.code('enorme.pdf', PDF + bytes(20 * mb + 1 - len(PDF))) == ('too_large', None)
    assert len(c.files()) == 2


def inv_sensitive_names(m, tmp, monkeypatch):
    """Hermes's credential basenames (web_routers/files.py _is_sensitive_filename) are never kept, even with valid bytes."""
    c = Ctx(m, tmp)
    for name in ('auth.json', 'AUTH.JSON', 'google_token.json', 'webhook_subscriptions.json', 'pasta/bws_cache.json'):
        assert c.code(name, b'{"token": "x"}') == ('attachment_refused', 'sensitive_name'), name
    assert c.files() == []


def inv_confined_write(m, tmp, monkeypatch):
    """Inside <workspace>/attachments only, under a new server-chosen name, 0700 folder and 0600 file, nothing replaced; a link
    or a file in place of the folder is refused, and a folder swapped for a link during the write leaves nothing outside."""
    c = Ctx(m, tmp)
    first, second = c.save('foto.png', PNG), c.save('foto.png', PNG)
    assert first['path'] != second['path'] and first['path'].startswith('attachments/') and first['path'].endswith('-foto.png')
    target = c.ws / first['path']
    assert target.read_bytes() == PNG and stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE((c.ws / 'attachments').stat().st_mode) == 0o700
    assert sorted(p.name for p in c.ws.iterdir()) == ['attachments'] and len(c.files()) == 2
    assert first['reference'] == f"[Anexo: {first['path']}, image/png, 1 KB]"
    shutil.rmtree(c.ws / 'attachments')
    os.symlink(c.outside, c.ws / 'attachments')                                    # a link where the folder should be
    assert c.code('foto.png', PNG) == ('workspace_unavailable', 'unsafe') and c.files(c.outside) == []
    os.unlink(c.ws / 'attachments')
    (c.ws / 'attachments').write_text('x')                                          # a file where the folder should be
    assert c.code('foto.png', PNG) == ('workspace_unavailable', 'unsafe')
    os.unlink(c.ws / 'attachments')
    (c.ws / 'attachments').mkdir(0o700)

    def swap(path):                                                                 # the Bot swaps the folder during the write
        os.rename(c.ws / 'attachments', c.ws / 'old')
        os.symlink(c.outside, c.ws / 'attachments')
    hermes_writer(monkeypatch, swap)
    assert c.code('foto.png', PNG) == ('workspace_unavailable', 'unsafe')
    assert c.files(c.outside) == [] and c.files(c.ws / 'old') == []


def inv_audit_first(m, tmp, monkeypatch):
    """The intent row (HMAC, size, type and clean name, as the payload digest; target = the content's HMAC with this
    database's key, never a plain sha256 a known file could be looked up by) is written before Hermes writes the file; no row
    carries the bytes or the name. With the audit down, nothing is written."""
    c = Ctx(m, tmp)
    seen = []
    hermes_writer(monkeypatch, lambda path: seen.append([r for r in c.rows() if 'attachment.upload' in r]))
    c.save('Relatório secreto.txt', b'conteudo-canario\n')
    assert len(seen) == 1 and len(seen[0]) == 1 and 'intent' in seen[0][0], seen
    rows = [r for r in c.rows() if 'attachment.upload' in r]
    assert len(rows) == 2 and c.index.keyed_digest(b'conteudo-canario\n') in rows[0]
    assert hashlib.sha256(b'conteudo-canario\n').hexdigest() not in str(c.rows())
    assert not any('canario' in str(r) or 'secreto' in str(r) for r in c.rows())
    conn = sqlite3.connect(c.db_path)                                                # the audit can no longer write
    conn.execute("CREATE TRIGGER down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'down'); END")
    conn.commit()
    conn.close()
    with pytest.raises(m.audit.AuditUnavailable):
        c.save('outro.txt', b'x\n')
    assert len(c.files()) == 1


def inv_own_workspace_set(m, tmp, monkeypatch):
    """A Bot without terminal.cwd gets <its home>/workspace through Hermes's config writer; never over a cwd the owner set."""
    c = Ctx(m, tmp)
    made = not HERMES_WS.exists()
    try:
        terminal('default', cwd='.')
        assert m.pages.workspace('default') == ('no_workspace', None)
        assert m.pages.set_own_workspace(c.audit, 'basic:ana', 'default', 'req_1') in ('ready', 'empty')
        # the Maestro's point 4: <home of default>/workspace sits INSIDE the Hermes root and still passes workspace()
        assert os.path.realpath(HERMES_WS).startswith('/root/.hermes/') and HERMES_WS.is_dir()
        assert m.pages.workspace('default') in (('empty', os.path.realpath(HERMES_WS)), ('ready', os.path.realpath(HERMES_WS)))
        terminal('vendas', cwd=str(HERMES_WS))                                            # the same folder is not vendas's own
        assert m.pages.workspace('vendas') == ('inside_hermes', None)
        terminal('vendas', cwd=str(c.ws))
        assert len([r for r in c.rows() if 'bot.workspace.set' in r]) == 2               # audited: intent + result
        with pytest.raises(m.api_errors.PluginError) as again:                            # already set: kept
            m.pages.set_own_workspace(c.audit, 'basic:ana', 'default', 'req_2')
        assert again.value.code == 'workspace_not_changed'
        broken = str(tmp / 'nao-existe')
        terminal('vendas', cwd=broken)                                                    # the owner's cwd, even broken: kept
        with pytest.raises(m.api_errors.PluginError) as kept:
            m.pages.set_own_workspace(c.audit, 'basic:ana', 'vendas', 'req_3')
        assert kept.value.code == 'workspace_not_changed'
        from hermes_cli.config import load_config
        from hermes_cli.web_server_profiles import _config_profile_scope
        with _config_profile_scope('vendas'):
            assert load_config()['terminal']['cwd'] == broken
    finally:
        if made:
            shutil.rmtree(HERMES_WS, ignore_errors=True)


def raw_cwd(bot):
    from hermes_cli.config import read_raw_config
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        raw = read_raw_config().get('terminal')
    return raw.get('cwd') if isinstance(raw, dict) else None


def inv_workspace_undo(m, tmp, monkeypatch):
    """If the final check fails after Hermes wrote terminal.cwd, the previous value and a folder made here are put back."""
    c = Ctx(m, tmp)
    made = not HERMES_WS.exists()
    try:
        terminal('default', cwd='.')
        before, real, calls = raw_cwd('default'), m.pages.workspace, []

        def failing_check(bot):
            calls.append(bot)
            return real(bot) if len(calls) == 1 else ('inside_hermes', None)
        monkeypatch.setattr(m.pages, 'workspace', failing_check)
        with pytest.raises(m.api_errors.PluginError) as error:
            m.pages.set_own_workspace(c.audit, 'basic:ana', 'default', 'req_undo')
        assert error.value.code == 'hermes_error' and len(calls) == 2
        assert raw_cwd('default') == before == '.', raw_cwd('default')
        assert HERMES_WS.exists() is not made                                              # made here -> removed again
        conn = sqlite3.connect(c.db_path)
        try:
            outcomes = conn.execute("SELECT outcome, detail FROM audit_log WHERE action = 'bot.workspace.set'").fetchall()
        finally:
            conn.close()
        assert outcomes == [('ok', 'intent'), ('error', 'result')], outcomes                # audited, and the failure recorded
    finally:
        if made:
            shutil.rmtree(HERMES_WS, ignore_errors=True)


INVARIANTS = {name[4:]: fn for name, fn in dict(globals()).items() if name.startswith('inv_')}
MUTATIONS = [
    ('types_by_bytes', 'markup and scripts accepted as text', "    if text.lstrip('\\ufeff \\t\\r\\n').lower().startswith(MARKUP):\n        return None\n", ''),
    ('types_by_bytes', 'any zip is a document',
     "return next(((e, mime, DOC_MAX) for e, (part, mime) in OFFICE.items() if '[Content_Types].xml' in names and part in names), None)",
     "return 'docx', OFFICE['docx'][1], DOC_MAX"),
    ('types_by_bytes', 'any text extension accepted', "if claimed not in TEXT_MIME or b'\\0' in data:", "if b'\\0' in data:"),
    ('types_by_bytes', 'BMP accepted by its 2 bytes', '    if ext in _CHAT_IMAGE_ALLOWED_EXTENSIONS and ext in IMAGE_MIME:',
     "    if ext in _CHAT_IMAGE_ALLOWED_EXTENSIONS:\n        IMAGE_MIME.setdefault('.bmp', 'image/bmp')"),
    ('caps', 'images get the document cap', 'return ext[1:].replace(\'jpeg\', \'jpg\'), IMAGE_MIME[ext], IMAGE_MAX',
     'return ext[1:].replace(\'jpeg\', \'jpg\'), IMAGE_MIME[ext], DOC_MAX'),
    ('sensitive_names', 'credential names kept', "    if _is_sensitive_filename(original) or _is_sensitive_filename(name):\n        raise attachment_refused('sensitive_name')\n", ''),
    ('confined_write', 'a link in place of the folder is followed', 'fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
     'fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)'),
    ('confined_write', 'a swap during the write is not checked', "        if st is None or not stat.S_ISREG(st.st_mode) or st.st_size != len(data):",
     "        if False:"),
    ('confined_write', "the browser's name is kept", "    stored = f'{uuid.uuid4().hex}-{name}'", "    stored = original or name"),
    ('audit_first', 'written before the audit',
     "    audit.act(actor, 'attachment.upload', digest, {'kind': 'ui', 'ref': origin_ref}, lambda: _write_attachment(root, stored, data),",
     "    _write_attachment(root, stored, data)\n    audit.act(actor, 'attachment.upload', digest, {'kind': 'ui', 'ref': origin_ref}, lambda: None,"),
    ('audit_first', 'the name goes to the audit target',
     "    audit.act(actor, 'attachment.upload', digest, {'kind': 'ui', 'ref': origin_ref}, lambda: _write_attachment(root, stored, data),",
     "    audit.act(actor, 'attachment.upload', name, {'kind': 'ui', 'ref': origin_ref}, lambda: _write_attachment(root, stored, data),"),
    ('audit_first', 'plain sha256 as the target', '    digest = keyed(data)', '    digest = sha256(data)'),
    ('own_workspace_set', 'the own workspace of default refused (inside_hermes)', "    mine = real == own or real.startswith(own + '/')",
     '    mine = False'),
    ('workspace_undo', 'a failed check leaves the new cwd',
     "            with _config_profile_scope(bot):\n                if previous is None:\n                    unset_config_value('terminal.cwd')\n                else:\n                    set_config_value('terminal.cwd', previous)\n", ''),
    ('own_workspace_set', "the owner's cwd is replaced", "    if state != 'no_workspace' or (isinstance(cwd, str) and cwd.strip() not in NOT_SET):",
     "    if state not in ('no_workspace', 'ready', 'empty'):"),
]


@pytest.fixture
def isolated(workspace_config, tmp_path):
    yield tmp_path


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(isolated, monkeypatch, name):
    off_loop(INVARIANTS[name], load(isolated), isolated, monkeypatch)


def test_every_invariant_has_a_mutation():
    assert {m[0] for m in MUTATIONS} == set(INVARIANTS)


RESULTS = []


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(isolated, monkeypatch, invariant, label, old, new):
    variant = load(isolated, (old, new))
    try:
        off_loop(INVARIANTS[invariant], variant, isolated, monkeypatch)
    except BaseException as error:  # noqa: BLE001  (red = the invariant noticed)
        RESULTS.append((invariant, label, 'RED: ' + type(error).__name__))
        return
    RESULTS.append((invariant, label, 'SURVIVED'))
    pytest.fail(f'mutation survived: {invariant} / {label}')


def test_zz_print_the_mutation_table():
    print('\n| invariant | mutation | result |\n|---|---|---|')
    for row in RESULTS:
        print('| ' + ' | '.join(row) + ' |')


# ---------------------------------------------------------------------------------------------------------------------
# Part 2: the routes
# ---------------------------------------------------------------------------------------------------------------------
def upload(browser, bot, name, data, mime='application/octet-stream', token='valid'):
    headers = {} if token is None else {'X-LuveBot-CSRF': csrf(browser) if token == 'valid' else token}
    return browser.request.post(DASHBOARD + PREFIX + f'/bots/{bot}/attachments', headers=headers,
                                multipart={'file': {'name': name, 'mimeType': mime, 'buffer': data}})


def test_attachment_route(human_browser, workspace_config, tmp_path):
    ws = tmp_path / 'ws'
    ws.mkdir()
    terminal('vendas', backend='local', cwd=str(ws))
    before = len(audit_rows('attachment.upload'))
    got = upload(human_browser, 'vendas', 'Relatório.pdf', PDF, 'image/svg+xml')        # the browser's type is ignored
    assert got.status == 201, got.text()
    att = got.json()['attachment']
    assert set(att) == {'path', 'name', 'type', 'size', 'reference'} and att['type'] == 'application/pdf'
    assert (ws / att['path']).read_bytes() == PDF and att['name'] == 'Relatorio.pdf' and str(ws) not in got.text()
    rows = audit_rows('attachment.upload')[before:]
    from luvebot_backend.runs import RunIndex
    assert [r[1:3] for r in rows] == [('ok', 'intent'), ('ok', 'result')] and rows[0][3] == RunIndex(DB).keyed_digest(PDF)
    assert rows[0][3] != hashlib.sha256(PDF).hexdigest()
    svg = upload(human_browser, 'vendas', 'logo.svg', b'<svg onload="x()"/>', 'image/png')
    assert svg.status == 415 and error_of(svg)['code'] == 'attachment_refused' and error_of(svg)['details'] == {'reason': 'type'}
    assert upload(human_browser, 'vendas', 'a.png', PNG, token=None).status == 403            # CSRF
    assert upload(human_browser, 'vendas', 'a.png', PNG, token='forjado').status == 403
    big = upload(human_browser, 'vendas', 'big.pdf', PDF + bytes(21 * 1024 * 1024))
    assert big.status == 413 and error_of(big)['code'] == 'too_large'
    assert len(audit_rows('attachment.upload')) == before + 2                                   # refusals wrote nothing
    terminal('vendas', cwd='.')
    off = upload(human_browser, 'vendas', 'a.png', PNG)
    assert off.status == 409 and error_of(off)['code'] == 'workspace_unavailable' and error_of(off)['details'] == {'reason': 'no_workspace'}


def test_the_default_bot_gets_its_folder_and_works_in_it(human_browser, workspace_config):
    """The VPS case: the default profile as installed (no terminal.cwd) -> one click -> Pages and attachments work, and the
    Bot's next run really runs in that folder (no restart): the fake model writes pages/do-bot.md with its terminal tool."""
    from test_hook import wait_live
    from test_runs import wait_run
    made = not HERMES_WS.exists()
    try:
        terminal('default', cwd='.')
        state = lambda: human_browser.request.get(DASHBOARD + PREFIX + '/bots/default/pages').json()['workspace']['state']
        assert state() == 'no_workspace'                       # the library says why it is off (contract v0.5: 200 + state)
        before = len(audit_rows('bot.workspace.set'))
        assert post(human_browser, '/bots/default/workspace', {}, token=None).status == 403
        done = post(human_browser, '/bots/default/workspace', {})
        assert done.status == 200 and done.json()['workspace']['state'] in ('empty', 'ready'), done.text()
        assert state() == done.json()['workspace']['state']    # the dashboard process sees the new folder at once
        assert len(audit_rows('bot.workspace.set')) == before + 2
        again = post(human_browser, '/bots/default/workspace', {})
        assert again.status == 409 and error_of(again)['code'] == 'workspace_not_changed'
        assert post(human_browser, '/bots/default/pages', {'title': 'Plano T14'}).status == 201
        assert upload(human_browser, 'default', 'foto.png', PNG).status == 201
        wait_live(human_browser, 'default')
        sid = post(human_browser, '/bots/default/sessions', {}).json()['session']['id']
        run = post(human_browser, '/bots/default/runs', {'input': 'T95_PAGE: write the page.', 'session_id': sid})
        assert run.status == 202, run.text()
        wait_run(human_browser, 'default', run.json()['run']['id'], {'completed'})
        assert (HERMES_WS / 'pages' / 'do-bot.md').read_text() == '# Do Bot\n', 'the run did not work in the folder it was given'
    finally:
        if made:
            shutil.rmtree(HERMES_WS, ignore_errors=True)
