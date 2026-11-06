"""Red team (Lume, 31/10) of AV-3 (0c3325a, `backend/avatars.py` and the display validator) against contract v0.11 section 2.2, on what the Brasa's battery (test_avatars.py: the edges of the quotas and of the 24 h,
the read matrix, the display rules, 72 mutations) does not do: it never runs two requests AT ONCE, and it compares the 404s by code, not by body.

HELD (plain tests; each has mutations below that turn one red):
  * the quotas are one atomic decision: 16 tabs sending 16 different images as one owner make exactly 10, and the other 6 are `avatar_quota` (never a database error, never 11); 12 tabs sending the same pixels
    make ONE row and ONE id (11 replays); owners racing for the last room of the 50 and of the 8 MiB take exactly the room that there is;
  * two deletes of one image at once: one deletes, the other is the 404 of an image that is gone, and the audit shows one ok and one error;
  * no oracle: the owner's wrong guess, another login's read of an image that exists, the read of an id that does not exist and the read of a malformed id are the SAME answer, byte for byte (code, words, status,
    extra); the delete of another owner's image is that answer too, and not worn-by-someone ('409') for a stranger;
  * `etag_matches` is HTTP's reading of `If-None-Match` for a GET (a list, weak validators, `*`) and nothing looser (a prefix, another hash, a hash without quotes, another case).
NOT CLAIMED, written in the report: after `owns()` says yes the display is written in ANOTHER transaction, so an image swept or deleted in between is worn while it no longer exists (the screen draws initials); with a
reader holding a snapshot of the database open, the deleted bytes stay in the -wal file until it ends and a checkpoint runs (measured, 560 KB); one upload costs up to 67 ms of one core (the replay does not skip the
re-encode); the browser keeps a face for the hour of `Cache-Control: max-age=3600` after it was removed."""
import hashlib
import sqlite3
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_avatars as av  # noqa: E402

ANA, BIA, LOOP, MACHINE = av.ANA, av.BIA, av.LOOP, 'session-token:deployment-token'


def world(tmp_path, tag, edits=(), wal=True):
    m, name = av.load(edits)
    db, meta, store = av.database(m, name, tmp_path, tag)
    if wal:
        sqlite3.connect(db).execute('PRAGMA journal_mode=WAL').fetchone()                      # production runs in WAL (ADR-008); the mode is kept in the file
    return m, name, db, meta, store


def together(jobs):
    """Every job at the same moment (a barrier), each in its own thread: -> [('ok', value) | ('err', exception)] in job order."""
    out, start = [None] * len(jobs), threading.Barrier(len(jobs))

    def run(i, job):
        start.wait()
        try:
            out[i] = ('ok', job())
        except BaseException as error:  # noqa: BLE001
            out[i] = ('err', error)
    pool = [threading.Thread(target=run, args=(i, j)) for i, j in enumerate(jobs)]
    for t in pool:
        t.start()
    for t in pool:
        t.join(60)
    assert all(o is not None for o in out), 'a job never finished'
    return out


def codes(results):
    return sorted((getattr(r[1], 'code', type(r[1]).__name__) if r[0] == 'err' else 'ok') for r in results)   # a database error is its class name, never a quota


# ---- the checks the mutations run against -------------------------------------------------------------------------------------------------------------------------
def quota_checks(tmp_path, edits=(), tag='q'):
    m, name, db, meta, store = world(tmp_path, tag, edits)
    mine = together([lambda n=n: store.upload(av.Audit(), ANA, av.flat_png(100 + n), 'req') for n in range(16)])
    assert codes(mine) == ['avatar_quota'] * 6 + ['ok'] * 10, codes(mine)
    assert av.count(db) == 10
    same = together([lambda: store.upload(av.Audit(), BIA, av.flat_png(7), 'req') for _ in range(12)])
    assert codes(same) == ['ok'] * 12, codes(same)
    assert av.count(db) == 11 and len({r[1][1]['id'] for r in same}) == 1 and sum(1 for r in same if r[1][0]) == 11     # one row, one id, eleven replays
    owners = [f'basic:racer{i}' for i in range(8)]
    race = together([lambda o=o, n=n: store.upload(av.Audit(), o, av.flat_png(1000 + 10 * i + n), 'req') for i, o in enumerate(owners) for n in range(8)])
    taken = av.count(db)
    assert taken == 50, taken                                                                                                  # 50 in all, exactly, whoever got there first
    assert codes(race).count('ok') == 50 - 11 and set(codes(race)) <= {'ok', 'avatar_quota'}, codes(race)


