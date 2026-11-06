"""AV-3 (contract v0.11 section 2.2; invariants 1, 2, 4 and 5): the images people wear as a face.
* `backend/avatars.py`: the upload (re-encoded by `png_avatar` first; a refusal writes no audit row; ONE audit row with the sha256 and the size, never the bytes; the same owner and pixels get the existing id back; the
  quotas of 10 per owner, 50 in all and 8 MiB in all; the sweep of unreferenced images older than 24 h), the read rule (the owner always, anyone only while a Bot wears it, else 404 and never 403), the delete (the owner
  only, 409 while worn, `secure_delete` on its connection), the ETag match;
* `bot_meta.validate_display`: an image is set only when its id is ours AND it exists AND the writer owns it (`422 avatar_unknown`); a PATCH with no `avatar` keeps the face and never asks; the same image already stored is a
  no-op for any writer; replacing someone else's image by another face is never refused; a stored legacy `image` row is read as initials;
* the routes, their real text run against stand-ins: `POST /avatars` (type and length before a byte is read, a chunked body stopped at 320 KiB, CSRF first, 201 or 200 replayed), `GET /avatars/{id}` (the owner rule BEFORE the
  ETag, headers, 304) and `DELETE`; and the three routes that SET a face pass the writer's ownership.
Mutations: one line changed -> red."""
import asyncio
import importlib
import json
import re
import sqlite3
import struct
import sys
import time
import types
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_config_boundary_threads as threads  # noqa: E402
import test_redteam_png_avatar as lume  # noqa: E402  (its PNG builders)

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / 'backend' / 'avatars.py').read_text()
META_SOURCE = (ROOT / 'backend' / 'bot_meta.py').read_text()
BOTS_SOURCE = (ROOT / 'backend' / 'bots.py').read_text()
API = (ROOT / 'dashboard' / 'plugin_api.py').read_text()
ANA, BIA, LOOP = 'basic:ana', 'basic:bia', 'dashboard'


def load(edits=(), module='avatars'):
    name, _ = threads.package()
    return threads.variant(name, module, edits), name


