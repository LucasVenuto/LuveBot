"""T9.5: Pages backend (contract v0.5 P1 + P2, ADR-004) against the REAL harness.

Part 1 runs the REAL `backend/pages.py` in-process against the real Hermes (profile config read under its scope, Hermes's own
`fs_write_text`, Hermes's redactor) and a temporary workspace; then the same module copied with ONE deliberate defect per
mutation (contract 8.1), which must turn its invariant red. Every invariant also asserts that the files outside `pages/` are
byte-identical before and after. Part 2 goes through the dashboard routes (router, CSRF, error envelope, one round trip).
"""
import asyncio
import hashlib
import importlib
import itertools
import os
import re
from pathlib import Path
import shutil
import sqlite3
import stat
import sys
import time
import uuid

import pytest

from support import DASHBOARD, plugin
from test_bots import csrf, error_of, post
from test_plugin import PREFIX, routes
from test_stream import parse

BACKEND = Path(plugin().__file__).parents[1] / 'backend'
NEEDED = ['__init__.py', 'api_errors.py', 'audit.py', 'dbfile.py', 'pages.py']
HERMES_ROOT = Path('/root/.hermes')
KEY = 'sk-' + 'a1b2c3d4e5f6' * 3          # a key shape Hermes's redactor masks (head and tail kept, sk-a...e5f6)
SLUG = 'plano'
_counter = itertools.count()


class Pkg:
    def __init__(self, name):
        self.name = name

    def __getattr__(self, module):
        return importlib.import_module(f'{self.name}.{module}')


def load(tmp_path, edit=None):
    pkg = tmp_path / f'pgpkg{next(_counter)}'
    pkg.mkdir()
    for name in NEEDED:
        shutil.copy(BACKEND / name, pkg / name)
    if edit:
        target = pkg / 'pages.py'
        assert target.read_text().count(edit[0]) == 1, edit[0]
        target.write_text(target.read_text().replace(*edit))
    sys.path.insert(0, str(pkg.parent))
    try:
        for name in NEEDED[1:]:
            importlib.import_module(f'{pkg.name}.{name[:-3]}')
        return Pkg(pkg.name)
    finally:
        sys.path.remove(str(pkg.parent))


def redact(text):
    from agent.redact import redact_sensitive_text
    return redact_sensitive_text(text, force=True)


def terminal(bot, **values):
    """Set terminal.* of a profile through Hermes's own config writer, in that profile's scope. Returns the previous values."""
    plugin()
    from hermes_cli.config import load_config, set_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    with _config_profile_scope(bot):
        before = dict(load_config().get('terminal') or {})
        for key, value in values.items():
            set_config_value('terminal.' + key, value)
    return {k: before.get(k) for k in values}


def tree(root):
    """{relative path: bytes} of every regular file under root outside pages/ (symlinks by their target text)."""
    out = {}
    for path in sorted(Path(root).rglob('*')):
        rel = path.relative_to(root)
        if rel.parts[0] == 'pages':
            continue
        out[str(rel)] = os.readlink(path) if path.is_symlink() else path.read_bytes() if path.is_file() else None
    return out


class Ctx:
    """A workspace for `vendas` (and one for `default`), the plugin's own DB in tmp, and who is asking."""

    def __init__(self, m, tmp):
        self.m, self.tmp = m, tmp
        self.ws = tmp / 'ws'
        self.ws.mkdir()
        (self.ws / '.env.md').write_text('KEY=' + KEY)                    # what `../.env` would reach
        (self.ws / 'config.yaml').write_text('secret: canary-config')
        self.db_path = tmp / 'luvebot.db'
        self.audit = m.audit.AuditLog(self.db_path)
        self.db = m.pages.Revisions(self.db_path)
        self.who = {'actor': 'basic:ana', 'label': 'Ana', 'bot_label': 'Vendas'}
        self.view = ('basic:ana', 'Vendas')
        self.before = tree(self.ws)

    @property
    def pages(self):
        return self.ws / 'pages'

    def create(self, title='Plano', content=None):
        return self.m.pages.create(self.db, self.audit, 'vendas', title, content, self.who, 'req_' + uuid.uuid4().hex, redact)

    def get(self, slug=SLUG):
        return self.m.pages.get_page(self.db, 'vendas', slug, self.view, redact)

    def put(self, content, base, slug=SLUG):
        return self.m.pages.update(self.db, self.audit, 'vendas', slug, content, base, self.who, 'req_' + uuid.uuid4().hex, redact)

    def restore(self, rev, base, slug=SLUG):
        return self.m.pages.restore(self.db, self.audit, 'vendas', slug, rev, base, self.who, 'req_' + uuid.uuid4().hex, redact)

    def listed(self):
        return self.m.pages.list_pages(self.db, 'vendas', None, self.view, redact)

    def refused(self, fn, *args):
        with pytest.raises(self.m.api_errors.PluginError) as error:
            fn(*args)
        return error.value

    def untouched(self):
        assert tree(self.ws) == self.before, 'a file outside pages/ changed'

    def audit_rows(self):
        conn = sqlite3.connect(self.db_path)
        try:
            return conn.execute('SELECT * FROM audit_log').fetchall()
        finally:
            conn.close()


