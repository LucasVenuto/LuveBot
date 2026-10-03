"""T12 (2): a file of the Bot's workspace as a download (backend/pages.py read_workspace_file, GET /bots/{bot}/files/download),
and the ADR-004 addendum (the Bot's own <profile home>/workspace is a valid workspace; the rest of the Hermes root is not).

Part 1 runs the REAL module in-process against the real Hermes (profile config, redactor, sensitive-name guard) and the same
module with ONE defect per mutation, which must turn its invariant red (pattern of test_pages.py). Part 2 goes through the
dashboard route. Container mutations of the route: tests/harness/mutate_v04.py t12_dl_*.
"""
import hashlib
import os
from pathlib import Path
import shutil

import pytest

from support import DASHBOARD, plugin
from test_bots import audit_rows, error_of
from test_pages import load, off_loop, redact, terminal, workspace_config  # noqa: F401  (workspace_config is a fixture)
from test_plugin import PREFIX

KEY = 'sk-' + 'a1b2c3d4e5f6' * 3
PROFILES = Path('/root/.hermes/profiles')


def build(tmp):
    ws, outside = tmp / 'ws', tmp / 'outside'
    for folder in (ws / 'docs', outside):
        folder.mkdir(parents=True)
    (ws / 'docs' / 'plano.md').write_text('# Plano\nlista\n')
    (ws / 'img.png').write_bytes(b'\x89PNG\r\n\x1a\n' + bytes(range(256)))
    (ws / '.env.md').write_text('x')
    (ws / 'docs' / '.oculto.md').write_text('x')
    (ws / 'segredo.md').write_text('chave ' + KEY)
    (ws / 'script.py').write_text('print(1)')
    (outside / 'x.md').write_text('fora do workspace')
    (outside / 'h.md').write_text('alvo do hard link')
    os.symlink(outside / 'x.md', ws / 'link.md')
    os.symlink(outside, ws / 'linkdir')
    os.link(outside / 'h.md', ws / 'hard.md')
    os.mkfifo(ws / 'fifo.md')
    with open(ws / 'grande.txt', 'wb') as big:
        big.truncate(25 * 1024 * 1024 + 1)  # sparse: 25 MiB + 1 byte without writing them
    return ws


def code_of(m, path):
    try:
        m.pages.read_workspace_file('vendas', path, redact)
    except m.api_errors.PluginError as error:
        return error.code
    return 'served'


def inv_download_confined(m, tmp):
    ws = build(tmp)
    terminal('vendas', backend='local', cwd=str(ws))
    assert m.pages.read_workspace_file('vendas', 'docs/plano.md', redact) == ('plano.md', b'# Plano\nlista\n')
    assert m.pages.read_workspace_file('vendas', 'img.png', redact)[1].startswith(b'\x89PNG')
    for path in ('../outside/x.md', '/etc/passwd', 'docs/../img.png', '.env.md', 'docs/.oculto.md', 'docs//plano.md', '',
                 'link.md', 'linkdir/x.md', 'hard.md', 'fifo.md', 'script.py', 'docs', 'nao/existe.md'):
        assert code_of(m, path) == 'file_not_found', (path, code_of(m, path))
    assert code_of(m, 'segredo.md') == 'file_redacted'
    assert code_of(m, 'grande.txt') == 'too_large'
    terminal('vendas', cwd='.')
    assert code_of(m, 'docs/plano.md') == 'workspace_unavailable'


def inv_own_workspace(m, tmp):
    """ADR-004 addendum: <profile home>/workspace of THIS Bot (and inside it) is accepted; the rest of the Hermes root is not."""
    made = []
    for folder in (PROFILES / 'vendas' / 'workspace', Path('/root/.hermes/workspace')):
        if not folder.exists():
            folder.mkdir()
            made.append(folder)
    sub = PROFILES / 'vendas' / 'workspace' / 't12-sub'
    sub.mkdir(exist_ok=True)
    try:
        own = os.path.realpath(PROFILES / 'vendas' / 'workspace')
        terminal('vendas', backend='local', cwd=own)
        assert m.pages.workspace('vendas')[0] in ('ready', 'empty') and m.pages.workspace('vendas')[1] == own
        terminal('vendas', cwd=str(sub))
        assert m.pages.workspace('vendas')[1] == os.path.realpath(sub)
        for other in ('/root/.hermes/workspace', str(PROFILES / 'vendas'), '/root/.hermes'):   # default's, the profile home, the root
            terminal('vendas', cwd=other)
            assert m.pages.workspace('vendas') == ('inside_hermes', None), other
    finally:
        shutil.rmtree(sub, ignore_errors=True)
        for folder in made:
            shutil.rmtree(folder, ignore_errors=True)


