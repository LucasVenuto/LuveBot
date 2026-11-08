"""AV-4 (contract v0.11 section 2.2 and 2.4), the routes on the REAL mounted plugin and the real database: an image a person sends becomes a face, and nothing the file carried survives.

  * an upload of a canvas-like PNG (256 x 256 RGBA, every filter type) is stored as a PNG LuveBot wrote (`IHDR`, one `IDAT`, `IEND`; the same pixels; re-encoding it gives itself back), `GET` returns the
    same bytes whose sha256 is the ETag with a session and `401` without one, `304` for the ETag; the same pixels again are the same id (`200`, `replayed`); the audit holds the sha256 and the size, never bytes;
  * a poisoned set: an `eXIf` chunk (and `tEXt`, `iTXt`, `zTXt`, `pHYs`, `tIME`) is stripped (the stored bytes carry none of it, nor the sentinel hidden in it); a ZIP or PHP tail after `IEND`, a 257 x 257 image, a
    decompression bomb, a bad CRC, 16 bits, an interlaced image, a JPEG and an unknown critical chunk are `422 invalid_image` with the `details.why` of the closed list, store nothing and echo nothing;
    a body over 320 KiB is `413` and another media type is `415`;
  * who may read: a SECOND gated login (in process) gets `404` for a person's image, the same answer as for an id that does not exist, also with the right
    `If-None-Match` (an ETag never confirms that another person's image exists), and `200` once a Bot wears it; it cannot delete it (`404`);
  * `DELETE` while a Bot wears it is `409 avatar_in_use`, after the face is changed it deletes; the Bot's display takes `image` only for an existing id the writer owns (`422 avatar_unknown` for an unknown id
    and for another login's image, and no audit row for the refusal).
The screen (the sidebar draws the face as a `blob:` of 256 x 256) is tests/e2e/test_avatar_image.py."""
import hashlib
import json
import sqlite3
import types
import urllib.error
import urllib.request

import pytest

from png_fixture import SENTINEL, channels_of, decoded, pixels, poisoned, valid, with_metadata
from support import DASHBOARD, plugin
from test_bots import DB, csrf, error_of, patch
from test_hook import run_async
from test_plugin import PREFIX
from test_runs import get

WHY = {'not_png', 'bad_chunk', 'bad_crc', 'bad_header', 'unsupported_format', 'bad_data', 'too_large'}
OTHER = 'av4-other-login'


def upload(browser, body, content_type='image/png'):
    return browser.request.post(DASHBOARD + PREFIX + '/avatars', data=body, headers={'Content-Type': content_type, 'X-LuveBot-CSRF': csrf(browser)})


def stored(image_id):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT owner, sha256, bytes FROM avatar_images WHERE id = ?', (image_id,)).fetchone()
    finally:
        conn.close()


def image_count():
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT COUNT(*) FROM avatar_images').fetchone()[0]
    finally:
        conn.close()


def audit_count(action):
    conn = sqlite3.connect(DB)
    try:
        return conn.execute('SELECT COUNT(*) FROM audit_log WHERE action = ?', (action,)).fetchone()[0]
    finally:
        conn.close()


def second_login(method, path, *, body=b'', content_type='application/json', if_none_match=None):
    """A request of ANOTHER person (the harness has one login): a gated `basic` session of `av4-other-login`, through the route functions in process, with its own valid CSRF."""
    from starlette.requests import Request
    module = plugin()
    token = 'av4-other-token'
    headers = [(b'content-type', content_type.encode()), (b'x-luvebot-csrf', module._csrf_for(token).encode())] + ([(b'if-none-match', if_none_match.encode())] if if_none_match else [])
    scope = {'type': 'http', 'method': method, 'path': path, 'raw_path': path.encode(), 'query_string': b'', 'headers': headers,
             'app': types.SimpleNamespace(state=types.SimpleNamespace(auth_required=True)),
             'state': {'session': types.SimpleNamespace(provider='basic', user_id=OTHER, access_token=token, display_name=None)}}

    async def receive():
        return {'type': 'http.request', 'body': body, 'more_body': False}
    return module, Request(scope, receive)