def bytes_checks(tmp_path, edits=(), tag='b'):
    m, name, db, meta, store = world(tmp_path, tag, edits)
    png = importlib_png(name)
    size = len(png.reencode(av.flat_png(5)))
    av.insert(db, av.ids(1)[0], 'basic:fill', size=m.BYTES_IN_ALL - 3 * size - 10)                                           # room for exactly three more
    race = together([lambda i=i: store.upload(av.Audit(), f'basic:o{i}', av.flat_png(2000 + i), 'req') for i in range(12)])
    assert codes(race).count('ok') == 3 and set(codes(race)) <= {'ok', 'avatar_quota'}, codes(race)
    conn = sqlite3.connect(db)
    assert conn.execute('SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM avatar_images').fetchone()[0] <= m.BYTES_IN_ALL
    conn.close()


def importlib_png(name):
    import importlib
    return importlib.import_module(f'{name}.png_avatar')


def delete_checks(tmp_path, edits=(), tag='d'):
    m, name, db, meta, store = world(tmp_path, tag, edits)
    image_id = store.upload(av.Audit(), ANA, av.flat_png(3), 'req')[1]['id']
    gate, original = threading.Barrier(2, timeout=10), store._owned

    def owned_then_wait(actor, wanted):                                                          # both tabs pass the pre-check (the image is there and theirs) BEFORE either enters the lock:
        sha = original(actor, wanted)                                                            # the window the (bot, image) decision inside the lock exists to close
        gate.wait()
        return sha
    store._owned = owned_then_wait
    worn_original = store._worn

    def slow_worn(conn, wanted):                                                                 # inside the transaction, between reading the row and deleting it: the window a deferred BEGIN leaves open
        time.sleep(0.15)
        return worn_original(conn, wanted)
    store._worn = slow_worn
    audits = [av.Audit(), av.Audit()]
    both = together([lambda a=a: store.delete(a, ANA, image_id, 'req') for a in audits])
    assert codes(both) == ['avatar_not_found', 'ok'], codes(both)
    assert av.count(db) == 0
    assert sorted(row[0] for a in audits for row in a.rows if row[0] != 'intent') == ['error', 'ok']                         # one deleted, one found nothing inside the lock, both on the record


def test_sixteen_tabs_make_exactly_ten_images_twelve_tabs_of_one_picture_make_one_and_the_last_room_goes_to_exactly_as_many_as_fit(tmp_path):
    quota_checks(tmp_path)


def test_the_last_room_of_the_8_mib_is_taken_by_exactly_as_many_owners_as_fit(tmp_path):
    bytes_checks(tmp_path)


def test_two_deletes_of_one_image_at_once_one_deletes_and_the_other_finds_nothing(tmp_path):
    delete_checks(tmp_path)


@pytest.mark.parametrize('wal', [True, False])
def test_the_quota_race_is_decided_the_same_way_in_both_journal_modes(tmp_path, wal):
    m, name, db, meta, store = world(tmp_path, f'w{wal}', wal=wal)
    results = together([lambda n=n: store.upload(av.Audit(), ANA, av.flat_png(300 + n), 'req') for n in range(14)])
    assert codes(results) == ['avatar_quota'] * 4 + ['ok'] * 10 and av.count(db) == 10


# ---- no oracle: the same answer, byte for byte ---------------------------------------------------------------------------------------------------------------------
def shape(error):
    return (type(error).__name__, error.code, error.message, error.status, error.extra)