@pytest.fixture
def workspace_config():
    saved = terminal('vendas', backend='local')
    saved.update(terminal('vendas', cwd='.'))
    default = terminal('default', cwd='.')
    yield
    terminal('vendas', backend=saved['backend'] or 'local', cwd=saved['cwd'] or '.')
    terminal('default', cwd=default['cwd'] or '.')


def ctx_for(m, tmp):
    ctx = Ctx(m, tmp)
    terminal('vendas', backend='local', cwd=str(ctx.ws))
    return ctx


def wait_second():
    time.sleep(1.05)  # one save per second per page


# ---------------------------------------------------------------------------------------------------------------------
# Part 1: invariants of contract 8.1 / ADR-004 section 5
# ---------------------------------------------------------------------------------------------------------------------
def inv_1_slug_confinement(m, tmp):
    c = ctx_for(m, tmp)
    page = c.create()
    for slug in ('../.env', '..%2F.env', 'a/b', 'SOUL', 'x.md', 'X', 'a' * 65, '', 'ção'):
        assert c.refused(c.get, slug).code == 'page_not_found', slug
        assert c.refused(c.put, 'x', page['sha'], slug).code == 'page_not_found', slug
        assert c.refused(c.restore, 1, page['sha'], slug).code == 'page_not_found', slug
    assert c.refused(c.create, '!!!').code == 'invalid_field'
    assert KEY not in str(c.listed())
    c.untouched()


def inv_2_symlink_refused(m, tmp):
    c = ctx_for(m, tmp)
    page = c.create()
    for name, target in (('x', 'config.yaml'), ('y', '.env.md')):
        os.symlink(c.ws / target, c.pages / (name + '.md'))
        assert c.refused(c.get, name).code == 'page_not_found'
        assert c.refused(c.put, 'overwrite', page['sha'], name).code == 'page_not_found'
    listed = c.listed()
    assert [p['slug'] for p in listed['pages']] == [SLUG] and listed['skipped'] == 2
    assert 'canary-config' not in str(listed) and KEY not in str(listed)
    for name in ('x', 'y'):
        (c.pages / (name + '.md')).unlink()
    real = c.ws / 'real-pages'
    c.pages.rename(real)
    os.symlink(real, c.pages)                                                         # pages/ itself a link
    assert m.pages.workspace('vendas') == ('unsafe', None)
    assert c.listed() == {'workspace': {'state': 'unsafe'}, 'pages': [], 'skipped': 0}
    for call in ((c.get,), (c.put, 'x', page['sha']), (c.create, 'Outra')):
        error = c.refused(*call)
        assert error.code == 'pages_unavailable' and error.extra == {'details': {'reason': 'unsafe'}}
    c.pages.unlink()
    real.rename(c.pages)
    c.untouched()


def inv_3_hardlink_refused(m, tmp):
    c = ctx_for(m, tmp)
    c.create()
    os.link(c.ws / 'config.yaml', c.pages / 'h.md')
    listed = c.listed()
    assert [p['slug'] for p in listed['pages']] == [SLUG] and listed['skipped'] == 1 and 'canary-config' not in str(listed)
    assert c.refused(c.get, 'h').code == 'page_not_found'
    (c.pages / 'h.md').unlink()
    c.untouched()


