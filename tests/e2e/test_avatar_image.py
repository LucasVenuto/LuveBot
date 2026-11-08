"""AV-4, the screen (contract v0.11 section 2.3 and 2.4): real Chrome, real login, the real plugin and Hermes. A Bot that wears a person's own image is drawn in the sidebar as a `blob:` of exactly 256 x 256 whose
bytes are the stored image (the sha256 is the one the server serves as its ETag), fetched through the session (an `<img src>` to the route would carry none), and the face goes back to the initials when the
image is taken off. The routes, the validator and who may read are tests/invariants/test_zz_avatars.py.

Run (native lane): `TESTDIR=e2e one.sh av4 <worktree> test_avatar_image.py`. The screenshot goes to <harness state>/evidence/av4/."""
import hashlib
import sqlite3

from playwright.sync_api import expect

from conftest import DESKTOP, SHOTS, open_luvebot, sidebar_bot
from png_fixture import valid
from support import DASHBOARD

PREFIX = DASHBOARD + '/api/plugins/luvebot'
EVIDENCE = SHOTS.parent / 'av4'
BLOB_SHA = '''async (src) => {
  const bytes = await (await fetch(src)).arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}'''


def test_the_sidebar_draws_the_image_a_bot_wears_as_a_256_blob_and_the_initials_when_it_is_taken_off(human):
    context = human(DESKTOP)
    token = context.request.get(PREFIX + '/session').json()['csrf']
    write = {'X-LuveBot-CSRF': token}
    face = context.request.get(PREFIX + '/bots/vendas').json()['display']['avatar']
    sent = context.request.post(PREFIX + '/avatars', data=valid(seed=21), headers={**write, 'Content-Type': 'image/png'})
    assert sent.status in (200, 201), sent.text()
    image_id = sent.json()['id']
    try:
        worn = context.request.patch(PREFIX + '/bots/vendas/display', data={'avatar': {'kind': 'image', 'value': image_id}}, headers=write)
        assert worn.status == 200, worn.text()
        served = context.request.get(PREFIX + f'/avatars/{image_id}')
        etag = {k.lower(): v for k, v in served.headers.items()}['etag'].strip('"')
        assert hashlib.sha256(served.body()).hexdigest() == etag
        page = open_luvebot(context)
        face_img = sidebar_bot(page, 'vendas').locator('img[src^="blob:"]').first
        expect(face_img).to_be_visible(timeout=20_000)
        page.wait_for_function('(e) => e.complete && e.naturalWidth > 0', arg=face_img.element_handle(), timeout=20_000)
        assert face_img.evaluate('e => [e.naturalWidth, e.naturalHeight]') == [256, 256]                       # the face is the 256 x 256 image, never a URL of the server or another host
        assert page.evaluate(BLOB_SHA, face_img.get_attribute('src')) == etag                                   # and its bytes are the stored ones
        EVIDENCE.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(EVIDENCE / 'sidebar-com-imagem-propria.png'))
        # taken off (the face is the initials again): no blob in that row, after the next load of the list
        assert context.request.patch(PREFIX + '/bots/vendas/display', data={'avatar': {'kind': 'initials', 'value': 'VE'}}, headers=write).status == 200
        again = open_luvebot(context)
        expect(sidebar_bot(again, 'vendas').locator('img[src^="blob:"]')).to_have_count(0, timeout=20_000)
    finally:
        if face is None:                                                                                         # no face at all cannot be put back through the route: the row as it was
            conn = sqlite3.connect('/root/.hermes/luvebot/luvebot.db')
            conn.execute("UPDATE bot_meta SET avatar_kind = NULL, avatar_value = NULL WHERE bot = 'vendas'")
            conn.commit()
            conn.close()
        else:
            context.request.patch(PREFIX + '/bots/vendas/display', data={'avatar': face}, headers=write)
        context.request.delete(PREFIX + f'/avatars/{image_id}', headers=write)