def test_a_stranger_cannot_tell_an_image_that_exists_from_one_that_does_not_by_the_answer(tmp_path):
    m, name, db, meta, store = world(tmp_path, 'o')
    exists = store.upload(av.Audit(), ANA, av.flat_png(11), 'req')[1]['id']
    on_a_person = store.upload(av.Audit(), ANA, av.flat_png(12), 'req')[1]['id']
    meta.set_person(ANA, {'kind': 'image', 'value': on_a_person})                                                            # a person's own face: still only theirs
    missing, malformed = 'img_' + 'a' * 32, ['', 'x', 'img_' + 'a' * 31, ('img_' + 'a' * 32) + '\n', ('IMG_' + 'a' * 32), "' OR 1=1 --", None, 5, ['x']]
    wanted = shape(av.refusal(lambda: store.read(BIA, missing)))
    for stranger in (BIA, LOOP, MACHINE, ANA + ' ', ANA.upper(), ''):
        for image_id in (exists, on_a_person):
            assert shape(av.refusal(lambda: store.read(stranger, image_id))) == wanted, (stranger, image_id)
    for bad in malformed:
        assert shape(av.refusal(lambda: store.read(ANA, bad))) == wanted, bad
    assert shape(av.refusal(lambda: store.read(ANA, missing))) == wanted                                                      # even the owner's miss


def test_deleting_what_is_not_yours_is_the_same_answer_as_deleting_what_is_not_there_and_never_says_worn(tmp_path):
    m, name, db, meta, store = world(tmp_path, 'x')
    worn = store.upload(av.Audit(), ANA, av.flat_png(13), 'req')[1]['id']
    meta.upsert('vendas', {'avatar': {'kind': 'image', 'value': worn}})                                                       # worn by a Bot: the OWNER is told 409, nobody else is told anything
    plain = store.upload(av.Audit(), ANA, av.flat_png(14), 'req')[1]['id']
    wanted = shape(av.refusal(lambda: store.delete(av.Audit(), BIA, 'img_' + 'b' * 32, 'req')))
    for stranger in (BIA, LOOP, MACHINE):
        for image_id in (worn, plain):
            audit = av.Audit()
            assert shape(av.refusal(lambda: store.delete(audit, stranger, image_id, 'req'))) == wanted, (stranger, image_id)
            assert audit.rows == [], 'a refused delete of a stranger left an audit row'
    owner = av.refusal(lambda: store.delete(av.Audit(), ANA, worn, 'req'))
    assert owner.code == 'avatar_in_use' and owner.status == 409 and owner.extra == {'details': {'bots': ['vendas'], 'people': 0}}
    assert av.count(db) == 2


# ---- the ETag ------------------------------------------------------------------------------------------------------------------------------------------------------
SHA = hashlib.sha256(b'an image').hexdigest()
OTHER = hashlib.sha256(b'another').hexdigest()


@pytest.mark.parametrize('header, expected', [
    (f'"{SHA}"', True), (f'W/"{SHA}"', True), (f'"{OTHER}", "{SHA}"', True), (f'"{OTHER}",W/"{SHA}"', True), (f' "{SHA}" ', True), ('*', True), (f'"{OTHER}", *', True),
    (f'"{OTHER}"', False), (SHA, False), (f'"{SHA[:-1]}"', False), (f'"{SHA}0"', False), (f'"{SHA.upper()}"', False), (f"'{SHA}'", False), (f'w/"{SHA}"', False), (f'W/ "{SHA}"', False),
    ('', False), (None, False), (' ', False), (',', False), ('**', False), ('"*"', False), (f'"{SHA}', False), (f'{SHA}"', False),
])
def test_if_none_match_is_read_as_http_reads_it_for_a_get_and_no_looser(tmp_path, header, expected):
    m, name = av.load()
    assert m.etag_matches(header, SHA) is expected, repr(header)