def inv_4_fail_closed_workspace(m, tmp):
    c = Ctx(m, tmp)
    inside = HERMES_ROOT / 'profiles' / 'vendas'
    cases = [('.', 'no_workspace'), ('auto', 'no_workspace'), ('cwd', 'no_workspace'), ('relative/dir', 'no_workspace'),
             (str(tmp / 'missing'), 'no_workspace'), ('/', 'no_workspace'), (str(inside), 'inside_hermes'),
             (str(HERMES_ROOT), 'inside_hermes')]
    process_cwd = tmp / 'process-cwd'
    process_cwd.mkdir()
    previous = os.getcwd()
    os.chdir(process_cwd)
    try:
        _fail_closed_cases(m, c, cases)
    finally:
        os.chdir(previous)
    assert not (process_cwd / 'pages').exists() and not (inside / 'pages').exists() and not (HERMES_ROOT / 'pages').exists()
    assert not (tmp / 'missing').exists() and not c.pages.exists()
    c.untouched()


def _fail_closed_cases(m, c, cases):
    for cwd, state in cases:
        terminal('vendas', backend='local', cwd=cwd)
        assert m.pages.workspace('vendas') == (state, None), (cwd, m.pages.workspace('vendas'))
        error = c.refused(c.create, 'Plano')
        assert error.code == 'pages_unavailable' and error.extra['details'] == {'reason': state}
        assert c.listed()['workspace']['state'] == state
    terminal('vendas', backend='docker', cwd=str(c.ws))
    assert m.pages.workspace('vendas') == ('not_local', None)
    assert c.refused(c.create, 'Plano').code == 'pages_unavailable'
    terminal('vendas', backend='local')


def inv_5_profile_scope(m, tmp):
    c = ctx_for(m, tmp)
    other = tmp / 'ws-default'
    other.mkdir()
    terminal('default', cwd=str(other))
    c.create('Só da Vendas')
    m.pages.create(c.db, c.audit, 'default', 'Só do Default', None, c.who, 'req_x', redact)
    assert [p['slug'] for p in c.listed()['pages']] == ['so-da-vendas']
    assert [p['slug'] for p in m.pages.list_pages(c.db, 'default', None, c.view, redact)['pages']] == ['so-do-default']
    assert sorted(os.listdir(c.pages)) == ['so-da-vendas.md'] and sorted(os.listdir(other / 'pages')) == ['so-do-default.md']
    c.untouched()


def inv_6_conflict(m, tmp):
    c = ctx_for(m, tmp)
    loaded = c.create()
    (c.pages / 'plano.md').write_text('# Plano\nversão do Bot\n')                     # the Bot writes meanwhile
    wait_second()
    error = c.refused(c.put, '# Plano\nminha\n', loaded['sha'])
    assert error.code == 'page_conflict' and error.status == 409
    assert error.extra['details']['changed_by'] == 'external' and error.extra['details']['current_sha'] != loaded['sha']
    assert (c.pages / 'plano.md').read_text() == '# Plano\nversão do Bot\n'
    fresh = c.get()
    assert fresh['changed_outside'] and fresh['author'] == 'external'
    saved = c.put('# Plano\nminha\n', fresh['sha'])
    assert saved['changed'] and (c.pages / 'plano.md').read_text() == '# Plano\nminha\n'
    history = m.pages.revisions(c.db, 'vendas', SLUG, 10, None, c.view)['revisions']
    assert [(r['rev'], r['author']) for r in history] == [(3, 'human'), (2, 'external'), (1, 'human')]
    assert m.pages.revision(c.db, 'vendas', SLUG, 2, c.view, redact)['content'] == '# Plano\nversão do Bot\n'
    c.untouched()


def inv_7_official_write(m, tmp):
    c = ctx_for(m, tmp)
    real, calls = m.pages.writer(), []

    async def counting(payload, profile=None):
        calls.append((payload.path, profile))
        return await real(payload, profile=profile)
    m.pages.writer = lambda: counting
    try:
        first = c.create()
        wait_second()
        second = c.put('# Plano\nv2\n', first['sha'])
        wait_second()
        c.restore(1, second['page']['sha'])
        expected = os.path.join(os.path.realpath(c.ws), 'pages', 'plano.md')
        assert calls == [(expected, 'vendas')] * 3, calls

        async def noop(payload, profile=None):
            return {'ok': True, 'path': payload.path}
        m.pages.writer = lambda: noop
        wait_second()
        before = (c.pages / 'plano.md').read_bytes()
        c.put('# Plano\nnunca\n', c.get()['sha'])
        assert (c.pages / 'plano.md').read_bytes() == before                            # nobody else writes the file
    finally:
        m.pages.writer = lambda: real
    assert stat.S_IMODE(os.stat(c.pages).st_mode) == 0o700                             # ADR-004: the one direct write
    c.untouched()


