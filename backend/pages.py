"""Pages (contract v0.5 P1 + P2, ADR-004): Markdown files `<workspace>/pages/<slug>.md` of a Bot, read safely and written
through Hermes's own editor route, with LuveBot's own revision history.

Hermes code used (commit f8489405), all in the dashboard process:
  workspace  `terminal.*` from `load_config()` under `_config_profile_scope(bot)` (web_server_profiles.py#L277); SSH workspaces
             from `_fs_backend` (web_routers/files.py#L262). `/api/fs/default-cwd` is never used: it ignores the profile (#L969).
  write      `fs_write_text` (web_routers/files.py#L825): temp file + os.replace, needs the parent, regular files only.
  root       `hermes_constants.get_default_hermes_root()`: no page workspace may sit inside it.
Reads never resolve a path: the folder is opened O_NOFOLLOW and each page O_NOFOLLOW under its descriptor, then fstat must say a
regular file with one link and at most 1 MiB. The one direct write of Pages is `os.mkdir(pages, 0o700)` (ADR-004), audited first.
Attachments (ADR-005) are written by Hermes's own upload writer (`stream_upload_to_path`, web_routers/files.py#L650) into
<workspace>/attachments; a Bot without terminal.cwd gets its own <profile home>/workspace through Hermes's config writer.
Every string that leaves here is redacted by the caller's `redact`; `actor` never leaves (only `author_label`).
"""
import asyncio
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import io
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
import time
import unicodedata
import uuid
import zipfile

from .api_errors import PluginError
from .audit import ActionDenied

SLUG = re.compile(r'[a-z0-9][a-z0-9-]{0,63}')
MAX_BYTES = 1024 * 1024
KEEP = 50
LIST_MAX = 500
NOT_SET = ('', '.', 'auto', 'cwd')
WRITERS = ('write_file', 'patch', 'terminal', 'execute_code')  # tools whose completion schedules a rescan (7.1)
_SCHEMA = """
CREATE TABLE IF NOT EXISTS page_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot TEXT NOT NULL, slug TEXT NOT NULL, rev INTEGER NOT NULL,
  sha TEXT NOT NULL, size INTEGER NOT NULL, content TEXT NOT NULL,
  author TEXT NOT NULL CHECK (author IN ('human', 'bot', 'external')),
  actor TEXT, actor_label TEXT, origin_kind TEXT NOT NULL, origin_ref TEXT, detail TEXT,
  at REAL NOT NULL,
  UNIQUE (bot, slug, rev));
"""
_LOCKS = defaultdict(threading.Lock)  # per (bot, slug): our own writers (two tabs) one at a time
_LAST_WRITE = {}                      # (bot, slug) -> monotonic time of the last write: one per second
_SEEN = defaultdict(dict)             # bot -> {slug: (mtime_ns, size)} for the rescan


class Refused(PluginError, ActionDenied):
    """A page action refused by a rule: audited as denied, answered with the contract error."""


def _details(code, message, status, **details):
    return Refused(code, message, status, {'details': details} if details else None)


def not_found():
    return PluginError('page_not_found', 'Page not found.', 404)


def unavailable(state):
    return _details('pages_unavailable', 'Pages are not available for this Bot.', 409, reason=state)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _iso(epoch):
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


# ---- 1. workspace --------------------------------------------------------------------------------------------------
def workspace(bot):
    """(state, realpath of the workspace or None). Fails closed: any doubt is a state other than ready/empty."""
    from hermes_cli.config import load_config
    from hermes_cli.web_routers.files import _fs_backend
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_constants import get_default_hermes_root, get_hermes_home
    with _config_profile_scope(bot):
        own = os.path.realpath(os.path.join(get_hermes_home(), 'workspace'))  # the folder Hermes makes in every profile
    with _config_profile_scope(bot):
        terminal = load_config().get('terminal')  # the profile's own config, never the process-wide TERMINAL_CWD
    terminal = terminal if isinstance(terminal, dict) else {}
    backend = str(terminal.get('backend') or '').strip().lower()
    if backend not in ('', 'local'):
        return 'not_local', None
    try:
        remote = _fs_backend(bot)  # an SSH workspace (its env can select one too)
    except Exception:
        return 'not_local', None
    if remote is not None:
        return 'not_local', None
    cwd = terminal.get('cwd')
    if not isinstance(cwd, str) or cwd.strip() in NOT_SET:
        return 'no_workspace', None
    cwd = os.path.expanduser(cwd.strip())
    if not os.path.isabs(cwd):
        return 'no_workspace', None
    real = os.path.realpath(cwd)
    if real == '/' or not os.path.isdir(real):
        return 'no_workspace', None
    root = os.path.realpath(get_default_hermes_root())
    # ADR-004 addendum: the Bot's own <profile home>/workspace (hermes_cli/profiles.py _PROFILE_DIRS) is user data and is
    # accepted, with what is inside it; the rest of the Hermes root (configs, .env, other profiles) stays refused.
    mine = real == own or real.startswith(own + '/')
    if not mine and (real == root or real.startswith(root.rstrip('/') + '/')):
        return 'inside_hermes', None
    try:
        st = os.lstat(os.path.join(real, 'pages'))
    except FileNotFoundError:
        return 'empty', real
    except OSError:
        return 'unsafe', None
    return ('ready', real) if stat.S_ISDIR(st.st_mode) else ('unsafe', None)


