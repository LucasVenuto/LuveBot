"""The SOUL editor and a data loss (the Vitral's E-3, found before it shipped): `GET /bots/{bot}/soul` shows the text REDACTED (a key becomes asterisks, an inline image becomes `[image]`) and hands
back the digest of the REAL text. A person who saves what they see would write the asterisks over the secret. Closed on the server, not only on the screen:
* `GET` says `redacted: true` when what is shown is not what the file holds (a secret, an image), and `false` for an ordinary text; `truncated` keeps its own meaning;
* `PUT` is `422 soul_redacted` (calm words, nothing written) when the CURRENT SOUL holds anything the browser sees differently, even with the right digest; a stale digest is still the 409 `stale`
  (reload first); an ordinary SOUL saves exactly as before, with the managed rules block kept byte for byte;
* the other flag of the same loss: a SOUL over 64 KiB is SHOWN cut (`truncated`), and `PUT` is `422 soul_truncated` for it (after `soul_redacted`, when both hold);
* the SOULs LuveBot itself writes (the seven templates, the evidence snippet) are never `redacted` or `truncated`: a false positive would lock the person out of their own Bot (the REAL redactor is
  proved on the real Hermes, SO-3; here a redactor that masks keys stands in).
The functions run from the source of backend/bot_controls.py (it imports Hermes), with a Hermes whose profile SOUL is a string we hold.
Mutations: the flag always false; the flag from the digest side; the refusal missing; the refusal only for a wrong digest; the redaction compared on the cut text; an image not counted; the truncation
refusal missing, before the redaction one, or on the new text."""
import ast
import asyncio
import hashlib
from pathlib import Path
import re
import sys
import threading
import types

import pytest

SOURCE = (Path(__file__).resolve().parents[3] / 'backend' / 'bot_controls.py').read_text()
SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'
IMAGE = 'data:image/png;base64,' + 'iVBORw0KGgo' * 8
BEGIN, END = '<!-- luvebot:rules:begin -->', '<!-- luvebot:rules:end -->'
BLOCK = f'{BEGIN}\nregra: perguntar\n{END}'


def redact(text):
    return re.sub(r'sk-[A-Za-z0-9]{20,}', '***', text)


class PluginError(Exception):
    def __init__(self, code, message, status):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


class RunRefused(PluginError):
    pass


def build(edits=()):
    """The SOUL functions of bot_controls, taken out of its source in order, with their constants and a stand-in for the Hermes route functions (the SOUL it holds is `state['soul']`)."""
    text = SOURCE
    for old, new in edits:
        assert text.count(old) == 1, old
        text = text.replace(old, new)
    tree = ast.parse(text)
    wanted = ('as_shown', 'capped', 'digest', 'split_soul', 'validate_soul', '_read_soul', 'soul_view', 'merge_soul', 'update_soul')
    state = {'soul': '', 'written': []}
    ns = {'re': re, 'hashlib': hashlib, 'asyncio': asyncio, 'LOCK': threading.RLock(), 'PluginError': PluginError, 'RunRefused': RunRefused,
          'SOUL_BEGIN': BEGIN, 'SOUL_END': END, 'SOUL_MAX': 64 * 1024}
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            exec(compile(ast.get_source_segment(text, node), 'bot_controls', 'exec'), ns)
    assert all(name in ns for name in wanted), [n for n in wanted if n not in ns]

    async def get_profile_soul(bot):
        return {'content': state['soul'], 'exists': True}

    async def update_profile_soul(bot, body):
        state['written'].append(body.content)
        state['soul'] = body.content

    class ProfileSoulUpdate:
        def __init__(self, content):
            self.content = content
    saved = {m: sys.modules.get(m) for m in ('hermes_cli', 'hermes_cli.web_routers', 'hermes_cli.web_routers.profiles', 'hermes_cli.web_models')}
    for name, attrs in (('hermes_cli', {'__path__': []}), ('hermes_cli.web_routers', {'__path__': []}),
                        ('hermes_cli.web_routers.profiles', {'get_profile_soul': get_profile_soul, 'update_profile_soul': update_profile_soul}),
                        ('hermes_cli.web_models', {'ProfileSoulUpdate': ProfileSoulUpdate})):
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        sys.modules[name] = module
    return ns, state, saved


def restore(saved):
    for name, module in saved.items():
        if module is None:
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module


def code_of(fn, *args):
    try:
        return fn(*args)
    except PluginError as error:
        return error.code, error.status


