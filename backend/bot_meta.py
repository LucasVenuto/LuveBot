"""Display metadata of a Bot (contract section 4): lives in the LuveBot DB, never in Hermes."""
import hashlib
import re
import sqlite3

from .api_errors import PluginError

_SCHEMA = """
CREATE TABLE IF NOT EXISTS bot_meta (
    bot TEXT PRIMARY KEY, label TEXT NOT NULL, role TEXT NOT NULL, call_me TEXT,
    color TEXT NOT NULL, avatar_kind TEXT NOT NULL, avatar_value TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0
);
"""
FIELDS = ('label', 'role', 'call_me', 'color', 'avatar', 'hidden')
# ponytail: same palette as the UI (docs/propostas/design-luve.md); the UI may still send any #RRGGBB.
_PALETTE = ('#60a5fa', '#34d399', '#a78bfa', '#fbbf24', '#fb7185', '#38bdf8', '#fb923c', '#e879f9')
# Contract v0 section 14.1 (A-53): the only mascot ids, byte for byte. The UI has the same list; test_mascot.py ties both to
# assets/mascots/manifest.json.
MASCOT_IDS = frozenset(('luvi', 'brisa', 'faro', 'pipo', 'nimbo', 'tinta', 'rumo', 'vera', 'zuca', 'niquel', 'quadra', 'flora',
                        'eco', 'lacre', 'tico'))
_CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f  ]')


def _bad(field):
    return PluginError('invalid_field', f'Invalid value for {field}.', 422)


def _text(value, field, maximum, *, optional=False, empty=False):
    if value is None and optional:
        return None
    if not isinstance(value, str) or len(value) > maximum or _CONTROL.search(value) or (not empty and not value.strip()):
        raise _bad(field)
    return value


def validate_display(body, *, complete=False):
    """Returns only known, validated fields. Unknown keys are refused, not ignored."""
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
        # A-54: 'image' is refused on write until an upload contract exists (a stored legacy row is still read as-is)
        if not isinstance(avatar, dict) or set(avatar) != {'kind', 'value'} or avatar['kind'] not in ('emoji', 'initials', 'mascot'):
            raise _bad('avatar')
        value = avatar['value']
        if avatar['kind'] == 'mascot':
            if not isinstance(value, str) or value not in MASCOT_IDS:
                raise _bad('avatar')
        else:
            _text(value, 'avatar', 16)
        out['avatar'] = {'kind': avatar['kind'], 'value': value}
    if 'hidden' in body:
        if not isinstance(body['hidden'], bool):
            raise _bad('hidden')
        out['hidden'] = body['hidden']
    return out


def default_display(name):
    index = int(hashlib.sha256(name.encode()).hexdigest(), 16) % len(_PALETTE)
    return {'label': name, 'role': '', 'call_me': None, 'color': _PALETTE[index],
            'avatar': {'kind': 'initials', 'value': name[:2].upper()}, 'hidden': False}


class BotMeta:
    """Opens the LuveBot DB that AuditLog already created (0600); only bot_meta is ours."""

    def __init__(self, path):
        self.path = path
        conn = self._connect()
        try:
            conn.executescript(_SCHEMA)
            have = {row[1] for row in conn.execute('PRAGMA table_info(bot_meta)')}
            for column in ('template_id', 'intro_session_id', 'intro_run_id'):  # v0.4 B4: the template and the one introduction
                if column not in have:
                    conn.execute(f'ALTER TABLE bot_meta ADD COLUMN {column} TEXT')
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    @staticmethod
    def _display(name, row):
        base = default_display(name)
        if row is None:
            return base
        return {'label': row['label'], 'role': row['role'], 'call_me': row['call_me'], 'color': row['color'],
                'avatar': {'kind': row['avatar_kind'], 'value': row['avatar_value']}, 'hidden': bool(row['hidden'])}

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
                'INSERT INTO bot_meta (bot,label,role,call_me,color,avatar_kind,avatar_value,hidden) VALUES (?,?,?,?,?,?,?,?) '
                'ON CONFLICT(bot) DO UPDATE SET label=excluded.label, role=excluded.role, call_me=excluded.call_me, '
                'color=excluded.color, avatar_kind=excluded.avatar_kind, avatar_value=excluded.avatar_value, hidden=excluded.hidden',
                (name, merged['label'], merged['role'], merged['call_me'], merged['color'],
                 merged['avatar']['kind'], merged['avatar']['value'], int(merged['hidden'])))
            conn.commit()
        finally:
            conn.close()
        return merged

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