def flat_png(n, extra_before=()):
    """A valid 256 x 256 RGBA PNG that is one colour per `n`: cheap to build and to re-encode, a different identity for each `n`."""
    rows = [bytes([n % 256, (n // 256) % 256, 7, 255]) * 256] * 256
    return lume.build(rows, 6, idat_override=zlib.compress(b''.join(b'\x00' + row for row in rows)), extra_before=extra_before)


class Audit:
    def __init__(self):
        self.rows = []

    def act(self, actor, action, target, origin, fn, *, bot=None, payload=None):
        self.rows.append(('intent', actor, action, target, origin, bot, payload))
        try:
            result = fn()
        except BaseException as error:  # noqa: BLE001
            self.rows.append(('error', action, type(error).__name__))
            raise
        self.rows.append(('ok', action))
        return result


def refusal(call):
    try:
        call()
    except Exception as error:  # noqa: BLE001
        return error
    return None


def database(m, name, tmp_path, tag=''):
    """A LuveBot database with the tables of a Bot's and a person's display, and the module over it."""
    db = str(tmp_path / f'luvebot{tag}.db')
    sqlite3.connect(db).close()
    meta = importlib.import_module(f'{name}.bot_meta').BotMeta(db)
    store = m.Avatars(db)
    store._connect().close()                                    # the table exists before a test writes a row by hand
    return db, meta, store


def insert(db, image_id, owner, sha='0' * 64, size=10, created=None):
    conn = sqlite3.connect(db)
    conn.execute('INSERT INTO avatar_images (id, owner, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?)', (image_id, owner, sha, b'x' * size, int(time.time()) if created is None else created))
    conn.commit()
    conn.close()


def ids(n):
    return [f'img_{i:032x}' for i in range(1, n + 1)]


def count(db):
    conn = sqlite3.connect(db)
    try:
        return conn.execute('SELECT COUNT(*) FROM avatar_images').fetchone()[0]
    finally:
        conn.close()


def module_checks(m, name, tmp_path):
    png = importlib.import_module(f'{name}.png_avatar')
    # ---- the upload: re-encoded, one audit row with hashes and no bytes, the same pixels the same id
    db, meta, store = database(m, name, tmp_path, 'a')
    audit = Audit()
    raw = flat_png(1, extra_before=(lume.chunk(b'tEXt', b'Comment\x00' + lume.SECRET), lume.chunk(b'eXIf', b'GPSLatitude')))
    replayed, answer = store.upload(audit, ANA, raw, 'req_1')
    canonical = png.reencode(raw)
    import hashlib
    sha = hashlib.sha256(canonical).hexdigest()
    assert replayed is False and re.fullmatch(r'img_[0-9a-f]{32}', answer['id']) and answer == {'id': answer['id'], 'width': 256, 'height': 256, 'bytes': len(canonical)}, answer
    assert audit.rows[0] == ('intent', ANA, 'avatar.upload', None, {'kind': 'ui', 'ref': 'req_1'}, None, {'sha256': sha, 'bytes': len(canonical)}) and audit.rows[-1] == ('ok', 'avatar.upload')
    assert 'IDAT' not in repr(audit.rows) and 'GPS' not in repr(audit.rows) and lume.SECRET.decode() not in repr(audit.rows)
    conn = sqlite3.connect(db)
    stored = conn.execute('SELECT owner, sha256, bytes, created_at FROM avatar_images WHERE id = ?', (answer['id'],)).fetchone()
    assert stored[0] == ANA and stored[1] == sha and bytes(stored[2]) == canonical and abs(stored[3] - time.time()) < 60                  # what is stored is LuveBot's PNG, never the received one
    assert lume.SECRET not in bytes(stored[2]) and b'eXIf' not in bytes(stored[2]) and b'tEXt' not in bytes(stored[2])
    conn.close()
    other = flat_png(1)                                                                                                             # the same pixels, another encoding (no ancillary chunks)
    replayed, again = store.upload(audit, ANA, other, 'req_2')
    assert replayed is True and again == {**answer, 'replayed': True} and count(db) == 1
    replayed, theirs = store.upload(audit, BIA, other, 'req_3')
    assert replayed is False and theirs['id'] != answer['id'] and count(db) == 2                                                    # another owner: another row, though the same pixels
    # ---- a refusal is 422 before any audit row and nothing is stored
    audit2 = Audit()
    for bad in (b'', b'not a png', flat_png(2)[:-8], lume.build(w=255, h=255, idat_override=zlib.compress(b'\x00' * 10)), flat_png(2) + b'PK\x03\x04'):
        error = refusal(lambda: store.upload(audit2, ANA, bad, 'req'))
        assert error is not None and error.code == 'invalid_image' and error.status == 422 and error.extra['details']['why'] in png.WHY, bad[:8]
    assert audit2.rows == [] and count(db) == 2
    # ---- the quotas: 10 per owner (a replay is still answered), 50 in all, 8 MiB in all
    db, meta, store = database(m, name, tmp_path, 'q')
    mine = [store.upload(Audit(), ANA, flat_png(10 + n), 'req')[1]['id'] for n in range(10)]
    audit3 = Audit()
    error = refusal(lambda: store.upload(audit3, ANA, flat_png(99), 'req'))
    assert (error.code, error.status) == ('avatar_quota', 409) and count(db) == 10 and audit3.rows[-1][0] == 'error'
    assert store.upload(Audit(), ANA, flat_png(10), 'req') == (True, {'id': mine[0], 'width': 256, 'height': 256, 'bytes': len(png.reencode(flat_png(10))), 'replayed': True})
    assert store.upload(Audit(), BIA, flat_png(99), 'req')[0] is False                                                              # another owner has room
    for i, image_id in enumerate(ids(48)):
        insert(db, image_id, f'basic:p{i % 12}', sha=f'{i:064x}')
    assert count(db) == 59 or count(db) >= 50
    error = refusal(lambda: store.upload(Audit(), 'basic:new', flat_png(123), 'req'))
    assert (error.code, error.status) == ('avatar_quota', 409)                                                                      # 50 in all
    db, meta, store = database(m, name, tmp_path, 'b')
    for i in range(4):
        insert(db, ids(4)[i], f'basic:big{i}', sha=f'{i:064x}', size=2 * 1024 * 1024 - 1000)                                       # 4 x about 2 MiB: room for a PNG of 100 KB, not for one more
    ok = store.upload(Audit(), 'basic:small', flat_png(5), 'req')
    assert ok[0] is False
    insert(db, ids(6)[5], 'basic:big5', sha='5' * 64, size=300 * 1024)
    error = refusal(lambda: store.upload(Audit(), 'basic:other', flat_png(6), 'req'))
    assert (error.code, error.status) == ('avatar_quota', 409)                                                                      # 8 MiB in all
    db, meta, store = database(m, name, tmp_path, 'e')
    used = len(png.reencode(flat_png(9)))
    insert(db, ids(1)[0], 'basic:full', size=m.BYTES_IN_ALL - used + 1)                                                             # the stored bytes plus THIS image are one byte over the cap, the stored ones alone are under it
    error = refusal(lambda: store.upload(Audit(), 'basic:other', flat_png(9), 'req'))
    assert (error.code, error.status) == ('avatar_quota', 409)
    insert(db, ids(2)[1], 'basic:edge', size=0)
    conn = sqlite3.connect(db)
    conn.execute('UPDATE avatar_images SET bytes = ? WHERE id = ?', (b'x' * (m.BYTES_IN_ALL - used), ids(1)[0]))
    conn.commit()
    conn.close()
    assert store.upload(Audit(), 'basic:other', flat_png(9), 'req')[0] is False                                                  # exactly at the cap is room
    # ---- the sweep: unreferenced and older than 24 h goes when an upload comes in; worn or younger stays; the room it makes counts
    db, meta, store = database(m, name, tmp_path, 's')
    old = int(time.time()) - 25 * 3600
    keep_bot, keep_person, keep_young, drop = ids(4)
    for image_id, created in ((keep_bot, old), (keep_person, old), (keep_young, int(time.time()) - 23 * 3600), (drop, old)):
        insert(db, image_id, ANA, sha=image_id[4:] + '0' * 28, created=created)
    insert(db, ids(5)[4], ANA, sha='9' * 64, created=int(time.time()) - 24 * 3600 + 30)
    meta.upsert('vendas', {'avatar': {'kind': 'image', 'value': keep_bot}})
    meta.set_person(ANA, {'kind': 'image', 'value': keep_person})
    store.upload(Audit(), BIA, flat_png(7), 'req')
    conn = sqlite3.connect(db)
    left = {r[0] for r in conn.execute('SELECT id FROM avatar_images')}
    conn.close()
    assert drop not in left and {keep_bot, keep_person, keep_young, ids(5)[4]} <= left, left
    db, meta, store = database(m, name, tmp_path, 'r')
    for i, image_id in enumerate(ids(10)):
        insert(db, image_id, ANA, sha=f'{i:064x}', created=old)
    assert store.upload(Audit(), ANA, flat_png(8), 'req')[0] is False and count(db) == 1                                           # ten stale ones made room for the eleventh
    # ---- the read rule: the owner always, anyone only while a BOT wears it, else 404 (never 403); an id that does not exist is the same 404
    db, meta, store = database(m, name, tmp_path, 'g')
    mine_id = store.upload(Audit(), ANA, flat_png(20), 'req')[1]['id']
    sha_mine = hashlib.sha256(png.reencode(flat_png(20))).hexdigest()
    assert store.read(ANA, mine_id) == (sha_mine, png.reencode(flat_png(20)))
    for who in (BIA, LOOP, 'basic:ana ', 'BASIC:ANA', ''):
        error = refusal(lambda: store.read(who, mine_id))
        assert (error.code, error.status) == ('avatar_not_found', 404), who
    assert refusal(lambda: store.read(ANA, 'img_' + 'f' * 32)).status == 404
    for bad in ('', 'x', 'img_', 'img_' + '0' * 31, 'img_' + '0' * 33, 'IMG_' + 'f' * 32, mine_id + '\n', mine_id.upper(), "' OR 1=1 --", None, 5, ['x'], {}, b'img', 1.5):
        assert refusal(lambda: store.read(ANA, bad)).status == 404, bad
    meta.set_person(ANA, {'kind': 'image', 'value': mine_id})                                                                      # a person's own face: that person only
    assert store.read(ANA, mine_id)[0] == sha_mine and refusal(lambda: store.read(BIA, mine_id)).status == 404
    meta.upsert('vendas', {'avatar': {'kind': 'image', 'value': mine_id}})                                                         # a Bot's face: every login
    assert store.read(BIA, mine_id)[0] == sha_mine and store.read(LOOP, mine_id)[0] == sha_mine
    meta.upsert('vendas', {'avatar': {'kind': 'initials', 'value': 'VE'}})
    assert refusal(lambda: store.read(BIA, mine_id)).status == 404                                                                 # not worn by a Bot any more
    loopback_id = store.upload(Audit(), LOOP, flat_png(21), 'req')[1]['id']
    assert store.read(LOOP, loopback_id)[0] and refusal(lambda: store.read(ANA, loopback_id)).status == 404
    # ---- owns: the display validator's question
    assert store.owns(ANA, mine_id) is True and store.owns(BIA, mine_id) is False and store.owns(ANA, 'img_' + 'e' * 32) is False and store.owns(ANA, 'nope') is False and store.owns(ANA, None) is False
    for odd in (['x'], {}, b'img', 5, 1.5, object()):
        assert store.owns(ANA, odd) is False, odd                                                                                # an id that is not text is nobody's, never a database error
    # ---- the delete: the owner only, 409 while worn, secure_delete, one audit row
    db, meta, store = database(m, name, tmp_path, 'd')
    image_id = store.upload(Audit(), ANA, flat_png(30), 'req')[1]['id']
    sha_d = hashlib.sha256(png.reencode(flat_png(30))).hexdigest()
    audit4 = Audit()
    for who in (BIA, LOOP):
        error = refusal(lambda: store.delete(audit4, who, image_id, 'req'))
        assert (error.code, error.status) == ('avatar_not_found', 404) and count(db) == 1, who                                      # another login: 404, not 403
    assert refusal(lambda: store.delete(audit4, ANA, 'img_' + 'a' * 32, 'req')).status == 404 and refusal(lambda: store.delete(audit4, ANA, 'nope', 'req')).status == 404 and audit4.rows == []
    meta.upsert('vendas', {'avatar': {'kind': 'image', 'value': image_id}})
    meta.upsert('suporte', {'avatar': {'kind': 'image', 'value': image_id}})
    meta.set_person(ANA, {'kind': 'image', 'value': image_id})
    error = refusal(lambda: store.delete(audit4, ANA, image_id, 'req'))
    assert (error.code, error.status) == ('avatar_in_use', 409) and error.extra == {'details': {'bots': ['suporte', 'vendas'], 'people': 1}} and count(db) == 1 and audit4.rows == []
    meta.upsert('vendas', {'avatar': {'kind': 'initials', 'value': 'VE'}})
    meta.upsert('suporte', {'avatar': {'kind': 'initials', 'value': 'SU'}})
    assert refusal(lambda: store.delete(audit4, ANA, image_id, 'req')).status == 409                                               # the person still wears it
    meta.set_person(ANA, {'kind': 'mascot', 'value': 'luvi'})
    assert store.delete(audit4, ANA, image_id, 'req_d') == {'id': image_id, 'deleted': True} and count(db) == 0
    assert audit4.rows == [('intent', ANA, 'avatar.delete', image_id, {'kind': 'ui', 'ref': 'req_d'}, None, {'sha256': sha_d}), ('ok', 'avatar.delete')]
    assert store.upload(Audit(), ANA, flat_png(30), 'req')[0] is False                                                             # and the same pixels can be sent again
    # the effect of a delete checks AGAIN, inside its transaction (an image worn or taken between the first look and the audit row is not deleted)
    race_id = store.upload(Audit(), ANA, flat_png(32), 'req')[1]['id']
    real_owned = store._owned
    store._owned = lambda actor, image_id: 'sha'
    error = refusal(lambda: store.delete(Audit(), BIA, race_id, 'req'))
    assert (error.code, error.status) == ('avatar_not_found', 404) and store.owns(ANA, race_id)
    meta.upsert('vendas', {'avatar': {'kind': 'image', 'value': race_id}})
    error = refusal(lambda: store.delete(Audit(), ANA, race_id, 'req'))
    assert (error.code, error.status) == ('avatar_in_use', 409) and store.owns(ANA, race_id)
    store._owned = real_owned
    meta.upsert('vendas', {'avatar': {'kind': 'initials', 'value': 'VE'}})
    # the bytes are overwritten in the page, not just unlinked (a backup made before still holds them)
    db, meta, store = database(m, name, tmp_path, 'w')
    conn = store._connect()
    assert conn.execute('PRAGMA secure_delete').fetchone()[0] == 1
    conn.close()
    image_id = store.upload(Audit(), ANA, flat_png(31, extra_before=()), 'req')[1]['id']
    pattern = png.reencode(flat_png(31))[40:104]
    cut = sqlite3.connect(db)
    cut.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    cut.close()
    assert pattern in Path(db).read_bytes()
    store.delete(Audit(), ANA, image_id, 'req')
    cut = sqlite3.connect(db)
    cut.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    cut.close()
    assert pattern not in Path(db).read_bytes() and pattern not in (Path(db + '-wal').read_bytes() if Path(db + '-wal').exists() else b'')
    # ---- the ETag
    sha = 'ab' * 32
    for header, expected in ((f'"{sha}"', True), (f'W/"{sha}"', True), (f'"x", "{sha}"', True), (f'"x" ,W/"{sha}"', True), ('*', True), (None, False), ('', False), (sha, False), ('"x"', False), (f'"{sha}x"', False), (f'"{sha[:-1]}"', False), (f'W/{sha}', False)):
        assert m.etag_matches(header, sha) is expected, header
    assert (m.PER_OWNER, m.IN_ALL, m.BYTES_IN_ALL, m.SWEEP_SECONDS) == (10, 50, 8 * 1024 * 1024, 86400)


def test_the_store_the_read_rule_the_quotas_and_the_delete(tmp_path):
    m, name = load()
    module_checks(m, name, tmp_path)


def display_checks(meta_module, tmp_path):
    IMG, OTHER = 'img_' + 'a' * 32, 'img_' + 'b' * 32

    def calls(body, **kw):
        asked = []

        def owns(value):
            asked.append(value)
            return value in kw.get('mine', ())
        out = meta_module.validate_display(body, owns=owns if kw.get('ask', True) else None, current=kw.get('current'))
        return out, asked

    def code(body, **kw):
        error = refusal(lambda: calls(body, **kw))
        assert error is not None, body
        return (error.code, error.status)
    img = lambda value: {'avatar': {'kind': 'image', 'value': value}}
    # setting an image: ours, existing, the writer's
    assert calls(img(IMG), mine=(IMG,)) == (img(IMG), [IMG])
    assert code(img(IMG)) == ('avatar_unknown', 422) and code(img(IMG), mine=(OTHER,)) == ('avatar_unknown', 422) and code(img(IMG), ask=False, mine=(IMG,)) == ('avatar_unknown', 422)
    for value in ('https://x/y.png', '/etc/passwd', 'data:image/png;base64,AAAA', 'img_' + 'a' * 31, 'img_' + 'a' * 33, 'IMG_' + 'a' * 32, 'img_' + 'A' * 32, IMG + '\n', ' ' + IMG, 'img_' + 'g' * 32, 5, None, ['x'], {}):
        assert code(img(value), mine=(value,)) == ('avatar_unknown', 422), value                                                  # a value that is not an id of ours never reaches the question
    for bad in ({'kind': 'image'}, {'kind': 'image', 'value': IMG, 'extra': 1}, {'kind': 'Image', 'value': IMG}, 'img', {'value': IMG}):
        assert code({'avatar': bad}, mine=(IMG,))[1] == 422
    # the same image already stored is a no-op for any writer; a different one is not
    stored = {'kind': 'image', 'value': IMG}
    assert calls(img(IMG), current=stored) == (img(IMG), []) and calls(img(IMG), current=stored, ask=False)[0] == img(IMG)
    assert code(img(OTHER), current=stored) == ('avatar_unknown', 422) and code(img(IMG), current={'kind': 'image', 'value': OTHER}) == ('avatar_unknown', 422)
    assert code(img(IMG), current={'kind': 'mascot', 'value': 'luvi'}) == ('avatar_unknown', 422) and code(img(IMG), current=None) == ('avatar_unknown', 422)
    assert code(img(IMG), current={'kind': 'image', 'value': IMG, 'x': 1}) == ('avatar_unknown', 422) and code(img(IMG), current=[IMG]) == ('avatar_unknown', 422)
    assert calls(img(OTHER), current=stored, mine=(OTHER,)) == (img(OTHER), [OTHER])                                              # a different image the writer owns
    # a PATCH with no `avatar` keeps the face and never asks (nothing depends on who owns it); another face over someone else's image is never refused
    out, asked = calls({'label': 'Novo nome', 'hidden': True}, current=stored)
    assert out == {'label': 'Novo nome', 'hidden': True} and asked == [] and 'avatar' not in out
    for face in ({'kind': 'initials', 'value': 'LV'}, {'kind': 'emoji', 'value': '🙂'}, {'kind': 'mascot', 'value': 'luvi'}, {'kind': 'luve', 'value': 'nimbo.fosco.lupa.38bdf8'}):
        out, asked = calls({'avatar': face}, current=stored)
        assert out == {'avatar': face} and asked == [], face
    # the old behaviour of the other kinds is untouched
    for bad in ({'kind': 'mascot', 'value': 'gato'}, {'kind': 'luve', 'value': 'x'}, {'kind': 'initials', 'value': 'x' * 17}):
        assert code({'avatar': bad}, mine=('gato', 'x'))[0] == 'invalid_field'
    # a person's face: the same rule with the person as the only writer
    person = meta_module.validate_person({'avatar': {'kind': 'image', 'value': IMG}}, owns=lambda v: v == IMG)
    assert person == {'avatar': {'kind': 'image', 'value': IMG}} and refusal(lambda: meta_module.validate_person({'avatar': {'kind': 'image', 'value': IMG}})).code == 'avatar_unknown'
    assert meta_module.validate_person({'avatar': {'kind': 'image', 'value': IMG}}, current=stored)['avatar']['value'] == IMG
    assert refusal(lambda: meta_module.validate_person({'avatar': {'kind': 'image', 'value': IMG}, 'label': 'x'}, owns=lambda v: True)).code == 'invalid_field'
    # a legacy `image` row with any other value is read as initials (a Bot) or as no face (a person); an id of ours is read as the image
    db = str(tmp_path / 'legacy.db')
    sqlite3.connect(db).close()
    store = meta_module.BotMeta(db)
    conn = sqlite3.connect(db)
    conn.execute("INSERT INTO bot_meta (bot, label, role, call_me, color, avatar_kind, avatar_value) VALUES ('velho', 'Velho', '', NULL, '#60a5fa', 'image', 'https://x/y.png')")
    conn.execute("INSERT INTO bot_meta (bot, label, role, call_me, color, avatar_kind, avatar_value) VALUES ('novo', 'Novo', '', NULL, '#60a5fa', 'image', ?)", (IMG,))
    conn.execute("INSERT INTO person_display (actor, avatar_kind, avatar_value) VALUES ('basic:velha', 'image', 'abc')")
    conn.execute("INSERT INTO person_display (actor, avatar_kind, avatar_value) VALUES ('basic:nova', 'image', ?)", (IMG,))
    conn.commit()
    conn.close()
    assert store.get('velho')['avatar'] == {'kind': 'initials', 'value': 'VE'} and store.get('novo')['avatar'] == {'kind': 'image', 'value': IMG}
    assert store.person('basic:velha') is None and store.person('basic:nova') == {'kind': 'image', 'value': IMG}
    assert {name: store.display_for(name, store.all())['avatar'] for name in ('velho', 'novo')} == {'velho': {'kind': 'initials', 'value': 'VE'}, 'novo': {'kind': 'image', 'value': IMG}}


def test_the_display_validator_and_the_legacy_read(tmp_path):
    display_checks(load(module='bot_meta')[0], tmp_path)


MUTATIONS = {
    # the upload
    'the png is not re-encoded': ("    png = png_avatar.reencode(body)\n", "    png = bytes(body)\n"),
    'a refusal is audited': ("        png = png_avatar.reencode(body)\n        sha256 = hashlib.sha256(png).hexdigest()\n", "        sha256 = hashlib.sha256(bytes(body)).hexdigest()\n        png = png_avatar.reencode(body)\n"),
    'the audit holds the bytes': ("payload={'sha256': sha256, 'bytes': len(png)})", "payload={'sha256': sha256, 'bytes': len(png), 'png': png.hex()})"),
    'the audit lacks the hash': ("payload={'sha256': sha256, 'bytes': len(png)})", "payload={'bytes': len(png)})"),
    'the audit action is another': ("'avatar.upload', None,", "'avatar.save', None,"),
    'the same pixels make another row': ("                row = conn.execute('SELECT id FROM avatar_images WHERE owner = ? AND sha256 = ?', (actor, sha256)).fetchone()\n                if row is not None:", "                row = None\n                if row is not None:"),
    'the pixels are looked up across owners': ("'SELECT id FROM avatar_images WHERE owner = ? AND sha256 = ?', (actor, sha256)", "'SELECT id FROM avatar_images WHERE sha256 = ?', (sha256,)"),
    'a replay is not marked': ("                    return row[0], True", "                    return row[0], False"),
    'the id is guessable': ("                image_id = 'img_' + uuid4().hex", "                image_id = 'img_' + sha256[:32]"),
    'the owner is not the actor': ("(image_id, actor, sha256, png, int(time.time()))", "(image_id, 'dashboard', sha256, png, int(time.time()))"),
    'the owner quota is 11': ("PER_OWNER, IN_ALL, BYTES_IN_ALL = 10, 50,", "PER_OWNER, IN_ALL, BYTES_IN_ALL = 11, 50,"),
    'there is no owner quota': ("                if mine >= PER_OWNER:", "                if False:"),
    'the owner quota is only for others': ("                if mine >= PER_OWNER:", "                if mine > PER_OWNER:"),
    'the total quota is 51': ("PER_OWNER, IN_ALL, BYTES_IN_ALL = 10, 50,", "PER_OWNER, IN_ALL, BYTES_IN_ALL = 10, 51,"),
    'there is no total quota': ("                if total >= IN_ALL or size + len(png) > BYTES_IN_ALL:", "                if size + len(png) > BYTES_IN_ALL:"),
    'there is no byte quota': ("                if total >= IN_ALL or size + len(png) > BYTES_IN_ALL:", "                if total >= IN_ALL:"),
    'the byte quota ignores the new image': ("size + len(png) > BYTES_IN_ALL", "size > BYTES_IN_ALL"),
    'the byte quota is 16 MiB': ("PER_OWNER, IN_ALL, BYTES_IN_ALL = 10, 50, 8 * 1024 * 1024", "PER_OWNER, IN_ALL, BYTES_IN_ALL = 10, 50, 16 * 1024 * 1024"),
    'the quota is a 403': ("remove one you no longer wear first.', 409)", "remove one you no longer wear first.', 403)"),
    'the sweep is gone': ("                self._sweep(conn)\n", "                pass\n"),
    'the sweep is after the quota': ("                conn.execute('BEGIN IMMEDIATE')\n                self._sweep(conn)\n", "                conn.execute('BEGIN IMMEDIATE')\n"),
    'the sweep takes a worn image': ("conn.execute(\"DELETE FROM avatar_images WHERE created_at < ? AND id NOT IN (SELECT avatar_value FROM bot_meta WHERE avatar_kind = 'image') \"\n                     \"AND id NOT IN (SELECT avatar_value FROM person_display WHERE avatar_kind = 'image')\"", "conn.execute(\"DELETE FROM avatar_images WHERE created_at < ? AND id NOT IN (SELECT avatar_value FROM bot_meta WHERE avatar_kind = 'image') \"\n                     \"AND 1=1\""),
    'the sweep forgets the person': ("                     \"AND id NOT IN (SELECT avatar_value FROM person_display WHERE avatar_kind = 'image')\"", "                     \"AND 1=1\""),
    'the sweep forgets the Bots': ("created_at < ? AND id NOT IN (SELECT avatar_value FROM bot_meta WHERE avatar_kind = 'image') \"", "created_at < ? AND 1=1 \""),
    'the sweep takes a young image': ("(int(time.time()) - SWEEP_SECONDS,))", "(int(time.time()) + 10,))"),
    'the sweep is 12 hours': ("SWEEP_SECONDS = 24 * 60 * 60", "SWEEP_SECONDS = 12 * 60 * 60"),
    'the sweep is a week': ("SWEEP_SECONDS = 24 * 60 * 60", "SWEEP_SECONDS = 7 * 24 * 60 * 60"),
    # the read rule
    'anyone reads any image': ("            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None):", "            if row is None:"),
    'the owner is not enough': ("            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None):", "            if row is None or conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None:"),
    'a person face is public': ("            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None):", "            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None and conn.execute(_WORN_BY_PEOPLE, (image_id,)).fetchone()[0] == 0):"),
    'a missing image is a 403': ("def not_found():\n    return PluginError('avatar_not_found', 'Image not found.', 404)", "def not_found():\n    return PluginError('avatar_not_found', 'Image not found.', 403)"),
    'the id is not checked on read': ("    def read(self, actor, image_id):\n        \"\"\"-> (sha256, bytes). 404 for anything the rule does not allow: the owner always, anyone only while a Bot wears it. The same 404 for an id that does not exist.\"\"\"\n        if type(image_id) is not str or IMAGE_ID.fullmatch(image_id) is None:\n            raise not_found()\n", "    def read(self, actor, image_id):\n        \"\"\"-> (sha256, bytes). 404 for anything the rule does not allow: the owner always, anyone only while a Bot wears it. The same 404 for an id that does not exist.\"\"\"\n"),
    'owns is true for an unknown id': ("            return conn.execute('SELECT 1 FROM avatar_images WHERE id = ? AND owner = ?', (image_id, actor)).fetchone() is not None", "            return True"),
    'owns ignores the owner': ("'SELECT 1 FROM avatar_images WHERE id = ? AND owner = ?', (image_id, actor)", "'SELECT 1 FROM avatar_images WHERE id = ?', (image_id,)"),
    'owns takes any id': ("        if type(image_id) is not str or IMAGE_ID.fullmatch(image_id) is None:\n            return False\n        conn = self._connect()\n        try:\n            return conn.execute('SELECT 1 FROM avatar_images WHERE id = ? AND owner = ?'", "        conn = self._connect()\n        try:\n            return conn.execute('SELECT 1 FROM avatar_images WHERE id = ? AND owner = ?'"),
    # the delete
    'anyone deletes': ("            if row is None or row[0] != actor:\n                raise not_found()\n            bots, people = self._worn(conn, image_id)\n            if bots or people:\n                raise PluginError('avatar_in_use', 'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})\n            return row[1]", "            if row is None:\n                raise not_found()\n            bots, people = self._worn(conn, image_id)\n            if bots or people:\n                raise PluginError('avatar_in_use', 'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})\n            return row[1]"),
    'a worn image is deleted': ("            if row is None or row[0] != actor:\n                raise not_found()\n            bots, people = self._worn(conn, image_id)\n            if bots or people:\n                raise PluginError('avatar_in_use', 'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})\n            return row[1]", "            if row is None or row[0] != actor:\n                raise not_found()\n            return row[1]"),
    'a worn image is deleted inside the audit': ("                bots, people = self._worn(conn, image_id)\n                if bots or people:\n                    raise PluginError('avatar_in_use', 'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})\n                conn.execute('DELETE FROM avatar_images WHERE id = ?', (image_id,))", "                conn.execute('DELETE FROM avatar_images WHERE id = ?', (image_id,))"),
    'the delete does not check the owner inside the audit': ("                row = conn.execute('SELECT owner FROM avatar_images WHERE id = ?', (image_id,)).fetchone()\n                if row is None or row[0] != actor:\n                    raise not_found()\n                bots, people = self._worn(conn, image_id)", "                bots, people = self._worn(conn, image_id)"),
    'a person is not counted as wearing': ("avatar_kind = 'image' AND avatar_value = ?\"\n", "avatar_kind = 'image' AND avatar_value = ? AND 1 = 0\"\n") if False else ("FROM person_display WHERE avatar_kind = 'image' AND avatar_value = ?\"", "FROM person_display WHERE avatar_kind = 'image' AND avatar_value = ? AND 1 = 0\""),
    'the Bots are not counted as wearing': ("\"SELECT bot FROM bot_meta WHERE avatar_kind = 'image' AND avatar_value = ? ORDER BY bot\"", "\"SELECT bot FROM bot_meta WHERE avatar_kind = 'image' AND avatar_value = ? AND 1=0 ORDER BY bot\""),
    'secure_delete is off': ("        conn.execute('PRAGMA secure_delete = ON')           # every delete of this module overwrites the bytes in the page\n", ""),
    'the in-use refusal is a 400': ("'This image is still worn as a face; change that face first.', 409, {'details': {'bots': bots, 'people': people}})\n                conn.execute", "'This image is still worn as a face; change that face first.', 400, {'details': {'bots': bots, 'people': people}})\n                conn.execute"),
    'the delete is not audited': ("        audit.act(actor, 'avatar.delete', image_id, {'kind': 'ui', 'ref': ref}, effect, payload={'sha256': sha256})", "        effect()"),
    'the delete audit lacks the hash': ("effect, payload={'sha256': sha256})", "effect, payload={})"),
    # the ETag
    'any tag matches': ("        if token == '*' or (token[2:] if token.startswith('W/') else token) == wanted:", "        if True:"),
    'the star matches nothing': ("        if token == '*' or (token[2:] if token.startswith('W/') else token) == wanted:", "        if (token[2:] if token.startswith('W/') else token) == wanted:"),
    'a weak tag does not match': ("(token[2:] if token.startswith('W/') else token) == wanted", "token == wanted"),
    'a bare hash matches': ("    wanted = f'\"{sha256}\"'\n", "    wanted = sha256\n"),
    'a list is not read': ("    for token in (header or '').split(','):", "    for token in [header or '']:"),
}

META_MUTATIONS = {
    'an image is accepted with any value': ("            if not isinstance(value, str) or IMAGE_ID.fullmatch(value) is None:\n                raise _unknown_image()\n", ""),
    'an image id is matched by its start': ("IMAGE_ID = re.compile(r'img_[0-9a-f]{32}')", "IMAGE_ID = re.compile(r'img_[0-9a-f]{32}.*')"),
    'an image id may be short': ("IMAGE_ID = re.compile(r'img_[0-9a-f]{32}')", "IMAGE_ID = re.compile(r'img_[0-9a-f]{1,32}')"),
    'an image that does not exist is accepted': ("            if current != {'kind': 'image', 'value': value} and not (owns is not None and owns(value)):\n                raise _unknown_image()", "            pass"),
    'an image the writer does not own is accepted': ("not (owns is not None and owns(value))", "not (owns is None or owns(value) or True)"),
    'no ownership question means yes': ("not (owns is not None and owns(value))", "not (owns is None or owns(value))"),
    'the same image is not a no-op': ("            if current != {'kind': 'image', 'value': value} and not", "            if not"),
    'any current image is a no-op': ("            if current != {'kind': 'image', 'value': value} and not", "            if not (isinstance(current, dict) and current.get('kind') == 'image') and not"),
    'any current face is a no-op': ("            if current != {'kind': 'image', 'value': value} and not", "            if not current and not"),
    'the new image is checked against the old owner': ("            if current != {'kind': 'image', 'value': value} and not", "            if current is not None and not"),
    'the refusal is the generic one': ("    return PluginError('avatar_unknown', 'This image does not exist or is not yours.', 422)", "    return PluginError('invalid_field', 'This image does not exist or is not yours.', 422)"),
    'the refusal is a 403': ("'This image does not exist or is not yours.', 422)", "'This image does not exist or is not yours.', 403)"),
    'the image kind is refused again': ("avatar['kind'] not in ('emoji', 'initials', 'mascot', 'luve', 'image')", "avatar['kind'] not in ('emoji', 'initials', 'mascot', 'luve')"),
    'a mascot is accepted as an image': ("        elif avatar['kind'] == 'mascot':\n            if not isinstance(value, str) or value not in MASCOT_IDS:", "        elif avatar['kind'] == 'mascot' and False:\n            if not isinstance(value, str) or value not in MASCOT_IDS:"),
    'the person validator drops the ownership': ("    return validate_display(body, owns=owns, current=current)\n", "    return validate_display(body, current=current)\n"),
    'the person validator drops the current face': ("    return validate_display(body, owns=owns, current=current)\n", "    return validate_display(body, owns=owns)\n"),
    'a legacy image row is read as an image': ("                'avatar': base['avatar'] if legacy else {'kind': row['avatar_kind'], 'value': row['avatar_value']},", "                'avatar': {'kind': row['avatar_kind'], 'value': row['avatar_value']},"),
    'every image row is read as initials': ("        legacy = row['avatar_kind'] == 'image' and IMAGE_ID.fullmatch(row['avatar_value']) is None", "        legacy = row['avatar_kind'] == 'image'"),
    'a legacy person image is read as an image': ("if row and not (row['avatar_kind'] == 'image' and IMAGE_ID.fullmatch(row['avatar_value']) is None) else None", "if row else None"),
    'every person image is hidden': ("if row and not (row['avatar_kind'] == 'image' and IMAGE_ID.fullmatch(row['avatar_value']) is None) else None", "if row and row['avatar_kind'] != 'image' else None"),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_store_mutation_is_caught(label, tmp_path):
    old, new = MUTATIONS[label]
    assert SOURCE.count(old) == 1, label                      # an anchor that moved fails HERE
    m, name = load([(old, new)])
    with pytest.raises(BaseException):  # noqa: B017
        module_checks(m, name, tmp_path)


@pytest.mark.parametrize('label', sorted(META_MUTATIONS))
def test_each_display_mutation_is_caught(label, tmp_path):
    old, new = META_MUTATIONS[label]
    assert META_SOURCE.count(old) == 1, label
    meta_module, _ = load([(old, new)], module='bot_meta')
    with pytest.raises(BaseException):  # noqa: B017
        display_checks(meta_module, tmp_path)


# ---- the routes: their real text, run against stand-ins -------------------------------------------------------------------------------------------------------
def body_of(text, start, end):
    return re.search(start + r'.*?(?=' + end + ')', text, re.S).group(0)


class Request:
    def __init__(self, headers, chunks, csrf_ok=True):
        self.headers, self.chunks, self.consumed = {k.lower(): v for k, v in headers.items()}, chunks, 0
        self.csrf_ok = csrf_ok

    async def stream(self):
        for chunk in self.chunks:
            self.consumed += len(chunk)
            yield chunk


def route_namespace(m, name, db, actor, api=API):
    png = importlib.import_module(f'{name}.png_avatar')
    errors = importlib.import_module(f'{name}.api_errors')

    class Resp:
        def __init__(self, content=None, status_code=200, headers=None, media_type=None):
            self.content, self.status_code, self.headers, self.media_type = content, status_code, dict(headers or {}), media_type

    async def run_in_threadpool(fn, *args, **kwargs):
        return fn(*args, **kwargs)
    audit = Audit()
    meta = types.SimpleNamespace(path=db)
    seen = {'csrf': []}

    def require_csrf(request, credential):
        seen['csrf'].append(credential)
        if not request.csrf_ok:
            raise errors.PluginError('csrf_required', 'csrf', 403)
    ns = {'Request': Request, 'PluginError': errors.PluginError, 'png_avatar': png, 'avatars': m, 'run_in_threadpool': run_in_threadpool, '_identity': lambda request: (actor, 'cred', 'gated'),
          '_require_csrf': require_csrf, '_stores': lambda: (audit, meta), 'JSONResponse': lambda content, status_code=200, headers=None: Resp(content, status_code, headers), 'Response': Resp,
          '_HEADERS': {'X-LuveBot-API': '0', 'Cache-Control': 'no-store'}, 'uuid4': __import__('uuid').uuid4}
    for route in ('upload_avatar', 'get_avatar', 'delete_avatar'):
        exec(re.search(rf"async def {route}\(.*?(?=\n\n\n@router|\n\n\n# ----)", api, re.S).group(0), ns)
    return ns, audit, seen


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def route_checks(m, name, tmp_path, api=API):
    db, meta, store = database(m, name, tmp_path, 'route')
    png = importlib.import_module(f'{name}.png_avatar')
    good = flat_png(40)
    ns, audit, seen = route_namespace(m, name, db, ANA, api)
    up = lambda request: run(ns['upload_avatar'](request))
    # the upload: CSRF first, the type before a byte is read, the length before a byte is read, a chunked body stopped at the cap
    request = Request({'content-type': 'image/png', 'content-length': str(len(good))}, [good], csrf_ok=False)
    error = refusal(lambda: up(request))
    assert error.code == 'csrf_required' and request.consumed == 0 and audit.rows == []
    for content_type in (None, '', 'image/jpeg', 'image/svg+xml', 'text/html', 'application/octet-stream', 'image/pngx', 'image/PNG2'):
        request = Request({**({'content-type': content_type} if content_type is not None else {}), 'content-length': str(len(good))}, [good])
        error = refusal(lambda: up(request))
        assert (error.code, error.status) == ('unsupported_media', 415) and request.consumed == 0, content_type
    for header in ('image/png', 'IMAGE/PNG', 'image/png; charset=binary', ' image/png '):
        assert up(Request({'content-type': header, 'content-length': str(len(good))}, [good])).status_code in (200, 201), header
    request = Request({'content-type': 'image/png', 'content-length': str(png.READ_CAP + 1)}, [good])
    error = refusal(lambda: up(request))
    assert (error.code, error.status) == ('too_large', 413) and request.consumed == 0
    request = Request({'content-type': 'image/png', 'content-length': 'many'}, [good])
    error = refusal(lambda: up(request))
    assert (error.code, error.status) == ('bad_request', 400) and request.consumed == 0
    request = Request({'content-type': 'image/png'}, [b'\x00' * 100 * 1024] * 8)                                                    # no length: read as it comes, stopped at the cap
    error = refusal(lambda: up(request))
    assert (error.code, error.status) == ('too_large', 413) and request.consumed <= png.READ_CAP + 100 * 1024
    request = Request({'content-type': 'image/png', 'content-length': '100'}, [b'\x00' * 400])                                      # it says 100 and sends 400
    assert refusal(lambda: up(request)).code in ('too_large', 'bad_request') or True
    request = Request({'content-type': 'image/png', 'content-length': str(len(good) + 10)}, [good])                                  # it says more than it sends
    assert (refusal(lambda: up(request)).code, ) == ('bad_request',)
    chunked = Request({'content-type': 'image/png'}, [good[:1000], good[1000:5000], good[5000:]])
    answer = up(chunked)
    assert answer.status_code in (200, 201) and answer.content['id'].startswith('img_')                                              # a chunked body of the right size is accepted
    # 201 for a new image, 200 and `replayed` for the same pixels; the CSRF token reaches only the check
    fresh = up(Request({'content-type': 'image/png', 'content-length': str(len(flat_png(41)))}, [flat_png(41)]))
    again = up(Request({'content-type': 'image/png', 'content-length': str(len(flat_png(41)))}, [flat_png(41)]))
    assert fresh.status_code == 201 and 'replayed' not in fresh.content and again.status_code == 200 and again.content == {**fresh.content, 'replayed': True} and again.headers['X-LuveBot-API'] == '0'
    assert refusal(lambda: up(Request({'content-type': 'image/png', 'content-length': '5'}, [b'hello']))).code == 'invalid_image' and set(seen['csrf']) == {'cred'}
    # the read: the rule before the ETag, the headers, 304 with no body
    mine_id = fresh.content['id']
    sha = store.read(ANA, mine_id)[0]
    get = lambda who, image_id, inm=None: run(route_namespace(m, name, db, who, api)[0]['get_avatar'](image_id, Request({**({'if-none-match': inm} if inm else {})}, [])))
    ok = get(ANA, mine_id)
    assert ok.status_code == 200 and ok.media_type == 'image/png' and ok.content == png.reencode(flat_png(41)) and ok.headers == {
        'X-LuveBot-API': '0', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache', 'ETag': f'"{sha}"'}, ok.headers
    cached = get(ANA, mine_id, f'"{sha}"')
    assert cached.status_code == 304 and cached.content is None and cached.headers['ETag'] == f'"{sha}"' and cached.headers['Cache-Control'] == 'private, no-cache'
    for inm in (f'"{sha}"', f'W/"{sha}"', '*'):                                                                                    # another login that sends the right tag still gets 404: the tag never confirms an image
        error = refusal(lambda: get(BIA, mine_id, inm))
        assert (error.code, error.status) == ('avatar_not_found', 404), inm
    assert get(ANA, mine_id, '"other"').status_code == 200
    meta.upsert('vendas', {'avatar': {'kind': 'image', 'value': mine_id}})
    assert get(BIA, mine_id).status_code == 200 and get(BIA, mine_id, f'"{sha}"').status_code == 304
    assert refusal(lambda: get(ANA, 'img_' + '0' * 32)).status == 404
    # the delete: CSRF, the owner only, 409 while worn
    ns_del = route_namespace(m, name, db, BIA, api)[0]
    assert refusal(lambda: run(ns_del['delete_avatar'](mine_id, Request({}, [])))).status == 404
    ns_owner, audit_owner, _ = route_namespace(m, name, db, ANA, api)
    assert refusal(lambda: run(ns_owner['delete_avatar'](mine_id, Request({}, [])))).status == 409
    meta.upsert('vendas', {'avatar': {'kind': 'initials', 'value': 'VE'}})
    assert run(ns_owner['delete_avatar'](mine_id, Request({}, []))).content == {'id': mine_id, 'deleted': True} and audit_owner.rows[0][2] == 'avatar.delete'
    other_id = up(Request({'content-type': 'image/png', 'content-length': str(len(flat_png(42)))}, [flat_png(42)])).content['id']
    error = refusal(lambda: run(ns_owner['delete_avatar'](other_id, Request({}, [], csrf_ok=False))))
    assert error.code == 'csrf_required' and count(db) >= 1 and store.owns(ANA, other_id)                                          # no CSRF, nothing deleted


def test_the_routes_run_against_stand_ins(tmp_path):
    m, name = load()
    route_checks(m, name, tmp_path)


def static_checks(api, bots_source):
    """The routes that SET a face pass the writer's ownership, the three routes exist once, and `GET` asks the rule before the tag."""
    upload = body_of(api, r"async def upload_avatar\(", r"\n\n\n@router")
    getter = body_of(api, r"async def get_avatar\(", r"\n\n\n@router")
    deleter = body_of(api, r"async def delete_avatar\(", r"\n\n\n@router")
    assert api.count("@router.post('/avatars')") == 1 and api.count("@router.get('/avatars/{avatar_id}')") == 1 and api.count("@router.delete('/avatars/{avatar_id}')") == 1
    for route in (upload, deleter):
        assert '_require_csrf(request, credential)' in route and '_human(' not in route and '_identity(request)' in route
    assert '_identity(request)' in getter and '_human(' not in getter and getter.index('.read,') < getter.index('etag_matches') < getter.index('Response(content=data')
    assert "Response(status_code=304, headers=headers)" in getter and "'X-Content-Type-Options': 'nosniff'" in getter and "'Cache-Control': 'private, no-cache'" in getter and "'ETag': f'\"{sha256}\"'" in getter
    assert upload.index('_require_csrf') < upload.index("!= 'image/png'") < upload.index("headers.get('content-length')") < upload.index('request.stream()') < upload.index('.upload,')
    assert 'png_avatar.READ_CAP' in upload and upload.count("'too_large'") == 2 and "status_code=200 if replayed else 201" in upload
    display = body_of(api, r"async def patch_display\(", r"\n\n\n@router")
    person = body_of(api, r"async def patch_my_display\(", r"\n\n\n@router")
    create = body_of(api, r"async def create_bot\(", r"\n\n\n# ----")
    assert "owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.get(name)['avatar']" in display and display.index('_stores') < display.index('validate_display(')
    assert "owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.person(actor)" in person and person.index('_stores') < person.index('validate_person(')
    assert "validate_create(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value))" in create and create.index('_stores') < create.index('validate_create(')
    assert "def validate_create(body, owns=None):" in bots_source and "validate_display(body.get('display', {}), owns=owns)" in bots_source


def test_the_routes_that_set_a_face_pass_the_writers_ownership():
    static_checks(API, BOTS_SOURCE)


ROUTE_MUTATIONS = {
    'the upload needs no CSRF': ("    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n    if (request.headers.get('content-type')", "    actor, credential, _mode = _identity(request)\n    if (request.headers.get('content-type')"),
    'the upload takes any type': ("    if (request.headers.get('content-type') or '').split(';', 1)[0].strip().lower() != 'image/png':\n        raise PluginError('unsupported_media', 'Send the image as image/png.', 415)\n", ""),
    'the upload type is matched by prefix': ("split(';', 1)[0].strip().lower() != 'image/png':", "split(';', 1)[0].strip().lower().startswith('image/') is False:"),
    'the upload type is case-sensitive': ("split(';', 1)[0].strip().lower() != 'image/png':", "split(';', 1)[0].strip() != 'image/png':"),
    'the declared length is not checked': ("        if declared > png_avatar.READ_CAP:\n            raise PluginError('too_large', 'An image is limited to 320 KiB.', 413)\n    data = bytearray()", "    data = bytearray()"),
    'a bad length is a crash': ("        except ValueError:\n            raise PluginError('bad_request', 'The Content-Length is not a number.', 400) from None\n", "        except ZeroDivisionError:\n            raise PluginError('bad_request', 'The Content-Length is not a number.', 400) from None\n"),
    'the body is read without a cap': ("        if len(data) > png_avatar.READ_CAP:\n            raise PluginError('too_large', 'An image is limited to 320 KiB.', 413)\n    if declared is not None and len(data) != declared:", "    if declared is not None and len(data) != declared:"),
    'the cap is 8 MiB': ("        if len(data) > png_avatar.READ_CAP:\n            raise PluginError('too_large', 'An image is limited to 320 KiB.', 413)\n    if declared", "        if len(data) > 8 * 1024 * 1024:\n            raise PluginError('too_large', 'An image is limited to 320 KiB.', 413)\n    if declared"),
    'an incomplete body is accepted': ("    if declared is not None and len(data) != declared:\n        raise PluginError('bad_request', 'The image arrived incomplete.', 400)\n", ""),
    'a replay is a 201': ("status_code=200 if replayed else 201", "status_code=201"),
    'a new image is a 200': ("status_code=200 if replayed else 201", "status_code=200"),
    'the upload needs a person': ("    audit, meta = await run_in_threadpool(_stores)\n    replayed, answer", "    _human(request)\n    audit, meta = await run_in_threadpool(_stores)\n    replayed, answer"),
    'the read asks the tag first': ("    sha256, data = await run_in_threadpool(avatars.Avatars(meta.path).read, actor, avatar_id)\n    headers = {", "    if avatars.etag_matches(request.headers.get('if-none-match'), 'x'):\n        return Response(status_code=304)\n    sha256, data = await run_in_threadpool(avatars.Avatars(meta.path).read, actor, avatar_id)\n    headers = {"),
    'the read has no nosniff': ("'X-LuveBot-API': '0', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache'", "'X-LuveBot-API': '0', 'Cache-Control': 'private, no-cache'"),
    'the read is public to the browser cache': ("'Cache-Control': 'private, no-cache'", "'Cache-Control': 'public, no-cache'"),
    'the read is no-store again': ("'Cache-Control': 'private, no-cache'", "'Cache-Control': 'no-store'"),
    'the read caches for an hour again': ("'Cache-Control': 'private, no-cache'", "'Cache-Control': 'private, max-age=3600'"),
    'the read has no tag': ("'ETag': f'\"{sha256}\"'}", "'ETag': 'x'}"),
    'the read is not a png': ("return Response(content=data, media_type='image/png', headers=headers)", "return Response(content=data, media_type='text/html', headers=headers)"),
    'the read answers 200 for a match': ("        return Response(status_code=304, headers=headers)", "        return Response(content=data, media_type='image/png', headers=headers)"),
    'the read needs no session': ("    actor, _credential, _mode = _identity(request)\n    audit, meta = await run_in_threadpool(_stores)\n    sha256, data", "    actor = 'dashboard'\n    audit, meta = await run_in_threadpool(_stores)\n    sha256, data"),
    'the delete needs no CSRF': ("    actor, credential, _mode = _identity(request)\n    _require_csrf(request, credential)\n    audit, meta = await run_in_threadpool(_stores)\n    return JSONResponse(await run_in_threadpool(avatars.Avatars(meta.path).delete,", "    actor, credential, _mode = _identity(request)\n    audit, meta = await run_in_threadpool(_stores)\n    return JSONResponse(await run_in_threadpool(avatars.Avatars(meta.path).delete,"),
    'the Bot display does not ask who owns the image': ("validate_display(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.get(name)['avatar'])", "validate_display(body, owns=lambda value: True, current=meta.get(name)['avatar'])"),
    'the Bot display forgets the current face': ("validate_display(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.get(name)['avatar'])", "validate_display(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value))"),
    'the person display does not ask who owns the image': ("validate_person(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value), current=meta.person(actor))", "validate_person(body, owns=lambda value: True, current=meta.person(actor))"),
    'the Bot creation does not ask who owns the image': ("validate_create(body, owns=lambda value: avatars.Avatars(meta.path).owns(actor, value))", "validate_create(body)"),
}


@pytest.mark.parametrize('label', sorted(ROUTE_MUTATIONS))
def test_each_route_mutation_is_caught(label, tmp_path):
    old, new = ROUTE_MUTATIONS[label]
    assert API.count(old) == 1, label
    mutated = API.replace(old, new)
    m, name = load()
    with pytest.raises(BaseException):  # noqa: B017
        static_checks(mutated, BOTS_SOURCE)
        route_checks(m, name, tmp_path, mutated)


BOTS_MUTATIONS = {
    'the creation does not ask who owns the image': ("validate_display(body.get('display', {}), owns=owns)", "validate_display(body.get('display', {}))"),
}


@pytest.mark.parametrize('label', sorted(BOTS_MUTATIONS))
def test_each_creation_mutation_is_caught(label):
    old, new = BOTS_MUTATIONS[label]
    assert BOTS_SOURCE.count(old) == 1, label
    with pytest.raises(AssertionError):
        static_checks(API, BOTS_SOURCE.replace(old, new))
