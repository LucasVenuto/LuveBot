"""Display metadata of a Bot (contract section 4): lives in the LuveBot DB, never in Hermes."""
import hashlib
import re
import sqlite3

from . import dbfile
from .api_errors import PluginError

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bot_meta (
    bot TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL, call_me TEXT,
    color TEXT NOT NULL, avatar_kind TEXT NOT NULL, avatar_value TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS person_display (actor TEXT PRIMARY KEY, avatar_kind TEXT NOT NULL, avatar_value TEXT NOT NULL);
"""
FIELDS = ('label', 'role', 'call_me', 'color', 'avatar', 'hidden', 'pinned')
# ponytail: same palette as the UI (docs/propostas/design-luve.md); the UI may still send any #RRGGBB.
_PALETTE = ('#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#fb923c', '#e879f9')
# Contract v0 section 14.1 (A-53): the only mascot ids, byte for byte. The UI has the same list; test_mascot.py ties both to
# assets/mascots/manifest.json.
MASCOT_IDS = frozenset(('luvi', 'brisa', 'faro', 'pipo', 'nimbo', 'tinta', 'rumo', 'vera', 'zuca', 'niquel', 'quadra', 'flora',
                        'eco', 'lacre', 'tico'))
# "Crie seu Luve" (docs/propostas/v02-crie-seu-luve.md §4 and §8 Q1): a recipe "<shape>.<material>.<accessory>.<rrggbb>", one
# spelling only (lowercase hex, no "#"). Shapes are MASCOT_IDS; the lists are byte for byte those of assets/mascots/luve-kit.json
# (tests/unit/backend/test_luve_recipe.py ties them). The ids only ever pick shipped pieces in the UI; nothing else is stored.
LUVE_MATERIALS = frozenset(('vinil', 'laca', 'fosco', 'metal'))
LUVE_ACCESSORIES = frozenset(('nenhum', 'headset', 'lupa', 'helice', 'antena', 'lapis', 'check', 'balao', 'barras', 'boina',
                              'coracao', 'cadeado', 'sinos'))
_LUVE = re.compile(r'([a-z]+)\.([a-z]+)\.([a-z]+)\.([0-9a-f]{6})')
IMAGE_ID = re.compile(r'img_[0-9a-f]{32}')   # an uploaded face (contract v0.11 section 2.2): the id of a row of `avatar_images`, never a URL and never a data URI


def is_luve(value):
    match = _LUVE.fullmatch(value) if isinstance(value, str) else None
    return bool(match) and match[1] in MASCOT_IDS and match[2] in LUVE_MATERIALS and match[3] in LUVE_ACCESSORIES


_CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f\u2028\u2029]')


def _bad(field):
    return PluginError('invalid_field', f'Invalid value for {field}.', 422)


def _text(value, field, maximum, *, optional=False, empty=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or len(value) > maximum or _CONTROL.search(value) or (not empty and not value.strip()):
        raise _bad(field)
    return value


def _unknown_image():
    return PluginError('avatar_unknown', 'This image does not exist or is not yours.', 422)


def validate_display(body, *, complete=False, owns=None, current=None):
    """Returns only known, validated fields. Unknown keys are refused, not ignored. A display write is a PATCH: one that carries no `avatar` keeps the current face untouched (no check, no change, no error).
    `{kind: image, value}` needs `value` to be `img_` and 32 hex digits AND the image to exist and be the WRITER's (`owns(value)`, none given = refused): ownership is checked on the image being SET, never on the
    one being replaced, and an `avatar` equal to the one already stored (`current`) is a no-op for any writer, so a client that resends the whole display cannot lock a Bot's name behind someone else's image."""
    if not isinstance(body, dict) or set(body) - set(FIELDS):
        raise PluginError('invalid_field', 'Unknown or malformed display fields.', 422)
    out = {}
    if 'label' in body:
        out['label'] = _text(body['label'], 'label', 60)
    if 'role' in body:
        out['role'] = _text(body['role'], 'role', 160, empty=True)
    if 'call_me' in body:
        out['call_me'] = _text(body['call_me'], 'call_me', 60, optional=True)
    if 'color' in body:
        if not isinstance(body['color'], str) or not re.fullmatch(r'#[0-9A-Fa-f]{6}', body['color']):
            raise _bad('color')
        out['color'] = body['color']
    if 'avatar' in body:
        avatar = body['avatar']
        if not isinstance(avatar, dict) or set(avatar) != {'kind', 'value'} or avatar['kind'] not in ('emoji', 'initials', 'mascot', 'luve', 'image'):
            raise _bad('avatar')
        value = avatar['value']
        if avatar['kind'] == 'image':
            if not isinstance(value, str) or IMAGE_ID.fullmatch(value) is None:
                raise _unknown_image()
            if current != {'kind': 'image', 'value': value} and not (owns is not None and owns(value)):
                raise _unknown_image()
        elif avatar['kind'] == 'mascot':
            if not isinstance(value, str) or value not in MASCOT_IDS:
                raise _bad('avatar')
        elif avatar['kind'] == 'luve':
            if not is_luve(value):
                raise _bad('avatar')
        else:
            _text(value, 'avatar', 16)
        out['avatar'] = {'kind': avatar['kind'], 'value': value}
    for flag in ('hidden', 'pinned'):  # v0.8 section 9: pinned; hidden pauses nothing (spec 4.1)
        if flag in body:
            if not isinstance(body[flag], bool):
                raise _bad(flag)
            out[flag] = body[flag]
    return out


def validate_order(body, names):
    """{"bots": [...]}: exactly a permutation of the listed Bots (none missing, none extra, none twice), else 422."""
    if not isinstance(body, dict) or set(body) != {'bots'} or not isinstance(body['bots'], list):
        raise PluginError('bad_request', 'Send {"bots": [names in order]}.', 400)
    order = body['bots']
    if not all(isinstance(n, str) for n in order) or len(order) != len(set(order)) or set(order) != set(names):
        raise PluginError('invalid_field', 'The order must list every Bot exactly once.', 422)
    return order

def validate_person(body, *, owns=None, current=None):
    """The person's own face (Crie seu Luve B2, proposal §8 Q3): only `avatar`, by the same rule as a Bot's (the person is the only writer)."""
    if not isinstance(body, dict) or set(body) != {'avatar'}:
        raise PluginError('invalid_field', 'Only the avatar can be set here.', 422)
    return validate_display(body, owns=owns, current=current)


def default_display(name):
    index = int(hashlib.sha256(name.encode()).hexdigest(), 16) % len(_PALETTE)
    return {'label': name, 'role': '', 'call_me': None, 'color': _PALETTE[index],
            'avatar': {'kind': 'initials', 'value': name[:2].upper()}, 'hidden': False, 'pinned': False, 'position': None}


class BotMeta:
    """Opens the LuveBot DB that AuditLog already created (0600); only bot_meta is ours."""

    def __init__(self, path):
        self.path = path
        conn = self._connect()
        try:
            dbfile.ensure(conn, path, _SCHEMA, self._migrate)
        finally:
            conn.close()

    @staticmethod
    def _migrate(conn):
        have = {row[1] for row in conn.execute('PRAGMA table_info(bot_meta)')}
        for column, kind in (('template_id', 'TEXT'), ('intro_session_id', 'TEXT'), ('intro_run_id', 'TEXT'),  # v0.4 B4
                             ('pinned', 'INTEGER NOT NULL DEFAULT 0'), ('position', 'INTEGER')):           # v0.8 section 9
            if column not in have:
                conn.execute(f'ALTER TABLE bot_meta ADD COLUMN {column} {kind}')

    def _connect(self):
        conn = dbfile.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _display(name, row):
        base = default_display(name)
        if row is None:
            return base
        legacy = row['avatar_kind'] == 'image' and IMAGE_ID.fullmatch(row['avatar_value']) is None   # a row from before uploads existed: read as initials, as ever
        return {'label': row['label'], 'role': row['role'], 'call_me': row['call_me'], 'color': row['color'],
                'avatar': base['avatar'] if legacy else {'kind': row['avatar_kind'], 'value': row['avatar_value']}, 'hidden': bool(row['hidden']),
                'pinned': bool(row['pinned']), 'position': row['position']}

    def all(self):
        conn = self._connect()
        try:
            return {row['bot']: row for row in conn.execute('SELECT * FROM bot_meta')}
        finally:
            conn.close()

    def get(self, name):
        conn = self._connect()
        try:
            return self._display(name, conn.execute('SELECT * FROM bot_meta WHERE bot=?', (name,)).fetchone())
        finally:
            conn.close()

    def display_for(self, name, rows):
        return self._display(name, rows.get(name))

    def upsert(self, name, changes):
        """Merge validated changes over the current display (or the defaults)."""
        merged = {**self.get(name), **changes}
        conn = self._connect()
        try:
            conn.execute(
                'INSERT INTO bot_meta (bot,label,role,call_me,color,avatar_kind,avatar_value,hidden,pinned) VALUES (?,?,?,?,?,?,?,?,?) '
                'ON CONFLICT(bot) DO UPDATE SET label=excluded.label, role=excluded.role, call_me=excluded.call_me, '
                'color=excluded.color, avatar_kind=excluded.avatar_kind, avatar_value=excluded.avatar_value, hidden=excluded.hidden, '
                'pinned=excluded.pinned',
                (name, merged['label'], merged['role'], merged['call_me'], merged['color'],
                 merged['avatar']['kind'], merged['avatar']['value'], int(merged['hidden']), int(merged['pinned'])))
            conn.commit()
        finally:
            conn.close()
        return merged

    def set_order(self, names):
        """v0.8 section 9: the shared sidebar order, every position in ONE transaction (a Bot with no row gets its defaults)."""
        conn = self._connect()
        try:
            with conn:
                for position, name in enumerate(names):
                    base = default_display(name)
                    conn.execute('INSERT OR IGNORE INTO bot_meta (bot,label,role,call_me,color,avatar_kind,avatar_value) VALUES (?,?,?,?,?,?,?)',
                                 (name, base['label'], base['role'], base['call_me'], base['color'], base['avatar']['kind'], base['avatar']['value']))
                    conn.execute('UPDATE bot_meta SET position=? WHERE bot=?', (position, name))
        finally:
            conn.close()

    def person(self, actor):
        """The face of WHO IS VIEWING (the actor of /session), or None: Hermes does not record which person sent a message."""
        conn = self._connect()
        try:
            row = conn.execute('SELECT avatar_kind, avatar_value FROM person_display WHERE actor=?', (actor,)).fetchone()
            return {'kind': row['avatar_kind'], 'value': row['avatar_value']} if row and not (row['avatar_kind'] == 'image' and IMAGE_ID.fullmatch(row['avatar_value']) is None) else None
        finally:
            conn.close()

    def set_person(self, actor, avatar):
        self._write('INSERT INTO person_display (actor, avatar_kind, avatar_value) VALUES (?,?,?) ON CONFLICT(actor) DO UPDATE '
                    'SET avatar_kind=excluded.avatar_kind, avatar_value=excluded.avatar_value', (actor, avatar['kind'], avatar['value']))
        return self.person(actor)

    def set_template(self, name, template_id):
        self._write('UPDATE bot_meta SET template_id=? WHERE bot=?', (template_id, name))

    def introduction(self, name):
        conn = self._connect()
        try:
            row = conn.execute('SELECT template_id, intro_session_id, intro_run_id FROM bot_meta WHERE bot=?', (name,)).fetchone()
            return dict(row) if row else {}
        finally:
            conn.close()

    def set_intro(self, name, session_id, run_id):
        self._write('UPDATE bot_meta SET intro_session_id=?, intro_run_id=? WHERE bot=?', (session_id, run_id, name))

    def _write(self, sql, args):
        conn = self._connect()
        try:
            conn.execute(sql, args)
            conn.commit()
        finally:
            conn.close()

    def delete(self, name):
        conn = self._connect()
        try:
            conn.execute('DELETE FROM bot_meta WHERE bot=?', (name,))
            conn.commit()
        finally:
            conn.close()