@pytest.fixture(autouse=True)
def tidy(human_browser):
    """Whatever a test uploads or wears is taken back: the Bot's face as it was, then the images the test added (the harness restoring its own fixture state)."""
    face = get(human_browser, '/bots/vendas').json()['display']['avatar']
    human_browser.request.get(DASHBOARD + PREFIX + '/avatars/img_' + '0' * 32)             # the table is made by the first avatar route that runs (a 404 here): read it only after
    conn = sqlite3.connect(DB)
    before = {row[0] for row in conn.execute('SELECT id FROM avatar_images')}
    conn.close()
    yield
    conn = sqlite3.connect(DB)
    if face is None:
        conn.execute("UPDATE bot_meta SET avatar_kind = NULL, avatar_value = NULL WHERE bot = 'vendas'")
        conn.commit()
    else:
        patch(human_browser, '/bots/vendas/display', {'avatar': face})
    for (image_id,) in conn.execute('SELECT id FROM avatar_images').fetchall():
        if image_id not in before:
            conn.execute('DELETE FROM avatar_images WHERE id = ?', (image_id,))
    conn.commit()
    conn.close()


def test_an_upload_is_stored_as_a_png_luvebot_wrote_and_served_behind_the_gate(human_browser):
    source = valid()
    answer = upload(human_browser, source)
    assert answer.status == 201, answer.text()
    body = answer.json()
    image_id = body['id']
    assert (body['width'], body['height']) == (256, 256) and image_id.startswith('img_') and len(image_id) == 36 and 'replayed' not in body
    owner, sha256, png = stored(image_id)
    assert hashlib.sha256(png).hexdigest() == sha256 and body['bytes'] == len(png)
    assert channels_of(png) == [b'IHDR', b'IDAT', b'IEND'] and decoded(png) == pixels()                   # a PNG LuveBot wrote, the same pixels
    served = human_browser.request.get(DASHBOARD + PREFIX + f'/avatars/{image_id}')
    assert served.status == 200 and served.body() == png
    headers = {k.lower(): v for k, v in served.headers.items()}
    assert headers['content-type'] == 'image/png' and headers['x-content-type-options'] == 'nosniff' and headers['etag'] == f'"{sha256}"'
    assert headers['cache-control'] == 'private, no-cache'                                                   # AV-3b (A-184): kept private, revalidated every time, so a removed image is not shown for an hour
    assert human_browser.request.get(DASHBOARD + PREFIX + f'/avatars/{image_id}', headers={'If-None-Match': f'"{sha256}"'}).status == 304
    with pytest.raises(urllib.error.HTTPError) as no_session:                                              # without a session: the gate
        urllib.request.urlopen(urllib.request.Request(DASHBOARD + PREFIX + f'/avatars/{image_id}'), timeout=10)
    assert no_session.value.code == 401
    # the same pixels again are the same id (200, `replayed`), and so is the output of the first: a fixed point
    again = upload(human_browser, source)
    assert again.status == 200 and again.json() == {**body, 'replayed': True}
    assert upload(human_browser, png).json()['id'] == image_id
    # the audit holds the sha256 and the size of what was stored, never a byte of it
    conn = sqlite3.connect(DB)
    try:
        rows = conn.execute("SELECT detail, outcome, digest FROM audit_log WHERE action = 'avatar.upload' ORDER BY rowid DESC LIMIT 2").fetchall()
        everything = ' '.join(str(c) for r in conn.execute("SELECT * FROM audit_log WHERE action = 'avatar.upload'").fetchall() for c in r)
    finally:
        conn.close()
    expected = hashlib.sha256(json.dumps({'sha256': sha256, 'bytes': len(png)}, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
    assert rows[::-1] == [('intent', 'ok', expected), ('result', 'ok', expected)], rows
    assert SENTINEL.decode() not in everything


def test_metadata_is_stripped_and_a_poisoned_set_is_refused_storing_nothing(human_browser):
    clean = upload(human_browser, with_metadata())
    assert clean.status == 201, clean.text()
    _owner, _sha, png = stored(clean.json()['id'])
    assert channels_of(png) == [b'IHDR', b'IDAT', b'IEND'] and SENTINEL not in png and b'eXIf' not in png and b'tEXt' not in png    # the stored bytes carry none of it
    assert SENTINEL not in human_browser.request.get(DASHBOARD + PREFIX + f'/avatars/{clean.json()["id"]}').body()
    assert clean.json()['bytes'] == upload(human_browser, valid()).json()['bytes']                          # the same pixels: the same image, whatever the file carried
    count, written = image_count(), audit_count('avatar.upload')
    for name, (body, why) in poisoned().items():
        answer = upload(human_browser, body)
        assert (answer.status, error_of(answer)['code']) == (422, 'invalid_image'), (name, answer.status, answer.text()[:200])
        assert error_of(answer)['details']['why'] == why and why in WHY, (name, answer.text()[:200])
        assert SENTINEL.decode() not in answer.text() and 'PK' not in answer.text() and 'php' not in answer.text().lower(), name
    assert image_count() == count and audit_count('avatar.upload') == written, 'a refused image left a row or an audit entry'
    big = upload(human_browser, b'\x89PNG\r\n\x1a\n' + bytes(400 * 1024))
    assert (big.status, error_of(big)['code']) == (413, 'too_large')
    wrong = upload(human_browser, valid(), content_type='image/jpeg')
    assert (wrong.status, error_of(wrong)['code']) == (415, 'unsupported_media')
    assert image_count() == count


def test_who_may_read_or_delete_an_image_a_person_the_other_login_and_a_bot_face(human_browser):
    image_id = upload(human_browser, valid(seed=11)).json()['id']
    _owner, sha256, png = stored(image_id)
    module, request = second_login('GET', PREFIX + f'/avatars/{image_id}')
    with pytest.raises(module.PluginError) as hidden:
        run_async(module.get_avatar(image_id, request))
    unknown = 'img_' + '0' * 32
    _m, request = second_login('GET', PREFIX + f'/avatars/{unknown}')
    with pytest.raises(module.PluginError) as missing:
        run_async(module.get_avatar(unknown, request))
    assert (hidden.value.status, hidden.value.code, hidden.value.message) == (missing.value.status, missing.value.code, missing.value.message) and hidden.value.status == 404   # no existence leak
    _m, request = second_login('GET', PREFIX + f'/avatars/{image_id}', if_none_match=f'"{sha256}"')
    with pytest.raises(module.PluginError) as etag:                                                        # the ETag is looked at AFTER the rule: it never confirms an image exists
        run_async(module.get_avatar(image_id, request))
    assert etag.value.status == 404
    _m, request = second_login('DELETE', PREFIX + f'/avatars/{image_id}')
    with pytest.raises(module.PluginError) as not_theirs:
        run_async(module.delete_avatar(image_id, request))
    assert not_theirs.value.status == 404 and stored(image_id) is not None
    # a Bot wears it: it is the Bot's face now, public to the logins like its name; the person can no longer delete it
    worn = patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'image', 'value': image_id}})
    assert worn.status == 200 and worn.json()['display']['avatar'] == {'kind': 'image', 'value': image_id}, worn.text()
    _m, request = second_login('GET', PREFIX + f'/avatars/{image_id}')
    seen = run_async(module.get_avatar(image_id, request))
    assert seen.status_code == 200 and seen.body == png
    deleted = human_browser.request.delete(DASHBOARD + PREFIX + f'/avatars/{image_id}', headers={'X-LuveBot-CSRF': csrf(human_browser)})
    assert (deleted.status, error_of(deleted)['code']) == (409, 'avatar_in_use'), deleted.text()
    assert stored(image_id) is not None
    # change the face: the image is nobody's face again, the other login cannot read it, its owner can delete it
    assert patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'initials', 'value': 'VE'}}).status == 200
    _m, request = second_login('GET', PREFIX + f'/avatars/{image_id}')
    with pytest.raises(module.PluginError) as again:
        run_async(module.get_avatar(image_id, request))
    assert again.value.status == 404
    gone = human_browser.request.delete(DASHBOARD + PREFIX + f'/avatars/{image_id}', headers={'X-LuveBot-CSRF': csrf(human_browser)})
    assert gone.status == 200 and gone.json() == {'id': image_id, 'deleted': True} and stored(image_id) is None
    assert human_browser.request.get(DASHBOARD + PREFIX + f'/avatars/{image_id}').status == 404