# ---- mutations: one line changed, red ------------------------------------------------------------------------------------------------------------------------------
# `BEGIN` alone is an EQUIVALENT mutant while the sweep is there: its DELETE is a write and takes the lock first. Dropping the sweep as well is what a later refactor could do, and then the counts are read before the lock.
UPLOAD_LOCK = ("                conn.execute('BEGIN IMMEDIATE')\n                self._sweep(conn)", "                conn.execute('BEGIN')")
MUTATIONS = {
    'the upload reads the counts before it holds the write lock': (quota_checks, [UPLOAD_LOCK]),
    'the owner may have eleven': (quota_checks, [("                if mine >= PER_OWNER:", "                if mine > PER_OWNER:")]),
    'the same pixels are stored twice': (quota_checks, [("                if row is not None:\n                    conn.commit()\n                    return row[0], True", "                if False:\n                    conn.commit()\n                    return row[0], True")]),
    'the global count is not checked': (quota_checks, [("                if total >= IN_ALL or size + len(png) > BYTES_IN_ALL:", "                if size + len(png) > BYTES_IN_ALL:")]),
    'the bytes are not checked': (bytes_checks, [("                if total >= IN_ALL or size + len(png) > BYTES_IN_ALL:", "                if total >= IN_ALL:")]),
    'the bytes of the new image are not counted': (bytes_checks, [("size + len(png) > BYTES_IN_ALL", "size > BYTES_IN_ALL")]),
    'the delete takes the lock only when it writes': (delete_checks, [("                conn.execute('BEGIN IMMEDIATE')\n                row = conn.execute('SELECT owner FROM avatar_images WHERE id = ?', (image_id,)).fetchone()", "                conn.execute('BEGIN')\n                row = conn.execute('SELECT owner FROM avatar_images WHERE id = ?', (image_id,)).fetchone()")]),
    'the delete does not look again inside the lock': (delete_checks, [("                if row is None or row[0] != actor:\n                    raise not_found()\n                bots, people", "                if False:\n                    raise not_found()\n                bots, people")]),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_concurrency_mutation_is_caught(label, tmp_path):
    check, edits = MUTATIONS[label]
    with pytest.raises(BaseException):  # noqa: B017
        check(tmp_path, edits, tag='m')


NO_ORACLE_MUTATIONS = {
    'a forbidden read says 403': ("            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None):\n                raise not_found()", "            if row is None:\n                raise not_found()\n            if row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None:\n                raise PluginError('avatar_forbidden', 'Not yours.', 403)"),
    'a forbidden read has other words than a missing one': ("            if row is None or (row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None):\n                raise not_found()", "            if row is None:\n                raise not_found()\n            if row[0] != actor and conn.execute(_WORN_BY_BOTS, (image_id,)).fetchone() is None:\n                raise PluginError('avatar_not_found', 'Image not found for you.', 404)"),
    'a weak validator is not read': ("(token[2:] if token.startswith('W/') else token) == wanted", "token == wanted"),
    'a star is not read': ("token == '*' or ", ""),
    'a prefix of the hash matches': ("(token[2:] if token.startswith('W/') else token) == wanted", "wanted.startswith((token[2:] if token.startswith('W/') else token)[:20])"),
}


@pytest.mark.parametrize('label', sorted(NO_ORACLE_MUTATIONS))
def test_each_oracle_mutation_is_caught(label, tmp_path):
    edits = [NO_ORACLE_MUTATIONS[label]]
    with pytest.raises(BaseException):  # noqa: B017
        m, name, db, meta, store = world(tmp_path, 'n', edits)
        exists = store.upload(av.Audit(), ANA, av.flat_png(11), 'req')[1]['id']
        wanted = shape(av.refusal(lambda: store.read(BIA, 'img_' + 'a' * 32)))
        assert shape(av.refusal(lambda: store.read(BIA, exists))) == wanted
        assert shape(av.refusal(lambda: store.read(ANA, 'x'))) == wanted
        assert m.etag_matches(f'W/"{SHA}"', SHA) and m.etag_matches('*', SHA) and not m.etag_matches(f'"{SHA[:-1]}"', SHA) and not m.etag_matches(f'"{SHA[:20]}"', SHA)


def test_every_mutation_anchor_is_in_the_source_exactly_once():
    """A mutation whose anchor moved would raise while loading and be counted as 'caught': this is where it fails instead."""
    wanted = [e for _check, edits in MUTATIONS.values() for e in edits] + list(NO_ORACLE_MUTATIONS.values())
    assert len(wanted) == len(MUTATIONS) + len(NO_ORACLE_MUTATIONS)
    for old, new in wanted:
        assert av.SOURCE.count(old) == 1, old[:80]
        assert old != new