def inv_8_audit_first(m, tmp):
    c = ctx_for(m, tmp)
    real, seen = m.pages.writer(), []

    async def watching(payload, profile=None):
        ours = [r for r in c.audit_rows() if r[6] in ('page.create', 'page.update')]   # (mkdir has its own rows in between)
        seen.append(tuple(ours[-1]))
        return await real(payload, profile=profile)
    m.pages.writer = lambda: watching
    try:
        first = c.create(content='# Plano\n' + 'canary-text-123\n')
        wait_second()
        c.put('# Plano\ncanary-text-456\n', first['sha'])
    finally:
        m.pages.writer = lambda: real
    assert len(seen) == 2
    for row in seen:
        assert row[10] == 'intent', row                                                  # intent written, result not yet
    rows = str(c.audit_rows())
    assert 'canary-text' not in rows and str(c.ws) not in rows and 'Plano' not in rows
    conn = sqlite3.connect(c.db_path)
    conn.execute("CREATE TRIGGER down BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'down'); END")
    conn.commit()
    conn.close()
    wait_second()
    before = (c.pages / 'plano.md').read_bytes()
    with pytest.raises(Exception):
        c.put('# Plano\nnão\n', c.get()['sha'])
    assert (c.pages / 'plano.md').read_bytes() == before
    c.untouched()


def inv_9_redacted_readonly(m, tmp):
    c = ctx_for(m, tmp)
    c.create()
    (c.pages / 'segredo.md').write_text('# Segredo\nchave ' + KEY + '\n')
    page = c.get('segredo')
    assert KEY not in str(page) and page['redacted'] and page['editable'] is False and page['readonly_reason'] == 'redacted'
    wait_second()
    error = c.refused(c.put, '# Segredo\nlimpo\n', page['sha'], 'segredo')
    assert error.code == 'page_redacted'
    assert KEY in (c.pages / 'segredo.md').read_text()
    c.untouched()


def inv_10_size_and_rate(m, tmp):
    c = ctx_for(m, tmp)
    page = c.create()
    wait_second()
    error = c.refused(c.put, 'x' * (1024 * 1024 + 1), page['sha'])
    assert (error.code, error.status) == ('too_large', 413) and (c.pages / 'plano.md').read_text() == '# Plano\n'
    saved = c.put('# Plano\num\n', page['sha'])
    assert c.refused(c.put, '# Plano\ndois\n', saved['page']['sha']).code == 'rate_limited'
    c.untouched()


def inv_15_error_details(m, tmp):
    c = ctx_for(m, tmp)
    page = c.create()
    assert c.refused(c.create, 'Plano').extra == {'details': {'slug': 'plano'}}
    (c.pages / 'plano.md').write_text('# Plano\nbot\n')
    wait_second()
    conflict = c.refused(c.put, 'x', page['sha'])
    assert set(conflict.extra) == {'details'} and set(conflict.extra['details']) == {'current_sha', 'changed_by', 'changed_by_label'}
    real = m.pages.writer
    m.pages.writer = lambda: None
    try:
        assert c.refused(c.create, 'Outra').extra == {'details': {'feature': 'pages_write'}}
    finally:
        m.pages.writer = real
    terminal('vendas', cwd='.')
    assert c.refused(c.get).extra == {'details': {'reason': 'no_workspace'}}
    c.untouched()


def inv_16_author_label(m, tmp):
    c = ctx_for(m, tmp)
    page = c.create()
    assert (page['author_label'], page['by_you']) == ('Você', True)
    other = {'actor': 'basic:bia', 'label': None, 'bot_label': 'Vendas'}                # a display_name with @ is dropped
    assert m.pages.actor_label('bia@empresa.com', redact) is None
    wait_second()
    m.pages.update(c.db, c.audit, 'vendas', SLUG, '# Plano\nbia\n', page['sha'], other, 'r1', redact)
    seen = c.get()
    assert (seen['author_label'], seen['by_you']) == ('Outra pessoa', False)
    history = m.pages.revisions(c.db, 'vendas', SLUG, 10, None, c.view)
    assert [r['author_label'] for r in history['revisions']] == ['Outra pessoa', 'Você']
    for response in (seen, history, c.listed(), m.pages.revision(c.db, 'vendas', SLUG, 1, c.view, redact)):
        assert 'basic:bia' not in str(response) and 'basic:ana' not in str(response)
    c.untouched()