def test_the_display_takes_an_image_only_for_an_existing_id_the_writer_owns(human_browser):
    module, request = second_login('POST', PREFIX + '/avatars', body=valid(seed=13), content_type='image/png')
    theirs = json.loads(run_async(module.upload_avatar(request)).body)['id']
    assert stored(theirs)[0] == f'basic:{OTHER}'
    mine = upload(human_browser, valid(seed=14)).json()['id']
    before = audit_count('bot.display.update')
    for value in ('img_' + '0' * 32, theirs, 'img_nothex', 'http://evil.example/a.png', 'data:image/png;base64,AAAA'):
        answer = patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'image', 'value': value}})
        assert answer.status == 422, (value, answer.status, answer.text()[:200])
        assert 'evil.example' not in answer.text()
    assert audit_count('bot.display.update') == before, 'a refused face wrote an audit row'
    assert get(human_browser, '/bots/vendas').json()['display']['avatar'] != {'kind': 'image', 'value': theirs}
    assert error_of(patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'image', 'value': theirs}}))['code'] == 'avatar_unknown'
    ok = patch(human_browser, '/bots/vendas/display', {'avatar': {'kind': 'image', 'value': mine}})
    assert ok.status == 200 and ok.json()['display']['avatar'] == {'kind': 'image', 'value': mine}
    renamed = patch(human_browser, '/bots/vendas/display', {'label': 'Vendas'})                             # a PATCH with no `avatar` never depends on who owns the face
    assert renamed.status == 200 and renamed.json()['display']['avatar'] == {'kind': 'image', 'value': mine}