def _ready(bot, *, allow_empty=False):
    state, root = workspace(bot)
    if state == 'ready' or (allow_empty and state == 'empty'):
        return state, root
    if state == 'empty':
        raise not_found()  # no pages/ folder: no page exists yet
    raise unavailable(state)


# ---- 2. confinement ------------------------------------------------------------------------------------------------
def valid_slug(slug):
    return isinstance(slug, str) and SLUG.fullmatch(slug) is not None


def _open_pages(root):
    return os.open(os.path.join(root, 'pages'), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)


def _read_at(dfd, slug):
    """(bytes, stat) of one page under the folder's descriptor, or None for anything that is not a plain small file."""
    try:
        fd = os.open(slug + '.md', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dfd)  # a FIFO never blocks us
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > MAX_BYTES:
            return None
        chunks, size = [], 0
        while size <= MAX_BYTES:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        data = b''.join(chunks)
        if len(data) > MAX_BYTES:
            return None
        data.decode('utf-8')  # not UTF-8: not a page (an edit would rewrite bytes)
        return data, st
    except (OSError, UnicodeDecodeError):
        return None
    finally:
        os.close(fd)


def _read(root, slug):
    dfd = _open_pages(root)
    try:
        return _read_at(dfd, slug)
    finally:
        os.close(dfd)


def _check_content(content):
    if not isinstance(content, str) or '\0' in content:
        raise _details('invalid_field', 'Invalid value for content.', 422, field='content')
    if len(content.encode('utf-8')) > MAX_BYTES:
        raise PluginError('too_large', 'A page holds at most 1 MiB.', 413)
    return content


# ---- 3. views ------------------------------------------------------------------------------------------------------
def title_of(text, slug, redact):
    line = next((l for l in text.split('\n') if l.startswith('# ')), None)
    title = redact(line[2:].strip()) if line else ''
    return title[:120] or slug


_FENCE = re.compile(r'^(```|~~~).*?(^\1[^\n]*$|\Z)', re.S | re.M)


def excerpt(text, redact):
    """A-62: plain text of the body, at most 200 characters, redacted BEFORE it is cut."""
    lines = text.split('\n')
    title = next((i for i, l in enumerate(lines) if l.startswith('# ')), None)
    body = '\n'.join(l for i, l in enumerate(lines) if i != title)
    body = _FENCE.sub(' ', body)
    body = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', body)
    body = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', body)
    body = re.sub(r'<[^>\n]*>', ' ', body)
    body = re.sub(r'(?m)^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)', '', body)
    body = re.sub(r'[*_~`]', '', body)
    body = redact(' '.join(body.split()))
    return body if len(body) <= 200 else body[:199].rstrip() + '…'


def actor_label(display_name, redact):
    """A-63: the session's display name, redacted and capped; never an e-mail."""
    if not isinstance(display_name, str) or not display_name.strip() or '@' in display_name:
        return None
    label = redact(display_name.strip())[:60]
    return None if '@' in label else label


def author_label(row, requester, bot_label):
    """(by_you, label) of a revision row, as contract 3.2."""
    if row is None or row['author'] == 'external':
        return False, 'Fora do LuveBot'
    if row['author'] == 'bot':
        return False, bot_label
    if row['actor'] == requester:
        return True, 'Você'
    if row['actor'] == 'dashboard':
        return False, 'Este computador'
    return False, row['actor_label'] or 'Outra pessoa'