def inv_17_excerpt(m, tmp):
    c = ctx_for(m, tmp)
    body = '# Plano\n' + 'y' * 188 + ' ' + KEY + '\n```\ncódigo\n```\n- **negrito** [link](https://x) ![img](u) <b>tag</b>\n'
    c.create(content=body)
    page = c.listed()['pages'][0]
    assert len(page['excerpt']) <= 200 and 'a1b2c3' not in page['excerpt'] and page['excerpt'].startswith('y' * 188), page['excerpt']
    assert '**' not in page['excerpt'] and 'código' not in page['excerpt'] and '](' not in page['excerpt']
    c.untouched()


def inv_adr4_mkdir_audited_and_one_level(m, tmp):
    c = ctx_for(m, tmp)
    real_mkdir, order = os.mkdir, []

    def watching(path, mode=0o777, **kw):
        order.append([r[6] for r in c.audit_rows()] if str(path).endswith('/pages') else None)
        return real_mkdir(path, mode, **kw)
    m.pages.os.mkdir = watching
    try:
        c.create()
    finally:
        m.pages.os.mkdir = real_mkdir
    order = [o for o in order if o is not None]                                         # only the mkdir of pages/
    assert order and order[0][-2:] == ['page.create', 'page.workspace.mkdir'], order    # both intents before the folder
    assert stat.S_IMODE(os.stat(c.pages).st_mode) == 0o700
    shutil.rmtree(c.pages)
    (c.ws / 'pages').write_text('a file')
    assert m.pages.workspace('vendas') == ('unsafe', None) and c.refused(c.create, 'Outra').code == 'pages_unavailable'
    (c.ws / 'pages').unlink()
    target = tmp / 'elsewhere'
    target.mkdir()
    os.symlink(target, c.ws / 'pages')                                               # swapped in after the workspace check
    with pytest.raises(m.api_errors.PluginError) as swapped:
        m.pages._mkdir(os.path.realpath(c.ws))
    assert swapped.value.extra == {'details': {'reason': 'unsafe'}}
    (c.ws / 'pages').unlink()
    deep = tmp / 'not' / 'there'
    terminal('vendas', cwd=str(deep))
    assert c.refused(c.create, 'Outra').code == 'pages_unavailable' and not (tmp / 'not').exists()


def inv_rescan_bot_updated(m, tmp):
    c = ctx_for(m, tmp)
    c.create()
    (c.pages / 'antigo.md').write_text('# Antigo\n')
    os.utime(c.pages / 'antigo.md', (time.time() - 3600, time.time() - 3600))         # written long before this run
    start = time.time()
    (c.pages / 'novo.md').write_text('# Novo\ndo Bot\n')
    found = m.pages.rescan(c.db, 'vendas', 'run_abc', start, redact)
    assert [(f['slug'], f['title']) for f in found] == [('novo', 'Novo')]
    row = m.pages.revision(c.db, 'vendas', 'novo', 1, c.view, redact)
    assert (row['author'], row['origin_kind'], row['origin_ref']) == ('bot', 'agent', 'run_abc')
    assert m.pages.rescan(c.db, 'vendas', 'run_abc', start, redact) == []               # unchanged files are not hashed again
    c.untouched()


def inv_12_note_is_metadata_only(m, tmp):
    c = ctx_for(m, tmp)
    c.create(content='# Plano\nconteudo-canario-789\n')
    text = m.pages.note(c.db, 'vendas', SLUG, c.view)
    assert text.startswith('[luvebot:page] A pessoa está vendo pages/plano.md (revisão 1, editada por Você em ')
    assert text.endswith('Releia o arquivo antes de alterar.') and 'conteudo-canario' not in text and '\n' not in text
    for slug in ('../.env', 'X', 'nao-existe'):
        assert c.refused(m.pages.note, c.db, 'vendas', slug, c.view).code == 'page_not_found', slug
    c.untouched()