def checks(edits=()):
    ns, state, saved = build(edits)
    try:
        view, update = ns['soul_view'], ns['update_soul']
        # an ordinary SOUL: not redacted, and it saves as before (the rules block kept byte for byte)
        state['soul'] = f'Você é o Vendas.\n{BLOCK}\nSeja breve.\n'
        shown = view('vendas', redact)
        assert shown['redacted'] is False and shown['truncated'] is False and shown['content'] == 'Você é o Vendas.\n\nSeja breve.\n', shown
        assert code_of(update, 'vendas', 'Você é o Vendas.\nNovo.\n', shown['expected_digest'], redact) is None
        assert BLOCK in state['written'][-1]
        # a secret in the SOUL: shown redacted, flagged, and a save is refused even with the RIGHT digest; nothing is written
        state['soul'], state['written'] = f'Use a chave {SECRET} para o CRM.\n', []
        shown = view('vendas', redact)
        assert shown['redacted'] is True and SECRET not in shown['content'] and '***' in shown['content'], shown
        assert code_of(update, 'vendas', shown['content'], shown['expected_digest'], redact) == ('soul_redacted', 422)
        assert state['written'] == [] and SECRET in state['soul']                      # the secret is where it was
        try:                                                                          # the words say what is hidden: a key, a line that looks like a password (the real redactor masks prose like
            update('vendas', 'x', shown['expected_digest'], redact)                   # `password: use the vault`), or an image
        except PluginError as error:
            assert error.message == 'This SOUL holds text LuveBot hides (a key, a line that looks like a password, or an image), so saving it here would overwrite that text. Edit it in Hermes.'
        assert code_of(update, 'vendas', 'x', 'not-the-digest', redact) == ('stale', 409)   # a stale digest is still the reload, first
        assert code_of(update, 'vendas', 'x', hashlib.sha256(b'other').hexdigest(), redact) == ('stale', 409)
        # an inline image counts the same (the browser sees [image])
        state['soul'] = f'Logo: {IMAGE}\n'
        shown = view('vendas', redact)
        assert shown['redacted'] is True and '[image]' in shown['content'] and IMAGE not in shown['content']
        assert code_of(update, 'vendas', shown['content'], shown['expected_digest'], redact) == ('soul_redacted', 422) and state['written'] == []
        # the secret inside a SOUL that also carries the rules block: still refused, block untouched
        state['soul'] = f'{SECRET}\n{BLOCK}\n'
        shown = view('vendas', redact)
        assert shown['redacted'] is True and code_of(update, 'vendas', 'x', shown['expected_digest'], redact) == ('soul_redacted', 422)
        assert state['soul'] == f'{SECRET}\n{BLOCK}\n'
        # the secret ONLY in the rules block does not count (the block is not shown or edited here)
        state['soul'] = f'Texto limpo.\n{BEGIN}\nregra com {SECRET}\n{END}\n'
        assert view('vendas', redact)['redacted'] is False
        # redacted is about the whole text, not the cut one: a long clean SOUL is not "redacted" because it was truncated
        state['soul'] = 'a' * (64 * 1024 + 500)
        shown = view('vendas', redact)
        assert shown['truncated'] is True and shown['redacted'] is False
        state['soul'] = 'a' * (64 * 1024 - 5) + SECRET
        assert view('vendas', redact)['redacted'] is True                             # the secret past the cut is still a redaction
        # the other flag: a SOUL over 64 KiB is shown cut, and a save would delete its tail
        state['soul'], state['written'] = 'a' * (64 * 1024 + 500), []
        shown = view('vendas', redact)
        assert shown['truncated'] is True and shown['redacted'] is False
        assert code_of(update, 'vendas', shown['content'], shown['expected_digest'], redact) == ('soul_truncated', 422) and state['written'] == []
        assert code_of(update, 'vendas', 'x', 'not-the-digest', redact) == ('stale', 409)                    # a stale digest is still the reload, first
        # both at once: the redaction is told first
        state['soul'] = 'a' * (64 * 1024 + 500) + SECRET
        shown = view('vendas', redact)
        assert shown['truncated'] is True and shown['redacted'] is True
        assert code_of(update, 'vendas', 'x', shown['expected_digest'], redact) == ('soul_redacted', 422) and state['written'] == []
        # exactly at the limit is fully shown: it saves
        state['soul'], state['written'] = 'a' * (64 * 1024), []
        shown = view('vendas', redact)
        assert shown['truncated'] is False and code_of(update, 'vendas', 'b' * 10, shown['expected_digest'], redact) is None and state['written'] == ['b' * 10]
        # the SOULs LuveBot writes itself: never redacted, never truncated (a false positive would lock the person out of their own Bot)
        for text in own_souls():
            state['soul'], state['written'] = text, []
            shown = view('vendas', redact)
            assert (shown['redacted'], shown['truncated']) == (False, False), text[:60]
            assert code_of(update, 'vendas', shown['content'] + '\n', shown['expected_digest'], redact) is None and len(state['written']) == 1, text[:60]
    finally:
        restore(saved)