# ---- 5. revisions --------------------------------------------------------------------------------------------------
class Revisions:
    def __init__(self, path):
        self.path = path
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def latest(self, bot, slug):
        conn = self._connect()
        try:
            return conn.execute('SELECT * FROM page_revisions WHERE bot=? AND slug=? ORDER BY rev DESC LIMIT 1', (bot, slug)).fetchone()
        finally:
            conn.close()

    def latest_all(self, bot):
        conn = self._connect()
        try:
            return {r['slug']: r for r in conn.execute(
                'SELECT p.* FROM page_revisions p JOIN (SELECT slug, MAX(rev) AS rev FROM page_revisions WHERE bot=? GROUP BY slug) m '
                'ON p.slug=m.slug AND p.rev=m.rev WHERE p.bot=?', (bot, bot))}
        finally:
            conn.close()

    def get(self, bot, slug, rev):
        conn = self._connect()
        try:
            return conn.execute('SELECT * FROM page_revisions WHERE bot=? AND slug=? AND rev=?', (bot, slug, rev)).fetchone()
        finally:
            conn.close()

    def page(self, bot, slug, limit, before=None):
        conn = self._connect()
        try:
            return conn.execute('SELECT * FROM page_revisions WHERE bot=? AND slug=? AND rev<? ORDER BY rev DESC LIMIT ?',
                                (bot, slug, before if before is not None else 2 ** 62, limit)).fetchall()
        finally:
            conn.close()

    def add(self, bot, slug, data, author, origin_kind, origin_ref=None, actor=None, label=None, detail=None):
        """rev = max + 1 in one transaction; only the last KEEP per page are kept (this is not the audit table)."""
        conn = self._connect()
        try:
            conn.execute('BEGIN IMMEDIATE')
            rev = conn.execute('SELECT COALESCE(MAX(rev), 0) + 1 FROM page_revisions WHERE bot=? AND slug=?', (bot, slug)).fetchone()[0]
            conn.execute('INSERT INTO page_revisions (bot, slug, rev, sha, size, content, author, actor, actor_label, origin_kind, '
                         'origin_ref, detail, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (bot, slug, rev, sha256(data), len(data), data.decode('utf-8'), author, actor, label, origin_kind, origin_ref,
                          detail, time.time()))
            conn.execute('DELETE FROM page_revisions WHERE bot=? AND slug=? AND rev<=?', (bot, slug, rev - KEEP))
            conn.commit()
            return rev
        finally:
            conn.close()


# ---- read routes ---------------------------------------------------------------------------------------------------
def writer():
    """Hermes's editor route, or None (then pages are read-only: invariant 9)."""
    try:
        from hermes_cli.web_routers.files import fs_write_text
        return fs_write_text
    except Exception:
        return None


def feature():
    try:
        from hermes_cli.web_routers.files import _fs_backend  # noqa: F401
        from hermes_cli.web_server_profiles import _config_profile_scope  # noqa: F401
    except Exception:
        return 'unavailable'
    return 'ok' if writer() else 'read_only'


def page_view(slug, data, st, latest, who, redact):
    """Page object (contract 3) from the bytes on disk and the latest revision. `who` = (requester actor, bot label)."""
    text = data.decode('utf-8')
    disk = sha256(data)
    outside = latest is None or latest['sha'] != disk
    by_you, label = author_label(None if outside else latest, who[0], who[1])
    redacted = redact(text) != text
    reason = 'redacted' if redacted else None if writer() else 'write_unsupported'
    return {'slug': slug, 'title': title_of(text, slug, redact), 'excerpt': excerpt(text, redact), 'size': st.st_size,
            'mtime': _iso(st.st_mtime), 'sha': disk, 'rev': latest['rev'] if latest else None,
            'author': 'external' if outside else latest['author'], 'author_label': label, 'by_you': by_you,
            'changed_outside': outside, 'editable': reason is None, 'readonly_reason': reason}


def list_pages(db, bot, q, who, redact):
    state, root = workspace(bot)
    if state != 'ready':
        return {'workspace': {'state': state}, 'pages': [], 'skipped': 0}
    latest, found, skipped = db.latest_all(bot), [], 0
    dfd = _open_pages(root)
    try:
        for name in os.listdir(dfd):
            slug = name[:-3] if name.endswith('.md') else None
            read = _read_at(dfd, slug) if slug and valid_slug(slug) else None
            if read is None:
                skipped += 1  # never named in the answer
                continue
            found.append(page_view(slug, read[0], read[1], latest.get(slug), who, redact))
    finally:
        os.close(dfd)
    if q:
        needle = q.casefold()
        found = [p for p in found if needle in p['slug'] or needle in p['title'].casefold()]
    found.sort(key=lambda p: p['mtime'], reverse=True)
    return {'workspace': {'state': state}, 'pages': found[:LIST_MAX], 'skipped': skipped}