def test_a_served_image_is_private_and_revalidated_every_time_and_an_error_is_never_cached(human_browser):
    """AV-3b (A-184): the avatar route says `private, no-cache` with its ETag (the browser keeps the bytes and asks every time, a `304` answers; no `max-age`: an image that was removed must not stay visible for an hour),
    and `SafeRoute` no longer overrides it with `no-store` (it only sets that when the route did not say its own); every other answer, an error included, is still `no-store`."""
    image_id = upload(human_browser, valid(seed=31)).json()['id']
    served = human_browser.request.get(DASHBOARD + PREFIX + f'/avatars/{image_id}')
    headers = {k.lower(): v for k, v in served.headers.items()}
    assert headers['cache-control'] == 'private, no-cache' and 'max-age' not in headers['cache-control'], headers['cache-control']
    again = human_browser.request.get(DASHBOARD + PREFIX + f'/avatars/{image_id}', headers={'If-None-Match': headers['etag']})
    assert again.status == 304 and {k.lower(): v for k, v in again.headers.items()}['cache-control'] == 'private, no-cache'
    missing = human_browser.request.get(DASHBOARD + PREFIX + '/avatars/img_' + '0' * 32)
    assert missing.status == 404 and {k.lower(): v for k, v in missing.headers.items()}['cache-control'] == 'no-store'      # an error is never kept
    assert {k.lower(): v for k, v in human_browser.request.get(DASHBOARD + PREFIX + '/bots').headers.items()}['cache-control'] == 'no-store'
