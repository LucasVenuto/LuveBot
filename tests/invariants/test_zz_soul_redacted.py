"""SO-3 (contract v0.10 section 6, conditions 1 to 5): the SOUL editor never writes back what it did not show, proven on the REAL Hermes and the REAL redactor.

The SOUL of a Bot is written by Hermes's OWN route (`PUT /api/profiles/{name}/soul`), the way a Bot made with Hermes gets its text; LuveBot reads it through `GET /bots/{bot}/soul` and writes through `PUT`.
  * a key, an inline image: `redacted: true`, the shown text holds neither, PUT with the RIGHT digest is `422 soul_redacted`, a stale digest is `409` (not 422), and `SOUL.md` is byte for byte the same;
  * a SOUL over 64 KiB: `truncated: true`, `redacted: false`, PUT is `422 soul_truncated`, the file the same;
  * `redacted` is exactly "what is shown is not what the file holds", also for ordinary prose the real redactor masks (A-145: measured, not assumed);
  * what LuveBot itself writes is never locked: the seven templates and the evidence snippet (PT and EN, read from the screen's own i18n) are `redacted: false`, `truncated: false`;
  * an ordinary SOUL saves as before, the managed rules block byte for byte;
  * the A-145 count over this stack's SOULs (the CEO's own Bots are counted with `tests/harness/soul_redaction_count.py`, read-only, by whoever owns that home)."""
import hashlib
import json
import re
import sqlite3
import uuid
from pathlib import Path

import pytest

from soul_redaction_count import count_souls
from support import DASHBOARD, plugin
from test_bots import DB, error_of, post
from test_hook import ROOT_HOME
from test_phase4 import put
from test_runs import get

I18N = Path('/root/.hermes/plugins/luvebot/dashboard/src/i18n.ts')
KEY = 'sk-or-v1-' + 'a1b2c3d4e5f6' * 4                       # a key the real redactor masks
IMAGE = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAA' * 4


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def drop(browser, name):
    browser.request.delete(DASHBOARD + '/api/profiles/' + name)
    conn = sqlite3.connect(DB)
    conn.execute('DELETE FROM bot_meta WHERE bot=?', (name,))
    conn.commit()
    conn.close()


@pytest.fixture
def bot(human_browser):
    name = 'so3-' + uuid.uuid4().hex[:6]
    created = post(human_browser, '/bots', {'name': name, 'display': {'label': 'Soul'}})
    assert created.status == 201, created.text()
    yield name
    drop(human_browser, name)


def hermes_writes_soul(browser, name, text):
    """The Bot's text as Hermes itself stores it (the official writer), never LuveBot's route."""
    done = browser.request.put(DASHBOARD + f'/api/profiles/{name}/soul', data={'content': text})
    assert done.status == 200, done.text()


def soul_view(browser, name):
    answer = get(browser, f'/bots/{name}/soul')
    assert answer.status == 200, answer.text()
    return answer.json()


@pytest.mark.parametrize('what, secret', [('a key', KEY), ('an inline image', IMAGE)])
def test_a_soul_with_a_key_or_an_image_is_read_only_and_the_file_is_byte_for_byte_the_same(human_browser, bot, what, secret):
    text = f'Voce e um Bot de vendas.\nUse {secret} quando precisar.\nSeja breve.\n'
    hermes_writes_soul(human_browser, bot, text)
    file = ROOT_HOME / 'profiles' / bot / 'SOUL.md'
    before = file.read_bytes()
    view = soul_view(human_browser, bot)
    assert view['redacted'] is True and view['truncated'] is False, (what, view)
    assert secret not in json.dumps(view), 'the secret reached the browser'
    new = {'content': 'Voce e um Bot de vendas.\n', 'expected_digest': view['expected_digest']}
    refused = put(human_browser, f'/bots/{bot}/soul', new)
    assert (refused.status, error_of(refused)['code']) == (422, 'soul_redacted'), (what, refused.status, refused.text()[:300])
    assert secret not in refused.text()
    stale = put(human_browser, f'/bots/{bot}/soul', {**new, 'expected_digest': '0' * 64})
    assert (stale.status, error_of(stale)['code']) == (409, 'stale'), (what, stale.status, stale.text()[:200])   # an old digest means "reload": 409 first
    assert file.read_bytes() == before, f'the SOUL changed after a refused save ({what})'


