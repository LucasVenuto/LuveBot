"""Red team (Lume, 30/10) of the SOUL editor of E-3 (the Instructions tab used to be read-only; now it WRITES): `GET /bots/{bot}/soul` returns the text REDACTED (`soul_view`: `capped(user, redact, ...)`) with the
digest of the REAL text, and `PUT` writes what the editor sends if that digest still matches. So a person who opens a SOUL that holds a key, adds the four lines of the evidence button and saves has
written the MASKED text over the real one: the key is gone from the Bot's instructions (or cut to `sk-pro...6789`). The editor handles `truncated` (read-only) but nothing says "this text was redacted":
`SoulView` has no such field. Measured with Hermes's own redactor (agent/redact.py, v0.22.5): `OPENAI_API_KEY=sk-live-...` -> `OPENAI_API_KEY=***`, `sk-proj-...` -> `sk-pro...6789`, a Bearer token -> `Bearer eyJhbG...3456`.
The real `soul_view` and `update_soul` (their text, taken out of backend/bot_controls.py) run here with a Hermes whose SOUL holds a key and a redactor that masks it.
FINDING F13 (Media, silent data loss of what the person did not touch): `xfail(strict=True)`: red the day a save that would replace redacted text with its mask is refused (409) or the view says the text was redacted (and the editor goes read-only)."""
import ast
import asyncio
import hashlib
import re
import sys
import threading
import types
from pathlib import Path

import pytest

SOURCE = (Path(__file__).resolve().parents[3] / 'backend' / 'bot_controls.py').read_text()
SECRET = 'OPENAI_API_KEY=sk-live-0123456789abcdef0123456789abcdef'
REAL = f'You are the sales assistant.\n{SECRET}\nAnswer in Portuguese.\n'
EVIDENCE = '\nWhen a task has consequences, end your answer with one evidence block.\n'


def redact(text):                                    # what the plugin hands over (Hermes's redact_sensitive_text masks a key like this)
    return re.sub(r'(OPENAI_API_KEY=)\S+', r'\1***', text)


class PluginError(Exception):
    def __init__(self, code, message, status=400, *rest):
        self.code, self.status = code, status
        super().__init__(message)


class RunRefused(PluginError):
    pass


def functions(real_text):
    tree = ast.parse(SOURCE)
    wanted = {'as_shown', 'capped', 'digest', 'split_soul', 'validate_soul', '_read_soul', 'soul_view', 'merge_soul', 'update_soul'}
    body = '\n\n'.join(ast.get_source_segment(SOURCE, n) for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in wanted)
    written = []

    async def get_profile_soul(bot):
        return {'content': real_text, 'exists': True}

    async def update_profile_soul(bot, update):
        written.append(update.content)

    class ProfileSoulUpdate:
        def __init__(self, content):
            self.content = content
    for name, attrs in (('hermes_cli', {}), ('hermes_cli.web_routers', {}), ('hermes_cli.web_routers.profiles', {'get_profile_soul': get_profile_soul, 'update_profile_soul': update_profile_soul}),
                        ('hermes_cli.web_models', {'ProfileSoulUpdate': ProfileSoulUpdate})):
        module = types.ModuleType(name)
        module.__dict__.update(attrs)
        sys.modules[name] = module
    ns = {'asyncio': asyncio, 'hashlib': hashlib, 're': re, 'LOCK': threading.RLock(), 'PluginError': PluginError, 'RunRefused': RunRefused,
          'SOUL_BEGIN': '<!-- luvebot:rules:begin -->', 'SOUL_END': '<!-- luvebot:rules:end -->', 'SOUL_MAX': 64 * 1024}
    exec(body, ns)
    return ns, written


def test_control_the_view_is_redacted_and_the_digest_is_of_the_real_text():
    ns, _ = functions(REAL)
    view = ns['soul_view']('vendas', redact)
    assert 'sk-live' not in view['content'] and 'OPENAI_API_KEY=***' in view['content']
    assert view['expected_digest'] == hashlib.sha256(REAL.encode()).hexdigest() and view['truncated'] is False


def test_control_a_text_with_nothing_to_hide_round_trips_unchanged():
    plain = 'You are the sales assistant.\nAnswer in Portuguese.\n'
    ns, written = functions(plain)
    view = ns['soul_view']('vendas', redact)
    ns['update_soul']('vendas', view['content'] + EVIDENCE, view['expected_digest'], redact)
    assert written == [plain + EVIDENCE]


def test_finding_a_save_from_the_redacted_view_does_not_overwrite_what_it_hid():
    ns, written = functions(REAL)
    view = ns['soul_view']('vendas', redact)
    try:
        ns['update_soul']('vendas', view['content'] + EVIDENCE, view['expected_digest'], redact)
    except PluginError:
        return                                        # refused: the real text is intact
    assert written and SECRET in written[-1], written  # or, if it saved, the key must still be there