INVARIANTS = {name[4:]: fn for name, fn in dict(globals()).items() if name.startswith('inv_')}
MUTATIONS = [
    ('download_confined', 'a folder link is followed', "os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fds[-1])",
     "os.open(part, os.O_RDONLY | os.O_DIRECTORY, dir_fd=fds[-1])"),
    ('download_confined', 'the file link is followed', "fds.append(os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fds[-1]))",
     "fds.append(os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK, dir_fd=fds[-1]))"),
    ('download_confined', 'a hard link is served', "if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:\n            raise file_not_found()",
     "if not stat.S_ISREG(st.st_mode):\n            raise file_not_found()"),
    ('download_confined', "'..' and hidden parts accepted", "if len(parts) > 16 or any(not part or part.startswith('.') for part in parts):",
     "if len(parts) > 16 or any(not part for part in parts):"),
    ('download_confined', 'any file type served', "return parts if '.' in name and name.rsplit('.', 1)[1].lower() in DOWNLOAD_TYPES else None",
     "return parts"),
    ('download_confined', 'a text with a secret served', "        if redact(text) != text:\n            raise Refused('file_redacted'",
     "        if False:\n            raise Refused('file_redacted'"),
    ('download_confined', 'no size cap', 'DOWNLOAD_MAX = 25 * 1024 * 1024', 'DOWNLOAD_MAX = 10 ** 12'),
    ('own_workspace', 'any folder inside the Hermes root accepted', "    mine = real == own or real.startswith(own + '/')", '    mine = True'),
]


@pytest.fixture
def isolated(workspace_config, tmp_path):
    yield tmp_path


@pytest.mark.parametrize('name', sorted(INVARIANTS))
def test_invariant_holds_on_the_real_module(isolated, name):
    off_loop(INVARIANTS[name], load(isolated), isolated)


def test_every_invariant_has_a_mutation():
    assert {m[0] for m in MUTATIONS} == set(INVARIANTS)


RESULTS = []


@pytest.mark.parametrize('invariant,label,old,new', MUTATIONS, ids=[f'{i}|{l}' for i, l, *_ in MUTATIONS])
def test_each_mutation_turns_its_invariant_red(isolated, invariant, label, old, new):
    variant = load(isolated, (old, new))
    try:
        off_loop(INVARIANTS[invariant], variant, isolated)
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
# Part 2: the route
# ---------------------------------------------------------------------------------------------------------------------
def test_download_route(human_browser, workspace_config, tmp_path):
    ws = tmp_path / 'ws'
    ws.mkdir()
    page = b'<html><script>window.__pwn=1</script>relatorio</html>'
    (ws / 'relatorio de outubro.html').write_bytes(page)
    terminal('vendas', backend='local', cwd=str(ws))
    url = DASHBOARD + PREFIX + '/bots/vendas/files/download?path='
    before = len(audit_rows('file.download'))
    got = human_browser.request.get(url + 'relatorio%20de%20outubro.html')
    assert got.status == 200 and got.body() == page, got.text()
    headers = got.headers
    assert headers['content-type'] == 'application/octet-stream'
    assert headers['content-disposition'] == "attachment; filename*=UTF-8''relatorio%20de%20outubro.html"
    assert headers['x-content-type-options'] == 'nosniff' and headers['content-security-policy'] == "default-src 'none'; sandbox"
    assert headers['cache-control'] == 'no-store'
    rows = audit_rows('file.download')[before:]
    assert [r[1:3] for r in rows] == [('ok', 'intent'), ('ok', 'result')]
    assert rows[0][3] == hashlib.sha256('relatorio de outubro.html'.encode()).hexdigest() and 'relatorio' not in str(rows)
    for bad in ('..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', '.env'):
        refused = human_browser.request.get(url + bad)
        assert refused.status == 404 and error_of(refused)['code'] == 'file_not_found', bad
    terminal('vendas', cwd='.')
    off = human_browser.request.get(url + 'relatorio.html')
    assert off.status == 409 and error_of(off)['code'] == 'workspace_unavailable' and error_of(off)['details'] == {'reason': 'no_workspace'}
