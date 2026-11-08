"""The images people send to wear as a face (contract plugin-api v0.11 section 2.2): the table, the upload, the read rule, the delete, the quotas and the sweep. The PNG itself is `png_avatar`'s: nothing is stored
that it did not write.

  table `avatar_images (id, owner, sha256, bytes, created_at, UNIQUE (owner, sha256))` in luvebot.db; `id = "img_" + 32 hex` (unguessable); `owner` is the actor of the session (`provider:user_id` when gated,
  `dashboard` in loopback);
  limits: 10 images per owner, 50 in all, 8 MiB in all (`409 avatar_quota`); the same owner sending the same pixels gets the existing id back (`replayed`);
  who may read an image: its OWNER always; anyone with a login only while a BOT wears it (a Bot's face is public to the logins like its name); a person's own face is read by that person only. Anyone else gets `404`,
  never `403`, so nothing says that an image exists; and `If-None-Match` is looked at AFTER that rule (the route's job), so an ETag can never confirm another person's image;
  the delete: the owner only, `409 avatar_in_use` while any Bot or person wears it, on a connection with `PRAGMA secure_delete = ON` (a backup made before still holds the image);
  the sweep: an unreferenced image older than 24 h is deleted when an upload comes in (no background job).
What is worn is counted from the stored displays (`bot_meta`, `person_display`), never kept apart, so it cannot drift. The audit holds the sha256 and the size, never the bytes."""
import hashlib
import re
import time
from uuid import uuid4

from . import dbfile, png_avatar
from .api_errors import PluginError

IMAGE_ID = re.compile(r'img_[0-9a-f]{32}')
PER_OWNER, IN_ALL, BYTES_IN_ALL = 10, 50, 8 * 1024 * 1024
SWEEP_SECONDS = 24 * 60 * 60
_SCHEMA = """
CREATE TABLE IF NOT EXISTS avatar_images (id TEXT PRIMARY KEY, owner TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL, UNIQUE (owner, sha256));
"""
_WORN_BY_BOTS = "SELECT bot FROM bot_meta WHERE avatar_kind = 'image' AND avatar_value = ? ORDER BY bot"
_WORN_BY_PEOPLE = "SELECT COUNT(*) FROM person_display WHERE avatar_kind = 'image' AND avatar_value = ?"


def not_found():
    return PluginError('avatar_not_found', 'Image not found.', 404)


def etag_matches(header, sha256):
    """`If-None-Match` against this image's strong ETag (the sha256): a list, weak validators and `*` are read as HTTP does for a GET."""
    wanted = f'"{sha256}"'
    for token in (header or '').split(','):
        token = token.strip()
        if token == '*' or (token[2:] if token.startswith('W/') else token) == wanted:
            return True
    return False