INVARIANTS = {name[4:]: fn for name, fn in dict(globals()).items() if name.startswith('inv_')}
MUTATIONS = [  # (invariant, label, old, new) on backend/pages.py
    ('1_slug_confinement', 'slug regex replaced by .+', "SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')", "SLUG = re.compile(r'.+')"),
    ('2_symlink_refused', 'page opened without O_NOFOLLOW',
     "fd = os.open(slug + '.md', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)", "fd = os.open(slug + '.md', os.O_RDONLY | os.O_NONBLOCK, dir_fd=dfd)"),
    ('2_symlink_refused', 'pages/ not checked with lstat', "    return ('ready', real) if stat.S_ISDIR(st.st_mode) else ('unsafe', None)",
     "    return 'ready', real"),
    ('3_hardlink_refused', 'link count not checked', 'or st.st_nlink != 1 ', ''),
    ('4_fail_closed_workspace', 'falls back to the process cwd',
     "    if not isinstance(cwd, str) or cwd.strip() in NOT_SET:\n        return 'no_workspace', None",
     "    if not isinstance(cwd, str) or cwd.strip() in NOT_SET:\n        cwd = os.getcwd()"),
    ('4_fail_closed_workspace', 'a workspace inside Hermes accepted', "        return 'inside_hermes', None", "        pass"),
    ('5_profile_scope', 'terminal.cwd read outside the profile scope',
     "    with _config_profile_scope(bot):\n        terminal = load_config().get('terminal')", "    terminal = load_config().get('terminal')"),
    ('6_conflict', 'base_sha not compared', '        if disk != base_sha:', '        if False:'),
    ('6_conflict', 'the outside version is not kept', '        if outside:  # a version written outside', '        if False:  # a version written outside'),
    ('7_official_write', 'written with open()', "        result = asyncio.run(writer()(FsWriteText(path=expected, content=text), profile=bot))",
     "        open(expected, 'w').write(text)\n        result = {'path': expected}"),
    ('8_audit_first', 'written before act()',
     "        audit.act(who['actor'], action, slug, {'kind': 'ui', 'ref': origin_ref}, effect, bot=bot, payload=payload)",
     "        effect()\n        audit.act(who['actor'], action, slug, {'kind': 'ui', 'ref': origin_ref}, lambda: None, bot=bot, payload=payload)"),
    ('9_redacted_readonly', 'a redacted page can be saved', '        if restore is None and redact(disk_text) != disk_text:', '        if False:'),
    ('9_redacted_readonly', 'raw content returned', "    return {**view, 'content': redact(text), 'redacted': redact(text) != text}",
     "    return {**view, 'content': text, 'redacted': False, 'editable': True, 'readonly_reason': None}"),
    ('10_size_and_rate', 'no 1 MiB cap', "    if len(content.encode('utf-8')) > MAX_BYTES:", '    if False:'),
    ('10_size_and_rate', 'no rate limit', "    if now - _LAST_WRITE.get((bot, slug), -10) < 1:", '    if False:'),
    ('15_error_details', 'extra fields at the top of the error',
     "    return Refused(code, message, status, {'details': details} if details else None)", '    return Refused(code, message, status, details or None)'),
    ('16_author_label', 'the actor is shown', "    return False, row['actor_label'] or 'Outra pessoa'", "    return False, row['actor_label'] or row['actor']"),
    ('17_excerpt', 'cut before redacting',
     "    body = redact(' '.join(body.split()))\n    return body if len(body) <= 200 else body[:199].rstrip() + '…'",
     "    body = ' '.join(body.split())[:199]\n    return redact(body)"),
    ('adr4_mkdir_audited_and_one_level', 'mkdir before act()',
     "            if state == 'empty':\n                audit.act(who['actor'], 'page.workspace.mkdir', 'pages', origin, lambda: _mkdir(root), bot=bot)",
     "            if state == 'empty':\n                _mkdir(root)"),
    ('adr4_mkdir_audited_and_one_level', 'parents created', "        os.mkdir(pages, 0o700)", "        os.makedirs(pages, 0o700, exist_ok=True)"),
    ('12_note_is_metadata_only', 'the note carries the page content',
     "    return f'{NOTE} A pessoa está vendo pages/{slug}.md ({edited}). Releia o arquivo antes de alterar.'",
     "    return f'{NOTE} A pessoa está vendo pages/{slug}.md ({edited}). Releia o arquivo antes de alterar.' + read[0].decode()"),
    ('rescan_bot_updated', 'a file older than the run is attributed to it', '            if seen.get(slug) == key or st.st_mtime < since - 1:',
     '            if seen.get(slug) == key:'),
]


@pytest.fixture
def isolated(workspace_config, tmp_path):
    yield tmp_path