# what LuveBot writes into a SOUL: the seven templates, and the evidence snippet of the contract (section 3.3, fixed text, PT and EN)
EVIDENCE_EN = ('When a task has consequences (it changes a file, sends something, spends money, or makes a claim someone will act on), end your answer with one block exactly like this, '
               'in your own words, and nothing else after it: a code fence whose first line is `luve-evidence`, then the headers `facts:`, `assumptions:`, `done:`, `awaiting:`, `questions:` '
               '(each once, each followed by lines that start with `- `, or the single line `- none`); put where a fact came from at the end of its line after ` | source: `. Facts are only '
               'what a source says; say what you assumed under `assumptions:`; list under `awaiting:` only what really waits for a person\'s approval.')


def own_souls():
    import backend.templates as templates
    souls = [t['soul'] for t in templates.TEMPLATES if t.get('soul')]
    assert len(souls) >= 7, len(souls)
    return [*souls, EVIDENCE_EN, souls[0] + '\n\n' + EVIDENCE_EN]


def test_the_soul_says_when_it_is_redacted_and_refuses_to_be_saved_over_it():
    checks()


MUTATIONS = {
    'the flag is always false': ("'redacted': as_shown(user, redact) != user,", "'redacted': False,"),
    'the flag is always true': ("'redacted': as_shown(user, redact) != user,", "'redacted': True,"),
    'the flag looks at the cut text': ("'redacted': as_shown(user, redact) != user,", "'redacted': text != user,"),
    'the refusal is gone': ("        if as_shown(user, redact) != user:\n            raise PluginError('soul_redacted',", "        if False:\n            raise PluginError('soul_redacted',"),
    'a wrong digest hides the refusal': ("        if digest(user) != expected:\n            raise RunRefused('stale',", "        if as_shown(user, redact) != user:\n            raise PluginError('soul_redacted', 'x', 422)\n        if digest(user) != expected:\n            raise RunRefused('stale',"),
    'the refusal compares the shown text with itself': ("        if as_shown(user, redact) != user:\n            raise PluginError('soul_redacted',", "        if as_shown(content, redact) != content:\n            raise PluginError('soul_redacted',"),
    'an image is not a redaction': ("    return redact(re.sub(r'data:image/[\\w.+-]+;base64,[A-Za-z0-9+/=\\r\\n]+', '[image]', text))", "    return redact(text)"),
    'the truncation refusal is gone': ("        if capped(user, redact, SOUL_MAX)[1]:", "        if False:"),
    'the truncation is checked on the new text': ("        if capped(user, redact, SOUL_MAX)[1]:", "        if capped(content, redact, SOUL_MAX)[1]:"),
    'the truncation refusal comes first': ("        if as_shown(user, redact) != user:\n            raise PluginError('soul_redacted',",
                                           "        if capped(user, redact, SOUL_MAX)[1]:\n            raise PluginError('soul_truncated', 'x', 422)\n        if as_shown(user, redact) != user:\n            raise PluginError('soul_redacted',"),
    'the truncation is a 409': ("so saving it here would cut the end. Edit it in Hermes.', 422)", "so saving it here would cut the end. Edit it in Hermes.', 409)"),
    'the refusal is a 409': ("raise PluginError('soul_redacted', 'This SOUL holds text LuveBot hides (a key, a line that looks like a password, or an image), so saving it here would overwrite that text. Edit it in Hermes.', 422)",
                             "raise PluginError('soul_redacted', 'This SOUL holds text LuveBot hides (a key, a line that looks like a password, or an image), so saving it here would overwrite that text. Edit it in Hermes.', 409)"),
}


@pytest.mark.parametrize('label', sorted(MUTATIONS))
def test_each_mutation_is_caught(label):
    edits = [MUTATIONS[label]]
    restore(build(edits)[2])                                    # an anchor that moved fails HERE, not inside the raises below
    with pytest.raises(Exception):  # noqa: B017
        checks(edits)


def test_the_route_hands_the_redactor_to_the_update():
    api = (Path(__file__).resolve().parents[3] / 'dashboard' / 'plugin_api.py').read_text()
    assert "_soul_writer(name, content, body['expected_digest']), bot=name," in api and "lambda: bot_controls.update_soul(name, content, digest, _REDACT)" in api   # P-3b: the writer is built out of the route
    assert "bot_controls.update_soul(name, content, body['expected_digest'])" not in api