class Avatars:
    """Opens the LuveBot DB that BotMeta already created (the worn faces are read from its tables)."""

    def __init__(self, path):
        self.path = path

    def _connect(self):
        conn = dbfile.connect(self.path)
        dbfile.ensure(conn, self.path, _SCHEMA)
        conn.execute('PRAGMA secure_delete = ON')           # every delete of this module overwrites the bytes in the page
        return conn

    def owns(self, actor, image_id):
        """True when the image exists and `actor` is its owner: what the display validator asks before a face is SET."""
        if type(image_id) is not str or IMAGE_ID.fullmatch(image_id) is None:
            return False
        conn = self._connect()
        try:
            return conn.execute('SELECT 1 FROM avatar_images WHERE id = ? AND owner = ?', (image_id, actor)).fetchone() is not None
        finally:
            conn.close()

    def upload(self, audit, actor, body, ref):
        """-> (replayed, {id, width, height, bytes[, replayed]}). The PNG is re-encoded first (a refusal is 422 before any audit row); then, inside ONE audit row (intent first, the sha256 and the size, never the bytes):
        sweep, the existing id back for the same owner and pixels, the quotas, the insert."""
        png = png_avatar.reencode(body)
        sha256 = hashlib.sha256(png).hexdigest()

        def effect():
            conn = self._connect()
            try:
                conn.execute('BEGIN IMMEDIATE')
                self._sweep(conn)
                row = conn.execute('SELECT id FROM avatar_images WHERE owner = ? AND sha256 = ?', (actor, sha256)).fetchone()
                if row is not None:
                    conn.commit()
                    return row[0], True
                total, size = conn.execute('SELECT COUNT(*), COALESCE(SUM(LENGTH(bytes)), 0) FROM avatar_images').fetchone()
                mine = conn.execute('SELECT COUNT(*) FROM avatar_images WHERE owner = ?', (actor,)).fetchone()[0]
                if mine >= PER_OWNER:
                    raise PluginError('avatar_quota', f'You can keep {PER_OWNER} images; remove one you no longer wear first.', 409)
                if total >= IN_ALL or size + len(png) > BYTES_IN_ALL:
                    raise PluginError('avatar_quota', 'This LuveBot has reached its limit of stored images; remove one that nobody wears first.', 409)
                image_id = 'img_' + uuid4().hex
                conn.execute('INSERT INTO avatar_images (id, owner, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?)', (image_id, actor, sha256, png, int(time.time())))
                conn.commit()
                return image_id, False
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.close()
        image_id, replayed = audit.act(actor, 'avatar.upload', None, {'kind': 'ui', 'ref': ref}, effect, payload={'sha256': sha256, 'bytes': len(png)})
        return replayed, {'id': image_id, 'width': png_avatar.SIZE, 'height': png_avatar.SIZE, 'bytes': len(png), **({'replayed': True} if replayed else {})}

    @staticmethod
    def _sweep(conn):
        """An image nobody wears and older than 24 h goes, whoever owns it (the same pass makes room for the quota)."""
        conn.execute("DELETE FROM avatar_images WHERE created_at < ? AND id NOT IN (SELECT avatar_value FROM bot_meta WHERE avatar_kind = 'image') "
                     "AND id NOT IN (SELECT avatar_value FROM person_display WHERE avatar_kind = 'image')", (int(time.time()) - SWEEP_SECONDS,))

    def read(self, actor, image_id):
        """-> (sha256, bytes). 404 for anything the rule does not allow: the owner always, anyone only while a Bot wears it. The same 404 for an id that does not exist."""
        if type(image_id) is not str or IMAGE_ID.fullmatch(image_id) is None:
            raise not_found()
        conn = self._connect()
        try:
            row = conn.execute('SELECT owner, sha256, bytes FROM avatar_images WHERE id = ?', (image_id,)).fetchone()
            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None):
                raise not_found()
            return row[1], bytes(row[2])
        finally:
            conn.close()

    def _worn(self, conn, image_id):
        return [r[0] for r in conn.execute(_WORN_BY_BOTS, (image_id,))], conn.execute(_WORN_BY_PEOPLE, (image_id,)).fetchone()[0]

    def delete(self, audit, actor, image_id, ref):
        """The owner only (another login gets 404); `409 avatar_in_use` while a Bot or a person wears it (the screen says who to change first). Checked before the audit row and again inside it."""
        sha256 = self._owned(actor, image_id)

        def effect():
            conn = self._connect()
            try:
                conn.execute('BEGIN IMMEDIATE')
                row = conn.execute('SELECT owner FROM avatar_images WHERE id = ?', (image_id,)).fetchone()
                if row is None or row[0] != actor:
                    raise not_found()
                bots, people = self._worn(conn, image_id)
                if bots or people:
                    raise PluginError('avatar_in_use', 'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})
                conn.execute('DELETE FROM avatar_images WHERE id = ?', (image_id,))
                conn.commit()
            except BaseException:
                conn.rollback()
                raise
            finally:
                conn.close()
        audit.act(actor, 'avatar.delete', image_id, {'kind': 'ui', 'ref': ref}, effect, payload={'sha256': sha256})
        return {'id': image_id, 'deleted': True}

    def _owned(self, actor, image_id):
        """The sha256 of an image `actor` owns, else 404; 409 here too when it is worn (the same answer the effect gives, before an audit row exists)."""
        if type(image_id) is not str or IMAGE_ID.fullmatch(image_id) is None:
            raise not_found()
        conn = self._connect()
        try:
            row = conn.execute('SELECT owner, sha256 FROM avatar_images WHERE id = ?', (image_id,)).fetchone()
            if row is None or row[0] != actor:
                raise not_found()
            bots, people = self._worn(conn, image_id)
            if bots or people:
                raise PluginError('avatar_in_use', 'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})
            return row[1]
        finally:
            conn.close()