def test_a_soul_over_64_kib_is_truncated_and_a_save_is_refused_with_the_file_the_same(human_browser, bot):
    hermes_writes_soul(human_browser, bot, 'palavra comum ' * 6000)                                               # 84 KB of ordinary words: nothing for the redactor to hide
    file = ROOT_HOME / 'profiles' / bot / 'SOUL.md'
    before = file.read_bytes()
    view = soul_view(human_browser, bot)
    assert view['truncated'] is True and view['redacted'] is False, {k: view[k] for k in ('truncated', 'redacted')}
    refused = put(human_browser, f'/bots/{bot}/soul', {'content': 'curto', 'expected_digest': view['expected_digest']})
    assert (refused.status, error_of(refused)['code']) == (422, 'soul_truncated'), (refused.status, refused.text()[:300])
    assert file.read_bytes() == before


def test_redacted_is_exactly_what_is_shown_differs_from_the_file_also_for_prose(human_browser, bot):
    """A-145 measured on the real redactor: ordinary prose that looks like a secret may be masked; whichever it is, the flag says it and the text agrees with the flag."""
    for text in ('password: use the vault\n', 'A senha e pedida ao usuario.\n', 'api_key: ask the user\n'):
        hermes_writes_soul(human_browser, bot, text)
        view = soul_view(human_browser, bot)
        assert view['redacted'] is (view['content'] != text) and view['truncated'] is False, (text, view)
        print(f'A-145: {text.strip()!r} -> redacted={view["redacted"]}')


def snippets():
    source = I18N.read_text()
    found = re.findall(r'soulEvidenceText: ("(?:[^"\\]|\\.)*"),', source)
    assert len(found) == 2, 'the evidence snippet (PT and EN) is in i18n.ts once each'
    return [json.loads(literal) for literal in found]


def test_what_luvebot_writes_itself_is_never_locked_the_templates_and_the_evidence_snippet(human_browser):
    templates = [t['id'] for t in get(human_browser, '/templates').json()['templates']]
    assert len(templates) == 7
    made = []
    try:
        for template in templates:
            name = 'so3-' + uuid.uuid4().hex[:6]
            created = post(human_browser, '/bots', {'name': name, 'template': template})
            assert created.status == 201, (template, created.text())
            made.append(name)
            view = soul_view(human_browser, name)
            assert (view['redacted'], view['truncated']) == (False, False), (template, view)
        # the evidence snippet, as the button inserts it, saved through LuveBot's own route and read back: not locked
        target = made[0]
        for snippet in snippets():
            view = soul_view(human_browser, target)
            saved = put(human_browser, f'/bots/{target}/soul', {'content': view['content'] + '\n\n' + snippet, 'expected_digest': view['expected_digest']})
            assert saved.status == 200, (saved.status, saved.text()[:300])
            after = soul_view(human_browser, target)
            assert (after['redacted'], after['truncated']) == (False, False), after
            assert snippet in after['content'], 'the snippet is not shown whole: the redactor changed LuveBot\'s own text'
    finally:
        for name in made:
            drop(human_browser, name)


def test_an_ordinary_soul_saves_exactly_as_before_and_the_rules_block_is_kept_byte_for_byte(human_browser, bot):
    from luvebot_backend.bot_controls import SOUL_BEGIN, SOUL_END
    plugin()
    file = ROOT_HOME / 'profiles' / bot / 'SOUL.md'
    block = lambda: (re.search(re.escape(SOUL_BEGIN) + '.*?' + re.escape(SOUL_END), file.read_text(), re.S) or [''])[0]
    hermes_writes_soul(human_browser, bot, f'Texto comum.\n\n{SOUL_BEGIN}\nregra: confirmar antes de enviar\n{SOUL_END}\n')
    kept = block()
    assert kept
    view = soul_view(human_browser, bot)
    assert (view['redacted'], view['truncated']) == (False, False) and 'Texto comum.' in view['content'] and SOUL_BEGIN not in view['content']   # the block is not shown here
    saved = put(human_browser, f'/bots/{bot}/soul', {'content': 'Texto novo e comum.\n', 'expected_digest': view['expected_digest']})
    assert saved.status == 200, (saved.status, saved.text()[:300])
    assert 'Texto novo e comum.' in file.read_text() and 'Texto comum.' not in file.read_text()
    assert block() == kept, 'the managed rules block changed'


def test_the_a145_count_over_this_stacks_souls(human_browser):
    """What the count says for this stack (the real Bots are counted by their owner with the script); the SOULs the harness made itself, `default` and `vendas`, may not be locked."""
    module = plugin()
    from luvebot_backend import bot_controls
    rows = count_souls(ROOT_HOME, module._REDACT, bot_controls)
    print('A-145 count:', [(n, r, t) for n, r, t, _ in rows], f'locked: {sum(r or t for _, r, t, _ in rows)} of {len(rows)}')
    assert not [name for name, redacted, truncated, _ in rows if (redacted or truncated) and name in ('default', 'vendas')], rows        # the SOULs the harness itself made
    assert {'default', 'vendas'} <= {name for name, *_ in rows}, rows