def get_page(db, bot, slug, who, redact):
    if not valid_slug(slug):
        raise not_found()
    _state, root = _ready(bot)
    read = _read(root, slug)
    if read is None:
        raise not_found()
    view = page_view(slug, read[0], read[1], db.latest(bot, slug), who, redact)
    text = read[0].decode('utf-8')
    return {**view, 'content': redact(text), 'redacted': redact(text) != text}


def _revision_view(row, who):
    by_you, label = author_label(row, who[0], who[1])
    return {'rev': row['rev'], 'sha': row['sha'], 'author': row['author'], 'author_label': label, 'by_you': by_you,
            'origin_kind': row['origin_kind'], 'origin_ref': row['origin_ref'], 'at': _iso(row['at']), 'size': row['size']}


def revisions(db, bot, slug, limit, cursor, who):
    if not valid_slug(slug):
        raise not_found()
    if cursor is not None and not (isinstance(cursor, str) and re.fullmatch(r'[0-9]{1,9}', cursor)):
        raise PluginError('bad_request', 'Invalid cursor.', 400)
    _ready(bot)
    rows = db.page(bot, slug, limit + 1, int(cursor) if cursor else None)
    return {'revisions': [_revision_view(r, who) for r in rows[:limit]],
            'next_cursor': str(rows[limit - 1]['rev']) if len(rows) > limit else None}


def revision(db, bot, slug, rev, who, redact):
    if not valid_slug(slug):
        raise not_found()
    _ready(bot)
    row = db.get(bot, slug, rev) if isinstance(rev, int) else None
    if row is None:
        raise PluginError('revision_not_found', 'Revision not found.', 404)
    return {**_revision_view(row, who), 'content': redact(row['content']), 'redacted': redact(row['content']) != row['content']}


# ---- 4. write routes -----------------------------------------------------------------------------------------------
def slug_of(title):
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
        raise _details('invalid_field', 'Invalid value for title.', 422, field='title')
    ascii_ = unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode().lower()
    slug = re.sub(r'[^a-z0-9]+', '-', ascii_).strip('-')[:64].strip('-')
    if not slug:
        raise _details('invalid_field', 'Invalid value for title.', 422, field='title')
    return slug


def _hermes_write(bot, root, slug, text):
    """The only writer of page content: Hermes's editor route, in process. The path it reports must be ours (R13)."""
    from fastapi import HTTPException
    from hermes_cli.web_models import FsWriteText
    expected = os.path.join(root, 'pages', slug + '.md')
    try:
        result = asyncio.run(writer()(FsWriteText(path=expected, content=text), profile=bot))
    except HTTPException:
        raise PluginError('hermes_error', 'Hermes could not save the page.', 502) from None  # its detail can hold a path
    if not isinstance(result, dict) or result.get('path') != expected:
        raise PluginError('hermes_error', 'Hermes saved the page somewhere else; check the pages folder.', 502)


def _gate(bot, slug):
    if writer() is None:
        raise _details('capability_missing', 'This Hermes cannot save pages.', 409, feature='pages_write')
    now = time.monotonic()
    if now - _LAST_WRITE.get((bot, slug), -10) < 1:
        raise PluginError('rate_limited', 'One save per second per page.', 429)
    _LAST_WRITE[(bot, slug)] = now


def _mkdir(root):
    """ADR-004: one level, 0700, refused if the name exists as anything but a real directory."""
    pages = os.path.join(root, 'pages')
    try:
        os.mkdir(pages, 0o700)
    except FileExistsError:
        if not stat.S_ISDIR(os.lstat(pages).st_mode):
            raise unavailable('unsafe') from None