def off_loop(fn, *args):
    """Run in a worker thread: in a full suite Playwright's sync API keeps an event loop running in this thread, and the
    module calls Hermes's async route functions with asyncio.run, as it does in the dashboard's threadpool."""
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(1) as pool:
        return pool.submit(fn, *args).result()


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
# Part 2: the routes, through the real dashboard
# ---------------------------------------------------------------------------------------------------------------------
@pytest.fixture
def fresh_history():
    """Route tests share the dashboard's own DB and process: start each without vendas's page history and outside the
    one-write-per-second window of the previous test (history is keyed by Bot and slug, not by workspace)."""
    plugin()
    from luvebot_backend.pages import Revisions
    conn = sqlite3.connect(Revisions(Path('/root/.hermes/luvebot/luvebot.db')).path)
    conn.execute("DELETE FROM page_revisions WHERE bot='vendas'")
    conn.commit()
    conn.close()
    time.sleep(1.05)


PAGE_ROUTES = [('GET', '/bots/{bot}/pages'), ('GET', '/bots/{bot}/pages/{slug}'), ('GET', '/bots/{bot}/pages/{slug}/revisions'),
               ('GET', '/bots/{bot}/pages/{slug}/revisions/{rev}'), ('POST', '/bots/{bot}/pages'), ('PUT', '/bots/{bot}/pages/{slug}'),
               ('POST', '/bots/{bot}/pages/{slug}/revisions/{rev}/restore')]


def test_13_page_routes_are_in_the_router_and_mutations_need_csrf(human_browser, workspace_config, tmp_path):
    found = set(routes())
    for method, path in PAGE_ROUTES:
        assert (method, PREFIX + path) in found, (method, path)
    for method, path in [r for r in PAGE_ROUTES if r[0] != 'GET']:
        url = DASHBOARD + PREFIX + path.replace('{bot}', 'vendas').replace('{slug}', 'plano').replace('{rev}', '1')
        response = human_browser.request.fetch(url, method=method, data={}, headers={'X-LuveBot-CSRF': 'wrong'})
        assert response.status == 403 and error_of(response)['code'] == 'csrf_required', (path, response.text())


def test_round_trip_through_the_dashboard(human_browser, workspace_config, fresh_history, tmp_path):
    ws = tmp_path / 'ws'
    ws.mkdir()
    terminal('vendas', backend='local', cwd=str(ws))
    get = lambda path: human_browser.request.get(DASHBOARD + PREFIX + path)
    put = lambda path, body: human_browser.request.put(DASHBOARD + PREFIX + path, data=body, headers={'X-LuveBot-CSRF': csrf(human_browser)})
    assert get('/bots/vendas/pages').json() == {'workspace': {'state': 'empty'}, 'pages': [], 'skipped': 0}
    created = post(human_browser, '/bots/vendas/pages', {'title': 'Plano de lançamento'})
    assert created.status == 201, created.text()
    page = created.json()['page']
    assert page['slug'] == 'plano-de-lancamento' and page['author_label'] == 'Você' and 'actor' not in page
    assert (ws / 'pages' / 'plano-de-lancamento.md').read_text() == '# Plano de lançamento\n'
    read = get('/bots/vendas/pages/plano-de-lancamento').json()
    assert read['content'] == '# Plano de lançamento\n' and read['editable'] is True
    time.sleep(1.05)
    saved = put('/bots/vendas/pages/plano-de-lancamento', {'content': '# Plano\nv2\n', 'base_sha': read['sha']})
    assert saved.status == 200 and saved.json()['changed'] is True, saved.text()
    stale = put('/bots/vendas/pages/plano-de-lancamento', {'content': 'x', 'base_sha': read['sha']})
    assert stale.status == 409 and error_of(stale)['code'] == 'page_conflict'
    assert set(error_of(stale)['details']) == {'current_sha', 'changed_by', 'changed_by_label'} and 'reason' not in error_of(stale)
    assert get('/bots/vendas/pages/..%2F.env').status == 404
    terminal('vendas', cwd='.')
    refused = get('/bots/vendas/pages/plano-de-lancamento')
    assert refused.status == 409 and error_of(refused)['details'] == {'reason': 'no_workspace'}
    health = get('/health').json()
    assert health['features']['pages'] == 'ok'