def create(db, audit, bot, title, content, who, origin_ref, redact):
    """POST /bots/{bot}/pages. who = {actor, label}."""
    slug = slug_of(title)
    text = _check_content(f'# {title.strip()}\n' if content is None else content)
    data = text.encode('utf-8')
    state, root = _ready(bot, allow_empty=True)
    with _LOCKS[(bot, slug)]:
        if state == 'ready' and os.path.lexists(os.path.join(root, 'pages', slug + '.md')):
            raise _details('page_exists', 'A page with this name already exists.', 409, slug=slug)
        _gate(bot, slug)
        origin = {'kind': 'ui', 'ref': origin_ref}

        def effect():
            if state == 'empty':
                audit.act(who['actor'], 'page.workspace.mkdir', 'pages', origin, lambda: _mkdir(root), bot=bot)
            if os.path.lexists(os.path.join(root, 'pages', slug + '.md')):
                raise _details('page_exists', 'A page with this name already exists.', 409, slug=slug)
            _hermes_write(bot, root, slug, text)
            return db.add(bot, slug, data, 'human', 'ui', origin_ref, who['actor'], who['label'])

        audit.act(who['actor'], 'page.create', slug, origin, effect, bot=bot, payload={'slug': slug, 'sha': sha256(data)})
    page = get_page(db, bot, slug, (who['actor'], who['bot_label']), redact)
    page.pop('content'), page.pop('redacted')
    return page


def _save(db, audit, bot, slug, text, base_sha, who, origin_ref, redact, *, restore=None):
    if not valid_slug(slug):
        raise not_found()
    if not isinstance(base_sha, str) or not re.fullmatch(r'[0-9a-f]{64}', base_sha):
        raise _details('invalid_field', 'Invalid value for base_sha.', 422, field='base_sha')
    _state, root = _ready(bot)
    view = (who['actor'], who['bot_label'])
    with _LOCKS[(bot, slug)]:
        read = _read(root, slug)
        if read is None:
            raise not_found()
        if restore is not None:
            row = db.get(bot, slug, restore)
            if row is None:
                raise PluginError('revision_not_found', 'Revision not found.', 404)
            text = row['content']
        text = _check_content(text)
        disk_text = read[0].decode('utf-8')
        if restore is None and redact(disk_text) != disk_text:
            raise PluginError('page_redacted', 'This page holds something that looks like a secret; edit it through the Bot.', 409)
        disk, latest = sha256(read[0]), db.latest(bot, slug)
        outside = latest is None or latest['sha'] != disk
        if disk != base_sha:
            by_you, label = author_label(None if outside else latest, *view)
            raise _details('page_conflict', 'This page changed since it was loaded.', 409, current_sha=disk,
                           changed_by='external' if outside else latest['author'], changed_by_label=label)
        data = text.encode('utf-8')
        if sha256(data) == disk:
            return {'page': page_view(slug, read[0], read[1], latest, view, redact), 'changed': False}  # autosave no-op
        _gate(bot, slug)
        if outside:  # a version written outside LuveBot is never lost from history
            db.add(bot, slug, read[0], 'external', 'system', origin_ref)
        saved = {}

        def effect():
            _hermes_write(bot, root, slug, text)
            try:
                saved['rev'] = db.add(bot, slug, data, 'human', 'ui', origin_ref, who['actor'], who['label'],
                                      None if restore is None else f'restore:{restore}')
            except sqlite3.Error:
                saved['rev'] = None  # the file the person wrote stays; only its history entry is missing
        action, payload = ('page.update', {'slug': slug, 'base_sha': base_sha, 'new_sha': sha256(data)}) if restore is None else \
            ('page.restore', {'slug': slug, 'rev': restore, 'base_sha': base_sha, 'new_sha': sha256(data)})
        audit.act(who['actor'], action, slug, {'kind': 'ui', 'ref': origin_ref}, effect, bot=bot, payload=payload)
    page = get_page(db, bot, slug, view, redact)
    page.pop('content'), page.pop('redacted')
    out = {'page': page, 'changed': True}
    if saved.get('rev') is None:
        out.update(page={**page, 'rev': None}, history_saved=False)
    return out


def update(db, audit, bot, slug, content, base_sha, who, origin_ref, redact):
    return _save(db, audit, bot, slug, content, base_sha, who, origin_ref, redact)


def restore(db, audit, bot, slug, rev, base_sha, who, origin_ref, redact):
    if not isinstance(rev, int) or rev < 1:
        raise PluginError('revision_not_found', 'Revision not found.', 404)
    return _save(db, audit, bot, slug, None, base_sha, who, origin_ref, redact, restore=rev)


# ---- files of the workspace, as a download (T12) ----
DOWNLOAD_MAX = 25 * 1024 * 1024
TEXT_TYPES = frozenset(('md', 'txt', 'html', 'htm', 'csv', 'json'))
DOWNLOAD_TYPES = TEXT_TYPES | frozenset(('pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip', 'docx', 'xlsx', 'pptx'))


def workspace_unavailable(state):
    return _details('workspace_unavailable', 'The workspace of this Bot is not available.', 409, reason=state)


def file_not_found():
    return Refused('file_not_found', 'File not found.', 404)


def _download_parts(path):
    """Components of a workspace-relative path, or None for anything else (absolute, '..', hidden, empty parts, too deep)."""
    if not isinstance(path, str) or not 1 <= len(path) <= 1024 or '\0' in path or '\\' in path or path.startswith('/'):
        return None
    parts = path.split('/')
    if len(parts) > 16 or any(not part or part.startswith('.') for part in parts):
        return None  # '.', '..', '.env', '.git/…' and empty components all start with '.' or are empty
    name = parts[-1]
    return parts if '.' in name and name.rsplit('.', 1)[1].lower() in DOWNLOAD_TYPES else None


def read_workspace_file(bot, path, redact):
    """(file name, bytes) of a file inside the Bot's workspace, read from the same descriptor that was checked: every
    component opened O_NOFOLLOW under its parent, the file a regular one with one link and at most DOWNLOAD_MAX bytes.
    A text whose redaction differs is refused (409 file_redacted, as A-57): no secret leaves and no file is masked."""
    from hermes_cli.web_routers.files import _is_sensitive_path
    state, root = workspace(bot)
    if state not in ('ready', 'empty'):
        raise workspace_unavailable(state)
    parts = _download_parts(path)
    if parts is None or _is_sensitive_path(Path(root, *parts)):
        raise file_not_found()
    fds = []
    try:
        fds.append(os.open(root, os.O_RDONLY | os.O_DIRECTORY))
        for part in parts[:-1]:
            fds.append(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fds[-1]))
        fds.append(os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fds[-1]))
        st = os.fstat(fds[-1])
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise file_not_found()
        if st.st_size > DOWNLOAD_MAX:
            raise PluginError('too_large', 'This file is larger than 25 MiB.', 413)
        chunks, size = [], 0
        while size <= DOWNLOAD_MAX:
            chunk = os.read(fds[-1], 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        data = b''.join(chunks)
    except OSError:
        raise file_not_found() from None
    finally:
        for fd in reversed(fds):
            os.close(fd)
    if len(data) > DOWNLOAD_MAX:
        raise PluginError('too_large', 'This file is larger than 25 MiB.', 413)
    if parts[-1].rsplit('.', 1)[1].lower() in TEXT_TYPES:
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            raise file_not_found() from None
        if redact(text) != text:
            raise Refused('file_redacted', 'This file holds something that looks like a secret; it is not downloaded.', 409)
    return parts[-1], data


# ---- 7.2 "Pedir ao Bot sobre esta página" ----
NOTE = '[luvebot:page]'


def note(db, bot, slug, who):
    """The server-built context line put before the person's text: metadata only, never page content (A-64)."""
    if not valid_slug(slug):
        raise not_found()
    _state, root = _ready(bot)
    read = _read(root, slug)
    if read is None:
        raise not_found()
    latest = db.latest(bot, slug)
    if latest is None or latest['sha'] != sha256(read[0]):
        edited = f'sem revisão no LuveBot, arquivo de {_iso(read[1].st_mtime)}'
    else:
        edited = f"revisão {latest['rev']}, editada por {author_label(latest, *who)[1]} em {_iso(latest['at'])}"
    return f'{NOTE} A pessoa está vendo pages/{slug}.md ({edited}). Releia o arquivo antes de alterar.'


# ---- 7.1 rescan ----------------------------------------------------------------------------------------------------
def rescan(db, bot, run_id, since, redact):
    """After a writing tool of a run completed: pages whose bytes differ from their latest revision, changed at or after the
    run started (`since`, epoch), become `bot` revisions of that run. Never trusts the tool preview. -> [{slug, rev, title}]"""
    state, root = workspace(bot)
    if state != 'ready':
        return []
    out, seen = [], _SEEN[bot]
    dfd = _open_pages(root)
    try:
        for name in os.listdir(dfd):
            slug = name[:-3] if name.endswith('.md') else None
            if not slug or not valid_slug(slug):
                continue
            read = _read_at(dfd, slug)
            if read is None:
                continue
            data, st = read
            key = (st.st_mtime_ns, st.st_size)
            if seen.get(slug) == key or st.st_mtime < since - 1:
                seen[slug] = key
                continue
            seen[slug] = key
            latest = db.latest(bot, slug)
            if latest is None or latest['sha'] != sha256(data):
                rev = db.add(bot, slug, data, 'bot', 'agent', run_id)
                out.append({'slug': slug, 'rev': rev, 'title': title_of(data.decode('utf-8'), slug, redact)})
    finally:
        os.close(dfd)
    return out


# ---- T14 attachments (ADR-005) -------------------------------------------------------------------------------------
ATTACH_DIR = 'attachments'
IMAGE_MAX = 10 * 1024 * 1024
DOC_MAX = 20 * 1024 * 1024
IMAGE_MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'}
# no BMP: Hermes recognizes it by its first 2 bytes only ('BM'), so a text beginning with "BM" would pass as an image
TEXT_MIME = {'txt': 'text/plain', 'md': 'text/markdown', 'csv': 'text/csv', 'json': 'application/json'}
OFFICE = {'docx': ('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
          'xlsx': ('xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
          'pptx': ('ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')}
MARKUP = ('#!', '<!doctype', '<html', '<svg', '<?xml', '<script')


def attachment_kind(name, data):
    """(extension, mime, cap) decided by the BYTES, or None. Images by Hermes's own check (_chat_image_extension, the chat
    image upload's), BMP excepted; PDF and Office by their signature; text only as UTF-8 without NUL under a text extension, and never a
    script or a markup document. SVG, HTML, executables and anything else: None."""
    from hermes_cli.web_routers.files import _CHAT_IMAGE_ALLOWED_EXTENSIONS, _chat_image_extension
    ext = _chat_image_extension(data)
    if ext in _CHAT_IMAGE_ALLOWED_EXTENSIONS and ext in IMAGE_MIME:
        return ext[1:].replace('jpeg', 'jpg'), IMAGE_MIME[ext], IMAGE_MAX
    if data.startswith(b'%PDF-'):
        return 'pdf', 'application/pdf', DOC_MAX
    if data.startswith(b'PK\x03\x04'):
        try:
            names = set(zipfile.ZipFile(io.BytesIO(data)).namelist())  # the central directory only: nothing is inflated
        except (zipfile.BadZipFile, ValueError, OSError):
            return None
        return next(((e, mime, DOC_MAX) for e, (part, mime) in OFFICE.items() if '[Content_Types].xml' in names and part in names), None)
    claimed = str(name or '').rsplit('.', 1)[-1].lower() if '.' in str(name or '') else ''
    if claimed not in TEXT_MIME or b'\0' in data:
        return None
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return None
    if text.lstrip('\ufeff \t\r\n').lower().startswith(MARKUP):
        return None
    return claimed, TEXT_MIME[claimed], DOC_MAX


def clean_name(name, ext):
    """The name the server keeps: the last component, ASCII letters, digits, '-' and '_' only, at most 60, with the extension
    of the detected type (never the one the browser sent)."""
    base = unicodedata.normalize('NFKD', str(name or '').replace('\\', '/').rsplit('/', 1)[-1])
    stem = base.rsplit('.', 1)[0] if '.' in base else base
    stem = re.sub(r'[^A-Za-z0-9_-]+', '-', stem.encode('ascii', 'ignore').decode()).strip('-_')[:60].strip('-_')
    return f'{stem or "anexo"}.{ext}'


def attachment_refused(reason):
    return _details('attachment_refused', 'This file cannot be attached.', 415, reason=reason)


def _write_attachment(root, name, data):
    """ADR-005: <workspace>/attachments (one level, 0700) and the file written by Hermes's own upload writer
    (stream_upload_to_path: temp file + os.replace, mode 0600). The name is new (uuid), so nothing is ever replaced. The folder
    is held open O_NOFOLLOW across the write; if it was swapped for a link meanwhile, the stray file is removed and refused."""
    from fastapi import HTTPException, UploadFile
    from hermes_cli.web_routers.files import stream_upload_to_path
    folder = os.path.join(root, ATTACH_DIR)
    try:
        os.mkdir(folder, 0o700)
    except FileExistsError:
        pass
    try:
        fd = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        raise workspace_unavailable('unsafe') from None  # a file or a link where the folder should be
    try:
        try:
            asyncio.run(stream_upload_to_path(UploadFile(io.BytesIO(data), filename=name), Path(folder, name),
                                              too_large='too large', not_writable='not writable', write_failed='write failed'))
        except HTTPException:
            raise PluginError('hermes_error', 'Hermes could not save the attachment.', 502) from None  # its detail can hold a path
        try:
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)  # in the folder that was checked, not wherever the path leads now
        except OSError:
            st = None
        if st is None or not stat.S_ISREG(st.st_mode) or st.st_size != len(data):
            try:
                os.unlink(os.path.join(folder, name))  # through the swapped link: the copy that landed elsewhere goes away
            except OSError:
                pass
            raise workspace_unavailable('unsafe')
    finally:
        os.close(fd)


def save_attachment(audit, keyed, actor, bot, filename, data, origin_ref):
    """POST /bots/{bot}/attachments. Audited before the write with the content's HMAC (`keyed`: RunIndex.keyed_digest, this
    database's key, so the audit is no dictionary of known files), size, type and the clean name; never the bytes.
    -> {path, name, type, size, reference}; `reference` is the neutral line the turn carries (the agent reads the file
    itself, through its tools and the rules hook)."""
    from hermes_cli.web_routers.files import _is_sensitive_filename
    state, root = workspace(bot)
    if state not in ('ready', 'empty'):
        raise workspace_unavailable(state)
    if len(data) > DOC_MAX:
        raise PluginError('too_large', 'Attachments are limited to 10 MB (images) and 20 MB (documents).', 413)
    kind = attachment_kind(filename, data)
    if kind is None:
        raise attachment_refused('type')
    ext, mime, cap = kind
    if len(data) > cap:
        raise PluginError('too_large', 'Attachments are limited to 10 MB (images) and 20 MB (documents).', 413)
    name = clean_name(filename, ext)
    original = str(filename or '').replace('\\', '/').rsplit('/', 1)[-1]
    if _is_sensitive_filename(original) or _is_sensitive_filename(name):
        raise attachment_refused('sensitive_name')
    stored = f'{uuid.uuid4().hex}-{name}'
    digest = keyed(data)
    audit.act(actor, 'attachment.upload', digest, {'kind': 'ui', 'ref': origin_ref}, lambda: _write_attachment(root, stored, data),
              bot=bot, payload={'hmac': digest, 'size': len(data), 'type': mime, 'name': name})
    path = f'{ATTACH_DIR}/{stored}'
    size = f'{len(data) / 1024 / 1024:.1f} MB' if len(data) >= 1024 * 1024 else f'{max(1, round(len(data) / 1024))} KB'
    return {'path': path, 'name': name, 'type': mime, 'size': len(data),
            'reference': f'[Anexo: {path}, {mime}, {size}]'}


def set_own_workspace(audit, actor, bot, origin_ref):
    """POST /bots/{bot}/workspace (ADR-005 §3): a Bot WITHOUT terminal.cwd (the default profile, as installed) gets its own
    <profile home>/workspace, through Hermes's config writer in the profile's scope; the folder is made if missing (one level,
    0700). Audited first. Never over a cwd the owner set, even a broken one, and never for a non-local terminal. If the final
    check fails, the previous terminal.cwd (or its absence) and a folder made here are put back. -> new state"""
    from hermes_cli.config import load_config, read_raw_config, set_config_value, unset_config_value
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_constants import get_hermes_home
    state, _root = workspace(bot)
    with _config_profile_scope(bot):
        settings = load_config().get('terminal')
        own = os.path.join(get_hermes_home(), 'workspace')
    cwd = settings.get('cwd') if isinstance(settings, dict) else None
    if state != 'no_workspace' or (isinstance(cwd, str) and cwd.strip() not in NOT_SET):
        raise _details('workspace_not_changed', 'This Bot already has a working folder set; it is kept.', 409, reason=state)

    def effect():
        made = False
        try:
            os.mkdir(own, 0o700)
            made = True
        except FileExistsError:
            if not stat.S_ISDIR(os.lstat(own).st_mode):
                raise workspace_unavailable('unsafe') from None
        with _config_profile_scope(bot):
            raw = read_raw_config().get('terminal')
            previous = raw.get('cwd') if isinstance(raw, dict) else None
            set_config_value('terminal.cwd', own)
        if workspace(bot)[0] not in ('ready', 'empty'):  # e.g. a managed install, where Hermes's writer declines
            with _config_profile_scope(bot):
                if previous is None:
                    unset_config_value('terminal.cwd')
                else:
                    set_config_value('terminal.cwd', previous)
            if made:
                try:
                    os.rmdir(own)
                except OSError:
                    pass
            raise PluginError('hermes_error', 'Hermes did not keep the working folder; nothing was changed.', 502)
    audit.act(actor, 'bot.workspace.set', bot, {'kind': 'ui', 'ref': origin_ref}, effect, bot=bot)
    return workspace(bot)[0]