def test_11_bot_updated_comes_from_a_rescan_of_a_real_run(human_browser, workspace_config, fresh_history, tmp_path):
    """7.1 end to end: the Bot writes pages/do-bot.md with its terminal tool in a real run; the run stream carries one
    luvebot.page.updated for it (and none for the page that did not change), and the history has a `bot` revision of that run."""
    from test_hook import wait_live
    from test_runs import new_run, wait_run
    ws = tmp_path / 'ws'
    ws.mkdir()
    terminal('vendas', backend='local', cwd=str(ws))
    wait_live(human_browser, 'vendas')
    assert post(human_browser, '/bots/vendas/pages', {'title': 'Plano'}).status == 201      # pages/ exists, plano.md untouched by the run
    _sid, run = new_run(human_browser, 'T95_PAGE: write the page.')
    frames = parse(human_browser.request.get(DASHBOARD + PREFIX + f"/bots/vendas/runs/{run['id']}/events").text())
    wait_run(human_browser, 'vendas', run['id'], {'completed'})
    assert (ws / 'pages' / 'do-bot.md').read_text() == '# Do Bot\n', 'the fake model did not write the page'
    updated = [f[2] for f in frames if f[1] == 'luvebot.page.updated']
    assert [(u['slug'], u['title']) for u in updated] == [('do-bot', 'Do Bot')], [f[1] for f in frames]
    revisions = human_browser.request.get(DASHBOARD + PREFIX + '/bots/vendas/pages/do-bot/revisions').json()['revisions']
    assert [(r['rev'], r['author'], r['origin_kind'], r['origin_ref']) for r in revisions] == [(1, 'bot', 'agent', run['id'])]


def stored_user_messages(sid):
    from hermes_state import SessionDB
    db = SessionDB(Path('/root/.hermes/profiles/vendas/state.db'))
    try:
        return [m['content'] for m in db.get_messages(sid) if m['role'] == 'user']
    finally:
        db.close()


def test_12_18_ask_the_bot_about_a_page_on_runs_and_chat(human_browser, workspace_config, fresh_history, tmp_path):
    """7.2: the server builds the note (metadata only) before the person's text, on the run and the chat surfaces; the client
    cannot send it; B1 history shows page_ref and never the note (A-64)."""
    from test_hook import wait_live
    from test_runs import wait_run
    ws = tmp_path / 'ws'
    ws.mkdir()
    terminal('vendas', backend='local', cwd=str(ws))
    wait_live(human_browser, 'vendas')
    assert post(human_browser, '/bots/vendas/pages', {'title': 'Plano', 'content': '# Plano\nconteudo-canario-789\n'}).status == 201
    sid = post(human_browser, '/bots/vendas/sessions', {}).json()['session']['id']
    assert post(human_browser, '/bots/vendas/runs', {'input': 'resuma', 'session_id': sid, 'page': {'slug': 'plano'}, 'note': 'x'}).status == 400
    assert post(human_browser, '/bots/vendas/runs', {'input': 'resuma', 'session_id': sid, 'page': {'slug': '../.env'}}).status == 404
    assert post(human_browser, '/bots/vendas/runs', {'input': 'resuma', 'session_id': sid, 'page': {'slug': 'nao-existe'}}).status == 404
    started = post(human_browser, '/bots/vendas/runs', {'input': 'resuma', 'session_id': sid, 'page': {'slug': 'plano'}})
    assert started.status == 202, started.text()
    wait_run(human_browser, 'vendas', started.json()['run']['id'], {'completed'})
    chat = post(human_browser, f'/bots/vendas/sessions/{sid}/chat/stream', {'input': 'e agora?', 'page': {'slug': 'plano'}})
    assert chat.status == 200, chat.text()
    stored = stored_user_messages(sid)
    note = re.compile(r'\[luvebot:page\] A pessoa está vendo pages/plano\.md \(revisão \d+, editada por Você em [0-9TZ:-]+\)\. '
                      r'Releia o arquivo antes de alterar\.\n\n')
    assert len(stored) == 2 and all(note.match(s) for s in stored), stored
    assert stored[0].endswith('\n\nresuma') and stored[1].endswith('\n\ne agora?') and not any('conteudo-canario' in s for s in stored)
    history = human_browser.request.get(DASHBOARD + PREFIX + f'/bots/vendas/sessions/{sid}/messages').json()['messages']
    asked = [m for m in history if m['role'] == 'user']
    assert [(m['text'], m.get('page_ref')) for m in asked] == [('resuma', {'slug': 'plano'}), ('e agora?', {'slug': 'plano'})]
    terminal('vendas', cwd='.')
    refused = post(human_browser, '/bots/vendas/runs', {'input': 'resuma', 'session_id': sid, 'page': {'slug': 'plano'}})
    assert refused.status == 409 and error_of(refused)['code'] == 'pages_unavailable'
